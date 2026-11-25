import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerRoutes } from '../index.js'
import { buildITermCommand, createITermLauncher } from '../lib/iterm.js'

const ORIGIN = 'http://127.0.0.1:61190'
const LOCAL_HOST = new URL(ORIGIN).host
const BROWSER_PEER = { id: 'fixture-browser' }
const PREFIX = '/api/codex-agent'

function fixture() {
  const configured = { id: 'fixture', name: 'Fixture', ssh: 'dev@fixture.invalid', port: 2222 }
  const settings = { days: 3, pollMs: 2000, servers: [configured] }
  const store = { get: () => settings }
  const session = { key: 'fixture:thread', id: 'thread', command: 'UNTRUSTED_COPY_COMMAND' }
  const state = {
    config: { ...configured },
    status: 'online',
    discoveryFresh: true,
    tmuxError: null,
    locations: new Map([['thread', { location: { sessionName: 'Codex 阅读', windowIndex: 2, paneIndex: 3 } }]]),
  }
  const monitor = {
    snapshot: () => ({ settings, servers: [{ id: configured.id, sessions: [session] }] }),
    servers: new Map([[configured.id, state]]),
  }
  const routes = new Map()
  const connection = {
    fetch: { register: route => { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    browserPeer: BROWSER_PEER,
    admit(request) {
      const credential = request.headers.get('cookie')
      if (credential === 'fixture=browser') return { peer: BROWSER_PEER }
      if (credential === 'fixture=api') return { peer: { id: 'fixture-api' } }
      return { rejection: 401 }
    },
  }
  const flags = { available: true, listener: ORIGIN, launches: [] }
  const iterm = {
    isAvailable: () => flags.available,
    async launch(command) { flags.launches.push(command); return { ok: true, mode: 'tab' } },
  }
  const dispose = registerRoutes(connection, monitor, store, {}, { iterm, getListenerOrigin: () => flags.listener })
  return { configured, routes, dispose, flags, state, settings, iterm }
}

function routeRequest(path, { method = 'POST', body = '{"key":"fixture:thread"}', headers = {} } = {}) {
  const fields = new Headers({
    host: LOCAL_HOST,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    cookie: 'fixture=browser',
    'content-type': 'application/json; charset=utf-8',
    ...(method === 'POST' ? { 'x-dsh-codex-view': '1' } : {}),
  })
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) fields.delete(name)
    else fields.set(name, value)
  }
  // Match the real DSH Connection bridge's synthetic Request.url authority.
  return new Request(`http://dsh.internal${PREFIX}${path}`, {
    method, headers: fields, body: method === 'POST' ? body : undefined,
  })
}

async function expectError(response, status, code) {
  assert.equal(response.status, status)
  const payload = await response.json()
  assert.deepEqual(Object.keys(payload).sort(), ['error', 'ok'])
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, code)
  assert.ok(payload.error.message.length > 0)
}

test('GET advertises canOpenITerm only for a fresh supported location on the local browser', async () => {
  const { routes, dispose, state, flags } = fixture()
  const { fetch } = routes.get(`${PREFIX}/sessions`)
  const sessionView = async (headers) => (await (await fetch(routeRequest('/sessions', {
    method: 'GET', headers: { origin: null, ...headers },
  }))).json()).servers[0].sessions[0]
  assert.equal((await sessionView()).canOpenITerm, true)
  assert.equal((await sessionView()).command, 'UNTRUSTED_COPY_COMMAND')
  assert.equal((await sessionView({ cookie: 'fixture=api' })).canOpenITerm, false)
  assert.equal((await sessionView({ host: '192.0.2.2:61190' })).canOpenITerm, false)
  state.discoveryFresh = false
  assert.equal((await sessionView()).canOpenITerm, false)
  state.discoveryFresh = true
  flags.available = false
  assert.equal((await sessionView()).canOpenITerm, false)
  assert.deepEqual(flags.launches, [])
  dispose()
  assert.equal(routes.size, 0)
})

