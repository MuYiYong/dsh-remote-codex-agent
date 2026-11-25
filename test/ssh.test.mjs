import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSshArgs, describeSshFailure, SshRunner } from '../lib/ssh.js'
import { discoveryScript } from '../lib/remote-scripts.js'
import { parseDiscoveryOutput } from '../lib/discovery-parse.js'

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-codex-agent-ssh-'))
}

/** Create a fake `ssh` that runs a local login bash instead of connecting. */
function installFakeSsh(directory) {
  const file = join(directory, 'ssh')
  writeFileSync(file, '#!/bin/sh\nexec bash -ls\n')
  chmodSync(file, 0o755)
  return file
}

test('buildSshArgs reuses BatchMode and the configured alias', () => {
  const args = buildSshArgs({ ssh: 'prod-ubuntu', port: null }, ['bash', '-ls'])
  assert.ok(args.includes('-o'))
  assert.ok(args.includes('BatchMode=yes'))
  assert.equal(args[args.length - 1], '-ls')
  assert.equal(args[args.length - 2], 'bash')
  assert.equal(args[args.length - 3], 'prod-ubuntu')
  assert.equal(args.includes('-p'), false)

  const withPort = buildSshArgs({ ssh: 'me@host', port: 2222 }, ['bash', '-ls'])
  assert.equal(withPort[withPort.indexOf('-p') + 1], '2222')
})

test('describeSshFailure explains timeout, missing binary and stderr', () => {
  assert.equal(describeSshFailure({ timedOut: true }), 'SSH 命令超时')
  assert.equal(describeSshFailure({ timedOut: true }, 2500), 'SSH 命令超时（2.5 秒）')
  assert.match(describeSshFailure({ spawnError: 'ENOENT' }), /ssh 无法启动/)
  assert.match(describeSshFailure({ code: 255, stderr: 'Permission denied (publickey).' }), /Permission denied/)
})

test('SshRunner streams a script over stdin and collects output', async () => {
  const directory = temporaryDirectory()
  const previousHome = process.env.HOME
  const previousCodex = process.env.CODEX_HOME
  try {
    const home = join(directory, 'home')
    const codexHome = join(directory, 'codex')
    mkdirSync(home, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    const db = join(codexHome, 'state_5.sqlite')
    execFileSync('sqlite3', [db, 'CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER)'])
    process.env.HOME = home
    process.env.CODEX_HOME = codexHome
    const sshBin = installFakeSsh(directory)
    const runner = new SshRunner({ sshBin })
    const result = await runner.runScript({ ssh: 'ignored', port: null }, discoveryScript({ days: 3 }), { timeoutMs: 30000 })
    assert.equal(result.code, 0)
    assert.equal(result.spawnError, null)
    assert.equal(result.timedOut, false)
    const parsed = parseDiscoveryOutput(result.stdout)
    assert.equal(parsed.protocol, true)
    assert.equal(parsed.complete, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodex
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SshRunner reports spawn errors without rejecting', async () => {
  const runner = new SshRunner({ sshBin: '/definitely/not/a/real/ssh' })
  const result = await runner.runScript({ ssh: 'x', port: null }, 'echo hi\n', { timeoutMs: 2000 })
  assert.equal(result.code, null)
  assert.match(result.spawnError, /ENOENT/)
})

test('SshRunner bounds a hanging remote command with the timeout', async () => {
  const directory = temporaryDirectory()
  try {
    const file = join(directory, 'ssh')
    writeFileSync(file, '#!/bin/sh\nsleep 10\n')
    chmodSync(file, 0o755)
    const runner = new SshRunner({ sshBin: file })
    const started = Date.now()
    const result = await runner.runScript({ ssh: 'x', port: null }, 'ignored\n', { timeoutMs: 300 })
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 5000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
