# wpe-renderdoc MCP

抓 Wallpaper Engine（WPE）的 RenderDoc 帧、读抓帧（`.rdc`）做回放分析的 MCP，给 WPE 的对照工作流用：
「确保 WPE 在跑 → 开自己的窗口 → 抓帧 → 打开 rdc → 分析」。计划见 `.claude/plans/tools/wpe-renderdoc-mcp.md`（总计划）
与 `wpe-renderdoc-mcp-p1.md` / `-p2.md` / `-p3.md`（三批）。抓 WPE 真值用这里：旧 `wpe-renderdoc` skill 的命令行
`driver.py` / `target.py` 已删，`.claude/skills/wpe-renderdoc/SKILL.md` 现在只是这个 MCP 的用法说明。

## 用法

### 典型工作流

1. `capture_wallpaper(project, out="A:\<项目>\<用途>", frames=3, size="1280x720", wait=8)`：一步做完
   「`ensure_running` → 开本会话的测试窗口 → 等 `wait` 秒让场景加载 → 抓帧 → 关窗 → 截日志 → 在本会话的回放进程里打开第一张」。
   结果里看 `capture.gaps`（帧号不连续）和 `capture.first_frame`（绘制数、后备缓冲尺寸、`backbuffer_ok`）。
2. 接着直接调回放工具：`get_draw_calls`、`get_mesh_data(event, "gs_out")`、`get_pipeline_state`、`save_texture`……
   换一张用 `open_capture`。
3. 一组「工程 × 帧数 × 设置」：`capture_sweep(jobs, out_root, log_dir?)`，替代 `ignore/p4/sweep_b.py`。
4. 要在开着的窗口上分步做（比如先 `apply_properties` 再抓）：`open_wallpaper` → `capture` → `close_wallpaper`。

### 工具

| 类 | 工具 | 做什么 |
|---|---|---|
| 抓帧 | `capture_wallpaper` | 见上；中途出错也关掉自己开的窗口。日志从开窗前截起（含加载期的报错） |
| | `capture_sweep(jobs, out_root, log_dir?)` | `jobs`：`[{project, frames?, size?, wait?, settings?, tag?, borderless?, x?, y?}]`，抓帧放 `out_root\<tag>`。按 `settings` 分组，要改设置时 `restart_wpe`，跑完改回扫描开始时的值；`log_dir` 给了就写 `<tag>-log.txt`（`[kbp]` 行）与 `<tag>-errors.txt` |
| | `capture(window, out, frames, tag?, timeout?, overwrite?)` | 在本会话开着的窗口上抓 N 帧，文件 `<tag>-frame<帧号>.rdc`；`out` 里已有同 tag 的抓帧时拒绝，除非 `overwrite` |
| WPE | `ensure_running` | 在跑且已注入就不动；在跑没注入就原地注入；没在跑就 `-silent` 普通启动再注入（崩溃标记为 1 先清） |
| | `open_wallpaper` / `close_wallpaper` / `apply_properties` / `windows` | 本会话的测试窗口；`open_wallpaper`、`capture_wallpaper` 与 sweep 的 job 收 `borderless`、`x`、`y`，见「无边框窗口」 |
| | `status(target?)` | 进程、注入、窗口表、外来窗口、抓帧锁由谁持有；`target=True` 另读 RenderDoc 目标的 API 与可抓窗口数 |
| | `get_settings` / `restart_wpe(settings?)` | 只读 `config.json`；改设置只能重启 |
| | `log_mark` / `log_since` / `cleanup_project` | 日志游标与增量；清测试工程里的 `shaders/blobsSM40` |
| 回放 | `open_capture`、`get_*`、`find_draws_*`、`save_texture`、`pick_pixel`…… | 19 个工具照旧 `renderdoc` MCP，后端是本会话私有的无界面回放进程；另有 `close_capture`、`show_in_renderdoc`（会弹界面） |

### `out` 的约定

