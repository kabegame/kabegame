# wpe-renderdoc MCP：常驻共享的 WPE，「确保在跑 → 开窗 → 抓帧 → 打开 rdc → 分析」

> 来源：2026-11-08 的基建工具盘点（本地存档 `ignore/tools-inventory.md`）与 2026-11-09 对 `wpe-renderdoc` 的接口分类。用户定（2026-11-09）：
> - **形态：** 这一侧也是有状态的。把 RenderDocMCP vendor 进仓库，放 `.claude/mcps/`，做成一个 MCP。
> - **范围：** 专做「确保 WPE 在跑 → 开窗口 → 抓帧 → 打开 rdc → 分析」这条工作流。测试工程的生成与比较另做 `kbp-tools` skill，本计划不做。
> - **自动、无感、不弹窗：** 用户电脑上的 WPE 在不在运行都要无感。弹窗会抢焦点，强杀后的「上次可能崩溃」还要用户点取消。
>   - 2026-11-10 补充：测试窗口占前台可以接受。不能弹出来抢前台的是 WPE 的主窗口，比如浏览界面、安全启动提示。
> - **可以操作用户正在开的 WPE。**
> - **不兼容旧命令行。** 完全迁移之前，旧 skill（`.claude/skills/wpe-renderdoc/`，含 `driver.py`、`target.py`）和旧 MCP（`.mcp.json` 的 `renderdoc`，指向 `ignore/RenderDocMCP`）原样保留，新旧并存。
> - **不做现场还原，减少复杂度。** 用户接受对 WPE 设置的更改；壁纸、工程与工坊内容照旧不改。
> - **语义是 `ensure_running`，常驻共享，不关不杀**（2026-11-09 晚，取代同日早些时候的「抓完就释放」）：
>   - 一般情况下确保 WPE 在跑、能抓，然后抓；
>   - 多个会话可以同时抓，各自在自己的回放实例里打开、分析；
>   - 不关、不杀 WPE。
> - 先写计划，不动手。

## 总体设计思路

现在拿 WPE 真值要用两样互不相通的东西。`wpe-renderdoc` 命令行（`driver.py`）管 WPE 进程和抓帧，要求用户先从托盘退出 WPE，结束时只能强杀，下次启动就弹「上次可能崩溃」，而且同一时刻只能有一个会话用。RenderDocMCP 读 `.rdc`，必须开着 RenderDoc 界面，经全局固定的 `%TEMP%\renderdoc_mcp` 和界面里的扩展交换请求，两个会话同时用会互相覆盖。

改造后，WPE 变成一份常驻、各会话共享的资源，每个 Claude 会话的 MCP 只持有自己的窗口和自己的回放进程。核心是 `ensure_running`：WPE 已在跑、已被注入，就直接用；在跑但没注入，就用 `renderdoccmd inject --PID` 原地注入，0.3 秒，不重启；没在跑，就照用户自己启动的方式 `-silent` 普通启动，等桌面壁纸出来再注入。MCP 从不退出、也不强杀 WPE，注入的 `renderdoc.dll` 一直留在 WPE 里，直到用户自己重启它。这一切成立的前提都已实测：WPE 给每个 `-playInWindow` 窗口新建 D3D 设备，所以注入之后开的窗口都抓得到；注入前已有的桌面壁纸设备不被挂上，桌面上没有叠加文字；一次注入可以反复开窗、反复抓（步骤 0 的实测记录二、三）。

每个会话只开、只关自己的测试窗口，窗口名带会话标识，登记在机器级的窗口表里，桌面壁纸一律不碰。抓帧要连 RenderDoc 的目标，目标连接是独占的：别的客户端连着时，不抢占的连接会被拒，抢占（`force=True`）会把对方踢掉。所以抓帧在一把机器级的锁里做，锁只覆盖「连接 → 选中自己的窗口 → 触发 → 收文件 → 断开」这几秒，回放分析不在锁里，各会话的回放进程互不相干，可以同时分析。RenderDoc 一次只抓「活动窗口」，活动窗口是目标进程里的共享状态：第一个注册的窗口默认活动，`CycleActiveWindow` 轮到下一个，跨连接保留。抓帧消息里的缩略图尺寸等于窗口尺寸，于是选窗口的办法是：只有一个可抓窗口时直接抓；多于一个时先抓 1 帧探测，尺寸不是自己的就删掉探测文件、切换、再探，最多探一轮。同一时刻不允许两个会话开同样尺寸的窗口，否则分不清。

设置（`fps`、后处理档位）是 WPE 全局的，改了会影响所有会话和用户的桌面，需要重启才生效的设置又和「不关不杀」冲突。这部分先不进常规流程：Q5 查清哪些键能运行中生效，能就地改的给一个显式工具，并在结果里报出；要重启的另议（决定 4，待定）。

**工具分三层：**
- **原子：** `ensure_running`、自己的窗口、日志、抓帧、回放分析。每个只做一件事，输出 JSON。
- **组合：** `capture_wallpaper` 一步做完「确保在跑 → 开自己的窗口 → 等到在呈现 → 记日志游标 → 抓帧 → 关自己的窗口 → 截日志 → 在自己的回放进程里打开第一张 rdc」。
- **状态：** `status`。

**几个关键决定：**
- **用 Python。** vendor 来的代码是 Python（FastMCP，uv 管依赖），`driver.py` 也是 Python，Win32 调用用 ctypes。工作进程里的代码要兼容 RenderDoc 内嵌的 Python，和 MCP 服务端分目录放。
- **没有会话归属，只有窗口归属和抓帧锁。** 状态目录 `.kabegame/debug/wpe-renderdoc-mcp/`：
  - `windows/<窗口名>.json`：所属 MCP 的进程号与启动时刻、工程、尺寸、hwnd；
  - `target.lock`：抓帧锁，用系统文件锁，持有进程死了自动放开；
  - 每个 MCP 的回放进程有自己的 `ipc/<MCP 进程号>/`。
- **WPE 的生命周期不归 MCP 管。** 常规流程里没有退出、没有强杀。唯一会改动 WPE 状态的是 `ensure_running` 的启动与注入：
  - WPE 没在跑、崩溃标记却是 1（上次被强杀或崩溃）时，启动前把标记写成 0，避免弹窗，并在结果里报出；
  - WPE 以管理员权限运行时注入会失败，报出来，不提权。
