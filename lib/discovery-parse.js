/**
 * Parser for the line-oriented output of `lib/scripts/discovery.sh`.
 *
 * The remote half encodes every free-text field as base64 and joins fields with
 * `|`, so the Host never has to guess at tabs, spaces, or newlines inside tmux
 * titles, Codex thread titles, or paths.
 */

const MAX_TITLE = 200
const MAX_SUMMARY = 280
const MAX_CWD = 4096
const SESSION_ID_FALLBACK = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * Decode one base64 transport field.
 * @param {string | undefined} value - base64 text.
 * @returns {string} decoded UTF-8 text.
 */
export function decodeField(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Decode one hex transport field (SQLite values are hex-encoded in SQL).
 * @param {string | undefined} value - hex text.
 * @returns {string} decoded UTF-8 text.
 */
export function decodeHexField(value) {
  if (typeof value !== 'string' || value === '' || value.length % 2 !== 0) return ''
  if (!/^[0-9a-fA-F]+$/.test(value)) return ''
  try {
    return Buffer.from(value, 'hex').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Remove control characters and collapse whitespace.
 * @param {unknown} value - candidate text.
 * @param {number} max - maximum length.
 * @returns {string} cleaned text.
 */
export function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned
}

/**
 * Normalize a timestamp that may be seconds or milliseconds.
 * @param {unknown} value - numeric or numeric string.
 * @returns {number} milliseconds since the epoch, or 0 when unknown.
 */
export function normalizeEpoch(value) {
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return 0
  if (numeric > 1_000_000_000_000) return Math.round(numeric)
  return Math.round(numeric * 1000)
}

/**
 * Directory name of a POSIX or Windows-style path.
 * @param {string} value - path.
 * @returns {string} final path segment.
 */
export function basenameOf(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Extract text from one user-message content payload.
 * @param {unknown} content - string, array, or object.
 * @returns {string} extracted text.
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item)
      } else if (item !== null && typeof item === 'object') {
        if (typeof item.text === 'string') parts.push(item.text)
        else if (typeof item.content === 'string') parts.push(item.content)
        else if (item.text !== null && typeof item.text === 'object' && typeof item.text.value === 'string') parts.push(item.text.value)
      }
    }
    return parts.join(' ')
  }
  return ''
}

/**
 * Walk one JSON value looking for a user message.
 * @param {unknown} value - parsed rollout line.
 * @param {number} depth - recursion guard.
 * @returns {string} user text, or an empty string.
 */