- 必须给，绝对路径，约定 `A:\<项目>\<用途>\`：项目根下散落的抓帧不算数（少于两级目录拒绝）。
- 不接受仓库里的路径，也不能和抓帧模板目录 `A:\_rdtemp` 重叠。
- `tag` 缺省取 `out` 的末级目录名。

### 常驻与并发规则

- **WPE 常驻共享，不关不杀。** MCP 从不强杀 WPE，也不在退出时关它；唯一会让它退出的是显式的 `restart_wpe`（走托盘「退出」同一条命令，退不掉只报错）。注入的 `renderdoc.dll` 一直留在 WPE 里，直到它重启。
- **窗口归属：** 测试窗口叫 `kb-<MCP 进程号>-<序号>`，登记在 `.kabegame/debug/wpe-renderdoc-mcp/windows/`。只开关自己的；别的会话的、外来的（表里没有的）不碰；所属 MCP 已不在的陈旧窗口，任何 MCP 的 `ensure_running` / `status` 都会顺手关掉。桌面壁纸一律不碰。
- **同尺寸：** 同一时刻不允许两个尺寸相差不超过 8 像素（宽、高都在 8 以内）的测试窗口：开窗时拒绝，否则抓帧时分不清是谁的。系统把窗口缩小过时，开窗后按实际客户区再查一次，撞了就关掉、撤销登记。
- **抓帧锁：** 连 RenderDoc 目标是独占的。机器级的 `target.lock` 保证同一时刻只有一个 MCP 在连，持有者写在 `target.holder.json`，等锁超时报出是谁。锁只覆盖「找目标号 → 连接 → 选中自己的窗口 → 触发 → 收文件 → 断开 → 移到 `out`」，一次约 1 s（有探测或回放核对时 2–3 s）；回放核对与分析在锁外，各会话可以同时分析。
- **不抢占：** 连目标一律 `force=False`。目标被别的客户端（比如用户在 RenderDoc 界面里附加了 WPE）连着时，报「目标被别的客户端连着（对方名字）」，不踢人。RenderDoc 报的客户端名会把 `-` 换成 `_`。
- **选窗口：** RenderDoc 一次只抓「活动窗口」，它是各会话共享的：第一个注册的窗口默认活动，切换一次轮到下一个，跨连接保留。
  - 可抓窗口只有一个、屏幕上的测试窗口也只有本窗口（所以桌面没被挂上）：直接认作本窗口，不看尺寸，只核对这次的 N 张缩略图彼此相同；结果里 `identified_by` 为「唯一可抓窗口」；
  - 其他情况按尺寸认：多于一个可抓窗口时先抓 1 帧探测，按缩略图认是不是自己的窗口，不是就删掉探测文件、切换、再探，最多探「窗口数」次；认对的那张探测也删掉（和后面的 N 帧不连续）。交替抓两个窗口时每次多 1～2 次探测；
  - 按缩略图认：和每个可能被抓到的窗口按规则预测的缩略图比，差 2 像素以内的算候选；只有一个候选就按它认，没有或有两个以上候选就另开回放，按后备缓冲认（差 8 像素以内、取最接近的），仍分不清就报错；
  - 锁外再另开一个回放读第一张，用同样的容差核对后备缓冲（按唯一可抓窗口认的只报不拒）。结果里报实际的后备缓冲（`backbuffer`），和请求的尺寸不同时带 `size_note`。
- **交换链与缩略图的尺寸（RenderDoc 1.47、WPE 实测，14 个尺寸，其中 7 个随机）：**
  - 交换链（后备缓冲）总等于窗口客户区，客户区总等于请求的尺寸（除非窗口超出屏幕被系统缩小，见下一条）；偏差为 0；
  - 缩略图不一定等于后备缓冲：宽 = min(后备缓冲宽, 2048) 向下对齐到 8 的倍数，高 = 宽 × 后备缓冲高 ÷ 后备缓冲宽（向下取整）。如 900×500 → 896×497、1366×768 → 1360×764、3840×2130 → 2048×1136；
  - 两个窗口的缩略图可能撞上（比如 2048×1136 的窗口和 3840×2130 的窗口），这时靠回放分开。
- **窗口加上标题栏后超出屏幕时会被系统缩小：** 本机屏幕 3840×2160 物理像素，带边框开 3840×2160 的窗口，客户区实际是 3840×2130，WPE 的交换链跟着客户区走。`capture` 按客户区认，结果里带 `expect_note`。要准确的客户区用无边框窗口（下一条），`borderless` 不给时放不下会自动用。
- **无边框窗口（2026-11-14）：** `openWallpaper` 还认 `-x`、`-y`、`-borderless`（`wallpaper64.exe` 里和 `-width` / `-height` 排在一起）。
  - `-borderless` 把窗口换成 `WS_POPUP`（样式 `0x94000000`），窗口 = 客户区；但 WPE 仍按带边框窗口（`WS_OVERLAPPEDWINDOW`）算尺寸，整个窗口是「请求尺寸 + 边框厚度」：144 DPI 下请求 3840×2160 实得 3862×2216，请求 3818×2104 实得 3840×2160，请求 1280×720 实得 1302×776。
  - 所以 `borderless` 时 MCP 按目标显示器的 DPI 用 `AdjustWindowRectExForDpi(WS_OVERLAPPEDWINDOW)` 算边框厚度（144 DPI 是 22×56，和实测相同），从 `-width` / `-height` 里先减掉；`x`、`y` 缺省为显示器左上角。开窗后照常核对客户区，对不上报 `warning`。
  - `borderless` 不给（`None`）时自动：带边框的窗口（请求尺寸 + 边框）放不进显示器工作区就用无边框，否则照旧带边框。结果的 `placement` 写明用没用、是不是自动选的、扣掉的边框、DPI、实际发给 WPE 的尺寸；sweep 的 job 结果里是 `borderless` 项。
  - 无边框窗口盖住它那块屏幕（4K 全屏时连任务栏一起），和带边框的测试窗口一样会拿到前台。
- **探测的代价：** 探测会让别人的窗口多一次被抓的帧。fps 20（正常 dt 50 ms）下三次实测：对方的探测落在自己窗口上时 dt 最多 66–70 ms；自己被抓时 dt 最多 77–249 ms，各次差别不小；fps 越高越明显。结果里报出探测次数（`probes`）。

### 设置

- `get_settings` 只读文件。WPE 只在启动时读 `config.json`，改设置只能 `restart_wpe(settings)`：正常退出 → 改文件 → `-silent` 启动 → 注入，桌面空几秒；只在没有别的会话的窗口、没有外来窗口、设置界面没开着时做。
- **设置不还原、只报改动：** 改过的键在结果里逐项报出（旧值、新值），第一次改之前在状态目录留一份备份。例外是 `capture_sweep`：它自己改的设置在扫描结束后改回扫描开始时的值。

### 从旧 skill 带过来、仍成立的坑

- **帧号换壁纸后重新计数：** 每次开窗都从头数，不同窗口的 `frame<N>` 不能比较。
- **被抓的帧本身是长帧：** 序列化要时间，这几帧的 dt 不代表正常帧率。
- **`pause` 只管桌面壁纸：** `-playInWindow` 窗口不受影响。
- **测试窗口左上角有 RenderDoc 的叠加文字：** 约 340×40 像素，不进 `.rdc`，但 PrintWindow 采样能看到。
- **桌面壁纸被重建后可能被挂上：** 注入之后用户换壁纸或显示器变化，新的桌面设备也会被挂上，桌面左上角出现叠加文字、可抓窗口数多出一个。`capture` 在可抓窗口数多于测试窗口数时把桌面尺寸也算进去认；WPE 重启（`restart_wpe` 或用户自己重启）后恢复。
- **开窗后要等加载：** `wait` 按场景大小给，否则抓到的还在加载。
- **测试窗口会在开窗几秒后拿到前台：** 用户接受；WPE 的主窗口（浏览界面、安全启动提示）不会弹。
- **RenderDoc 打开着的 `.rdc` 删不掉：** 先 `close_capture`。
- **回放进程在抓帧中途死掉（超时被结束、崩溃）时，`A:\_rdtemp` 里可能留下这次已经写好的抓帧：** 只删抓帧消息里报过的路径，这时拿不到路径，所以不删；之后的抓帧也不碰它们。看到 `A:\_rdtemp` 里有 `wallpaper64_frame*.rdc` 残留，确认没人在抓之后手动删。

## 来源

- 上游：[halby24/RenderDocMCP](https://github.com/halby24/RenderDocMCP) `11b6b743a4c02c94eb8a1125a1e025dbd021352a`（MIT，见 `LICENSE`）。
- 从仓库里的 `ignore/RenderDocMCP`（上游加本地改动）拷来。旧的 `renderdoc` MCP 已从 `.mcp.json` 去掉、`ignore/RenderDocMCP`
  由用户删除（2026-11-10，kbp-tools 第 4 批）；下面的本地改动清单是拷来时记下的。
- **以后不跟上游。** 上游的新功能要手工合进来。

### 拷来时已有的本地改动（相对上游 `11b6b74`）

`git -C ignore/RenderDocMCP diff --stat`：

```text
 mcp_server/bridge/client.py                      |   51 +-
 mcp_server/server.py                             |  181 +++-
 renderdoc_extension/renderdoc_facade.py          |   64 +-
 renderdoc_extension/request_handler.py           |   97 ++-
 renderdoc_extension/services/__init__.py         |    2 +
 renderdoc_extension/services/capture_manager.py  |   16 +-
 renderdoc_extension/services/pipeline_service.py | 1016 +++++++++++++---------
 renderdoc_extension/services/resource_service.py |  340 +++++++-
 renderdoc_extension/services/search_service.py   |   59 +-
 renderdoc_extension/socket_server.py             |   18 +-
 renderdoc_extension/utils/serializers.py         |   44 +-
 11 files changed, 1337 insertions(+), 551 deletions(-)
