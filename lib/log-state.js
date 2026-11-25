/**
 * Read-only fallback for an already-running Codex turn.
 *
 * Codex's OSC 7501 status stream is edge-triggered: a turn that started before
 * the Host attached its pipe-pane never re-emits its state. The rollout JSONL
 * still records `task_started` / `task_complete` events for every turn, so a
 * bounded batch probe can recover the current turn phase without touching the
 * TUI, tmux pane text, or the running process.
 *
 * The probe only runs for located sessions whose state is still unknown, at
 * most once per LOG_PROBE_INTERVAL_MS per server.
 */

/** A marker only matched in the event envelope, never in tool output. */
const EVENT_PATTERN = '"type":"event_msg","payload":\\{"type":"(task_started|task_complete)"'

/**
 * Build the remote batch probe script.
 * @param {Array<{ index: number, rolloutPath: string }>} targets - located session rollouts.
 * @returns {string} script executed through the Host's ssh runner.
 */
export function buildLogStateScript(targets) {
  const encoded = targets
    .map(target => Buffer.from(String(target.rolloutPath ?? ''), 'utf8').toString('base64'))
    .join('\n')
  return `i=0
while IFS= read -r encoded; do
  [ -n "$encoded" ] || continue
  path=$(printf '%s' "$encoded" | base64 -d 2>/dev/null)
  if [ -n "$path" ] && [ -f "$path" ]; then
    last=$(grep -a -o -E '${EVENT_PATTERN}' "$path" 2>/dev/null | tail -n 1)
    case "$last" in
      *'"task_started"'*) state=working ;;
      *'"task_complete"'*) state=done ;;
      *) state=unknown ;;
    esac
    mt=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || printf '0')
    printf 'L|%s|%s|%s\\n' "$i" "$state" "$mt"
  else
    printf 'L|%s|absent|0\\n' "$i"
  fi
  i=$((i+1))
done <<'DSH_LOG_STATE'
${encoded}
DSH_LOG_STATE
printf 'END\\n'
`
}

/**
 * Parse the probe transcript.
 * @param {string} stdout - remote probe output.
 * @returns {{ complete: boolean, states: Array<{ index: number, state: string, mtime: number }> }} parsed result.
 */
export function parseLogStateOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const states = []
  let complete = false
  for (const line of text.split('\n')) {
    if (line === 'END') {
      complete = true
      continue
    }
    if (!line.startsWith('L|')) continue
    const fields = line.split('|')
    if (fields.length < 4) continue
    const index = Number.parseInt(fields[1], 10)
    if (!Number.isInteger(index) || index < 0) continue
    const state = fields[2] === 'working' || fields[2] === 'done' ? fields[2] : fields[2] === 'absent' ? 'absent' : 'unknown'
    const mtime = Number.parseInt(fields[3], 10)
    states.push({ index, state, mtime: Number.isFinite(mtime) ? mtime : 0 })
  }
  return { complete, states }
}
