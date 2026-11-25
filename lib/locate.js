/**
 * Match Codex sessions to tmux panes.
 *
 * A session is the monitored object; a pane is only the clue for where it runs.
 * Matching therefore prefers the application-set pane title, then falls back to
 * a `codex` process in the pane's process tree whose working directory matches
 * the thread's cwd. Every session without a match stays visible and unlocated.
 */

const GENERIC_TITLES = new Set([
  'codex', 'terminal', 'shell', 'tmux', 'bash', 'zsh', 'sh', 'fish', 'node', 'python', 'python3',
  'claude', 'cursor', 'vim', 'nvim', 'less', 'man',
])

/**
 * Lowercase, trim, and collapse whitespace for comparison.
 * @param {unknown} value - candidate text.
 * @returns {string} normalized text.
 */
function normalize(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : ''
}

/**
 * Whether one path is the same as, or an ancestor of, another.
 * @param {string} left - one path.
 * @param {string} right - other path.
 * @returns {'equal' | 'prefix' | 'none'} relationship.
 */
function pathRelation(left, right) {
  // Remote hosts are case-sensitive Linux filesystems: compare paths exactly,
  // without the case folding used for human-facing titles.
  const a = typeof left === 'string' ? left.trim().replace(/\/+$/, '') : ''
  const b = typeof right === 'string' ? right.trim().replace(/\/+$/, '') : ''
  if (a === '' || b === '') return 'none'
  if (a === b) return 'equal'
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
    const tail = longer.slice(shorter.length + 1)
    return tail.includes('/') ? 'none' : 'prefix'
  }
  return 'none'
}

/**
 * Score one session/pane pair. Exported for tests.
 * @param {object} session - parsed session record.
 * @param {object} pane - parsed pane record.
 * @returns {{ score: number, matchedBy: 'title' | 'process' | 'title+process' } | null}
 */
export function scorePaneMatch(session, pane) {
  if (session === null || pane === null || typeof session !== 'object' || typeof pane !== 'object') return null
  const title = normalize(session.title)
  const cwdName = normalize(session.cwdName ?? (typeof session.cwd === 'string' ? session.cwd.split('/').filter(Boolean).pop() : ''))
  const paneTitle = normalize(pane.paneTitle)
  const titleUsable = title.length >= 3 && !GENERIC_TITLES.has(title)
  const cwdUsable = cwdName.length >= 3 && !GENERIC_TITLES.has(cwdName)
  const paneUsable = paneTitle.length >= 3 && !GENERIC_TITLES.has(paneTitle)

  let titleScore = 0
  if (titleUsable && paneUsable) {
    if (paneTitle === title) titleScore = 100
    else if (title.length >= 4 && paneTitle.includes(title)) titleScore = 72
    else if (paneTitle.length >= 4 && title.includes(paneTitle)) titleScore = 60
  }
  let cwdScore = 0
  if (cwdUsable && paneUsable) {
    if (paneTitle === cwdName) cwdScore = 68
    else if (paneTitle.includes(cwdName)) cwdScore = 62
    else if (cwdName.includes(paneTitle) && paneTitle.length >= 4) cwdScore = 44
  }

  let processScore = 0
  let processHit = false
  const procs = Array.isArray(pane.codexProcs) ? pane.codexProcs : []
  for (const proc of procs) {
    const relation = session.cwd !== undefined && proc.cwd !== undefined
      ? pathRelation(session.cwd, proc.cwd)
      : 'none'
    let score = 0
    if (relation === 'equal') score = 95
    else if (relation === 'prefix') score = 82
    else if (cwdUsable && normalize(proc.cwd).endsWith(`/${cwdName}`)) score = 74
    if (score === 0 && (cwdUsable || titleUsable)) {
      const command = normalize(proc.cmdline)
      if (command !== '') {
        if (cwdUsable && command.includes(cwdName)) score = 40
        else if (titleUsable && title.length >= 4 && command.includes(title)) score = 38
      }
    }
    if (score > 0) {
      processHit = true
      processScore = Math.max(processScore, score)
    }
  }

  const best = Math.max(titleScore, cwdScore, processScore)
  if (best === 0) return null
  const titleHit = titleScore > 0 || cwdScore > 0
  let matchedBy = 'process'
  if (titleHit && processHit) matchedBy = 'title+process'
  else if (titleHit) matchedBy = 'title'
  // A TUI pane runs one main thread and any number of child agents from the
  // same cwd; prefer the user-owned session when process evidence is equal.
  const sourceBonus = session.threadSource === 'user' ? 12 : session.threadSource === 'subagent' ? -2 : 0
  const titleBonus = titleUsable ? 4 : 0
  return { score: best + sourceBonus + titleBonus, matchedBy }
}

/**
 * Assign panes to sessions, preferring the strongest match and then the most
 * recently active session. Each pane and each session is claimed at most once.
 * @param {Array<object>} sessions - session records, already sorted by activity.
 * @param {Array<object>} panes - pane records.
 * @returns {Map<string, { location: object, matchedBy: string }>} location by session id.
 */
export function locateSessions(sessions, panes) {
  const bySession = new Map()
  if (!Array.isArray(sessions) || !Array.isArray(panes) || sessions.length === 0 || panes.length === 0) return bySession
  const candidates = []
  for (const session of sessions) {
    for (const pane of panes) {
      const match = scorePaneMatch(session, pane)
      if (match !== null) candidates.push({ session, pane, ...match })
    }
  }
  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return (right.session.activityAt ?? 0) - (left.session.activityAt ?? 0)
  })
  const usedPanes = new Set()
  const assigned = new Set()
  for (const candidate of candidates) {
    const sessionId = candidate.session.id
    const paneId = candidate.pane.paneId
    if (assigned.has(sessionId) || usedPanes.has(paneId)) continue
    assigned.add(sessionId)
    usedPanes.add(paneId)
    bySession.set(sessionId, {
      matchedBy: candidate.matchedBy,
      location: {
        sessionName: candidate.pane.sessionName,
        windowIndex: candidate.pane.windowIndex,
        paneIndex: candidate.pane.paneIndex,
        paneId: candidate.pane.paneId,
        paneTitle: candidate.pane.paneTitle,
        windowName: candidate.pane.windowName,
        matchedBy: candidate.matchedBy,
        target: `${candidate.pane.sessionName}:${candidate.pane.windowIndex}.${candidate.pane.paneIndex}`,
      },
    })
  }
  return bySession
}
