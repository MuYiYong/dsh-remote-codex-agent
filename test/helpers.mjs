/** Shared fixtures for dsh-remote-codex-agent Host tests. */

/** Base64-encode one transport field. */
export function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/** Hex-encode one field transported from SQLite. */
export function hex(value) {
  return Buffer.from(String(value), 'utf8').toString('hex')
}

/** Build one tmux pane record. */
export function tLine(options = {}) {
  const {
    sessionName = 'demo', windowIndex = 0, paneIndex = 0, paneTitle = '',
    panePid = 100, windowName = 'zsh', sessionId = '$1', paneId = '%1',
    active = 1, currentCommand = 'node',
  } = options
  return ['T', b64(sessionName), windowIndex, paneIndex, b64(paneTitle), panePid,
    b64(windowName), b64(sessionId), paneId, active, b64(currentCommand)].join('|')
}

/** Build one codex process record. */
export function pLine(options = {}) {
  const {
    paneId = '%1', cwd = '/home/me/project',
    cmdline = 'node /usr/local/bin/codex', pid = 200,
  } = options
  return ['P', paneId, b64(cwd), b64(cmdline), pid].join('|')
}

/** Build one SQLite session record. */
export function sLine(options = {}) {
  const {
    id = 'thread-1', title = '', cwd = '/home/me/project',
    updatedAt = Math.floor(Date.now() / 1000), rolloutPath = '', mtime = 0,
    source = 'sqlite',
    threadSource = '', parentThreadId = '', firstUserMessage = '', agentNickname = '',
  } = options
  return [
    'S', hex(id), hex(title), hex(cwd), updatedAt, hex(rolloutPath), mtime, source,
    hex(threadSource), hex(parentThreadId), hex(firstUserMessage), hex(agentNickname),
  ].join('|')
}

/** Build one JSONL fallback record. */
export function jLine(options = {}) {
  const {
    mtime = Math.floor(Date.now() / 1000),
    path = '/home/me/.codex/sessions/2026/11/24/rollout-2026-11-24T00-00-00-thread-1.jsonl',
    id = 'thread-1',
    cwd = '/home/me/project',
  } = options
  return ['J', mtime, b64(path), b64(id), b64(cwd)].join('|')
}

/** Build one user instruction record. */
export function uLine(id, line) {
  return ['U', hex(id), b64(line)].join('|')
}

/** Build one remote warning record. */
export function eLine(area, message) {
  return ['E', area, b64(message)].join('|')
}

/** Wrap records into a complete discovery transcript. */
export function discoveryOutput(lines) {
  return ['DSH1', ...lines, 'END', ''].join('\n')
}
