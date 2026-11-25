import assert from 'node:assert/strict'
import test from 'node:test'
import { Monitor } from '../lib/monitor.js'
import { b64, discoveryOutput, sLine, tLine } from './helpers.mjs'

const SERVER = { id: 'srv_1', name: 'prod', ssh: 'prod', port: null }

/** Build a mutable settings store stub. */
function createStore(settings = { servers: [SERVER], days: 3, pollMs: 2000 }) {
  const state = structuredClone(settings)
  return {
    state,
    get: () => structuredClone(state),
    update: (next) => {
      Object.assign(state, next)
      return { ok: true, settings: structuredClone(state) }
    },
  }
}

/** SSH stub that serves one discovery transcript and records captures. */
class FakeSsh {
  constructor(discovery) {
    this.discovery = discovery
    this.scripts = []
    this.streams = []
  }

  async runScript(server, script) {
    this.scripts.push({ server, script })
    if (script.includes('DSH_LOG_STATE')) {
      const logState = this.logState ?? { code: 0, stdout: 'END\n' }
      const value = typeof logState === 'function' ? logState(server, script) : logState
      return { timedOut: false, spawnError: null, signal: null, stdout: '', stderr: '', ...value }
    }
    const value = typeof this.discovery === 'function' ? this.discovery(server, script) : this.discovery
    return { timedOut: false, spawnError: null, signal: null, stdout: '', stderr: '', ...value }
  }

  spawnStream(server, script, handlers) {
    const record = { server, script, handlers, killed: false }
    this.streams.push(record)
    return {
      pid: 4242,
      kill: () => { record.killed = true },
    }
  }
}

/** A complete discovery transcript locating one session in one pane. */
function locatedDiscovery(options = {}) {
  const now = Math.floor(Date.now() / 1000)
  const sessionId = options.sessionId ?? 'thread-1'
  const title = options.title ?? 'Fix login flow'
  return discoveryOutput([
    tLine({ paneTitle: title, paneId: '%7', sessionName: 'oinx', windowIndex: 0, paneIndex: 1 }),
    sLine({ id: sessionId, title, cwd: '/home/me/project', updatedAt: now, rolloutPath: '/home/me/rollout.jsonl' }),
  ])
}

function createMonitor(discovery) {
  const store = createStore()
  const ssh = new FakeSsh(discovery)
  const monitor = new Monitor({ store, ssh, logger: {} })
  return { monitor, store, ssh }
}

test('a successful poll locates sessions and produces an unknown state until OSC arrives', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  monitor.reconcileCaptures()
  const snapshot = monitor.snapshot(3)
  assert.equal(snapshot.servers.length, 1)
  const server = snapshot.servers[0]
  assert.equal(server.status, 'online')
  assert.equal(server.sessions.length, 1)
  const session = server.sessions[0]
  assert.equal(session.status, 'unknown')
  assert.equal(session.hint, 'no-osc')
  assert.equal(session.location.paneId, '%7')
  assert.equal(session.command, 'ssh -t prod "tmux attach -t oinx:0.1"'.replace(':0.1', ':0 \\; select-pane -t oinx:0.1'))
  assert.equal(session.commandKind, 'pane')
  assert.equal(ssh.streams.length, 1)
  assert.match(ssh.streams[0].script, /pipe-pane -O/)
  monitor.dispose()
})

test('OSC 7501 events update the session state table immediately', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  monitor.reconcileCaptures()
  const message = Buffer.from('Allow this command?').toString('base64')
  ssh.streams[0].handlers.onData(
    `\u001b]7501;app=codex:state=blocked:kind=permission:msg=${message}\u001b\\`,
  )
  let session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'blocked')
  assert.equal(session.stateSource, 'osc')
  assert.deepEqual(session.blocked, { kind: 'permission', message: 'Allow this command?' })

  ssh.streams[0].handlers.onData('\u001b]7501;app=codex:state=working\u0007')
  session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'working')
  monitor.dispose()
})

