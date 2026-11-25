import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAttachCommand, escapeDoubleQuoted, sshPrefix } from '../lib/commands.js'
import { locateSessions, scorePaneMatch } from '../lib/locate.js'

function pane(overrides = {}) {
  return {
    paneId: '%1',
    sessionName: 'oinx',
    windowIndex: 0,
    paneIndex: 1,
    paneTitle: '',
    windowName: 'zsh',
    codexProcs: [],
    ...overrides,
  }
}

function session(overrides = {}) {
  return {
    id: 'thread-1',
    title: 'Fix login flow',
    cwd: '/home/me/project',
    cwdName: 'project',
    activityAt: Date.now(),
    ...overrides,
  }
}

test('title match wins over process match', () => {
  const match = scorePaneMatch(session(), pane({ paneTitle: 'Fix login flow' }))
  assert.equal(match.matchedBy, 'title')
  assert.equal(match.score, 104)
})

test('process cwd match locates a pane without a useful title', () => {
  const match = scorePaneMatch(session(), pane({
    paneTitle: 'zsh',
    codexProcs: [{ cwd: '/home/me/project', cmdline: 'node codex', pid: 1 }],
  }))
  assert.equal(match.matchedBy, 'process')
  assert.equal(match.score, 99)
})

test('a path prefix is a weaker but accepted process match', () => {
  const match = scorePaneMatch(session(), pane({
    paneTitle: '',
    codexProcs: [{ cwd: '/home/me/project/subdir', cmdline: 'codex', pid: 1 }],
  }))
  assert.equal(match.matchedBy, 'process')
  assert.equal(match.score, 86)
})

test('generic pane titles do not match', () => {
  assert.equal(scorePaneMatch(session({ title: 'codex', cwdName: '' }), pane({ paneTitle: 'codex' })), null)
  assert.equal(scorePaneMatch(session({ title: '', cwdName: '' }), pane({ paneTitle: 'zsh' })), null)
})

test('prefers the user-owned thread over a child agent with the same process evidence', () => {
  const user = session({ id: 'user', title: 'Main task', threadSource: 'user' })
  const child = session({ id: 'child', title: 'Main task', threadSource: 'subagent', activityAt: Date.now() + 5000 })
  const located = locateSessions([child, user], [pane({ paneId: '%1', paneTitle: 'project' })])
  assert.equal(located.get('user').location.paneId, '%1')
  assert.equal(located.has('child'), false)
})

test('locateSessions assigns one pane per session and one session per pane', () => {
  const sessions = [
    session({ id: 'a', title: 'Alpha', activityAt: 2000 }),
    session({ id: 'b', title: 'Beta', activityAt: 1000 }),
  ]
  const panes = [
    pane({ paneId: '%1', paneTitle: 'Alpha' }),
    pane({ paneId: '%2', paneTitle: 'Beta' }),
  ]
  const located = locateSessions(sessions, panes)
  assert.equal(located.get('a').location.paneId, '%1')
  assert.equal(located.get('b').location.paneId, '%2')
  assert.equal(located.get('a').location.target, 'oinx:0.1')
})

test('locateSessions leaves unmatched sessions unlocated', () => {
  const located = locateSessions([session({ title: 'Nothing matches' })], [pane({ paneTitle: 'unrelated' })])
  assert.equal(located.size, 0)
})

test('locateSessions prefers the strongest match when two sessions compete for one pane', () => {
  const sessions = [
    session({ id: 'weak', title: 'Fix login flow', activityAt: 5000 }),
    session({ id: 'exact', title: 'Deploy', activityAt: 1000 }),
  ]
  const panes = [pane({ paneId: '%9', paneTitle: 'Deploy' })]
  const located = locateSessions(sessions, panes)
  assert.equal(located.get('exact').location.paneId, '%9')
  assert.equal(located.has('weak'), false)
})

test('builds the pane-precise attach command exactly as specified', () => {
  const { command, commandKind } = buildAttachCommand({ ssh: 'prod-ubuntu', port: null }, {
    sessionName: 'oinx', windowIndex: 0, paneIndex: 1,
  })
  assert.equal(command, 'ssh -t prod-ubuntu "tmux attach -t oinx:0 \\; select-pane -t oinx:0.1"')
  assert.equal(commandKind, 'pane')
})

test('degrades to a session attach command and includes a configured port', () => {
  const { command, commandKind } = buildAttachCommand({ ssh: 'me@example.com', port: 2222 }, {
    sessionName: 'oinx', windowIndex: null, paneIndex: null,
  })
  assert.equal(command, 'ssh -t -p 2222 me@example.com "tmux attach -t oinx"')
  assert.equal(commandKind, 'session')
})

test('returns no command without a tmux session', () => {
  assert.deepEqual(buildAttachCommand({ ssh: 'prod', port: null }, null), { command: null, commandKind: null })
  assert.deepEqual(buildAttachCommand({ ssh: 'prod', port: null }, { sessionName: '' }), { command: null, commandKind: null })
})

test('escapes shell-significant characters inside the quoted tmux command', () => {
  const { command } = buildAttachCommand({ ssh: 'prod', port: null }, {
    sessionName: 'we"ird$name', windowIndex: 2, paneIndex: 0,
  })
  assert.equal(command, 'ssh -t prod "tmux attach -t we\\"ird\\$name:2 \\; select-pane -t we\\"ird\\$name:2.0"')
  assert.equal(escapeDoubleQuoted('a`b\\c'), 'a\\`b\\\\c')
  assert.equal(escapeDoubleQuoted('run!now'), 'run\\!now')
  assert.equal(sshPrefix({ ssh: 'x', port: null }), 'ssh -t x')
})
