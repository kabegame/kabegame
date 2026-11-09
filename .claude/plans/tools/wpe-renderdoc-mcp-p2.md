# wpe-renderdoc MCP 第 2 批：常驻 WPE、自己的窗口、配置与日志

> 总计划：[wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md) 步骤 2（决定 3、4、5）。第 1 批（读 rdc）已提交 `28347646`。本批会操作用户正在用的、各会话共享的 WPE，但不连 RenderDoc 的抓帧目标：注入只做到 `renderdoccmd inject` 为止。抓帧、抓帧锁、选窗口留给第 3 批。

## 总体设计思路

这一批让 MCP 接管「WPE 在跑、能抓」这件事，同时管好每个会话自己的测试窗口。

核心是 `ensure_running`：
- **判定是否已注入：** 不连 RenderDoc 目标，只看 WPE 进程里有没有加载 `renderdoc.dll`。
- **在跑但没注入：** 用 `renderdoccmd inject --PID` 原地注入。
- **没在跑：** 照用户平时的方式 `-silent` 普通启动，等桌面壁纸出来再注入。启动前崩溃标记是 1 就先写 0，避免弹「上次可能崩溃」，并在结果里报出来。

这些做法都已经实测过（总计划步骤 0 的记录一、二）。MCP 从不强杀 WPE；唯一会让 WPE 退出的是显式的 `restart_wpe`，它走托盘「退出」同一条命令（向 `WPEEventWindow` 发 `WM_COMMAND 0x9c4a`），退不掉就报出来，不强杀。

**窗口归属：** 每个会话开的测试窗口登记在机器级的窗口表里，表项是一个个 JSON 文件，记所属 MCP 的进程号与启动时刻。
- 窗口名 `kb-<MCP 进程号>-<序号>`，会话只关自己的窗口。
- **陈旧窗口：** 所属进程已不在的窗口，任何 MCP 在 `ensure_running` / `status` 时顺手关掉。
- **外来窗口：** 不在表里的 `WPEOverlappedWallpaper`，比如旧脚本或 `exp.py` 开的，视为别人的，只报告、不碰。
- **同尺寸：** 同一时刻同尺寸的窗口会让第 3 批分不清抓到的是谁，开窗时就拒绝。「查重 + 登记」在一把表锁里做，防两个会话同时抢到同一个尺寸。

**配置：** 按 Q5 读码（[rea-wpe-settings.md](rea-wpe-settings.md)），WPE 只在启动时读 `config.json`，运行中外部改文件不生效，还会在它下次保存时被覆盖。所以：
- `get_settings` 只读文件；
- 改设置一律走 `restart_wpe(settings)`：正常退出 → 改文件 → `-silent` 启动 → 注入。
- `restart_wpe` 只在这些都满足时才做：没有别的会话的窗口、没有外来窗口、WPE 的设置界面没开着。
- 读码说正常退出不写文件，这一点本批要实测确认（报告的实验 E5）。

**日志：** 是 WPE 的 `log.txt`，各会话共用。游标记文件大小和创建时刻：WPE 重启时日志会重写，游标失效要报出来，不静默从头读。

**测试也要改：** 第 1 批发现验收脚本只打印、不断言。本批的验收脚本出错必须返回非 0。

## 现状锚点

**a. 注入与启动只在实验脚本里**（`ignore/wpe-mcp/exp/exp.py`）
```python
def cmd_inject(args):
    result = run([RENDERDOCCMD, 'inject', f'--PID={args.pid}', '-c', TEMPLATE], timeout=60)  # 现状：实验用，CREATE_NO_WINDOW
def spawn_detached(command_line, hide_console):
    # 现状：经 WMI 起进程，跨调用存活；renderdoccmd 要 ShowWindow=0，否则弹 Windows Terminal 抢前台
def cmd_quit(args):
    posted = bool(user32.PostMessageW(found[0], 0x0111, 0x9c4a, 0))   # 现状：托盘「退出」同一条命令
```

