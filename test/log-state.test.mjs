import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLogStateScript, parseLogStateOutput } from '../lib/log-state.js'

test('probe script base64-encodes paths and reads only event envelopes', () => {
  const script = buildLogStateScript([
    { index: 0, rolloutPath: '/home/me/.codex/sessions/a b/rollout-1.jsonl' },
    { index: 1, rolloutPath: '/home/me/rollout-2.jsonl' },
  ])
  const encoded = Buffer.from('/home/me/.codex/sessions/a b/rollout-1.jsonl').toString('base64')
  assert.match(script, new RegExp(encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(script, /"type":"event_msg","payload":\\\{"type":"\(task_started\|task_complete\)"/)
  assert.match(script, /DSH_LOG_STATE/)
})

test('probe parser keeps valid states and ignores malformed lines', () => {
  const parsed = parseLogStateOutput('L|0|working|123\nL|1|done|456\nL|2|absent|0\nL|3|bogus|9\nnot-a-record\nEND\n')
  assert.equal(parsed.complete, true)
  assert.deepEqual(parsed.states, [
    { index: 0, state: 'working', mtime: 123 },
    { index: 1, state: 'done', mtime: 456 },
    { index: 2, state: 'absent', mtime: 0 },
    { index: 3, state: 'unknown', mtime: 9 },
  ])
  assert.equal(parseLogStateOutput('L|0|working|123\n').complete, false)
})