- **MCP 退出时只关自己的窗口。** 发现所属进程已经不在的窗口（陈旧窗口），任何 MCP 在 `ensure_running` / `status` 时都会顺手关掉，免得一直在后台渲染。
- **不认识测试工程的约定。** 帧号 / 时钟图层解码、`kbp-meta.json`、`[kbp]` 日志转 dt、粒子轨迹提取，都留给以后的 `kbp-tools`。
- **安全规则：**
  - 不退出、不强杀 WPE；
  - 连目标一律不抢占（`force=False`），被拒就报「目标被别的客户端连着」；
  - 只关自己的窗口和陈旧窗口，不碰桌面壁纸；
  - 改过的设置逐项报出，不静默改；
  - 不改用户的壁纸、工程与工坊内容；
  - 清理只动仓库 `ignore/` 下的测试工程目录。
- **新旧并存，互不兼容。**
  - 新 MCP 不引用、也不修改 `driver.py` 和旧 MCP。要用的代码（`target.py`、`resolve_project` 等）拷过来，旧的不动。状态目录分开。
  - 常驻之后 WPE 基本总在跑，旧 `rd start` 会因此拒绝，旧 skill 实际上只有用户从托盘退出 WPE 后才能用。
  - 旧 skill 的 `state.json` 在，说明旧会话正在用它自己注入启动的 WPE，旧 `stop` 会把它强杀。这时新 MCP 拒绝 `ensure_running`，并说明原因。
  - 旧 `target.py` 连目标用的是 `force=True`。它只连自己会话的 WPE，和新 MCP 的目标碰不到一起。
  - `.mcp.json` 新增 `wpe-renderdoc`，旧的 `renderdoc` 保留。

## 现状锚点

**a. 用户的 WPE 在跑就拒绝**（`.claude/skills/wpe-renderdoc/driver.py:123`）
```python
def cmd_start(args):
    running = wpe_pids()
    if running:
        die(f'WPE 正在运行（PID {running}）。这个工具不结束别人启动的进程，请先从托盘退出')  # 现状：要用户手动退出
    shutil.copy2(CONFIG, BACKUP)
    apply_settings(args.set)                     # 现状：只能在启动前改 config.json，换档要重启
    spawn_detached(f'"{RENDERDOCCMD}" capture -d "{WPE_DIR}" -c "{TEMPLATE}" "{WPE_EXE}" -silent', WPE_DIR)
```

**b. 结束只能强杀**（`driver.py:300`）
```python
def cmd_stop(args):
    if pid in wpe_pids():
        # 只能强杀：WPE 没有退出命令，也不响应 WM_CLOSE
        subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True)   # 现状：下次启动弹「上次可能崩溃」
    shutil.copyfile(BACKUP, CONFIG)
    if args.relaunch:
        spawn_detached(f'"{WPE_EXE}" -silent', WPE_DIR)
        report['wallpaper'] = restore_wallpaper()   # 现状：等 12 秒没有桌面窗口，就按备份 openWallpaper 放回去
```

**c. 打开壁纸固定等待**（`driver.py:172`）
```python
    control(f'openWallpaper -file "{path}" -playInWindow "{args.window}" -width {width} -height {height}')
    time.sleep(args.wait)     # 现状：命令发出就返回，按场景大小猜秒数
```

**d. 每次碰 RenderDoc 都临时起一个 qrenderdoc**（`driver.py:84`；`target.py:131`）
```python
def in_renderdoc(action, limit, **params):
    subprocess.run([QRENDERDOC, '--python', os.path.join(HERE, 'target.py')], env=env, timeout=limit)  # 现状：一次一个进程
# target.py：find / status / capture / inspect，结果写文件后 os._exit(0)
```

**e. RenderDocMCP 依赖界面扩展和全局目录**（`ignore/RenderDocMCP/renderdoc_extension/socket_server.py:15`；`renderdoc_facade.py:47`）
```python
IPC_DIR = os.path.join(tempfile.gettempdir(), "renderdoc_mcp")   # 现状：全机一个目录，谁都往里写
    def _invoke(self, callback):
        self.ctx.Replay().BlockInvoke(callback)                     # 现状：要界面的 CaptureContext
```

**f. service 已能脱离界面运行**（`ignore/RenderDocMCP/scripts/replay_check.py:27`）
```python
class Ctx:
    """The part of CaptureContext the services use, backed by a bare ReplayController"""
    def IsCaptureLoaded(self): return True
    def GetAction(self, event_id): return self.actions.get(event_id)
    def GetResourceName(self, resource_id): return ""     # 现状：只补了 Mesh / Pipeline / Resource 三个 service 用到的
```
service 用到的 ctx 方法：`IsCaptureLoaded` 16 处、`GetResourceName` 5、`GetAction` 2、`GetCaptureFilename`、`LoadCapture`、`Replay` 各 1。

**g. MCP 入口**（`.mcp.json`）
```json
"renderdoc": { "command": "uv", "args": ["--directory", "ignore/RenderDocMCP", "run", "renderdoc-mcp"] }
```

**h. WPE 可执行文件里的线索**（只读扫描 `wallpaper64.exe`，2026-11-09）
- `-control` 的命令：`openWallpaper`、`closeWallpaper`、`applyProperties`、`getWallpaper`、`pause`、`play`、`stop`、`mute`、`unmute`、`nextWallpaper`、`openPlaylist`、`openProfile`、`revealWallpaper`、`hideIcons`、`showIcons`；
- 参数：`-file`、`-location`、`-monitor`、`-playInWindow`、`-width`、`-height`、`-borderless`、`-activate`、`-pipe`、`-preset`、`-workshopid`；
- 启动参数：`-silent`、`-nowallpapers`、`-showbrowse`、`safemode`；
- 词条 `core_msgbox_init_secondinstance_ask_quit`，日志「Failed to terminate existing process without window. STARTING ANYWAY.」：第二个实例启动时会尝试结束旧进程。
- 没找到 `quit` / `exit` 这类控制命令。崩溃提示的判据不在这个文件的英文字符串里。

