# Changelog

## 0.1.1

- 侧栏「· 有更新」只跟随主任务的状态变化；子代理（subagent）状态变化不再触发提示。

## 0.1.0

首个公开版本。

- 侧栏 Codex Agent 面板：远端 Codex 会话发现、tmux 窗格定位、OSC 7501 实时状态。
- 主任务 / 子代理分层展示，展开时按需读取子代理状态。
- 侧栏「有更新」提示：面板未打开时，已知会话状态变化会在标题旁标记，打开即清除。
- iTerm2「查看」：macOS 本机通过 SSH 交互式连接会话；已有 iTerm2 时优先在普通窗口新开标签页，否则新建窗口；不踢出其他客户端，tmux 3.2+ 使用 `ignore-size`。
- 保留复制 SSH + tmux attach 命令作为备用入口。
- Host HTTP API 本地认证、只读会话发现、tmux pipe-pane 守卫。