test('state does not follow a session that moves to a pane without OSC data', async () => {
  const now = Math.floor(Date.now() / 1000)
  const first = discoveryOutput([
    tLine({ paneTitle: 'Fix login flow', paneId: '%1', sessionName: 'oinx', windowIndex: 0, paneIndex: 0 }),
    sLine({ id: 'thread-1', title: 'Fix login flow', cwd: '/home/me/project', updatedAt: now }),
  ])
  const second = discoveryOutput([
    tLine({ paneTitle: 'Fix login flow', paneId: '%2', sessionName: 'oinx', windowIndex: 1, paneIndex: 0 }),
    sLine({ id: 'thread-1', title: 'Fix login flow', cwd: '/home/me/project', updatedAt: now + 1 }),
  ])
  const { monitor, ssh } = createMonitor({ code: 0, stdout: first })
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  ssh.streams[0].handlers.onData('\u001b]7501;app=codex:state=working\u001b\\')
  assert.equal(monitor.snapshot(3).servers[0].sessions[0].status, 'working')

  monitor.ssh.discovery = { code: 0, stdout: second }
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.location.paneId, '%2')
  assert.equal(session.status, 'unknown')
  assert.equal(session.hint, 'no-osc')
  monitor.dispose()
})

test('an outage clears live state so a reused pane cannot inherit it', async () => {
  const now = Math.floor(Date.now() / 1000)
  const first = discoveryOutput([
    tLine({ paneTitle: 'Fix login flow', paneId: '%1' }),
    sLine({ id: 'thread-1', title: 'Fix login flow', cwd: '/home/me/project', updatedAt: now }),
  ])
  const afterRestart = discoveryOutput([
    tLine({ paneTitle: 'Other work', paneId: '%1' }),
    sLine({ id: 'thread-2', title: 'Other work', cwd: '/home/me/other', updatedAt: now + 5 }),
  ])
  const { monitor, ssh } = createMonitor({ code: 0, stdout: first })
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  ssh.streams[0].handlers.onData('\u001b]7501;app=codex:state=blocked:kind=auth\u001b\\')
  assert.equal(monitor.snapshot(3).servers[0].sessions[0].status, 'blocked')

  monitor.ssh.discovery = { code: 255, stdout: '', stderr: 'Connection refused' }
  await monitor.pollServer(state, 0)
  await monitor.pollServer(state, 0)
  monitor.ssh.discovery = { code: 0, stdout: afterRestart }
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.id, 'thread-2')
  assert.equal(session.status, 'unknown')
  assert.equal(session.hint, 'no-osc')
  monitor.dispose()
})

test('non-codex OSC and malformed sequences do not change state', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  monitor.reconcileCaptures()
  ssh.streams[0].handlers.onData('\u001b]7501;app=other:state=working\u001b\\')
  ssh.streams[0].handlers.onData('\u001b]7501;garbage\u0007')
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'unknown')
  monitor.dispose()
})

const CONNECTION_REFUSED = { code: 255, stderr: 'ssh: connect to host prod port 22: Connection refused' }

test('a single SSH failure preserves live state; a full poll clears the warning and failure streak', async () => {
  const discovery = { code: 0, stdout: locatedDiscovery() }
  const { monitor, ssh } = createMonitor(discovery)
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  ssh.streams[0].handlers.onData('\u001b]7501;app=codex:state=working\u0007')
  const lastOkAt = state.lastOkAt

  ssh.discovery = CONNECTION_REFUSED
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  const retrying = monitor.snapshot(3).servers[0]
  assert.equal(retrying.status, 'online')
  assert.equal(retrying.sessions[0].status, 'working')
  assert.equal(retrying.lastOkAt, lastOkAt)
  assert.equal(retrying.warnings[0].code, 'ssh-retrying')
  assert.equal(ssh.streams[0].killed, false)

  ssh.discovery = discovery
  await monitor.pollServer(state, 0)
  assert.deepEqual(monitor.serverSummaries().servers[0].warnings, [])
  ssh.discovery = CONNECTION_REFUSED
  await monitor.pollServer(state, 0)
  assert.equal(monitor.serverSummaries().servers[0].status, 'online')
  monitor.dispose()
})

