---
name: run-sonnet
description: 把前端任务外包给便宜的 sonnet 子进程跑（claude -p --model sonnet），省下当前 opus 会话的 token 与额度——Vue/TS/样式/i18n 的分析与改写、结构化提取、续跑会话。当需要省 token/省钱地跑一个前端任务、run/start/调用 claude、delegate to sonnet、claude -p、让 sonnet 改前端代码时使用。后端 Rust 任务请用 run-codex。
---

# 把前端任务外包给 sonnet

**这个 skill 的目的是省钱，不是"用 claude"。** 当前主会话跑的是 opus；机械、重复、要读一堆文件才能下手的
前端活（批量替换、按既定方案改一批 `.vue`、结构化提取、跑一遍再报告），交给 sonnet 子进程做，
主会话只花 token 在决策与复核上。名字里的 `sonnet` 就是这个约束：**换成 opus 跑就失去了用它的理由**
（`-m` 能改，但那时不如直接在主会话里做）。

配套的分工约定：**前端（Vue / TS / UnoCSS / i18n JSON）派给 sonnet，后端（Rust / Tauri / 构建脚本）派给 codex。**
本 skill 是前一半；后一半见 [run-codex](../run-codex/SKILL.md)。

省 token 的前提是**任务描述本身要写清楚**——把方案、靶文件、验收标准一次性写进 prompt（长的用 `-f`），
让它一趟做完；来回追问会把省下的钱又烧回去。反过来，`grep`/`ls` 一条命令能得到的答案别派给它（见 Gotchas）。

`claude` 是本机的 Claude Code CLI（`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.220`）。
交互模式对 agent 没用（占住终端等按键），**一律走 `claude -p` 非交互模式**，并统一通过本 skill 的 driver 调用：

```
.claude/skills/run-sonnet/driver.mjs
```

driver 负责：钉死 `--model sonnet`、注入前端作用域约束、拼 `-p --output-format stream-json --verbose`、
关 stdin、流式打印进度、最终答案落文件回显、把 `--resume last` 补上（CLI 本身没有）、
分辨"写入被拒"和"Bash 被拒"、超时兜底、额度告警、打印每跑一次的实际 token 与 $。
**本文所有路径相对仓库根 `/Volumes/KIOXIA/kabegame`。**

## 前置检查

无需安装任何东西：

```bash
claude --version                 # 2.1.220 (Claude Code)
claude -p --model sonnet "只回答一个词：ping" < /dev/null   # → pong
```

上面第二条报鉴权失败就停下来告诉用户去 `claude auth` / `claude setup-token`，不要代跑登录。

## 跑任务（agent 路径）

### 只读分析（默认，最常用）

```bash
node .claude/skills/run-sonnet/driver.mjs "看一眼 apps/kabegame/src/views/Albums.vue，一句话说明它的顶层布局用了哪几个组件。"
```

默认不带 `--write`：`Edit`/`Write` 会被权限层拒掉，`Read`/`Grep`/`Glob` 和只读的 `Bash` 照常能跑。
**注意这不是沙箱**，只是权限分类器，详见 Gotchas。

### 让 sonnet 真改前端代码

```bash
mkdir -p ignore/sonnet-smoke && cp .claude/skills/run-sonnet/examples/Counter.vue ignore/sonnet-smoke/
node .claude/skills/run-sonnet/driver.mjs --write "ignore/sonnet-smoke/Counter.vue 里的 doubled 算错了，应该是 count * 2。修好它并删掉 BUG 注释。"
git diff --no-index .claude/skills/run-sonnet/examples/Counter.vue ignore/sonnet-smoke/Counter.vue
```

（`examples/Counter.vue` 是个故意写错的靶子，验证写入链路通不通。真任务直接换成你的文件。）

`--write` → `--permission-mode acceptEdits`。**改完自己 `git diff` 核一遍**，别信最终消息的自述。

### 前后端分工

driver 默认 `--scope fe`，会追加一段系统提示：只碰 Vue/TS/样式/i18n，**按文件类型**挡掉 `*.rs` /
`Cargo.toml` / `*.kt` / `build.rs` / `scripts/` / `third/` / `src-tauri*/`，并要求把后端部分写成交接清单。
实测（同时给它一个 `.vue` 和一个 `.rs` 靶子，两个都是同一个 `+2` → `*2` 的 bug）：

```
  · Counter.vue 是前端文件,我来修;backend_target.rs 是 `.rs` 文件,按规则我不动它。
  ± Edit: .../ignore/sonnet-smoke/Counter.vue
```

