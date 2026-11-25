/**
 * Plugin-owned settings persistence for dsh-remote-codex-agent.
 *
 * DSH's `ctx.settings` service projects Config schemas into forms; it does not
 * expose a namespace get/set store. This module implements the plugin's own
 * `codex-agent` settings namespace as a small JSON document under
 * `$DSH_HOME/codex-agent/settings.json`, written atomically and validated on
 * every read and write.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default display window (days) for sessions. */
export const DEFAULT_DAYS = 3
/** Default Host polling interval in milliseconds. */
export const DEFAULT_POLL_MS = 2000
/** Upper bound for configured servers; keeps one poll from fanning out unboundedly. */
export const MAX_SERVERS = 50
/** Accepted SSH target spellings (alias, user@host, host, IPv4, host:port). */
const SSH_TARGET_PATTERN = /^[A-Za-z0-9_.@:%-]+$/
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** @typedef {{ id: string, name: string, ssh: string, port: number | null }} ServerConfig */
/** @typedef {{ servers: ServerConfig[], days: number, pollMs: number }} Settings */

/** Fresh default settings object. */
export function defaultSettings() {
  return { servers: [], days: DEFAULT_DAYS, pollMs: DEFAULT_POLL_MS }
}

/**
 * Resolve the settings document path.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} home - fallback home directory.
 * @returns {string} absolute path to the plugin settings document.
 */
export function resolveSettingsPath(env = process.env, home = homedir()) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(home, '.dsh')
  return join(dshHome, 'codex-agent', 'settings.json')
}

/**
 * Keep a display string free of control characters and bounded in length.
 * @param {unknown} value - candidate text.
 * @param {number} max - maximum accepted length.
 * @returns {string} cleaned text.
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Normalize one configured server entry.
 * @param {unknown} raw - untrusted entry.
 * @param {number} index - position, used in diagnostics.
 * @param {Set<string>} usedIds - ids already handed out in this document.
 * @param {Array<{ field: string, message: string }>} errors - collected validation errors.
 * @returns {ServerConfig | null} normalized entry, or null when invalid.
 */
function normalizeServer(raw, index, usedIds, errors) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: `servers.${index}`, code: 'server-invalid', message: 'server entry must be an object' })
    return null
  }
  const input = /** @type {Record<string, unknown>} */ (raw)
  const name = cleanText(input.name, 80)
  if (name === '') errors.push({ field: `servers.${index}.name`, code: 'name-required', message: 'name is required' })

  const ssh = cleanText(input.ssh, 200)
  if (ssh === '') {
    errors.push({ field: `servers.${index}.ssh`, code: 'ssh-required', message: 'SSH alias or user@host is required' })
  } else if (ssh.startsWith('-')) {
    errors.push({ field: `servers.${index}.ssh`, code: 'ssh-invalid', message: 'SSH target must not start with "-"' })
  } else if (!SSH_TARGET_PATTERN.test(ssh)) {
    errors.push({ field: `servers.${index}.ssh`, code: 'ssh-invalid', message: 'SSH target contains unsupported characters' })
  }

  let port = null
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    const candidate = typeof input.port === 'string' ? Number(input.port) : input.port
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
      errors.push({ field: `servers.${index}.port`, code: 'port-range', message: 'port must be an integer between 1 and 65535' })
    } else {
      port = candidate
    }
  }

  let id = typeof input.id === 'string' && SERVER_ID_PATTERN.test(input.id) ? input.id : ''
  if (id === '' || usedIds.has(id)) id = `srv_${randomUUID().replace(/-/g, '').slice(0, 10)}`
  usedIds.add(id)

  if (name === '' || ssh === '' || ssh.startsWith('-') || !SSH_TARGET_PATTERN.test(ssh)) return null
  return { id, name, ssh, port }
}

/**
 * Validate and normalize untrusted settings input.
 * @param {unknown} raw - untrusted JSON value.
 * @param {Settings} base - values used when a field is absent.
 * @returns {{ settings: Settings, errors: Array<{ field: string, message: string }> }}
 */
