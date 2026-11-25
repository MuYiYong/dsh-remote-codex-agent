/**
 * Build the command a user copies from a session row.
 *
 * The server target is inserted exactly as configured (an SSH alias or
 * `user@host`); only characters that would break the command's outer double
 * quotes inside tmux targets are escaped. The plugin never guesses at tmux
 * configuration beyond the located session/window/pane.
 */

/**
 * Escape text for insertion between double quotes in a POSIX shell command.
 * @param {string} value - raw text.
 * @returns {string} escaped text.
 */
export function escapeDoubleQuoted(value) {
  return String(value).replace(/[\\"$`!]/g, character => `\\${character}`)
}

/**
 * Build the ssh prefix for one server.
 * @param {{ ssh: string, port: number | null }} server - configured target.
 * @returns {string} `ssh` prefix including `-t` and optional `-p`.
 */
export function sshPrefix(server) {
  const port = typeof server?.port === 'number' ? `-p ${server.port} ` : ''
  return `ssh -t ${port}${server?.ssh ?? ''}`
}

/**
 * Build a ready-to-run attach command.
 * @param {{ ssh: string, port: number | null }} server - configured target.
 * @param {{ sessionName?: string, windowIndex?: number, paneIndex?: number } | null} location - located tmux coordinates.
 * @returns {{ command: string | null, commandKind: 'pane' | 'session' | null }} command and its precision.
 */
export function buildAttachCommand(server, location) {
  const sessionName = typeof location?.sessionName === 'string' ? location.sessionName : ''
  if (sessionName === '') return { command: null, commandKind: null }
  const prefix = sshPrefix(server)
  const escapedSession = escapeDoubleQuoted(sessionName)
  const windowIndex = location?.windowIndex
  const paneIndex = location?.paneIndex
  if (Number.isInteger(windowIndex) && Number.isInteger(paneIndex)) {
    const windowTarget = `${sessionName}:${windowIndex}`
    const paneTarget = `${windowTarget}.${paneIndex}`
    return {
      command: `${prefix} "tmux attach -t ${escapeDoubleQuoted(windowTarget)} \\; select-pane -t ${escapeDoubleQuoted(paneTarget)}"`,
      commandKind: 'pane',
    }
  }
  return {
    command: `${prefix} "tmux attach -t ${escapedSession}"`,
    commandKind: 'session',
  }
}