test('consecutive SSH failures show an outage and retain the catalog until recovery', async () => {
  const discovery = { code: 0, stdout: locatedDiscovery() }
  const { monitor, ssh } = createMonitor(discovery)
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()

  ssh.discovery = CONNECTION_REFUSED
  await monitor.pollServer(state, 0)
  await monitor.pollServer(state, 0)
  const server = monitor.snapshot(3).servers[0]
  assert.equal(server.status, 'unreachable')
  assert.match(server.error, /Connection refused/)
  assert.equal(server.sessions.length, 1)
  assert.equal(server.sessions[0].status, 'unreachable')
  assert.equal(ssh.streams[0].killed, true)

  ssh.discovery = discovery
  await monitor.pollServer(state, 0)
  const recovered = monitor.serverSummaries().servers[0]
  assert.equal(recovered.status, 'online')
  assert.equal(recovered.error, null)
  monitor.dispose()
})

test('a scan timeout after SSH starts keeps cached sessions and does not open captures from stale locations', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  const lastOkAt = state.lastOkAt
  ssh.discovery = { timedOut: true, code: null, stdout: 'DSH1\n' }
  await monitor.pollServer(state, 0)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  const server = monitor.snapshot(3).servers[0]
  assert.equal(server.status, 'online')
  assert.equal(server.error, null)
  assert.equal(server.warnings[0].code, 'discovery-timeout')
  assert.equal(server.lastOkAt, lastOkAt)
  assert.equal(server.sessions[0].id, 'thread-1')
  assert.equal(ssh.streams.length, 0)
  monitor.dispose()
})

test('an incomplete remote exit starts online with a scan warning, not an SSH failure', async () => {
  const { monitor } = createMonitor({ code: 127, stderr: 'bash: command not found' })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const server = monitor.serverSummaries().servers[0]
  assert.equal(server.status, 'online')
  assert.equal(server.lastOkAt, null)
  assert.equal(server.warnings[0].code, 'discovery-incomplete')
  assert.match(server.warnings[0].message, /command not found/)
  monitor.dispose()
})

test('a connection timeout before the scan starts is confirmed on the next failed poll', async () => {
  const { monitor } = createMonitor({ timedOut: true, code: null })
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  assert.equal(monitor.serverSummaries().servers[0].status, 'checking')
  await monitor.pollServer(state, 0)
  const server = monitor.serverSummaries().servers[0]
  assert.equal(server.status, 'unreachable')
  assert.match(server.error, /命令超时（8 秒）/)
  monitor.dispose()
})

test('a complete transcript is accepted despite an error after the final marker', async () => {
  const { monitor } = createMonitor({ code: 255, stdout: locatedDiscovery() })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const server = monitor.serverSummaries().servers[0]
  assert.equal(server.status, 'online')
  assert.equal(server.sessionCount, 1)
  assert.deepEqual(server.warnings, [])
  monitor.dispose()
})

test('unlocated sessions remain visible with the unlocated hint and no command', async () => {
  const now = Math.floor(Date.now() / 1000)
  const stdout = discoveryOutput([
    tLine({ paneTitle: 'unrelated terminal', paneId: '%3' }),
    sLine({ id: 'thread-9', title: 'Different work', cwd: '/home/me/other', updatedAt: now }),
  ])
  const { monitor } = createMonitor({ code: 0, stdout })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.location, null)
  assert.equal(session.command, null)
  assert.equal(session.hint, 'unlocated')
  assert.equal(session.status, 'unknown')
  monitor.dispose()
})

test('tmux enumeration failure keeps the session list but reports the warning and no location', async () => {
  const now = Math.floor(Date.now() / 1000)
  const stdout = discoveryOutput([
    ['E', 'tmux', b64('tmux 未安装')].join('|'),
    sLine({ id: 'thread-1', title: 'Fix login flow', cwd: '/home/me/project', updatedAt: now }),
  ])
  const { monitor } = createMonitor({ code: 0, stdout })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const server = monitor.snapshot(3).servers[0]
  assert.equal(server.sessions.length, 1)
  assert.equal(server.tmuxError, 'tmux 未安装')
  assert.equal(server.sessions[0].command, null)
  assert.equal(server.sessions[0].hint, 'unlocated')
  monitor.dispose()
})