test('launch route requires the authenticated same-origin browser on the real loopback listener', async () => {
  const { routes, flags } = fixture()
  const route = routes.get(`${PREFIX}/open-iterm`)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'streaming')
  for (const headers of [
    { cookie: null }, { cookie: 'fixture=api' }, { host: null }, { origin: null },
    { origin: 'null' }, { origin: 'https://127.0.0.1:61190' }, { origin: 'http://127.0.0.1:5555' },
    { origin: 'http://localhost:61190' }, { host: 'attacker.invalid:61190' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    { 'x-dsh-codex-view': null }, { 'x-dsh-codex-view': '0' }, { 'x-dsh-codex-view': '1, 1' },
  ]) await expectError(await route.fetch(routeRequest('/open-iterm', { headers })), 403, 'local-only')
  await expectError(await route.fetch(routeRequest('/open-iterm', { method: 'GET' })), 403, 'local-only')
  await expectError(await route.fetch(routeRequest('/open-iterm', { method: 'OPTIONS' })), 403, 'local-only')
  flags.listener = 'http://192.0.2.2:61190'
  await expectError(await route.fetch(routeRequest('/open-iterm')), 403, 'local-only')
  flags.listener = undefined
  await expectError(await route.fetch(routeRequest('/open-iterm')), 403, 'local-only')
  assert.deepEqual(flags.launches, [])
})

test('desktop proxy may omit Origin and Fetch Metadata but still needs the owner cookie and intent header', async () => {
  const { routes, flags } = fixture()
  const { fetch } = routes.get(`${PREFIX}/open-iterm`)
  const desktop = { origin: null, 'sec-fetch-site': null }
  for (const headers of [
    { ...desktop, cookie: null }, { ...desktop, cookie: 'fixture=api' },
    { ...desktop, 'x-dsh-codex-view': null }, { ...desktop, 'x-dsh-codex-view': '0' },
  ]) await expectError(await fetch(routeRequest('/open-iterm', { headers })), 403, 'local-only')
  assert.deepEqual(flags.launches, [])
  const response = await fetch(routeRequest('/open-iterm', { headers: desktop }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, mode: 'tab' })
  assert.equal(flags.launches.length, 1)
})

test('launch rejects non-JSON, oversized, malformed and request-supplied execution fields', async () => {
  const { routes, flags } = fixture()
  const { fetch } = routes.get(`${PREFIX}/open-iterm`)
  for (const body of [
    '', '{', 'null', '[]', '{}', '{"key":"fixture:thread","port":22}',
    '{"key":"fixture:thread","command":"bad"}', '{"key":"fixture:thread","ssh":"unconfigured"}',
    '{"key":"fixture:thread","target":"elsewhere"}', '{"key":"fixture:thread\\n"}',
    '{"key":"fixture:thread"}' + ' '.repeat(4096),
  ]) await expectError(await fetch(routeRequest('/open-iterm', { body })), 400, 'request-invalid')
  await expectError(await fetch(routeRequest('/open-iterm', { headers: { 'content-type': 'text/plain' } })), 400, 'request-invalid')
  assert.deepEqual(flags.launches, [])
})

test('launch resolves only current configured, online, located sessions without probing or running clipboard text', async () => {
  const { configured, routes, settings, state, flags } = fixture()
  const { fetch } = routes.get(`${PREFIX}/open-iterm`)
  const request = (key = 'fixture:thread') => routeRequest('/open-iterm', { body: JSON.stringify({ key }) })
  await expectError(await fetch(request('none:thread')), 404, 'session-unavailable')
  await expectError(await fetch(request('fixture:gone')), 404, 'session-unavailable')
  state.discoveryFresh = false
  await expectError(await fetch(request()), 404, 'session-unavailable')
  state.discoveryFresh = true
  settings.servers = [{ ...configured, port: 22 }]
  await expectError(await fetch(request()), 404, 'session-unavailable')
  settings.servers = []
  await expectError(await fetch(request()), 404, 'session-unavailable')
  settings.servers = [configured]
  flags.available = false
  await expectError(await fetch(request()), 503, 'iterm-unavailable')
  flags.available = true
  assert.deepEqual(flags.launches, [])
  const response = await fetch(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, mode: 'tab' })
  assert.deepEqual(flags.launches, [buildITermCommand(configured, state.locations.get('thread').location)])
  assert.doesNotMatch(flags.launches[0], /2\.3|select-pane|UNTRUSTED_COPY_COMMAND/)
})