**i. 用户实测**（2026-11-09）
- 已经在跑、没经 RenderDoc 注入的 WPE 抓不到帧。
- `-silent` 启动：
  - 已经有 WPE 进程时，界面会弹起来；
  - 没有进程、上次正常退出时，静默启动；
  - 上次被强杀时，即使现在没有进程，也会弹起界面，并弹「上次可能崩溃」。
- 所以起点 A 不能靠再启动一个 `-silent` 实例；强杀之后必须先清掉崩溃标记，或者干脆不强杀。
- 补充：当时在跑的 WPE 命令行是 `wallpaper64.exe  -slient`（拼错，只读查询 `Win32_Process` 得到）。按读码，已有实例时正确拼写的 `-silent` 会直接退出、什么都不做；拼错时走「转给已有实例打开浏览界面」的分支。第一条现象多半由此而来，待实验 E5 第 1 步确认。

**j. 读码结论：怎么判断上次正常退出**（[rea-wpe-exit.md](rea-wpe-exit.md)，2026-11-09，静态读码，未实测；Claude 抽查过地址与注册表值）
- **崩溃标记：** `HKCU\Software\WallpaperEngine\faultyShutdown`（REG_DWORD）。
  - 启动时读到 1，且 `general.user.safemode` 不为 false，就补上 `-nowallpapers -showbrowse`：弹浏览界面和安全启动提示，不加载壁纸；
  - 读完无条件写 1（`0x14000c311`）；
  - 消息循环正常结束写 0（`0x14000c709`），注销 / 关机时也写 0。
  - 「强杀后不自动加载壁纸」也是这个机制。弹窗走的这条路径不看 `-silent`。
- **正常退出可以从外部触发：** 托盘「退出」的命令号是 `0x9c4a`，处理函数只做 `PostMessageW(WM_QUIT)`（`0x140024f1d`）。事件窗口类名 `WPEEventWindow`，不可见、没有标题。外部 `PostMessageW(FindWindowW(L"WPEEventWindow", NULL), WM_COMMAND, 0x9c4a, 0)` 应能正常退出；WPE 自带的 `apputil32.exe -closewe` 也是发 `WM_QUIT`。
- **强杀的补救：** 进程消失后、下次启动前，把 `faultyShutdown` 写成 0（`launcher.exe` 更新时就这么做）。预期下次 `-silent` 启动不弹窗，壁纸照常自动加载。
- **普通的第二个实例不能和用户的 WPE 并存。** 唯一线索是 `-screensaver -preview -host <窗口>` 的屏保预览实例：它跳过互斥体和崩溃标记，但显示的是屏保配置的壁纸，能不能换成测试壁纸、能不能控制都不清楚（实验 E8）。

## 步骤 0 — 调研（实测为主，不改代码）

用户允许操作正在运行的 WPE，也接受实验对它的设置的更改。实验前备份一次 `config.json`，结果里写明改了什么。二进制读码交给子代理（REA）。实验脚本在 `ignore/wpe-mcp/exp/`（`exp.py`、`target2.py`），记录见下面三节。

**状态（2026-11-09 晚）：** 决定方向的几题已经实测答完，常驻方案可行。剩下的几题不挡步骤 1，按批次在步骤 2 之前做完。

| # | 问题 | 状态 |
|---|---|---|
| Q1 | **正常退出：** 向 `WPEEventWindow` 发 `WM_COMMAND 0x9c4a` | **已答**（记录二）：注入过的进程 1.8 s 退出，标记归 0。常驻方案的常规流程不用它，留给 `restart_wpe`（待定） |
| Q2 | **崩溃提示：** `faultyShutdown` | **已答**（记录一）：强杀后写 0 再启动，不弹窗，壁纸自动加载。`ensure_running` 启动前遇到 1 就这样做 |
| Q3 | **第二个实例** | 不再需要：常驻方案不起第二个实例 |
| Q4 | **原地注入后新开的窗口能不能抓** | **已答**（记录二）：能，WPE 每个窗口一个设备；桌面设备不被挂上 |
| Q5 | **运行中改设置** | **读码已答**（[rea-wpe-settings.md](rea-wpe-settings.md)，未实测）：<br>· `config.json` 只在启动时读，没有文件监视；运行中外部改文件不生效，而且 WPE 下一次保存时会用内存里的值整段覆盖回去。<br>· 设置界面经命名管道 `WPEhandlerSettings` 把整份 `general.user` 发给主进程（每改一项发一次 `applyGeneral`，点「确定」才写文件）。<br>· 主进程收到后：`fps` 等就地推给桌面壁纸；`msaa`、`resolution`、`postprocessing` 等会关掉全部桌面壁纸再重开；`safemode`、`windowupdaterate` 等只在启动时读。<br>· 已开的 `-playInWindow` 窗口不受影响，新开的窗口按当时内存里的值建。<br>· 外部没有现成入口：`-control` 没有设置命令；管道只在设置界面开着时存在，且被界面占着。唯一能就地改的办法，是往 WPE 进程内存写消息再发内部消息 `0x401`，有崩溃风险。<br>待实测：报告的 E5（正常退出不写文件、外部改文件后重启生效）是 `restart_wpe` 的前提 |
| Q6 | **不弹窗、不抢焦点** | 大部分已答：<br>· `-silent` 启动、注入、开关窗都不弹 WPE 主窗口（记录一、二，第 2 批共 8 次启动）；<br>· `renderdoccmd` 必须用 `CREATE_NO_WINDOW` 或 `ShowWindow=0` 起，否则会弹 Windows Terminal 抢前台；<br>· 常驻回放进程没有任何窗口（第 1 批）；<br>· 测试窗口会在开窗几秒后抢前台，用户 200 s 内有输入时抢不走（`ForegroundLockTimeout`）。用户定：可以接受（第 2 批实施记录）。<br>待做：窗口移到屏幕外或被遮住时 WPE 还画不画、还抓不抓得到（第 3 批） |
| Q7 | **多个可抓窗口时选中自己的** | **已答**（记录一、三）：活动窗口是目标里的共享状态，第一个注册的默认活动，`CycleActiveWindow` 轮到下一个、跨连接保留；`NewCapture` 的缩略图尺寸等于窗口尺寸，不用回放就能认 |
| Q8 | **常驻回放进程：** 长时间循环、反复开关 rdc 是否稳定；ctx 垫片要补哪些方法；内嵌 Python 版本 | 待做 |
| Q9 | **陈旧窗口回收：** MCP 被强行结束后，另一个 MCP 按窗口表认出所属进程已死的窗口并关掉 | 待做 |
| Q10 | **叠加文字：** 测试窗口左上角的 RenderDoc 叠加文字能不能关 | 待做。只影响测试窗口；桌面设备没被挂上时桌面没有 |
| Q11 | **`-nowallpapers`** | **已答**（记录二）：不改选中的壁纸。常驻方案不用它 |
| Q12 | **并发：** 两个 MCP 同时抓。抓帧锁的等待时间；探测抓帧给别的会话窗口带来的长帧，对它们的日志 dt 有多大影响 | 部分已答（记录三）：目标连接独占，不抢占的连接被拒、不影响已连着的。待做：两个真实进程交错抓 |
| Q13 | **桌面设备被重建：** 注入后用户换壁纸或显示器变化，新的桌面设备会不会被挂上；挂上后叠加文字与内存开销。要换一次桌面壁纸（关掉再按原工程打开，`config.json` 可能少一行 `"layout": null`） | 待做 |

