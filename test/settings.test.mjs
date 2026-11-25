import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_DAYS, DEFAULT_POLL_MS, defaultSettings, normalizeSettings, resolveSettingsPath, SettingsStore,
} from '../lib/settings-store.js'

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-codex-agent-'))
}

test('resolveSettingsPath honors DSH_HOME', () => {
  assert.equal(
    resolveSettingsPath({ DSH_HOME: '/tmp/dsh-home' }, '/home/me'),
    join('/tmp/dsh-home', 'codex-agent', 'settings.json'),
  )
  assert.equal(
    resolveSettingsPath({}, '/home/me'),
    join('/home/me', '.dsh', 'codex-agent', 'settings.json'),
  )
})

test('defaults are empty servers, three days and two seconds', () => {
  assert.deepEqual(defaultSettings(), { servers: [], days: DEFAULT_DAYS, pollMs: DEFAULT_POLL_MS })
})

test('normalizes valid settings and assigns stable ids', () => {
  const { settings, errors } = normalizeSettings({
    servers: [
      { name: 'Demo', ssh: 'demo-host', port: 2222 },
      { name: 'Staging', ssh: 'me@staging.example.com' },
    ],
    days: 7,
    pollMs: 5000,
  })
  assert.deepEqual(errors, [])
  assert.equal(settings.servers.length, 2)
  assert.match(settings.servers[0].id, /^srv_[0-9a-f]{10}$/)
  assert.equal(settings.servers[0].port, 2222)
  assert.equal(settings.servers[1].port, null)
  assert.equal(settings.days, 7)
  assert.equal(settings.pollMs, 5000)

  const kept = normalizeSettings({ servers: [{ id: 'srv_keep', name: 'X', ssh: 'x' }] }, defaultSettings())
  assert.equal(kept.settings.servers[0].id, 'srv_keep')
})

test('rejects invalid server fields, days and poll interval', () => {
  const { errors } = normalizeSettings({
    servers: [
      { name: '', ssh: '' },
      { name: 'X', ssh: '-oProxyCommand=bad' },
      { name: 'Y', ssh: 'host name' },
      { name: 'Z', ssh: 'host', port: 70000 },
    ],
    days: 0,
    pollMs: 10,
  })
  const fields = errors.map(error => error.field)
  assert.ok(fields.includes('servers.0.name'))
  assert.ok(fields.includes('servers.0.ssh'))
  assert.ok(fields.includes('servers.1.ssh'))
  assert.ok(fields.includes('servers.2.ssh'))
  assert.ok(fields.includes('servers.3.port'))
  assert.ok(fields.includes('days'))
  assert.ok(fields.includes('pollMs'))
})

test('rejects duplicate ids by assigning a fresh one', () => {
  const { settings, errors } = normalizeSettings({
    servers: [
      { id: 'same', name: 'A', ssh: 'a' },
      { id: 'same', name: 'B', ssh: 'b' },
    ],
  })
  assert.deepEqual(errors, [])
  assert.notEqual(settings.servers[0].id, settings.servers[1].id)
})

test('limits the server count', () => {
  const servers = Array.from({ length: 51 }, (_, index) => ({ name: `s${index}`, ssh: `host${index}` }))
  const { errors } = normalizeSettings({ servers })
  assert.ok(errors.some(error => error.field === 'servers'))
})

test('SettingsStore persists, reloads, and honors defaults', () => {
  const directory = temporaryDirectory()
  try {
    const file = join(directory, 'settings.json')
    const store = new SettingsStore(file)
    assert.deepEqual(store.get(), defaultSettings())
    const saved = store.update({
      servers: [{ name: 'Demo', ssh: 'demo-host', port: null }],
      days: 5,
      pollMs: 3000,
    })
    assert.equal(saved.ok, true)
    const document = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(document.version, 1)
    assert.equal(document.days, 5)

    const reloaded = new SettingsStore(file)
    assert.equal(reloaded.get().servers.length, 1)
    assert.equal(reloaded.get().servers[0].name, 'Demo')
    assert.equal(reloaded.get().days, 5)
    assert.equal(reloaded.get().pollMs, 3000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SettingsStore rejects invalid writes without changing the document', () => {
  const directory = temporaryDirectory()
  try {
    const file = join(directory, 'settings.json')
    const store = new SettingsStore(file)
    const result = store.update({ servers: [{ name: 'X', ssh: '' }], days: 3, pollMs: 2000 })
    assert.equal(result.ok, false)
    assert.ok(result.errors.length > 0)
    assert.deepEqual(store.get(), defaultSettings())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SettingsStore recovers from a corrupt document', () => {
  const directory = temporaryDirectory()
  try {
    const file = join(directory, 'settings.json')
    writeFileSync(file, '{not json')
    const warnings = []
    const store = new SettingsStore(file, { logger: { warn: (...args) => warnings.push(args.join(' ')) } })
    assert.deepEqual(store.get(), defaultSettings())
    assert.ok(warnings.some(line => line.includes('invalid settings JSON')))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
