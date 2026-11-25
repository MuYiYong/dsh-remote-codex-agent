# dsh-codex-agent — Client half contract (for client.js)

This file is the implementation contract for `client.js` only. The Host half (`index.js`, `lib/`) is implemented separately and must not be edited by the client-half author. Do not change `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, or `docs/`.

## Deliverable

One file: `client.js`, a browser half in the DSH lazy-CJS format used by the shipped plugin templates:

```js
window.__ModuleLoader__.load({
  id: 'dsh-codex-agent',
  factory(require) {
    const React = require('react')
    // ... define components ...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // register locale dicts, sidebar entry, main panel, settings card
      },
    }
  },
})
```

Only `require('react')` may be requested. Do not import any `@deepseek-ai/*` package at runtime; do not use JSX (write `React.createElement` via a small `h` helper). No `child_process`, no Node APIs, no dynamic `import()`.

## What the browser half does

1. Register locale namespace `codex-agent` with complete `en` and `zh` dictionaries via `ctx.locale.register('codex-agent', { en, zh })` inside `ctx.effect(...)`.
2. Register the sidebar entry and main panel:
   - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'codex-agent', order, locale: 'codex-agent', label: () => t('panel') }, CodexAgentIcon))`
   - Order is dynamic: inside the inject callback call `ctx.slots.entriesOfSlot('sidebar.panellist')`; find the entry whose `options.id === 'schedules'` (the shipped 自动化任务 entry) and use `(thatOrder ?? 10) + 5`, so the entry lands directly below 自动化任务. Never hardcode 15 without this lookup.
   - `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'codex-agent', locale: 'codex-agent' }, CodexAgentPanel))`
   - `t` for the label: `ctx.locale.bind('codex-agent')`, called at projection time so the label follows locale changes.
3. Register the settings card:
   - Primary target requested by the spec is `agent-presets.settings`. That slot does not exist in the running DSH 0.2.2-rc.5 profile. At apply time check `ctx.slots.spec && ctx.slots.spec('agent-presets.settings')`; if it exists, register the card there (`id: 'codex-agent'`, `locale: 'codex-agent'`). Regardless, in this version register the card as its own settings page through `ctx.slots.inject('settings.section', ...)` with `id: 'codex-agent'`, `order: 21`, `locale: 'codex-agent'`, label thunk. Both registrations must be effect-owned/disposed correctly; it is acceptable (and expected) that the agent-presets branch does nothing in the current profile.
4. Use `ctx.effect` or `ctx.slots.inject` for every registration and dispose correctly. Component-local `<style data-plugin="dsh-codex-agent">` elements are fine (or a `<style>` element rendered by a wrapper); never append to `document.body`, never replace the app root, never read another plugin's DOM.

## HTTP API (Host half provides; same origin, authenticated cookie already present)

All calls: `fetch(path, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })`. Paths are relative (`/api/...`) so the Web GUI origin resolves them.

- `GET /api/codex-agent/settings` → `{ ok: true, settings: Settings }`
- `POST /api/codex-agent/settings` body = `Settings` (below) → `{ ok: true, settings }`, or 400 `{ ok: false, errors: [{ field, message }] }`
- `GET /api/codex-agent/servers` → `{ ok: true, generatedAt, settings, servers: ServerSummary[] }`
- `GET /api/codex-agent/sessions?days=N` → `{ ok: true, generatedAt, days, pollMs, captures: { active, total }, settings, servers: ServerView[] }`
- `POST /api/codex-agent/refresh` → `{ ok: true }`

### Settings

```ts
type Settings = {
  servers: Array<{ id?: string; name: string; ssh: string; port?: number | null }>
  days: number        // 1..30, default 3
  pollMs: number      // Host remote polling interval, 1000..60000, default 2000
}
```

The server id may be omitted for a new entry; the Host assigns one and returns the normalized settings (the settings card must replace its local list with the returned one after save).

### ServerView

```ts
type ServerView = {
  id: string
  name: string
  ssh: string
  port: number | null
  status: 'online' | 'unreachable' | 'checking'
  error: string | null            // SSH failure text when unreachable
  tmuxError: string | null        // tmux enumeration failure; location/copy unavailable only
  warnings: Array<{ area: string; message: string }> // non-fatal, e.g. sqlite fallback
  lastPollAt: number | null       // ms epoch
  lastOkAt: number | null
  sessions: SessionView[]         // already filtered to the requested days and sorted by activityAt desc
}

type SessionView = {
  key: string
  id: string
  title: string                   // display summary (thread title / last user instruction / cwd basename / id prefix)
  cwd: string
  cwdName: string
  updatedAt: number               // ms epoch (thread updated_at)
  activityAt: number              // ms epoch, max(updatedAt, rollout mtime)
  source: 'sqlite3' | 'jsonl'
  status: 'working' | 'blocked' | 'idle' | 'done' | 'error' | 'unknown' | 'unreachable'
  stateSource: 'osc' | 'none'
  stateUpdatedAt: number | null   // ms epoch of last OSC event
  blocked: { kind: 'permission' | 'question' | 'auth' | 'other'; message: string } | null
  hint: 'no-osc' | 'unlocated' | null
  location: null | {
    sessionName: string
    windowIndex: number
    paneIndex: number
    paneId: string
    paneTitle: string
    windowName: string
    matchedBy: 'title' | 'process' | 'title+process'
    target: string                // e.g. "demo:0.1"
  }
  command: string | null          // ready-to-copy SSH attach command
  commandKind: 'pane' | 'session' | null
  canOpenITerm: boolean          // local owner browser, iTerm2 available, fresh and safe tmux location
}
```

## Main panel behavior (slot `main`, key `codex-agent`)

Layout: a scrollable management page that fills the main column, matching the look of host management pages (Plugin Manager / schedules): page padding, a heading row, server sections, session rows, muted text via theme tokens. No cards with heavy borders; use `--dsw-alias-*` tokens only for colors, inherit font family/type scale.

- Header: title “Codex Agent”, a short subtitle showing `days` and poll state, a refresh button (POST refresh, then poll immediately), and a muted hint that servers are configured in 设置 → Codex Agent.
- Data lifecycle: one Client plugin-scoped loop polls cached `GET /api/codex-agent/sessions` (which uses the saved window) with a chained `setTimeout`. Abort on plugin disposal or explicit refresh. Keep last successful data while a poll fails; show a compact inline error banner with a retry button, not a full-page replacement.
- Sidebar: known status changes for the same session latch `Codex Agent · Updated` while the main panel is closed. Mounting the main panel acknowledges the changes. The first snapshot, a new display window, network failure and unknown/unreachable observations do not themselves trigger the indicator.
- Server sections in response order. First-level heading = server `name`; right side shows status: 在线 / SSH 不可达 / 检测中, with color + icon together (not color only). Unreachable servers still render their cached sessions, all marked unreachable. Show `error` as a muted line under the heading for unreachable servers. Show `tmuxError` as a warning line (“tmux 枚举失败，定位与复制命令不可用”). Show first `warnings[]` item as a muted warning line (e.g. “sqlite3 不可用，已回退到 rollout 文件”).
- Empty server (no sessions): keep the heading and show “近 N 天无活动会话”.
- Session rows, sorted as received. Leftmost column is the status marker; then title (bold), then meta row: relative activity time (refresh via a 30s local tick), cwd, tmux location (`demo:0.1` / pane title) or “未定位到运行终端”; then the copy button at the right. For `blocked`, add a second line with kind-specific label (等待批准 / 等待回答 / 等待登录 / 需要处理) and the decoded message. For `unknown` + `hint === 'no-osc'`, add muted hint “该会话无法通过原生状态通道监控”; for `unlocated`, hint “未定位到运行终端”. For `done`, show a check glyph; for `unreachable`, grey ✕ on every row of that server.
- Status marker: inline SVG (not emoji), 14–16 px, with `aria-label`/`title` localized text; shapes/colors: working = filled circle success token; blocked = filled circle warn token; idle = hollow circle idle token; done = check idle token; error = filled circle error token; unknown = question glyph idle/muted; unreachable = ✕ muted. Do not animate status transitions.
- Copy button: label 复制连接命令 / 已复制 (2s transient feedback, no toast library). Use `navigator.clipboard.writeText(command)`. If unavailable or rejected, keep the button enabled but beneath/next to it render the command as a selectable `<code>` text (`user-select: text`, wrap, monospace) so the user can manually copy; show a short “复制失败，请手动选择命令” note. Disable the button only when `command === null`, with title/aria-label “未定位到运行终端”.
- Use `session.command` verbatim for copying only. When `canOpenITerm` is true, show View / 查看 with a separate icon-only copy button.
- View sends same-origin `POST /api/codex-agent/open-iterm` with `Content-Type: application/json`, `X-DSH-Codex-View: 1` and exactly `{key}`. The Host requires the authenticated local owner and resolves the configured SSH destination and fresh tmux location itself. The action opens an interactive client on the currently selected view of the named session: a tab in the frontmost non-hotkey iTerm2 window when one exists, otherwise a window. It never detaches other clients and uses `-f ignore-size` where supported so the existing session window keeps its size. `{ok:true,mode:'tab'|'window'}` acknowledges tab or window creation, not a successful SSH login. Failure returns `{ok:false,error:{code,message}}`.
- Keyboard/focus: buttons are real `<button type="button">` with visible focus rings (`outline` using brand token), copy failure text is not hidden behind hover only.
- Light and dark themes: every color must be a `--dsw-alias-*` token; `color-mix`/opacity is fine. Use `--dsw-alias-bg-base`, `bg-layer-1`, `bg-layer-2`, `border-l1`, `border-l2`, `label-primary`, `label-secondary`, `brand-primary`, `state-success-primary`, `state-warn-primary`, `state-error-primary`, `state-idle-primary`, `specific-sidebar-fill`. No literal colors except inside the sidebar SVG artwork (which may use brand-like tones).
- Styles: render one `<style data-plugin="dsh-codex-agent">` element at the top of each top-level page/card component (React children) or inside a small wrapper; keep all class names prefixed `dca-`. Unmounting the component removes the style.

## Sidebar icon

`CodexAgentIcon` receives `{ size, active }`; render an original 24×24 viewBox SVG (terminal prompt + status dots is fine), no text, stroke/fill may use currentColor and brand/state tokens inline styles. Respect `size`; mark `aria-hidden` and set `focusable: false` because the sidebar owns the accessible button.

## Settings card behavior (slot `settings.section`, id `codex-agent`; also reusable in `agent-presets.settings` if present)

- Page heading “Codex Agent”, intro line “配置要监控的远端服务器；tmux 会话由插件自动发现，无需填写。”
- Server list editor: each row has name (`名称`), ssh (`SSH 别名或 user@host`), optional port (`端口`, blank = standard), delete button. An “添加服务器” button appends an empty row. At least one field validation runs client-side before save: name and ssh non-empty, port blank or 1–65535.
- Days: number input 1–30, default 3, label “展示天数（近 N 天）”.
- Poll interval: number input in seconds 1–60, default 2, label “轮询间隔（秒）”; convert to `pollMs` on save.
- “保存” button; while saving disable inputs and show 保存中…; on success show 已保存 for 2s and replace local state with the returned normalized settings. On failure show the first Host error message in a `role="alert"` block. Do not lose the user's draft on failure.
- Load existing settings on mount; show a compact loading state, and a retry state if the initial GET fails.
- Show a small server status summary under the editor (name + 在线/不可达/检测中 + error text) by calling `GET /api/codex-agent/servers` after load/save and on a 10s interval while mounted; this is optional to implement if time is constrained, but preferred.
- Styled as an inline settings section, not a modal: max-width around 760px, left-aligned.
- Reuse the same `t` dictionary and stylesheet; both slot components must be defined and registered.

## Locale

Provide both `en` and `zh` dictionaries for every key used. Register with `ctx.locale.register('codex-agent', { en, zh })` and dispose it. Keys must be flat (no nested objects) because `t('key')` looks up flat entries; interpolation `{n}` works. Cover at least: panel, title, subtitle, refresh, refreshing, settingsHint, online, unreachable, checking, noSessions, noServers, addServer, name, namePlaceholder, ssh, sshPlaceholder, port, portPlaceholder, days, daysUnit, pollSeconds, pollUnit, save, saving, saved, saveFailed, loadFailed, retry, copyCommand, copied, copyFailed, copyUnavailable, unlocated, blockedPermission, blockedQuestion, blockedAuth, blockedOther, unknownHint, tmuxFailed, sshFailed, sessionCount, lastActivity, justNow, minutesAgo, hoursAgo, daysAgo, serverStatus, noDescription, edit, delete, confirmDelete, cancel, validation.

Chinese copy should be natural and concise (e.g. 未定位到运行终端, 该会话无法通过原生状态通道监控, 等待批准, 等待回答, 等待登录, 近 N 天无活动会话). English sentence case.

## Constraints / review checklist

- `node --check client.js` must pass (plain ESM-ish script; it is a script, not a module, but syntax must be valid).
- No JSX. No optional chaining? Modern browser supports it, fine, but keep syntax conservative (Chromium 120+).
- No `require()` besides `react`.
- All registrations/effects cleaned up; no top-level side effects beyond `window.__ModuleLoader__.load`.
- No dependency on internal desktop shell services.
- Keep client.js self-contained (single file); no extra files.
- After writing, report: file size, exported components, registration ids/orders, locator keys, and anything not implemented.