function findUserText(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUserText(item, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  const object = /** @type {Record<string, unknown>} */ (value)
  if (object.role === 'user') {
    const direct = typeof object.message === 'string'
      ? object.message
      : contentText(object.content)
    if (direct.trim() !== '') return direct
  }
  if (object.type === 'user_message' && typeof object.message === 'string' && object.message.trim() !== '') {
    return object.message
  }
  if (object.type === 'user' && typeof object.message === 'string' && object.message.trim() !== '') {
    return object.message
  }
  for (const key of ['payload', 'event_msg', 'response_item', 'message', 'session_meta']) {
    if (object[key] !== undefined) {
      const found = findUserText(object[key], depth + 1)
      if (found !== '') return found
    }
  }
  return ''
}

/**
 * Extract the latest user instruction from one rollout JSONL line.
 * @param {string} line - a JSON object line from a rollout file.
 * @returns {string} sanitized, bounded user text.
 */
export function extractUserText(line) {
  if (typeof line !== 'string' || line.trim() === '') return ''
  try {
    const parsed = JSON.parse(line)
    const found = cleanText(findUserText(parsed), MAX_SUMMARY)
    if (found !== '') return found
  } catch {
    // Older rollout lines are still JSON; fall through to a tolerant regex.
  }
  const match = /"(?:message|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line)
  if (match === null) return ''
  try {
    return cleanText(JSON.parse(`"${match[1]}"`), MAX_SUMMARY)
  } catch {
    return cleanText(match[1], MAX_SUMMARY)
  }
}

/**
 * Extract session identity and working directory from a rollout's first line.
 * @param {string} firstLine - JSON `session_meta` line.
 * @param {string} path - rollout path, used for the id fallback.
 * @returns {{ id: string, cwd: string, title: string } | null} metadata or null.
 */
export function parseSessionMeta(firstLine, path) {
  let parsed = null
  if (typeof firstLine === 'string' && firstLine.trim() !== '') {
    try {
      parsed = JSON.parse(firstLine)
    } catch {
      parsed = null
    }
  }
  const candidates = [
    parsed,
    parsed?.payload,
    parsed?.session_meta,
    parsed?.meta,
  ].filter(value => value !== null && typeof value === 'object' && !Array.isArray(value))
  let id = ''
  let cwd = ''
  let title = ''
  for (const candidate of candidates) {
    if (id === '' && typeof candidate.id === 'string') id = candidate.id
    if (id === '' && typeof candidate.session_id === 'string') id = candidate.session_id
    if (cwd === '' && typeof candidate.cwd === 'string') cwd = candidate.cwd
    if (title === '' && typeof candidate.title === 'string') title = candidate.title
  }
  if (id === '' && typeof path === 'string') {
    const match = SESSION_ID_FALLBACK.exec(path)
    if (match !== null) id = match[1]
  }
  if (id === '') return null
  return { id, cwd: cleanText(cwd, MAX_CWD), title: cleanText(title, MAX_TITLE) }
}

/**
 * Create a mutable session record.
 * @param {object} init - initial fields.
 * @returns {object} normalized session record.
 */
function makeSession(init) {
  const updatedAt = normalizeEpoch(init.updatedAt)
  const rolloutMtime = normalizeEpoch(init.rolloutMtime)
  return {
    id: init.id,
    title: cleanText(init.title, MAX_TITLE),
    cwd: cleanText(init.cwd, MAX_CWD),
    updatedAt,
    rolloutPath: typeof init.rolloutPath === 'string' ? init.rolloutPath : '',
    rolloutMtime,
    source: init.source === 'jsonl' ? 'jsonl' : 'sqlite3',
    threadSource: typeof init.threadSource === 'string' ? init.threadSource : '',
    parentThreadId: typeof init.parentThreadId === 'string' ? init.parentThreadId : '',
    firstUserMessage: cleanText(init.firstUserMessage, MAX_SUMMARY),
    agentNickname: cleanText(init.agentNickname, 80),
    isSubagent: init.isSubagent === true,
    userText: '',
    activityAt: Math.max(updatedAt, rolloutMtime),
  }
}

/**
 * Resolve the title a row displays: thread title, latest user instruction,
 * working directory basename, then an id prefix.
 * @param {object} session - session record.
 * @returns {string} display title.
 */
export function displayTitle(session) {
  const candidates = [session?.title, session?.userText, session?.firstUserMessage, basenameOf(session?.cwd ?? '')]
  for (const candidate of candidates) {
    const text = cleanText(candidate, MAX_TITLE)
    if (text !== '') return text
  }
  const id = typeof session?.id === 'string' ? session.id : ''
  return id === '' ? 'unknown' : id.slice(0, 8)
}

/**
 * Parse the complete output of one discovery poll.
 * @param {string} stdout - remote stdout.
 * @returns {{ protocol: boolean, complete: boolean, panes: Array<object>, sessions: Array<object>, warnings: Array<{ area: string, message: string }> }}
 */
export function parseDiscoveryOutput(stdout) {
  const panes = []
  const paneById = new Map()
  const sessions = new Map()
  const userLines = new Map()
  const warnings = []
  let protocol = false
  let complete = false
  const ensurePane = (paneId) => {
    let pane = paneById.get(paneId)
    if (pane === undefined) {
      pane = {
        paneId,
        sessionName: '',
        windowIndex: null,
        paneIndex: null,
        paneTitle: '',
        panePid: null,
        windowName: '',
        sessionId: '',
        active: false,
        currentCommand: '',
        codexProcs: [],
      }
      paneById.set(paneId, pane)
      panes.push(pane)
    }
    return pane
  }

  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    if (line === 'DSH1') {
      protocol = true
      continue
    }
    if (line === 'END') {
      complete = true
      continue
    }
    const fields = line.split('|')
    switch (fields[0]) {
      case 'T': {
        if (fields.length < 11) break
        const paneId = fields[8]
        if (paneId === undefined || paneId === '') break
        const pane = ensurePane(paneId)
        pane.sessionName = decodeField(fields[1])
        pane.windowIndex = Number(fields[2])
        pane.paneIndex = Number(fields[3])
        pane.paneTitle = decodeField(fields[4])
        pane.panePid = Number(fields[5])
        pane.windowName = decodeField(fields[6])
        pane.sessionId = decodeField(fields[7])
        pane.active = fields[9] === '1'
        pane.currentCommand = decodeField(fields[10])
        break
      }
      case 'P': {
        if (fields.length < 5) break
        const pane = ensurePane(fields[1])
        pane.codexProcs.push({
          cwd: cleanText(decodeField(fields[2]), MAX_CWD),
          cmdline: cleanText(decodeField(fields[3]), 1000),
          pid: Number(fields[4]),
        })
        break
      }
      case 'S': {
        if (fields.length < 8) break
        const id = cleanText(decodeHexField(fields[1]), 128)
        if (id === '') break
        const source = fields[7] === 'jsonl' ? 'jsonl' : 'sqlite3'
        const threadSource = cleanText(fields.length > 8 ? decodeHexField(fields[8]) : '', 40)
        const parentThreadId = cleanText(fields.length > 9 ? decodeHexField(fields[9]) : '', 128)
        const firstUserMessage = fields.length > 10 ? decodeHexField(fields[10]) : ''
        const agentNickname = cleanText(fields.length > 11 ? decodeHexField(fields[11]) : '', 80)
        const record = makeSession({
          id,
          title: decodeHexField(fields[2]),
          cwd: decodeHexField(fields[3]),
          updatedAt: fields[4],
          rolloutPath: decodeHexField(fields[5]),
          rolloutMtime: fields[6],
          source,
          threadSource,
          parentThreadId,
          firstUserMessage,
          agentNickname,
        })
        const existing = sessions.get(id)
        if (existing === undefined) sessions.set(id, record)
        else mergeSession(existing, record)
        break
      }
      case 'J': {
        if (fields.length < 3) break
        const path = decodeField(fields[2])
        let id = ''
        let cwd = ''
        let title = ''
        if (fields.length >= 5) {
          id = cleanText(decodeField(fields[3]), 128)
          cwd = cleanText(decodeField(fields[4]), MAX_CWD)
        } else if (fields.length === 4) {
          // Legacy transcript shape: the whole first line was sent as JSON.
          const meta = parseSessionMeta(decodeField(fields[3]), path)
          if (meta !== null) {
            id = meta.id
            cwd = meta.cwd
            title = meta.title
          }
        }
        if (id === '') {
          const meta = parseSessionMeta('', path)
          if (meta !== null) id = meta.id
        }
        if (id === '') break
        const threadSource = cleanText(decodeField(fields[5]), 40)
        const record = makeSession({
          id,
          title,
          cwd,
          updatedAt: 0,
          rolloutPath: path,
          rolloutMtime: normalizeEpoch(fields[1]),
          source: 'jsonl',
          threadSource,
        })
        const existing = sessions.get(record.id)
        if (existing === undefined || existing.source !== 'sqlite3') {
          if (existing === undefined) sessions.set(record.id, record)
          else mergeSession(existing, record)
        }
        break
      }
      case 'U': {
        if (fields.length < 3) break
        const id = cleanText(decodeHexField(fields[1]), 128)
        if (id === '') break
        userLines.set(id, extractUserText(decodeField(fields[2])))
        break
      }
      case 'E': {
        if (fields.length < 3) break
        warnings.push({ area: cleanText(fields[1], 40), message: cleanText(decodeField(fields[2]), 400) })
        break
      }
      default:
        break
    }
  }

  for (const [id, userText] of userLines) {
    const session = sessions.get(id)
    if (session !== undefined && userText !== '') session.userText = userText
  }
  for (const session of sessions.values()) {
    session.activityAt = Math.max(session.updatedAt, session.rolloutMtime)
    session.isSubagent = session.threadSource === 'subagent'
      || session.threadSource === 'agent'
      || session.agentNickname !== ''
    session.title = displayTitle(session)
  }
  const ordered = [...sessions.values()].sort((left, right) => right.activityAt - left.activityAt)
  return { protocol, complete, panes, sessions: ordered, warnings }
}