test('SQLite fallback warning survives into the snapshot', async () => {
  const now = Math.floor(Date.now() / 1000)
  const stdout = discoveryOutput([
    ['E', 'sqlite', b64('no such table: threads')].join('|'),
    sLine({ id: 'thread-1', title: 'Fallback', cwd: '/x/y', updatedAt: now }),
  ])
  const { monitor } = createMonitor({ code: 0, stdout })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const server = monitor.snapshot(3).servers[0]
  assert.equal(server.warnings.length, 1)
  assert.match(server.warnings[0].message, /回退到 rollout/)
  monitor.dispose()
})

test('sessions outside the display window are filtered on the Host', async () => {
  const now = Math.floor(Date.now() / 1000)
  const stdout = discoveryOutput([
    sLine({ id: 'old', title: 'Old', cwd: '/x', updatedAt: now - 10 * 86_400 }),
    sLine({ id: 'fresh', title: 'Fresh', cwd: '/x', updatedAt: now - 60 }),
  ])
  const { monitor } = createMonitor({ code: 0, stdout })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const snapshot = monitor.snapshot(3)
  assert.deepEqual(snapshot.servers[0].sessions.map(session => session.id), ['fresh'])
  assert.equal(monitor.snapshot(30).servers[0].sessions.length, 2)
  monitor.dispose()
})

test('dispose stops capture streams', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  monitor.reconcileCaptures()
  assert.equal(ssh.streams.length, 1)
  monitor.dispose()
  assert.equal(ssh.streams[0].killed, true)
})

test('a capture process exit clears the pane state and records a retry backoff', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  const state = monitor.servers.get(SERVER.id)
  await monitor.pollServer(state, 0)
  monitor.reconcileCaptures()
  ssh.streams[0].handlers.onData('\u001b]7501;app=codex:state=working\u001b\\')
  assert.equal(monitor.snapshot(3).servers[0].sessions[0].status, 'working')
  ssh.streams[0].handlers.onClose({ code: 1, signal: null, stderr: 'pipe-pane failed', spawnError: null })
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'unknown')
  assert.equal(session.hint, 'no-osc')
  assert.equal(state.captureErrors.get('%7').message, 'pipe-pane failed')
  assert.equal(monitor.captures.size, 0)
  monitor.dispose()
})

test('recovers a running turn from rollout events when OSC never arrived', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  ssh.logState = { code: 0, stdout: 'L|0|working|' + Math.floor(Date.now() / 1000) + '\nEND\n' }
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'working')
  assert.equal(session.stateSource, 'log')
  monitor.dispose()
})

test('a turn completed long ago becomes idle rather than done', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  ssh.logState = { code: 0, stdout: 'L|0|done|' + (Math.floor(Date.now() / 1000) - 3600) + '\nEND\n' }
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'idle')
  assert.equal(session.stateSource, 'log')
  monitor.dispose()
})

test('a stale started turn is not called working on the first pane sighting', async () => {
  const { monitor, ssh } = createMonitor({ code: 0, stdout: locatedDiscovery() })
  ssh.logState = { code: 0, stdout: 'L|0|working|' + (Math.floor(Date.now() / 1000) - 3600) + '\nEND\n' }
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const session = monitor.snapshot(3).servers[0].sessions[0]
  assert.equal(session.status, 'idle')
  assert.equal(session.stateSource, 'log')
  monitor.dispose()
})

test('on-demand probe returns subagent states without requiring a location', async () => {
  const now = Math.floor(Date.now() / 1000)
  const discovery = discoveryOutput([
    sLine({ id: 'thread-main', title: 'Main', cwd: '/p', updatedAt: now, rolloutPath: '/p/main.jsonl' }),
    sLine({ id: 'thread-child', title: 'Child', cwd: '/p', updatedAt: now, rolloutPath: '/p/child.jsonl', threadSource: 'subagent', parentThreadId: 'thread-main' }),
  ])
  const { monitor, ssh } = createMonitor({ code: 0, stdout: discovery })
  ssh.logState = { code: 0, stdout: 'L|0|done|' + now + '\nL|1|working|' + now + '\nEND\n' }
  await monitor.pollServer(monitor.servers.get(SERVER.id), 0)
  const result = await monitor.probeSessionStates(['thread-main', 'thread-child'])
  assert.equal(result.states['thread-main'].status, 'done')
  assert.equal(result.states['thread-main'].stateSource, 'log')
  assert.equal(result.states['thread-child'].status, 'working')
  monitor.dispose()
})
