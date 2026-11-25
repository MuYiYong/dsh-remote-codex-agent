# Codex Agent

在 DSH 左侧边栏“自动化任务”下方增加 **Codex Agent** 面板，统一查看、监控多台远端 Ubuntu 服务器上的 Codex CLI 会话。

## 能做什么

- **发现会话**：Host 侧通过 `ssh` 连接每台服务器，优先只读查询 `${CODEX_HOME:-~/.codex}/state_5.sqlite` 的 `threads` 表；`sqlite3` 不可用时先尝试 Python 标准库 sqlite3（只读），最后回退到解析 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 的 `session_meta`。JSONL 回退会按 mtime 倒序取最近文件，避免旧会话占满上限而漏掉正在运行的任务。
- **定位运行终端**：自动枚举远端全部 tmux 会话与窗格，用 `pane_title` 与会话标题/工作目录匹配；匹配不到时，检查 `pane_pid` 进程树中的 `codex` 进程及其工作目录。同一窗格中的主会话与子代理共享 cwd 时，优先定位 `thread_source=user` 的主任务。无需手工填写 tmux 会话名。
- **实时状态**：对已定位的窗格执行 `tmux pipe-pane -Oo`，把输出复制到远端 FIFO；Host 侧通过 SSH 长连接读取并解析 Codex CLI 0.163.0+ 的 OSC 7501 状态序列（`app=codex` + `state=idle|working|blocked|done|error|clear`），`blocked` 时额外解析 `kind` 与 base64 编码的 `msg`。
- **侧栏更新提示**：离开 Codex Agent 面板后，已有会话的已知状态发生变化时，侧栏标题旁显示「· 有更新」；打开面板即清除。
- **在 iTerm2 中查看**：本机 macOS Desktop 安装 iTerm2，且 tmux 位置可用时，点击「查看」会交互式连接当前 tmux 会话，可直接输入；不主动切换原有窗格、不踢出已有客户端。iTerm2 已运行时，优先在最前面的普通窗口新开标签页；未运行、只剩热键窗口或该窗口拒绝新标签页时才新建窗口。tmux 3.2+ 用 `-f ignore-size` 避免改变其他客户端看到的窗口大小，旧版回退为普通 attach。首次使用可能需要授权 macOS 自动化。标签页或窗口打开后，SSH 登录及连接结果仍以 iTerm2 中的输出为准。
- **复制连接命令**：原有 SSH + tmux 命令保留为备用操作；不能用 iTerm2 查看时，仍显示「复制连接命令」。
- **设置**：在 **设置 → Codex Agent** 卡片中维护服务器列表（名称 + SSH 别名或 `user@host`，端口可选）、展示天数（1–30，默认 3）与轮询间隔（默认 2 秒）。该卡片与“Agent 预设”设置页并列；当前 DSH 版本没有 `agent-presets.settings` 扩展槽位，因此在设置导航中作为独立页面呈现。

## 使用前提

- 本机已配置 `~/.ssh/config`，并通过公钥免密登录远端服务器（插件以 `BatchMode=yes` 运行，不管理密码与私钥）。
- 远端已安装 `tmux`；`sqlite3` 可选（缺失时自动回退）。
- Codex CLI 版本不低于 0.163.0 才能通过原生 OSC 7501 通道给出精确状态；更低版本或未捕获到 OSC 时会显示 `unknown`，并提示该会话无法通过原生状态通道监控。
- 服务器 SSH 别名/`user@host` 与端口在“设置 → Codex Agent”中配置。

## 主任务与子代理

Codex 会为并行任务创建 `thread_source=subagent` 的子会话。面板默认只展示主会话（右上角“子代理 N”开关可展开全部），避免几十个子代理会话淹没正在运行的主任务。

## 状态来源与日志回退

1. **OSC 7501**：Codex 原生状态通道，优先级最高。
2. **rollout 事件**：捕获开始时 turn 已运行，OSC 是边沿触发、不会补发；Host 每 5 秒对已定位、且仍无 OSC 状态的会话批量执行一次只读检查，从 rollout JSONL 的 `event_msg` 中找最后一个 `task_started` / `task_complete`。`task_started` → `working`，`task_complete` 且文件较新 → `done`，完成超过 10 分钟 → `idle`。面板在该行显示 `LOG` 徽标。展开子代理时，浏览器调用 `/api/codex-agent/session-states`，Host 只对展开的子代理做一次有界、带 5 秒缓存的同样检查；不展开不扫描，避免几十个子代理 rollout 每轮全量 grep。
3. **unknown**：以上都不可用时的诚实状态。

## 设置自动保存

服务器与展示参数没有单独的保存按钮：输入变化后 600 ms 防抖自动 POST；新增服务器在名称与 SSH 填写完整后自动落盘；删除确认后立即自动保存。右上角显示 `AUTO-SAVE` 状态（等待填写 / 保存中 / 已保存时间 / 失败重试），不再有“添加和保存分开”的两步操作。

## 状态标识

| 标识 | 状态 | 含义 |
|---|---|---|
| 绿色圆点 | working | 正在思考、执行工具或生成中 |
| 橙色圆点 | blocked | 等待批准、回答问题或登录 |
| 灰色空心圆 | idle | 一轮任务已结束，等待新指令 |
| 灰色对勾 | done | 任务完成 |
| 红色圆点 | failed | 执行出错 |
| 暗灰问号 | unknown | OSC 未捕获或 Codex 版本过低 |
| 灰色叉号 | unreachable | SSH 不可达，该服务器下所有会话统一标记 |

## 已知限制

- 状态通道依赖 tmux 的 `pipe-pane`（建议 tmux >= 3.1，插件用 `#{pane_pipe}` 判断窗格是否已有 pipe）。如果同一窗格已有其他 `pipe-pane` 占用，插件使用 `-o` 不会覆盖它，该会话会保持 `unknown`。
- 远端 `/tmp` 不可写时，FIFO 会回退到 `~/.dsh-codex-agent-<hash>.fifo`。
- 插件只监控既有 Codex 会话，不启动新会话。
- 面板每 2 秒（可调）读取 Host 缓存；Host 侧按配置的轮询间隔并行 SSH 刷新各服务器。


## 子任务关系与展开

`ServerSection` 按 `parentThreadId` 把会话分组：主任务默认渲染，子代理按父任务折叠。点击主任务行（或行内“N 个子代理”按钮）展开子行；展开期间客户端每 8 秒调用一次 `/session-states`，Host 端缓存 5 秒并限制最多 12 个目标，返回 `working/done/idle` 与 `LOG` 来源。未展开的子代理不显示、也不探测。设置页不再重复展示“服务器状态”卡片，服务器卡片标题栏的状态灯已经是当前连接结果。
