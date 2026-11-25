import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/** Load the client bundle with a minimal React and a module-loader stub. */
function loadClientModule({ fetch, timers } = {}) {
  const reactEffects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: callback => reactEffects.push(callback),
    useSyncExternalStore: (_, getSnapshot) => getSnapshot(),
    useCallback: callback => callback,
    useId: () => 'uid',
    useRef: value => ({ current: value }),
  }
  let registered = null
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registered = registration
      },
    },
  }
  vm.runInNewContext(readFileSync(CLIENT_PATH, 'utf8'), {
    window, console, AbortController,
    fetch: fetch ?? (() => new Promise(() => {})),
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
  })
  assert.ok(registered !== null, 'client bundle must register one module')
  return { reactEffects, id: registered.id, exports: registered.factory(request => {
    if (request === 'react') return React
    throw new Error(`unexpected client require: ${request}`)
  }) }
}

/**
 * Build a client-side Cordis context stub that records every contribution.
 * @param {{ schedulesOrder?: number, agentPresets?: boolean }} [options] - slot fixture.
 */
function createClientContext(options = {}) {
  const registrations = []
  const injections = []
  const effects = []
  const activeEntries = new Set()
  const localeRegistrations = []
  const t = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`)
  const slots = {
    entriesOfSlot: () => [{ options: { id: 'schedules', order: options.schedulesOrder ?? 10 } }],
    spec: () => (options.agentPresets === true ? { name: 'agent-presets.settings' } : undefined),
    register: (slotOptions, component) => {
      const entry = { options: slotOptions, component }
      registrations.push(entry)
      activeEntries.add(entry)
      return () => activeEntries.delete(entry)
    },
    inject: (slot, callback) => {
      injections.push(slot)
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
  }
  const locale = {
    bind: () => t,
    register: (namespace, dicts) => {
      localeRegistrations.push({ namespace, dicts })
      return () => {}
    },
  }
  const ctx = {
    locale,
    slots,
    effect: (callback) => {
      const disposer = callback()
      effects.push(disposer)
      return disposer
    },
  }
  const active = (name, id) => [...activeEntries].filter(x => x.options.name === name && (x.options.id ?? x.options.key) === id)
    .sort((left, right) => (left.options.priority ?? 0) - (right.options.priority ?? 0))[0]
  return { ctx, registrations, injections, effects, localeRegistrations, t, active }
}

test('registers the sidebar entry directly below the schedules panel', () => {
  const { exports } = loadClientModule()
  assert.equal(exports.inject.includes('slots'), true)
  assert.equal(exports.inject.includes('locale'), true)
  const harness = createClientContext({ schedulesOrder: 10 })
  exports.apply(harness.ctx)

  const sidebar = harness.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'sidebar.panellist registration exists')
  assert.equal(sidebar.options.id, 'codex-agent')
  assert.equal(sidebar.options.order, 15)
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), 'panel')
  assert.equal(typeof sidebar.component, 'function')

  const main = harness.registrations.find(entry => entry.options.name === 'main')
  assert.ok(main, 'main registration exists')
  assert.equal(main.options.key, 'codex-agent')
  assert.equal(main.options.key, sidebar.options.id, 'main key must match the sidebar id')
})

test('sidebar order follows the schedules entry instead of a hardcoded value', () => {
  const { exports } = loadClientModule()
  const harness = createClientContext({ schedulesOrder: 42 })
  exports.apply(harness.ctx)
  const sidebar = harness.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(sidebar.options.order, 47)
})

test('registers a settings section and locale dictionaries in the current profile', () => {
  const { exports } = loadClientModule()
  const harness = createClientContext({ agentPresets: false })
  exports.apply(harness.ctx)
  const settings = harness.registrations.find(entry => entry.options.name === 'settings.section')
  assert.ok(settings, 'settings.section registration exists')
  assert.equal(settings.options.id, 'codex-agent')
  assert.equal(settings.options.order, 21)
  const fallback = harness.registrations.find(entry => entry.options.name === 'agent-presets.settings')
  assert.equal(fallback, undefined)

  assert.equal(harness.localeRegistrations.length, 1)
  const dictionaries = harness.localeRegistrations[0]
  assert.equal(dictionaries.namespace, 'codex-agent')
  assert.ok(dictionaries.dicts.en.panel)
  assert.ok(dictionaries.dicts.zh.panel)
  assert.equal(harness.injections.includes('sidebar.panellist'), true)
  assert.equal(harness.injections.includes('main'), true)
  assert.equal(harness.injections.includes('settings.section'), true)
})

test('uses the Agent-presets extension slot instead of a second settings page when declared', () => {
  const { exports } = loadClientModule()
  const harness = createClientContext({ agentPresets: true })
  exports.apply(harness.ctx)
  const card = harness.registrations.find(entry => entry.options.name === 'agent-presets.settings')
  assert.ok(card, 'agent-presets.settings registration exists')
  assert.equal(card.options.id, 'codex-agent')
  const settings = harness.registrations.find(entry => entry.options.name === 'settings.section')
  assert.equal(settings, undefined)
})

test('disposes every effect registration cleanly', () => {
  const { exports } = loadClientModule()
  const harness = createClientContext()
  exports.apply(harness.ctx)
  for (const disposer of harness.effects) {
    if (typeof disposer === 'function') disposer()
  }
})


function fixture() {
  const queue = []
  const requests = []
  const timers = new Set()
  const harness = createClientContext()
  const { exports, reactEffects } = loadClientModule({
    timers: {
      setTimeout: fn => { timers.add(fn); return fn },
      clearTimeout: fn => timers.delete(fn),
    },
    fetch: (path, init) => {
      const req = { path, init }
      requests.push(req)
      return new Promise(resolve => queue.push((payload, ok) => resolve({ ok, status: ok ? 200 : 503, json: async () => payload })))
    },
  })
  exports.apply(harness.ctx)
  return {
    ...harness, reactEffects, requests, timers,
    label: () => harness.active('sidebar.panellist', 'codex-agent')?.options.label(),
    panel: () => harness.active('main', 'codex-agent').component({ t: harness.t }),
    tick() {
      assert.equal(timers.size, 1, 'share exactly one scheduled poll')
      const [poll] = timers
      timers.delete(poll)
      poll()
    },
    async reply(payload, ok = true) {
      assert.equal(queue.length, 1, 'there is one outstanding request')
      queue.shift()(payload, ok)
      await new Promise(resolve => setImmediate(resolve))
    },
    dispose: () => { for (const dispose of [...harness.effects].reverse()) dispose() },
  }
}

const item = (id, status, activityAt = 123) => ({
  key: 'host:' + id, id, status, activityAt, title: 'Agent ' + id,
  location: { sessionName: 'dev', windowIndex: 0, paneIndex: 1 }, command: 'ssh -t demo',
})

function snapshot(sessions, { serverStatus = 'online', days = 3 } = {}) {
  return { ok: true, days, settings: { days }, servers: [{ id: 'host', status: serverStatus, sessions }] }
}

function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, predicate)
      if (found) return found
    }
  } else if (node && typeof node === 'object') {
    if (predicate(node)) return node
    return findNode(node.children, predicate)
  }
}

test('sidebar latches real background status changes and acknowledges on opening the main panel', async () => {
  const f = fixture()
  assert.deepEqual(f.requests.map(req => [req.path, req.init.method]), [['/api/codex-agent/sessions', 'GET']])
  await f.reply(snapshot([item('1', 'working'), item('2', 'idle')]))
  assert.equal(f.label(), 'panel')
  f.tick()
  await f.reply(snapshot([item('2', 'idle', 999), item('1', 'unknown'), item('3', 'working')]))
  assert.equal(f.label(), 'panel', 'new discovery, unknown, reorder and timestamps are not updates')
  f.tick()
  await f.reply(snapshot([item('1', 'unreachable')], { serverStatus: 'unreachable' }))
  assert.equal(f.label(), 'panel')
  f.tick()
  await f.reply({ ok: false }, false)
  assert.equal(f.label(), 'panel')
  f.tick()
  await f.reply(snapshot([item('1', 'blocked')]))
  assert.equal(f.label(), 'panelUnread', 'first known change since baseline')
  f.tick()
  await f.reply(snapshot([item('1', 'working')]))
  assert.equal(f.label(), 'panelUnread', 'latches even if status returns to baseline')
  const panel = f.panel()
  panel.type(panel.props)
  const closeView = f.reactEffects[0]()
  assert.equal(f.label(), 'panel')
  f.tick()
  await f.reply(snapshot([item('1', 'done')]))
  assert.equal(f.label(), 'panel', 'no unread while viewing the main panel')
  closeView()
  f.tick()
  await f.reply(snapshot([item('1', 'blocked')], { days: 4 }))
  assert.equal(f.label(), 'panel', 'changing the display window re-baselines')
  f.tick()
  await f.reply(snapshot([item('1', 'done')], { days: 4 }))
  assert.equal(f.label(), 'panelUnread')
  f.dispose()
  assert.equal(f.timers.size, 0)
  assert.equal(f.label(), undefined)
})

test('disposal aborts an in-flight snapshot and ignores a late response', async () => {
  const f = fixture()
  f.dispose()
  assert.equal(f.requests[0].init.signal.aborted, true)
  await f.reply(snapshot([item('1', 'working')]))
  assert.equal(f.timers.size, 0)
})

test('iTerm capability adds a read-only View action with a separate copy fallback', async () => {
  const f = fixture()
  await f.reply(snapshot([{ ...item('1', 'working'), canOpenITerm: true }]))
  const panel = f.panel()
  const panelTree = panel.type(panel.props)
  const card = findNode(panelTree, node => node.type?.name === 'ServerSection')
  assert.ok(card)
  const cardTree = card.type(card.props)
  const row = findNode(cardTree, node => node.type?.name === 'SessionRow')
  assert.ok(row)
  const rowTree = row.type(row.props)
  const button = label => findNode(rowTree, node => node.type === 'button' && node.props['aria-label'] === label)
  const view = button('viewInITerm')
  assert.ok(view)
  assert.ok(button('copyCommand'))
  const pending = view.props.onClick()
  await view.props.onClick()
  assert.equal(f.requests.length, 2, 'rapid clicks do not queue a new terminal')
  const request = f.requests[1]
  assert.equal(request.path, '/api/codex-agent/open-iterm')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.credentials, 'same-origin')
  assert.equal(request.init.headers['x-dsh-codex-view'], '1')
  assert.equal(request.init.headers['content-type'], 'application/json')
  assert.equal(request.init.body, '{"key":"host:1"}')
  await f.reply({ ok: true, mode: 'tab' })
  await pending
  assert.equal(f.requests.length, 2)
  const fallback = row.type({ ...row.props, session: { ...row.props.session, canOpenITerm: false } })
  assert.equal(findNode(fallback, node => node.props?.['aria-label'] === 'viewInITerm'), undefined)
  assert.ok(findNode(fallback, node => node.props?.['aria-label'] === 'copyCommand'))
  f.dispose()
})
