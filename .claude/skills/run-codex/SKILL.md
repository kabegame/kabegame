---
name: run-codex
description: 用 codex CLI（OpenAI Codex，codex exec）把一个具体任务派给 codex 跑——代码分析、改代码、结构化提取、续跑会话。当需要 run/start/调用 codex、把任务交给 codex、delegate to codex、codex exec、让 codex 分析或修改本仓库代码时使用。
---

# 用 codex CLI 执行任务

`codex` 是本机安装的 OpenAI Codex CLI（`~/.local/bin/codex`，v0.144.1，standalone 安装）。
交互 TUI（直接敲 `codex`）对 agent 没用——它会占住终端等按键。**agent 一律走 `codex exec` 非交互模式**，
并且统一通过本 skill 的 driver 调用：

```
.claude/skills/run-codex/driver.mjs
```

driver 负责：拼 `codex exec` 参数、禁掉会刷屏的 MCP、关 stdin、流式打印进度、把最终答案单独落文件回显、超时兜底。
**本文所有路径相对仓库根 `/Volumes/KIOXIA/kabegame`。**

## 前置检查

无需安装任何东西。确认 codex 可用且已登录：

```bash
codex --version          # codex-cli 0.144.1
codex doctor 2>&1 | grep -A3 'auth '   # 期望 "auth is configured" + stored auth mode chatgpt
```

`doctor` 报 auth 未配置就停下来告诉用户去 `codex login`，不要试图代跑登录流程。

## 跑任务（agent 路径）

### 只读分析（默认，最常用）

```bash
node .claude/skills/run-codex/driver.mjs "看一眼 scripts/utils.ts，一句话说明 ROOT 和 THIRD_DIR 分别是怎么算出来的。"
```

默认 `--sandbox read-only`：codex 能读文件、跑 `rg`/`sed` 之类的命令，但改不了任何东西。

### 让 codex 真改代码

```bash
mkdir -p ignore/codex-smoke && cp .claude/skills/run-codex/examples/add.mjs ignore/codex-smoke/add.mjs
node .claude/skills/run-codex/driver.mjs --write "文件 ignore/codex-smoke/add.mjs 里的 add 函数写错了，它应该做加法。请直接修好它，并删掉那个 BUG 注释。只改这一个文件。"
git diff --no-index .claude/skills/run-codex/examples/add.mjs ignore/codex-smoke/add.mjs   # 看它到底改了什么
```

（`examples/add.mjs` 是个故意写错的靶子，用来验证写入链路通不通。真任务直接换成你的文件。）

`--write` → `--sandbox workspace-write`，codex 可以写工作目录内的文件（仓库外和网络仍被挡）。
**改完自己 `git diff` 核一遍**，别信最终消息的自述。

### 结构化输出（要机器可解析的结果时）

```bash
node .claude/skills/run-codex/driver.mjs --schema .claude/skills/run-codex/examples/schema.json --quiet \
  "分析 src-tauri/tauri-runtime-cef 这个 crate：component 填 crate 名，risk 填改动它的风险等级，files 填最核心的 2 个源文件路径。"
```

最终答案就是符合 schema 的裸 JSON，可以直接 `| jq`：

```json
{"component":"tauri-runtime-cef","risk":"high","files":["src-tauri/tauri-runtime-cef/src/runtime.rs","src-tauri/tauri-runtime-cef/src/webview.rs"]}
```

### 长任务描述放文件

```bash
node .claude/skills/run-codex/driver.mjs -f .claude/skills/run-codex/examples/task.md
```

比在 shell 里塞多行带反引号的字符串省心得多——**优先用这个**。

### 续跑会话（追问，省掉重新读上下文）

```bash
node .claude/skills/run-codex/driver.mjs --resume last --quiet "刚才那个 crate，再补一句：它主要面向哪几个平台？"
```

`--resume <session-id>` 也行，id 来自上一次输出的 `[driver] session=...`。**优先用 id，别用 `last`**，
理由见下面 Gotchas 里 `--ephemeral` 那条。

### 一次性查询（不污染 ~/.codex）

```bash
node .claude/skills/run-codex/driver.mjs --ephemeral --quiet "回答：本仓库根目录下 Cargo.toml 的 workspace members 有几个？只给数字。"
```

`--ephemeral` 让 codex 不把会话 rollout 落到 `~/.codex/sessions`（那儿已经堆了 414M / 200+ 个会话）。
代价是这次会话之后**不能被 resume**。

### 全部选项

```bash
node .claude/skills/run-codex/driver.mjs --help
```

`--write` / `--full` / `-m <模型>` / `--schema <file>` / `--resume <id|last>` / `-C <目录>` /
`-f <prompt文件>` / `--timeout <秒>`（默认 900）/ `--ephemeral` / `--mcp` / `--quiet`。

### 产物

