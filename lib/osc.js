/**
 * Parser for Codex CLI's OSC 7501 status channel.
 *
 * Wire form: `ESC ] 7501 ; key=value:key=value ESC \` (BEL is accepted as a
 * terminator too). The authoritative fields are `app=codex` and
 * `state=idle|working|blocked|done|error|clear`; `blocked` adds
 * `kind=permission|question|auth` and a base64-encoded `msg`.
 */

const START = '\u001b]7501;'
const ST = '\u001b\\'
const BEL = '\u0007'
const MAX_BUFFER = 64 * 1024
const MAX_MESSAGE = 300
const KNOWN_STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'failed', 'clear', 'needs_you', 'unknown'])

/**
 * Strip terminal control characters and bound one decoded message.
 * @param {string} value - decoded text.
 * @returns {string} safe display text.
 */
export function sanitizeMessage(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped.
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > MAX_MESSAGE ? `${cleaned.slice(0, MAX_MESSAGE - 1)}…` : cleaned
}

/**
 * Decode one base64 `msg=` field.
 * @param {string | undefined} encoded - base64 payload from the sequence.
 * @returns {string} sanitized message, or an empty string.
 */
export function decodeOscMessage(encoded) {
  if (typeof encoded !== 'string') return ''
  const candidate = encoded.replace(/\s+/g, '')
  if (candidate === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) return ''
  let decoded
  try {
    decoded = Buffer.from(candidate, 'base64').toString('utf8')
  } catch {
    return ''
  }
  return sanitizeMessage(decoded)
}

/**
 * Parse the body of one OSC 7501 sequence (everything after `ESC ] 7501 ;`).
 * @param {string} payload - `key=value:key=value` body.
 * @returns {{ app: string | null, state: string | null, rawState: string | null, kind: string | null, message: string, raw: string } | null}
 */
export function parseOsc7501Payload(payload) {
  if (typeof payload !== 'string' || payload === '') return null
  const fields = new Map()
  for (const part of payload.split(':')) {
    const equals = part.indexOf('=')
    if (equals <= 0) continue
    const key = part.slice(0, equals).trim().toLowerCase()
    const value = part.slice(equals + 1)
    if (key !== '') fields.set(key, value)
  }
  const stateValue = (fields.get('state') ?? '').trim().toLowerCase()
  const appValue = (fields.get('app') ?? '').trim().toLowerCase()
  if (stateValue === '' && appValue === '') return null
  const kindValue = (fields.get('kind') ?? '').trim().toLowerCase()
  return {
    app: appValue === '' ? null : appValue,
    state: stateValue === '' ? null : (KNOWN_STATES.has(stateValue) ? stateValue : 'unknown'),
    rawState: stateValue === '' ? null : stateValue,
    kind: kindValue === '' ? null : kindValue,
    message: decodeOscMessage(fields.get('msg')),
    raw: payload,
  }
}

/**
 * Incremental stream parser. Feed decoded text chunks, receive complete events.
 * @param {{ maxBuffer?: number }} [options] - parser bounds.
 * @returns {{ push: (chunk: string) => Array<{ app: string | null, state: string | null, rawState: string | null, kind: string | null, message: string, raw: string }>, reset: () => void }}
 */
export function createOsc7501Parser(options = {}) {
  const maxBuffer = options.maxBuffer ?? MAX_BUFFER
  let buffer = ''
  return {
    push(chunk) {
      if (typeof chunk !== 'string' || chunk === '') return []
      buffer += chunk
      const events = []
      for (;;) {
        const start = buffer.indexOf(START)
        if (start === -1) {
          // Retain a possible partial marker at the tail so a chunk boundary
          // inside `ESC ] 7501 ;` is not lost.
          if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer)
          break
        }
        if (start > 0) buffer = buffer.slice(start)
        const bodyStart = START.length
        const stEnd = buffer.indexOf(ST, bodyStart)
        const belEnd = buffer.indexOf(BEL, bodyStart)
        let end = -1
        let terminatorLength = 0
        if (stEnd !== -1 && (belEnd === -1 || stEnd < belEnd)) {
          end = stEnd
          terminatorLength = ST.length
        } else if (belEnd !== -1) {
          end = belEnd
          terminatorLength = BEL.length
        }
        if (end === -1) {
          // Incomplete sequence: keep it (bounded) until the next chunk.
          if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer)
          break
        }
        const payload = buffer.slice(bodyStart, end)
        buffer = buffer.slice(end + terminatorLength)
        const event = parseOsc7501Payload(payload)
        if (event !== null) events.push(event)
      }
      if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer)
      return events
    },
    reset() {
      buffer = ''
    },
  }
}

const KIND_LABELS = {
  permission: 'permission',
  question: 'question',
  auth: 'auth',
}

/**
 * Project one parsed OSC event to plugin state.
 * @param {{ app: string | null, state: string | null, rawState: string | null, kind: string | null, message: string }} event - parsed event.
 * @returns {{ state: 'working'|'blocked'|'idle'|'done'|'error'|'unknown', rawState: string, kind: string | null, message: string, blocked: { kind: 'permission'|'question'|'auth'|'other', message: string } | null } | null}
 */
export function mapOscState(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.app !== null && event.app !== 'codex') return null
  const rawState = event.rawState ?? event.state ?? ''
  let state
  switch (rawState) {
    case 'working':
      state = 'working'
      break
    case 'blocked':
    case 'needs_you':
      state = 'blocked'
      break
    case 'idle':
    case 'clear':
      state = 'idle'
      break
    case 'done':
      state = 'done'
      break
    case 'error':
    case 'failed':
      state = 'error'
      break
    default:
      state = 'unknown'
      break
  }
  const kind = event.kind !== null && Object.prototype.hasOwnProperty.call(KIND_LABELS, event.kind) ? KIND_LABELS[event.kind] : null
  const blocked = state === 'blocked'
    ? {
      kind: kind ?? 'other',
      message: sanitizeMessage(event.message ?? ''),
    }
    : null
  return {
    state,
    rawState: rawState === '' ? 'unknown' : rawState,
    kind,
    message: sanitizeMessage(event.message ?? ''),
    blocked,
  }
}
