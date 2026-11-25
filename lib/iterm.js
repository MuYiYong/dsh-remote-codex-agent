/**
 * Host-only launcher for an existing tmux session: a tab in the current iTerm2
 * window when one is available, else a new window. The attach is interactive so
 * the user can type in the session they opened.
 */

import { execFile } from 'node:child_process'
import { constants, accessSync } from 'node:fs'

const ITERM_APP = '/Applications/iTerm.app'
const ITERM_BIN = `${ITERM_APP}/Contents/MacOS/iTerm2`
const OSASCRIPT = '/usr/bin/osascript'
const SSH_BIN = '/usr/bin/ssh'
const LAUNCH_TIMEOUT_MS = 45_000
const MAX_REQUEST_BYTES = 4096
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}:[^\x00-\x1f\x7f]{1,128}(?![\s\S])/
const HOST_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i
const SSH_PATTERN = /^(?!-)[A-Za-z0-9_.@:%-]{1,200}(?![\s\S])/
// Restrict tmux's own target/command grammar as well as both shell layers.
// In particular ':', '.', '%', '$' and ';' are not literal target characters.
const SESSION_PATTERN = /^[\p{L}\p{N}_ -]{1,128}(?![\s\S])/u

// Reuse a visible terminal window because that is where the user is already
// working. Hotkey windows are skipped: a session started from the Codex panel
// should not appear inside a floating quick-access window. When iTerm2 is not
// running, or only hotkey windows exist, a normal window is created instead.
const OPEN_SCRIPT = `on run argv
  set sshCommand to item 1 of argv
  tell application "${ITERM_APP}"
    activate
    try
      repeat with candidate in windows
        if not (is hotkey window of candidate) then
          -- A hotkey window may cover it, so bring the chosen window forward.
          select candidate
          tell candidate
            create tab with default profile command sshCommand
          end tell
          return "tab"
        end if
      end repeat
    on error
      -- A window may refuse a tab (for example while a sheet is open).
    end try
    create window with default profile command sshCommand
  end tell
  return "window"
end run`

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Exact Connection Fetch routes already require an authenticated owner. Gate
 * this native action more narrowly: a browser Peer on the actual loopback
 * listener, not an API Peer or a publicly bound listener with a spoofed Host.
 * DSH's Node bridge uses `http://dsh.internal` for Request.url; the real
 * authority is in Host and the listener's URL is from the webServer service.
 * Desktop's trusted dsh-app://app proxy strips Origin and Sec-Fetch-Site
 * before injecting the signed owner cookie. The POST requires a custom intent
 * header, which a cross-origin web page cannot send without a CORS preflight.
 */
export function isLocalITermRequest(request, connection, getListenerOrigin, requireIntent = false) {
  try {
    const listener = new URL(getListenerOrigin())
    if (!isLoopback(listener.hostname) || !['http:', 'https:'].includes(listener.protocol)) return false
    const host = request.headers.get('host')
    if (host === null || !HOST_PATTERN.test(host)) return false
    const authority = new URL(`${listener.protocol}//${host}`)
    if (!isLoopback(authority.hostname) || listener.port !== authority.port) return false
    if (requireIntent && request.headers.get('x-dsh-codex-view') !== '1') return false
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && (requireIntent || site !== 'none')) return false
    const origin = request.headers.get('origin')
    if (origin !== null ? origin !== authority.origin : requireIntent && site !== null) return false
    const admission = connection.admit(request)
    return 'peer' in admission && admission.peer.id === connection.browserPeer.id
  } catch {
    // Missing/not-ready listener or malformed headers: fail closed.
    return false
  }
}

/** Parse exactly {key} without buffering arbitrarily large request bodies. */
export async function readITermSessionKey(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return null
  const reader = request.body?.getReader()
  if (!reader) return null
  try {
    const bytes = new Uint8Array(MAX_REQUEST_BYTES)
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length > bytes.length - length) return null
      bytes.set(value, length)
      length += value.length
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !Object.hasOwn(body, 'key') || typeof body.key !== 'string' || !KEY_PATTERN.test(body.key)) return null
    return body.key
  } catch {
    return null
  } finally {
    // On an oversized stream DSH closes the unread connection after replying.
    reader.releaseLock()
  }
}

/** Get only a currently configured server whose location cache is still fresh. */
export function currentITermServer(configured, state) {
  return state?.status === 'online' && state.discoveryFresh === true && state.tmuxError === null
    && state.config.ssh === configured.ssh && state.config.port === configured.port
    ? state : null
}

/** Build an iTerm command queue entry from configured SSH and cached tmux data only. */
export function buildITermCommand(server, location) {
  const name = location?.sessionName
  if (typeof name !== 'string' || !SESSION_PATTERN.test(name) || name.trim() === '') return null
  if (typeof server?.ssh !== 'string' || !SSH_PATTERN.test(server.ssh)) return null
  const port = server.port
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null

  // A normal interactive client: the user must be able to type in the session
  // they opened. -E avoids updating the session environment, and -d is never
  // used so other attached clients stay connected. `-f ignore-size` (tmux >=
  // 3.2) keeps this window from resizing the session for the other clients;
  // older tmux rejects the flag, so retry a plain attach then. Precisely target
  // the named session, not its window/pane: attaching to those coordinates
  // would change the selection for existing clients.
  const target = `'=${name}'`
  const guarded = `tmux attach-session -f ignore-size -E -t ${target} 2>/dev/null || tmux attach-session -E -t ${target}`
  const remote = `tmux has-session -t ${target} && { ${guarded}; }`
  return [SSH_BIN, '-tt', '-a', '-x', '-o', 'ClearAllForwardings=yes', '-o', 'EscapeChar=none',
    '-o', 'PermitLocalCommand=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=5',
    ...(port === null ? [] : ['-p', String(port)]), '--', server.ssh, `"${remote}"`].join(' ')
}

/**
 * Test the fixed executables without opening the app. Bound and serialize the
 * AppleScript subprocess, which acknowledges tab or window creation, not SSH
 * login.
 */
export function createITermLauncher({ platform = process.platform, access = accessSync, execute = execFile } = {}) {
  let launching = false
  return {
    isAvailable() {
      if (platform !== 'darwin') return false
      try {
        for (const path of [ITERM_BIN, OSASCRIPT, SSH_BIN]) access(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    async launch(command) {
      if (launching) return { ok: false, error: { code: 'launch-in-progress', message: '正在打开 iTerm2，请稍候。' } }
      launching = true
      try {
        return await new Promise((resolve, reject) => {
          // Script source is constant; the SSH command is only data.
          execute(OSASCRIPT, ['-e', OPEN_SCRIPT, '--', command], {
            shell: false,
            timeout: LAUNCH_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: 8192,
          }, (error, stdout, stderr) => {
            const placement = stdout.trim()
            const known = placement === 'tab' || placement === 'window'
            if (error !== null || !known) reject(error ? { error, stderr } : {})
            else resolve({ ok: true, mode: placement })
          })
        })
      } catch (failure) {
        if (/(?:^|\D)-1743(?:\D|$)/.test(`${failure?.stderr ?? ''} ${failure?.error?.message ?? ''}`)) {
          return { ok: false, error: { code: 'automation-denied', message: 'macOS 未允许控制 iTerm2，请前往「系统设置 → 隐私与安全性 → 自动化」授权后重试。' } }
        }
        return { ok: false, error: { code: 'launch-failed', message: '无法在 iTerm2 中打开会话。请检查 macOS 自动化权限后重试。' } }
      } finally {
        launching = false
      }
    },
  }
}
