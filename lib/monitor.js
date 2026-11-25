/**
 * Host-side monitoring loop for dsh-remote-codex-agent.
 *
 * Responsibilities:
 * - poll every configured server in parallel, with a per-server timeout;
 * - keep the last known session catalog when a server is unreachable;
 * - locate sessions in tmux panes (title first, codex process cwd second);
 * - run one long-lived FIFO capture per located pane and fold OSC 7501 events
 *   into an in-process `Map<sessionKey, state>`;
 * - expose an immutable snapshot to the HTTP layer, filtered to the requested
 *   display window.
 */

import { buildAttachCommand } from './commands.js'
import { basenameOf, displayTitle, parseDiscoveryOutput } from './discovery-parse.js'
import { buildLogStateScript, parseLogStateOutput } from './log-state.js'
import { locateSessions } from './locate.js'
import { createOsc7501Parser, mapOscState } from './osc.js'
import { captureScript, fifoHash, discoveryScript } from './remote-scripts.js'
import { describeSshFailure, SshRunner } from './ssh.js'

const DISCOVERY_TIMEOUT_MS = 8000
const SSH_FAILURE_THRESHOLD = 2
const LOG_PROBE_TIMEOUT_MS = 2500
const LOG_PROBE_MAX_TARGETS = 12
const LOG_PROBE_INTERVAL_MS = 5000
const LOG_DONE_TTL_MS = 10 * 60_000
const LOG_WORKING_TTL_MS = 10 * 60_000
const PANE_ACTIVE_TTL_MS = 2 * 60_000
/**
 * Remote discovery always asks for the widest supported window (30 days); the
 * requested display window is applied to the snapshot on the Host. This keeps a
 * panel request for `days=30` correct even when the saved default is 3 days.
 */
const DISCOVERY_DAYS = 30
const CAPTURE_LIMIT_PER_SERVER = 16
const CAPTURE_LIMIT_TOTAL = 48
const CAPTURE_RETRY_BASE_MS = 2000
const CAPTURE_RETRY_MAX_MS = 60000
const MAX_ERROR_LENGTH = 400

/**
 * Build the internal key for one session.
 * @param {string} serverId - configured server id.
 * @param {string} sessionId - Codex thread id.
 * @returns {string} stable session key.
 */
export function sessionKeyOf(serverId, sessionId) {
  return `${serverId}:${sessionId}`
}

/**
 * Build the internal key for one pane capture.
 * @param {string} serverId - configured server id.
 * @param {string} paneId - tmux pane id.
 * @returns {string} stable pane key.
 */
export function paneKeyOf(serverId, paneId) {
  return `${serverId}|${paneId}`
}

/**
 * Create one empty per-server observation state.
 * @param {{ id: string, name: string, ssh: string, port: number | null }} config - server configuration.
 * @returns {object} mutable server state.
 */
function createServerState(config) {
  return {
    config: { ...config },
    status: 'checking',
    consecutiveSshFailures: 0,
    discoveryFresh: false,
    error: null,
    tmuxError: null,
    warnings: [],
    lastPollAt: null,
    lastOkAt: null,
    sessions: [],
    panes: [],
    locations: new Map(),
    captureErrors: new Map(),
    paneTitles: new Map(),
    paneActivityAt: new Map(),
    logStates: new Map(),
  }
}

/**
 * Long-lived polling/capture coordinator.
 */
export class Monitor {
  /**
   * @param {{ store: import('./settings-store.js').SettingsStore, logger?: object, ssh?: SshRunner, now?: () => number }} options - dependencies and clock override.
   */
  constructor(options) {
    this.store = options.store
    this.logger = options.logger
    this.ssh = options.ssh ?? new SshRunner({ logger: this.logger })
    this.now = options.now ?? (() => Date.now())
    const settings = this.store.get()
    this.settings = settings
    this.days = settings.days
    this.pollMs = settings.pollMs
    /** @type {Map<string, object>} */
    this.servers = new Map()
    /** @type {Map<string, object>} */
    this.sessionStates = new Map()
    /** @type {Map<string, object>} */
    this.paneStates = new Map()
    /** @type {Map<string, Set<string>>} */
    this.paneSessions = new Map()
    /** @type {Map<string, object>} */
    this.captures = new Map()
    /** @type {Map<string, { attempts: number, until: number, message: string }>} */
    this.captureBackoff = new Map()
    this.generation = 0
    this.timer = null
    this.polling = false
    this.stopped = false
    this.lastPollAt = null
    this.desiredCaptureCount = 0
    this.syncServers()
  }

