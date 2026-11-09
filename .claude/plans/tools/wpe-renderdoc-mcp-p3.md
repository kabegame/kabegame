# wpe-renderdoc MCP 第 3 批：抓帧、组合工具与文档

> 总计划：[wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md) 步骤 3、步骤 4。第 1 批（读 rdc）`28347646`、第 2 批（常驻 WPE、自己的窗口、配置、日志）`2a0778e7` 已提交。本批做完，抓 WPE 真值就不再需要旧 skill。

## 总体设计思路

抓帧要连 RenderDoc 注入在 WPE 里的目标（Target Control），而这个连接是独占的：别的客户端连着时，不抢占的连接会被直接拒绝；抢占（`force=True`）会把对方踢掉（总计划步骤 0 的实测记录三）。所以：
- 连目标一律不抢占；
- 机器级的抓帧锁 `target.lock` 保证同一时刻只有一个 MCP 在连。锁只覆盖「连接 → 选中自己的窗口 → 触发 → 收文件 → 断开」这几秒，回放分析不在锁里。

**连接放在哪：** 放在各会话自己的回放工作进程里。它本来就是 `qrenderdoc --python`，`renderdoc` 模块的 Target Control API 只能在这里用。这样不用每次抓帧都临时起一个 qrenderdoc。工作进程处理抓帧请求时，同一会话的回放请求排在后面，这是可以接受的。

**选窗口：** RenderDoc 一次只抓「活动窗口」，活动窗口是目标进程里各会话共享的状态：第一个注册的窗口默认活动，`CycleActiveWindow` 轮到下一个，跨连接保留。抓帧消息（`NewCapture`）的缩略图尺寸就是后备缓冲尺寸，第 2 批又保证同一时刻没有同尺寸的测试窗口。于是：
- 可抓窗口只有一个：直接抓 N 帧；
- 多于一个：先抓 1 帧探测，缩略图尺寸不是自己窗口的，就删掉探测文件、切换一次、再探，最多探一轮；认出来以后再抓 N 帧。
- 每一张抓帧都核对缩略图尺寸，混进别人窗口的帧就报错，不静默收下。
- 缩略图对大尺寸可能被缩小，本批先实测；缩小了就改按宽高比认，并用回放核对。

**组合工具：** 把一次对照抓帧的整条流程做成一步：
- `capture_wallpaper`：确保在跑 → 开自己的窗口 → 等场景加载 → 记日志游标 → 抓帧 → 关窗 → 截日志 → 在自己的回放进程里打开第一张；
- `capture_sweep`：一组「工程 × 帧数 × 设置」依次跑完，替代 `ignore/p4/sweep_b.py`。要改设置时走第 2 批的 `restart_wpe`，同样要求没有别的会话的窗口。

**文档：** 写 MCP 的用法；旧 skill 只在开头加一句指向新 MCP，正文不动，完全迁移另定。

## 现状锚点

**a. 选窗口与不抢占的实验版**（`ignore/wpe-mcp/exp/target2.py`）
```python
class Session:
    def __init__(self, ident, force):
        self.target = rd.CreateTargetControl('', ident, params.get('client', CLIENT), force)  # 现状：force 由参数给，默认 False
    def handle(self, msg):
        ...
        elif kind == rd.TargetControlMessageType.NewCapture:
            cap = msg.newCapture
            self.captures.append({..., 'thumb': [getattr(cap, 'thumbWidth', None), getattr(cap, 'thumbHeight', None)]})
def capture():
    for _ in range(params.get('cycle', 0)):
        session.target.CycleActiveWindow()          # 现状：切换次数由调用方给，不会自己认窗口
    session.target.TriggerCapture(frames)
```

**b. 旧 skill 的抓帧与核对**（`.claude/skills/wpe-renderdoc/driver.py:184`、`target.py:inspect`）
```python
    for cap in sorted(result.get('captures', []), key=lambda c: c['frame']):
        target = os.path.join(out, f'{tag}-frame{cap["frame"]}.rdc')
        shutil.move(cap['path'], target)                 # 现状：A:\_rdtemp 落盘后移到 --out
    gaps = [b - a for a, b in zip(frames, frames[1:]) if b - a != 1]
    check = in_renderdoc('inspect', 120, path=saved[0]['path'])   # 现状：回放第一张报绘制数与后备缓冲尺寸
```

**c. 第 2 批已有的**（`.claude/mcps/wpe-renderdoc/mcp_server/`）：
- `ensure_running`、`open_wallpaper`、`close_wallpaper`、窗口表与表锁（`wpe/registry.py`，`msvcrt.locking`）、`restart_wpe`、`log_mark` / `log_since`；
- 注入时的抓帧模板 `paths.capture_template()`（`A:\_rdtemp\wallpaper64`）；
- 回放工作进程 `renderdoc_worker/worker.py`，一次处理一个请求。

**d. 要替代的扫描脚本**（`ignore/p4/sweep_b.py`）：
- 用法：`sweep_b.py <fps[,键=值…]> <工程[:帧数[:尺寸]]>… [-- …]`；
- 每个工程开窗、等 12 s、抓帧到 `A:\p4b\<工程>-fps<fps>`，日志写 `out/<tag>-log.txt`（`[kbp]` 行）和 `out/<tag>-errors.txt`。

## 点 1 — 工作进程里的抓帧控制（`renderdoc_worker/target.py`、`request_handler.py`）

- **新增** `target.py`，照 `target2.py` 改写成常驻进程里的函数（连接用完即断，不长期占着）：
  - `target_find(pid, timeout)`：`EnumerateRemoteTargets` 按 PID 找目标号；
  - `target_status(ident)`：API、是否在呈现、可抓窗口数；
  - `target_capture(ident, frames, expect_size, timeout, client)`：
    - 不抢占连接，被拒就回「目标被别的客户端连着」（拿得到对方名字时带上）；
    - 可抓窗口为 1 时直接触发；
    - 大于 1 时探测：触发 1 帧 → 等 `NewCapture` → 看缩略图尺寸 → 不对就删文件、`CycleActiveWindow` → 最多「窗口数」次；
    - 触发 N 帧，逐张核对缩略图尺寸；
    - 回 `captures`（路径、帧号、字节、缩略图尺寸）、`probes`（每次探测抓到的尺寸、删了没有）、`windows`、`apis`。
  - `inspect(path)`：另开一个 `OpenCaptureFile` 回放，报绘制数、绘制尺寸、后备缓冲尺寸。不动当前打开的抓帧。
