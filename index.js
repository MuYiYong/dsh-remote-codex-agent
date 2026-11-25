/**
 * Host half of dsh-remote-codex-agent.
 *
 * Owns the SSH polling/capture monitor and exposes its snapshot to the browser
 * half through authenticated `/api/codex-agent/*` Fetch routes. All SSH,
 * SQLite, tmux, FIFO and file work stays in this process; the browser half only
 * receives structured JSON.
 */

import { Monitor, sessionKeyOf } from './lib/monitor.js'
import {
  buildITermCommand, createITermLauncher, currentITermServer, isLocalITermRequest, readITermSessionKey,
} from './lib/iterm.js'
import { resolveSettingsPath, SettingsStore } from './lib/settings-store.js'

/**
 * Absolute path below the shared `/api` channel. `connection.fetch.register`
 * validates that a route path starts with `/api/`; the browser half therefore
 * fetches `/api/codex-agent/*`.
 */
const API_PREFIX = '/api/codex-agent'

/**
 * Build one JSON response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON-serializable value.
 * @returns {Response} response with no-store caching.
 */
function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Read a JSON request body, tolerating an empty body.
 * @param {Request} request - incoming request.
 * @returns {Promise<unknown>} parsed JSON or undefined.
 */
async function readJsonBody(request) {
  try {
    const text = await request.text()
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Normalize the settings document shape accepted by the POST route.
 * @param {unknown} body - parsed request body.
 * @returns {unknown} settings document candidate.
 */
function settingsCandidate(body) {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = /** @type {Record<string, unknown>} */ (body)
    if (record.settings !== null && typeof record.settings === 'object' && !Array.isArray(record.settings)) {
      return record.settings
    }
  }
  return body
}

/**
 * Register the authenticated HTTP API on the shared connection channel.
 * @param {object} connection - Host connection handle with Fetch registration and admission.
 * @param {Monitor} monitor - running monitor.
 * @param {SettingsStore} store - settings owner.
 * @param {object} logger - host logger.
 * @param {{ iterm?: ReturnType<typeof createITermLauncher>, getListenerOrigin?: () => string | undefined }} [options] - native launcher and listener origin.
 * @returns {() => void} disposer for every route.
 */
export function registerRoutes(connection, monitor, store, logger, {
  iterm = createITermLauncher(),
  getListenerOrigin = () => undefined,
} = {}) {
  /** @type {Array<() => void | Promise<void>>} */
  const disposers = []
  const register = (path, methods, fetch, requestBody = 'buffered') => {
    disposers.push(connection.fetch.register({ path: `${API_PREFIX}${path}`, methods, requestBody, fetch }))
  }
  const itermError = (status, code, message) => jsonResponse(status, { ok: false, error: { code, message } })
  const isLocal = (request, requireIntent = false) => isLocalITermRequest(request, connection, getListenerOrigin, requireIntent)

  register('/settings', ['GET', 'HEAD', 'POST'], async (request) => {
    if (request.method === 'POST') {
      const body = settingsCandidate(await readJsonBody(request))
      if (body === undefined) return jsonResponse(400, { ok: false, errors: [{ field: 'settings', code: 'request-invalid', message: 'request body must be valid JSON' }] })
      const result = store.update(body)
      if (!result.ok) return jsonResponse(400, { ok: false, errors: result.errors })
      monitor.reconfigure()
      return jsonResponse(200, { ok: true, settings: result.settings })
    }
    return jsonResponse(200, { ok: true, settings: store.get() })
  })

  register('/servers', ['GET', 'HEAD'], async () => {
    try {
      return jsonResponse(200, { ok: true, ...monitor.serverSummaries() })
    } catch (error) {
      logger?.error?.('[codex-agent] /servers failed: %s', error?.message ?? error)
      return jsonResponse(500, { ok: false, code: 'servers-unavailable', error: 'cannot read server status' })
    }
  })

  register('/sessions', ['GET', 'HEAD'], async (request) => {
    try {
      const url = new URL(request.url)
      const rawDays = Number(url.searchParams.get('days'))
      const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 30 ? rawDays : undefined
      const snapshot = monitor.snapshot(days)
      const available = isLocal(request) && iterm.isAvailable()
      const configured = new Map(snapshot.settings.servers.map(server => [server.id, server]))
      const servers = snapshot.servers.map(server => {
        const config = configured.get(server.id)
        const state = available && config ? currentITermServer(config, monitor.servers.get(server.id)) : null
        return {
          ...server,
          sessions: server.sessions.map(session => ({
            ...session,
            canOpenITerm: state !== null && buildITermCommand(config, state.locations.get(session.id)?.location) !== null,
          })),
        }
      })
      return jsonResponse(200, { ok: true, ...snapshot, servers })
    } catch (error) {
      logger?.error?.('[codex-agent] /sessions failed: %s', error?.message ?? error)
      return jsonResponse(500, { ok: false, code: 'sessions-unavailable', error: 'cannot read sessions' })
    }
  })

  register('/open-iterm', ['POST'], async (request) => {
    if (request.method !== 'POST' || !isLocal(request, true)) {
      return itermError(403, 'local-only', '只能从本机已登录的 DeepSeek Harness 页面打开 iTerm2。')
    }
    const key = await readITermSessionKey(request)
    if (key === null || request.signal.aborted) {
      return itermError(400, 'request-invalid', '请求必须提供有效的会话标识。')
    }
    if (!iterm.isAvailable()) return itermError(503, 'iterm-unavailable', '本机未检测到可用的 iTerm2。')

    // The key only identifies a monitor observation. Never read launch
    // parameters from the request or run the separate clipboard command.
    for (const config of store.get().servers) {
      const state = currentITermServer(config, monitor.servers.get(config.id))
      if (state === null) continue
      for (const [id, match] of state.locations) {
        if (sessionKeyOf(config.id, id) !== key) continue
        const command = buildITermCommand(config, match.location)
        if (command === null) break
        const result = await iterm.launch(command)
        const status = result.ok ? 200 : result.error.code === 'launch-in-progress' ? 409 : 500
        return jsonResponse(status, result)
      }
    }
    return itermError(404, 'session-unavailable', '会话的 tmux 位置已失效或不可用，请刷新后重试。')
  }, 'streaming')

  register('/session-states', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(400, { ok: false, code: 'request-invalid', error: 'body must be a JSON object' })
    }
    const rawIds = /** @type {{ ids?: unknown }} */ (body).ids
    if (!Array.isArray(rawIds) || rawIds.length > 32) {
      return jsonResponse(400, { ok: false, code: 'request-invalid', error: 'ids must be an array of at most 32 thread ids' })
    }
    const ids = []
    for (const value of rawIds) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        return jsonResponse(400, { ok: false, code: 'request-invalid', error: 'ids must be thread id strings' })
      }
      ids.push(value)
    }
    try {
      return jsonResponse(200, { ok: true, ...(await monitor.probeSessionStates(ids)) })
    } catch (error) {
      logger?.error?.('[codex-agent] /session-states failed: %s', error?.message ?? error)
      return jsonResponse(500, { ok: false, code: 'sessions-unavailable', error: 'cannot read session states' })
    }
  })

  register('/refresh', ['POST'], async () => {
    const started = monitor.requestRefresh()
    return jsonResponse(200, { ok: true, started })
  })

  return () => {
    for (const dispose of disposers) {
      try {
        const result = dispose()
        if (result !== undefined && typeof result.then === 'function') {
          void result.catch((error) => {
            logger?.warn?.('[codex-agent] cannot dispose HTTP route: %s', error?.message ?? error)
          })
        }
      } catch (error) {
        logger?.warn?.('[codex-agent] cannot dispose HTTP route: %s', error?.message ?? error)
      }
    }
  }
}

/**
 * Host plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const store = new SettingsStore(resolveSettingsPath(), { logger })
  const monitor = new Monitor({ store, logger })

  ctx.effect(() => {
    monitor.start()
    return () => monitor.dispose()
  }, 'codex-agent: monitor')

  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () => registerRoutes(scope.connection, monitor, store, logger, {
        getListenerOrigin: () => scope.get('webServer')?.getOrigin(),
      }),
      'codex-agent: HTTP API',
    )
    logger?.info?.('[codex-agent] HTTP API registered under %s', API_PREFIX)
  })
}
