/**
 * Remote bash programs shipped with the plugin and the small amount of
 * validated text prepended to each one. Keeping the programs in `.sh` files
 * (instead of JavaScript template strings) avoids a second layer of shell
 * quoting and lets tests execute exactly what production sends.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const DISCOVERY_TEMPLATE = readFileSync(new URL('./scripts/discovery.sh', import.meta.url), 'utf8')
const CAPTURE_TEMPLATE = readFileSync(new URL('./scripts/capture.sh', import.meta.url), 'utf8')
const PANE_ID_PATTERN = /^%[0-9]+$/

/**
 * Build the remote discovery script for one poll.
 * @param {{ days: number }} options - display window in days.
 * @returns {string} bash script to send on the SSH stdin.
 */
export function discoveryScript({ days }) {
  const bounded = Number.isInteger(days) ? Math.min(30, Math.max(1, days)) : 3
  return `DSH_DAYS=${bounded}\n${DISCOVERY_TEMPLATE}`
}

/**
 * Stable FIFO hash for one server/pane pair. The configured server id is part
 * of the identity, so two entries that point at the same host cannot fight
 * over one FIFO or one pipe-pane.
 * @param {{ id?: string, ssh: string, port: number | null }} server - configured target.
 * @param {string} paneId - tmux pane id such as `%12`.
 * @returns {string} 16 hex characters.
 */
export function fifoHash(server, paneId) {
  return createHash('sha1')
    .update(`${server.id ?? ''}\u0000${server.ssh}\u0000${server.port ?? ''}\u0000${paneId}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Build the long-lived capture script for one pane.
 * @param {{ paneId: string, hash: string }} options - validated pane identity.
 * @returns {string} bash script to send on the SSH stdin.
 */
export function captureScript({ paneId, hash }) {
  if (!PANE_ID_PATTERN.test(paneId)) throw new Error(`invalid tmux pane id: ${paneId}`)
  if (!/^[A-Za-z0-9]{1,64}$/.test(hash)) throw new Error(`invalid fifo hash: ${hash}`)
  return `PANE_ID='${paneId}'\nFIFO_HASH='${hash}'\n${CAPTURE_TEMPLATE}`
}