```

另有两个新文件：`renderdoc_extension/services/mesh_service.py`（`get_mesh_data`）、`scripts/replay_check.py`（脱离界面跑服务层的检查脚本，没拷过来）。
大致内容：`get_mesh_data`、`save_texture`、`pick_pixel`、`get_texture_stats`；`get_buffer_contents` / `get_texture_data` 的 `event_id` 与大小上限；`list_captures` 的 `recursive`；
常量缓冲按类型解码、标出着色器没读的常量；RenderDoc 1.32+ 的管线状态接口；IPC 回应原子替换、不能序列化时回错误、请求串行。

### 本目录相对 `ignore/RenderDocMCP` 的改动

- `renderdoc_worker/services/`、`renderdoc_worker/utils/`：原样拷来，逐字节相同（`pipeline_service.py` 在源处就是 CRLF）。
- `renderdoc_worker/renderdoc_facade.py`：只改 `_invoke`，直接把 controller 交给回调。
- `renderdoc_worker/request_handler.py`：加 `close_capture`，第 3 批加 `target_find` / `target_status` / `target_capture` / `target_inspect`。
- 新增 `renderdoc_worker/context.py`（ctx 垫片）、`renderdoc_worker/worker.py`（常驻循环）、`renderdoc_worker/target.py`（抓帧控制）。
- `mcp_server/server.py`：19 个工具的名字、参数、缺省值与说明不变，后端改调 `mcp_server/replay.py`；另加 `close_capture`、`show_in_renderdoc`。
- 新增 `mcp_server/replay.py`（工作进程客户端）、`mcp_server/paths.py`。
- 不拷：界面扩展部分（`renderdoc_extension/__init__.py`、`socket_server.py`、`extension.json`）、`scripts/install_extension.py`、`mcp_server/bridge/`、`mcp_server/config.py`。

## 结构

```text
mcp_server/          MCP 服务端（uv 的 Python ≥ 3.10）
  server.py          工具注册
  replay.py          工作进程客户端：拉起、请求、超时与退出后重启、退出时关闭
  paths.py           仓库根、状态目录、qrenderdoc / WPE 位置
  wpe/               第 2 批：常驻共享的 WPE（ensure_running、restart_wpe）、本会话的测试窗口与机器级窗口表、
                     config.json 读写、log.txt 游标（计划见 wpe-renderdoc-mcp-p2.md）
    capture.py       第 3 批：capture、capture_wallpaper、capture_sweep，抓帧锁里调工作进程的 target_*