  /** Begin polling and capture reconciliation. */
  start() {
    if (this.stopped) return
    this.logger?.info?.('[codex-agent] monitor started with %d server(s)', this.servers.size)
    this.schedule(0)
  }

  /** Stop timers and every SSH stream. */
  dispose() {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const key of [...this.captures.keys()]) this.stopCapture(key)
    this.paneStates.clear()
    this.sessionStates.clear()
    this.paneSessions.clear()
    this.logger?.info?.('[codex-agent] monitor stopped')
  }

  /** Apply a settings document edited through the HTTP API. */
  reconfigure() {
    const previous = this.settings
    const next = this.store.get()
    this.settings = next
    this.days = next.days
    this.pollMs = next.pollMs
    this.generation += 1
    this.syncServers()
    if (!this.stopped) {
      const changed = previous.days !== next.days
        || previous.pollMs !== next.pollMs
        || previous.servers.length !== next.servers.length
        || previous.servers.some((server, index) => {
          const other = next.servers[index]
          return other === undefined || other.ssh !== server.ssh || other.port !== server.port || other.name !== server.name
        })
      if (changed) this.logger?.info?.('[codex-agent] settings applied (%d servers, %d days, %d ms)', next.servers.length, next.days, next.pollMs)
      this.schedule(0)
    }
  }

  /** Schedule the next poll, replacing any pending one. */
  schedule(delay) {
    if (this.stopped) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, Math.max(0, delay))
    this.timer.unref?.()
  }

  /** Ask for an immediate poll (used by the panel's refresh action). */
  requestRefresh() {
    if (this.stopped) return false
    this.schedule(0)
    return true
  }

  /** One polling tick across every configured server. */
  async poll() {
    if (this.stopped) return
    if (this.polling) {
      this.schedule(this.pollMs)
      return
    }
    this.polling = true
    const generation = this.generation
    const states = [...this.servers.values()]
    try {
      const results = await Promise.allSettled(states.map(state => this.pollServer(state, generation)))
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger?.warn?.('[codex-agent] poll cycle error: %s', result.reason?.message ?? result.reason)
        }
      }
    } finally {
      this.polling = false
    }
    if (this.stopped || generation !== this.generation) return
    this.reconcileCaptures()
    this.lastPollAt = this.now()
    this.schedule(this.pollMs)
  }

  /**
   * Discover one server.
   * @param {object} state - per-server observation state.
   * @param {number} generation - settings generation the poll belongs to.
   */
  async pollServer(state, generation) {
    const config = { ...state.config }
    state.lastPollAt = this.now()
    let result
    try {
      result = await this.ssh.runScript(config, discoveryScript({ days: DISCOVERY_DAYS }), { timeoutMs: DISCOVERY_TIMEOUT_MS })
    } catch (error) {
      if (generation !== this.generation) return
      this.recordSshFailure(state, `SSH 执行失败：${error?.message ?? error}`)
      return
    }
    if (generation !== this.generation) return
    const parsed = parseDiscoveryOutput(result.stdout)
    if (parsed.protocol && parsed.complete) {
      // A complete transcript is usable even if the login shell or SSH exits
      // with an error afterwards.
      this.applyDiscovery(state, parsed)
      await this.probeLogStates(state, generation)
      return
    }
    const diagnostic = describeSshFailure(result, DISCOVERY_TIMEOUT_MS)
    const remoteExited = !result.spawnError && !result.timedOut
      && typeof result.code === 'number' && result.code !== 255
    if (parsed.protocol || remoteExited) {
      // The remote script started, or SSH returned the remote command's exit
      // status. Keep the last complete catalog and distinguish this from a
      // connection failure; do not open new captures using stale locations.
      state.status = 'online'
      state.error = null
      state.consecutiveSshFailures = 0
      if (result.timedOut) {
        this.recordDiscoveryWarning(state, 'discovery-timeout', String(DISCOVERY_TIMEOUT_MS / 1000))
      } else {
        this.recordDiscoveryWarning(state, 'discovery-incomplete', result.code === 0 ? '未收到完整采集结果' : diagnostic)
      }
      return
    }
    this.recordSshFailure(state, diagnostic)
  }

  /** Keep the previous complete catalog while a failed scan is retried. */
  recordDiscoveryWarning(state, code, message) {
    state.discoveryFresh = false
    state.warnings = [
      { area: 'discovery', code, message: String(message).slice(0, MAX_ERROR_LENGTH) },
      ...state.warnings.filter(warning => warning.area !== 'discovery'),
    ]
  }

  /** Confirm outages across consecutive polls so a brief failure doesn't reset live state. */
  recordSshFailure(state, diagnostic) {
    state.consecutiveSshFailures += 1
    if (state.consecutiveSshFailures >= SSH_FAILURE_THRESHOLD) {
      this.markUnreachable(state, diagnostic)
    } else {
      this.recordDiscoveryWarning(state, 'ssh-retrying', diagnostic)
    }
  }

  /**
   * Recover turn phase from rollout events when OSC never arrived for a turn
   * that started before the capture attached. One batched SSH call per server
   * covers every located session that still lacks an OSC state.
   * @param {object} state - per-server observation state.
   * @param {number} generation - settings generation.
   */
  async probeLogStates(state, generation) {
    if (this.stopped || generation !== this.generation || state.status !== 'online') return
    const now = this.now()
    const targets = []
    for (const session of state.sessions) {
      // Probe only sessions with a live tmux pane. The pane is what makes the
      // row actionable, and it bounds the number of full rollout scans to the
      // capture limit; 30 days of main threads could otherwise be hundreds of
      // megabytes on every poll.
      if (session.location === null || session.rolloutPath === '') continue
      if (this.sessionStates.has(sessionKeyOf(state.config.id, session.id))) continue
      const previous = state.logStates.get(session.id)
      if (previous !== undefined && now - previous.probedAt < LOG_PROBE_INTERVAL_MS) continue
      targets.push({ index: targets.length, session, rolloutPath: session.rolloutPath })
      if (targets.length >= LOG_PROBE_MAX_TARGETS) break
    }
    if (targets.length === 0) return
    let result
    try {
      result = await this.ssh.runScript(
        state.config,
        buildLogStateScript(targets.map(target => ({ index: target.index, rolloutPath: target.rolloutPath }))),
        { timeoutMs: LOG_PROBE_TIMEOUT_MS },
      )
    } catch (error) {
      this.logger?.debug?.('[codex-agent] rollout state probe failed: %s', error?.message ?? error)
      return
    }
    if (this.stopped || generation !== this.generation) return
    if (result.spawnError !== null || result.timedOut || result.code !== 0) {
      this.logger?.debug?.('[codex-agent] rollout state probe unavailable')
      return
    }
    const parsed = parseLogStateOutput(result.stdout)
    for (const probe of parsed.states) {
      const target = targets[probe.index]
      if (target === undefined) continue
      if (probe.state === 'working' || probe.state === 'done') {
        state.logStates.set(target.session.id, {
          state: probe.state,
          mtime: probe.mtime,
          probedAt: now,
        })
      } else {
        state.logStates.delete(target.session.id)
      }
    }
  }

  /**
   * Apply one complete discovery result to a server state.
   * @param {object} state - per-server observation state.
   * @param {ReturnType<typeof parseDiscoveryOutput>} parsed - parsed remote output.
   */
  applyDiscovery(state, parsed) {
    state.status = 'online'
    state.error = null
    state.consecutiveSshFailures = 0
    state.discoveryFresh = true
    state.lastOkAt = this.now()
    // OSC 0 changes whenever Codex redraws its terminal title (the spinner
    // ticks while a turn runs). Track it as *activity*, never as session state.
    const nextTitles = new Map()
    for (const pane of parsed.panes) {
      const paneId = pane.paneId
      const title = pane.paneTitle
      nextTitles.set(paneId, title)
      const previous = state.paneTitles.get(paneId)
      // A pane's first sighting is not evidence of activity: after a Host
      // restart a stale task_started rollout must not look "live" for two
      // minutes. Only an observed title transition counts.
      if (previous !== undefined && previous !== title) {
        state.paneActivityAt.set(paneId, this.now())
      }
    }
    state.paneTitles = nextTitles
    state.panes = parsed.panes
    const tmuxWarning = parsed.warnings.find(warning => warning.area === 'tmux')
    state.tmuxError = tmuxWarning?.message ?? null
    state.warnings = this.buildWarnings(parsed)
    const cutoff = this.now() - DISCOVERY_DAYS * 86_400_000
    state.sessions = parsed.sessions
      .filter(session => session.activityAt >= cutoff)
      .map(session => ({
        ...session,
        title: displayTitle(session),
        cwdName: basenameOf(session.cwd),
        location: null,
        matchedBy: null,
        command: null,
        commandKind: null,
        stateError: null,
      }))
    this.applyLocations(state)
    const liveSessionIds = new Set(state.sessions.map(session => session.id))
    for (const sessionId of [...state.logStates.keys()]) {
      if (!liveSessionIds.has(sessionId)) state.logStates.delete(sessionId)
    }
  }

  /**
   * Convert raw remote warnings into the two user-facing categories.
   * @param {ReturnType<typeof parseDiscoveryOutput>} parsed - parsed remote output.
   * @returns {Array<{ area: string, message: string }>} warnings other than tmux.
   */
  buildWarnings(parsed) {
    const warnings = []
    for (const warning of parsed.warnings) {
      if (warning.area === 'tmux') continue
      if (warning.area === 'sqlite') {
        warnings.push({
          area: 'sqlite',
          code: 'sqlite-fallback',
          message: 'sqlite3 不可用或 threads 查询失败，已回退到 rollout 文件。',
        })
      } else if (warning.area === 'codex') {
        warnings.push({
          area: 'codex',
          code: 'codex-unavailable',
          message: warning.message.slice(0, MAX_ERROR_LENGTH),
        })
      } else if (warning.message !== '') {
        warnings.push({ area: warning.area, code: 'remote', message: warning.message.slice(0, MAX_ERROR_LENGTH) })
      }
    }
    return warnings
  }

  /**
   * Mark one server unreachable while retaining its last known sessions.
   * @param {object} state - per-server observation state.
   * @param {string} message - diagnostic.
   */
  markUnreachable(state, message) {
    state.status = 'unreachable'
    state.discoveryFresh = false
    state.error = String(message ?? '').slice(0, MAX_ERROR_LENGTH)
    state.tmuxError = null
    state.warnings = []
    state.panes = []
    this.stopServerCaptures(state.config.id)
    // Cached sessions keep their last location and copy command so they remain
    // useful once the server comes back; the renderer marks every row unreachable.
    // Live capture state belongs to pane identities that may be gone after an
    // outage (tmux restarts renumber panes), so no state survives the failure.
    this.forgetServerState(state.config.id)
  }

  /**
   * Recompute pane assignments and per-session commands for one server.
   * @param {object} state - per-server observation state.
   */
  applyLocations(state) {
    const located = locateSessions(state.sessions, state.panes)
    state.locations = located
    const serverId = state.config.id
    // Forget pane→session bindings for this server; rebuild from this result.
    for (const key of [...this.paneSessions.keys()]) {
      if (key.startsWith(`${serverId}|`)) this.paneSessions.delete(key)
    }
    const keepStates = new Set()
    for (const session of state.sessions) {
      const match = located.get(session.id)
      session.location = match?.location ?? null
      session.matchedBy = match?.matchedBy ?? null
      const built = buildAttachCommand(state.config, session.location)
      session.command = built.command
      session.commandKind = built.commandKind
      const key = sessionKeyOf(serverId, session.id)
      keepStates.add(key)
      if (session.location === null) {
        // A session that is no longer attributed to a pane has no authoritative
        // state; never let an old pane's state follow it.
        this.sessionStates.delete(key)
        continue
      }
      const paneKey = paneKeyOf(serverId, session.location.paneId)
      let set = this.paneSessions.get(paneKey)
      if (set === undefined) {
        set = new Set()
        this.paneSessions.set(paneKey, set)
      }
      set.add(key)
      const paneState = this.paneStates.get(paneKey)
      if (paneState !== undefined) this.sessionStates.set(key, { ...paneState })
      else this.sessionStates.delete(key)
    }
    for (const key of [...this.sessionStates.keys()]) {
      if (!key.startsWith(`${serverId}:`)) continue
      if (!keepStates.has(key)) this.sessionStates.delete(key)
    }
    // Capture errors belong to pane identities that may have disappeared.
    const livePanes = new Set(state.panes.map(pane => pane.paneId))
    for (const paneId of [...state.captureErrors.keys()]) {
      if (!livePanes.has(paneId)) state.captureErrors.delete(paneId)
    }
    for (const key of [...this.paneStates.keys()]) {
      if (!key.startsWith(`${serverId}|`)) continue
      const paneId = key.slice(serverId.length + 1)
      if (!livePanes.has(paneId)) this.paneStates.delete(key)
    }
    for (const paneId of [...state.paneActivityAt.keys()]) {
      if (!livePanes.has(paneId)) state.paneActivityAt.delete(paneId)
    }
  }

  /**
   * Keep one capture per located pane, bounded per server and globally.
   */
  reconcileCaptures() {
    /** @type {Map<string, { state: object, paneId: string, config: object }>} */
    const desired = new Map()
    for (const state of this.servers.values()) {
      if (state.status !== 'online') continue
      const byPane = new Map()
      for (const session of state.sessions) {
        if (session.location === null) continue
        const paneId = session.location.paneId
        if (!state.discoveryFresh && !this.captures.has(paneKeyOf(state.config.id, paneId))) continue
        const previous = byPane.get(paneId)
        if (previous === undefined || session.activityAt > previous.activityAt) {
          byPane.set(paneId, { activityAt: session.activityAt })
        }
      }
      const ordered = [...byPane.entries()]
        .sort((left, right) => right[1].activityAt - left[1].activityAt)
        .slice(0, CAPTURE_LIMIT_PER_SERVER)
      for (const [paneId] of ordered) {
        desired.set(paneKeyOf(state.config.id, paneId), { state, paneId, config: state.config })
      }
    }
    let accepted = 0
    for (const key of [...desired.keys()]) {
      if (accepted >= CAPTURE_LIMIT_TOTAL) {
        desired.delete(key)
        continue
      }
      accepted += 1
    }
    this.desiredCaptureCount = desired.size
    for (const key of [...this.captures.keys()]) {
      if (!desired.has(key)) this.stopCapture(key)
    }
    for (const key of [...this.captureBackoff.keys()]) {
      if (!desired.has(key)) this.captureBackoff.delete(key)
    }
    const now = this.now()
    for (const [key, target] of desired) {
      if (this.captures.has(key)) continue
      const backoff = this.captureBackoff.get(key)
      if (backoff !== undefined && backoff.until > now) continue
      this.startCapture(key, target.state, target.config, target.paneId)
    }
  }

  /**
   * Start the long-lived FIFO reader for one pane.
   * @param {string} key - pane key.
   * @param {object} state - per-server observation state.
   * @param {object} config - server configuration.
   * @param {string} paneId - tmux pane id.
   */
  startCapture(key, state, config, paneId) {
    let script
    try {
      script = captureScript({ paneId, hash: fifoHash(config, paneId) })
    } catch (error) {
      this.logger?.warn?.('[codex-agent] cannot build capture script: %s', error?.message ?? error)
      return
    }
    const capture = {
      key,
      serverId: config.id,
      paneId,
      parser: createOsc7501Parser(),
      startedAt: this.now(),
      stopping: false,
      stderr: '',
      handle: null,
    }
    this.captures.set(key, capture)
    try {
      capture.handle = this.ssh.spawnStream(config, script, {
        onData: (chunk) => {
          if (this.captures.get(key) !== capture || capture.stopping || this.stopped) return
          const events = capture.parser.push(chunk)
          for (const event of events) this.applyOscEvent(capture, event)
        },
        onStderr: (chunk) => {
          capture.stderr = `${capture.stderr}${chunk}`.slice(-4096)
        },
        onClose: (result) => this.finishCapture(capture, result),
      })
      this.logger?.debug?.('[codex-agent] capture started for %s', paneId)
    } catch (error) {
      this.finishCapture(capture, { code: null, signal: null, stderr: '', spawnError: error?.message ?? String(error) })
    }
  }

  /**
   * Fold one OSC event into the session state map.
   * @param {object} capture - capture record.
   * @param {object} event - parsed OSC event.
   */
  applyOscEvent(capture, event) {
    const state = this.servers.get(capture.serverId)
    if (state === undefined) return
    const projected = mapOscState(event)
    if (projected === null) return
    const paneKey = paneKeyOf(capture.serverId, capture.paneId)
    const record = {
      ...projected,
      paneId: capture.paneId,
      serverId: capture.serverId,
      updatedAt: this.now(),
    }
    this.paneStates.set(paneKey, record)
    // A stream that delivers status is healthy again; do not inherit an old
    // exponential retry delay if it dies later.
    this.captureBackoff.delete(capture.key)
    const sessions = this.paneSessions.get(paneKey)
    if (sessions !== undefined) {
      for (const key of sessions) this.sessionStates.set(key, { ...record })
    }
    state.captureErrors.delete(capture.paneId)
  }

  /**
   * Finish one capture process, scheduling a bounded retry through the next poll.
   * @param {object} capture - capture record.
   * @param {{ code: number | null, signal: string | null, stderr: string, spawnError: string | null }} result - close result.
   */
  finishCapture(capture, result) {
    if (this.captures.get(capture.key) !== capture) return
    this.captures.delete(capture.key)
    if (capture.stopping || this.stopped) return
    const state = this.servers.get(capture.serverId)
    const previous = this.captureBackoff.get(capture.key)
    const attempts = (previous?.attempts ?? 0) + 1
    const delay = Math.min(CAPTURE_RETRY_MAX_MS, CAPTURE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
    const message = result.spawnError !== null
      ? `SSH 无法启动：${result.spawnError}`
      : (result.stderr.trim() !== ''
        ? result.stderr.trim().slice(-MAX_ERROR_LENGTH)
        : `状态捕获进程退出（${result.code ?? result.signal ?? 'unknown'}）`)
    this.captureBackoff.set(capture.key, { attempts, until: this.now() + delay, message })
    if (state !== undefined) {
      state.captureErrors.set(capture.paneId, { message, at: this.now() })
      const paneKey = paneKeyOf(capture.serverId, capture.paneId)
      const sessions = this.paneSessions.get(paneKey)
      if (sessions !== undefined) {
        for (const key of sessions) this.sessionStates.delete(key)
        this.paneStates.delete(paneKey)
      }
    }
    if (attempts <= 3) this.logger?.warn?.('[codex-agent] capture for %s stopped: %s', capture.paneId, message)
  }

  /**
   * Stop one capture and release its SSH process.
   * @param {string} key - pane key.
   */
  stopCapture(key) {
    const capture = this.captures.get(key)
    if (capture === undefined) return
    capture.stopping = true
    this.captures.delete(key)
    const paneKey = paneKeyOf(capture.serverId, capture.paneId)
    this.paneStates.delete(paneKey)
    const sessions = this.paneSessions.get(paneKey)
    if (sessions !== undefined) {
      for (const sessionKey of sessions) this.sessionStates.delete(sessionKey)
    }
    try {
      capture.handle?.kill?.('SIGTERM')
    } catch {
      // The process already exited.
    }
    const timer = setTimeout(() => {
      try {
        capture.handle?.kill?.('SIGKILL')
      } catch {
        // The process already exited.
      }
    }, 1500)
    timer.unref?.()
  }

  /** Rebuild the server map after configuration changes. */
  syncServers() {
    const wanted = new Map(this.settings.servers.map(server => [server.id, server]))
    for (const [id, state] of [...this.servers]) {
      const next = wanted.get(id)
      if (next === undefined) {
        this.stopServerCaptures(id)
        this.servers.delete(id)
        this.forgetServerState(id)
        continue
      }
      if (state.config.ssh !== next.ssh || state.config.port !== next.port) {
        this.stopServerCaptures(id)
        state.status = 'checking'
        state.consecutiveSshFailures = 0
        state.discoveryFresh = false
        state.lastOkAt = null
        state.lastPollAt = null
        state.error = null
        state.tmuxError = null
        state.warnings = []
        state.sessions = []
        state.panes = []
        state.locations = new Map()
        this.forgetServerState(id)
      }
      state.config = { ...next }
    }
    for (const [id, config] of wanted) {
      if (!this.servers.has(id)) this.servers.set(id, createServerState(config))
    }
  }

  /**
   * Stop captures and forget state for one server.
   * @param {string} serverId - configured server id.
   */
  stopServerCaptures(serverId) {
    for (const [key, capture] of [...this.captures]) {
      if (capture.serverId === serverId) this.stopCapture(key)
    }
  }

  /**
   * Remove in-memory per-server state when a server is removed or replaced.
   * @param {string} serverId - configured server id.
   */
  forgetServerState(serverId) {
    for (const key of [...this.sessionStates.keys()]) {
      if (key.startsWith(`${serverId}:`)) this.sessionStates.delete(key)
    }
    for (const key of [...this.paneStates.keys()]) {
      if (key.startsWith(`${serverId}|`)) this.paneStates.delete(key)
    }
    for (const key of [...this.paneSessions.keys()]) {
      if (key.startsWith(`${serverId}|`)) this.paneSessions.delete(key)
    }
    for (const key of [...this.captureBackoff.keys()]) {
      if (key.startsWith(`${serverId}|`)) this.captureBackoff.delete(key)
    }
    const state = this.servers.get(serverId)
    if (state !== undefined) {
      state.paneTitles.clear()
      state.paneActivityAt.clear()
      state.logStates.clear()
    }
  }

  /**
   * Resolve a rollout-derived state with age and pane-activity guards.
   * @param {object} state - per-server state.
   * @param {object} session - session with optional location.
   * @returns {{ status: string, updatedAt: number } | null} resolved log state.
   */
  resolveLogState(state, session) {
    const record = state.logStates.get(session.id)
    if (record === undefined) return null
    const now = this.now()
    const age = now - record.mtime * 1000
    const paneActivityAt = session.location === null
      ? null
      : (state.paneActivityAt.get(session.location.paneId) ?? null)
    const paneFresh = paneActivityAt !== null && now - paneActivityAt <= PANE_ACTIVE_TTL_MS
    let status = record.state
    if (status === 'working' && age > LOG_WORKING_TTL_MS && !(session.location !== null && paneFresh)) status = 'idle'
    if (status === 'done' && age > LOG_DONE_TTL_MS) status = 'idle'
    return { status, updatedAt: record.probedAt }
  }

  /**
   * On-demand state probe for expanded subagent rows. Bounded, cached per
   * session for five seconds, and only for sessions already in the snapshot.
   * @param {string[]} ids - Codex thread ids from the browser.
   * @returns {Promise<{ states: Record<string, object> }>} state map by thread id.
   */
  async probeSessionStates(ids) {
    const wanted = new Set(ids)
    const groups = []
    for (const state of this.servers.values()) {
      const candidates = []
      for (const session of state.sessions) {
        if (!wanted.has(session.id) || session.rolloutPath === '') continue
        if (this.sessionStates.has(sessionKeyOf(state.config.id, session.id))) continue
        const previous = state.logStates.get(session.id)
        const lastProbed = previous?.probedAt ?? 0
        if (lastProbed !== 0 && this.now() - lastProbed < LOG_PROBE_INTERVAL_MS) continue
        candidates.push({ session, lastProbed })
      }
      // Least recently probed first: a large expanded set is covered across
      // successive 8 s ticks instead of re-reading the same first 12 forever.
      candidates.sort((left, right) => left.lastProbed - right.lastProbed)
      const targets = candidates.slice(0, LOG_PROBE_MAX_TARGETS).map((candidate, index) => ({
        index,
        session: candidate.session,
        rolloutPath: candidate.session.rolloutPath,
      }))
      if (targets.length > 0) groups.push({ state, targets })
    }
    const probes = groups.map(async (group) => {
      let result
      try {
        result = await this.ssh.runScript(
          group.state.config,
          buildLogStateScript(group.targets.map(target => ({ index: target.index, rolloutPath: target.rolloutPath }))),
          { timeoutMs: LOG_PROBE_TIMEOUT_MS },
        )
      } catch (error) {
        this.logger?.debug?.('[codex-agent] on-demand state probe failed: %s', error?.message ?? error)
        return
      }
      if (result.spawnError !== null || result.timedOut || result.code !== 0) return
      const parsed = parseLogStateOutput(result.stdout)
      for (const probe of parsed.states) {
        const target = group.targets[probe.index]
        if (target === undefined) continue
        if (probe.state === 'working' || probe.state === 'done') {
          group.state.logStates.set(target.session.id, {
            state: probe.state,
            mtime: probe.mtime,
            probedAt: this.now(),
          })
        }
      }
    })
    await Promise.allSettled(probes)
    const states = {}
    for (const state of this.servers.values()) {
      for (const session of state.sessions) {
        if (!wanted.has(session.id)) continue
        if (this.sessionStates.has(sessionKeyOf(state.config.id, session.id))) continue
        const resolved = this.resolveLogState(state, session)
        if (resolved !== null) {
          states[session.id] = {
            status: resolved.status,
            stateSource: 'log',
            stateUpdatedAt: resolved.updatedAt,
          }
        }
      }
    }
    return { states }
  }

  /**
   * Project one session for the wire.
   * @param {object} state - per-server observation state.
   * @param {object} session - session record.
   * @returns {object} session view consumed by the browser half.
   */
  sessionView(state, session) {
    const serverId = state.config.id
    const key = sessionKeyOf(serverId, session.id)
    const view = {
      key,
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      cwdName: session.cwdName,
      updatedAt: session.updatedAt,
      activityAt: session.activityAt,
      source: session.source,
      threadSource: session.threadSource,
      isSubagent: session.isSubagent === true,
      parentThreadId: session.parentThreadId,
      agentNickname: session.agentNickname,
      status: 'unknown',
      stateSource: 'none',
      stateUpdatedAt: null,
      blocked: null,
      hint: null,
      location: session.location,
      command: session.command,
      commandKind: session.commandKind,
      paneActivityAt: session.location === null
        ? null
        : (state.paneActivityAt.get(session.location.paneId) ?? null),
    }
    if (state.status !== 'online') {
      view.status = 'unreachable'
      return view
    }
    if (session.location === null) view.hint = 'unlocated'
    const record = this.sessionStates.get(key)
    if (record !== undefined) {
      view.status = record.state
      view.stateSource = 'osc'
      view.stateUpdatedAt = record.updatedAt
      view.blocked = record.blocked
      view.rawState = record.rawState
      return view
    }
    const logRecord = this.resolveLogState(state, session)
    if (logRecord !== null) {
      view.status = logRecord.status
      view.stateSource = 'log'
      view.stateUpdatedAt = logRecord.updatedAt
      return view
    }
    if (session.location === null) return view
    view.hint = 'no-osc'
    const captureError = state.captureErrors.get(session.location.paneId)
    view.stateError = captureError?.message ?? null
    return view
  }

  /**
   * Build the immutable response for `/api/codex-agent/sessions`.
   * @param {number} days - requested display window.
   * @returns {object} snapshot payload.
   */
  snapshot(days) {
    const requested = Number.isInteger(days) && days >= 1 && days <= 30 ? days : this.days
    const cutoff = this.now() - requested * 86_400_000
    const servers = [...this.servers.values()].map((state) => {
      const sessions = state.sessions
        .filter(session => session.activityAt >= cutoff)
        .map(session => this.sessionView(state, session))
        .sort((left, right) => right.activityAt - left.activityAt)
      return {
        id: state.config.id,
        name: state.config.name,
        ssh: state.config.ssh,
        port: state.config.port,
        status: state.status,
        error: state.error,
        tmuxError: state.tmuxError,
        warnings: state.warnings,
        lastPollAt: state.lastPollAt,
        lastOkAt: state.lastOkAt,
        sessions,
      }
    })
    return {
      generatedAt: this.now(),
      days: requested,
      pollMs: this.pollMs,
      captures: { active: this.captures.size, total: this.desiredCaptureCount },
      settings: this.store.get(),
      servers,
    }
  }

  /**
   * Build the lightweight server summaries for `/api/codex-agent/servers`.
   * @returns {object} summary payload.
   */
  serverSummaries() {
    return {
      generatedAt: this.now(),
      settings: this.store.get(),
      servers: [...this.servers.values()].map(state => ({
        id: state.config.id,
        name: state.config.name,
        ssh: state.config.ssh,
        port: state.config.port,
        status: state.status,
        error: state.error,
        tmuxError: state.tmuxError,
        warnings: state.warnings,
        lastPollAt: state.lastPollAt,
        lastOkAt: state.lastOkAt,
        sessionCount: state.sessions.length,
      })),
    }
  }
}
