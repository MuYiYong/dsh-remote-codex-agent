import assert from 'node:assert/strict'
import test from 'node:test'
import {
  basenameOf, displayTitle, extractUserText, normalizeEpoch, parseDiscoveryOutput, parseSessionMeta,
} from '../lib/discovery-parse.js'
import { b64, discoveryOutput, eLine, jLine, pLine, sLine, tLine, uLine } from './helpers.mjs'

test('normalizes seconds and milliseconds', () => {
  assert.equal(normalizeEpoch(1_700_000_000), 1_700_000_000_000)
  assert.equal(normalizeEpoch(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(normalizeEpoch('oops'), 0)
  assert.equal(normalizeEpoch(0), 0)
})

test('basename handles trailing slashes and Windows separators', () => {
  assert.equal(basenameOf('/home/me/project/'), 'project')
  assert.equal(basenameOf('C:\\work\\project'), 'project')
  assert.equal(basenameOf(''), '')
})

test('parses panes, codex processes and sessions', () => {
  const updatedAt = Math.floor(Date.now() / 1000) - 60
  const output = discoveryOutput([
    tLine({ paneTitle: 'project', paneId: '%4', sessionName: 'oinx', windowIndex: 1, paneIndex: 2 }),
    pLine({ paneId: '%4', cwd: '/home/me/project' }),
    sLine({ id: 'thread-1', title: 'Fix login', cwd: '/home/me/project', updatedAt, rolloutPath: '/x/rollout.jsonl', mtime: updatedAt + 30 }),
  ])
  const parsed = parseDiscoveryOutput(output)
  assert.equal(parsed.protocol, true)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.panes.length, 1)
  assert.equal(parsed.panes[0].paneTitle, 'project')
  assert.equal(parsed.panes[0].windowIndex, 1)
  assert.equal(parsed.panes[0].paneIndex, 2)
  assert.equal(parsed.panes[0].codexProcs.length, 1)
  assert.equal(parsed.panes[0].codexProcs[0].cwd, '/home/me/project')
  assert.equal(parsed.sessions.length, 1)
  const session = parsed.sessions[0]
  assert.equal(session.id, 'thread-1')
  assert.equal(session.title, 'Fix login')
  assert.equal(session.updatedAt, updatedAt * 1000)
  assert.equal(session.rolloutMtime, (updatedAt + 30) * 1000)
  assert.equal(session.activityAt, (updatedAt + 30) * 1000)
  assert.equal(session.source, 'sqlite3')
})

test('parses extended thread metadata and flags subagent sessions', () => {
  const updatedAt = Math.floor(Date.now() / 1000)
  const parsed = parseDiscoveryOutput(discoveryOutput([
    sLine({
      id: 'thread-main', title: 'Main task', cwd: '/home/me/project', updatedAt,
      threadSource: 'user',
    }),
    sLine({
      id: 'thread-child', title: '', cwd: '/home/me/project', updatedAt: updatedAt - 1,
      threadSource: 'subagent', parentThreadId: 'thread-main', agentNickname: 'Peirce',
    }),
  ]))
  const main = parsed.sessions.find(session => session.id === 'thread-main')
  const child = parsed.sessions.find(session => session.id === 'thread-child')
  assert.equal(main.threadSource, 'user')
  assert.equal(main.isSubagent, false)
  assert.equal(child.threadSource, 'subagent')
  assert.equal(child.isSubagent, true)
  assert.equal(child.parentThreadId, 'thread-main')
  assert.equal(child.agentNickname, 'Peirce')
  assert.equal(child.title, 'project')
})

test('falls back to the latest user instruction and cwd basename for titles', () => {
  const updatedAt = Math.floor(Date.now() / 1000)
  const userLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please fix the failing login test' }] },
  })
  const parsed = parseDiscoveryOutput(discoveryOutput([
    sLine({ id: 'thread-1', title: '', cwd: '/home/me/project', updatedAt }),
    uLine('thread-1', userLine),
  ]))
  assert.equal(parsed.sessions[0].title, 'Please fix the failing login test')

  const noUser = parseDiscoveryOutput(discoveryOutput([
    sLine({ id: 'thread-2', title: '', cwd: '/home/me/other-project', updatedAt }),
  ]))
  assert.equal(noUser.sessions[0].title, 'other-project')

  const noTitleNoCwd = parseDiscoveryOutput(discoveryOutput([
    sLine({ id: 'abcdef123456', title: '', cwd: '', updatedAt }),
  ]))
  assert.equal(noTitleNoCwd.sessions[0].title, 'abcdef12')
})

