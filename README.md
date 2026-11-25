# Codex Agent

DSH 插件：在左侧边栏「自动化任务」下方增加 **Codex Agent**，集中查看、监控并连接多台远端服务器上的 Codex CLI 会话。

- 自动发现远端 Codex 会话，并定位到对应的 tmux 会话/窗格，无需手工填写。
- 通过 Codex CLI 0.163.0+ 的 OSC 7501 显示实时状态（working / blocked / idle / done / error）。
- 侧栏显示「· 有更新」提示（只跟随主任务，子代理状态变化不触发）；打开面板即清除。
- 在 macOS Desktop 上点「查看」可直接在 iTerm2 的标签页里交互连接该会话；也可以复制原来的 SSH + tmux attach 命令。
- 主任务与子代理分层展示，展开后按需读取子代理状态。

完整功能与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装

### 通过插件市场（推荐）

1. 打开 DSH 的 **插件** 页，进入 **发现** 标签。
2. 点 **添加索引源**，填入本插件所在市场的索引地址：

   ```text
   https://raw.githubusercontent.com/MuYiYong/dsh-marketplace/main/index.json
   ```

3. 在列表中找到 **Codex Agent**，点 **安装**。
4. 安装完成后在 **设置 → Codex Agent** 中添加要监控的服务器（名称 + SSH 别名或 `user@host`，端口可选；默认沿用 SSH 配置）。

从 Git 提交安装的副本，后续可以在 **发现** 页直接点 **更新**。

### 手动安装（高级）

```sh
git clone https://github.com/MuYiYong/dsh-remote-codex-agent.git
# 在 DSH 的 插件 → 添加插件 中选择该目录，或使用 profile 的安装入口
```

手动安装的副本不会出现在市场的「更新」流程里；需要自行拉取新提交。

## 使用前提

- 本机已配置 `~/.ssh/config`，并能用公钥免密登录远端服务器（插件以 `BatchMode=yes` 运行，不管理密码与私钥）。
- 远端已安装 `tmux`（建议 >= 3.1，用于 `pane_pipe` 判断）。
- 需要 Codex CLI 0.163.0+ 才能通过 OSC 7501 给出精确状态；更低版本显示 `unknown`。
- iTerm2 查看仅支持 macOS Desktop；需要已安装 iTerm2，首次使用可能需要授予“自动化”权限。

## 配置

打开 **设置 → Codex Agent**：

- 服务器列表右上角 **添加 Agent**。端口留空时沿用该目标的 SSH 配置，不强制 `22`。
- 展示天数：1–30，默认 3。
- 轮询间隔：默认 2 秒。

配置保存在 `$DSH_HOME/codex-agent/settings.json`，与安装方式无关。

## 数据来源与状态

- **连通性**：单次 SSH 检查失败会自动重试，连续两次失败才标为 SSH 不可达；已执行远端命令但采集未完成时保留最后一次完整结果。
- **会话发现**：优先只读查询 `${CODEX_HOME:-~/.codex}/state_5.sqlite` 的 `threads` 表；`sqlite3` 缺失时尝试 Python 标准库 sqlite3（无写入），最后回退解析 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 的 `session_meta`。
- **定位**：`tmux list-panes -a` 先按 `pane_title` 与会话标题/工作目录匹配，再按 `pane_pid` 进程树中的 `codex` 进程 cwd 匹配。
- **实时状态**：对已定位窗格 `tmux pipe-pane -Oo` 复制输出到远端 FIFO，Host 侧解析 OSC 7501；`blocked` 展示 `kind` 与解码后的消息。
- **日志回退**：没有 OSC 时每 5 秒做一次有界只读 rollout 检查，主任务与展开的子代理分别处理。
- **iTerm2 查看**：SSH 交互式连接该 tmux 会话；iTerm2 已运行时优先在最前面的普通窗口新开标签页（跳过 hotkey 窗口），否则新开窗口。不使用 `-d`，不会踢出其他客户端；tmux 3.2+ 用 `-f ignore-size` 避免改变其他客户端的窗口大小，旧版回退普通 attach。窗口/标签页打开只表示创建成功，SSH 登录结果以 iTerm2 输出为准。

## 目录结构

```
index.js              Host 插件入口：HTTP API、设置存储、监控生命周期
lib/monitor.js        轮询、定位、捕获与状态表
lib/ssh.js            ssh 子进程封装（超时、输出上限、长连接）
lib/remote-scripts.js 远端脚本拼装
lib/scripts/*.sh      在远端执行的 bash 程序
lib/discovery-parse.js 会话发现输出解析
lib/osc.js            OSC 7501 增量解析
lib/locate.js         pane 匹配
lib/commands.js       attach 命令拼装
lib/iterm.js          iTerm2 本机启动与参数校验
lib/settings-store.js 插件设置命名空间
client.js             浏览器半边：侧栏入口、主面板、设置卡片
```

## 开发

```sh
node --check index.js
node --check client.js
node --test test/*.test.mjs
```

Host 侧测试覆盖发现脚本（本地 sqlite + 假 tmux）、输出解析、OSC 解析、pane 匹配、命令拼装、设置校验、HTTP 路由和 iTerm2 参数；Client 测试用 VM 桩覆盖侧栏提示、共享轮询和查看交互。CI 在 Ubuntu 与 macOS 上运行同一套测试。

## 发布流程

1. 修改代码与测试，更新 `CHANGELOG.md`。
2. 更新 `package.json` 的 `version`（SemVer）。
3. 提交并推送，然后打标签：

   ```sh
   git add -A && git commit -m "release: v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```

4. 记录提交 SHA：`git rev-parse HEAD`。
5. 到 [dsh-marketplace](https://github.com/MuYiYong/dsh-marketplace) 仓库执行发布脚本并推送索引：

   ```sh
   node scripts/add-release.mjs \
     --name dsh-remote-codex-agent \
     --version 0.2.0 \
     --git-url https://github.com/MuYiYong/dsh-remote-codex-agent \
     --commit <完整 40 位 commit>
   npm test
   git add -A && git commit -m "release: dsh-remote-codex-agent 0.2.0"
   git push
   ```

DSH 的 **发现** 页刷新后会看到新版本；由市场安装（Git 提交固定）的副本可直接点 **更新**。

## 限制

- 状态通道依赖 tmux `pipe-pane`；同一窗格已有其他 pipe 时不会覆盖（`-o` 守卫），该会话保持 `unknown`。
- Codex CLI 低于 0.163.0 或未发出 OSC 7501 时状态为 `unknown`。
- 插件只监控既有 Codex 会话，不启动新会话。
- iTerm2 查看会与已有终端共享同一个 tmux 会话，输入会发送到该会话；请避免误输入或退出正在运行的任务。

## License

[MIT](LICENSE)