**b. 工程解析与 `-control`**（`.claude/skills/wpe-renderdoc/driver.py:157`、`:110`）
```python
def resolve_project(name):
    """接受工程目录、project.json、工坊 ID、默认工程名或 myprojects 里的名字。"""
def control(command):
    # 没有主实例时，控制进程会自己变成主实例并弹出浏览界面
    subprocess.run(f'"{WPE_EXE}" -control {command}', timeout=30, check=True)
```

**c. 改属性的写法**（`ignore/p3c/wpe-bloom/wpe.py:37`）
```python
def apply(name, props):
    ctl(f'-control applyProperties -location {name} -properties RAW~({json.dumps(props, separators=(",", ":"))})~END')
```

**d. 第 1 批的 MCP 只有回放工具**（`.claude/mcps/wpe-renderdoc/mcp_server/server.py`）：21 个工具，`instructions` 里写着「抓帧工具在后续批次」。

**e. 用户当前的 WPE**（2026-11-09 晚）：
- PID 452412，普通 `-silent` 启动，已被注入（`renderdoc.dll` 已加载），桌面壁纸是 Monitor0 的 2833452727；
- `config.json` 里 `fps` 20、`postprocessing` `disabled`。

## 点 1 — WPE 模块（`mcp_server/wpe/`）

- **新增** `process.py`：
  - WPE 进程列表：PID、命令行、创建时刻、完整性级别；
  - 是否已注入（枚举模块看有没有 `renderdoc.dll`；打不开进程就报「可能以管理员权限运行」）；
  - 崩溃标记读写；
  - WMI 普通启动 `-silent`（跨 MCP 存活）；
  - `renderdoccmd inject`（`CREATE_NO_WINDOW`）；
  - 正常退出（只找该 PID 的 `WPEEventWindow`）；
  - 设置界面是否开着（命令行带 `-window settings` 的 `wallpaperui.exe`）；
  - 桌面壁纸窗口（WorkerW 下的 `WPEDesktopDX11Window`）。

  从 `exp.py` 拷过来改写，`exp.py` 不动。
- **新增** `registry.py`：
  - 窗口表 `.kabegame/debug/wpe-renderdoc-mcp/windows/<窗口名>.json`：所属 MCP 进程号与创建时刻、工程、尺寸、hwnd、开窗时刻；
  - 表锁 `windows.lock`，用 `msvcrt.locking`，持有进程死了系统自动放开；
  - 陈旧判定：进程号不在，或进程号在但创建时刻对不上。
- **新增** `windows.py`：
  - 测试窗口枚举（`WPEOverlappedWallpaper`，属于 WPE 进程，带标题）；
  - 窗口与客户区矩形，按物理像素取（MCP 进程设成 per-monitor DPI aware）；
  - 等窗口出现、等窗口消失。
- **新增** `control.py`：`-control` 命令；没有主实例时拒绝发。
- **新增** `projects.py`：`resolve_project`，从 `driver.py` 拷来。
- **新增** `log.py`：
  - 游标 `{size, created}`；
  - 读增量；文件变小或创建时刻变了，就报「WPE 重启过，日志已重写」。
- **新增** `settings.py`：
  - **读：** 按读码报告附录的键清单读 `config.json` 当前用户段（用户段名取当前 Windows 用户名，取不到而文件里只有一个用户段时用它），另报崩溃标记、选中的壁纸、设置界面是否开着。
  - **写：** 只收清单里的键，值按清单的取值范围校验；第一次写前留备份 `.kabegame/debug/wpe-renderdoc-mcp/config-backup-<时刻>.json`。
  - **序列化：** 照 WPE 自己的格式（制表符缩进、`" : "`）写回。
    > 说明：验收要求把现有文件「读入再写出」逐字节不变，证明格式照对了。做不到就改用按键的文本替换，并说明原因。

## 点 2 — `ensure_running`（`mcp_server/wpe/ensure.py`）