**验收：** 每题给结论和证据。有做不到的，停下来报用户。

### 实测记录（2026-11-09 20:00，用户定方向后）

**当时用户定的方向（已被常驻方案取代，见总体设计）：** WPE 在跑就先强杀、把 `faultyShutdown` 写成 0，再经 RenderDoc 注入启动；没在跑就直接注入启动；启动一律带 `-silent`。

**脚本：** `ignore/wpe-mcp/exp/exp.py`，含 `snap`、`watch`、`kill`、`clear`、`spawn [--injected]`、`control`、`rd`；`rd` 复用旧 skill 的 `target.py`。观察器每 100 ms 记录新出现的可见顶层窗口（任何进程）和前台切换，记录在 `ignore/wpe-mcp/exp/work/watch-1.ndjson`。抓帧在 `A:\wpe-mcp\exp-kill-restart\`。

**起点：** 用户的 WPE 以拼错的 `-slient` 启动，被杀过一次，所以开着浏览界面、桌面没有壁纸，标记为 1。选中的壁纸是 Monitor0 的 2833452727。

| 步骤 | 结果 |
|---|---|
| 1. 强杀用户的 WPE，`faultyShutdown` 写 0，WMI 起 `renderdoccmd capture … wallpaper64.exe -silent`（`renderdoccmd` 的控制台设成 `ShowWindow=0`） | 2.8 s 起进程，同时桌面壁纸自己加载；没有 `wallpaperui`，没有安全启动提示；标记由 WPE 写回 1。t≈29 s 托盘溢出面板曾拿到前台，随后依次切到任务栏、RenderDoc、VS Code，像是人在点；第 5 步普通启动时没有再出现，暂按人为操作记 |
| 2. `-control openWallpaper … -playInWindow KBT -width 1280 -height 720` | 窗口类 `WPEOverlappedWallpaper`，**不抢前台**，但它是普通的可见窗口，盖在屏幕上（Q6 的屏幕外 / 最小化还没测） |
| 3. 两个交换链（桌面 + 窗口）时抓 1 帧 | 可抓窗口数为 2。`cycle 0` 抓到桌面（后备缓冲 3840×2160，3 个绘制，112 MB）；`cycle 1` 抓到窗口（1280×720，1 个绘制 1200 索引，与 shimmering_particles 相符）。所以只开窗口、不关桌面也能抓，要靠回放核对尺寸选对交换链（Q7） |
| 4. `closeWallpaper -location KBT` | 窗口关掉，桌面壁纸不受影响，`config.json` 逐字节不变 |
| 5. 强杀注入实例并写 0（即起点 B 的终态） | 进程没了，`wallpaperui` 没有残留，标记 0 |
| 6. 普通 `-silent` 启动（即起点 A 的终态，也等于起点 B 之后用户下次自己启动） | 2.7 s 壁纸自己加载，不弹窗、不切前台 |

**实验后观察器顺带录到的（同一份 `watch-1.ndjson`，t = 412–600 s）：**
- **托盘退出会把标记写回 0：** 用户从托盘菜单退出 WPE（`#32768` 菜单 → `WPETrayWindow`），1.2 s 后进程退出，`faultyShutdown` 为 0。这印证了锚点 j 的正常退出路径（Q1 的一半）。
- **旧 driver 起 `renderdoccmd` 会闪控制台、抢焦点：** wpe 4d 会话用 `driver.py start` 时，Windows Terminal 弹出一个标题为 `renderdoccmd.exe` 的窗口，拿了约 1.4 s 前台。本次 `exp.py` 给 WMI 传了 `Win32_ProcessStartup.ShowWindow=0`，没有出现窗口（Q6）。新 MCP 必须这样起。
- **那个会话开的 `-playInWindow` 窗口每个都拿到了前台**（4 个窗口，各约 20 s 后回到 VS Code），本次的 KBT 窗口没有。推测是控制台窗口拿过前台，WPE 作为它的子进程继承了设前台的权利；但对方的开窗命令和采样脚本没核对，不能下结论。新 MCP 起 WPE 时不经过可见窗口，再测一次开窗抢不抢前台。

### 实测记录二：注入已在运行的 WPE（2026-11-09 20:20 左右）