- **修改** `request_handler.py`：注册以上四个方法。

## 点 2 — 抓帧工具（`mcp_server/wpe/capture.py`、`server.py`）

- **新增** `target.lock`：放在 `registry.py` 里，同表锁的写法；持有进程死了自动放开。
- **新增** `capture(window, out, frames=3, tag=None, timeout=60, overwrite=False)`：
  1. 窗口必须是本会话的、且还在；期望尺寸取窗口表里的尺寸。
  2. 确认 WPE 已注入。目标号按 PID 找，缓存到 WPE 的 PID 变了为止。
  3. 拿 `target.lock`（等锁超时就报出是哪个 MCP 拿着），调工作进程的 `target_capture`。
  4. 文件从模板目录移到 `out`，命名 `<tag>-frame<帧号>.rdc`，`tag` 缺省取 `out` 的末级目录名。
     - 目标已存在且没给 `overwrite`：拒绝，探测文件也删掉；
     - 移动在锁内完成，模板目录里不留本次的文件。
  5. 放锁。锁外：
     - 核对帧号连续（`gaps`）；
     - 回放第一张核对后备缓冲尺寸等于窗口尺寸、报绘制数。
  6. 结果报：文件清单、`gaps`、第一张核对、等锁时间、探测次数与探测到的尺寸、可抓窗口数。
- `out` 必须给，约定 `A:\<项目>\<用途>\`。不设缺省目录，不接受仓库内的路径。

## 点 3 — 组合工具

- **新增** `capture_wallpaper(project, out, frames=3, size="1280x720", wait=8, tag=None, log_grep=None, open_first=True)`：
  1. `ensure_running`；`open_wallpaper` 开自己的窗口；
  2. 等 `wait` 秒让场景加载；
  3. 记日志游标，`capture`，再关窗；
  4. `log_since(游标, grep=log_grep)`，返回日志行；
  5. `open_first` 时在本会话回放进程里 `open_capture` 第一张，之后可以直接调回放工具。
  - 中途出错也要关掉自己开的窗口。
- **新增** `capture_sweep(jobs, out_root, log_dir=None)`：
  - `jobs`：`[{project, frames, size?, wait?, settings?, tag?}]`。
  - 按 `settings` 分组，相同的连在一起。
    - 组前需要改设置，就调 `restart_wpe(settings)`（规则同第 2 批：有别的会话的窗口、外来窗口或设置界面开着就拒绝，整次扫描停下报告）。
    - 全部跑完后，若改过设置，再 `restart_wpe` 改回扫描开始时的值。
  - 每个 job 跑一次 `capture_wallpaper`，抓帧放 `out_root\<tag>`。
  - `log_dir` 给了就照 `sweep_b.py` 写 `<tag>-log.txt`（`[kbp]` 行）和 `<tag>-errors.txt`。
  - 结果逐 job 报文件、`gaps`、日志行数、报错行数。

## 点 4 — 说明与文档（总计划步骤 4）

- **修改** MCP 的 `instructions`：抓帧工具已有；抓帧锁、选窗口、同尺寸的规则；`out` 的约定；不再需要旧 skill。
- **修改** `.claude/mcps/wpe-renderdoc/README.md` 加用法：
  - 工具表与典型工作流（`capture_wallpaper` → 回放工具）；
  - 常驻与并发规则（不关不杀、窗口归属、同尺寸、陈旧窗口、抓帧锁）；
  - 「设置不还原、只报改动」的约定；
  - 从旧 skill 带过来、仍成立的坑：帧号换壁纸后重新计数、被抓的帧本身是长帧、`pause` 只管桌面、窗口左上角有叠加文字、桌面壁纸被重建后可能被挂上。
- **修改** `.claude/skills/wpe-renderdoc/SKILL.md`：只在开头加一句「抓 WPE 用新的 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`）；完全迁移前本 skill 保留」。正文和 `driver.py`、`target.py` 不动。
- **修改** `AGENTS.md`「单体仓库布局」加一行 `.claude/mcps/`。
- **修改** `cocs/wpe/WPE_SCENE.md` 里提到 `wpe-renderdoc` skill 的地方，补一句新 MCP。

## 验收