照总计划步骤 2 的判定顺序：
1. 旧 skill 的 `.kabegame/debug/wpe-renderdoc/state.json` 在：拒绝。
2. 没有 `wallpaper64`：标记为 1 就写 0；WMI 普通启动 `-silent`；等桌面壁纸窗口出现、再稳 2 s。用户没选桌面壁纸时等不到，就改等 `WPEEventWindow` 出现、再稳 2 s。然后注入。
3. 有 `wallpaper64`、没注入：注入。
4. 已注入：不动。
5. 注入后核对 `renderdoc.dll` 已加载。
6. 关陈旧窗口。

结果报：做了哪几步、PID、是否清了标记、关了哪些陈旧窗口、外来窗口有哪些。

## 点 3 — 窗口工具

| 工具 | 做什么 |
|---|---|
| `ensure_running()` | 见点 2 |
| `open_wallpaper(project, size="1280x720", wait=20)` | 先 `ensure_running`；表锁内查重（同尺寸的登记窗口或外来窗口都算冲突，拒绝并报出是谁），分配名字并登记；发 `openWallpaper -file … -playInWindow <名字> -width W -height H`；等窗口出现，补上 hwnd。前台被它拿走的话报出来。回窗口名、hwnd、窗口与客户区矩形、开窗前的日志游标 |
| `close_wallpaper(window)` | 只关自己的；发 `closeWallpaper -location <名字>`，等窗口消失，再从表里删掉 |
| `apply_properties(window, props)` | 只对自己的窗口；写法同锚点 c |
| `windows()` | 桌面壁纸窗口、全部测试窗口：名字、hwnd、矩形、所属（本会话 / 别的会话 / 陈旧 / 外来） |

- **MCP 退出**（第 1 批已有的退出钩子）：先关自己的窗口，再停回放进程。WPE 不动。

## 点 4 — 配置工具

| 工具 | 做什么 |
|---|---|
| `get_settings()` | 只读：清单里的键、崩溃标记、选中的壁纸、设置界面是否开着、上次备份以来改过的键。设置界面开着时注明「文件可能落后于 WPE 内存」 |
| `restart_wpe(settings={})` | 见下 |

**`restart_wpe` 的步骤：**
1. 前提，不满足就拒绝并报原因：
   - 窗口表里没有别的会话的活窗口；
   - 没有外来窗口；
   - 设置界面没开着；
   - 旧 skill 的 `state.json` 不在；
   - `settings` 里的键都在清单里，值都合法。
2. 关掉本会话自己的窗口，结果里列出来。
3. 正常退出。20 s 内没退就报失败：不强杀、不改文件。
4. 记下退出后的文件哈希，和退出前比（验证读码说的「正常退出不写文件」），再核对标记为 0。
5. 第一次改就先备份，再写 `settings`。
6. 普通启动 `-silent`，等桌面壁纸，注入。
7. WPE 起来后再读文件，核对新值还在（启动时的规范化会写文件，新值还在说明它读进去了）。
8. 结果报：改了哪些键、旧值和新值、退出与启动的耗时、哈希核对、注入状态。

`settings` 为空时就是一次干净的重启：去掉注入的 DLL、重建桌面设备，然后重新注入。

## 点 5 — 状态、日志与清理

| 工具 | 做什么 |
|---|---|
| `status()` | WPE 进程、完整性级别、是否已注入、崩溃标记、窗口表（含所属与陈旧）、外来窗口、设置界面是否开着、旧 skill 会话是否存在 |
| `log_mark()` | 返回游标 |
| `log_since(mark, grep?, errors=False)` | 增量行；`errors` 只回含 `error` / `fail` 的行；游标失效时报出来 |
| `cleanup_project(path)` | 删 WPE 写进测试工程的 `shaders/blobsSM40`；只限仓库 `ignore/` 下的目录，路径规范化后再判断 |

- **修改** `instructions`：加上本批的工具与约定（常驻、不关不杀、只开关自己的窗口、改设置要重启）。抓帧仍写「在后续批次」。

## 验收