export function normalizeSettings(raw, base = defaultSettings()) {
  const errors = []
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : null
  if (input === null) {
    errors.push({ field: 'settings', code: 'settings-invalid', message: 'settings must be an object' })
    return { settings: base, errors }
  }

  let servers = base.servers
  if (input.servers !== undefined) {
    if (!Array.isArray(input.servers)) {
      errors.push({ field: 'servers', code: 'servers-invalid', message: 'servers must be an array' })
    } else if (input.servers.length > MAX_SERVERS) {
      errors.push({ field: 'servers', code: 'servers-limit', message: `at most ${MAX_SERVERS} servers may be configured` })
    } else {
      const usedIds = new Set()
      const normalized = []
      for (let index = 0; index < input.servers.length; index += 1) {
        const entry = normalizeServer(input.servers[index], index, usedIds, errors)
        if (entry !== null) normalized.push(entry)
      }
      servers = normalized
    }
  }

  let days = base.days
  if (input.days !== undefined) {
    const candidate = typeof input.days === 'string' ? Number(input.days) : input.days
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1 || candidate > 30) {
      errors.push({ field: 'days', code: 'days-range', message: 'days must be an integer between 1 and 30' })
    } else {
      days = candidate
    }
  }

  let pollMs = base.pollMs ?? DEFAULT_POLL_MS
  if (input.pollMs !== undefined) {
    const candidate = typeof input.pollMs === 'string' ? Number(input.pollMs) : input.pollMs
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 1000 || candidate > 60000) {
      errors.push({ field: 'pollMs', code: 'poll-range', message: 'poll interval must be between 1000 and 60000 ms' })
    } else {
      pollMs = candidate
    }
  }

  return { settings: { servers, days, pollMs }, errors }
}

/** Deep-copy one settings value. */
function cloneSettings(settings) {
  return {
    servers: settings.servers.map(server => ({ ...server })),
    days: settings.days,
    pollMs: settings.pollMs,
  }
}

/**
 * Small validated JSON store for this plugin's settings namespace.
 */
export class SettingsStore {
  /**
   * @param {string} filePath - settings document path.
   * @param {{ logger?: { warn?: (...args: unknown[]) => void } }} [options] - diagnostics sink.
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.logger = options.logger
    this.settings = defaultSettings()
    this.load()
  }

  /** Read and normalize the document; corrupt or absent files fall back to defaults. */
  load() {
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('[codex-agent] cannot read settings: %s', error?.message ?? error)
      this.settings = defaultSettings()
      return this.settings
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.logger?.warn?.('[codex-agent] invalid settings JSON, using defaults: %s', error?.message ?? error)
      this.settings = defaultSettings()
      return this.settings
    }
    const { settings, errors } = normalizeSettings(parsed)
    for (const problem of errors) this.logger?.warn?.('[codex-agent] settings %s: %s', problem.field, problem.message)
    this.settings = settings
    return this.settings
  }

  /** Current settings as a detached copy. */
  get() {
    return cloneSettings(this.settings)
  }

  /**
   * Validate and persist a complete settings document.
   * @param {unknown} input - untrusted settings JSON.
   * @returns {{ ok: true, settings: Settings } | { ok: false, errors: Array<{ field: string, message: string }> }}
   */
  update(input) {
    const { settings, errors } = normalizeSettings(input, this.settings)
    if (errors.length > 0) return { ok: false, errors }
    try {
      this.write(settings)
    } catch (error) {
      return { ok: false, errors: [{ field: 'settings', code: 'save-failed', message: `cannot save settings: ${error?.message ?? error}` }] }
    }
    this.settings = settings
    return { ok: true, settings: cloneSettings(settings) }
  }

  /**
   * Persist one validated settings value atomically.
   * @param {Settings} settings - complete settings to write.
   */
  write(settings) {
    const document = { version: 1, ...cloneSettings(settings) }
    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // A restrictive mode is best-effort; the rename already succeeded.
    }
  }
}
