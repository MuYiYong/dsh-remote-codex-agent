import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

/**
 * Build a minimal Cordis-like context that captures route registrations.
 * @returns {{ ctx: object, routes: Map<string, object>, dispose: () => void }}
 */
function createHarness() {
  const routes = new Map()
  const cleanups = []
  const scopedCleanups = []
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const connection = {
    fetch: {
      register: (route) => {
        // Mirror DSH's own rule: an exact Fetch route is an absolute path
        // below the shared /api channel, and registration returns a disposer.
        if (typeof route.path !== 'string' || !route.path.startsWith('/api/')) {
          throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
        }
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  }
  const ctx = {
    logger,
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    inject(_dependencies, callback) {
      const scope = {
        connection,
        effect(mount) {
          const disposer = mount()
          if (typeof disposer === 'function') scopedCleanups.push(disposer)
          return disposer
        },
      }
      callback(scope)
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    dispose() {
      for (const cleanup of scopedCleanups) cleanup()
      for (const cleanup of cleanups) cleanup()
    },
  }
}

/**
 * Parse one JSON response.
 * @param {Response} response - fetch response.
 * @returns {Promise<any>} parsed body.
 */
async function json(response) {
  return JSON.parse(await response.text())
}

test('registers the six authenticated API routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-codex-agent-http-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const harness = createHarness()
  try {
    apply(harness.ctx)
    assert.deepEqual([...harness.routes.keys()].sort(), [
      '/api/codex-agent/open-iterm',
      '/api/codex-agent/refresh',
      '/api/codex-agent/servers',
      '/api/codex-agent/session-states',
      '/api/codex-agent/sessions',
      '/api/codex-agent/settings',
    ])
    assert.deepEqual([...harness.routes.get('/api/codex-agent/open-iterm').methods], ['POST'])
    assert.equal(harness.routes.get('/api/codex-agent/open-iterm').requestBody, 'streaming')
    assert.deepEqual([...harness.routes.get('/api/codex-agent/refresh').methods], ['POST'])
    assert.deepEqual([...harness.routes.get('/api/codex-agent/session-states').methods], ['POST'])
    assert.equal(harness.routes.get('/api/codex-agent/session-states').requestBody, 'buffered')
    assert.ok(harness.routes.get('/api/codex-agent/settings').methods.includes('POST'))
    assert.equal(harness.routes.get('/api/codex-agent/settings').requestBody, 'buffered')
    harness.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(harness.routes.size, 0, 'disposing the plugin removes every route')
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})

test('serves defaults, saves valid settings and rejects invalid ones', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-codex-agent-http-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const harness = createHarness()
  try {
    apply(harness.ctx)
    const settingsRoute = harness.routes.get('/api/codex-agent/settings')

    const initial = await settingsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/settings'))
    assert.equal(initial.status, 200)
    const initialBody = await json(initial)
    assert.equal(initialBody.ok, true)
    assert.deepEqual(initialBody.settings.servers, [])
    assert.equal(initialBody.settings.days, 3)
    assert.equal(initialBody.settings.pollMs, 2000)

    const saved = await settingsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [], days: 7, pollMs: 5000 }),
    }))
    assert.equal(saved.status, 200)
    const savedBody = await json(saved)
    assert.equal(savedBody.settings.days, 7)
    assert.equal(savedBody.settings.pollMs, 5000)
    const document = JSON.parse(readFileSync(join(directory, 'codex-agent', 'settings.json'), 'utf8'))
    assert.equal(document.days, 7)

    const invalid = await settingsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [{ name: 'X', ssh: 'host', port: 99999 }], days: 3, pollMs: 2000 }),
    }))
    assert.equal(invalid.status, 400)
    const invalidBody = await json(invalid)
    assert.equal(invalidBody.ok, false)
    assert.ok(invalidBody.errors.some(error => error.field.includes('port')))
    assert.ok(invalidBody.errors.some(error => error.code === 'port-range'))

    const malformed = await settingsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }))
    assert.equal(malformed.status, 400)
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sessions and servers routes return structured snapshots with day filtering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-codex-agent-http-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const harness = createHarness()
  try {
    apply(harness.ctx)
    const sessionsRoute = harness.routes.get('/api/codex-agent/sessions')
    const serversRoute = harness.routes.get('/api/codex-agent/servers')

    const sessions = await sessionsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/sessions?days=10'))
    assert.equal(sessions.status, 200)
    const sessionsBody = await json(sessions)
    assert.equal(sessionsBody.ok, true)
    assert.equal(sessionsBody.days, 10)
    assert.deepEqual(sessionsBody.servers, [])
    assert.equal(sessionsBody.settings.days, 3)

    const fallbackDays = await json(await sessionsRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/sessions?days=99')))
    assert.equal(fallbackDays.days, 3)

    const servers = await json(await serversRoute.fetch(new Request('http://127.0.0.1/api/codex-agent/servers')))
    assert.equal(servers.ok, true)
    assert.deepEqual(servers.servers, [])
    assert.equal(servers.settings.days, 3)

    const refresh = await json(await harness.routes.get('/api/codex-agent/refresh').fetch(new Request('http://127.0.0.1/api/codex-agent/refresh', { method: 'POST' })))
    assert.equal(refresh.ok, true)
    assert.equal(typeof refresh.started, 'boolean')
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})

test('session-states validates ids and returns an empty map without servers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-codex-agent-http-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const harness = createHarness()
  try {
    apply(harness.ctx)
    const route = harness.routes.get('/api/codex-agent/session-states')
    const invalid = await route.fetch(new Request('http://127.0.0.1/api/codex-agent/session-states', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['ok', '../bad'] }),
    }))
    assert.equal(invalid.status, 400)
    const valid = await route.fetch(new Request('http://127.0.0.1/api/codex-agent/session-states', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    }))
    assert.equal(valid.status, 200)
    assert.deepEqual((await json(valid)).states, {})
  } finally {
    harness.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  }
})