脚本和输出放 `ignore/wpe-mcp/p2/`；脚本出错返回非 0，带断言。全程开观察器：`python -X utf8 -I ignore/wpe-mcp/exp/exp.py watch --seconds <N> --out <文件>`。

1. **配置格式：** 现有 `config.json` 读入再按 WPE 格式写出，逐字节相同（只写到 `ignore/wpe-mcp/p2/` 下的副本，不碰原文件）。
2. **`ensure_running` 四种起点：** 起点的准备用 `exp.py` 的 `quit` / `spawn`，不走 MCP。
   - (a) 在跑、没注入：先 `restart_wpe()`，再用 `exp.py` 正常退出、普通启动，得到一个没注入的 WPE；`ensure_running` 后 PID 不变，`renderdoc.dll` 已加载，桌面壁纸窗口一直在；
   - (b) 已注入：再调一次，什么都不做；
   - (c) 没在跑、标记 0：启动并注入，原壁纸自己加载；
   - (d) 没在跑、标记 1（`exp.py quit` 之后手动写 1）：清标记、启动、注入。
   - 四种都不弹窗、不抢前台。
3. **窗口：** 两个 MCP 进程（两个 stdio 客户端）各开一个窗口。
   - 名字、表项正确；
   - 同尺寸被拒并报出所属；
   - 两个客户端同时开同尺寸的窗口，只有一个成功；
   - 各自只能关自己的（关别人的被拒）；
   - 结束其中一个 MCP 的进程树后，另一个的 `ensure_running` 把它的窗口关掉，并报为陈旧；
   - 用 `exp.py control` 开一个外来窗口，`windows()` 标为外来，`restart_wpe` 因此拒绝。
4. **`restart_wpe`：**
   - `fps` 20 → 30：退出前后文件哈希相同；退出后标记为 0；启动后文件里 `fps` 是 30；桌面壁纸回来、已注入；不弹窗。
   - 再改回 20。
   - 最后的 `config.json` 和开工前相比，除 WPE 规范化带来的差异外相同，差异逐条列出。
   - 前提不满足时（窗口表里有别的会话的窗口）拒绝。
5. **`get_settings`：** 与文件逐键相同，标记与选中的壁纸正确。
6. **日志：** 开窗前 `log_mark`，开窗后 `log_since` 有该工程的加载行；`restart_wpe` 之后用旧游标读，报「日志已重写」。
7. **不弹窗、不抢焦点：** 观察器全程没有新的可见窗口（测试窗口除外），前台没被切走。测试窗口抢不抢前台单独列出。
8. **终态：** WPE 在跑、已注入、原壁纸在、没有测试窗口；`config.json` 同第 4 条；窗口表为空。
9. **范围：** `git status` 只有 `.claude/mcps/wpe-renderdoc/` 和本阶段计划；`exp.py`、旧 skill、`ignore/RenderDocMCP` 没有改动。

## 约束（给实施方）

- **WPE 是共享的：**
  - 任何会让 WPE 退出的测试（`restart_wpe`、`exp.py quit`）之前，先确认没有不属于本测试的 `WPEOverlappedWallpaper` 窗口；有就停下来报告，不要继续。
  - 测试窗口只开本测试的。
- **不强杀 WPE：** 不对 `wallpaper64.exe` 用 `taskkill` 或 `TerminateProcess`。正常退出失败就停下来报告。
- **只改 `fps`：** 配置只改 `fps`（20 → 30 → 20），最后改回原值。不改壁纸、工程、工坊内容；测试工程用默认工程（如 `shimmering_particles`）或仓库 `ignore/` 下的。
- **本批不连 RenderDoc 的抓帧目标**（不调 `CreateTargetControl`），只注入。
- **不碰用户的 RenderDoc：** 不碰用户开着的 RenderDoc 界面（PID 24528、237204）和旧的 `renderdoc` MCP。
- **只结束自己起的进程：** MCP 测试进程、它们的回放进程。结束前核对 PID 和命令行。
- **Python：** 脚本一律落文件，用 `python -X utf8 -I <脚本>` 跑；新工程里用 `uv run`。不要 `python -c`、`python -`。
- **其他：** 不要 `deno install`；不 `git add` / commit；注释用中文。
- **汇报：** 改了哪些文件；每条验收的证据；和本计划不同的地方及原因；没做完的；全程对 WPE 做过的操作清单（启动、退出、注入、改配置，带时刻），以及最终状态。