用户要求：能注入已有进程就不杀；启动也改成先普通启动、再注入。`exp.py` 新增 `inject --pid`（`renderdoccmd inject --PID=<pid> -c <模板>`，用 `CREATE_NO_WINDOW` 跑，注入完就返回）和 `quit --pid`（向该 PID 的 `WPEEventWindow` 发 `WM_COMMAND 0x9c4a`）。观察器记录在 `work/watch-2.ndjson`，抓帧在 `A:\wpe-mcp\exp-inject-running\` 和 `A:\wpe-mcp\exp-start-then-inject\`。

| 步骤 | 结果 |
|---|---|
| 注入已运行 15 分钟、带桌面壁纸的 WPE（PID 437564，普通 `-silent` 启动） | 0.3 s 完成，`renderdoc.dll` 已加载，进程照常运行，桌面壁纸不受影响 |
| 连上目标 | 没有 API，可抓窗口数为空：桌面壁纸的设备是注入前建的，没被挂上，所以桌面上也不会有叠加文字 |
| 开 `-playInWindow` 1280×720 窗口 | 出现 D3D11，`presenting` 真，可抓窗口数为 1：WPE 给每个窗口新建设备（Q4 答了）。连续抓 3 帧（506–508）不缺帧，回放为 1280×720、1 个绘制、1200 索引。窗口不抢前台 |
| 关窗后再开 960×540 窗口 | 关窗后 `supported` 为假、窗口数为空；再开又是 1，抓到 960×540。一次注入可以反复用 |
| 对注入过的进程发正常退出 | 1.8 s 退出，`faultyShutdown` 为 0，没有界面进程残留（Q1、E7 答了） |
| 起点 B：普通启动 `-silent -nowallpapers` → 注入 → 开窗 → 抓 → 关窗 → 正常退出 | 桌面不出壁纸，抓到 1280×720；退出用 2.1 s，标记为 0；`config.json` 逐字节不变 |
| 再普通 `-silent` 启动 | 2.6 s 原壁纸自己加载：`-nowallpapers` 不改写选中的壁纸（Q11 答了） |

- **权限：** 用户的 WPE 没开自启（`autostart`、`autostartscheduler` 都是 false），是手动以普通权限启动的。如果以后开了计划任务方式的自启，WPE 可能以管理员权限运行，注入和退出消息都会失败，届时要能识别并报出（E6）。
- **全程没有弹窗、没有抢前台。** 观察器里 t≈130 s 托盘溢出面板拿到过一次前台，当时没有任何 WPE 操作，按人为操作记。
- **没测：** 对已注入的进程再注入一次。新 MCP 先按 PID 在 `EnumerateRemoteTargets` 里找现成的目标，找不到才注入，就避开了这个问题。
- **预计的副作用（没测）：** 注入后 `renderdoc.dll` 一直留在用户的 WPE 里，直到它重启。这期间如果桌面壁纸被重建（用户换壁纸、显示器变化），新设备会被挂上：桌面左上角出现叠加文字，RenderDoc 还会记录资源上传，多占内存。

**当时由此得出的流程（已被常驻方案取代：不再释放，WPE 保持运行、保持注入）：**
- **起点 A（在跑）：** 注入现有 PID → 开窗 → 抓 → 关窗。当时考虑的释放有两种做法：
  - 保留注入：桌面完全不中断，代价是上面的副作用；
  - 正常退出后普通 `-silent` 重启：桌面空约 4–5 s，进程干净。
- **起点 B（没跑）：** 普通启动 `-silent -nowallpapers` → 注入 → 开窗 → 抓 → 关窗 → 正常退出。
- **兜底：** 只有正常退出超时才强杀，并在下次启动前把标记写 0。

**结论（实测记录一）：** 两种起点的终态都做得到，全程没有 WPE 的弹窗，也没有抢焦点。代价是起点 A 桌面会空两次（各约 3 s），注入期间桌面左上角有 RenderDoc 叠加文字。旧 driver 的 `stop --relaunch` 不清标记，强杀后直接重启会弹安全启动提示，新 MCP 的释放必须先写 0 再启动。实验后 WPE 是 PID 462264（20:04:38 普通 `-silent` 启动，壁纸在），`config.json` 与实验前逐字节相同。

### 实测记录三：多个窗口与并发连接（2026-11-09 20:40 左右）

WPE 是 PID 452412（普通 `-silent` 启动，桌面壁纸在），先注入它（即 `ensure_running` 的「在跑但没注入」）。`target2.py` 是 `target.py` 的实验版：抓帧消息带缩略图尺寸，连接默认不抢占，客户端名可指定，另有 `hold`（连上占住 N 秒）。抓帧在 `A:\wpe-mcp\exp-multi\`，观察器记录在 `work/watch-3.ndjson`。

| 步骤 | 结果 |
|---|---|
| 先后开 KBA（1280×720）、KBB（800×800） | 可抓窗口数为 2 |
| 依次按切换 0、1、0、1 次各抓 1 帧 | 依次是 KBA、KBB、KBB、KBA：第一个注册的窗口默认活动；切换一次轮到下一个；活动窗口跨连接保留 |
| 看 `NewCapture` 消息 | 缩略图尺寸 `[800, 800]`，等于窗口尺寸，不用回放就能认出抓到的是哪个窗口 |
| A 以不抢占方式连上并占住 15 s，期间 B 以不抢占方式读状态、抓帧 | B 两次都立刻收到 `Disconnected`（不是 `Busy`）；A 占满 15 s，没受影响 |
| 关掉 KBA、KBB | `supported` 为假，窗口数为空；WPE 保持运行、保持注入，桌面壁纸在，`config.json` 与实验前逐字节相同 |

- **抓帧要串行：** 连接独占，同时抓的两个会话必有一个被拒，所以要有机器级的抓帧锁。旧 `target.py` 的 `force=True` 会把正在抓的另一方踢掉，新 MCP 一律不抢占。
- **选窗口不靠回放：** 多于一个可抓窗口时，探测 1 帧看缩略图尺寸，不对就切换再探。探测会让被探到的那个窗口出现一次长帧。
- **现在的状态：** WPE 是 PID 452412，带着注入，没有测试窗口。

## 步骤 1 — vendor 与无界面回放进程（不碰 WPE）

- **新增** `.claude/mcps/wpe-renderdoc/`：从 `ignore/RenderDocMCP` 拷来（原处不动，旧 MCP 继续用它），含上游 `LICENSE`（MIT）和本地改动。`README.md` 记来源：上游 `11b6b74`、本地改动的内容、以后不跟上游。`.venv/`、`__pycache__/` 不入库。目录：
```text
.claude/mcps/wpe-renderdoc/
  pyproject.toml  uv.lock  LICENSE  README.md
  mcp_server/            # MCP 服务端（uv 的 Python）
    server.py            # 工具注册
    replay.py            # 工作进程的客户端：启动、心跳、超时重启、退出时关闭
    wpe/                 # 步骤 2
  renderdoc_worker/      # 在 qrenderdoc --python 里跑（兼容内嵌 Python）
    worker.py            # 常驻循环：读请求、分派、写回应
    context.py           # ctx 垫片：照 replay_check.py 扩全 service 用到的方法
    target.py            # 抓帧控制（从 skills/wpe-renderdoc/target.py 拷来，旧的不动）
    services/  utils/    # 从 renderdoc_extension/ 拷来