最终答案里自动带上：

```
**需要后端配合**
- 文件:`ignore/sonnet-smoke/backend_target.rs`
- 改动:第 3 行 `count + 2` → `count * 2`,并删除同行 BUG 注释
```

这段直接喂给 codex 就完成闭环：

```bash
node .claude/skills/run-codex/driver.mjs --write --quiet "把 ignore/sonnet-smoke/backend_target.rs 里的 count + 2 改成 count * 2，并删掉那行 BUG 注释。只改这一个文件。"
```

想让 sonnet 也做后端（不推荐，这是 codex 的活）：`--scope be`；完全不加约束：`--scope none`。

### 结构化输出（要机器可解析的结果时）

```bash
node .claude/skills/run-sonnet/driver.mjs --schema .claude/skills/run-sonnet/examples/schema.json --quiet \
  "分析 apps/kabegame/src/views/Albums.vue：view 填文件名，components 填它直接用到的自定义组件名，usesPinia 填它是否用了 pinia store。"
```

最终答案是符合 schema 的裸 JSON，可直接 `| jq`：

```json
{"view":"Albums.vue","components":["AlbumsPageHeader","AlbumCard","ActionRenderer","AlbumPickerField"],"usesPinia":true}
```

### 长任务描述放文件

```bash
node .claude/skills/run-sonnet/driver.mjs -f .claude/skills/run-sonnet/examples/task.md
```

比在 shell 里塞多行带反引号的字符串省心得多——**优先用这个**。

### 续跑会话（追问，省掉重新读文件）

```bash
node .claude/skills/run-sonnet/driver.mjs --resume last --quiet "刚才那个组件，再补一句：它的网格用了什么 CSS 布局？"
```

`--resume <session-id>` 也行，id 来自上一次输出的 `[driver] session=...`。
`last` 是 driver 自己实现的（读 `ignore/sonnet-runs/*/session.txt` 挑最新），**不是 CLI 功能**——
`claude -r` 不带值在非 tty 下只会开一个没人能操作的 picker。

### 一次性查询（不落会话）

```bash
node .claude/skills/run-sonnet/driver.mjs --ephemeral --quiet "回答：apps/kabegame/src/views/ 下有几个 .vue 文件？只给数字。"
```

`--ephemeral` → `--no-session-persistence`，之后**不能** resume（实测直接 `-r` 会 `No conversation found` + exit 1）。
driver 对 ephemeral 跑不写 `session.txt`，所以 `--resume last` 会自动跳过它挑上一个真会话。

### 全部选项

```bash
node .claude/skills/run-sonnet/driver.mjs --help
```

`--write` / `--full` / `-m <模型>`（默认 `sonnet`，**改成 opus 就没有省钱意义了**）/ `--scope fe|be|none`（默认 `fe`）/ `--effort <级别>` /
`--schema <file>` / `--resume <id|last>` / `-C <目录>` / `-f <prompt文件>` / `--timeout <秒>`（默认 900）/
`--ephemeral` / `--no-mcp` / `--quiet`。

退出码：`0` 正常 · `3` 有写入类工具被权限拒绝（多半忘了 `--write`）· `124` 超时 · 其余透传 claude。

### 产物

每次跑都落在 `ignore/sonnet-runs/<时间戳>/`（`.gitignore:81` 已忽略整个 `/ignore`）：

- `last-message.txt` — 最终答案（driver 也会打到 stdout）
- `events.jsonl` — 完整事件流，每次工具调用的完整入参都在里面。**结果可疑时查这个。**
- `session.txt` — 会话 id（ephemeral 跑不写）
- `meta.json` — 实际用的 argv

## 人类路径

直接敲 `claude` 进交互 TUI。agent 别用：要 tty，会挂住。

## 坑（都是这次实跑踩出来的）

- **失败也返回 exit 0。** 忘了 `--write` 时，claude 只是在最终消息里说"看起来我没有获得写入该文件的权限"，
  进程照样 exit 0，文件一个字没动。**不能只看退出码**——driver 为此额外解析 `permission_denials`
  并在写入被拒时返回 3，改代码类任务仍然一律 `git diff` 复核。
- **默认权限模式不是只读沙箱。** 它是个分类器：`Read`/`Grep` 直接过，只读 `Bash`（`find`/`ls`）也直接过，
  写入类的 `Edit`/`Write` 和 `sed -i` 之类才被拦。实测让它"用 Bash 的 sed 改文件"会被拒，
  但**不要把它当 codex 的 `--sandbox read-only` 那种硬隔离用**——没有进程级隔离。