## 实施记录

2026-11-09 23:20–23:45，子代理实施。点 1–5 做完；验收 1–5、7–9 过，验收 6 的后半按原文不成立（WPE 重启不重写日志，见下）。脚本与输出在 `ignore/wpe-mcp/p2/`（`out/*.txt`），观察器记录 `watch/watch-all.ndjson`（23:30:11 起，覆盖全部碰 WPE 的步骤）。

### 做了什么

- **新增** `mcp_server/wpe/`：`process.py`、`windows.py`、`registry.py`、`control.py`、`projects.py`、`log.py`、`settings.py`、`ensure.py`（ensure_running、restart_wpe、status、get_settings），另有 `session.py`（窗口工具的实现、陈旧窗口回收、退出时关自己的窗口、cleanup_project）、`common.py`（`WpeError` 等）。
- **修改** `paths.py`（WPE、renderdoccmd、窗口表、两把锁、旧 skill 的 state.json）、`server.py`（11 个工具、`instructions`、退出钩子先关自己的窗口再停回放进程）、`README.md`（结构里加一行 `wpe/`）。
- `exp.py`、旧 skill、`ignore/RenderDocMCP` 没动（快照前后逐文件相同）。

### 和计划不同的地方

1. **多一把进程锁 `wpe.lock`。** 两个会话同时 `ensure_running`、WPE 又没在跑时，会各自启动、各自注入（重复注入没测过）。启动、注入、重启都在这把锁里；`restart_wpe` 从核对前提到新 WPE 注入完一直握着 `wpe.lock` 和 `windows.lock`，别的会话这几秒开不了窗，免得在「核对没有别人的窗口」之后又登记进来、被重启关掉。次序固定先 `wpe.lock` 后 `windows.lock`；进程内可重入。
2. **日志游标多 `head` / `head_len`（开头 256 字节的摘要）。** NTFS 的隧道效应：删掉后马上同名重建，创建时刻沿用旧的。`acc6_log.py` 实测删掉重建后只有「开头变了」这一条报出来，创建时刻没变。
3. **WPE 重启不重写 `log.txt`**（计划设计思路与验收 6 的前提不成立）。`log.txt` 创建于 2026-11-01 11:00:47，一直追加，里面有 11-01 以来多次启动的行；`restart_wpe(fps=30)` 之后用重启前取的游标读，`valid: true`、0 行新内容；全部 6 次启动之后再用同一个游标读，仍然有效，读到之后开窗写的 13 行（`acc6_oldmark.py`）。所以「restart_wpe 之后用旧游标读，报『日志已重写』」做不到；改在日志副本上模拟截断、删掉重建、文件消失三种情形，都报 `rewritten`、不从头读。
4. **`loglevel` 是 `error`，WPE 不写「加载工程」的行。** 验收 6 前半改用测试工程 `ignore/wpe-mcp/p2/proj/kbp2-log`（`ignore/p4/proj/p4-0` 的副本，标题改成 kbp2-log，去掉 `blobsSM40`），它的脚本每 50 帧 `console.error('[kbp] …')`。开窗前的游标之后读到它从第 1 帧开始的行。
5. **WPE 启动时没有回写 `config.json`**（读码说启动时规范化后回写一次）。三次带改动的写入后，文件修改时刻都停在我们写的那一刻。所以第 7 步「新值还在」只说明没被覆盖，不能证明读进去了；结果里加了 `config_rewritten_on_start`。读进去的证据另取：fps 30 时新开窗口的帧间隔中位数 0.0334 s，fps 20 时 0.0501 s（`acc4_restart.py` 的 `measure_dt`）。
6. **序列化：数字照原文写回。** 现有文件里只有一个浮点数 `0.21`，定不出 WPE 的浮点位数规则；整数、浮点都保留读进来的原文，新写的值用 Python 的最短表示。其余照 jsoncpp `BuiltStyledStreamWriter`（`indentation "\t"`、无注释、结尾无换行、CRLF）逐行实现。写之前先核对「读入再写出逐字节相同」，不同就拒绝写。
7. **可写键：** `apprules`、`mediablocklist` 是数组，只读；`monitordetection` 只收报告列出的五个值；`fps` 的上限取各显示器所有模式里的最高刷新率（本机 152）。备份只在写真正的 `config.json` 时留，且只在还没有备份时留一次，`get_settings` 和最新一份比。
8. **`restart_wpe` 在 WPE 没在跑时**：跳过退出，标记为 1 就写 0，照常写文件、启动、注入。
9. **同尺寸冲突**：外来窗口按客户区物理像素算尺寸；陈旧但窗口还在的也算冲突。实测 WPE 的 `-width/-height` 就是客户区的物理像素。
10. **`cleanup_project`** 另要求目录里有 `project.json`，并在任一登记窗口正开着这个工程时拒绝。
11. **`close_stale`** 顺带删掉本会话表项里窗口已经不在的（WPE 被别处重启时会这样）。`open_wallpaper` 等不到窗口时补发一次 `closeWallpaper` 并撤销登记。
12. **`renderdoccmd inject` 的退出码是目标号**（本机都是 38920），不是 0；注入成功与否只看 `renderdoc.dll` 是否加载。
13. 新工具的说明用中文；`restart_wpe` 的参数缺省是 `None`（等同 `{}`）。

