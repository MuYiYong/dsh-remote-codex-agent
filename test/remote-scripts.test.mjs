import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseDiscoveryOutput } from '../lib/discovery-parse.js'
import { captureScript, discoveryScript, fifoHash } from '../lib/remote-scripts.js'

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-codex-agent-script-'))
}

/**
 * Install a fake `tmux` that reports one pane and never touches a real server.
 * @param {string} binDirectory - directory placed first on PATH.
 * @param {string} title - pane title reported by `list-panes`.
 */
function installFakeTmux(binDirectory, title) {
  mkdirSync(binDirectory, { recursive: true })
  const script = `#!/bin/sh
if [ "$1" = "list-sessions" ]; then exit 0; fi
if [ "$1" = "list-panes" ]; then
  printf 'oinx\\0370\\0371\\037%s\\037123456\\037zsh\\037$1\\037%%7\\0371\\037node\\n' '${title}'
  exit 0
fi
exit 1
`
  const file = join(binDirectory, 'tmux')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
}

/**
 * Run the exact discovery script the Host sends over SSH.
 * @param {string} script - bash program.
 * @param {NodeJS.ProcessEnv} env - environment overrides.
 * @returns {{ stdout: string, stderr: string, status: number | null }}
 */
function runDiscovery(script, env) {
  const result = spawnSync('bash', ['-ls'], {
    input: script,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

test('discovery script reads SQLite threads and tmux panes end-to-end', () => {
  const directory = temporaryDirectory()
  try {
    const home = join(directory, 'home')
    const codexHome = join(directory, 'codex')
    const bin = join(directory, 'bin')
    const tmp = join(directory, 'tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    installFakeTmux(bin, 'Fix login flow')

    const now = Math.floor(Date.now() / 1000)
    const rollout = join(codexHome, 'rollout-1.jsonl')
    writeFileSync(rollout, '{"type":"session_meta","payload":{"id":"thread-1","cwd":"/home/me/project"}}\n')
    const db = join(codexHome, 'state_5.sqlite')
    execFileSync('sqlite3', [db, `
      CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER);
      INSERT INTO threads VALUES ('thread-1', 'Fix login flow', '/home/me/project', ${now - 60}, '${rollout}', 0);
    `])
    utimesSync(rollout, now - 30, now - 30)

    const script = discoveryScript({ days: 3 })
    const result = runDiscovery(script, {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmp,
      PATH: `${bin}:${process.env.PATH}`,
    })
    assert.equal(result.status, 0)
    const parsed = parseDiscoveryOutput(result.stdout)
    assert.equal(parsed.complete, true)
    assert.equal(parsed.panes.length, 1)
    assert.equal(parsed.panes[0].paneTitle, 'Fix login flow')
    assert.equal(parsed.sessions.length, 1)
    assert.equal(parsed.sessions[0].id, 'thread-1')
    assert.equal(parsed.sessions[0].title, 'Fix login flow')
    assert.equal(parsed.sessions[0].source, 'sqlite3')
    assert.equal(parsed.sessions[0].rolloutMtime, (now - 30) * 1000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Python fallback honors CODEX_HOME instead of the login home', () => {
  const directory = temporaryDirectory()
  try {
    const home = join(directory, 'home')
    const codexHome = join(directory, 'custom-codex')
    const bin = join(directory, 'bin')
    const tmp = join(directory, 'tmp')
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    installFakeTmux(bin, '')
    const now = Math.floor(Date.now() / 1000)
    const decoy = join(home, '.codex', 'state_5.sqlite')
    const real = join(codexHome, 'state_5.sqlite')
    execFileSync('sqlite3', [decoy, `
      CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER);
      INSERT INTO threads VALUES ('decoy-thread', 'decoy', '/decoy', ${now}, '', 0);
    `])
    execFileSync('sqlite3', [real, `
      CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER);
      INSERT INTO threads VALUES ('real-thread', 'real task', '/real', ${now}, '', 0);
    `])
    const result = runDiscovery(discoveryScript({ days: 3 }), {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmp,
      PATH: `${bin}:${process.env.PATH}`,
    })
    assert.equal(result.status, 0)
    const parsed = parseDiscoveryOutput(result.stdout)
    assert.deepEqual(parsed.sessions.map(session => session.id), ['real-thread'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('discovery script falls back to rollout session_meta without a database', () => {
  const directory = temporaryDirectory()
  try {
    const home = join(directory, 'home')
    const codexHome = join(directory, 'codex')
    const bin = join(directory, 'bin')
    const tmp = join(directory, 'tmp')
    const sessions = join(codexHome, 'sessions', '2026', '11', '24')
    mkdirSync(home, { recursive: true })
    mkdirSync(sessions, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    installFakeTmux(bin, '')

    const rollout = join(sessions, 'rollout-2026-11-24T00-00-00-thread-2.jsonl')
    // `session_id` is the ancestor thread of a resumed rollout; `id` is this
    // thread and must win.
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'ancestor-thread', id: 'thread-2', cwd: '/home/me/fallback' } })}\n`)

    const script = discoveryScript({ days: 3 })
    const result = runDiscovery(script, {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmp,
      PATH: `${bin}:${process.env.PATH}`,
    })
    assert.equal(result.status, 0)
    const parsed = parseDiscoveryOutput(result.stdout)
    assert.equal(parsed.complete, true)
    assert.equal(parsed.sessions.length, 1)
    assert.equal(parsed.sessions[0].id, 'thread-2')
    assert.equal(parsed.sessions[0].cwd, '/home/me/fallback')
    assert.equal(parsed.sessions[0].source, 'jsonl')
    assert.equal(parsed.panes.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('discovery script stays alive when tmux is missing and sessions are absent', () => {
  const directory = temporaryDirectory()
  try {
    const home = join(directory, 'home')
    const codexHome = join(directory, 'codex')
    const bin = join(directory, 'bin')
    const tmp = join(directory, 'tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    // A PATH with no tmux and no sqlite3 or real tools is unnecessary; hide tmux
    // only by pointing PATH at the empty bin plus the standard system paths
    // through a wrapper that does not contain tmux. Use /usr/bin:/bin on macOS,
    // which has no tmux, and keep our fake bin first.
    const result = runDiscovery(discoveryScript({ days: 3 }), {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmp,
      PATH: `${bin}:/usr/bin:/bin`,
    })
    assert.equal(result.status, 0)
    const parsed = parseDiscoveryOutput(result.stdout)
    assert.equal(parsed.complete, true)
    assert.equal(parsed.sessions.length, 0)
    assert.ok(parsed.warnings.some(warning => warning.area === 'tmux'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('capture script names a per-pane FIFO and guards pipe-pane with -o', () => {
  const script = captureScript({ paneId: '%12', hash: 'abcdef0123456789' })
  assert.match(script, /PANE_ID='%12'/)
  assert.match(script, /FIFO_HASH='abcdef0123456789'/)
  assert.match(script, /pipe-pane -Oo/)
  assert.match(script, /mkfifo/)
  assert.match(script, /cat "\$FIFO"/)
  assert.match(script, /pane_pipe/)
  assert.match(script, /OPENED=1/)
  assert.match(script, /\[ "\$OPENED" = 1 \]/)
  assert.throws(() => captureScript({ paneId: 'bad; rm -rf /', hash: 'abc' }))
  assert.throws(() => captureScript({ paneId: '%1', hash: '../../x' }))
})

test('fifoHash is stable and server-specific', () => {
  const first = fifoHash({ id: 'srv_a', ssh: 'prod', port: null }, '%1')
  const second = fifoHash({ id: 'srv_a', ssh: 'prod', port: null }, '%1')
  const other = fifoHash({ id: 'srv_a', ssh: 'prod', port: 2222 }, '%1')
  const sameTarget = fifoHash({ id: 'srv_b', ssh: 'prod', port: null }, '%1')
  assert.equal(first, second)
  assert.notEqual(first, other)
  assert.notEqual(first, sameTarget)
  assert.match(first, /^[0-9a-f]{16}$/)
})