renderdoc_worker/    在 qrenderdoc --python 里跑（RenderDoc 内嵌的 Python 3.8）
  worker.py          常驻循环
  context.py         ctx 垫片：服务层用到的 CaptureContext 子集，背后是裸 ReplayController
  target.py          第 3 批：连 RenderDoc 目标（不抢占）、认窗口、触发、逐张核对、另开回放核对
  request_handler.py renderdoc_facade.py services/ utils/
```

**`kbp-tools` 把服务层当库用：** `.claude/skills/kbp-tools/rdc/bridge.py` 在它自己拉起的 `qrenderdoc --python` 里直接 import
`renderdoc_worker` 的 `ReplayContext`、`RenderDocFacade`、`RequestHandler`，依赖 `handle()` 的返回形状（`{"id", "result"}` 或
`{"id", "error": {"code", "message"}}`），批量提取轨迹、整帧图、统计量，不经 MCP、不经 IPC。改这三个类或返回形状时同步
`bridge.py`，并跑一遍 `python -X utf8 -I .claude/skills/kbp-tools/tests/accept1.py`。

## 工作方式

- 第一次调用工具时，MCP 拉起 `qrenderdoc --python renderdoc_worker/worker.py`。`--python` 的脚本在主界面出现之前运行，
  脚本不返回，界面就不会出现，所以这个进程没有窗口，也不碰用户开着的 RenderDoc。
- 每个 MCP 进程一个私有 IPC 目录 `.kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/`：
  `request.json` / `response.json`（都先写 `.tmp` 再 `os.replace`）、`ready.json`、`owner.json`、`worker.log`。
- 工作进程握着 MCP 进程的句柄，MCP 没了就自己退出并删掉这个目录；MCP 正常退出时也会关掉它、删目录。
  MCP 启动时删掉所属进程已不在的残留目录。
- 超时（默认 120 s，`RENDERDOC_MCP_TIMEOUT`）或工作进程退出：结束这个进程，下次调用重新拉起，
  结果里带 `worker_restarted`、`capture_lost`、`restart_reason`。
- RenderDoc 安装目录取环境变量 `RENDERDOC_DIR`，缺省 `C:\Program Files\RenderDoc`。

入口在仓库根的 `.mcp.json`：

```json
"wpe-renderdoc": { "command": "uv", "args": ["--directory", ".claude/mcps/wpe-renderdoc", "run", "wpe-renderdoc-mcp"] }
```