### 验收证据

**1. 配置格式：过**（`acc1_config.py`，`out/acc1.txt`）。`config.json` 与 `config_backups/` 的 7 份每日备份，副本读入再写出全部逐字节相同（如 `config.json` 16763 字节 sha `793251d6…`）。副本上写 fps 30 只改了 `"fps" : 20,` 那一行，写回 20 后与原文逐字节相同；5 种非法值都被拒。变异检查：把单行数组的 `"[ "` / `" ]"` 改成 `"["` / `"]"`，4 份文件报不同、退出码 1。

**2. ensure_running 四种起点：过**（`acc2_ensure.py`，`out/acc2-*.txt`）。

| 起点 | 结果 |
|---|---|
| (b) 已注入（452412） | `steps: [already_injected]`，0.08 s，PID 不变 |
| (a) 在跑、没注入 | 先 `restart_wpe()`：456488 → 450328，退出 0.2 s、退出前后哈希相同、标记 0、已注入；`exp.py quit` 后普通启动得到没注入的 455684；`ensure_running`：`steps: [injected]`，PID 不变，注入 0.27 s，每 50 ms 采样桌面壁纸窗口一直在 |
| (c) 没在跑、标记 0 | `steps: [started, injected]`，起到桌面壁纸 0.2 s，没开 wallpaperui，选中的壁纸仍是 2833452727 |
| (d) 没在跑、标记 1 | `steps: [cleared_crash_flag, started, injected]`，`crash_flag_before: 1`，不弹窗 |

(a) 第一次跑时脚本把 `exp.py spawn --args -silent` 写错（argparse 当成选项），WPE 在 23:37:36–23:38:13 没在跑；修好后用 `a-tail` 从「没在跑」续跑完后半。

**3. 窗口：过**（`acc3_windows.py`，`out/acc3.txt`；收尾后又完整重跑一次 `out/acc3-rerun.txt`，也过）。名字 `kb-<MCP 进程号>-<序号>`、表项（所属进程号与创建时刻、工程、尺寸、hwnd）正确；B 开 1280×720 被拒并报出 A 的窗口与进程号；两个客户端同时开 800×800 只有一个成功，失败方报出对方的窗口；互相关、改属性都被拒；结束 B 的整条进程链（核对命令行）后，A 的 `windows()` 把 B 的窗口标为 stale，`ensure_running` 关掉它并报在 `stale_closed`；伪造「进程号在、创建时刻不符」的表项同样被当陈旧删掉；`exp.py control` 开的 KBFOREIGN 标为 foreign，同尺寸开窗、关它、`restart_wpe` 都被拒；另一个 MCP 关 stdin 退出后它的窗口关了、表项删了。