test('extracts user text from several rollout event shapes', () => {
  assert.equal(
    extractUserText(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello there' } })),
    'hello there',
  )
  assert.equal(
    extractUserText(JSON.stringify({ type: 'message', role: 'user', content: 'plain content' })),
    'plain content',
  )
  assert.equal(
    extractUserText(JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ text: 'nested' }] } })),
    'nested',
  )
  assert.equal(extractUserText('not json'), '')
  assert.equal(extractUserText(JSON.stringify({ type: 'assistant', content: 'hi' })), '')
})

test('parses JSONL fallback session_meta shapes', () => {
  const withPayload = parseSessionMeta(
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-9', cwd: '/home/me/code' } }),
    '/x/rollout-a.jsonl',
  )
  assert.deepEqual(withPayload, { id: 'thread-9', cwd: '/home/me/code', title: '' })

  const flat = parseSessionMeta(JSON.stringify({ id: 'thread-8', cwd: '/home/me/code' }), '/x/rollout-b.jsonl')
  assert.deepEqual(flat, { id: 'thread-8', cwd: '/home/me/code', title: '' })

  const fromPath = parseSessionMeta('not json', '/x/rollout-2026-11-24T00-00-00-11111111-2222-3333-4444-555555555555.jsonl')
  assert.equal(fromPath.id, '11111111-2222-3333-4444-555555555555')
})

test('parses the JSONL fallback records', () => {
  const mtime = Math.floor(Date.now() / 1000) - 30
  const parsed = parseDiscoveryOutput(discoveryOutput([
    eLine('sqlite', 'no such table: threads'),
    jLine({ mtime }),
  ]))
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0].id, 'thread-1')
  assert.equal(parsed.sessions[0].cwd, '/home/me/project')
  assert.equal(parsed.sessions[0].source, 'jsonl')
  assert.equal(parsed.sessions[0].activityAt, mtime * 1000)
  assert.equal(parsed.warnings[0].area, 'sqlite')
})

test('parses a legacy JSONL record whose fourth field is the whole first line', () => {
  const firstLine = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-old', cwd: '/home/me/legacy' } })
  const legacy = ['J', Math.floor(Date.now() / 1000), b64('/x/rollout.jsonl'), b64(firstLine)].join('|')
  const parsed = parseDiscoveryOutput(discoveryOutput([legacy]))
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0].id, 'thread-old')
  assert.equal(parsed.sessions[0].cwd, '/home/me/legacy')
})

test('deduplicates sessions and keeps the SQLite observation', () => {
  const updatedAt = Math.floor(Date.now() / 1000)
  const parsed = parseDiscoveryOutput(discoveryOutput([
    jLine({ mtime: updatedAt - 100 }),
    sLine({ id: 'thread-1', title: 'From SQLite', updatedAt, mtime: updatedAt + 10 }),
  ]))
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0].title, 'From SQLite')
  assert.equal(parsed.sessions[0].source, 'sqlite3')
})

test('keeps sessions sorted by activity descending', () => {
  const now = Math.floor(Date.now() / 1000)
  const parsed = parseDiscoveryOutput(discoveryOutput([
    sLine({ id: 'old', title: 'Old', updatedAt: now - 1000 }),
    sLine({ id: 'new', title: 'New', updatedAt: now - 10 }),
  ]))
  assert.deepEqual(parsed.sessions.map(session => session.id), ['new', 'old'])
})

test('reports incomplete transcripts and tmux warnings', () => {
  const incomplete = parseDiscoveryOutput('DSH1\nT|x\n')
  assert.equal(incomplete.protocol, true)
  assert.equal(incomplete.complete, false)
  const withTmux = parseDiscoveryOutput(discoveryOutput([eLine('tmux', 'tmux 未安装')]))
  assert.equal(withTmux.warnings[0].area, 'tmux')
  assert.equal(withTmux.warnings[0].message, 'tmux 未安装')
})

test('invalid SQLite hex fields are dropped without throwing', () => {
  const parsed = parseDiscoveryOutput(discoveryOutput([
    ['S', 'zz', 'zz', 'zz', 1_700_000_000, 'zz', '0', 'sqlite'].join('|'),
  ]))
  assert.equal(parsed.complete, true)
  assert.equal(parsed.sessions.length, 0)
})

test('displayTitle falls back through user text, cwd and id', () => {
  assert.equal(displayTitle({ title: 'T', userText: 'U', cwd: '/a/b', id: 'x' }), 'T')
  assert.equal(displayTitle({ title: '', userText: 'U', cwd: '/a/b', id: 'x' }), 'U')
  assert.equal(displayTitle({ title: '', userText: '', cwd: '/a/b', id: 'x' }), 'b')
  assert.equal(displayTitle({ title: '', userText: '', cwd: '', id: '12345678-rest' }), '12345678')
})