test('iTerm command uses fixed options and rejects unsafe SSH and tmux tokens', () => {
  const server = { ssh: 'fixture', port: null }
  const location = { sessionName: 'Codex 阅读-1' }
  const command = buildITermCommand(server, location)
  assert.equal(command, '/usr/bin/ssh -tt -a -x -o ClearAllForwardings=yes -o EscapeChar=none -o PermitLocalCommand=no -o ControlPath=none -o ConnectTimeout=5 -- fixture "tmux has-session -t \'=Codex 阅读-1\' && { tmux attach-session -f ignore-size -E -t \'=Codex 阅读-1\' 2>/dev/null || tmux attach-session -E -t \'=Codex 阅读-1\'; }"')
  assert.doesNotMatch(command, /attach-session -[a-z]*r/)
  for (const sessionName of ['x\n', 'a:b', 'x.y', '$0', '%1', 'a;b', '  ', 'a"b', "a'b", '`id`', 'x'.repeat(129)]) {
    assert.equal(buildITermCommand(server, { sessionName }), null)
  }
  for (const ssh of ['-oProxyCommand', 'fixture bad', 'fixture\n', 'a;id', 'a`id`']) {
    assert.equal(buildITermCommand({ ...server, ssh }, location), null)
  }
  for (const port of [0, -1, 65536, NaN, '22']) {
    assert.equal(buildITermCommand({ ...server, port }, location), null)
  }
})

test('AppleScript prefers an existing terminal window and falls back to a new window, from argv only', async () => {
  const accessed = []
  const invocations = []
  let finish
  const launcher = createITermLauncher({
    platform: 'darwin', access: (path) => accessed.push(path),
    execute: (...args) => { invocations.push(args.slice(0, -1)); finish = args.at(-1) },
  })
  assert.equal(launcher.isAvailable(), true)
  assert.deepEqual(accessed, ['/Applications/iTerm.app/Contents/MacOS/iTerm2', '/usr/bin/osascript', '/usr/bin/ssh'])
  const command = 'fake command data only'
  const opening = launcher.launch(command)
  assert.equal((await launcher.launch(command)).error.code, 'launch-in-progress')
  assert.equal(invocations.length, 1)
  const [file, argv, options] = invocations[0]
  assert.equal(file, '/usr/bin/osascript')
  assert.equal(options.shell, false)
  assert.ok(options.timeout > 0 && options.maxBuffer > 0)
  assert.equal(argv[0], '-e')
  assert.match(argv[1], /tell application "\/Applications\/iTerm\.app"/)
  assert.match(argv[1], /activate/)
  assert.match(argv[1], /repeat with candidate in windows/)
  assert.match(argv[1], /if not \(is hotkey window of candidate\)/)
  assert.match(argv[1], /select candidate/)
  assert.match(argv[1], /create tab with default profile command sshCommand/)
  assert.match(argv[1], /create window with default profile command sshCommand/)
  assert.doesNotMatch(argv[1], /write text|select tab|fake command data only/)
  assert.deepEqual(argv.slice(2), ['--', command])
  finish(null, 'tab\n', '')
  assert.deepEqual(await opening, { ok: true, mode: 'tab' })

  const newWindow = launcher.launch(command)
  finish(null, 'window\n', '')
  assert.deepEqual(await newWindow, { ok: true, mode: 'window' })

  const denied = launcher.launch(command)
  finish(new Error('denied'), '', 'Not authorized to send Apple events. (-1743)')
  assert.equal((await denied).error.code, 'automation-denied')
  const failed = launcher.launch(command)
  finish(null, 'unexpected', '')
  assert.equal((await failed).error.code, 'launch-failed')
  assert.equal(createITermLauncher({ platform: 'linux', access: assert.fail }).isAvailable(), false)
  assert.equal(createITermLauncher({ platform: 'darwin', access: () => { throw new Error('not installed') } }).isAvailable(), false)
})
