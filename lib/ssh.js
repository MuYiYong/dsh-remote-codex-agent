/**
 * SSH transport for the Codex Agent Host half.
 *
 * One process per operation, reusing the user's `~/.ssh/config` aliases and
 * public-key authentication. Credentials are never read, stored, or passed by
 * the plugin. Remote commands are streamed over stdin (`bash -ls`) so no shell
 * quoting of the script is needed; only validated pane ids and hashes are
 * interpolated into remote scripts.
 */

import { spawn } from 'node:child_process'

/** Default OpenSSH binary; overridable for tests or non-standard installations. */
const SSH_BIN = process.env.DSH_CODEX_AGENT_SSH_BIN || 'ssh'
/** Guard against a runaway remote command filling the Host process memory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
/**
 * Locale for the remote command. It must stay UTF-8: tmux sanitizes
 * non-printable/format characters to `_` under a plain C locale, which
 * collapses the `\x1f`-delimited pane records and breaks pane titles. C.UTF-8
 * keeps the protocol intact while still giving English tool messages.
 */
const REMOTE_LOCALE = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }

/** SSH keepalive so a dead transport is noticed on long-lived capture streams. */
const BASE_SSH_ARGS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'LogLevel=ERROR',
]

/**
 * Build the argv for one SSH invocation.
 * @param {{ ssh: string, port: number | null }} server - configured target.
 * @param {string[]} remoteArgs - remote command argv; the OpenSSH client joins it into one command.
 * @returns {string[]} argv for `spawn`.
 */
export function buildSshArgs(server, remoteArgs) {
  const args = [...BASE_SSH_ARGS]
  if (typeof server.port === 'number') args.push('-p', String(server.port))
  args.push(server.ssh, ...remoteArgs)
  return args
}

/**
 * Turn an SSH/program failure into a short user-facing message.
 * @param {{ code?: number | null, signal?: string | null, stderr?: string, spawnError?: string | null, timedOut?: boolean }} result - operation result.
 * @param {number} [timeoutMs] - whole-command deadline used by the caller.
 * @returns {string} concise diagnostic.
 */
export function describeSshFailure(result, timeoutMs) {
  if (result.spawnError) return `ssh 无法启动：${result.spawnError}`
  if (result.timedOut) return timeoutMs === undefined ? 'SSH 命令超时' : `SSH 命令超时（${timeoutMs / 1000} 秒）`
  const stderr = (result.stderr ?? '').trim()
  if (stderr !== '') {
    const first = stderr.split('\n').filter(line => line.trim() !== '').slice(-2).join(' ')
    return first.slice(0, 300)
  }
  return `ssh 退出码 ${result.code ?? 'unknown'}${result.signal ? `（${result.signal}）` : ''}`
}

/**
 * Run one finite remote command and collect its output.
 */
export class SshRunner {
  /**
   * @param {{ sshBin?: string, maxOutputBytes?: number, logger?: { warn?: (...args: unknown[]) => void } }} [options] - transport overrides.
   */
  constructor(options = {}) {
    this.sshBin = options.sshBin ?? SSH_BIN
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_CAPTURE_BYTES
    this.logger = options.logger
  }

  /**
   * Run a script through the remote login shell and wait for completion.
   * @param {{ ssh: string, port: number | null }} server - configured target.
   * @param {string} script - bash script sent on stdin.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, spawnError: string | null, durationMs: number }>}
   */
  runScript(server, script, options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000
    const startedAt = Date.now()
    return new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
      let child
      try {
        child = spawn(this.sshBin, buildSshArgs(server, ['bash', '-ls']), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...REMOTE_LOCALE },
          windowsHide: true,
        })
      } catch (error) {
        resolve({
          code: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: error?.message ?? String(error),
          durationMs: Date.now() - startedAt,
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let overflow = false
      /** @type {NodeJS.Timeout | undefined} */
      let forceTimer

      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }, 700).unref?.()
        // A grandchild can keep the inherited pipes open after the direct child
        // exits; do not let a timeout hang the poll loop indefinitely.
        forceTimer = setTimeout(() => {
          try { child.stdout.destroy() } catch { /* already closed */ }
          try { child.stderr.destroy() } catch { /* already closed */ }
          try { child.stdin.destroy() } catch { /* already closed */ }
          settle({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut, spawnError: null })
        }, 2000)
        forceTimer.unref?.()
      }, timeoutMs)
      timer.unref?.()

      const settle = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', abort)
        resolve({ ...result, durationMs: Date.now() - startedAt })
      }

      const abort = () => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }
      options.signal?.addEventListener('abort', abort, { once: true })

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > this.maxOutputBytes) {
          overflow = true
          try { child.kill('SIGTERM') } catch { /* already gone */ }
          return
        }
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk
      })
      child.on('error', (error) => {
        settle({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error?.message ?? String(error) })
      })
      child.on('close', (code, signal) => {
        options.signal?.removeEventListener('abort', abort)
        settle({
          code,
          signal,
          stdout,
          stderr: overflow ? `${stderr}\n输出超过 ${this.maxOutputBytes} 字节，已中止` : stderr,
          timedOut,
          spawnError: null,
        })
      })
      child.stdin.on('error', () => { /* remote closed stdin early */ })
      child.stdin.end(script)
    })
  }

  /**
   * Start a long-lived remote stream (FIFO capture) and hand chunks to callbacks.
   * @param {{ ssh: string, port: number | null }} server - configured target.
   * @param {string} script - bash script sent on stdin.
   * @param {{ onData: (chunk: string) => void, onStderr?: (chunk: string) => void, onClose?: (result: { code: number | null, signal: string | null, stderr: string, spawnError: string | null }) => void }} handlers - stream callbacks.
   * @returns {{ kill: (signal?: NodeJS.Signals) => void, pid: number | undefined }}
   */
  spawnStream(server, script, handlers) {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
    let child
    let stderr = ''
    let closed = false
    let spawnError = null
    try {
      child = spawn(this.sshBin, buildSshArgs(server, ['bash', '-ls']), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...REMOTE_LOCALE },
        windowsHide: true,
      })
    } catch (error) {
      spawnError = error?.message ?? String(error)
      queueMicrotask(() => handlers.onClose?.({ code: null, signal: null, stderr: '', spawnError }))
      return { kill: () => {}, pid: undefined }
    }
    const proc = child
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => handlers.onData(chunk))
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk
      handlers.onStderr?.(chunk)
    })
    const finish = (code, signal) => {
      if (closed) return
      closed = true
      handlers.onClose?.({ code, signal, stderr, spawnError })
    }
    proc.on('error', (error) => {
      spawnError = error?.message ?? String(error)
      finish(null, null)
    })
    proc.on('close', (code, signal) => finish(code, signal))
    proc.stdin.on('error', () => { /* remote closed stdin early */ })
    proc.stdin.end(script)
    return {
      pid: proc.pid,
      kill: (signal = 'SIGTERM') => {
        closed = true
        try { proc.kill(signal) } catch { /* already gone */ }
      },
    }
  }
}
