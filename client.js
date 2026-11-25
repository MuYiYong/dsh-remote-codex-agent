/**
 * Browser half of dsh-codex-agent.
 *
 * A sidebar entry plus a main management page that lists Codex CLI sessions
 * discovered on the configured remote servers, and a settings section that
 * edits the server list, the display window, and the polling interval. All
 * remote work stays on the Host half; this module only reads the plugin's
 * authenticated JSON routes and renders them with the host theme tokens.
 *
 * Loaded through the browser lazy-CJS module table, so the factory registers
 * one module and every side effect lives inside `apply`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-codex-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'codex-agent'
    /** Same-origin JSON API root served by the Host half. */
    const API_ROOT = '/api/codex-agent'
    /** Display window used before the stored settings arrive. */
    const DEFAULT_DAYS = 3
    /** Browser polling interval used before the stored settings arrive. */
    const DEFAULT_POLL_MS = 2000
    /** Lower bound the Host accepts for its own polling interval. */
    const MIN_POLL_MS = 1000
    /** Upper bound the Host accepts for its own polling interval. */
    const MAX_POLL_MS = 60000
    /** Local re-render cadence for relative times. */
    const TICK_MS = 30000
    /** How recently a changing pane title counts as live terminal activity. */
    const PANE_ACTIVE_MS = 5 * 60 * 1000
    /** Transient "copied" feedback duration. */
    const COPIED_MS = 2000
    const OPENED_NOTICE_MS = 4000
    /** Transient "saved" feedback duration. */
    const SAVED_MS = 2000
    /** Debounce before an autosave request is sent. */
    const AUTO_SAVE_DELAY_MS = 600
    /** Settings server-status summary refresh cadence. */
    const STATUS_REFRESH_MS = 10000
    /** Longest blocked/permission message rendered before truncation. */
    const MAX_DETAIL_LENGTH = 400

    // ---------------------------------------------------------------------
    // Locale dictionaries. Keys stay flat: t('key') looks up flat entries.
    // ---------------------------------------------------------------------

    const en = {
      panel: 'Codex Agent',
      panelUnread: 'Codex Agent · Updated',
      title: 'Codex Agent',
      subtitle: 'Last {days} days · refresh every {seconds}s',
      subtitleLoading: 'Connecting to the Host monitor…',
      overview: 'Sessions: {sessions} · Agents: {servers} · Last {days} days · every {seconds}s',
      subagents: 'Subagents {n}',
      showSubagents: 'Show subagent sessions',
      hideSubagents: 'Hide subagent sessions',
      hiddenSubagents: '+{n} subagents',
      hiddenSubagentsNotice: '{n} subagent sessions are hidden',
      onlySubagents: 'Only {n} subagent sessions in this window',
      subagent: 'Subagent',
      pollFailedHint: 'The Host monitor did not answer. Check the plugin status, then retry.',
      noServersHint: 'Add a remote agent in Settings → Codex Agent. tmux sessions are discovered automatically.',
      stepAddServer: 'Add an agent in Settings',
      stepOpenPanel: 'Return here to monitor sessions',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      refreshFailed: 'Refresh failed',
      settingsHint: 'Configure agents in Settings → Codex Agent',
      loading: 'Loading…',
      pollFailed: 'Could not load sessions',
      updatedAt: 'Updated {time}',
      retry: 'Retry',
      online: 'Online',
      unreachable: 'SSH unreachable',
      checking: 'Checking',
      noSessions: 'No active sessions in the last {n} days',
      noCachedSessions: 'SSH unreachable; no cached sessions',
      noServers: 'No agents configured',
      addServer: 'Add agent',
      name: 'Name',
      namePlaceholder: 'e.g. dev box',
      ssh: 'SSH alias or user@host',
      sshPlaceholder: 'e.g. dev or ubuntu@10.0.0.5',
      port: 'Port',
      days: 'Display window',
      daysUnit: 'days',
      pollSeconds: 'Polling interval',
      pollUnit: 'seconds',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed',
      loadFailed: 'Could not load settings',
      copyCommand: 'Copy attach command',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the command manually',
      viewSession: 'View',
      viewInITerm: 'Open in iTerm2 (interactive)',
      openingITerm: 'Opening…',
      openITermFailed: 'Could not open iTerm2. You can still copy the connection command.',
      openITermDenied: 'Allow iTerm2 under System Settings → Privacy & Security → Automation, then try again.',
      openITermUnavailable: 'iTerm2 is not available. You can still copy the connection command.',
      openSessionUnavailable: 'This session no longer has a current tmux location. Refresh and try again.',
      openITermBusy: 'iTerm2 is already opening. Try again in a moment.',
      openITermTabOpened: 'Opened in a new iTerm2 tab',
      openITermWindowOpened: 'Opened a new iTerm2 window',
      copyUnavailable: 'No attach command available',
      copyUnavailableShort: 'No command',
      unlocated: 'Terminal location unavailable',
      blockedPermission: 'Waiting for approval',
      blockedQuestion: 'Waiting for an answer',
      blockedAuth: 'Waiting for sign-in',
      blockedOther: 'Needs attention',
      unknownHint: 'This session is not monitored by the native status channel',
      paneActive: 'Terminal output is still changing ({time}) — Codex has not emitted an OSC 7501 state yet',
      tmuxFailed: 'tmux enumeration failed; terminal location and attach command are unavailable',
      sshFailed: 'SSH failed',
      hostNameRequired: 'Name is required',
      hostSshRequired: 'SSH alias or user@host is required',
      hostSshInvalid: 'SSH target contains unsupported characters',
      hostPortRange: 'Port must be an integer between 1 and 65535',
      hostDaysRange: 'Display window must be between 1 and 30 days',
      hostPollRange: 'Polling interval must be between 1 and 60 seconds',
      hostServersLimit: 'Too many agents are configured',
      hostSettingsInvalid: 'The settings document is invalid',
      hostSaveFailed: 'The settings could not be saved',
      hostRequestInvalid: 'The request was not valid JSON',
      sessionCount: '{n} sessions',
      sessionCountOne: '{n} session',
      lastActivity: 'Last activity',
      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      daysAgo: '{n} d ago',
      serverStatus: 'Agent status',
      noDescription: 'Untitled session',
      edit: 'Edit',
      delete: 'Delete',
      confirmDelete: 'Delete this agent?',
      cancel: 'Cancel',
      validation: 'Check the highlighted fields',
      statusWorking: 'Working',
      statusBlocked: 'Blocked',
      statusIdle: 'Idle',
      statusDone: 'Done',
      statusError: 'Error',
      statusUnknown: 'Unknown status',
      settingsIntro: 'Configure the remote agents to monitor. tmux sessions are discovered automatically; no manual entry is needed.',
      behaviorHint: 'The display window and how often the Host refreshes each agent.',
      daysHint: 'Sessions active within this window are shown.',
      pollHint: 'Host-side discovery interval. The panel reads its cached snapshot.',
      saveHint: "Changes are saved to this plugin's settings.",
      autoSaveOn: 'Autosave on',
      autoSaveWaiting: 'Fill in name and SSH to save',
      autoSaveInvalid: 'Fix the highlighted fields',
      autoSaveFailed: 'Autosave failed',
      autoSavedAt: 'Saved {time}',
      draft: 'Draft',
      statusSourceLog: 'State inferred from the session rollout log',
      tagline: 'Monitor remote Codex CLI sessions, their live state, and tmux terminals.',
      consoleKicker: 'REMOTE SESSION CONSOLE',
      configKicker: 'CONFIG / CODEX AGENT',
      teleLink: 'LINK',
      teleTasks: 'TASKS',
      teleAgents: 'AGENTS',
      teleActive: 'ACTIVE',
      teleWindow: 'WINDOW',
      telePoll: 'POLL',
      teleSync: 'SYNC',
      filterMain: 'MAIN',
      filterAll: 'ALL',
      serverCode: 'AGENT',
      serverNumber: 'AGENT {n}',
      sourceLog: 'LOG',
      subagentCount: '{n} subagents',
      expandSubagents: 'Expand subagents',
      collapseSubagents: 'Collapse subagents',
      autoSaveTag: 'AUTO-SAVE',
      activeCount: '{n} active',
      filterSessions: 'Session filter',
      mainOnly: 'Main sessions only',
      allSessions: 'All sessions, including subagents',
      serverStatusHint: 'Latest Host connection result for each configured agent.',
      servers: 'Codex Agent',
      server: 'Agent',
      behavior: 'Display and refresh',
      warning: 'Notice',
      warningSqlite: 'sqlite3 unavailable or the threads query failed; fell back to rollout files.',
      warningCodex: 'The Codex data directory was not found on this agent.',
      statusSshRetry: 'Retrying SSH',
      statusScanIncomplete: 'Scan incomplete',
      warningSshRetry: 'SSH check failed. Retrying automatically.',
      warningDiscoveryTimeout: 'SSH reached the server, but the session scan exceeded {seconds} seconds.',
      warningDiscoveryIncomplete: 'SSH reached the server, but the session scan did not finish.',
      cachedScan: 'Showing the last complete scan ({time}).',
      noScan: 'No complete session scan yet.',
      statusUnavailable: 'Agent status is temporarily unavailable',
      validationName: 'Name is required',
      validationSsh: 'SSH alias or user@host is required',
      validationPort: 'Port must be an integer between 1 and 65535',
      validationDays: 'Display window must be an integer between 1 and 30 days',
      validationPoll: 'Polling interval must be between 1 and 60 seconds',
    }

    const zh = {
      panel: 'Codex Agent',
      panelUnread: 'Codex Agent · 有更新',
      title: 'Codex Agent',
      subtitle: '近 {days} 天 · 每 {seconds} 秒刷新',
      subtitleLoading: '正在连接 Host 监控…',
      overview: '{sessions} 个会话 · {servers} 个 Agent · 近 {days} 天 · 每 {seconds} 秒刷新',
      subagents: '子代理 {n}',
      showSubagents: '显示子代理会话',
      hideSubagents: '隐藏子代理会话',
      hiddenSubagents: '+{n} 个子代理',
      hiddenSubagentsNotice: '{n} 个子代理会话已隐藏',
      onlySubagents: '该时间窗口内只有 {n} 个子代理会话',
      subagent: '子代理',
      pollFailedHint: 'Host 监控没有响应，请检查插件状态后重试。',
      noServersHint: '请在 设置 → Codex Agent 中添加远端 Agent；tmux 会话由插件自动发现。',
      stepAddServer: '在设置中添加 Agent',
      stepOpenPanel: '回到这里监控会话',
      refresh: '刷新',
      refreshing: '刷新中…',
      refreshFailed: '刷新失败',
      settingsHint: '在 设置 → Codex Agent 中配置 Agent',
      loading: '加载中…',
      pollFailed: '读取会话失败',
      updatedAt: '更新于 {time}',
      retry: '重试',
      online: '在线',
      unreachable: 'SSH 不可达',
      checking: '检测中',
      noSessions: '近 {n} 天无活动会话',
      noCachedSessions: 'SSH 不可达，暂无缓存会话',
      noServers: '尚未配置 Agent',
      addServer: '添加 Agent',
      name: '名称',
      namePlaceholder: '例如 开发机',
      ssh: 'SSH 别名或 user@host',
      sshPlaceholder: '例如 dev 或 ubuntu@10.0.0.5',
      port: '端口',
      days: '展示天数',
      daysUnit: '天',
      pollSeconds: '轮询间隔',
      pollUnit: '秒',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      loadFailed: '加载设置失败',
      copyCommand: '复制连接命令',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择命令',
      viewSession: '查看',
      viewInITerm: '查看（在 iTerm2 中打开，可输入）',
      openingITerm: '正在打开…',
      openITermFailed: '未能打开 iTerm2，仍可复制连接命令。',
      openITermDenied: '请在「系统设置 → 隐私与安全性 → 自动化」中允许控制 iTerm2，再重试。',
      openITermUnavailable: 'iTerm2 不可用，仍可复制连接命令。',
      openSessionUnavailable: '此会话已没有可用的 tmux 位置，请刷新后重试。',
      openITermBusy: '正在打开 iTerm2，请稍后重试。',
      openITermTabOpened: '已在 iTerm2 新标签页打开',
      openITermWindowOpened: '已新开 iTerm2 窗口',
      copyUnavailable: '未定位到运行终端',
      copyUnavailableShort: '无可用命令',
      unlocated: '未定位到运行终端',
      blockedPermission: '等待批准',
      blockedQuestion: '等待回答',
      blockedAuth: '等待登录',
      blockedOther: '需要处理',
      unknownHint: '该会话无法通过原生状态通道监控',
      paneActive: '终端仍在刷新（{time}）——Codex 尚未发送 OSC 7501 状态',
      tmuxFailed: 'tmux 枚举失败，定位与复制命令不可用',
      sshFailed: 'SSH 失败',
      hostNameRequired: '请填写名称',
      hostSshRequired: '请填写 SSH 别名或 user@host',
      hostSshInvalid: 'SSH 目标包含不支持的字符',
      hostPortRange: '端口需为 1–65535 的整数',
      hostDaysRange: '展示天数需为 1–30 的整数',
      hostPollRange: '轮询间隔需为 1–60 秒',
      hostServersLimit: 'Agent 数量超过上限',
      hostSettingsInvalid: '设置内容无效',
      hostSaveFailed: '设置保存失败',
      hostRequestInvalid: '请求内容不是有效的 JSON',
      sessionCount: '{n} 个会话',
      sessionCountOne: '{n} 个会话',
      lastActivity: '最近活动',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      serverStatus: 'Agent 状态',
      noDescription: '未命名会话',
      edit: '编辑',
      delete: '删除',
      confirmDelete: '确认删除该 Agent？',
      cancel: '取消',
      validation: '请检查输入内容',
      statusWorking: '正在工作',
      statusBlocked: '等待输入',
      statusIdle: '空闲',
      statusDone: '已完成',
      statusError: '出错',
      statusUnknown: '状态未知',
      settingsIntro: '配置要监控的远端 Agent；tmux 会话由插件自动发现，无需填写。',
      behaviorHint: '控制展示的时间窗口，以及 Host 刷新各 Agent 的频率。',
      daysHint: '只展示该时间窗口内有活动的会话。',
      pollHint: 'Host 侧发现间隔；面板读取 Host 缓存快照。',
      saveHint: '修改会保存到插件设置中。',
      autoSaveOn: '自动保存已开启',
      autoSaveWaiting: '填写名称和 SSH 后自动保存',
      autoSaveInvalid: '请修正标红项',
      autoSaveFailed: '自动保存失败',
      autoSavedAt: '已保存 {time}',
      draft: '草稿',
      statusSourceLog: '状态由会话 rollout 日志推断',
      tagline: '监控远端 Codex CLI 会话、实时状态与 tmux 终端。',
      consoleKicker: '远端会话控制台',
      configKicker: '配置 / CODEX AGENT',
      teleLink: '链路',
      teleTasks: '任务',
      teleAgents: '代理',
      teleActive: '进行',
      teleWindow: '窗口',
      telePoll: '轮询',
      teleSync: '同步',
      filterMain: '主任务',
      filterAll: '全部',
      serverCode: 'Agent',
      serverNumber: 'Agent {n}',
      sourceLog: '日志',
      subagentCount: '{n} 个子代理',
      expandSubagents: '展开子代理',
      collapseSubagents: '收起子代理',
      autoSaveTag: '自动保存',
      activeCount: '{n} 个进行中',
      filterSessions: '会话过滤',
      mainOnly: '仅显示主任务',
      allSessions: '显示全部会话（含子代理）',
      serverStatusHint: '每个 Agent 最近一次 Host 连接结果。',
      servers: 'Codex Agent',
      server: 'Agent',
      behavior: '展示与刷新',
      warning: '提示',
      warningSqlite: 'sqlite3 不可用或 threads 查询失败，已回退到 rollout 文件。',
      warningCodex: '该 Agent 上未找到 Codex 数据目录。',
      statusSshRetry: 'SSH 重试中',
      statusScanIncomplete: '会话采集未完成',
      warningSshRetry: '本次 SSH 检查失败，正在自动重试。',
      warningDiscoveryTimeout: 'SSH 已连通，但会话采集超过 {seconds} 秒。',
      warningDiscoveryIncomplete: 'SSH 已连通，但会话采集未完成。',
      cachedScan: '当前显示上次完整采集结果（{time}）。',
      noScan: '尚未完成首次会话采集。',
      statusUnavailable: 'Agent 状态暂时不可用',
      validationName: '请填写名称',
      validationSsh: '请填写 SSH 别名或 user@host',
      validationPort: '端口需为 1–65535 的整数',
      validationDays: '展示天数需为 1–30 的整数',
      validationPoll: '轮询间隔需为 1–60 秒',
    }

    // ---------------------------------------------------------------------
    // Styles. Colors come only from the documented alias tokens; the two
    // radii are plain geometry values. Class names use `dca-`.
    // ---------------------------------------------------------------------

    const STYLE_SHEET = `
/* ============================== page shell ============================== */
.dca-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.6;
}

.dca-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}

.dca-content {
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  padding: 0 clamp(24px, 4vw, 48px) 56px;
}

/* ============================== hero =================================== */
.dca-hero {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 28px 0 22px;
}

[data-platform='darwin'] .dca-hero {
  padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
}

.dca-heroMark {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-border-l1));
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-brand-primary);
}

.dca-heroText {
  flex: 1;
  min-width: 0;
}

.dca-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.dca-subtitle {
  margin: 3px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dca-heroMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-metaDot {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}

.dca-heroActions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

/* ============================== buttons ================================= */
.dca-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}

.dca-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.dca-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (hover: hover) {
  .dca-button:not(:disabled):hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dca-buttonPrimary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

@media (hover: hover) {
  .dca-buttonPrimary:not(:disabled):hover {
    background: var(--dsw-alias-button-primary-hover);
  }
}

.dca-buttonSmall {
  height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  font-size: 12px;
  line-height: 18px;
}

.dca-buttonDanger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

@media (hover: hover) {
  .dca-buttonDanger:not(:disabled):hover {
    background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  }
}

.dca-icon {
  flex: none;
  display: block;
}

.dca-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.dca-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.dca-switchDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.65;
}

.dca-switchOn {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  color: var(--dsw-alias-brand-primary);
}

@media (hover: hover) {
  .dca-switch:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .dca-switchOn:hover {
    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
  }
}

/* ============================== notices ================================= */
.dca-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, var(--dsw-alias-border-l1));
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, var(--dsw-alias-bg-layer-1));
  font-size: 13px;
  line-height: 20px;
}

.dca-bannerText {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dca-bannerDetail {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.dca-banner .dca-button {
  flex: none;
}

/* ============================== server cards ============================ */
.dca-serverList {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dca-card {
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-card-fill);
}

.dca-cardHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 14px;
}

.dca-cardHeadMain {
  min-width: 0;
}

.dca-serverTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dca-serverName {
  margin: 0;
  min-width: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dca-serverMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 8px;
  margin-top: 3px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 0.5px solid transparent;
  border-radius: 12px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.dca-statusIcon {
  flex: none;
}

.dca-status--online {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent);
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-status--unreachable {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}

.dca-status--checking {
  border-color: var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
}

.dca-cardNotice {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 9px 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.dca-cardNotice--error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.dca-cardNotice--warn {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent);
}

.dca-noticeLabel {
  flex: none;
  font-weight: 600;
}

.dca-noticeText {
  min-width: 0;
  overflow-wrap: anywhere;
}

.dca-warningIcon {
  flex: none;
  color: var(--dsw-alias-state-warn-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%, var(--dsw-alias-label-primary));
}

/* ============================== session rows ============================ */
.dca-sessionList {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dca-session {
  padding: 0 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dca-session:first-child {
  border-top: 0;
}

.dca-sessionRow {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 0 12px;
  align-items: start;
  padding: 14px 0;
}

@media (hover: hover) {
  .dca-session:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dca-marker {
  display: block;
  width: 18px;
  height: 18px;
  margin-top: 1px;
}

/* State tokens are tuned for fills, not thin glyphs. Mix toward the label color
   so the marker keeps the semantic hue while staying visible in both themes;
   the plain token line is the fallback for browsers without color-mix. */
.dca-marker--working {
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-primary));
}

.dca-marker--blocked {
  color: var(--dsw-alias-state-warn-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%, var(--dsw-alias-label-primary));
}

.dca-marker--idle,
.dca-marker--done {
  color: var(--dsw-alias-state-idle-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 55%, var(--dsw-alias-label-primary));
}

.dca-marker--error {
  color: var(--dsw-alias-state-error-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 82%, var(--dsw-alias-label-primary));
}

.dca-marker--unknown {
  color: var(--dsw-alias-label-secondary);
}

.dca-marker--unreachable {
  color: var(--dsw-alias-label-secondary);
  color: color-mix(in srgb, var(--dsw-alias-label-secondary) 70%, var(--dsw-alias-label-primary));
}

.dca-sessionBody {
  min-width: 0;
}

.dca-sessionTitleRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.dca-sessionTitle {
  min-width: 0;
  font-size: 14px;
  line-height: 21px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.dca-subBadge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 19px;
  padding: 0 7px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}

.dca-sessionMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 9px;
  margin-top: 3px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-time {
  white-space: nowrap;
}

.dca-metaText {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dca-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
}

.dca-location {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}

.dca-locationDot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}

.dca-locationChip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.dca-locationPane {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dca-sep {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
}

.dca-blocked {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 8px;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}

.dca-blockedLabel {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--dsw-alias-state-warn-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%, var(--dsw-alias-label-primary));
}

.dca-blockedMsg {
  flex: 1;
  min-width: 160px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.dca-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-hintGlyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
}

/* ============================== copy / command ========================== */
.dca-copyArea {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  padding-top: 1px;
}

.dca-copyButton {
  height: 30px;
  border-radius: 15px;
}

.dca-sessionActions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dca-copyButton.dca-copyButtonIcon {
  padding-inline: 0;
  width: 30px;
  min-width: 30px;
  justify-content: center;
}

.dca-copyMessage {
  max-width: 260px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  text-align: right;
}

.dca-commandWrap {
  padding: 0 0 14px 30px;
}

.dca-command {
  display: block;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 18px;
  overflow-wrap: anywhere;
  user-select: text;
}

/* ============================== empty states ============================ */
.dca-hiddenNotice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 9px 18px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 26px 18px 30px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}

.dca-emptyTitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dca-emptyText {
  max-width: 430px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}

.dca-emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 56px 24px 58px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-card-fill);
  text-align: center;
}

.dca-emptyIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  margin-bottom: 5px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  color: var(--dsw-alias-brand-primary);
}

.dca-emptyHeading {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dca-emptyCopy {
  max-width: 460px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dca-emptySteps {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 14px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dca-stepNum {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  font-weight: 600;
}

.dca-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 60px 24px;
  text-align: center;
}

.dca-stateTitle {
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dca-spinner {
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: dca-spin 0.8s linear infinite;
}

@keyframes dca-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .dca-spinner { animation-duration: 2.4s; }
}

/* ============================== settings =============================== */
.dca-settingsPage {
  box-sizing: border-box;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 0 0 20px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
}

.dca-settingsHero {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 4px 0 18px;
}

.dca-settingsHero .dca-heroMark {
  width: 38px;
  height: 38px;
  border-radius: 11px;
}

.dca-settingsTitle {
  margin: 0;
  font-size: 18px;
  line-height: 26px;
  font-weight: 500;
}

.dca-settingsIntro {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dca-cardPad {
  padding: 18px;
}

.dca-settingsHeroText {
  min-width: 0;
}

.dca-sectionHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.dca-addServer {
  margin-inline-start: auto;
}

.dca-sectionTitle {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
}

.dca-sectionHint {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-settingsBody {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dca-serverEditorList {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
}

.dca-serverRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) 108px 36px;
  gap: 12px;
  align-items: start;
  margin: 0;
  padding: 14px 0;
  border: 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  min-width: 0;
}

.dca-serverRow:first-child {
  border-top: 0;
  padding-top: 2px;
}

.dca-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.dca-fieldLabel {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dca-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}

.dca-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.dca-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.dca-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dca-inputInvalid {
  border-color: var(--dsw-alias-state-error-primary);
}

.dca-fieldError {
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.dca-fieldHint {
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.dca-rowActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 23px;
}

.dca-iconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.dca-iconButton:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

@media (hover: hover) {
  .dca-iconButton:hover:not(:disabled) {
    background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
    color: var(--dsw-alias-state-error-primary);
  }
}

.dca-rowConfirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  grid-column: 1 / -1;
  margin-top: 2px;
  padding: 9px 10px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, var(--dsw-alias-border-l1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.dca-editorEmpty {
  margin-top: 8px;
  padding: 24px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  text-align: center;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-formGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 12px;
}

.dca-numberField {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.dca-numberInputWrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dca-numberInput {
  box-sizing: border-box;
  width: 100px;
  height: 34px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}

.dca-numberInput:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.dca-numberInput.dca-inputInvalid {
  border-color: var(--dsw-alias-state-error-primary);
}

.dca-numberUnit {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-saveBar {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 20px;
  padding: 12px 0;
  background: var(--dsw-alias-bg-layer-2);
}

.dca-saveStatus {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.dca-saveStatusError {
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.dca-saved {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-savedIcon {
  flex: none;
}

.dca-statusList {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
}

.dca-statusItem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 9px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  line-height: 18px;
}

.dca-statusItem:first-child {
  border-top: 0;
}

.dca-statusName {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.dca-statusDetail {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.dca-visuallyHidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}


/* ============================== tech pass ============================== */
.dca-page {
  font-variant-numeric: tabular-nums;
  background:
    radial-gradient(900px 320px at 50% -180px, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent), transparent 72%),
    linear-gradient(color-mix(in srgb, var(--dsw-alias-label-primary) 2.2%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-primary) 2.2%, transparent) 1px, transparent 1px),
    var(--dsw-alias-bg-base);
  background-size: auto, 32px 32px, 32px 32px, auto;
}

.dca-content {
  padding-bottom: 64px;
}

.dca-hero {
  display: block;
  padding: 24px 0 18px;
}

.dca-heroTop {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.dca-heroIdentity {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 12px;
}

.dca-heroMark {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 9px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  color: var(--dsw-alias-label-primary);
}

.dca-heroMark::after {
  content: '';
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
}

.dca-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

.dca-prompt {
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary));
  font-weight: 700;
  letter-spacing: 0;
}

.dca-title {
  font-size: 21px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dca-subtitle {
  max-width: 620px;
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}

.dca-heroActions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}

.dca-iconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.dca-iconBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 2px;
}

.dca-iconBtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (hover: hover) {
  .dca-iconBtn:not(:disabled):hover {
    border-color: var(--dsw-alias-label-tertiary);
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dca-refreshIcon {
  display: inline-flex;
}

.dca-refreshIcon.isSpinning {
  animation: dca-spin 0.9s linear infinite;
}

.dca-filter {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

.dca-filterBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  cursor: pointer;
}

.dca-filterBtn.isActive {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  color: var(--dsw-alias-label-primary);
}

.dca-filterBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 1px;
}

.dca-filterCount {
  font-size: 9px;
  opacity: 0.6;
}

.dca-telemetry {
  display: flex;
  flex-wrap: wrap;
  overflow: hidden;
  margin-top: 14px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-card-fill) 62%, transparent);
}

.dca-teleItem {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-left: 0.5px solid var(--dsw-alias-border-l1);
}

.dca-teleItem:first-child {
  border-left: 0;
}

.dca-teleLabel {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 14px;
  letter-spacing: 0.12em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-teleValue {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dca-teleItem--ok .dca-teleValue {
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-teleItem--warn .dca-teleValue {
  color: var(--dsw-alias-state-warn-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-teleItem--error .dca-teleValue {
  color: var(--dsw-alias-state-error-primary);
}

.dca-teleItem--idle .dca-teleValue {
  color: var(--dsw-alias-label-tertiary);
}

.dca-card {
  position: relative;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-card-fill) 88%, transparent);
}

.dca-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent), transparent 58%);
  pointer-events: none;
}

.dca-serverList {
  gap: 12px;
}

.dca-cardHead {
  padding: 12px 16px 11px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
}

.dca-serverCode {
  flex: none;
  padding: 1px 5px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: var(--dsw-alias-bg-base);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 14px;
  letter-spacing: 0.08em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-serverName {
  font-size: 15px;
  line-height: 21px;
  font-weight: 600;
}

.dca-serverHeadRight {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dca-serverHash {
  font-size: 9px;
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.7;
}

.dca-serverActive {
  padding: 0 5px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent);
  border-radius: 4px;
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary));
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 16px;
}

.dca-session {
  position: relative;
  padding: 0 16px;
}

.dca-session::before {
  content: '';
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 0;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: transparent;
}

.dca-session--working::before {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}

.dca-session--blocked::before {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, transparent);
}

.dca-session--error::before {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent);
}

.dca-sessionRow {
  grid-template-columns: 24px 18px minmax(0, 1fr) auto;
  gap: 0 10px;
  padding: 12px 0;
}

.dca-sessionSeq {
  padding-top: 1px;
  overflow: hidden;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 18px;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.5;
}

.dca-sessionBody {
  padding-top: 0;
}

.dca-sessionBody--toggle {
  cursor: pointer;
}

.dca-sessionTitleRow {
  gap: 4px 7px;
}

.dca-sessionTitle {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
}

.dca-stateTag {
  flex: none;
  padding: 0 5px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 8.5px;
  line-height: 15px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

.dca-stateTag--working {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 26%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent);
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-stateTag--blocked {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent);
  color: var(--dsw-alias-state-warn-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%, var(--dsw-alias-label-primary));
}

.dca-stateTag--error {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.dca-sourceTag {
  flex: none;
  padding: 0 3px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 3px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 8px;
  line-height: 14px;
  letter-spacing: 0.08em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-sessionMeta {
  gap: 2px 8px;
  margin-top: 2px;
  font-size: 11px;
  line-height: 17px;
}

.dca-time {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10.5px;
}

.dca-locationChip {
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  font-size: 10px;
}

.dca-copyArea {
  padding-top: 0;
}

.dca-copyButton {
  height: 26px;
  border-radius: 6px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.02em;
}

.dca-marker {
  width: 16px;
  height: 16px;
  margin-top: 2px;
}

.dca-emptyState {
  position: relative;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-card-fill) 84%, transparent);
}


.dca-emptyIcon {
  width: 52px;
  height: 52px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  color: var(--dsw-alias-label-secondary);
}

.dca-emptyHeading {
  font-size: 15px;
  font-weight: 600;
}

.dca-stepNum {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

/* settings tech */
.dca-settingsHero {
  flex-wrap: wrap;
  align-items: flex-start;
  padding: 4px 0 15px;
  margin-bottom: 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.dca-settingsTitle {
  font-size: 18px;
  line-height: 25px;
  font-weight: 600;
}

.dca-settingsStatus {
  display: flex;
  flex: none;
  max-width: 100%;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  margin-left: auto;
  padding-top: 2px;
}

.dca-monoTag {
  padding: 1px 5px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 3px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 8.5px;
  line-height: 14px;
  letter-spacing: 0.12em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-autoStatus {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

.dca-autoDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}

.dca-autoStatus--saved .dca-autoDot {
  background: var(--dsw-alias-state-success-primary);
}

.dca-autoStatus--saved {
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-primary));
}

.dca-autoStatus--saving .dca-autoDot {
  background: var(--dsw-alias-state-warn-primary);
  animation: dca-pulse 1.1s ease-in-out infinite;
}

.dca-autoStatus--waiting .dca-autoDot {
  background: var(--dsw-alias-state-warn-primary);
}

.dca-autoStatus--error {
  color: var(--dsw-alias-state-error-primary);
}

.dca-autoStatus--error .dca-autoDot {
  background: var(--dsw-alias-state-error-primary);
}

.dca-autoRetry {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

@keyframes dca-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

.dca-settingsBody {
  gap: 12px;
}

.dca-serverEditorList {
  margin-top: 10px;
}

.dca-serverCard {
  position: relative;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-card-fill) 88%, transparent);
  min-width: 0;
}

.dca-serverCard + .dca-serverCard {
  margin-top: 10px;
}

.dca-serverCardHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
}

.dca-serverCardTitle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.dca-serverIndex {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 14px;
  letter-spacing: 0.1em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-serverLamp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 14px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary);
}

.dca-lampDot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.dca-serverLamp--online {
  color: var(--dsw-alias-state-success-primary);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
}

.dca-serverLamp--unreachable {
  color: var(--dsw-alias-state-error-primary);
}

.dca-serverLamp--checking {
  color: var(--dsw-alias-state-warn-primary);
}

.dca-serverGrid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 110px;
  gap: 12px;
  align-items: start;
  padding: 12px 12px 13px;
}

.dca-rowConfirm {
  grid-column: auto;
  margin: 0 12px 12px;
}

.dca-editorEmpty {
  margin-top: 10px;
  border-radius: 8px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.03em;
}

.dca-formGrid {
  margin-top: 12px;
}

.dca-sectionTitle {
  font-size: 13px;
  font-weight: 600;
}

.dca-sectionHint {
  font-size: 11px;
}

.dca-statusList {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dca-statusItem {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10.5px;
}

.dca-numberInput,
.dca-input {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
}

.dca-fieldLabel {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 15px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* ============================== responsive ============================= */
@media (max-width: 767px) {
  .dca-content {
    padding-inline: 20px;
  }
  .dca-hero {
    flex-wrap: wrap;
  }
  .dca-heroText {
    flex: 1 1 calc(100% - 56px);
  }
  .dca-heroActions {
    width: 100%;
    justify-content: flex-start;
    padding-top: 0;
    padding-left: 56px;
  }
  .dca-sessionRow {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .dca-copyArea {
    grid-column: 2;
    align-items: flex-start;
    padding-top: 8px;
  }
  .dca-commandWrap {
    padding-left: 30px;
  }
  .dca-serverRow {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .dca-rowActions {
    grid-column: 2;
    justify-content: flex-end;
    padding-top: 0;
  }
  .dca-formGrid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .dca-content {
    padding-inline: 16px;
  }
  .dca-settingsPage {
    padding-inline: 0;
  }
  .dca-title,
  .dca-settingsTitle {
    font-size: 18px;
    line-height: 26px;
  }
  .dca-heroMark {
    width: 36px;
    height: 36px;
  }
  .dca-heroText {
    flex-basis: calc(100% - 48px);
  }
  .dca-heroActions {
    padding-left: 48px;
  }
  .dca-cardHead {
    padding: 14px 14px 12px;
  }
  .dca-session {
    padding: 0 14px;
  }
  .dca-cardNotice {
    padding-inline: 14px;
  }
  .dca-serverRow {
    grid-template-columns: minmax(0, 1fr);
  }
  .dca-rowActions {
    grid-column: 1;
    justify-content: flex-start;
  }
  .dca-saveBar {
    align-items: flex-start;
  }
}


.dca-status {
  height: 21px;
  padding: 0 7px;
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 15px;
  letter-spacing: 0.04em;
}

.dca-button {
  height: 30px;
  border-radius: 6px;
  font-size: 12px;
}

.dca-buttonSmall {
  height: 26px;
  border-radius: 5px;
  font-size: 10.5px;
}

.dca-banner {
  border-radius: 6px;
}

.dca-input {
  border-radius: 5px;
}

.dca-numberInput {
  border-radius: 5px;
}

.dca-settingsIntro {
  font-size: 12px;
  line-height: 18px;
}

.dca-cardHead {
  flex-wrap: wrap;
}


.dca-teleLabel {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}

.dca-stateTag {
  padding: 0 6px;
  font-size: 10px;
  line-height: 17px;
  letter-spacing: 0.03em;
}

.dca-status {
  height: 22px;
  padding: 0 8px;
  font-size: 10px;
  line-height: 16px;
}

.dca-sourceTag {
  padding: 0 4px;
  border-style: solid;
  font-size: 9px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary);
}

.dca-sessionMeta {
  color: var(--dsw-alias-label-secondary);
}

.dca-filterBtn {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}

.dca-filterCount {
  font-size: 9.5px;
}

.dca-serverIndex,
.dca-serverLamp {
  font-size: 10px;
}

.dca-monoTag {
  font-size: 9px;
  color: var(--dsw-alias-label-secondary);
}

.dca-autoStatus {
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
}

.dca-autoRetry {
  min-height: 24px;
  padding: 0 7px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l2));
  border-radius: 5px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  text-decoration: none;
}

.dca-editorEmpty {
  color: var(--dsw-alias-label-secondary);
}

.dca-sessionSeq {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.65;
}

.dca-fieldLabel {
  font-size: 10px;
}

.dca-sectionHint,
.dca-fieldHint {
  color: var(--dsw-alias-label-secondary);
}

.dca-locationPane {
  color: var(--dsw-alias-label-secondary);
}

.dca-status--online,
.dca-status--unreachable,
.dca-status--checking {
  font-size: 10px;
}


.dca-expandBtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 15px;
  white-space: nowrap;
  cursor: pointer;
}

.dca-expandBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 2px;
}

@media (hover: hover) {
  .dca-expandBtn:hover {
    border-color: var(--dsw-alias-label-tertiary);
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dca-chevron {
  transition: transform 0.15s ease;
}

.dca-expandBtn.isOpen .dca-chevron {
  transform: rotate(180deg);
}

.dca-session--child {
  padding-left: 42px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent);
}

.dca-session--child::before {
  top: 10px;
  bottom: 10px;
  left: 26px;
  width: 1px;
  border-radius: 0;
  background: var(--dsw-alias-border-l2);
}

.dca-session--child .dca-sessionRow {
  grid-template-columns: 20px 16px minmax(0, 1fr);
  gap: 0 8px;
  padding: 10px 0;
}

.dca-session--child .dca-sessionSeq {
  padding-top: 2px;
  font-size: 9px;
}

.dca-session--child .dca-marker {
  width: 14px;
  height: 14px;
  margin-top: 3px;
}

.dca-session--child .dca-sessionTitle {
  font-size: 13px;
}

.dca-session--child .dca-stateTag {
  font-size: 9.5px;
  line-height: 16px;
}

.dca-session--child .dca-sessionMeta {
  gap: 2px 6px;
}


.dca-sessionTitleBtn {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dca-sessionTitleBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 2px;
}

.dca-sessionTitleBtn .dca-sessionTitle {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
}

.dca-childList {
  list-style: none;
  margin: 0;
  padding: 0;
}

.dca-expandBtn {
  height: 24px;
  padding: 0 7px;
  font-size: 10px;
}

/* tech responsive */
@media (max-width: 767px) {
  .dca-heroTop {
    flex-wrap: wrap;
  }
  .dca-heroActions {
    padding-left: 52px;
  }
  .dca-telemetry {
    overflow-x: auto;
    flex-wrap: nowrap;
  }
  .dca-teleItem {
    flex: none;
  }
  .dca-sessionRow {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .dca-session--child .dca-sessionRow {
    grid-template-columns: 16px minmax(0, 1fr);
  }
  .dca-session--child .dca-sessionSeq {
    display: none;
  }
  .dca-sessionSeq {
    display: none;
  }
  .dca-copyArea {
    grid-column: 2;
  }
  .dca-session {
    padding-inline: 14px;
  }
  .dca-session.dca-session--child {
    padding-left: 34px;
    padding-right: 14px;
  }
  .dca-session--child::before {
    left: 18px;
  }
  .dca-serverGrid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .dca-serverGrid .dca-field:last-child {
    grid-column: 1 / -1;
    max-width: 140px;
  }
  .dca-settingsStatus {
    align-items: flex-start;
    margin-left: 52px;
  }
}

@media (max-width: 560px) {
  .dca-title {
    font-size: 19px;
    line-height: 26px;
  }
  .dca-heroActions {
    padding-left: 0;
  }
  .dca-heroIdentity {
    gap: 10px;
  }
  .dca-filter {
    flex: 1;
  }
  .dca-serverGrid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dca-serverGrid .dca-field:last-child {
    grid-column: auto;
    max-width: none;
  }
  .dca-telemetry {
    border-radius: 6px;
  }
  .dca-teleItem {
    padding: 6px 10px;
  }
  .dca-settingsStatus {
    margin-left: 0;
    align-items: flex-start;
    width: 100%;
  }
  .dca-settingsHero {
    flex-wrap: wrap;
  }
}
`
    // ---------------------------------------------------------------------
    // Small shared UI atoms.
    // ---------------------------------------------------------------------

    /** Shared stylesheet owner; unmount removes the whole rule set. */
    function PluginStyles() {
      return h('style', { 'data-plugin': 'dsh-codex-agent' }, STYLE_SHEET)
    }

    /**
     * Join truthy class names.
     * @param {...unknown} values - candidate class names.
     * @returns {string} space-separated class list.
     */
    function cx() {
      const out = []
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index]
        if (typeof value === 'string' && value !== '') out.push(value)
      }
      return out.join(' ')
    }

    /** 14px warning triangle used by advisory lines. */
    function WarnGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 12
      return h('svg', {
        viewBox: '0 0 12 12',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        className: cx('dca-warningIcon', props && props.className),
      },
        h('path', {
          d: 'M6 1.5 11 10.5H1z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M6 4.4v2.7', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('circle', { cx: 6, cy: 8.9, r: 0.7, fill: 'currentColor' }),
      )
    }

    /** Refresh arrow. */
    function RefreshGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
        className: 'dca-icon',
      },
        h('path', {
          d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.2 2.4v3.4H9.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Check mark for the saved indicator. */
    function CheckGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
        className: 'dca-savedIcon',
      },
        h('path', {
          d: 'M3.4 8.4 6.6 11.6 12.6 4.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Clipboard glyph for the copy action. */
    function CopyGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        className: cx('dca-icon', props && props.className),
      },
        h('rect', {
          x: 5.2, y: 3.2, width: 7.6, height: 9.6, rx: 1.6,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M6.2 2.6h4.6v1.4H6.2zM3.2 5.2v7.2c0 .9.7 1.6 1.6 1.6h4.2',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }),
      )
    }

    /** Disclosure chevron for a parent task with child agents. */
    function ChevronGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        'aria-hidden': true,
        focusable: 'false',
        className: 'dca-icon dca-chevron',
      },
        h('path', {
          d: 'M3.8 5.8 8 10l4.2-4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Small terminal illustration for empty states. */
    function TerminalGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 28
      return h('svg', {
        viewBox: '0 0 32 32',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        className: cx('dca-icon', props && props.className),
      },
        h('rect', {
          x: 3.5, y: 5, width: 25, height: 22, rx: 4,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M9 12.2l4.4 3.6L9 19.4',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M15.6 19.8h6.2',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        }),
        h('circle', { cx: 24.2, cy: 10.6, r: 1.5, fill: 'currentColor', opacity: 0.55 }),
      )
    }

    /** Trash can for the delete action. */
    function TrashGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        'aria-hidden': true,
        focusable: 'false',
        className: 'dca-icon',
      },
        h('path', {
          d: 'M2.8 4.4h10.4M6.4 4.4V3.1h3.2v1.3M4.4 4.4l.6 8.3h6l.6-8.3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Server reachability glyph; color comes from the surrounding status class. */
    function ServerStatusIcon(props) {
      const status = props.status
      const common = {
        viewBox: '0 0 14 14',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
        className: 'dca-statusIcon',
      }
      if (status === 'online') {
        return h('svg', common, h('circle', { cx: 7, cy: 7, r: 4.2, fill: 'currentColor' }))
      }
      if (status === 'unreachable') {
        return h('svg', common,
          h('path', {
            d: 'M3.6 3.6 10.4 10.4M10.4 3.6 3.6 10.4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        )
      }
      return h('svg', common,
        h('circle', {
          cx: 7,
          cy: 7,
          r: 4.2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeDasharray: '2.4 1.8',
        }),
      )
    }

    function scanStatusLabel(t, warning) {
      if (warning?.code === 'ssh-retrying') return t('statusSshRetry')
      if (warning?.area === 'discovery') return t('statusScanIncomplete')
      return null
    }

    /** Render the current server status, announcing label changes but not each poll. */
    function ServerStatus(props) {
      const t = props.t
      const scanLabel = scanStatusLabel(t, props.scanWarning)
      const status = scanLabel === null ? props.status : 'checking'
      const label = scanLabel ?? t(status === 'online' ? 'online' : status === 'unreachable' ? 'unreachable' : 'checking')
      return h('span', { className: cx('dca-status', 'dca-status--' + status), role: 'status' },
        h(ServerStatusIcon, { status: status }),
        h('span', null, label),
      )
    }

    // ---------------------------------------------------------------------
    // Data normalization: the page never trusts a field to exist or to have
    // the documented type, so a Host change degrades instead of crashing.
    // ---------------------------------------------------------------------

    const SERVER_STATUSES = ['online', 'unreachable', 'checking']
    const SESSION_STATUSES = ['working', 'blocked', 'idle', 'done', 'error', 'unknown', 'unreachable']
    const BLOCKED_KINDS = ['permission', 'question', 'auth', 'other']
    const HINTS = ['no-osc', 'unlocated']

    /**
     * @param {unknown} value - candidate.
     * @returns {boolean} whether the value is a plain object.
     */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * @param {unknown} value - candidate.
     * @returns {string} the value when it is a string, else an empty string.
     */
    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    /**
     * @param {unknown} value - candidate.
     * @returns {number | null} the finite number, else null.
     */
    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * Clamp a candidate to an integer in a range.
     * @param {unknown} value - candidate.
     * @param {number} min - inclusive minimum.
     * @param {number} max - inclusive maximum.
     * @param {number} fallback - value used when the candidate is not an integer in range.
     * @returns {number} clamped integer.
     */
    function clampInt(value, min, max, fallback) {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number)) return fallback
      if (number < min || number > max) return fallback
      return number
    }

    /**
     * @param {unknown} value - candidate status.
     * @returns {'online'|'unreachable'|'checking'} normalized server status.
     */
    function normalizeServerStatus(value) {
      return typeof value === 'string' && SERVER_STATUSES.indexOf(value) !== -1 ? value : 'checking'
    }

    /**
     * @param {unknown} value - candidate status.
     * @returns {string} normalized session status.
     */
    function normalizeSessionStatus(value) {
      return typeof value === 'string' && SESSION_STATUSES.indexOf(value) !== -1 ? value : 'unknown'
    }

    /**
     * Keep a rendered remote message bounded.
     * @param {unknown} value - candidate text.
     * @returns {string} bounded text.
     */
    function boundedText(value) {
      const text = asString(value)
      if (text.length <= MAX_DETAIL_LENGTH) return text
      return text.slice(0, MAX_DETAIL_LENGTH - 1) + '…'
    }

    /**
     * Normalize one blocked detail from the wire.
     * @param {unknown} value - candidate blocked record.
     * @returns {{ kind: string, message: string } | null} normalized detail.
     */
    function normalizeBlocked(value) {
      if (!isRecord(value)) return null
      const kind = typeof value.kind === 'string' && BLOCKED_KINDS.indexOf(value.kind) !== -1 ? value.kind : 'other'
      return { kind: kind, message: boundedText(value.message) }
    }

    /**
     * Normalize one tmux location from the wire.
     * @param {unknown} value - candidate location record.
     * @returns {object | null} normalized location.
     */
    function normalizeLocation(value) {
      if (!isRecord(value)) return null
      const sessionName = asString(value.sessionName)
      const windowIndex = clampInt(value.windowIndex, 0, 1e6, 0)
      const paneIndex = clampInt(value.paneIndex, 0, 1e6, 0)
      const target = asString(value.target) || (sessionName === '' ? '' : sessionName + ':' + windowIndex + '.' + paneIndex)
      return {
        sessionName: sessionName,
        windowIndex: windowIndex,
        paneIndex: paneIndex,
        paneId: asString(value.paneId),
        paneTitle: asString(value.paneTitle),
        windowName: asString(value.windowName),
        matchedBy: asString(value.matchedBy),
        target: target,
      }
    }

    /**
     * Normalize one session view from the wire.
     * @param {unknown} value - candidate session.
     * @param {number} index - position, used for a stable fallback key.
     * @returns {object} normalized session.
     */
    function normalizeSession(value, index) {
      const input = isRecord(value) ? value : {}
      const id = asString(input.id)
      const key = asString(input.key) || (id === '' ? 'session-' + index : 'id-' + id + '-' + index)
      const hint = typeof input.hint === 'string' && HINTS.indexOf(input.hint) !== -1 ? input.hint : null
      const command = typeof input.command === 'string' && input.command !== '' ? input.command : null
      const commandKind = input.commandKind === 'pane' || input.commandKind === 'session' ? input.commandKind : null
      return {
        key: key,
        id: id,
        title: boundedText(input.title),
        cwd: asString(input.cwd),
        cwdName: asString(input.cwdName),
        updatedAt: asNumber(input.updatedAt),
        activityAt: asNumber(input.activityAt),
        source: input.source === 'sqlite3' ? 'sqlite3' : 'jsonl',
        threadSource: asString(input.threadSource),
        isSubagent: input.isSubagent === true,
        parentThreadId: asString(input.parentThreadId),
        agentNickname: asString(input.agentNickname),
        status: normalizeSessionStatus(input.status),
        stateSource: input.stateSource === 'osc' ? 'osc' : input.stateSource === 'log' ? 'log' : 'none',
        stateUpdatedAt: asNumber(input.stateUpdatedAt),
        blocked: normalizeBlocked(input.blocked),
        hint: hint,
        paneActivityAt: asNumber(input.paneActivityAt),
        location: normalizeLocation(input.location),
        command: command,
        commandKind: commandKind,
        canOpenITerm: input.canOpenITerm === true,
      }
    }

    /**
     * Normalize one warning record from the wire.
     * @param {unknown} value - candidate warning.
     * @returns {{ area: string, code: string, message: string } | null} normalized warning.
     */
    function normalizeWarning(value) {
      if (!isRecord(value)) return null
      const message = boundedText(value.message)
      if (message === '') return null
      return { area: asString(value.area), code: asString(value.code), message: message }
    }

    /**
     * Normalize one server view from the wire.
     * @param {unknown} value - candidate server.
     * @returns {object} normalized server.
     */
    function normalizeServer(value) {
      const input = isRecord(value) ? value : {}
      const sessions = Array.isArray(input.sessions) ? input.sessions.map(normalizeSession) : []
      const warnings = Array.isArray(input.warnings) ? input.warnings.map(normalizeWarning).filter(Boolean) : []
      return {
        id: asString(input.id),
        name: asString(input.name),
        ssh: asString(input.ssh),
        port: asNumber(input.port),
        status: normalizeServerStatus(input.status),
        error: boundedText(input.error),
        tmuxError: boundedText(input.tmuxError),
        warnings: warnings,
        lastPollAt: asNumber(input.lastPollAt),
        lastOkAt: asNumber(input.lastOkAt),
        sessions: sessions,
      }
    }

    /**
     * Normalize the stored settings document.
     * @param {unknown} value - candidate settings.
     * @returns {{ servers: Array<object>, days: number, pollMs: number }} normalized settings.
     */
    function normalizeSettings(value) {
      const input = isRecord(value) ? value : {}
      const servers = []
      if (Array.isArray(input.servers)) {
        input.servers.forEach((entry, index) => {
          if (!isRecord(entry)) return
          const id = asString(entry.id)
          const port = clampInt(entry.port, 1, 65535, null)
          servers.push({
            id: id,
            name: asString(entry.name),
            ssh: asString(entry.ssh),
            port: port === null ? null : port,
          })
        })
      }
      return {
        servers: servers,
        days: clampInt(input.days, 1, 30, DEFAULT_DAYS),
        pollMs: clampInt(input.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
      }
    }

    /**
     * Normalize the sessions snapshot payload.
     * @param {unknown} value - candidate payload.
     * @returns {object} normalized snapshot.
     */
    function normalizeSnapshot(value) {
      const input = isRecord(value) ? value : {}
      const settings = normalizeSettings(input.settings)
      const servers = Array.isArray(input.servers) ? input.servers.map(normalizeServer) : []
      const capturesRaw = isRecord(input.captures) ? input.captures : {}
      return {
        generatedAt: asNumber(input.generatedAt),
        days: clampInt(input.days, 1, 30, settings.days),
        pollMs: clampInt(input.pollMs, MIN_POLL_MS, MAX_POLL_MS, settings.pollMs),
        captures: {
          active: clampInt(capturesRaw.active, 0, 1e9, 0),
          total: clampInt(capturesRaw.total, 0, 1e9, 0),
        },
        settings: settings,
        servers: servers,
      }
    }

    /**
     * Normalize one server summary from `/servers`.
     * @param {unknown} value - candidate summary.
     * @returns {{ id: string, name: string, status: string, error: string, sessionCount: number, scanWarning: object | null }} summary.
     */
    function normalizeServerSummary(value) {
      const input = isRecord(value) ? value : {}
      const scanWarning = Array.isArray(input.warnings)
        ? normalizeWarning(input.warnings.find(warning => isRecord(warning) && warning.area === 'discovery'))
        : null
      return {
        scanWarning: scanWarning,
        id: asString(input.id),
        name: asString(input.name),
        status: normalizeServerStatus(input.status),
        error: boundedText(input.error),
        sessionCount: clampInt(input.sessionCount, 0, 1e9, 0),
      }
    }

    // ---------------------------------------------------------------------
    // HTTP helpers.
    // ---------------------------------------------------------------------

    /**
     * @param {unknown} error - thrown value.
     * @returns {string} a short human-readable detail.
     */
    function errorDetail(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (error instanceof Error) return error.message
      if (isRecord(error) && typeof error.message === 'string') return error.message
      return ''
    }

    /**
     * @param {unknown} error - thrown value.
     * @returns {boolean} whether the error is an aborted fetch.
     */
    function isAbortError(error) {
      return error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 20)
    }

    /** Host validation codes mapped to localized copy. */
    const HOST_ERROR_KEYS = {
      'name-required': 'hostNameRequired',
      'ssh-required': 'hostSshRequired',
      'ssh-invalid': 'hostSshInvalid',
      'port-range': 'hostPortRange',
      'days-range': 'hostDaysRange',
      'poll-range': 'hostPollRange',
      'servers-limit': 'hostServersLimit',
      'settings-invalid': 'hostSettingsInvalid',
      'save-failed': 'hostSaveFailed',
      'request-invalid': 'hostRequestInvalid',
    }

    /**
     * Extract the first useful message from a JSON error body. Known Host codes
     * become localized copy; unknown messages pass through as technical detail.
     * @param {unknown} body - parsed response body.
     * @param {Function} [t] - locale reader.
     * @returns {string} first message, or an empty string.
     */
    function firstErrorMessage(body, t) {
      if (!isRecord(body)) return ''
      if (Array.isArray(body.errors)) {
        for (const entry of body.errors) {
          if (!isRecord(entry)) continue
          if (typeof entry.code === 'string' && typeof t === 'function') {
            const key = HOST_ERROR_KEYS[entry.code]
            if (key !== undefined) return t(key)
          }
          if (typeof entry.message === 'string' && entry.message !== '') return entry.message
        }
      }
      if (typeof body.error === 'string' && body.error !== '') return body.error
      if (typeof body.message === 'string' && body.message !== '') return body.message
      return ''
    }

    /**
     * Read one JSON payload with same-origin credentials.
     * @param {string} path - API path below the Host gateway.
     * @param {object} [options] - fetch overrides (signal, method, body, headers).
     * @returns {Promise<{ response: Response, body: unknown }>} response and parsed body.
     */
    async function requestJson(path, options) {
      const settings = options === undefined ? {} : options
      const headers = { accept: 'application/json', ...settings.headers }
      if (typeof settings.body === 'string') headers['content-type'] = 'application/json'
      const response = await fetch(path, {
        method: settings.method || 'GET',
        credentials: 'same-origin',
        headers: headers,
        signal: settings.signal,
        body: settings.body,
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { response: response, body: body }
    }

    /**
     * GET one `{ ok: true, ... }` payload, throwing a descriptive error otherwise.
     * @param {string} path - API path below the Host gateway.
     * @param {AbortSignal} signal - request cancellation.
     * @returns {Promise<object>} response payload.
     */
    async function requestOk(path, signal, t) {
      const { response, body } = await requestJson(path, { signal: signal })
      if (!response.ok || !isRecord(body) || body.ok !== true) {
        const detail = firstErrorMessage(body, t) || 'HTTP ' + response.status
        throw new Error(detail)
      }
      return body
    }

    // ---------------------------------------------------------------------
    // Formatting helpers.
    // ---------------------------------------------------------------------

    /**
     * @param {number | null} value - epoch milliseconds.
     * @returns {string} local clock time, or an empty string.
     */
    function formatClock(value) {
      if (value === null) return ''
      try {
        return new Date(value).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      } catch {
        return ''
      }
    }

    /**
     * @param {number | null} value - epoch milliseconds.
     * @returns {string | undefined} ISO timestamp for a `<time>` element.
     */
    function toIsoString(value) {
      if (value === null) return undefined
      try {
        return new Date(value).toISOString()
      } catch {
        return undefined
      }
    }

    /**
     * Localized relative activity time.
     * @param {Function} t - locale reader.
     * @param {number | null} activityAt - epoch milliseconds.
     * @param {number} now - current epoch milliseconds.
     * @returns {string} localized relative time, or an empty string when unknown.
     */
    function formatRelative(t, activityAt, now) {
      if (activityAt === null) return ''
      const diff = Math.max(0, now - activityAt)
      if (diff < 45000) return t('justNow')
      const minutes = Math.floor(diff / 60000)
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      const hours = Math.floor(diff / 3600000)
      if (hours < 24) return t('hoursAgo', { n: hours })
      const days = Math.floor(diff / 86400000)
      return t('daysAgo', { n: days })
    }

    /**
     * @param {number} pollMs - interval in milliseconds.
     * @returns {number} whole seconds for copy.
     */
    function pollSeconds(pollMs) {
      return Math.max(1, Math.round(pollMs / 1000))
    }

    // ---------------------------------------------------------------------
    // Hooks.
    // ---------------------------------------------------------------------

    /**
     * Re-render on a coarse clock so relative times stay current.
     * @returns {number} current epoch milliseconds, refreshed every 30 s.
     */
    function useNowTick() {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
        return () => { clearInterval(timer) }
      }, [])
      return now
    }

    /**
     * Compare stable status values of main agents, not discovery order,
     * timestamps or SSH errors. Subagent rows are excluded: they churn while a
     * main task runs and would otherwise mark the panel as updated constantly.
     */
    function compareSessionStatuses(previous, snapshot) {
      const next = new Map()
      let changed = false
      for (const server of snapshot.servers) {
        const old = previous.get(server.id)
        if (server.status !== 'online') {
          if (old !== undefined) next.set(server.id, old)
          continue
        }
        const current = new Map()
        for (const session of server.sessions) {
          if (session.id === '') continue
          if (session.isSubagent === true) continue
          const before = old?.get(session.id)
          if (session.status === 'unknown' || session.status === 'unreachable') {
            if (before !== undefined) current.set(session.id, before)
            continue
          }
          if (before !== undefined && before !== session.status) changed = true
          current.set(session.id, session.status)
        }
        next.set(server.id, current)
      }
      return { next, changed }
    }

    /** One read-only polling loop per Client plugin, shared with the main panel. */
    function createCodexFeed() {
      let state = { status: 'loading', data: null, error: null, refreshing: false }
      let statuses = new Map()
      let unread = false
      let openViews = 0
      let stopped = true
      let timer = null
      let controller = null
      let pollMs = DEFAULT_POLL_MS
      const listeners = new Set()
      const unreadListeners = new Set()

      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }
      const setUnread = (value) => {
        if (unread === value) return
        unread = value
        for (const listener of unreadListeners) listener()
      }
      const stopWork = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        const active = controller
        controller = null
        active?.abort()
      }
      const load = async (refreshing = false) => {
        if (stopped) return
        stopWork()
        const request = new AbortController()
        controller = request
        let errorKind = refreshing ? 'refresh' : 'poll'
        try {
          if (refreshing) {
            const { response } = await requestJson(API_ROOT + '/refresh', { method: 'POST', signal: request.signal })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            if (controller !== request || stopped) return
          }
          // The Host applies the latest saved display window when days is omitted.
          const raw = await requestOk(API_ROOT + '/sessions', request.signal)
          if (controller !== request || stopped) return
          if (!Array.isArray(raw.servers)) throw new Error('Invalid sessions snapshot')
          const snapshot = normalizeSnapshot(raw)
          pollMs = snapshot.pollMs
          const sameWindow = state.data?.days === snapshot.days
          const comparison = compareSessionStatuses(sameWindow ? statuses : new Map(), snapshot)
          statuses = comparison.next
          publish({ status: 'ready', data: snapshot, error: null, refreshing: false })
          if (comparison.changed && openViews === 0) setUnread(true)
        } catch (error) {
          if (controller !== request || stopped || isAbortError(error)) return
          if (!refreshing && state.data === null) errorKind = 'load'
          publish({ ...state, status: state.data === null ? 'error' : state.status,
            error: { kind: errorKind, detail: errorDetail(error) }, refreshing: false })
        } finally {
          if (!stopped && controller === request) {
            controller = null
            timer = setTimeout(() => { timer = null; void load() }, pollMs)
          }
        }
      }
      const reload = (refreshing) => {
        if (stopped) return
        publish({ ...state, status: state.data === null ? 'loading' : state.status, error: null, refreshing })
        void load(refreshing)
      }

      return {
        start() {
          stopped = false
          void load()
          return () => { stopped = true; stopWork() }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => state,
        hasUnread: () => unread,
        subscribeUnread(listener) {
          unreadListeners.add(listener)
          return () => unreadListeners.delete(listener)
        },
        openView() {
          openViews += 1
          setUnread(false)
          return () => { openViews -= 1 }
        },
        refresh: () => reload(true),
        retry: () => reload(false),
      }
    }

    // ---------------------------------------------------------------------
    // Main panel.
    // ---------------------------------------------------------------------

    const SESSION_MARKER_LABELS = {
      working: 'statusWorking',
      blocked: 'statusBlocked',
      idle: 'statusIdle',
      done: 'statusDone',
      error: 'statusError',
      unknown: 'statusUnknown',
      unreachable: 'unreachable',
    }

    const BLOCKED_LABELS = {
      permission: 'blockedPermission',
      question: 'blockedQuestion',
      auth: 'blockedAuth',
      other: 'blockedOther',
    }

    /**
     * Inline status marker for one session row. Shape and color carry the
     * status together, and the accessible name is the localized status.
     * @param {{ status: string, t: Function }} props - status and locale reader.
     * @returns {object} inline SVG marker.
     */
    function SessionMarker(props) {
      const status = props.status
      const t = props.t
      const maskId = 'dca-mask-' + useId().replace(/[^A-Za-z0-9_-]/g, '')
      const labelKey = SESSION_MARKER_LABELS[status] || 'statusUnknown'
      const label = t(labelKey)
      const common = {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        role: 'img',
        'aria-label': label,
        focusable: 'false',
        className: cx('dca-marker', 'dca-marker--' + (SESSION_MARKER_LABELS[status] ? status : 'unknown')),
      }
      const title = h('title', null, label)
      const cutout = (shapes) => h('defs', null, h('mask', {
        id: maskId,
        maskUnits: 'userSpaceOnUse',
        x: 0,
        y: 0,
        width: 16,
        height: 16,
      },
        h('rect', { width: 16, height: 16, fill: 'white' }),
        shapes,
      ))
      if (status === 'working') {
        return h('svg', common, title, h('circle', { cx: 8, cy: 8, r: 5, fill: 'currentColor' }))
      }
      if (status === 'blocked') {
        // A dot alone would separate blocked from working/error by color only.
        // Transparent mask cutouts keep the dot silhouette on any row surface.
        return h('svg', common, title,
          cutout([
            h('rect', { key: 'l', x: 6.1, y: 5.1, width: 1.25, height: 5.8, rx: 0.6, fill: 'black' }),
            h('rect', { key: 'r', x: 8.65, y: 5.1, width: 1.25, height: 5.8, rx: 0.6, fill: 'black' }),
          ]),
          h('circle', { cx: 8, cy: 8, r: 5, fill: 'currentColor', mask: 'url(#' + maskId + ')' }),
        )
      }
      if (status === 'error') {
        return h('svg', common, title,
          cutout([
            h('rect', { key: 'stem', x: 7.25, y: 4.4, width: 1.5, height: 5, rx: 0.7, fill: 'black' }),
            h('circle', { key: 'dot', cx: 8, cy: 11.35, r: 0.85, fill: 'black' }),
          ]),
          h('circle', { cx: 8, cy: 8, r: 5, fill: 'currentColor', mask: 'url(#' + maskId + ')' }),
        )
      }
      if (status === 'idle') {
        return h('svg', common, title, h('circle', {
          cx: 8,
          cy: 8,
          r: 5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }))
      }
      if (status === 'done') {
        return h('svg', common, title, h('path', {
          d: 'M3.5 8.4 6.7 11.6 12.5 4.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
      }
      if (status === 'unreachable') {
        return h('svg', common, title, h('path', {
          d: 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }))
      }
      return h('svg', common, title,
        h('path', {
          d: 'M5.9 6.1a2.15 2.15 0 1 1 3.25 2.4c-.7.4-1.1.9-1.1 1.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 8, cy: 12.5, r: 0.9, fill: 'currentColor' }),
      )
    }

    /**
     * Render the tmux location fragment for one session.
     * @param {object} session - normalized session.
     * @param {Function} t - locale reader.
     * @returns {object} inline location element.
     */
    function renderLocation(session, t) {
      if (session.location === null) {
        return h('span', { className: 'dca-location' }, t('unlocated'))
      }
      const target = session.location.target
      const paneTitle = session.location.paneTitle
      return h('span', { className: 'dca-location', title: paneTitle || target },
        h('span', { className: 'dca-locationChip' },
          h('span', { className: 'dca-locationDot', 'aria-hidden': true }),
          h('span', { className: 'dca-mono' }, target),
        ),
        paneTitle !== '' ? h('span', { className: 'dca-locationPane' }, paneTitle) : null,
      )
    }

    const ITERM_ERROR_LABELS = new Map([
      ['automation-denied', 'openITermDenied'],
      ['iterm-unavailable', 'openITermUnavailable'],
      ['session-unavailable', 'openSessionUnavailable'],
      ['launch-in-progress', 'openITermBusy'],
    ])

    async function openSessionInITerm(key) {
      const { response, body } = await requestJson(API_ROOT + '/open-iterm', {
        method: 'POST',
        headers: { 'x-dsh-codex-view': '1' },
        body: JSON.stringify({ key }),
      })
      if (response.ok && isRecord(body) && body.ok === true) {
        return { error: null, notice: body.mode === 'tab' ? 'openITermTabOpened' : 'openITermWindowOpened' }
      }
      return { error: ITERM_ERROR_LABELS.get(body?.error?.code) ?? 'openITermFailed', notice: null }
    }

    /**
     * Render one session row.
     * @param {object} props - normalized session plus row callbacks.
     * @returns {object} row element.
     */
    function SessionRow(props) {
      const t = props.t
      const session = props.session
      const isChild = props.isChild === true
      const override = session.stateSource === 'osc' ? undefined : props.statusOverride
      const depth = typeof props.depth === 'number' ? props.depth : 1
      const index = typeof props.index === 'number' ? props.index : 0
      const status = props.unreachable ? 'unreachable' : (override?.status ?? session.status)
      const stateSource = override?.stateSource ?? session.stateSource
      const stateLabel = t(SESSION_MARKER_LABELS[status] || 'statusUnknown')
      const fromLog = stateSource === 'log'
      const activityAt = session.activityAt !== null ? session.activityAt : session.updatedAt
      const relative = formatRelative(t, activityAt, props.now)
      const title = session.title || session.cwdName || session.id || t('noDescription')
      const cwd = session.cwd || session.cwdName
      const blocked = session.blocked
      const command = session.command
      const copyDisabled = command === null
      const canView = session.canOpenITerm && !props.unreachable && !copyDisabled && session.location !== null
      const openingRef = useRef(false)
      const [opening, setOpening] = useState(false)
      const [openError, setOpenError] = useState(null)
      const [openedNotice, setOpenedNotice] = useState(null)
      useEffect(() => {
        if (openedNotice === null) return undefined
        const timer = setTimeout(() => setOpenedNotice(null), OPENED_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [openedNotice])
      const showInITerm = async () => {
        if (!canView || openingRef.current) return
        openingRef.current = true
        setOpening(true)
        setOpenError(null)
        setOpenedNotice(null)
        try {
          const result = await openSessionInITerm(session.key)
          setOpenError(result.error)
          if (result.error === null) setOpenedNotice(result.notice)
        } catch {
          setOpenError('openITermFailed')
        } finally {
          openingRef.current = false
          setOpening(false)
        }
      }
      const childCount = typeof props.childCount === 'number' ? props.childCount : 0
      const expanded = props.expanded === true

      const meta = []
      if (relative !== '') {
        meta.push(h('time', {
          key: 'activity',
          className: 'dca-time',
          dateTime: toIsoString(activityAt),
          title: t('lastActivity'),
        }, relative))
      }
      if (cwd !== '') {
        if (meta.length > 0) meta.push(h('span', { key: 'sep-cwd', className: 'dca-sep', 'aria-hidden': true }))
        meta.push(h('span', { key: 'cwd', className: 'dca-metaText dca-mono', title: cwd }, cwd))
      }
      if (!isChild) {
        if (meta.length > 0) meta.push(h('span', { key: 'sep-location', className: 'dca-sep', 'aria-hidden': true }))
        meta.push(h('span', { key: 'location' }, renderLocation(session, t)))
      }

      const details = []
      if (blocked !== null) {
        details.push(h('div', { key: 'blocked', className: 'dca-blocked' },
          h('span', { className: 'dca-blockedLabel' },
            h(WarnGlyph, { size: 12 }),
            h('span', null, t(BLOCKED_LABELS[blocked.kind] || 'blockedOther')),
          ),
          blocked.message !== ''
            ? h('span', { className: 'dca-blockedMsg' }, blocked.message)
            : null,
        ))
      }
      if (!isChild && session.hint === 'no-osc' && override === undefined) {
        const paneRecent = session.paneActivityAt !== null
          && props.now - session.paneActivityAt >= 0
          && props.now - session.paneActivityAt < PANE_ACTIVE_MS
        const hintText = paneRecent
          ? t('paneActive', { time: formatRelative(t, session.paneActivityAt, props.now) })
          : t('unknownHint')
        details.push(h('p', { key: 'unknown-hint', className: 'dca-hint' },
          h('span', { className: 'dca-hintGlyph', 'aria-hidden': true }, '?'),
          h('span', null, hintText),
        ))
      }

      let copyArea = null
      let fallback = null
      if (!isChild) {
        const copyLabel = props.copied ? t('copied') : copyDisabled ? t('copyUnavailableShort') : t('copyCommand')
        const buttonTitle = copyDisabled ? t('unlocated') : copyLabel
        const copyButton = h('button', {
          type: 'button',
          className: cx('dca-button dca-buttonSmall dca-copyButton', canView && 'dca-copyButtonIcon'),
          disabled: copyDisabled,
          title: buttonTitle,
          'aria-label': buttonTitle,
          onClick: copyDisabled ? undefined : () => {
            setOpenError(null)
            setOpenedNotice(null)
            props.onCopy(session)
          },
        }, props.copied && canView ? h(CheckGlyph) : h(CopyGlyph), canView ? null : h('span', null, copyLabel))

        const viewButton = canView ? h('button', {
          type: 'button',
          className: 'dca-button dca-buttonSmall dca-copyButton',
          'aria-disabled': opening || undefined,
          title: t('viewInITerm'),
          'aria-label': t('viewInITerm'),
          onClick: showInITerm,
        }, h(TerminalGlyph, { size: 14 }), h('span', null, t('viewSession'))) : null
        const actionFeedback = openError !== null ? t(openError)
          : props.copyFallback ? t('copyFailed')
            : opening ? t('openingITerm')
              : openedNotice !== null ? t(openedNotice)
                : props.copied ? t('copied') : ''
        copyArea = h('div', { className: 'dca-copyArea' },
          h('div', { className: 'dca-sessionActions' }, viewButton, copyButton),
          h('span', {
            className: openError !== null || props.copyFallback || openedNotice !== null
              ? 'dca-copyMessage'
              : 'dca-visuallyHidden',
            role: 'status',
          }, actionFeedback),
        )

        fallback = props.copyFallback && command !== null
          ? h('div', { key: 'command', className: 'dca-commandWrap' },
            h('code', { className: 'dca-command' }, command),
          )
          : null
      }

      const subagentBadge = session.isSubagent
        ? h('span', { className: 'dca-subBadge', title: session.agentNickname !== '' ? session.agentNickname : t('subagent') },
          h('span', null, t('subagent')),
          session.agentNickname !== '' ? h('span', null, '· ' + session.agentNickname) : null,
        )
        : null

      const titleNode = childCount > 0
        ? h('button', {
          type: 'button',
          className: 'dca-sessionTitleBtn',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-controls': props.childrenId,
          onClick: (event) => {
            if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
            props.onToggleParent(session.id)
          },
        }, h('span', { className: 'dca-sessionTitle' }, title))
        : h('span', { className: 'dca-sessionTitle' }, title)

      const expandButton = childCount > 0
        ? h('button', {
          type: 'button',
          className: cx('dca-expandBtn', expanded && 'isOpen'),
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-label': (expanded ? t('collapseSubagents') : t('expandSubagents')) + ' — ' + t('subagentCount', { n: childCount }),
          'aria-controls': props.childrenId,
          title: expanded ? t('collapseSubagents') : t('expandSubagents'),
          onClick: (event) => {
            if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
            props.onToggleParent(session.id)
          },
        },
          h(ChevronGlyph),
          h('span', null, t('subagentCount', { n: childCount })),
        )
        : null

      return h('li', {
        className: cx(
          'dca-session',
          'dca-session--' + status,
          isChild && 'dca-session--child',
        ),
        style: isChild && depth > 1 ? { paddingLeft: String(42 + Math.min(depth - 1, 3) * 16) + 'px' } : undefined,
      },
        h('div', { className: 'dca-sessionRow' },
          h('span', { className: 'dca-sessionSeq', 'aria-hidden': true }, String(index + 1).padStart(2, '0')),
          h(SessionMarker, { status: status, t: t }),
          h('div', { className: 'dca-sessionBody' },
            h('div', { className: 'dca-sessionTitleRow' },
              h('span', { className: 'dca-stateTag dca-stateTag--' + status }, stateLabel),
              titleNode,
              fromLog
                ? h('span', { className: 'dca-sourceTag', title: t('statusSourceLog') }, t('sourceLog'))
                : null,
              subagentBadge,
              expandButton,
            ),
            h('div', { className: 'dca-sessionMeta' }, meta),
            details,
          ),
          copyArea,
        ),
        fallback,
        childCount > 0
          ? h('ul', {
            id: props.childrenId,
            className: 'dca-childList',
            hidden: !expanded,
          }, expanded ? props.childrenContent : null)
          : null,
      )
    }

    /**
     * Localized session count, with an English singular form.
     * @param {Function} t - locale reader.
     * @param {number} n - count.
     * @returns {string} localized count.
     */
    function sessionCountText(t, n) {
      return t(n === 1 ? 'sessionCountOne' : 'sessionCount', { n: n })
    }

    /**
     * Resolve a Host warning to localized copy when the Host sent a known code.
     * @param {Function} t - locale reader.
     * @param {{ code: string, message: string }} warning - normalized warning.
     * @returns {string} display text.
     */
    function warningText(t, warning) {
      if (warning.code === 'sqlite-fallback') return t('warningSqlite')
      if (warning.code === 'codex-unavailable') return t('warningCodex')
      if (warning.code === 'ssh-retrying') return t('warningSshRetry')
      if (warning.code === 'discovery-timeout') return t('warningDiscoveryTimeout', { seconds: warning.message })
      if (warning.code === 'discovery-incomplete') return t('warningDiscoveryIncomplete')
      return warning.message
    }

    /**
     * Render one server card with its heading, notices, and session rows.
     * @param {object} props - normalized server plus view state.
     * @returns {object} section element.
     */
    function ServerSection(props) {
      const t = props.t
      const server = props.server
      const unreachable = server.status === 'unreachable'
      const displayName = server.name || server.id || t('noDescription')
      const headingId = props.headingId
      const expandedParents = props.expandedParents
      const statusOverride = props.subagentStates

      const sessionIds = new Set(server.sessions.map(session => session.id))
      const childrenByParent = new Map()
      for (const session of server.sessions) {
        if (!session.isSubagent) continue
        if (session.parentThreadId === '' || !sessionIds.has(session.parentThreadId)) continue
        let list = childrenByParent.get(session.parentThreadId)
        if (list === undefined) {
          list = []
          childrenByParent.set(session.parentThreadId, list)
        }
        list.push(session)
      }
      const topLevel = server.sessions.filter((session) => {
        if (!session.isSubagent) return true
        return session.parentThreadId === '' || !sessionIds.has(session.parentThreadId)
      })
      const descendantsByRoot = new Map()
      const collectDescendants = (parentId, depth, out) => {
        for (const child of childrenByParent.get(parentId) || []) {
          out.push({ session: child, depth: depth })
          collectDescendants(child.id, depth + 1, out)
        }
      }
      for (const root of topLevel) {
        const out = []
        collectDescendants(root.id, 1, out)
        descendantsByRoot.set(root.id, out)
      }
      const hiddenChildren = server.sessions.length - topLevel.length
      const activeCount = server.sessions.filter((session) => {
        const override = statusOverride.get(session.id)
        const status = override?.status ?? session.status
        return status === 'working' || status === 'blocked'
      }).length
      const serverIndex = typeof props.index === 'number' ? props.index : 0
      const serverCode = t('serverCode') + '/' + String(serverIndex + 1).padStart(2, '0')
      const firstWarning = server.warnings.length > 0 ? server.warnings[0] : null
      const scanWarning = firstWarning?.area === 'discovery' ? firstWarning : null
      const sshTarget = server.port === null ? server.ssh : server.ssh + ':' + server.port

      const rows = []
      let rowIndex = 0
      for (const session of topLevel) {
        const children = descendantsByRoot.get(session.id) || []
        const expanded = children.length > 0 && expandedParents.has(session.id)
        const parentIndex = rowIndex
        rowIndex += 1
        const childrenId = headingId + '-children-' + parentIndex
        const childRows = []
        if (expanded) {
          for (const child of children) {
            childRows.push(h(SessionRow, {
              key: child.session.key || 'session-' + rowIndex,
              index: rowIndex,
              session: child.session,
              unreachable: unreachable,
              now: props.now,
              t: t,
              isChild: true,
              depth: child.depth,
              statusOverride: statusOverride.get(child.session.id),
            }))
            rowIndex += 1
          }
        }
        rows.push(h(SessionRow, {
          key: session.key || 'session-' + parentIndex,
          index: parentIndex,
          session: session,
          unreachable: unreachable,
          now: props.now,
          t: t,
          childCount: children.length,
          expanded: expanded,
          childrenId: childrenId,
          childrenContent: childRows,
          onToggleParent: props.onToggleParent,
          copied: props.copiedKey === session.key,
          copyFallback: props.fallbackKeys.has(session.key),
          onCopy: props.onCopy,
        }))
      }

      const sessions = topLevel.length === 0
        ? h('div', { className: 'dca-empty' },
          h(TerminalGlyph, { size: 22 }),
          h('p', { className: 'dca-emptyTitle' },
            unreachable ? t('noCachedSessions')
              : server.lastOkAt === null ? t('noScan')
                : t('noSessions', { n: props.days })),
        )
        : h('ul', { className: 'dca-sessionList', role: 'list' }, rows)

      return h('section', { className: 'dca-card', 'aria-labelledby': headingId },
        h('header', { className: 'dca-cardHead' },
          h('div', { className: 'dca-cardHeadMain' },
            h('div', { className: 'dca-serverTitleRow' },
              h('span', { className: 'dca-serverCode' }, serverCode),
              h('h2', { className: 'dca-serverName', id: headingId }, displayName),
            ),
            h('div', { className: 'dca-serverMeta' },
              sshTarget !== ''
                ? h('span', { className: 'dca-metaText dca-mono', title: sshTarget }, sshTarget)
                : null,
              sshTarget !== '' ? h('span', { className: 'dca-metaDot', 'aria-hidden': true }) : null,
              h('span', null, sessionCountText(t, topLevel.length)),
              activeCount > 0
                ? h('span', { className: 'dca-serverActive' }, t('activeCount', { n: activeCount }))
                : null,
              hiddenChildren > 0
                ? h('span', null, t('subagentCount', { n: hiddenChildren }))
                : null,
            ),
          ),
          h('div', { className: 'dca-serverHeadRight' },
            h(ServerStatus, { status: server.status, scanWarning: scanWarning, t: t }),
            h('span', { className: 'dca-serverHash dca-mono' }, '#' + (server.id || '').slice(0, 8)),
          ),
        ),
        unreachable && server.error !== ''
          ? h('p', { className: 'dca-cardNotice dca-cardNotice--error' },
            h('span', { className: 'dca-noticeLabel' }, t('sshFailed')),
            h('span', { className: 'dca-noticeText' }, server.error),
          )
          : null,
        server.tmuxError !== ''
          ? h('p', { className: 'dca-cardNotice dca-cardNotice--warn' },
            h(WarnGlyph, { size: 12 }),
            h('span', { className: 'dca-noticeLabel' }, t('tmuxFailed')),
            h('span', { className: 'dca-noticeText' }, server.tmuxError),
          )
          : null,
        firstWarning !== null
          ? h('p', { className: 'dca-cardNotice dca-cardNotice--warn' },
            h(WarnGlyph, { size: 12 }),
            h('span', { className: 'dca-noticeLabel' }, t('warning')),
            h('span', { className: 'dca-noticeText' }, warningText(t, firstWarning),
              scanWarning !== null && server.lastOkAt !== null ? ' ' + t('cachedScan', { time: formatClock(server.lastOkAt) }) : ''),
          )
          : null,
        sessions,
      )
    }

    /**
     * Render the network error banner with its retry action.
     * @param {{ error: object, t: Function, onRetry: Function }} props - banner inputs.
     * @returns {object} banner element.
     */
    function ErrorBanner(props) {
      const t = props.t
      const error = props.error
      const title = error.kind === 'load'
        ? t('loadFailed')
        : error.kind === 'refresh' ? t('refreshFailed') : t('pollFailed')
      return h('div', { className: 'dca-banner', role: 'alert' },
        h(WarnGlyph, { size: 14 }),
        h('span', { className: 'dca-bannerText' },
          h('span', null, title),
          error.detail !== ''
            ? h('span', { className: 'dca-bannerDetail' }, ' — ' + error.detail)
            : null,
        ),
        h('button', {
          type: 'button',
          className: 'dca-button dca-buttonSmall',
          onClick: props.onRetry,
        }, t('retry')),
      )
    }

    /**
     * Main Codex Agent management page.
     * @param {object} props - slot props with the locale reader.
     * @returns {object} page element tree.
     */
    function CodexAgentPanel(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const sharedFeed = props.sharedFeed
      useEffect(() => sharedFeed.openView(), [sharedFeed])
      const feed = {
        ...useSyncExternalStore(sharedFeed.subscribe, sharedFeed.getSnapshot),
        refresh: sharedFeed.refresh,
        retry: sharedFeed.retry,
      }
      const now = useNowTick()
      const headingUid = useId()
      const [copiedKey, setCopiedKey] = useState(null)
      const [fallbackKeys, setFallbackKeys] = useState(() => new Set())
      const [expandedParents, setExpandedParents] = useState(() => new Set())
      const [subagentStates, setSubagentStates] = useState(() => new Map())
      const copiedTimerRef = useRef(null)
      const expandedChildIdsRef = useRef([])

      useEffect(() => {
        return () => {
          if (copiedTimerRef.current !== null) {
            clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = null
          }
        }
      }, [])

      const copyCommand = useCallback((session) => {
        if (session === null || typeof session.command !== 'string' || session.command === '') return
        const key = session.key
        const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
        const write = clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function'
          ? clipboard.writeText(session.command)
          : Promise.reject(new Error('clipboard unavailable'))
        Promise.resolve(write).then(() => {
          setFallbackKeys(previous => {
            if (!previous.has(key)) return previous
            const next = new Set(previous)
            next.delete(key)
            return next
          })
          setCopiedKey(key)
          if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = setTimeout(() => {
            copiedTimerRef.current = null
            setCopiedKey(current => (current === key ? null : current))
          }, COPIED_MS)
        }, () => {
          setCopiedKey(current => (current === key ? null : current))
          setFallbackKeys(previous => {
            if (previous.has(key)) return previous
            const next = new Set(previous)
            next.add(key)
            return next
          })
        })
      }, [])

      const probeSubagentStates = useCallback((ids) => {
        const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id !== '')
        if (unique.length === 0) return
        void (async () => {
          const chunks = []
          for (let offset = 0; offset < unique.length; offset += 32) {
            chunks.push(unique.slice(offset, offset + 32))
          }
          const results = await Promise.allSettled(chunks.map((chunk) => {
            return requestJson(API_ROOT + '/session-states', {
              method: 'POST',
              body: JSON.stringify({ ids: chunk }),
            })
          }))
          const merged = {}
          for (const result of results) {
            if (result.status !== 'fulfilled') continue
            const { response, body } = result.value
            if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.states)) continue
            Object.assign(merged, body.states)
          }
          if (Object.keys(merged).length === 0) return
          setSubagentStates((previous) => {
            const next = new Map(previous)
            for (const [id, value] of Object.entries(merged)) {
              if (!isRecord(value)) continue
              next.set(id, {
                status: normalizeSessionStatus(value.status),
                stateSource: value.stateSource === 'log' ? 'log' : 'none',
                stateUpdatedAt: asNumber(value.stateUpdatedAt),
              })
            }
            return next
          })
        })()
      }, [])

      const toggleParent = useCallback((sessionId) => {
        setExpandedParents((previous) => {
          const next = new Set(previous)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }, [])

      const data = feed.data
      const servers = data !== null && Array.isArray(data.servers) ? data.servers : []
      const days = data !== null ? data.settings.days : DEFAULT_DAYS
      const seconds = data !== null ? pollSeconds(data.settings.pollMs) : pollSeconds(DEFAULT_POLL_MS)
      const updated = data !== null ? formatClock(data.generatedAt) : ''
      const parentIdsByServer = new Map()
      for (const server of servers) {
        parentIdsByServer.set(server.id, new Set(server.sessions.map(session => session.id)))
      }
      let topLevelCount = 0
      let subagentCount = 0
      let activeCount = 0
      const expandedChildIds = []
      for (const server of servers) {
        const known = parentIdsByServer.get(server.id)
        const childrenMap = new Map()
        for (const session of server.sessions) {
          if (!session.isSubagent) continue
          if (session.parentThreadId === '' || !known.has(session.parentThreadId)) continue
          let list = childrenMap.get(session.parentThreadId)
          if (list === undefined) {
            list = []
            childrenMap.set(session.parentThreadId, list)
          }
          list.push(session)
        }
        const collectIds = (parentId, out) => {
          for (const child of childrenMap.get(parentId) || []) {
            out.push(child.id)
            collectIds(child.id, out)
          }
        }
        for (const session of server.sessions) {
          if (session.isSubagent) subagentCount += 1
          const topLevel = !session.isSubagent || session.parentThreadId === '' || !known.has(session.parentThreadId)
          if (topLevel) topLevelCount += 1
          const override = session.stateSource === 'osc' ? undefined : subagentStates.get(session.id)
          const status = override?.status ?? session.status
          if (status === 'working' || status === 'blocked') activeCount += 1
          if (topLevel && expandedParents.has(session.id)) collectIds(session.id, expandedChildIds)
        }
      }
      expandedChildIdsRef.current = expandedChildIds
      const onlineCount = servers.filter(server => server.status === 'online').length
      const subtitle = data === null ? t('subtitleLoading') : t('tagline')
      const telemetry = data === null
        ? []
        : [
          { key: 'link', label: t('teleLink'), value: onlineCount + '/' + servers.length, tone: onlineCount === servers.length ? 'ok' : onlineCount > 0 ? 'warn' : 'error' },
          { key: 'tasks', label: t('teleTasks'), value: String(topLevelCount) },
          { key: 'agents', label: t('teleAgents'), value: String(subagentCount) },
          { key: 'active', label: t('teleActive'), value: String(activeCount), tone: activeCount > 0 ? 'ok' : 'idle' },
          { key: 'window', label: t('teleWindow'), value: days + 'D' },
          { key: 'poll', label: t('telePoll'), value: seconds + 'S' },
          { key: 'sync', label: t('teleSync'), value: updated !== '' ? updated : '--:--:--', tone: feed.refreshing ? 'warn' : 'ok' },
        ]

      // Refresh the expanded child rows while they are open. The Host caps and
      // caches the probe, so a 8 s client tick maps to one bounded SSH read.
      useEffect(() => {
        if (expandedParents.size === 0) return undefined
        const tick = () => {
          if (expandedChildIdsRef.current.length > 0) probeSubagentStates(expandedChildIdsRef.current)
        }
        tick()
        const timer = setInterval(tick, 8000)
        return () => { clearInterval(timer) }
      }, [expandedParents, probeSubagentStates])

      const hero = h('header', { className: 'dca-hero' },
        h('div', { className: 'dca-heroTop' },
          h('div', { className: 'dca-heroIdentity' },
            h('div', { className: 'dca-heroMark' }, h(CodexAgentIcon, { size: 30, active: true })),
            h('div', { className: 'dca-heroText' },
              h('div', { className: 'dca-kicker' },
                h('span', { className: 'dca-prompt', 'aria-hidden': true }, '>_'),
                h('span', null, t('consoleKicker')),
              ),
              h('h1', { className: 'dca-title' }, t('title')),
              h('p', { className: 'dca-subtitle' }, subtitle),
            ),
          ),
          h('div', { className: 'dca-heroActions' },
            h('button', {
              type: 'button',
              className: 'dca-iconBtn',
              disabled: feed.refreshing,
              title: feed.refreshing ? t('refreshing') : t('refresh'),
              'aria-label': feed.refreshing ? t('refreshing') : t('refresh'),
              onClick: feed.refresh,
            },
              h('span', { className: cx('dca-refreshIcon', feed.refreshing && 'isSpinning') }, h(RefreshGlyph)),
            ),
          ),
        ),
        telemetry.length > 0
          ? h('div', { className: 'dca-telemetry' },
            telemetry.map(item => h('div', {
              key: item.key,
              className: cx('dca-teleItem', item.tone !== undefined && 'dca-teleItem--' + item.tone),
            },
              h('span', { className: 'dca-teleLabel' }, item.label),
              h('span', { className: 'dca-teleValue' }, item.value),
            )),
          )
          : null,
      )

      let body
      if (data === null && feed.status === 'loading') {
        body = h('div', { className: 'dca-state', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'dca-spinner', 'aria-hidden': true }),
          h('p', { className: 'dca-stateTitle' }, t('loading')),
        )
      } else if (data === null && feed.status === 'error') {
        body = h('div', { className: 'dca-emptyState', role: 'alert' },
          h('div', { className: 'dca-emptyIcon' }, h(TerminalGlyph, { size: 30 })),
          h('h2', { className: 'dca-emptyHeading' }, t('pollFailed')),
          h('p', { className: 'dca-emptyCopy' }, t('pollFailedHint')),
          h('button', {
            type: 'button',
            className: 'dca-button',
            onClick: feed.retry,
          }, t('retry')),
        )
      } else if (servers.length === 0) {
        body = h('div', { className: 'dca-emptyState' },
          h('div', { className: 'dca-emptyIcon' }, h(CodexAgentIcon, { size: 34, active: true })),
          h('h2', { className: 'dca-emptyHeading' }, t('noServers')),
          h('p', { className: 'dca-emptyCopy' }, t('noServersHint')),
          h('div', { className: 'dca-emptySteps' },
            h('span', { className: 'dca-step' },
              h('span', { className: 'dca-stepNum' }, '1'),
              h('span', null, t('stepAddServer')),
            ),
            h('span', { className: 'dca-step' },
              h('span', { className: 'dca-stepNum' }, '2'),
              h('span', null, t('stepOpenPanel')),
            ),
          ),
        )
      } else {
        body = h('div', { className: 'dca-serverList' },
          servers.map((server, index) => h(ServerSection, {
            key: server.id || 'server-' + index,
            server: server,
            index: index,
            days: days,
            now: now,
            t: t,
            headingId: headingUid + '-server-' + index,
            copiedKey: copiedKey,
            fallbackKeys: fallbackKeys,
            onCopy: copyCommand,
            expandedParents: expandedParents,
            subagentStates: subagentStates,
            onToggleParent: toggleParent,
          })),
        )
      }

      return h('div', {
        className: 'dca-page',
        role: 'region',
        'aria-label': t('title'),
        'aria-busy': feed.refreshing ? 'true' : undefined,
      },
        h(PluginStyles),
        h('div', { className: 'dca-scroll' },
          h('div', { className: 'dca-content' },
            hero,
            feed.error !== null && data !== null
              ? h(ErrorBanner, { error: feed.error, t: t, onRetry: feed.retry })
              : null,
            body,
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Settings section.
    // ---------------------------------------------------------------------

    let localRowCounter = 0

    /**
     * @returns {string} a browser-local row identity that never collides.
     */
    function nextLocalRowKey() {
      localRowCounter += 1
      return 'local-' + localRowCounter
    }

    let serverIdCounter = 0

    /**
     * Client-side stable server id. Assigning it before the first save makes a
     * draft row idempotent across debounced/queued writes: the Host preserves a
     * valid supplied id, so a re-sent draft can never become a second server.
     * @returns {string} server id accepted by the Host's id pattern.
     */
    function nextServerId() {
      const cryptoObject = typeof crypto === 'object' && crypto !== null ? crypto : null
      if (cryptoObject !== null && typeof cryptoObject.randomUUID === 'function') {
        return 'srv_' + cryptoObject.randomUUID().replace(/-/g, '').slice(0, 10)
      }
      serverIdCounter += 1
      return 'srv_' + Date.now().toString(36) + serverIdCounter.toString(36)
    }

    /**
     * Stable signature of the editable settings fields. Row ids are excluded so
     * the id write-back after a save does not schedule another save.
     * @param {Array<object>} rows - editor rows.
     * @param {string} daysText - display-window input.
     * @param {string} secondsText - poll-interval input.
     * @returns {string} signature.
     */
    function draftSignature(rows, daysText, secondsText) {
      return JSON.stringify({
        rows: rows.map(row => [row.name, row.ssh, row.port]),
        days: daysText,
        seconds: secondsText,
      })
    }

    /**
     * Validate the settings draft before it is sent to the Host.
     * @param {Array<object>} rows - editor rows.
     * @param {string} daysText - display-window input text.
     * @param {string} secondsText - poll-interval input text.
     * @param {Function} t - locale reader.
     * @returns {{ errors: object, firstPath: string | null, payload: object | null, firstMessage: string }} validation result.
     */
    function validateSettingsDraft(rows, daysText, secondsText, t) {
      const errors = {}
      rows.forEach((row) => {
        const prefix = 'row:' + row.key
        if (row.name.trim() === '') errors[prefix + '.name'] = t('validationName')
        if (row.ssh.trim() === '') errors[prefix + '.ssh'] = t('validationSsh')
        const portText = row.port.trim()
        if (portText !== '') {
          const port = Number(portText)
          if (!Number.isInteger(port) || port < 1 || port > 65535) errors[prefix + '.port'] = t('validationPort')
        }
      })
      const days = Number(daysText)
      if (!Number.isInteger(days) || days < 1 || days > 30) errors.days = t('validationDays')
      const seconds = Number(secondsText)
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) errors.pollSeconds = t('validationPoll')

      const paths = Object.keys(errors)
      if (paths.length > 0) {
        return { errors: errors, firstPath: paths[0], payload: null, firstMessage: errors[paths[0]] }
      }
      return {
        errors: errors,
        firstPath: null,
        payload: {
          servers: rows.map((row) => {
            const portText = row.port.trim()
            const server = {
              name: row.name.trim(),
              ssh: row.ssh.trim(),
              port: portText === '' ? null : Number(portText),
            }
            if (row.id !== null && row.id !== '') server.id = row.id
            return server
          }),
          days: days,
          pollMs: seconds * 1000,
        },
        firstMessage: '',
      }
    }

    /**
     * @param {object} settings - normalized settings.
     * @returns {Array<object>} editor rows rebuilt from stored settings.
     */
    function rowsFromSettings(settings) {
      return settings.servers.map((server) => ({
        key: server.id || nextLocalRowKey(),
        id: server.id || null,
        name: server.name,
        ssh: server.ssh,
        port: server.port === null ? '' : String(server.port),
      }))
    }

    /**
     * Settings section: server list, display window, poll interval, status.
     * @param {{ t?: Function, close?: Function }} props - composed slot props.
     * @returns {object} settings element tree.
     */
    function CodexAgentSettings(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const uid = useId()
      const titleId = uid + '-settings-title'

      const [loadState, setLoadState] = useState({ status: 'loading', detail: '' })
      const [loadToken, setLoadToken] = useState(0)
      const [rows, setRows] = useState([])
      const [daysText, setDaysText] = useState(String(DEFAULT_DAYS))
      const [secondsText, setSecondsText] = useState(String(pollSeconds(DEFAULT_POLL_MS)))
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const [draftState, setDraftState] = useState('idle')
      const [saveError, setSaveError] = useState(null)
      const [fieldErrors, setFieldErrors] = useState({})
      const [confirmingKey, setConfirmingKey] = useState(null)
      const [statusSummary, setStatusSummary] = useState({ state: 'idle', servers: [] })
      const [statusToken, setStatusToken] = useState(0)

      const mountedRef = useRef(true)
      const savedTimerRef = useRef(null)
      const saveControllerRef = useRef(null)
      const statusControllerRef = useRef(null)
      const trashRefs = useRef(new Map())
      const addButtonRef = useRef(null)
      const fieldRefs = useRef(new Map())
      const pendingFocusRowRef = useRef(null)
      const pendingFocusPathRef = useRef(null)
      const autoSaveReadyRef = useRef(false)
      const lastSavedSignatureRef = useRef('')
      const pendingSaveRef = useRef(false)
      const latestDraftRef = useRef({ rows: [], daysText: '', secondsText: '' })
      latestDraftRef.current = { rows: rows, daysText: daysText, secondsText: secondsText }

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          if (savedTimerRef.current !== null) {
            clearTimeout(savedTimerRef.current)
            savedTimerRef.current = null
          }
          if (saveControllerRef.current !== null) {
            saveControllerRef.current.abort()
            saveControllerRef.current = null
          }
          if (statusControllerRef.current !== null) {
            statusControllerRef.current.abort()
            statusControllerRef.current = null
          }
        }
      }, [])

      // Load the stored settings document, and reload it when Retry asks.
      useEffect(() => {
        let disposed = false
        const controller = new AbortController()
        setLoadState({ status: 'loading', detail: '' })
        void (async () => {
          try {
            const payload = await requestOk(API_ROOT + '/settings', controller.signal, t)
            if (disposed) return
            const settings = normalizeSettings(payload.settings)
            setRows(rowsFromSettings(settings))
            setDaysText(String(settings.days))
            setSecondsText(String(pollSeconds(settings.pollMs)))
            setFieldErrors({})
            setSaveError(null)
            setSaved(false)
            setDraftState('idle')
            autoSaveReadyRef.current = false
            setLoadState({ status: 'ready', detail: '' })
          } catch (error) {
            if (disposed || isAbortError(error)) return
            setLoadState({ status: 'error', detail: errorDetail(error) })
          }
        })()
        return () => {
          disposed = true
          controller.abort()
        }
      }, [loadToken])

      // Server reachability summary: after load/save and every 10 s.
      useEffect(() => {
        if (loadState.status !== 'ready') return undefined
        let disposed = false
        let timer = null
        let inFlight = false
        const load = () => {
          if (disposed || inFlight) return
          inFlight = true
          const controller = new AbortController()
          statusControllerRef.current = controller
          void (async () => {
            try {
              const payload = await requestOk(API_ROOT + '/servers', controller.signal, t)
              if (disposed) return
              const servers = Array.isArray(payload.servers) ? payload.servers.map(normalizeServerSummary) : []
              setStatusSummary({ state: 'ready', servers: servers })
            } catch (error) {
              if (disposed || isAbortError(error)) return
              setStatusSummary(previous => ({ state: 'error', servers: previous.servers }))
            } finally {
              inFlight = false
              if (statusControllerRef.current === controller) statusControllerRef.current = null
              if (!disposed) timer = setTimeout(load, STATUS_REFRESH_MS)
            }
          })()
        }
        load()
        return () => {
          disposed = true
          if (timer !== null) clearTimeout(timer)
          if (statusControllerRef.current !== null) {
            statusControllerRef.current.abort()
            statusControllerRef.current = null
          }
        }
      }, [loadState.status, statusToken])

      // Auto-save every valid draft after a short debounce. The old explicit
      // Save button made "add" and "persist" feel like two separate actions;
      // here a new server row becomes durable as soon as it is complete.
      useEffect(() => {
        if (loadState.status !== 'ready') {
          autoSaveReadyRef.current = false
          return undefined
        }
        const signature = draftSignature(rows, daysText, secondsText)
        if (!autoSaveReadyRef.current) {
          autoSaveReadyRef.current = true
          lastSavedSignatureRef.current = signature
          return undefined
        }
        if (signature === lastSavedSignatureRef.current) return undefined
        setSaved(false)
        const incomplete = rows.some(row => row.name.trim() === '' || row.ssh.trim() === '')
        if (incomplete) {
          setDraftState('waiting')
          setSaveError(null)
          return undefined
        }
        const validation = validateSettingsDraft(rows, daysText, secondsText, t)
        if (validation.payload === null) {
          setDraftState('invalid')
          setFieldErrors(validation.errors)
          setSaveError(null)
          return undefined
        }
        setFieldErrors({})
        setDraftState('idle')
        const timer = setTimeout(() => {
          persist(validation.payload, signature)
        }, AUTO_SAVE_DELAY_MS)
        return () => { clearTimeout(timer) }
      }, [rows, daysText, secondsText, loadState.status])

      // Focus a newly added server's name field, or the first invalid field.
      useEffect(() => {
        const rowKey = pendingFocusRowRef.current
        if (rowKey !== null) {
          pendingFocusRowRef.current = null
          const input = fieldRefs.current.get('row:' + rowKey + '.name')
          if (input !== undefined && typeof input.focus === 'function') input.focus()
        }
        const path = pendingFocusPathRef.current
        if (path !== null) {
          pendingFocusPathRef.current = null
          const input = fieldRefs.current.get(path)
          if (input !== undefined && typeof input.focus === 'function') input.focus()
        }
      }, [rows, fieldErrors])

      const markSaved = () => {
        setSaved(true)
        setSavedAt(Date.now())
        if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => {
          savedTimerRef.current = null
          if (mountedRef.current) setSaved(false)
        }, SAVED_MS)
      }

      const clearValidation = () => {
        setFieldErrors({})
        setSaveError(null)
        if (saved) setSaved(false)
      }

      const updateRow = (key, field, value) => {
        setRows(previous => previous.map((row) => {
          if (row.key !== key) return row
          const next = { key: row.key, id: row.id, name: row.name, ssh: row.ssh, port: row.port }
          next[field] = value
          return next
        }))
        setFieldErrors(previous => {
          const path = 'row:' + key + '.' + field
          if (previous[path] === undefined) return previous
          const next = { ...previous }
          delete next[path]
          return next
        })
        if (saveError !== null) setSaveError(null)
        if (saved) setSaved(false)
      }

      const addRow = () => {
        const key = nextLocalRowKey()
        setRows(previous => previous.concat([{ key: key, id: nextServerId(), name: '', ssh: '', port: '' }]))
        setConfirmingKey(null)
        pendingFocusRowRef.current = key
        if (saved) setSaved(false)
      }

      const removeRow = (key) => {
        setRows(previous => previous.filter(row => row.key !== key))
        setConfirmingKey(null)
        setFieldErrors(previous => {
          const next = {}
          let changed = false
          const prefix = 'row:' + key + '.'
          Object.keys(previous).forEach((path) => {
            if (path.indexOf(prefix) === 0) changed = true
            else next[path] = previous[path]
          })
          return changed ? next : previous
        })
        if (saved) setSaved(false)
        requestAnimationFrame(() => {
          const button = addButtonRef.current
          if (button !== null && typeof button.focus === 'function') button.focus()
        })
      }

      const persist = (payload, signature) => {
        if (saveControllerRef.current !== null) {
          // Keep the request order deterministic. The latest draft is rebuilt
          // from refs after the in-flight request settles, so a late response
          // can never rewrite a newer list.
          pendingSaveRef.current = true
          return
        }
        if (signature === lastSavedSignatureRef.current) return
        setFieldErrors({})
        setSaveError(null)
        setSaving(true)
        const controller = new AbortController()
        saveControllerRef.current = controller
        let failed = false
        void (async () => {
          try {
            const { response, body } = await requestJson(API_ROOT + '/settings', {
              method: 'POST',
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
            if (!mountedRef.current || controller.signal.aborted) return
            if (!response.ok || !isRecord(body) || body.ok !== true) {
              failed = true
              const detail = firstErrorMessage(body, t) || 'HTTP ' + response.status
              setSaveError({ detail: detail })
              return
            }
            lastSavedSignatureRef.current = signature
            setFieldErrors({})
            setSaveError(null)
            setDraftState('idle')
            setStatusToken(token => token + 1)
            markSaved()
          } catch (error) {
            if (controller.signal.aborted) return
            if (!mountedRef.current) return
            failed = true
            setSaveError({ detail: errorDetail(error) })
          } finally {
            if (saveControllerRef.current === controller) saveControllerRef.current = null
            if (mountedRef.current && !controller.signal.aborted) {
              setSaving(false)
              if (pendingSaveRef.current) {
                pendingSaveRef.current = false
                const draft = latestDraftRef.current
                const validation = validateSettingsDraft(draft.rows, draft.daysText, draft.secondsText, t)
                if (validation.payload !== null) {
                  const nextSignature = draftSignature(draft.rows, draft.daysText, draft.secondsText)
                  setTimeout(() => { persist(validation.payload, nextSignature) }, 0)
                } else if (!failed) {
                  setDraftState('invalid')
                  setFieldErrors(validation.errors)
                }
              }
            }
          }
        })()
      }

      const retrySave = () => {
        pendingSaveRef.current = false
        const validation = validateSettingsDraft(rows, daysText, secondsText, t)
        if (validation.payload === null) {
          setFieldErrors(validation.errors)
          setDraftState('invalid')
          return
        }
        persist(validation.payload, draftSignature(rows, daysText, secondsText))
      }

      const requestDelete = (key) => {
        setConfirmingKey(key)
      }

      const setFieldRef = (path, node) => {
        if (node === null) fieldRefs.current.delete(path)
        else fieldRefs.current.set(path, node)
      }

      const renderField = (options) => {
        const path = options.path
        const error = options.error
        const errorId = path.replace(/[^A-Za-z0-9_-]/g, '-') + '-error'
        const common = {
          ref: node => { setFieldRef(path, node) },
          className: cx('dca-input', error !== undefined && 'dca-inputInvalid'),
          'aria-invalid': error !== undefined ? 'true' : undefined,
          'aria-describedby': error !== undefined ? errorId : undefined,
        }
        return h('div', { className: 'dca-field', key: path },
          h('label', { className: 'dca-fieldLabel', htmlFor: options.id }, options.label),
          h('input', {
            ...common,
            id: options.id,
            type: options.type || 'text',
            value: options.value,
            placeholder: options.placeholder,
            autoComplete: 'off',
            spellCheck: false,
            inputMode: options.inputMode,
            min: options.min,
            max: options.max,
            step: options.step,
            onChange: event => { options.onChange(event.target.value) },
          }),
          error !== undefined
            ? h('span', { className: 'dca-fieldError', id: errorId }, error)
            : null,
        )
      }

      const renderServerRow = (row, index) => {
        const nameError = fieldErrors['row:' + row.key + '.name']
        const sshError = fieldErrors['row:' + row.key + '.ssh']
        const portError = fieldErrors['row:' + row.key + '.port']
        const confirming = confirmingKey === row.key
        const rowLabel = t('edit') + ' ' + (row.name.trim() !== '' ? row.name.trim() : t('server')) + ' ' + (index + 1)
        const known = row.id === null || row.id === ''
          ? undefined
          : statusSummary.servers.find(server => server.id === row.id)
        const scanLabel = scanStatusLabel(t, known?.scanWarning)
        const linkState = scanLabel !== null ? 'checking' : (known?.status ?? (row.id ? 'checking' : 'draft'))
        const linkLabel = scanLabel ?? t(linkState)
        const deleteLabel = t('delete') + ' ' + (row.name.trim() !== '' ? row.name.trim() : t('server'))
        return h('fieldset', {
          key: row.key,
          className: 'dca-serverCard',
          'aria-label': rowLabel,
        },
          h('div', { className: 'dca-serverCardHead' },
            h('div', { className: 'dca-serverCardTitle' },
              h('span', { className: 'dca-serverIndex' }, t('serverNumber', { n: String(index + 1).padStart(2, '0') })),
              h('span', { className: 'dca-serverLamp dca-serverLamp--' + linkState, role: 'status' },
                h('span', { className: 'dca-lampDot', 'aria-hidden': true }),
                h('span', null, linkLabel),
              ),
            ),
            confirming
              ? null
              : h('button', {
                type: 'button',
                ref: node => {
                  if (node === null) trashRefs.current.delete(row.key)
                  else trashRefs.current.set(row.key, node)
                },
                className: 'dca-iconButton',
                title: deleteLabel,
                'aria-label': deleteLabel,
                onClick: () => { requestDelete(row.key) },
              }, h(TrashGlyph)),
          ),
          h('div', { className: 'dca-serverGrid' },
            renderField({
              id: uid + '-name-' + row.key,
              path: 'row:' + row.key + '.name',
              label: t('name'),
              value: row.name,
              placeholder: t('namePlaceholder'),
              error: nameError,
              onChange: value => { updateRow(row.key, 'name', value) },
            }),
            renderField({
              id: uid + '-ssh-' + row.key,
              path: 'row:' + row.key + '.ssh',
              label: t('ssh'),
              value: row.ssh,
              placeholder: t('sshPlaceholder'),
              error: sshError,
              onChange: value => { updateRow(row.key, 'ssh', value) },
            }),
            renderField({
              id: uid + '-port-' + row.key,
              path: 'row:' + row.key + '.port',
              label: t('port'),
              // The placeholder is visual only: blank still inherits OpenSSH's port.
              value: row.port,
              placeholder: '22',
              type: 'number',
              inputMode: 'numeric',
              min: 1,
              max: 65535,
              step: 1,
              error: portError,
              onChange: value => { updateRow(row.key, 'port', value) },
            }),
          ),
          confirming
            ? h('div', { className: 'dca-rowConfirm', role: 'group', 'aria-label': t('confirmDelete') },
              h('span', null, t('confirmDelete')),
              h('button', {
                type: 'button',
                className: 'dca-button dca-buttonSmall dca-buttonDanger',
                onClick: () => { removeRow(row.key) },
              }, t('delete')),
              h('button', {
                type: 'button',
                className: 'dca-button dca-buttonSmall',
                autoFocus: true,
                onClick: () => {
                  setConfirmingKey(null)
                  requestAnimationFrame(() => {
                    const button = trashRefs.current.get(row.key)
                    if (button !== undefined && typeof button.focus === 'function') button.focus()
                  })
                },
              }, t('cancel')),
            )
            : null,
        )
      }

      const validationPaths = Object.keys(fieldErrors)
      const validationMessage = validationPaths.length > 0 ? fieldErrors[validationPaths[0]] : ''

      let editor = null
      let autoStatus = null
      if (loadState.status === 'loading') {
        editor = h('div', { className: 'dca-state', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'dca-spinner', 'aria-hidden': true }),
          h('p', { className: 'dca-stateTitle' }, t('loading')),
        )
      } else if (loadState.status === 'error') {
        editor = h('div', { className: 'dca-banner', role: 'alert' },
          h(WarnGlyph, { size: 14 }),
          h('span', { className: 'dca-bannerText' },
            h('span', null, t('loadFailed')),
            loadState.detail !== ''
              ? h('span', { className: 'dca-bannerDetail' }, ' — ' + loadState.detail)
              : null,
          ),
          h('button', {
            type: 'button',
            className: 'dca-button dca-buttonSmall',
            onClick: () => { setLoadToken(token => token + 1) },
          }, t('retry')),
        )
      } else {
        autoStatus = (() => {
          if (saveError !== null) {
            return h('span', { className: 'dca-autoStatus dca-autoStatus--error', role: 'alert' },
              h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
              h('span', null, t('autoSaveFailed')),
              h('button', {
                type: 'button',
                className: 'dca-autoRetry',
                onClick: retrySave,
              }, t('retry')),
            )
          }
          if (saving) {
            return h('span', { className: 'dca-autoStatus dca-autoStatus--saving', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
              h('span', null, t('saving')),
            )
          }
          if (saved) {
            return h('span', { className: 'dca-autoStatus dca-autoStatus--saved', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
              h('span', null, t('autoSavedAt', { time: formatClock(savedAt) })),
            )
          }
          if (draftState === 'waiting') {
            return h('span', { className: 'dca-autoStatus dca-autoStatus--waiting', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
              h('span', null, t('autoSaveWaiting')),
            )
          }
          if (draftState === 'invalid') {
            return h('span', { className: 'dca-autoStatus dca-autoStatus--error', role: 'alert' },
              h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
              h('span', null, validationMessage !== '' ? validationMessage : t('autoSaveInvalid')),
            )
          }
          return h('span', { className: 'dca-autoStatus' },
            h('span', { className: 'dca-autoDot', 'aria-hidden': true }),
            h('span', null, t('autoSaveOn')),
          )
        })()

        const numberField = (options) => {
          const error = options.error
          const errorId = options.id + '-error'
          return h('div', { className: 'dca-numberField' },
            h('label', { className: 'dca-fieldLabel', htmlFor: options.id }, options.label),
            h('div', { className: 'dca-numberInputWrap' },
              h('input', {
                id: options.id,
                type: 'number',
                min: options.min,
                max: options.max,
                step: 1,
                inputMode: 'numeric',
                ref: node => { setFieldRef(options.path, node) },
                className: cx('dca-numberInput', error !== undefined && 'dca-inputInvalid'),
                value: options.value,
                'aria-invalid': error !== undefined ? 'true' : undefined,
                'aria-describedby': error !== undefined ? errorId : undefined,
                onChange: options.onChange,
              }),
              h('span', { className: 'dca-numberUnit' }, options.unit),
            ),
            error !== undefined
              ? h('span', { className: 'dca-fieldError', id: errorId }, error)
              : null,
            options.hint !== undefined ? h('span', { className: 'dca-fieldHint' }, options.hint) : null,
          )
        }

        editor = h(React.Fragment, null,
          h('section', { className: 'dca-card dca-cardPad' },
            h('div', { className: 'dca-sectionHead' },
              h('h2', { className: 'dca-sectionTitle' }, t('servers')),
              h('button', {
                type: 'button',
                className: 'dca-button dca-addServer',
                ref: addButtonRef,
                onClick: addRow,
              }, t('addServer')),
            ),
            rows.length === 0
              ? h('div', { className: 'dca-editorEmpty' }, t('noServers'))
              : h('div', { className: 'dca-serverEditorList' }, rows.map(renderServerRow)),
          ),
          h('section', { className: 'dca-card dca-cardPad' },
            h('h2', { className: 'dca-sectionTitle' }, t('behavior')),
            h('p', { className: 'dca-sectionHint' }, t('behaviorHint')),
            h('div', { className: 'dca-formGrid' },
              numberField({
                id: uid + '-days',
                path: 'days',
                label: t('days'),
                value: daysText,
                unit: t('daysUnit'),
                min: 1,
                max: 30,
                hint: t('daysHint'),
                error: fieldErrors.days,
                onChange: (event) => {
                  setDaysText(event.target.value)
                  setFieldErrors(previous => {
                    if (previous.days === undefined) return previous
                    const next = { ...previous }
                    delete next.days
                    return next
                  })
                  if (saveError !== null) setSaveError(null)
                  if (saved) setSaved(false)
                },
              }),
              numberField({
                id: uid + '-seconds',
                path: 'pollSeconds',
                label: t('pollSeconds'),
                value: secondsText,
                unit: t('pollUnit'),
                min: 1,
                max: 60,
                hint: t('pollHint'),
                error: fieldErrors.pollSeconds,
                onChange: (event) => {
                  setSecondsText(event.target.value)
                  setFieldErrors(previous => {
                    if (previous.pollSeconds === undefined) return previous
                    const next = { ...previous }
                    delete next.pollSeconds
                    return next
                  })
                  if (saveError !== null) setSaveError(null)
                  if (saved) setSaved(false)
                },
              }),
            ),
          ),
        )
      }

      return h('div', { className: 'dca-settingsPage', role: 'region', 'aria-labelledby': titleId },
        h(PluginStyles),
        h('header', { className: 'dca-settingsHero' },
          h('div', { className: 'dca-heroMark' }, h(CodexAgentIcon, { size: 26, active: true })),
          h('div', { className: 'dca-settingsHeroText' },
            h('div', { className: 'dca-kicker' },
              h('span', { className: 'dca-prompt', 'aria-hidden': true }, '>_'),
              h('span', null, t('configKicker')),
            ),
            h('h1', { className: 'dca-settingsTitle', id: titleId }, t('title')),
            h('p', { className: 'dca-settingsIntro' }, t('settingsIntro')),
          ),
          h('div', { className: 'dca-settingsStatus' },
            h('span', { className: 'dca-monoTag' }, t('autoSaveTag')),
            autoStatus,
          ),
        ),
        h('div', { className: 'dca-settingsBody' }, editor),
      )
    }

    // ---------------------------------------------------------------------
    // Sidebar icon.
    // ---------------------------------------------------------------------

    /**
     * Sidebar panel icon: a terminal frame with a prompt and two status dots.
     * The sidebar owns the accessible button, so this artwork is decorative.
     * @param {{ size?: number, active?: boolean }} props - icon geometry and selection.
     * @returns {object} inline SVG icon.
     */
    function CodexAgentIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' && props.size > 0
        ? props.size
        : 24
      const active = props !== null && typeof props === 'object' && props.active === true
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block', color: 'currentColor' },
      },
        h('rect', {
          x: 2.75,
          y: 3.75,
          width: 18.5,
          height: 16.5,
          rx: 3,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.7 : 1.5,
          opacity: active ? 1 : 0.9,
        }),
        h('path', {
          d: 'M6.3 9.4 8.8 11.9 6.3 14.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.9,
        }),
        h('path', {
          d: 'M10.6 14.5h3.1',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          opacity: active ? 1 : 0.9,
        }),
        h('circle', { cx: 17.1, cy: 9.2, r: 1.65, style: { fill: 'currentColor', opacity: 0.9 } }),
        h('circle', { cx: 17.1, cy: 14.2, r: 1.45, style: { fill: 'currentColor', opacity: 0.45 } }),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry point.
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const sharedFeed = createCodexFeed()

        ctx.effect(() => ctx.locale.register(NS, { en: en, zh: zh }), 'codex-agent: dictionaries')

        // Sidebar entry: directly below the shipped 自动化任务 panel (id
        // `schedules`), whose order is read at declaration time instead of
        // being hardcoded here.
        ctx.slots.inject('sidebar.panellist', () => {
          let baseOrder = 10
          if (typeof ctx.slots.entriesOfSlot === 'function') {
            const entries = ctx.slots.entriesOfSlot('sidebar.panellist')
            if (Array.isArray(entries)) {
              for (const entry of entries) {
                if (entry === null || typeof entry !== 'object') continue
                const options = entry.options
                if (options === null || typeof options !== 'object') continue
                if (options.id !== 'schedules') continue
                if (typeof options.order === 'number' && Number.isFinite(options.order)) baseOrder = options.order
                break
              }
            }
          }
          const options = { name: 'sidebar.panellist', id: 'codex-agent', order: baseOrder + 5, locale: NS }
          const disposeDefault = ctx.slots.register({ ...options, label: () => t('panel') }, CodexAgentIcon)
          // Re-project the cached label without removing/replacing the owner's button.
          let disposeUnread = null
          const sync = () => {
            if (sharedFeed.hasUnread() && disposeUnread === null) {
              disposeUnread = ctx.slots.register({ ...options, priority: -1, label: () => t('panelUnread') }, CodexAgentIcon)
            } else if (!sharedFeed.hasUnread() && disposeUnread !== null) {
              disposeUnread()
              disposeUnread = null
            }
          }
          const unsubscribe = sharedFeed.subscribeUnread(sync)
          sync()
          return () => {
            unsubscribe()
            disposeUnread?.()
            disposeDefault()
          }
        })

        // Main management page, dispatched by the sidebar panel id above.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'codex-agent',
          locale: NS,
        }, props => h(CodexAgentPanel, { ...props, sharedFeed })))
        ctx.effect(() => sharedFeed.start(), 'codex-agent: shared session feed')

        // Preferred target requested by the spec. The running profile does
        // not declare this slot, so the branch is a no-op there; the check
        // keeps the registration honest on profiles that do declare it.
        let agentPresetsDeclared = false
        try {
          if (typeof ctx.slots.spec === 'function') agentPresetsDeclared = ctx.slots.spec('agent-presets.settings') !== undefined
        } catch {
          agentPresetsDeclared = false
        }
        if (agentPresetsDeclared) {
          ctx.slots.inject('agent-presets.settings', () => ctx.slots.register({
            name: 'agent-presets.settings',
            id: 'codex-agent',
            order: 21,
            locale: NS,
            label: () => t('panel'),
          }, CodexAgentSettings))
        }

        // This version's settings surface: a first-class settings page. When a
        // future DSH declares the Agent-presets extension slot above, the card
        // lives there instead of adding a second copy in the settings nav.
        if (!agentPresetsDeclared) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'codex-agent',
            order: 21,
            locale: NS,
            label: () => t('panel'),
          }, CodexAgentSettings))
          ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
            name: 'settings.section.icon',
            id: 'codex-agent',
            order: 21,
            locale: NS,
          }, CodexAgentIcon))
        }
      },
    }
  },
})