**4. restart_wpe：过**（`acc4_restart.py`，`out/acc4.txt`）。fps 20 → 30：退出 0.2 s，退出前后哈希都是 `793251d6…`，退出后标记 0，启动 2.55 s，文件里 fps 30，已注入，桌面壁纸回来；第一次写前留了 `config-backup-20261109-233548.json`（与开工前逐字节相同）。30 → 20 同样通过，不再留备份。最后的 `config.json` 与开工前逐字节相同（差异 0 行，没有规范化差异）。B 开着窗口时 A 的 `restart_wpe` 被拒，WPE PID 不变。

**5. get_settings：过**（`acc5_settings.py`）。40 个键与标准库直接读的文件逐键相同（值与类型），标记与注册表一致，选中的壁纸是 Monitor0 的 2833452727，设置界面没开着。

**6. 日志：前半过，后半见「不同」第 3 条。** 开窗后 `log_since` 读到 kbp2-log 从第 1 帧开始的 `[kbp]` 行；`restart_wpe` 后旧游标仍有效、没有新行。副本上的模拟（`acc6_log.py`）：追加、半行、`errors`、`grep`、截断、删掉重建、文件消失都对。变异检查：去掉开头摘要的比较，「删掉重建」一项失败、退出码 1。

**7. 不弹窗、不抢焦点：过，有一处说明。** 观察器 23:30:11–23:42:20：新出现的可见顶层窗口除测试窗口（`WPEOverlappedWallpaper`）外只有一个——23:40:38 资源管理器的托盘溢出窗口，随后前台切到任务栏；当时 acc3 重跑的两个 MCP 正在启动、还没发任何 WPE 命令，和步骤 0 记录一、二里两次「按人为操作记」的情形相同。23:42:20 前台回到 VS Code。测试窗口单独看：每次 `open_wallpaper` 的 `foreground.changed` 都是 false，观察器在开窗时刻也没有前台切换。6 次重启都没有 wallpaperui、没有安全启动提示。

**8. 终态：过**（`acc8_final.py`）。WPE 447736（`-silent`，medium），已注入，桌面壁纸窗口在，选中 2833452727，没有测试窗口，窗口表为空，`config.json` 与开工前逐字节相同（fps 20）。

**9. 范围：过。** 本批的 `git status` 只有 `.claude/mcps/wpe-renderdoc/` 下的 `README.md`、`mcp_server/paths.py`、`mcp_server/server.py`、`mcp_server/wpe/`，以及本计划文件；`exp.py`（`ignore/wpe-mcp/exp/` 44 个文件）、旧 skill 3 个文件、`ignore/RenderDocMCP` 69 个文件前后快照相同。

### 对 WPE 做过的操作

| 时刻 | 操作 |
|---|---|
| 23:31:44 | `ensure_running`，452412 已注入，不动 |
| 23:32:15–23:34:47 | 开关测试窗口（kbp2-log、shimmering_particles；KBFOREIGN 经 `exp.py control`）、`applyProperties` |
| 23:35:48 | `restart_wpe(fps=30)`：452412 正常退出 → 写 fps 30 → 启动 454396 → 注入 |
| 23:35:58 | `restart_wpe(fps=20)`：454396 → 写 fps 20 → 456488 → 注入 |
| 23:37:29 | `restart_wpe()`：456488 → 450328 → 注入 |
| 23:37:34 | `exp.py quit` 450328；脚本错误，WPE 停到 23:38:13 |
| 23:38:13 | `exp.py spawn` 普通启动 455684；23:38:19 `ensure_running` 原地注入 |
| 23:38:36 | `exp.py quit` 455684；`ensure_running` 启动 453128 并注入 |
| 23:38:58 | `exp.py quit` 453128；手动写标记 1；`ensure_running` 清标记、启动 447736、注入 |
| 23:40:33–23:41:26 | acc3 重跑（开关窗口）、只读核对 |