```
- **新增** `worker.py`：
  - 请求目录 `.kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/`，一次一个请求、原子替换回应，沿用 `socket_server.py` 的文件协议；
  - 请求种类：
    - `open_capture` / `close_capture`：用 `rd.OpenCaptureFile` 持有 controller；
    - 各 service 方法；
    - `target_find` / `target_status` / `target_capture` / `target_inspect`：现在 `target.py` 的四个动作，连目标一律不抢占（步骤 3）；
  - 父进程（MCP）没了就自己退出：每轮检查 MCP 进程号还在不在。
- **修改** 回放工具：原 `server.py` 的 19 个工具（`get_draw_calls`、`get_shader_info`、`get_mesh_data`、`get_pipeline_state`、`save_texture`、`pick_pixel` 等）一对一保留名字和参数，改经 `replay.py` 发给工作进程。新增 `close_capture`。
- **不 vendor**：界面扩展的注册与轮询（`renderdoc_extension/__init__.py`、`socket_server.py`、`extension.json`）、`scripts/install_extension.py`。过渡期要在界面里看，继续用旧 MCP。另给一个 `show_in_renderdoc(path)`：用户明确要看时，用 RenderDoc 界面打开文件，会弹窗。
- **修改** `.mcp.json`：新增一项，旧的 `renderdoc` 保留：
```json
"wpe-renderdoc": { "command": "uv", "args": ["--directory", ".claude/mcps/wpe-renderdoc", "run", "wpe-renderdoc-mcp"] }
```
  加完由用户 `/mcp` 重连。依赖由 uv 装在这个目录自己的 `.venv` 里，不碰根目录的 `node_modules`，dev 在跑时也能装。
- **新增** MCP 的 `instructions`（同 kabegame-dev 的写法）：说明它和旧 `renderdoc` 的区别（不用开 RenderDoc 界面、会话私有），两边工具同名时用哪一边。

**验收：**
- 对 `A:\` 下现有的几张 rdc（P4b、P4c 的抓帧），19 个工具逐个和旧界面桥的结果比，JSON 相同。允许的差别逐条列出，比如资源名：垫片拿不到界面里的资源名。
- 过程中没有新的顶层窗口，前台窗口不变；用户开着的 RenderDoc 不受影响。
- MCP 退出后工作进程在 2 秒内退出；工作进程被结束后，下一次调用自动重启并报出来。

## 步骤 2 — 常驻 WPE、自己的窗口与日志

- **新增** `mcp_server/wpe/`：
  - `process.py`：WPE 进程枚举与权限检查；崩溃标记读写；普通 `-silent` 启动（经 WMI，跨 MCP 进程存活）；`renderdoccmd inject --PID`（`CREATE_NO_WINDOW`）；按 PID 在 `EnumerateRemoteTargets` 里找现成的目标。
  - `registry.py`：窗口表（`windows/<窗口名>.json`）、抓帧锁（`target.lock`，系统文件锁）、陈旧窗口判定（所属进程号不在，或进程号被复用、启动时刻对不上）。
  - `control.py`：`-control` 命令。没有主实例时拒绝发，否则控制进程会自己变成主实例并弹界面。
  - `windows.py`：桌面壁纸窗口与测试窗口的枚举（`WPEDesktopDX11Window` 挂在 WorkerW 下，`WPEOverlappedWallpaper` 是顶层窗口）；等窗口出现；不激活窗口。
  - `log.py`：日志游标。WPE 重启、日志被截断时报出来，不静默从头读。日志是各会话共用的，行里不带窗口名，`log_since` 只能按时间段截，多个会话同时开窗时会混进别人的行，结果里注明。
  - `projects.py`：解析工程，照 `driver.py` 的 `resolve_project` 写（拷来，旧的不动）。
- **`ensure_running()` 的判定顺序：**
  1. 旧 skill 的 `state.json` 在：拒绝，说明旧会话正在用它自己启动的 WPE。
  2. 没有 `wallpaper64`：崩溃标记为 1 就先写 0；WMI 普通启动 `-silent`；等到桌面壁纸窗口出现、再稳 2 s；注入。
  3. 有 `wallpaper64`、没有目标：注入。
  4. 有目标：直接用。
  5. 注入后、开自己的窗口前，读一次可抓窗口数，记下已有的（正常为空；桌面设备被挂上时这里能看到，见 Q13），之后选窗口时把它们算作别人的。
  6. 顺手关陈旧窗口。

  结果报做了哪几步（直接用 / 注入 / 启动并注入 / 清了崩溃标记 / 关了哪些陈旧窗口），以及 WPE 的 PID、目标、已有的可抓窗口。
- **新增工具：**

| 工具 | 做什么 |
|---|---|
| `status` | WPE 进程与权限、崩溃标记、是否已注入与目标号、可抓窗口数、窗口表（含所属会话、尺寸、是否陈旧）、抓帧锁由谁持有、旧 skill 会话是否存在 |
| `ensure_running()` | 见上 |
| `open_wallpaper(project, size?, wait?)` | 先 `ensure_running`；窗口名 `kb-<MCP 进程号>-<序号>`；同尺寸的窗口已被别的会话开着就拒绝，报出是谁；先登记再发命令；等窗口出现。回窗口名、hwnd、日志游标 |
| `close_wallpaper(window)` | 只关自己的窗口，关完从窗口表删掉 |
| `apply_properties(window, props)` | 运行中改自己窗口的属性（`applyProperties`） |
| `windows()` | 桌面壁纸窗口和全部测试窗口：标题、hwnd、所属、窗口与客户区矩形 |
| `log_mark()` / `log_since(mark, grep?, errors?)` | WPE `log.txt` 的增量 |
| `cleanup_project(path)` | 删 WPE 写进测试工程的 `shaders/blobsSM40`，只限仓库 `ignore/` 下的目录 |
| `get_settings()` | 只读：WPE 当前配置的常用键、崩溃标记、选中的壁纸、上次备份以来改过的键（决定 5） |
| `restart_wpe(settings?)` | 见决定 4 |

- **MCP 退出**（stdin 关闭、进程退出钩子）：关自己的窗口，回放进程一起停；WPE 不动。

**验收：**
- **三种起点**各跑一遍「`ensure_running` → 开窗 → 关窗」：
  - 在跑、没注入：PID 不变，桌面壁纸不受影响，注入后可抓窗口数为空；
  - 在跑、已注入：不再注入；
  - 没在跑：崩溃标记为 0 和 1 两种情形都不弹窗，原壁纸自己加载，然后注入。
  - 三种都在结束后保持「WPE 在跑、带注入、原壁纸在、没有测试窗口」。
- **不弹窗、不抢焦点：** 全程每 100 ms 记前台窗口和新出现的顶层窗口（`exp.py watch`），没有弹窗，前台不变（`show_in_renderdoc` 除外）。
- **陈旧窗口：** 结束掉一个开着窗口的 MCP，另一个 MCP 的下一次 `ensure_running` 把它的窗口关掉；进程号被复用的情形用伪造的启动时刻测。
- **同尺寸冲突：** 两个 MCP 开同尺寸窗口，后开的被拒并报出占用方。
- **与旧 skill：** 旧 `state.json` 在时，`ensure_running` 拒绝；常驻 WPE 在跑时，旧 `rd start` 照旧拒绝。

## 步骤 3 — 抓帧与组合工具

- **新增工具：**

| 工具 | 做什么 |
|---|---|
| `capture(window, out, frames, tag?)` | 在抓帧锁里：不抢占地连目标；可抓窗口只有自己这一个就直接抓，否则探测 1 帧看缩略图尺寸、不对就删掉探测文件并切换，最多一轮；触发连续 N 帧；每张都核对缩略图尺寸；文件移到 `out`；断开、放锁。锁外核对帧号连续，并回放第一张，核对绘制数和后备缓冲尺寸。结果报出等锁时间和探测次数 |
| `capture_wallpaper(project, out, frames, size?, log_grep?)` | 组合：`ensure_running` → 开自己的窗口 → 等到在呈现 → 记日志游标 → 抓帧 → 关自己的窗口 → 截日志 → 在自己的回放进程里打开第一张 rdc。回 rdc 清单、日志行、第一帧核对结果，之后可以直接调回放工具 |
| `capture_sweep(jobs)` | 组合：一组「工程 × 帧数」依次抓完。即现在的 `ignore/p4/sweep_b.py` 去掉设置切换的部分（设置见决定 4） |

- `out` 必须给，约定 `A:\<项目>\<用途>\`，不设缺省目录。
- 连目标被拒（别的客户端连着，比如用户在 RenderDoc 界面里附加了 WPE）：等锁超时一样处理，报出来，不抢占。

**验收：**
- 用 P4c 的真实流程跑通：`capture_wallpaper` 抓 `p4c-trail`，接着 `get_mesh_data` 读 `gs_out` 四角，和 `ignore/p4/ana_c_render.py` 对同一批旧抓帧的结果一致。
- `capture_sweep` 跑 `p4c-attract`：日志行数、帧号连续性和 `sweep_b.py` 当时的输出一致。
- **并发**（Q12）：两个 Claude 会话的 MCP 各开一个尺寸不同的窗口，交错和同时各抓 10 次。每次都抓到自己的窗口（缩略图与回放尺寸），没有一方被踢；记下等锁时间、探测次数，以及探测给对方日志 dt 带来的尖峰。
- 两个会话同时在各自的回放进程里分析，互不影响。

## 步骤 4 — 文档（新旧并存期）

- **新增** `.claude/mcps/wpe-renderdoc/README.md` 的用法部分，内容和 MCP 的 `instructions` 一致：
  - 工具表、工作流；
  - `ensure_running` 的判定、常驻与并发规则（窗口归属、抓帧锁、同尺寸冲突、陈旧窗口）、不弹窗的做法，以及「设置不还原、只报改动」的约定；
  - 从旧 skill 带过来、仍成立的坑：多个交换链、帧号换壁纸后重新计数、被抓的帧本身是长帧、`pause` 只管桌面、叠加文字。
- **修改** `.claude/skills/wpe-renderdoc/SKILL.md`：只在开头加一句「新的 `wpe-renderdoc` MCP 在 `.claude/mcps/wpe-renderdoc/`，完全迁移前两者并存」，正文和 `driver.py`、`target.py` 都不动。
  > 说明：过渡期不新建 skill，免得两个同名；迁移时再把新用法写进 skill。
- **修改** `AGENTS.md`「单体仓库布局」加 `.claude/mcps/`；`cocs/wpe/WPE_SCENE.md` 里提到 `wpe-renderdoc` skill 的地方补一句新 MCP。

## 完全迁移（以后另定，本计划不做）

条件：
- 新 MCP 覆盖旧 skill 的全部用法（start / open / close / control / capture / stop）；
- `ignore/` 里还在用 `driver.py` 的脚本已经不再需要，或改成调新 MCP、`kbp-tools`。

到时候再做：
- 删除旧 skill 的 `driver.py`、`target.py`，把新用法写进 skill；
- 删除 `.mcp.json` 的 `renderdoc`；
- 用户确认后删掉 `ignore/RenderDocMCP`；
- 更新 memory 里 RenderDoc MCP 的位置。

## 本计划不做

- **`kbp-tools`：** 测试工程生成、帧号 / 时钟图层解码、`kbp-meta.json`、`[kbp]` 日志转 dt、轨迹提取、回放对比、语料扫描、变异检查、像素与统计比较。
- **PrintWindow 采样**（`ignore/p3c/wpe-general/sampler_pw.py` 一族）、**语料与 `scene.pkg` 读取**（`ignore/hdr-macro/scan_misc_lib.py`）：不在这条工作流里，以后随 `kbp-tools` 再定去处。

## 分批

- **第 0 批：** 步骤 0 剩下的 Q5、Q6、Q8、Q9、Q10、Q12、Q13。Q8、Q9、Q12 可以和步骤 1、2 一起做。
- **第 1 批：** 步骤 1，阶段计划 [wpe-renderdoc-mcp-p1.md](wpe-renderdoc-mcp-p1.md)。不碰 WPE，用现有 rdc 验收；`.mcp.json` 在这一批加新入口，回放工具在 Claude Code 里端到端测一遍。抓帧控制（`target_*`）挪到第 3 批，和抓帧锁一起做。
- **第 2 批：** 步骤 2。
- **第 3 批：** 步骤 3、步骤 4。

## 风险

1. **注入常驻在用户的 WPE 里**（Q10、Q13）。`renderdoc.dll` 卸不掉，直到用户重启 WPE。注入后新建的设备都会被挂上：
   - 测试窗口本来就要挂；
   - 用户换壁纸、显示器变化时，新的桌面设备也会被挂上，桌面左上角可能出现叠加文字，RenderDoc 还会给它记录资源，多占内存。
   
   用户重启 WPE 即可恢复，下次 `ensure_running` 会再注入。`status` 要能报出「桌面设备被挂上了」。
2. **探测抓帧打扰别的会话**（Q12）。多于一个可抓窗口时，探测会在别人的窗口上造成一次长帧；正在量 dt 的会话会看到尖峰。只有同时开着多个窗口时才会发生。结果里报探测次数，必要时给 `capture` 加「不探测，等别人关窗」的选项。
3. **同尺寸的窗口分不清。** 这样的开窗直接拒绝。两个会话恰好都要同一尺寸时，后来的要等先来的关窗。
4. **崩溃标记被清掉。** `ensure_running` 把标记从 1 写成 0，跳过了 WPE 自己的安全模式。如果 WPE 是真的因某张壁纸崩溃，启动后可能再崩。每次清标记都报出来；连续两次启动后很快退出，就停下来报用户。
5. **设置是全局的**（Q5）。改设置会影响所有会话和用户的桌面；要重启才生效的设置和「不关不杀」冲突，见决定 4。
6. **WPE 以管理员权限运行**（以后开了计划任务方式的自启）。注入和退出消息都会失败，只报出来，不提权。
7. **外部客户端占着目标。** 用户在 RenderDoc 界面里附加了 WPE，新 MCP 就连不上，只能报出来等。
8. **常驻 qrenderdoc 的稳定性**（Q8）。长时间运行、反复开关 rdc 有没有泄漏没测过。工作进程按需重启，MCP 对调用方报出来。
9. **两个 Python。** MCP 服务端是 uv 管的 Python 3.10+，工作进程是 RenderDoc 内嵌的 Python，版本不同，代码分目录、各自验证。
10. **fork 之后不跟上游。** 上游 RenderDocMCP 的新功能要手工合进来。
11. **并存期两套同名工具。** `get_draw_calls` 等在旧 `renderdoc` 和新 `wpe-renderdoc` 下都有，一个要开着 RenderDoc 界面、一个不用，容易调错。靠两边的 MCP 说明写清楚；本地改过的回放代码在两处各一份，过渡期只改新的那份。

## 决定

1. **不兼容旧命令行，新旧并存到完全迁移**（2026-11-09 用户）。旧 skill、旧 MCP 原样保留；新 MCP 不引用、不修改它们，状态目录分开。
2. **新 MCP 不带 RenderDoc 界面扩展**（随第 1 条定）。过渡期要在界面里看就用旧 MCP；完全迁移时再看 `show_in_renderdoc` 够不够。
3. **常驻共享、`ensure_running`、不关不杀**（2026-11-09 晚，用户；取代同日早些时候的「抓完就释放」和「先强杀再注入启动」）：
   - 一般情况下确保 WPE 在跑、已注入，然后抓；
   - 多个会话可以同时抓，各自在自己的回放进程里分析；
   - MCP 不退出、不强杀 WPE，只开关自己的窗口，不碰桌面壁纸。
   
   设置改了不还原，逐项报出，第一次改 `config.json` 前留一份备份。
4. **要重启才生效的设置用显式的 `restart_wpe(settings)`**（2026-11-09 晚，用户按推荐定）：
   - 只有窗口表里没有别的会话的窗口时才做，否则拒绝并报出是谁；
   - 做法是正常退出（`0x9c4a`）→ 改 `config.json` → 普通 `-silent` 启动 → 注入。桌面空约 4–5 s，不弹窗。
   
   结果里报出改了哪些键、原来的值。

   Q5 读码之后，先不做就地改的 `set_settings`。理由：
   - 外部没有现成入口，唯一的办法是往共享的 WPE 进程内存写消息，格式错了会把大家正在用的 WPE 弄崩；
   - 改渲染相关的键（`postprocessing`、`msaa` 等）会让桌面壁纸重建，注入之后新建的桌面设备会被挂上，桌面出现叠加文字；
   - 重启的做法是先退出、等 WPE 起来再注入，桌面设备在注入前已经建好，不会被挂上；
   - 测试窗口本来就是每次新开的，重启后新开的窗口自然用上新值。
   
   `restart_wpe` 还要求：
   - WPE 的设置界面没开着，否则退出时可能触发「取消」恢复并写文件；
   - 只改文件里当前用户段的键，WPE 起来后核对读进来的是新值。
5. **加一个只读的 `get_settings()`**（同上，用户加）：直接看 WPE 当前的配置，不改任何东西。
   - `config.json` 里当前用户的常用键（`fps`、`postprocessing`、MSAA、分辨率缩放、各类暂停策略等）原样列出；
   - 再给崩溃标记、选中的壁纸，以及上次备份以来改过哪些键；
   - 读的是文件。WPE 的设置界面开着、改了还没点「确定」时，文件落后于 WPE 内存里的值（Q5），这时结果里注明。键清单见 [rea-wpe-settings.md](rea-wpe-settings.md) 末尾。