每次跑都落在 `ignore/codex-runs/<时间戳>/`（`ignore/` 已被 gitignore）：

- `last-message.txt` — 最终答案（driver 也会打到 stdout）
- `events.jsonl` — 完整事件流，codex 跑过的每条命令、每次改文件都在里面。**任务结果可疑时查这个。**
- `meta.json` — 实际用的 argv

## 人类路径

直接敲 `codex` 进 TUI。agent 别用：它要 tty，会挂住。

## 坑（都是这次实跑踩出来的）

- **失败也返回 exit 0。** read-only 沙箱下让它建文件，codex 只是在最终消息里说"被拒绝"，进程照样 exit 0。
  **不能用退出码判断任务成没成**——读最终答案，改代码类任务一律 `git diff` 复核。
- **`--ephemeral` + `--resume last` = 静默续错会话。** ephemeral 那次不落 rollout，`--resume last`
  于是挑中**更早的另一个会话**——不报错，照样跑，答的是上一个任务的问题。实测撞到过。
  要续跑就别 ephemeral；要 `last` 就确认上一次没 ephemeral；**最稳的是显式传 session id**。
- **`--resume` 不吃 `--sandbox` / `-C` / `--color`。** 传了直接 usage error 退出 2。这是设计如此：
  [官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)明确 resume 复用原会话的设置（沙箱、模型、工作目录都继承）——
  原会话是 read-only，续跑就也是 read-only，想换只能开新会话。resume 只接受 `--json` / `-o` / `-m` / `-c` / `--output-schema`。
  driver 已按子命令分别拼参数。
- **`~/.codex/config.toml` 里配了 MCP server `kabegame`（`http://127.0.0.1:7490/mcp`）**，kabegame 应用没跑时
  每几秒刷一条 `ERROR rmcp::transport::worker: ... HTTP 502`，把输出淹了。driver 默认加
  `-c 'mcp_servers.kabegame.enabled=false'` 禁掉——`enabled` 是
  [官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)里 `mcp_servers` 条目的正式字段
  （"Set `false` to disable a server without deleting it"），driver 只是用 `-c` 按次覆盖，不动你的 config.toml。
  要用 MCP（应用正跑着）加 `--mcp`。注意 **`-c 'mcp_servers={}'` 没用**——试过，照样刷 502，必须点名到 server。
  （想永久禁用可以在 config.toml 的 `[mcp_servers.kabegame]` 下写 `enabled = false`，或者放进项目级
  `.codex/config.toml`；但那样应用真跑起来时也用不上 MCP 了，所以 driver 不这么干。目前没有
  `codex mcp disable` 子命令，[还是个 open issue](https://github.com/openai/codex/issues/16439)。）
- **stdin 必须给 `/dev/null`。** 非 tty 下 codex 会把 stdin 当追加输入读（打印 `Reading additional input from stdin...`），
  管道不关就一直等。driver 已经处理了。那行提示是 stderr 噪音，忽略即可。
- **codex 遵守本仓库的 `AGENTS.md`**，每次开工会先读 `cocs/README.md` 和 `.cursor/rules/`，
  最终消息带"工作总结/工作评价"段落——不是 driver 加的。这也意味着**每个新会话有 ~30-50k input token 的固定开销**；
  连续追问用 `--resume` 能吃到缓存（cached_input_tokens 会明显上升）。
- **不快。** 一个简单只读问题 25-40 秒，改代码类 1 分钟以上。别用它做 `grep` 能解决的事。
- 模型默认取 `~/.codex/config.toml` 的 `model`（当前 `gpt-5.6-sol`，reasoning effort high），driver 不写死。

## 排障

| 症状 | 原因 / 处理 |
|---|---|
| `error: unexpected argument '--sandbox'` + `Usage: codex exec resume ...` | resume 不支持这些全局 flag，见上。 |
| 输出被 `ERROR rmcp::transport::worker ... HTTP 502` 刷屏 | MCP server 连不上，driver 默认已禁；你手搓 `codex exec` 才会遇到。 |
| 挂住不动、只打印 `Reading additional input from stdin...` | stdin 没关，`< /dev/null`。 |
| `error=patch rejected: writing is blocked by read-only sandbox` | 忘了加 `--write`。 |
| 最终答案是 `(codex 没有产出最终消息...)` | codex 非正常退出，看同目录 `events.jsonl` 和上面的 stderr。 |
| driver 退出码 124 | 撞上 `--timeout`（默认 900s），已 SIGKILL；加 `--timeout 1800` 或把任务拆小。 |
| `--resume last` 答的是别的任务 | 上一次跑带了 `--ephemeral`，没落盘，`last` 挑中了更早的会话。用显式 session id。 |
| `Error: thread/resume: ... no rollout found for thread id <id>` + exit 1 | session id 打错，或那次是 `--ephemeral` 跑的没落盘。`ls -t ~/.codex/sessions` 找真实 id。 |