/**
 * Merge a duplicate session record into an existing one.
 * @param {object} target - retained record.
 * @param {object} incoming - newer observation.
 */
function mergeSession(target, incoming) {
  if (incoming.source === 'sqlite3' && target.source !== 'sqlite3') {
    target.title = incoming.title || target.title
    target.cwd = incoming.cwd || target.cwd
    target.rolloutPath = incoming.rolloutPath || target.rolloutPath
    target.source = 'sqlite3'
  } else {
    if (target.title === '' && incoming.title !== '') target.title = incoming.title
    if (target.cwd === '' && incoming.cwd !== '') target.cwd = incoming.cwd
    if (target.rolloutPath === '' && incoming.rolloutPath !== '') target.rolloutPath = incoming.rolloutPath
  }
  if (target.threadSource === '' && incoming.threadSource !== '') target.threadSource = incoming.threadSource
  if (target.parentThreadId === '' && incoming.parentThreadId !== '') target.parentThreadId = incoming.parentThreadId
  if (target.firstUserMessage === '' && incoming.firstUserMessage !== '') target.firstUserMessage = incoming.firstUserMessage
  if (target.agentNickname === '' && incoming.agentNickname !== '') target.agentNickname = incoming.agentNickname
  target.updatedAt = Math.max(target.updatedAt, incoming.updatedAt)
  target.rolloutMtime = Math.max(target.rolloutMtime, incoming.rolloutMtime)
  target.activityAt = Math.max(target.updatedAt, target.rolloutMtime)
}