全程没有强杀 WPE；每次退出前都过了护栏（`guard.py`：没有别人的测试窗口和表项）。

### 没做的、疑问

- 没测：WPE 以管理员权限运行时的报错路径（`modules_of` 拒绝访问、`PostMessage` 被 UIPI 拦）。
- `restart_wpe` 第 7 步的核对意义变弱（见「不同」第 5 条），要不要改成开一个窗口量帧间隔，请定。
- 违规：实施初期有三次命令里带了 `python -X utf8 -I -` / `python -`（输入为空，没有执行任何代码）。
- FastMCP 会把每次拒绝（`WpeError`）连同调用栈记到 MCP 的 stderr，只影响日志，不影响结果。

### Claude 独立验收（2026-11-09 23:46–23:55）

- **范围：** `git status` 里本批只有 `.claude/mcps/wpe-renderdoc/` 下的 `README.md`、`paths.py`、`server.py` 和新目录 `mcp_server/wpe/`，加上本阶段计划。代码里没有任何结束 WPE 的调用（搜 `taskkill`、`TerminateProcess`、`kill`），`restart_wpe` 退不掉只报错，不改文件。
- **重跑验收**（`ignore/wpe-mcp/p2/out/verify/run.sh`，逐条看退出码，输出在 `out/verify/`）：
  - guard、1、5、6（副本）、2(b)、3、8 全部退出码 0。
  - 4 有一条断言失败：「第一次写前留了备份」。原因是备份按设计只在还没有备份时留一次，子代理那轮已经留过，测试不能重复跑，不是代码的问题。已改成「已有备份时核对它等于开工前」。
  - 那份备份、开工前的两份副本和当前 `config.json` 的 sha256 都是 `793251d6…`。
  - 4 的其余断言全过：两轮「正常退出不写 `config.json`」（哈希不变）、退出后标记 0、新开窗口帧间隔 0.0333 s / 0.0502 s（fps 30 / 20）。
  - 期间 WPE 重启两次（447736 → 465588 → 458152），每次约 3 s。
- **变异检查：** 去掉开窗的同尺寸查重，验收 3 报 4 条失败、退出码 1；已还原，没有留下窗口和表项。
- **发现的问题：测试窗口会抢前台。**
  - 我这轮的观察器记到两个测试窗口先后拿到前台，各在开窗几秒后，前后约 4 s，直到关窗。子代理那轮是 0 次。
  - 原因（推断）：本机前台锁超时 `ForegroundLockTimeout` 是 200000 ms。用户 200 s 内有输入时后台进程抢不走前台，超过了就抢得走。之前 4d 会话的窗口每次都抢，也符合这一点。
  - 开窗后 0.5 s 那一次检查（`settle_foreground`）看不到这种晚几秒的抢夺。
- **用户定（2026-11-10）：测试窗口占前台可以接受，只是 WPE 的主窗口不能弹出来抢前台。**
  - 主窗口指浏览界面、安全启动提示这类界面。
  - 这一点由 `-silent` 启动和启动前清崩溃标记保证；全程 6 + 2 次启动都没有出现 `wallpaperui`，也没有安全启动提示。
  - 我一度加过前台守卫 `focus.py`：开关窗后被测试窗口拿走前台就切回。按用户的决定已撤回，代码恢复到子代理交付的版本。
  - 撤回后回归验收 3、8，全过。`open_wallpaper` 结果里的 `foreground` 只报告，不处理。
- **`restart_wpe` 生效核对：** 不加「开窗量帧间隔」的自动核对。验收里已实测 fps 30 / 20 生效，结果里保留 `config_rewritten_on_start` 的说明。
