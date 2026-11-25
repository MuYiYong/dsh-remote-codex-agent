import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOsc7501Parser, decodeOscMessage, mapOscState, parseOsc7501Payload, sanitizeMessage,
} from '../lib/osc.js'

const ESC = '\u001b'
const ST = '\u001b\\'
const BEL = '\u0007'

test('parses app/state/kind and a base64 message', () => {
  const message = Buffer.from('Allow this command?').toString('base64')
  const parsed = parseOsc7501Payload(`app=codex:state=blocked:kind=permission:msg=${message}`)
  assert.equal(parsed.app, 'codex')
  assert.equal(parsed.state, 'blocked')
  assert.equal(parsed.kind, 'permission')
  assert.equal(parsed.message, 'Allow this command?')
})

test('accepts unknown states but preserves the raw value', () => {
  const parsed = parseOsc7501Payload('app=codex:state=thinking')
  assert.equal(parsed.state, 'unknown')
  assert.equal(parsed.rawState, 'thinking')
})

test('ignores payloads without app or state', () => {
  assert.equal(parseOsc7501Payload('foo=bar'), null)
  assert.equal(parseOsc7501Payload(''), null)
})

test('decodes and sanitizes control characters in messages', () => {
  assert.equal(decodeOscMessage(Buffer.from('  hi\u0000\nthere  ').toString('base64')), 'hi there')
  assert.equal(sanitizeMessage('x'.repeat(400)).length, 300)
  assert.equal(decodeOscMessage('not base64!!'), '')
})

test('stream parser handles chunks split inside the marker and the terminator', () => {
  const parser = createOsc7501Parser()
  const first = parser.push(`${ESC}]750`)
  const second = parser.push(`1;app=codex:state=working${ST.slice(0, 1)}`)
  const third = parser.push(`${ST.slice(1)}tail`)
  assert.deepEqual(first, [])
  assert.deepEqual(second, [])
  assert.equal(third.length, 1)
  assert.equal(third[0].state, 'working')
})

test('stream parser handles BEL termination and multiple events in one chunk', () => {
  const parser = createOsc7501Parser()
  const events = parser.push(
    `${ESC}]7501;app=codex:state=idle${BEL}noise${ESC}]7501;app=codex:state=done${ST}`,
  )
  assert.deepEqual(events.map(event => event.state), ['idle', 'done'])
})

test('stream parser ignores other OSC sequences and bounds an unterminated tail', () => {
  const parser = createOsc7501Parser({ maxBuffer: 32 })
  assert.deepEqual(parser.push(`${ESC}]0;window title${BEL}`), [])
  parser.push(`${ESC}]7501;app=codex:state=working`)
  parser.push('x'.repeat(100))
  // A later complete event still parses after the bounded buffer trims the tail.
  const events = parser.push(`${ESC}]7501;app=codex:state=error${BEL}`)
  assert.equal(events.length, 1)
  assert.equal(events[0].state, 'error')
})

test('maps Codex states to the UI state vocabulary', () => {
  assert.equal(mapOscState({ app: 'codex', state: 'working', rawState: 'working' }).state, 'working')
  assert.equal(mapOscState({ app: 'codex', state: 'failed', rawState: 'failed' }).state, 'error')
  assert.equal(mapOscState({ app: 'codex', state: 'clear', rawState: 'clear' }).state, 'idle')
  assert.equal(mapOscState({ app: 'codex', state: 'unknown', rawState: 'weird' }).state, 'unknown')
  assert.equal(mapOscState({ app: 'other', state: 'working', rawState: 'working' }), null)
})

test('blocked projections carry kind and decoded message', () => {
  const projected = mapOscState({
    app: 'codex',
    state: 'blocked',
    rawState: 'blocked',
    kind: 'question',
    message: 'What should I do next?',
  })
  assert.deepEqual(projected.blocked, { kind: 'question', message: 'What should I do next?' })
  const unmapped = mapOscState({ app: 'codex', state: 'blocked', rawState: 'blocked', kind: 'custom', message: '' })
  assert.equal(unmapped.blocked.kind, 'other')
  assert.equal(unmapped.blocked.message, '')
})