脚本和输出放 `ignore/wpe-mcp/p3/`，带断言，失败返回非 0。全程开观察器（`ignore/wpe-mcp/exp/exp.py watch`）。抓帧放 `A:\wpe-mcp\p3\<用途>\`。

1. **基本抓帧：** 开 1280×720 窗口抓 3 帧：帧号连续、缩略图与回放都是 1280×720、文件命名正确、模板目录没留下本次的文件；`overwrite=False` 时目标已存在被拒。
2. **缩略图尺寸：** 再抓 1920×1080 和 3840×2160 两个窗口，看缩略图是不是原尺寸。缩小了的话，按宽高比 + 回放核对的路径要能认对。
3. **多窗口选窗：** 同一 MCP 开两个不同尺寸的窗口，各抓 3 次。每次都抓到要的那个；记下探测次数；探测文件都删掉了。
4. **并发：**
   - 两个 MCP 各开一个尺寸不同的窗口，交错与同时各抓 10 次；
   - 每次都是自己的窗口（缩略图与回放尺寸），没有一方被踢；
   - 记下等锁时间、探测次数；用带 `[kbp]` 帧时间的测试工程，看探测给对方 dt 带来的尖峰。
5. **外部客户端占着目标：** 用 `exp.py rd hold`（`target2.py` 不抢占地连上占住 20 s）模拟。`capture` 报「目标被别的客户端连着」，没有踢掉对方（对方 hold 正常结束）。
6. **P4c 真实流程：**
   - `capture_wallpaper` 抓 `ignore/p4/proj/p4c-trail`；
   - 用 `get_mesh_data` 读 `gs_out`，按 `ignore/p4/ana_c_render.py` 的办法（`ignore/wpe-mcp/p1/rdc_track_b_mcp.py` 可参考）算四角；
   - 和预测比，最大误差与 `ana_c_render.py` 对旧抓帧的结论同一量级。
7. **`capture_sweep`：**
   - 跑 `p4c-attract` 的 fps 60 和 fps 10，各 3 帧；会经 `restart_wpe` 改 fps 再改回 20；
   - 日志行数、帧号连续性和 `ignore/p4/out/p4c-attract-fps60-log.txt` / `-fps10-log.txt` 当时的输出同一形态；
   - 最后 `config.json` 与开工前逐字节相同。
8. **不弹 WPE 主窗口：** 观察器里没有 `wallpaperui`、安全启动提示等 WPE 主窗口；测试窗口占前台可以，单独列出。
9. **终态：**
   - WPE 在跑、已注入、原壁纸在，没有测试窗口，窗口表为空；
   - 模板目录 `A:\_rdtemp` 没有本次留下的文件；
   - `config.json` 与开工前相同。
10. **范围：** `git status` 只有 `.claude/mcps/wpe-renderdoc/`、本阶段计划、`AGENTS.md`、`cocs/wpe/WPE_SCENE.md`、旧 `SKILL.md` 开头一句。

## 不做

- **Q6 剩下的部分：** 窗口移到屏幕外或被遮住时还画不画。用户已接受测试窗口占前台、盖在屏幕上。
- **Q13：** 桌面壁纸被重建后桌面设备被挂上。要换一次用户的桌面壁纸才能测，以后遇到再说；选窗口的逻辑本来就能认出桌面那个交换链（尺寸不同）。
- **完全迁移：** 删旧 skill、删旧 MCP、改写 `sweep_b.py`。

## 约束（给实施方）

- **WPE 是共享的：**
  - 会让 WPE 退出的步骤（`restart_wpe`、扫描里的改设置）之前，先跑 `ignore/wpe-mcp/p2/guard.py`。有不属于本测试的窗口或表项，就停下来报告，不要继续。
  - 只开本测试的窗口。
- **不强杀 WPE。**
- **配置只改 fps**，最后改回 20。
- **不碰用户的 RenderDoc：**
  - 连目标一律不抢占；
  - 不碰用户开着的 RenderDoc 界面（PID 24528、237204）和旧的 `renderdoc` MCP；
  - 只结束自己起的进程，结束前核对 PID 和命令行。
- **抓帧：**
  - 只写 `A:\wpe-mcp\p3\` 和 `A:\_rdtemp\`；
  - 不删 A 盘上别的东西；
  - 删探测文件前核对它是本次 `NewCapture` 报的路径。
- **Python：** 脚本一律落文件，用 `python -X utf8 -I <脚本>` 跑；新工程里用 `uv run`。不要 `python -c`、`python -`。
- **其他：** 不要 `deno install`；不 `git add` / commit；注释用中文。
- **汇报：**
  - 改了哪些文件；
  - 每条验收的证据；
  - 和本计划不同的地方及原因；
  - 全程对 WPE 做过的操作清单（带时刻）与最终状态；
  - 没做完的。

## 实施记录

2026-11-10 00:05–00:50，子代理实施。点 1–4 做完，验收 1–10 都过。脚本与输出在 `ignore/wpe-mcp/p3/`（`out/*.txt`、`out/*.json`；最终回归在 `out/final/`），观察器记录 `watch/watch-all.ndjson`（00:16:49 起，覆盖全部碰 WPE 的步骤），对 WPE 的操作逐条记在 `out/wpe-ops.txt`。抓帧在 `A:\wpe-mcp\p3\`（351 张、204 MB）。

### 做了什么

- **点 1：** 新增 `renderdoc_worker/target.py`（`target_find`、`target_status`、`target_capture`、`inspect`），`request_handler.py` 注册 `target_find` / `target_status` / `target_capture` / `target_inspect`。
- **点 2：** 新增 `mcp_server/wpe/capture.py`；`registry.py` 加抓帧锁 `target_lock`（同表锁的写法，另写持有者 `target.holder.json`）；`paths.py` 加两个路径；`replay.py` 的 `call` 加单次请求超时。
- **点 3：** `capture_wallpaper`、`capture_sweep` 在 `capture.py`；`log.py` 加不截断的 `read_new`（扫描写日志文件用）。
- **点 4：** `server.py` 的 `instructions` 与三个新工具；`README.md` 加「用法」；旧 `SKILL.md` 开头加一句；`AGENTS.md` 单体仓库布局加 `.claude/mcps/`；`cocs/wpe/WPE_SCENE.md` 两处提到旧 skill 的地方各补一句。

### 和计划不同的地方

1. **期望尺寸取屏幕上的客户区。** 窗口加上标题栏后超出屏幕时系统会把它缩小：本机屏幕 3840×2160 物理像素，开 3840×2160 的窗口，客户区是 3840×2130，WPE 的交换链跟着客户区走（回放核对为 3840×2130）。按窗口表里的 3840×2160 认会把自己的窗口当成别人的。所以客户区和登记的尺寸不同时按客户区认，结果里带 `expect_note`。
2. **缩略图规则（验收 2 实测）：** 宽不超过 2048 时缩略图就是后备缓冲尺寸（1280×720、1920×1080 实测）；更宽时等比缩到宽 2048（3840×2130 → 2048×1136）。**第二轮更正：** 这条规则不完整，宽还要向下对齐到 8 的倍数（900×500 → 896×497），见文末「第二轮」。按这条规则预测每个窗口的缩略图；和别的窗口的预测撞了（实测：2048×1136 的窗口和 3840×2130 的窗口），探测时在工作进程里另开回放核对后备缓冲。竖长窗口（宽 ≤ 2048、高 > 2048）没测过，认作「可能」，同样交给回放。
3. **桌面尺寸只在「可抓窗口多于屏幕上的测试窗口」时才算作可能被抓到的。** 桌面设备正常不被挂上（注入前建好）。要是一直把桌面算进去，预测缩略图和桌面（3840×2160 → 2048×1152）相同的窗口，即宽超过 2048、宽高比 16:9 的窗口（比如 2560×1440），每次探测都得回放，白白拉长持锁时间。
4. **日志从开窗前截起**（`open_wallpaper` 的游标），不是计划写的「等待之后」。加载期的报错（着色器编译、JSON 解析）在开窗时打出，等待之后再记会漏掉；`sweep_b.py` 也是从开窗前截。另报 `capture_log_mark`（抓帧前的游标）。
5. **`out` 里已有同 tag 的抓帧时，抓之前就拒绝**（不触发抓帧、不占锁）。计划写的是「移动时目标已存在就拒绝」：真实抓帧里帧号总是往后走，撞不到同名，测不到；而且一个目录混两次的抓帧会坑 `rdc_track` 这类按目录读的脚本。移动时的检查也照计划做了（拒绝时一张都不移、本次的文件从模板目录删掉），用单测 `unit_move.py` 验。`overwrite=True` 时同名的替换、不同名的旧文件留着。
6. **认对了的那张探测也删掉**：它和后面的 N 帧不连续。
7. **连上后先「静置」，只认触发之后的新 captureId。** 步骤 0 的实验输出里，新连接一上来目标会把以前的抓帧重发一遍 `NewCapture`（`ignore/wpe-mcp/exp/work/target-capture-449380.json` 等里同一张 `frame426` 反复出现，旧 `target.py` 会把它当成新抓的）。本批文件都移走了，实测重发数（`backlog`）为 0，推测目标只重发文件还在的；照样防着。
8. **没有可抓窗口时目标不发 `CapturableWindowCount`**（实测），按 0 报，另带 `windows_reported`。
9. **目标被占时 `target_find` 不再重试。** 被拒的连接读不到进程号，重试 10 s 也没用；直接报对方名字。RenderDoc 报的客户端名会把 `-` 换成 `_`（`kabegame-wpe-renderdoc` → `kabegame_wpe_renderdoc`）。
10. **锁外回放核对不过时删掉本次移到 `out` 的文件并报错。** 变异检查（认窗口一律判为本窗口）里就是这一道兜住的。
11. **`status` 加了 `target` 参数**（连目标读 API 与可抓窗口数，要拿抓帧锁），结果里另报抓帧锁的持有者。计划没写，总计划的 `status` 有这两项。
12. **`capture_sweep` 的细节：** 没给的设置键取扫描开始时的值；和当前设置一样的那组排最前（省一次重启）；tag 缺省「工程名-键值…[-尺寸]」（`p4c-attract-fps60`，同 `sweep_b.py`）；tag 重复、`out_root\<tag>` 里已有抓帧、设置不合法时一开始就拒绝；单个 job 失败记下继续，改设置被拒就停下，`finally` 里改回。扫描里的 job 不打开抓帧。
13. **单次请求超时：** `capture` 给工作进程的超时是 `timeout + 150 s`，回放核对 300 s；不用全局的 120 s。
14. **抓帧锁持有者写在 `target.holder.json`**（msvcrt 锁住的字节读不了，另放一个文件）；等锁超时时读它、按进程是否还在报出。

### 验收证据

**1. 基本抓帧：过**（`acc1_basic.py`，`out/acc1.txt`；最终回归 `out/final/acc1_basic.txt`）。1280×720 的 shimmering_particles 抓 3 帧：`acc1-frame171…173.rdc`，帧号连续，缩略图三张都是 1280×720，回放第一张后备缓冲 `[[1280, 720]]`、1 个绘制 1200 索引；只有一个可抓窗口，没有探测；`template_leftover` 为空，`A:\_rdtemp` 与开工前一样是空的。持锁 0.75 s（连接 0.01 s、静置 0.4 s、抓 0.27 s）。同一个 `out` 再抓：报「已有 3 张 acc1-frame*.rdc，没给 overwrite，没有抓」，`out` 和模板目录都没多东西；`overwrite=True` 抓到 198–200。移动时的拒绝见 `unit_move.py`（`out/unit_move.txt`）：目标已存在、没给 overwrite 时一张都不移、本次的文件从模板目录删掉；overwrite 替换同名的；工作进程报的路径不在模板目录里不动它；`out` 在仓库里、太浅、和模板目录重叠、相对路径都拒绝。

**2. 缩略图尺寸：过**（`acc2_thumb.py`，`out/acc2.txt`；第 1、2 次因测试本身的期望写错失败，留在 `acc2-run1-failed.txt`、`acc2-run2-testbug.txt`）。

| 窗口（请求） | 客户区 / 后备缓冲 | 缩略图 | 认法 |
|---|---|---|---|
| 1920×1080 | 1920×1080 | 1920×1080 | 原尺寸 |
| 3840×2160 | 3840×2130 | 2048×1136 | 按规则缩小，锁外回放核对 |
| 3840×2160 与 1280×720 同时开 | 各自 | 2048×1136 / 1280×720 | 探测 1～2 次，都认对 |
| 2048×1136 与 3840×2160 同时开 | 2048×1136 / 3840×2130 | 都是 2048×1136 | 探测时回放核对后备缓冲，三次都认对，持锁 2.2–2.8 s |

**3. 多窗口选窗：过**（`acc3_multi.py`，`out/acc3.txt`）。同一 MCP 开 1280×720、800×800，交替各抓 3 次：每次 3 张缩略图与回放都是自己的尺寸，帧号连续；探测次数 `[1, 2, 2, 2, 2, 2]`（共 11 次：第一次活动窗口就是 1280×720，之后活动窗口总是上一次抓的那个）；探测文件都删了，模板目录不留。

**4. 并发：过**（`acc4_concurrent.py` + `acc4_dt.py`，`out/acc4*.txt`、`out/acc4-result.json`、`acc4-dt.json`；最终回归 `out/final/`）。两个 MCP 进程：A 开 `kbp3-a`（1280×720），B 开 `kbp3-b`（960×540）。这两个工程由 `make_proj.py` 从 p2 的 kbp2-log 生成，脚本每 50 帧打一行帧时间，前缀分别是 `[kbp-a]` / `[kbp-b]`，日志里能分清。
- 交错（每次之间停 2.5 s）与同时（两个线程不停地抓）各 10 次，两轮共 80 次全部成功：缩略图与回放都是自己的尺寸，没有 busy、没有被踢。
- 等锁：交错时 0（第一次 0.02 s）；同时抓时 0.3–1.0 s，正好是对方一次的持锁时间。持锁 0.88–1.08 s。
- 探测：除 A 的第一次（1 次）外每次 2 次。交错时每次抓帧的第一次探测都落在对方的窗口上。
- dt（fps 20，中位 50 ms）：两轮都没有超过 2.5 倍中位数的尖峰。分时段的最大 dt：

| 轮 | 窗口 | 自己被抓时 | 对方抓帧（探测落在自己窗口上）时 | 同时抓 | 空闲 |
|---|---|---|---|---|---|
| 第一轮 | A | 77.0 ms | 53.6 ms | 79.1 ms | 53.9 ms |
| | B | 52.7 ms | 66.5 ms | 65.8 ms | 52.4 ms |
| 最终回归 | A | 92.2 ms | 57.0 ms | 71.2 ms | 53.6 ms |
| | B | 78.9 ms | 62.8 ms | 57.9 ms | 53.9 ms |

  对方的探测在本窗口上带来的尖峰最多 +17 ms。fps 20 下帧率限制把大部分开销吸收了，fps 高时会更明显。

**5. 外部客户端占着目标：过**（`acc5_busy.py`，`out/acc5.txt`；第 1 次因测试里客户端名的写法失败，见 `acc5-run1-testbug.txt`）。`exp.py rd hold` 不抢占地连上目标 38920、占 20 s：
- 已缓存目标号的 A：`抓帧失败（busy）：目标被别的客户端连着（kabegame_wpe_renderdoc），没有抢占`；
- 新起的 B（要先找目标号）：`连不上 WPE 458152 的 RenderDoc 目标：目标被别的客户端连着（38920：kabegame_wpe_renderdoc），读不到它的进程号，没有抢占`；
- hold 正常结束，占满 22.4 s（含 qrenderdoc 启动），结果里没有「目标断开了」；
- 被拒的两次没往 `out` 写东西，模板目录不变；hold 结束后 A、B 都照常抓到 3 帧。

**6. P4c 真实流程：过**（`acc6_p4c.py`，`out/acc6.txt`）。
- `capture_wallpaper` 抓 `ignore/p4/proj/p4c-trail`（1920×1080，等 12 s）：帧 295–297，后备缓冲 1920×1080，自己的窗口关了，在本会话回放进程里打开了 `p4c-trail-frame295.rdc`，日志里有 6 行 `[kbp]`。
- 接着不再 `open_capture`，直接 `get_draw_calls` + `get_mesh_data(gs_out)`，照 `ana_c_render.py` 算四角。
- 13 个系统都量到了，T6 照预测不画（NaN）。最大误差 2.1514 px（T10），旧抓帧是 1.9594 px（T10），其余系统 ≤ 0.16 px，同一量级。
- 和旧抓帧逐系统比四角：12 个系统完全相同，只有 T10 差 0.192 px。

**7. `capture_sweep`：过**（`acc7_sweep.py`，`out/acc7.txt`、`out/acc7-report.json`，日志文件在 `out/sweep/`）。调之前护栏通过。跑 p4c-attract（1920×1080，等 12 s）fps 60、fps 10 各 3 帧：

| tag | restart_wpe | 帧 | 日志（参照 `sweep_b.py`） | 中位 dt（参照） | 报错文件 |
|---|---|---|---|---|---|
| p4c-attract-fps60 | 458152 → 445544，3.5 s | 878–880，连续 | 18 行（23 行），帧 1…900（1…1150），每行 50 帧 | 0.01677（0.01670） | 空行（同参照） |
| p4c-attract-fps10 | 445544 → 470972，3.5 s | 131–133，连续 | 2 行（3 行），帧 1…100（1…150），每行 50 帧 | 0.09999（0.10002） | 空行（同参照） |

- 跑完 `restart_wpe` 改回 fps 20（470972 → 463480，3.4 s）；三次正常退出都没改 `config.json`。
- 最后 `config.json` 与开工前逐字节相同（sha256 `793251d6…`）。
- 日志行数比参照少，是因为新流程不再每次抓帧都起一个 qrenderdoc，开窗到关窗的时间短了几秒。

**8. 不弹 WPE 主窗口：过**（`acc8_watch.py`，`out/acc8.txt`、`out/acc8-watch.json`）。观察器 00:16:49–00:45 左右：
- 新出现的 WPE 可见窗口只有 35 个测试窗口，和 35 次开窗对得上；没有 `wallpaperui`，没有别的 WPE 窗口。
- 测试窗口这次一次都没拿到前台（单独列出：0 次）。
- 别的进程的新窗口与前台切换都是用户自己的：Chrome 的弹窗与页面、输入法候选窗、切到别的 VS Code 窗口（「wpe 4d」）、任务栏。
- 三次重启时桌面壁纸窗口各空约 1.4 s（观察器 0.5 s 采样一次），崩溃标记退出时为 0、启动后 WPE 自己写回 1。

**9. 终态：过**（`acc9_final.py`，`out/acc9.txt`）。
- WPE 463480（`-silent`，medium），已注入，桌面壁纸窗口在，选中的壁纸仍是 2833452727，fps 20；
- 没有测试窗口，窗口表为空，抓帧锁没人持有；
- `A:\_rdtemp` 是空的（开工前也是空的），`config.json` 与开工前逐字节相同；
- 本测试起的 MCP / 回放进程 / 观察器都已退出；用户的 RenderDoc 界面 24528、237204 与主会话的 MCP 386936、回放进程 469356 还在。

**10. 范围：过。** `git status --short` 里本批的改动：
- `.claude/mcps/wpe-renderdoc/` 下 `README.md`、`mcp_server/paths.py`、`replay.py`、`server.py`、`wpe/log.py`、`wpe/registry.py`、`renderdoc_worker/request_handler.py`，新文件 `mcp_server/wpe/capture.py`、`renderdoc_worker/target.py`；
- 本阶段计划；`AGENTS.md`（1 行）、`cocs/wpe/WPE_SCENE.md`（2 行各补一句）、旧 `SKILL.md`（开头 1 句）。

`driver.py`、旧 `target.py`、`ignore/RenderDocMCP` 没动。其余条目开工前就有（`todo.md`、子模块、`phase5/`）。开工前的 P4d 几个计划文件不见了，是别的会话 00:32 的提交 `55948709` 收走的。

**变异检查：** 把工作进程的认窗口改成一律判为本窗口，跑 `acc3_multi.py -mut`（`out/mut-acc3.txt`）：第二次抓帧（800×800，活动窗口是 1280×720）被锁外的回放核对拦下，报「回放核对不过：第一张的后备缓冲是 [[1280, 720]]，不是窗口的 [800, 800]」，已移到 `out` 的文件删掉，脚本退出码 1。`target.py` 已还原，sha256 与变异前相同（`3572abbb…`）。

**最终回归：** 最后一次改代码之后重跑冒烟与验收 1–4（`out/final/`），全过；5–7 本来就在最后一次改 worker 之后跑的。

### 对 WPE 做过的操作

| 时刻 | 操作 |
|---|---|
| 00:17:25、00:18:40 | 冒烟：`status(target=True)` 不抢占地连目标读状态，不开窗 |
| 00:20:03–00:20:14 | 验收 1：开 1280×720，抓 3 帧两次（中间一次被拒、没抓），关窗 |
| 00:20:56–00:24:18 | 验收 2（三次）：开 1920×1080、3840×2160、1280×720、2048×1136，各抓 2 帧，关窗 |
| 00:24:42–00:25:00 | 验收 3：开两个窗口，交替各抓 3 次，关窗 |
| 00:26:45–00:28:40 | 验收 4：两个 MCP 各开一个窗口，交错与同时各抓 10 次，关窗 |
| 00:29:45–00:31:53 | 验收 5（两次）：开两个窗口；`exp.py rd hold` 不抢占地连目标 20 s；被拒两次后再各抓一次；关窗 |
| 00:32:51–00:33:09 | 验收 6：`capture_wallpaper` p4c-trail 1920×1080 |
| 00:34:09–00:34:50 | 验收 7：`capture_sweep` 内三次 `restart_wpe`（正常退出 → 改 fps → `-silent` 启动 → 注入）：fps 60（458152 → 445544，约 00:34:10–13），fps 10（445544 → 470972，约 00:34:29–32），fps 20（470972 → 463480，约 00:34:47–50）；两次开窗抓帧 |
| 00:38:10–00:38:23 | 变异检查：开两个窗口、抓两次，关窗 |
| 00:38:54–00:42:32 | 最终回归：验收 1–4 同上 |
| 00:44 | 验收 9 只读核对 |

- 退出前都过了护栏：`guard.py` 每个脚本跑之前跑一次，`acc7_sweep.py` 调 `capture_sweep` 前在脚本里再跑一次。全程没有强杀 WPE。
- 配置只改过 fps（20 → 60 → 10 → 20）。
- 只结束过自己起的进程：
  - 测试 MCP 都经 stdin 正常退出；
  - 观察器结束前核对了进程号与命令行（`python -X utf8 -I ../exp/exp.py watch … watch/watch-all.ndjson`）；
  - `exp.py rd hold` 起的 qrenderdoc 自己退出。
- **最终状态：** WPE 463480 在跑（00:34:47 起，`-silent`），已注入，原壁纸在，没有测试窗口，窗口表为空。

### 没做的、疑问

- **违规：** 写 `target.py` 时误敲了一次 `python -X utf8 -I -`（heredoc 是空的，进了交互提示又读到 EOF 退出，没执行任何代码），之后没再用。
- **工作进程在抓帧中途死掉（超时被结束、崩溃）时，目标已经写进 `A:\_rdtemp` 的文件会留下。** 只删 `NewCapture` 报过的路径，这时拿不到路径；之后的抓帧也不碰它们。（第二轮：按决定保持现状，README 的坑里写了一句。）
- **两个窗口请求的尺寸不同、被系统缩成同一个客户区尺寸时分不清**（开窗查重按请求尺寸）。只在窗口比屏幕还大时才会发生。（第二轮：开窗后按实际客户区再查一次，撞了就关掉、撤销登记。）
- **竖长窗口的缩略图规则没测**，按「可能」交给回放。
- **`capture_sweep` 是一次很长的工具调用**（两个 job 约 41 s，每个 job 约 15 s 加每次重启约 3.5 s）。job 多时可能撞上客户端的工具超时，必要时分几次调。
- **别的会话的 MCP 要 `/mcp` 重连才用得上本批的工具：**
  - 主会话的 MCP（386936，23:05 起）还是第 1 批的代码；
  - 00:28:38 起的另一个 Claude 会话（claude.exe 449008）的 MCP（453696）是在本批开发中途加载的，`capture.py` 不是最终版（`target.py` 在工作进程第一次用时才导入，是最终版）。
  - 测试期间那个会话没开测试窗口，护栏都过了。
- **没写回归文档和 changelog**（`AGENTS.md` 要求主仓库改动写）。本批只改 `.claude/` 下的工具与文档，按交代只做点 4 列出的文档。
- `exp.py rd hold` 在 `ignore/wpe-mcp/exp/work/` 留下两个输出文件（`target-hold-470440.json`、`target-hold-470988.json`），是 `exp.py` 本来的行为；`exp.py` 本身没改。

### 第二轮：900×500 被误判（独立验收后修复，2026-11-10 01:00 起）

**问题：** 独立验收（`ignore/wpe-mcp/p3/size_probe.py`、`sweep_verify.py`，输出在 `out/verify/`）发现，900×500 的窗口抓到的缩略图是 896×497。屏幕上只有这一个窗口时，`capture` 也报 mismatch，把正确的抓帧删了。

**实测**（`size_rule.py`，`out/fix/size_rule.txt`、`out/size-rule-fix.json`）：每个尺寸单独开一个窗口（新规则下按「唯一可抓窗口」认、不看尺寸）抓 1 帧，以回放的后备缓冲为准。共 14 个尺寸：7 个指定的，7 个随机的（固定种子 20261110）。

| 请求 | 客户区 | 后备缓冲 | 缩略图 | 规则预测 |
|---|---|---|---|---|
| 900×500 | 900×500 | 900×500 | 896×497 | 896×497 |
| 901×500 | 901×500 | 901×500 | 896×497 | 896×497 |
| 900×501 | 900×501 | 900×501 | 896×498 | 896×498 |
| 1000×600 | 1000×600 | 1000×600 | 1000×600 | 1000×600 |
| 640×360 | 640×360 | 640×360 | 640×360 | 640×360 |
| 1366×768 | 1366×768 | 1366×768 | 1360×764 | 1360×764 |
| 2000×1000 | 2000×1000 | 2000×1000 | 2000×1000 | 2000×1000 |
| 1425×1470（随机） | 同请求 | 1425×1470 | 1424×1468 | 1424×1468 |
| 913×1309（随机） | 同请求 | 913×1309 | 912×1307 | 912×1307 |
| 2130×1639（随机） | 同请求 | 2130×1639 | 2048×1575 | 2048×1575 |
| 2908×914（随机） | 同请求 | 2908×914 | 2048×643 | 2048×643 |
| 1507×518（随机） | 同请求 | 1507×518 | 1504×516 | 1504×516 |
| 2492×820（随机） | 同请求 | 2492×820 | 2048×673 | 2048×673 |
| 1136×1800（随机） | 同请求 | 1136×1800 | 1136×1800 | 1136×1800 |

- **交换链（后备缓冲）总等于客户区，客户区总等于请求的尺寸**，偏差为 0；开窗时与 3 s 后的客户区相同。
  - 例外只有第一轮记下的「窗口加标题栏超出屏幕时被系统缩小」（3840×2160 → 3840×2130），那时交换链跟着客户区走。
  - 独立验收「交换链尺寸不总等于客户区」的推测，回放否定了：900×500 的后备缓冲就是 900×500。
- **不等的是缩略图：** RenderDoc 的缩略图宽 = min(后备缓冲宽, 2048) 向下对齐到 8 的倍数，高 = 宽 × 后备缓冲高 ÷ 后备缓冲宽（向下取整）。14 个尺寸全部吻合，偏差 0。
  - 第一轮的预测漏了「对齐到 8」：第一轮测过的尺寸（1280、1920、800、960、1024、2048、3840）宽都是 8 的倍数，所以没暴露。

**改动：**
- `renderdoc_worker/target.py`：
  - `predicted_thumb` 按上面的规则（`THUMB_ALIGN = 8`）；
  - `judge` 改成带容差：和每个可能被抓到的窗口的预测缩略图比，差在 `thumb_tol` 内的算候选；只有一个候选就按它认，没有或有两个以上候选就回放；
  - 新增 `judge_backbuffer`：回放按后备缓冲认，差在 `size_tol` 内取最接近的，本窗口与别的窗口一样近时报 `ambiguous`，`target_capture` 据此报错；
  - `target_capture` 加「唯一可抓窗口」捷径：可抓窗口数为 1、屏幕上的测试窗口只有本窗口时不看尺寸，只核对这次 N 张缩略图彼此相同；结果里带 `single`。
- `renderdoc_worker/request_handler.py`：传 `size_tol`、`thumb_tol`。
- `mcp_server/wpe/session.py`：
  - `SIZE_TOL = 8`、`sizes_close`、`_size_conflicts`：开窗查重改成「宽、高都差在 8 以内」就拒绝，登记的请求尺寸与屏幕上的客户区都比；
  - 开窗后客户区和请求不同（系统缩小过）时，按实际客户区再查一次，撞了就关掉、撤销登记。
- `mcp_server/wpe/capture.py`：
  - `THUMB_TOL = 2`，两个容差随请求传给工作进程；
  - 新增 `check_backbuffer`：锁外回放核对用同样的容差规则，按唯一可抓窗口认的只报不拒；
  - 结果加 `requested_size`、`backbuffer`（实际的后备缓冲）、`size_note`（和请求不同时）、`identified_by`。扫描的逐 job 结果也带 `backbuffer` / `size_note`。
- `mcp_server/server.py`：`instructions` 与 `capture` 的说明。
- `README.md`：选窗口、同尺寸、交换链与缩略图尺寸三条，以及坑「回放进程在抓帧中途死掉时 `A:\_rdtemp` 可能留下残留」。

**容差：** 实测偏差都是 0（后备缓冲对客户区，缩略图对规则预测）。
- 窗口尺寸容差取 8：一个对齐单位。比它更近的两个窗口缩略图可能完全相同，比如 900×500 和 901×500 都是 896×497；回放的后备缓冲也只差 1，按容差分不清，所以开窗时就拒绝。
- 缩略图容差取 2：给向下取整留余量。

**脚本：**
- `p3util.py` 加 `SUFFIX`（第一个参数以 `-` 开头时），`dump` 的文件名自动带上；
- `acc5_busy.py`、`acc7_sweep.py` 的输出目录带后缀；`acc6_p4c.py` 的后缀独立验收已经加过；
- `acc8_watch.py` 可指定观察器文件；
- 新增 `size_rule.py`（实测）与 `acc_oddsize.py`（新验收）。

**验收（第二轮，后缀 `-fix`；控制台输出在 `out/fix/`，json 在 `out/*-fix.json`，抓帧在 `A:\wpe-mcp\p3\*-fix\`）：**

| 验收 | 结果 | 证据 |
|---|---|---|
| 新增：缩略图与请求尺寸不同（`acc_oddsize.py`） | 过 | 单窗口 900×500：按「唯一可抓窗口」认、不探测，`backbuffer` 900×500，缩略图 896×497（等于预测），持锁 0.72 s。多窗口 900×500 + 1366×768 + 910×500 各抓 2 次：按尺寸认，探测 1～2 次，探测里每张缩略图都和预测差 0，不用回放就分开了；后备缓冲分别是 900×500、1366×768、910×500。开着 900×500 时 904×503 被拒（「已有和 904x503 相差不超过 8 像素的测试窗口」） |
| `sweep_verify.py -fix`（独立验收写的） | 过 | 两个 job（p4c-attract 1024×576、shimmering_particles 900×500）各 2 帧、连续；900×500 那个 `backbuffer` 为 [900, 500]；日志文件 4 个，没有重启，WPE PID 不变（463480），模板目录为空 |
| 1 基本抓帧 | 过 | 帧 190–192，`identified_by` 为「唯一可抓窗口」，回放 1280×720；同 out 再抓被拒；overwrite 照常 |
| 2 缩略图尺寸 | 过 | 1920×1080 原尺寸；3840×2160 → 客户区 / 后备缓冲 3840×2130、缩略图 2048×1136；同为 16:9 的大小两窗口都认对；2048×1136 与 3840×2130 撞缩略图时探测里回放核对，三次都认对 |
| 3 多窗口选窗 | 过 | 探测次数 `[1, 2, 2, 2, 2, 2]`，每次都是自己的窗口，探测文件都删了 |
| 4 并发 | 过 | 80 次全部成功、都是自己的窗口、没有 busy 和被踢。等锁：交错 0–0.02 s，同时 0–1.41 s；持锁 0.92–1.38 s。dt（中位 50 ms）：对方的探测落在 A / B 上最多 68 / 70 ms；A 自己被抓时这次出现了 10 帧尖峰，最多 237 ms（交错）/ 249 ms（同时），都落在 A 自己的抓帧时段里，没有落在抓帧之外的 |
| 5 外部客户端占着目标 | 过 | (a) `目标被别的客户端连着（kabegame_wpe_renderdoc），没有抢占`；(b) `连不上 WPE 463480 的 RenderDoc 目标：目标被别的客户端连着（38920：kabegame_wpe_renderdoc）…`；hold 占满 22.9 s，没有被踢 |
| 6 P4c 真实流程 | 过 | 最大误差 2.0313 px（T10），旧抓帧 1.9594 px；和旧抓帧逐系统比，12 个相同，T10 差 0.072 px |
| 单测 `unit_move.py` | 过 | 移动时目标已存在的拒绝、overwrite、路径核对、`out` 校验 |
| 8 观察器（`watch/watch-r2.ndjson`，01:00:18–01:14:39） | 过 | 新出现的 WPE 窗口只有 32 个测试窗口（和 32 次开窗对得上），没有 `wallpaperui`、没有别的 WPE 窗口；前台一次都没切到测试窗口；别的进程只有输入法候选窗和一个 VS Code 窗口 |
| 9 终态（`out/fix/acc9_final.txt`） | 过 | WPE 463480，已注入、medium，桌面壁纸在，选中 2833452727，fps 20；没有测试窗口，窗口表为空，抓帧锁没人持有；`A:\_rdtemp` 为空；`config.json` 与开工前逐字节相同；本轮起的 MCP、回放进程、观察器都已退出 |

验收 7 会重启 WPE，按交代这轮没跑；`capture_sweep` 的 restart 路径没改过代码。

**对 WPE 的操作（第二轮）：** 只开关自己的测试窗口、抓帧，没有重启、没有改设置、没有注入（WPE 一直是 463480）。

| 时刻 | 操作 |
|---|---|
| 01:03:57–01:05:17 | `size_rule.py`：14 个尺寸各开一个窗口、抓 1 帧、关窗 |
| 01:06:38–01:07:04 | `acc_oddsize.py`：开 900×500、1366×768、910×500（904×503 被拒），共抓 7 次 |
| 01:08:37 | 冒烟：`status(target=True)`，不开窗 |
| 01:08:46–01:13:55 | 验收 1–6 重跑：验收 5 里 `exp.py rd hold` 不抢占地连目标 20 s |
| 01:14:17–01:14:43 | `sweep_verify.py -fix`：两个 job（独立验收的脚本，没走 `op` 记录，时刻取自输出文件） |
| 01:15 | 验收 9 只读核对 |

- 每个开窗的脚本跑之前都过了 `guard.py`。
- 没有强杀任何进程。本轮的观察器（`watch-r2`）结束前核对了进程号与命令行。
- 独立验收自己开的观察器 453296（`out/verify/watch.ndjson`）没碰。

**残留风险：** 「唯一可抓窗口」的捷径不看尺寸，依据是「可抓窗口数不多于屏幕上的测试窗口数，所以桌面没被挂上」。

- **会出错的情形：** 桌面设备被挂上（Q13）、而本窗口的设备恰好还没注册时，抓到的会是桌面。
- **怎么发现：** 结果里的 `backbuffer` 会是桌面尺寸，并带 `size_note`；锁外核对在这条路径上只报不拒。
- 开窗后都要等几秒加载，这种时间差实际很难碰上。

### Claude 独立验收（2026-11-10 00:46–01:23）

- **范围：** 本批只动 `.claude/mcps/wpe-renderdoc/`、本阶段计划、`AGENTS.md`（单体仓库布局加一行 `.claude/mcps/`）、`cocs/wpe/WPE_SCENE.md`（两处补一句新 MCP）、旧 `SKILL.md` 开头一句。`driver.py`、旧 `target.py` 没动。
- **代码审读：**
  - `renderdoc_worker/target.py`：连目标一律 `force=False`；多窗口逐个探测，探测文件都删；失败的各条路径都在 `finally` 里删本次抓的文件；删前核对路径来自本次 `NewCapture`、在模板目录里。
  - `mcp_server/wpe/capture.py`：抓帧锁只覆盖连目标、抓、移文件；回放核对在锁外；out 里已有同 tag 就先拒绝；锁外核对不过时删掉已移入 out 的文件。
- **第一轮重跑**（后缀 `-verify`，`out/verify/run.log`）：
  - 验收 1、2、3、4、6、9 退出码 0。
  - 验收 5 失败：输出目录写死，重跑被「不覆盖」拦下。MCP 的行为对，脚本问题。
  - 另写的 `sweep_verify.py`（两个 job、不改设置）失败：900×500 的窗口被判 mismatch，抓帧被删。
- **定位：** `size_probe.py` 复现，900×500 客户区始终 900×500、缩略图 896×497。交回子代理修。
  - 子代理查清是缩略图宽向下对齐到 8，交换链不变。
  - 我用修好的 MCP 重抓核实：900×500 回放的后备缓冲是 [900, 500]，缩略图 896×497；1366×768 是 [1366, 768]，缩略图 1360×764。
- **第二轮重跑**（后缀 `-v2`，`out/verify/run2.log`）：奇数尺寸、多窗口、目标被占、`sweep_verify` 全部退出码 0。
- **变异检查：**
  - 开窗查重容差改 0，奇数尺寸验收里「904×503 应被拒」失败、退出码 1；
  - 已还原，与备份字节相同。
- **观察器**（`out/verify/watch.ndjson`，00:50–01:20）：测试窗口 58 次，WPE 主窗口 0 次，前台被测试窗口拿走 0 次。
- **终态：** WPE 463480，已注入，原壁纸在，没有测试窗口；`A:\_rdtemp` 空；`config.json` sha `793251d6…`。
- **验收 7 没重跑：** 会重启 WPE 改帧率，`restart_wpe` 第 2 批已独立验过，`capture_sweep` 的组装由 `sweep_verify.py` 验了。