- **`--output-format stream-json` 必须配 `--verbose`**，否则直接
  `Error: When using --print, --output-format=stream-json requires --verbose`。
- **千万别 `2>&1 | jq`。** claude 的报错（`No conversation found ...`）走 stderr 且不是 JSON，
  混进事件流会让 `jq` 报 `parse error: Invalid numeric literal`。driver 把 stderr 原样透传，stdout 只走 JSON。
- **会话按目录隔离。** session 存在 `~/.claude/projects/<目录 slug>/`，换个 cwd 再 `-r <同一个 id>` 就是
  `No conversation found with session ID: ...` + exit 1。resume 必须在同一个 `-C` 目录下跑。
- **resume 不继承上次的权限模式。** 和 codex 相反：codex 的 `exec resume` 继承原会话沙箱且拒收
  `--sandbox`，claude 的 `-r` 每次都吃全新的 `--permission-mode` / `--model`（实测续跑一个
  `acceptEdits` 会话，init 事件里 `permissionMode` 回到 `default`）。要接着改代码就得再传一次 `--write`。
- **便宜是相对主会话说的，绝对值不便宜，而且吃的是同一份订阅额度。** 每个新会话都要重新灌本仓库的
  `CLAUDE.md` + `cocs/README.md` + memory + skill 列表，固定 ~33–60k 的 cache write，所以哪怕一个
  简单只读问题也要 $0.22–0.32，带 schema 的 $0.50——**每跑一次就先付一次这个开场费**。
  由此得到用法：**一次派一个够大的活**（一整批文件、一个完整批次），别拆成十次小问答；
  `grep` / `ls` 能解决的绝不派；追问用 `--resume`（复用上下文）而不是重开一次。
  driver 每跑完打印实际 `tokens ... cost=$...`，额度告警也始终打印：
  `[driver] 额度 seven_day=80% (allowed_warning)`。
- **不快。** 简单只读问题 9–16 秒，改代码类 18–28 秒。省的是 token 不是时间。
- **嵌套调用没有递归保护。** 在 Claude Code 会话里跑 `claude -p` 完全正常（本 skill 就是这么验的），
  但它会加载同一套 CLAUDE.md / skills / MCP，**包括本 skill 自己**——别写出让子 sonnet 再派一层 sonnet
  的任务描述（那等于再付一次开场费）。
- **MCP 默认照常加载**（本机是 `claude.ai Google Drive`，状态 `needs-auth`）。实测对启动耗时没有可测影响
  （7.2s vs 8.1s），所以 driver 不默认禁；确实要干净环境加 `--no-mcp`（`--strict-mcp-config`）。

## 排障

| 症状 | 原因 / 处理 |
|---|---|
| `Error: When using --print, --output-format=stream-json requires --verbose` | 手搓 CLI 漏了 `--verbose`，driver 已带。 |
| `jq: parse error: Invalid numeric literal at line 1, column 3` | 你把 stderr 用 `2>&1` 混进了 JSON 流。分开重定向。 |
| `No conversation found with session ID: <id>` + exit 1 | cwd 不对（会话按目录隔离），或那次是 `--ephemeral` 跑的。`ls -t ignore/sonnet-runs/*/session.txt` 找真实 id。 |
| driver 退出码 3 + `写入被拒` | 忘了 `--write`。 |
| 最终答案说"没有获得写入权限"但 exit 0 | 同上；靠 driver 的 exit 3 或 `git diff` 判断，别信退出码。 |
| `[driver] --resume last 找不到历史会话` | `ignore/sonnet-runs/` 下还没有非 ephemeral 的跑。 |
| 被拒的是 `Bash` 但任务其实做完了 | 正常：分类器挡掉某条命令（实测挡过 `find ... \| xargs`），claude 换个写法就过了。driver 只提示不改退出码。 |
| driver 退出码 124 | 撞上 `--timeout`（默认 900s），已 SIGKILL；加 `--timeout 1800` 或把任务拆小。 |
| 最终答案是 `(claude 没有产出最终消息...)` | claude 非正常退出，看同目录 `events.jsonl` 和上面的 stderr。 |
| 改前端时它顺手把 `.rs` 也改了 | `--scope` 被设成了 `none`/`be`；默认 `fe` 会按文件类型挡住。 |
