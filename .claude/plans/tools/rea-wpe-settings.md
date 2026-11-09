# WPE 运行中怎样应用设置改动（静态逆向，2026-11-09）

**结论概括。** 主进程 `wallpaper64.exe` 的设置只有一份内存副本。`config.json` 只在启动时读一次（`FUN_140007730` → `FUN_140040470`），运行中不监视文件，主实例也没有「从磁盘重读设置」的入口。

设置界面 `bin/wallpaperui.exe -window settings`（CEF）经一对命名管道把设置发给主进程：

- **界面每改一次**，就把整份 `general.user` 作为消息 **0xc9（applyGeneral）** 发一次。主进程立即应用到内存和引擎，不写文件。
- **点「确定」**：发 **0xca**，主进程这时才写 `config.json`。
- **点「取消」**：不发消息。界面进程退出后，主进程用打开设置窗口时拍下的快照恢复（消息 **2**），并写文件。

应用逻辑在 `FUN_14001b3a0`：

- **引擎级设置**（播放策略、进程优先级、音频、计时器精度等）：直接改全局变量，立即生效。
- **`msaa / resolution / postprocessing / shadows / volumetrics / videoframework / webmframework / overridewallpaper / overridelockscreen` 任一变化**：**关闭并重新加载全部桌面壁纸**。
- **其余键**（`fps`、`reflection`、`language` 等）：逐个推给桌面壁纸，就地生效。
- **`-playInWindow` 窗口不在上面任何一条路上：**
  - 已开的窗口不受影响；
  - 新开的窗口按内存里的当前值建；
  - 播放策略（其他程序全屏 / 最大化时暂停等）对它们也不起作用。

**外部触发。**

- **没有现成入口：**
  - `-control` 和 `WM_COPYDATA` 里没有设置命令；
  - 管道只在界面进程启动时创建，只允许一个实例，并且界面一启动就连上。
- **可行但侵入：**
  1. 把消息结构写进 WPE 的进程内存；
  2. `SendMessage(WPEEventWindow, 0x401, 0, 远端指针)`。

  走的正是界面 0xc9 / 0xca 那条路。必须发**完整的** `general.user`，否则缺的键会被默认值覆盖。
- **稳妥的做法**仍是决定 4 的「正常退出 → 改文件 → 启动」：**正常退出不写 `config.json`**，启动时读。

---

### 头部

- **目标：**
  - `wallpaper64.exe` 2.8.42，SHA-256 `40e2ce02…993b0`，与 `rea-wpe-exit.md` 同一文件；
  - `bin/wallpaperui.exe`，SHA-256 `dab38bfc017dd5fd4947a09706d23f27833870d1bbb87485677a3e67d1d55791`，构建串 `2026-06-29 14:36:02`；
  - 界面脚本 `ui/dist/scripts/scripts.js`。

  所有 exe 都先拷到 `ignore/wpe-mcp/rea/` 再打开。
- **方法：**
  - `wallpaper64.exe`：REA（Ghidra 12.1.4）从 `wp-exit.rea-snapshot` 打开；汇编与 `ignore/p4/rea/wp.asm` 对照，并沿用 `wndproc_21e50.c` 等已有伪代码。
  - `wallpaperui.exe`：12.7 MB，Ghidra 分析 330 s 超时，改用本机 llvm-objdump 全量反汇编；函数边界取自 `.pdata`。
- **地址：**
  - `wallpaper64.exe` 基址 `0x140000000`；
  - `wallpaperui.exe` 基址 `0x140000000`；
  - 函数名为 Ghidra 自动名。
- **证据等级：**
  - 【确】：读到了代码或文件内容。
  - 【推】：由代码推出，没有逐行确认，或依赖 jsoncpp / Win32 的标准行为。
  - 【未知】：没读到。
  - **全部结论都没有实测，也没有碰任何正在运行的进程。**
- **目标内容检查：** 看过 REA 结果、伪代码、`scripts.js` 和字符串，其中没有要求运行、安装、下载或发送任何东西的内容，没有需要搁置的指令。

---

## Q1 设置怎么从界面到主进程

### 界面侧：改动即时下发，「确定」才落盘，「取消」会恢复【确】

**`scripts.js` 的 `SettingsCtrl`**（文件内字节偏移约 158 700）：

- **下发：** `$watch("generalSettings", …, true)`，每次改动都调用 `window.settingsObject.applyGeneral(angular.toJson(generalSettings))`。滑块（fps、音频）只在 `onEnd` 时下发。
- **确定（`callbackOk`）：**
  - `isRestartRequired` 为真时，先弹「需要重启」确认框，再 `callDeferred("settingsObject","restartApp")`；
  - 然后 `settingsObject.close(true)`。
- **取消：** `settingsObject.close(false)`。
- **界面自己的「需重启」名单**（变量 `E`）：
  - `monitordetection`、`trayicon`、`uihardwareacceleration`、`uiquality`、`anticrash`、`vdesktopenabled`、`videomfstutterhack`；
  - 外加插件启用状态的变化。
- **选项范围：**
  - fps 滑块 `floor 10`，`ceil = runtime.frequencymax`；
  - `runtime.displayhdrsupport` 为假时去掉 `displayhdr` 选项；
  - 其余见附录。

**`wallpaperui.exe` 的 `SettingsWindow::OnSettingsObjectMethodCall` = `0x14011e510`：**

| JS 方法 | 原生侧行为 | 发出的消息号 |
|---|---|---|
| `applyGeneral(json)`（`0x14011e5de`） | 解析 JSON，补上 `autostartx64`（界面对象 +0x58b 的 bool），在本地记下 `mediablocklist`，再序列化 | **0xc9** |
| `close(true)`（`0x14011e562`） | 发出消息后关窗 | **0xca**（无载荷） |
| `close(false)` | 只关窗 | 无 |
| `languageChanged` | — | 3 |
| `persistSharedSettings`（`0x140120a1a`） | — | 6 |
| `resetConfig` / `restartApp` | — | 0xcc / 0xcd |
| `updateManagedMonitors` / `openWebWallpaperDevtools` | — | 0xcf / 0xd0 |
| `konamiUnlock` | `FindWindowW(L"WPEEventWindow")` 后直接发窗口消息 0x402 | — |

浏览窗口同理（`0x140023xxx`–`0x140026xxx`）：

| 方法 | 消息号 |
|---|---|
| `persistSharedSettings` | 6 |
| `persistUserMonitorSettings` | 9 |
| `reloadWallpaperConfig` | 0x75 |
| `disableSafeMode` | 0x78 |

### 传输：每个界面进程一对消息模式命名管道【确】

主进程在 `FUN_1400832c0` 里建管道。这个函数负责启动 `bin/wallpaperui.exe`，浏览 / 编辑器 / 欢迎窗口也用它。处理器名为 `WPEhandlerSettings`、`WPEhandlerBrowseWallpapers`、`WPEhandlerEditor`、`WPEhandlerWelcomeDialog`。

- **`\\.\pipe\<处理器名>Client`：**
  - 方向：界面 → 主进程；
  - `CreateNamedPipeW(PIPE_ACCESS_INBOUND, PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE, 最多 1 个实例, 入缓冲 0x10000)`，`0x1400837ff`；
  - 存在处理器对象 +0x78。
- **`\\.\pipe\<处理器名>`：**
  - 方向：主进程 → 界面，OUTBOUND，`0x140083844`；
  - 存在 +0x80。
- **安全描述符：** null DACL（`SetSecurityDescriptorDacl(…, TRUE, NULL, …)`，`0x1400834e6`），任何进程都能连。
- **读线程 `0x1400822e0`：**
  1. `ConnectNamedPipe`；
  2. 循环 `ReadFile(…, 0x400)`（`0x14008240d`）；
  3. 拼包后入队，并 `PostMessageW(事件窗口, 0x415)`（`0x14008251f`）。
- **启动界面：** 建完管道后用 `CreateProcessW`（`0x140083d8b`）启动 `wallpaperui.exe … -parentprocess <pid> -messagehandler <处理器名>`。

**包格式**（发送端：界面 `0x140232040` / 主进程 `FUN_1400182d0`，两边相同）：

- 每包固定 0x400 字节：
  - `int32 消息号`；
  - `int32 分片标志`（0 单包、1 首、2 中、3 尾）；
  - `int32 长度（≤0x3f4）`；
  - 载荷。
- 载荷为 UTF-8 JSON。

### 主进程侧：经内部窗口消息 0x401 分发【确】

1. 事件窗口收到 `0x415` 后，对三个处理器（浏览 `0x1404e64d0`、设置 `0x1404e67a0`、编辑器 `0x1404e6a70`）各调一次 `FUN_140084700`：
   - 取空队列，每条消息调 `SendMessageW(事件窗口, 0x401, 0, &{int id; int len; char* data})`；
   - 如果界面进程已经退出，关闭句柄，再调处理器 +0x2c8 上登记的退出回调。
2. 0x401 入口（`0x1400273d3` → `0x140027b71`）只做 `mov ecx,[lParam]`，然后查跳转表。**不检查发送方，也不做重入检查。**
3. 相关分支（伪代码见 `wndproc_21e50.c`）：

| 消息号 | 含义 | 处理 | 写文件 |
|---|---|---|---|
| **0xc9** | applyGeneral | 解析 → `FUN_140046f20` 给**缺失**的键填默认值（`0x14002c7b6`）→ 去掉 `usermonitors` → `FUN_14001b3a0(engine, user, 1)`（`0x14002c7f8`） | **不写** |
| **0xca** | 设置「确定」 | 清掉设置窗口的退出回调，清空快照 `DAT_1404df570`，`FUN_140041250`（`0x14002c847`），`FUN_140019350(0)` 每日备份 | 写 |
| **2** | 恢复 / 浏览窗口提交 | 载荷 `{user, wallpaperconfig, wproperties, …}`；`user` 去掉 `usermonitors / overridelockscreen / overridewallpaper` 后交给 `FUN_14001b3a0(…,1)`（`0x1400280a3`），然后写文件（`0x1400280af`） | 写 |
| 6 | persistSharedSettings | 合并进 `shared`，写文件，重新注册热键 | 写 |
| 9 | persistUserMonitorSettings | 合并进 `usermonitors`，`FUN_14001b3a0(…,0)`（`0x14002859a`），写文件 | 写 |
| 0x75 | reloadWallpaperConfig | 从参数表删掉 `-nowallpapers`，`FUN_140065110(engine,1)`，按内存里的 `wallpaperconfig` 重新加载壁纸 | 不写 |
| 0x78 | disableSafeMode | `general.user.safemode = false`，写文件 | 写 |
| 0xcc / 0xcd | resetConfig / restartApp | 经 `apputil32.exe -restartapplocal -process <pid>` 自重启；0xcd 先写文件 | 0xcd 写 |

这里顺带回答了 `rea-wpe-exit.md` 的两个遗留问题：

- `disableSafeMode` 是消息 0x78，会**永久**写入 `safemode=false`。
- `FUN_140065110` 的第二个参数是「允许加载壁纸」：0x75 先把它设成 1，再加载。

### 快照与「取消」【确】

- **拍快照：** `WM_COMMAND 0x9c53`（打开设置）分支（`wndproc_21e50.c` 约 4825–4985 行）把下列内容序列化进 `DAT_1404df570`，同时作为消息 200 发给界面：
  - `user`、`shared`、`playlists`、`profiles`、`localfiles`；
  - `monitormap`、`discoveredplugins`。
- **登记退出回调：** 一个 lambda，虚表在 `0x1404753e8`，+0x10 处的 `do_call` 是 `FUN_140036080`。
- **界面退出时：** 快照不为空（即没收到过 0xca）就调用 `SendMessageTimeoutW(事件窗口, 0x401, {消息号 2, 快照})`（`0x14003614f`）。效果是恢复设置并**写文件**。

### 没有别的通道【确】

- **文件监视：** 导入表里没有 `ReadDirectoryChangesW`，也没有 `FindFirstChangeNotification*`。
- **谁读 `config.json`：** 只有 `FUN_140007730`。它的调用方是：
  - 主函数（启动时）；
  - `wndproc` 的 0x412（`0x14002ddac`），见 Q3。

---

## Q2 主进程读设置的地方

### 启动

- **加载：** `FUN_140007730` → `FUN_140040470(配置对象, "config.json", <Windows 用户名>, 屏保标志)`：
  - 用 `FUN_140046f20` 规范化（`0x1400410e4`）；
  - 回写一次文件（`0x140040ef4`）。
- **内存里的配置对象**从 `0x1404df5a0` 开始：
  - 第一个字段是当前生效的 `wallpaperconfig` 键名；
  - 用户段在 `+0x48`（`DAT_1404df5e8`）。

### 运行中：applyGeneral → `FUN_14001b3a0(engine, 新 user, 是否通知浏览界面)`【确】

1. **`FUN_14006c280(engine, 新 user)`**：直接改引擎全局变量。
   - **显示与播放策略：**
     - `adjustdwmcolormode`；
     - `playbackfocus / playbackmaximized / playbackfullscreen / playbacksleep / playbackonbattery / playbackaudio` → `DAT_1404e53c0..d4`；
     - 映射函数 `FUN_140141880`：`stop`=4、`pauseall`=3、`pause`=2、`mute`=1，其余（含 `run`）=0；
     - `unpauseaero`。
   - **音频：**
     - `audioinputdevice`（变了就重启采集）；
     - `audioinputvolume ×0.02`；
     - `audioinputthreshold ×0.001`。
   - **`fps`：** 这里只设一个全局值 `clamp(round(1000/fps)·0.5, 6, 100)`（`_DAT_1404e55bc`）。它不是渲染帧率，【推】是音频采样周期。
   - **计时与框架：**
     - `highprecisiontimer`（标志 0x20000）；
     - `webmframework=="native"` 标志。
   - **进程与插件：**
     - `apprules`；
     - `processpriority` → `SetPriorityClass`（`normal` 0x20 / `belownormal` 0x4000）；
     - `plugins.*`（`FUN_1400567b0`，逐个插件调 +0x58）。
   - **其他：** `pausevram`、`reloadaudio`、`mediaintegration`、`mediablocklist`、`browsetransition`。
2. **合并进内存：** `config.general.user = FUN_140017fb0(旧, 新)`。
   - 这是**浅合并**：先复制旧值，再用新对象的每个顶层键覆盖。
3. **立即生效：**
   - `language`（字符串）→ `FUN_140097570`；
   - `iconopacity` → `FUN_14003d930`。
4. **`FUN_1400489a0(新, 旧)` 判断是否重载：**
   - 字符串键 `msaa`、`resolution`、`postprocessing`、`shadows`、`volumetrics`、`videoframework`、`webmframework`：新值是字符串且与旧值不同；
   - bool 键 `overridelockscreen`、`overridewallpaper`：不同。
5. **其余设置：**
   - `loglevel`（`FUN_140006060`）；
   - `overridewallpaper / overridelockscreen / slideshowkiller` 的 WinEvent 钩子（`FUN_14001a1f0`）。
6. **重载或就地：**
   - **需要重载：** `FUN_1400666c0` 关掉全部桌面壁纸（表 `DAT_1404e5330`），`FUN_14001b080` 再按内存里的 `wallpaperconfig` 重新加载。**启动时带了 `-nowallpapers` 的话只关不开。**
   - **不需要重载：** 对每个桌面壁纸调虚函数 `+0x88(user + location=usermonitors[显示器])`（`0x14001b841`）：

| 类型 | +0x88 | 效果 |
|---|---|---|
| 场景 | `FUN_14010fe50` | 合并进自己的 `general`，`SendMessageTimeoutW(渲染窗口, 0x467)` → `FUN_1401154c0`：`fps`（对象 +0x18c）、`videoaudiooutput`、`reflection` 与 `resolution` 标志（`FUN_140115a90`）、`language` |
| 视频 | `FUN_1400fed90` | → `FUN_1400ff750`，读 `videoloopmode / videoreadmode / videoaudiooutput / videohardwareacceleration / videomfstutterhack` |
| 网页 | `FUN_140119a60` | 合并 `general`，但保留旧的 `cefcommandline`，再调 `+0x10` 重启 CEF 子进程（`FUN_14011a180`；`resolution=="half"` 时加 `-halfresolution`） |

7. 参数要求通知且浏览界面开着时，把新设置作为消息 0x7e 发给它。

### `-playInWindow` 窗口【确】

- **存放：** 独立的表 `DAT_1404e63c8`，由 `FUN_140070dd0`（带 `playinwindow` 的 `openWallpaper` 分支）创建。
- **设置来源：**
  1. `FUN_140073d00` → `FUN_140046620(config, location)` = **内存里的** `general.user` + `location`；
  2. 场景加载 `FUN_14010df40` 读一次：
     - `msaa`（`x2`/`x4`/`x8` → 1/2/3）；
     - `postprocessing`（`disabled` 关后处理，`ultra` → HDR 标志 0x2000，`displayhdr` → 0x6000）；
     - `shadows`、`volumetrics`（`disabled/low/medium/high/ultra` → 0/1/2/3/4）；
     - `FUN_1401154c0`（fps、reflection、resolution）。
- **不经过这张表的路径：** `FUN_14001b3a0`、暂停 / 静音 `FUN_1400739a0`、停止 `FUN_140073ac0` 都只遍历桌面表。后果是：
  - applyGeneral **不会改**已开的窗口；
  - **新开**的窗口用新值；
  - 播放策略**不会让测试窗口暂停或静音**。
- **按窗口覆盖：** `location` 只覆盖 `videoaudiooutput`，无法给某个窗口单独设 fps / postprocessing【推】。依据是场景函数只从 `location` 读这一个键。
- **`openWallpaper` 的 playInWindow 分支不写 `config.json`**（不调 `FUN_140019f60`），与之前实测「逐字节不变」一致。

### 只在启动时读【确 / 推】

| 键 | 读取位置 | 说明 |
|---|---|---|
| `safemode` | 主函数 `0x14000c1f1` | 只在 `faultyShutdown==1` 时才看 |
| `anticrash` | 主函数 | 用途没读 |
| `windowupdaterate` | `FUN_14001eae0` `0x14001f523` | `SetTimer(事件窗口, 0x68, clamp(值, 50, 5000))`，即播放策略的轮询间隔 |
| `vdesktopenabled` | `FUN_14001eae0` | — |
| `monitordetection` | `FUN_14001eae0` | `FUN_14001bb10` 也读；【推】显示器变化时会重读 |
| `plugindelay` | `FUN_1400553ff` | 插件初始化 |
| 注册表 `HKCU\Software\WallpaperEngine` 的 `faultyShutdown / hideTrayIcon / disablePlugins` | 主函数 | — |

### 主进程不读的键

- **只有界面进程读：**
  - `uiskin*`、`uiquality`、`uieffects`、`uihardwareacceleration`；
  - `autostart*`、`graphicsapi`、`cefdevtoolsport`；
  - `minimodeminimizewindows`、`allowbrowseropacity`、`konami`、`hasshownwelcomedialog`。

  不过主进程的 `FUN_140046f20` 会按 `uihardwareacceleration` 在 `cefcommandline` 里增删 `--disable-gpu`。
- **`general.user.preset` 只是界面上的标签。** 主进程读到的 `preset` 字符串都属于 `openWallpaper` 的属性预设【推】。

### 按键分类

列含义：

- **就地：** applyGeneral 后，桌面壁纸 / 引擎立即生效。
- **桌面重载：** applyGeneral 会关闭并重新打开全部桌面壁纸。
- **加载时：** 只在打开壁纸（含窗口）时读，已开窗口要重开。
- **启动：** 要重启 WPE。

| 键 | 运行中经 applyGeneral | 已开 `-playInWindow` 窗口 | 新开窗口 | 要重启 | 可信度 |
|---|---|---|---|---|---|
| `fps` | 就地（场景 0x467 → +0x18c；网页壁纸重启） | 不变 | 新值 | 否 | 确 |
| `msaa` / `postprocessing` / `resolution` / `shadows` / `volumetrics` | **桌面重载** | 不变 | 新值 | 否 | 确 |
| `reflection` | 就地（场景 0x467） | 不变 | 新值 | 否 | 确（路径）/ 推（效果） |
| `videoframework` / `webmframework` | 桌面重载（另设 webm 全局标志） | — | 新值 | 否 | 确 |
| `video*` / `videoaudiooutput` | 就地（视频 +0x88；场景经 0x467 收 `videoaudiooutput`） | 不变 | 新值 | 界面把 `videomfstutterhack` 标为需重启 | 推 |
| `playback*`、`apprules`、`unpauseaero` | 就地（全局变量，由 `FUN_14006cea0` 轮询判定） | **始终不受影响** | **始终不受影响** | 否 | 确 |
| `processpriority`、`highprecisiontimer`、`pausevram`、`reloadaudio`、`mediaintegration`、`mediablocklist`、`audioinput*`、`adjustdwmcolormode`、`browsetransition`、`iconopacity`、`language`、`loglevel` | 就地 | — | — | 否 | 确 |
| `overridewallpaper` / `overridelockscreen` | 就地挂钩子 + 桌面重载 | — | — | 否 | 确 |
| `slideshowkiller` | 就地 | — | — | 否 | 确 |
| `plugins.*` | 就地推给各插件 | — | — | 界面认为启用状态需重启 | 推 |
| `cefcommandline` | 不作用于运行中的网页壁纸（重启时保留旧值） | — | 新开的网页壁纸读 | 实际上要重开 | 推 |
| `safemode`、`anticrash`、`windowupdaterate`、`vdesktopenabled`、`monitordetection`、`plugindelay` | 不生效 | — | — | **是** | 确 / 推 |
| `ui*`、`autostart*` 等 | 主进程不读 | — | — | 下次打开界面时生效 | 推 |

---

## Q3 能不能从外部触发

### 现成入口：没有【确】

- **`-control`：** 16 条命令（见 `rea-wpe-exit.md`），没有设置类。
  - `applyProperties`（0x3f0）只应用壁纸的 `wproperties`。
  - `openProfile`（0x3f5）只加载壁纸配置档（`FUN_14001dc40`）。
  - `WM_COPYDATA` 的 switch 只处理 dwData 1000–0x3f7，其余忽略。
- **命名管道：** 只在主进程启动界面时存在，最多一个实例，界面一启动就连上。要冒充界面就得先打开设置窗口（`0x9c53`），会弹窗、抢焦点。【推】界面退出后管道即关闭（`FUN_140084700` → `FUN_140081800`）。
- **`config.json`：** 不监视，运行中不重读。唯一会重读的是 `0x412`（WM_USER+0x12）：
  - 它是给屏保实例（`WPEEventWindowSC`）用的。主实例在修改屏保的壁纸配置时（生效键是 `wallpaperconfigscreensaver`），由 `FUN_140019f60` 启动定时器 0x76，500 ms 后投递给那个窗口（`0x140024a42`）。
  - **不要发给主实例。** 它会从磁盘重读 `config.json`，但是：
    - 只要用户段里有 `wallpaperconfigscreensaver`（用户配置里有：`layout 0, sameaswallpaper true`），就会**把生效的 wallpaperconfig 键切到 `wallpaperconfigscreensaver`**，并按它重载桌面；
    - 之后的保存会把桌面选择写进屏保键；
    - 它**不调** `FUN_14001b3a0` / `FUN_14006c280`，所以 `general.user` 只是重读进内存，引擎全局变量和已有壁纸都不变。

  代码【确】，后果【推】。

### 可行但侵入：写入 WPE 内存 + `SendMessage 0x401`【确 代码路径 / 推 可行性，未实测】

0x401 是内部消息，不检查发送方。lParam 指向 `{int32 id; int32 len; char* data}`。对 ≥ WM_USER 的消息，Windows 跨进程原样传递 lParam，所以结构体和 JSON 必须放在 WPE 自己的地址空间里。

**最小做法：**

1. `hwnd = FindWindowW(L"WPEEventWindow", NULL)`，取得 PID。
2. 确认没有命令行带 `-window settings` 的 `wallpaperui.exe`（只读查询 `Win32_Process`）。有的话拒绝，原因见下面的风险。
3. 从 `config.json` 读出**完整的**当前 `general.user`，只改目标键。没开设置窗口时，文件内容就等于内存内容【推】。
4. `OpenProcess(PROCESS_VM_OPERATION|PROCESS_VM_WRITE)`，`VirtualAllocEx(16 + len)`。
5. 写入 `{0xc9, len, base+16}` 和 UTF-8 JSON，不需要结尾的 NUL：处理函数会先按 `len` 复制进 `std::string`。
6. `SendMessageTimeoutW(hwnd, 0x401, 0, base, SMTO_ABORTIFHUNG, 5000)`。
   - 成功：`VirtualFreeEx`。
   - 超时：不释放（接受泄漏，因为消息可能稍后才被处理）。
7. 要落盘的话，用同样方式再发 `{0xca, 0, NULL}`。这就是界面「确定」的路径：写文件 + 每日备份。

**效果：**

- 内存里的 `general.user` 和引擎全局变量立即更新。
- **桌面壁纸：**
  - 改到渲染相关键时**关闭并重载**，桌面会短暂空白；
  - 否则就地推送。
- **已开的 `-playInWindow` 窗口不变。** 要关掉自己的窗口再重开；别的会话的窗口在它们重开之前保持旧值。
- 不发 0xca 就不会立刻写文件。但 WPE 下次任何一次保存都会把整段内存写下去，所以改动最终会持久化。

**风险：**

1. **部分 JSON 会覆盖用户设置。**
   - 走 0xc9 时，`FUN_140046f20` 会先给缺失的键填默认值再合并：
     - `msaa "x2"`、`postprocessing "disabled"`、`shadows / volumetrics "medium"`、`reflection true`、`fps 15`；
     - `windowupdaterate 1000`、`playbackfullscreen "pause"` 等。
   - **也不要用消息 2 加 `{"user":{部分}}`。**
     - `FUN_14001b3a0` 会先把新对象交给 `FUN_14006c280`，后者用非 const 的 `operator[]`（`FUN_140086de0`，会把 null 变成对象并插入缺失成员）逐键读取。
     - 缺失的键因此被插入为 null，随后在合并时覆盖旧值，下次保存时 null 被写进文件。
     - 调用顺序【确】，插入语义【推】（jsoncpp 标准行为）。
2. **往用户进程写内存。**
   - 结构写错就会访问违例，WPE 崩溃，`faultyShutdown = 1`，桌面壁纸丢失（按 `rea-wpe-exit.md` Q4 清标记后恢复）。
   - 目标进程的完整性级别不能高于我们（UIPI 和 OpenProcess 都受限）。
3. **RenderDoc 注入与桌面重载互相影响。** 渲染键变化会重建桌面壁纸的设备，已被注入的 WPE 会挂上新设备：桌面出现叠加文字，RenderDoc 记录更多资源（计划风险 1）。
4. **与用户的设置窗口冲突。**
   - 用户开着设置窗口时，点「取消」会恢复快照并写文件，覆盖我们的改动；
   - 界面下一次改动会整份下发，同样覆盖。
5. **窗口找错。** 屏保下窗口类是 `WPEEventWindowSC`，要确认找的是对的窗口。

### 稳妥：重启（决定 4）【确 代码 / 部分已实测】

1. `WM_COMMAND 0x9c4a` 正常退出（已实测：1.8 s 退出，标记归 0）。
2. 等进程完全退出后改 `config.json`。此时不会有人写回，见 Q4。
3. `-silent` 启动，再注入。

**覆盖范围与副作用：**

- 覆盖所有键，包括只在启动时读的键。
- 桌面空约 4–5 s。
- **所有 `-playInWindow` 窗口都会被关掉**，包括别的会话的窗口。这正是决定 4 的前提。

### 对 `-playInWindow` 的影响

| 做法 | 已开窗口 | 之后新开的窗口 |
|---|---|---|
| 写内存 + 0xc9 | 不变 | 新值 |
| 重启 | 全部关闭 | 新值 |

两种做法都**做不到**只改某一个窗口的 fps / postprocessing。

---

## Q4 `config.json` 什么时候被写回【确】

### `FUN_140041250` 怎么写

1. 配置对象 `+0xe0` 置位时直接返回，不写。【推】屏保实例是只读的。
2. **重新**从磁盘读 `config.json`。
3. 用内存里的用户段替换 `root[<Windows 用户名>]`，并设置 `?installdirectory` 和 `general[<当前生效的 wallpaperconfig 键>]`。
4. 写回整个文件。

后果：

- 其他用户的段和其他顶层键保留；
- **对本用户段的外部修改，会在下一次保存时被内存值覆盖。**

### 写入点

- **启动时：**
  - 加载后规范化，`0x140040ef4`；
  - 更新 `steamlanguage`，`0x14000b1fe`；
  - 处理 `disablePlugins`，`0x14000c608`；
  - 修正 `vdesktopenabled`，`0x14001f133`。
- **`FUN_140019f60`（内存里的 `wallpaperconfig` 变了）：**
  - 桌面 `openWallpaper` / 真的关掉了桌面壁纸的 `closeWallpaper`；
  - `openPlaylist`；
  - `openProfile` 等。

  playInWindow 分支不经过这里。
- **`wndproc` 内其余约 20 处：**
  - 设置「确定」0xca、「取消」恢复 2；
  - 6 / 9 / 0xcb / 0x78 / 0x12d（编辑器）/ 8 / 400（LED 插件）/ 0xcd 等。

  都由用户或界面操作触发。
- **每日备份：** `FUN_140019350` 写 `config_backups/config_<YYYY-MM-DD>.json`。

### 退出时不写

- 下列路径都不写文件：
  - `FUN_14001eae0` 消息循环结束后的清理；
  - 主函数结尾；
  - `WM_QUERYENDSESSION / WM_ENDSESSION`；
  - `0x9c4a` 退出发出的 `WM_QUIT`。
- **例外【推】：** 退出时设置窗口还开着的话，清理过程中可能触发「取消」恢复，那条路径会写文件。

### 结论

- WPE 运行时外部改文件：只能保留到 WPE 下一次保存，**运行中也不会读到**，没有用。
- 正常退出后再改：下次启动生效，也不会被覆盖。

---

## 对计划的影响

### `get_settings`

- **数据来源：** 读 `config.json`。不读 WPE 内存，才算真正不侵入。
- **滞后：** 设置窗口开着，或用 0xc9 改过但还没写盘时，文件会落后于内存。
- **建议：**
  - 同时报出「设置窗口是否开着」（查 `wallpaperui.exe` 命令行）。
  - 按上表给出每个键的类别（就地 / 桌面重载 / 加载时 / 启动）。

### `set_settings`

- **方案一：用「写内存 + 0xc9（+0xca）」实现。**
  - 前提：实验 E2 / E3 通过。
  - 一律发完整的 `general.user`。
  - 用户的设置窗口开着时拒绝。
  - 结果里报出：
    - 改了哪些键、是否触发了桌面重载；
    - 「你已开的窗口要重开」。
- **方案二：不接受方案一就不做 `set_settings`**，全部走 `restart_wpe`。

### `restart_wpe`

照决定 4 保留。下列只在启动时读的键必须走它：

- `safemode`、`anticrash`、`windowupdaterate`；
- `vdesktopenabled`、`monitordetection`、`plugindelay`。

### 对测试窗口的好消息

播放策略不会暂停它们。用户有窗口最大化或全屏时，测试窗口照常出帧【确：暂停 / 停止函数；窗口自身是否另有暂停逻辑【未知】】，用实验 E6 验证。

---

## 建议的实测实验（只列，不做）

默认对象是用户常驻会话中、已被注入的 WPE。每条实验前备份 `config.json`。

**E1 写回观察（被动）**

- **做法：** 在两个时刻记录 `config.json` 和 `config_backups/` 的修改时间与哈希：
  - 开 / 关一个 `-playInWindow` 窗口前后；
  - 正常退出之后。
- **预期：** 两次都不变。
- **影响：** 前者无影响；后者等同一次普通重启。

**E2 0x401 写内存，先做空操作（关键实验）**

- **做法：**
  1. 把当前完整的 `general.user` 原样作为 0xc9 发出。
  2. 记录：
     - `SendMessageTimeout` 的返回；
     - 进程是否存活；
     - `config.json` 是否变化；
     - 桌面是否闪烁。
- **预期：**
  - 返回 0，进程存活，文件不变；
  - 桌面不重载（只是把同样的值再推一次）；
  - 网页壁纸会重启，但当前桌面是场景壁纸。
- **影响：** 往 WPE 内存写约 3 KB。格式错可能导致崩溃，崩溃后按 `rea-wpe-exit.md` E4 清标记再重启。

**E3 内存改 fps 与窗口**

- **做法：**
  1. 在已开一个测试窗口的情况下，发 0xc9 把 `fps` 从 20 改成 30。
  2. 比较已开窗口与新开窗口的 `[kbp]` dt（或抓帧的帧率）。
  3. 再发 0xca，看 `config.json` 里是否变成 `fps=30`。
  4. 最后改回 20 并发 0xca。
- **预期：**
  - 已开窗口仍约 50 ms；
  - 新开窗口约 33 ms；
  - 发 0xca 之前文件不变，之后变成 30。
- **影响：** 桌面帧率临时变化；每日备份可能多一个文件。

**E4 渲染键变化**

- **做法：**
  1. 发 0xc9 把 `postprocessing` 从 disabled 改成 enabled。
  2. 观察桌面壁纸被关闭并重载。
  3. 检查目标的可抓窗口数是否多出一个桌面设备，桌面是否出现叠加文字。
  4. 新开测试窗口的抓帧里应有泛光 pass，已开窗口没有。
  5. 改回原值。
- **影响：**
  - 桌面闪两次；
  - 叠加文字可能一直留到 WPE 下次重启。

**E5 退出不写回 + 启动读取（验证 `restart_wpe`）**

- **做法：**
  1. 只在内存里改 fps，不发 0xca。也可以跳过 E3，直接正常退出。
  2. 确认 `config.json` 没变。
  3. 在外部把 `fps` 改成 25。
  4. `-silent` 启动，开测试窗口，预期 dt 约 40 ms。
- **影响：** 桌面空约 4–5 s。

**E6 播放策略不影响测试窗口**

- **做法：** 开着测试窗口时，把任意窗口最大化（用户设置了 `playbackmaximized = pause`）。
- **预期：** 测试窗口的 dt 连续，抓帧正常。可以顺便验证 `-control pause` / `play` 只作用于桌面。
- **影响：** 无。

**最值得做的前三条：**

1. **E2 + E3：** 决定 `set_settings` 能不能不重启就成立。
2. **E5：** 确认 `restart_wpe` 的核心前提（退出不写回、启动时读）。
3. **E4：** 量化渲染键变化对桌面和 RenderDoc 的扰动。

---

## 没查清的地方

- **视频壁纸：** `FUN_1400ff750` 没逐行读，不确定视频设置是就地生效还是重建视频。
- **`cefcommandline`：** 网页壁纸「保留旧值」的行为是否成立。
- **场景 0x467 的发送：** `FUN_14010fe50` 用 `SendMessageTimeoutW(…, SMTO_BLOCK, 超时 0)` 发 0x467，超时为 0 时是否总能送达？界面那条路径就是这样工作的，推测能。
- **`FUN_14006c280` 里 `fps` 全局值的用途：** 推测是音频采样周期。
- **向主实例发 0x412 的完整后果链**，特别是会不会自己切回来。
- **界面退出时管道是否立即关闭**（`FUN_140081800` 没读）。
- **`-playInWindow` 窗口有没有自己的暂停逻辑**（最小化、被遮挡）。
- **`anticrash` 在主函数里的具体作用。**

## 工作文件（`ignore/wpe-mcp/rea/`）

- **二进制副本：** `wallpaperui.exe`（新增）。
- **`settings/` 目录：**
  - **反汇编：**
    - `wallpaperui.asm`：llvm-objdump 全量反汇编，约 100 MB；
    - `ui_settingscall_1e510.asm`：带注解的 `OnSettingsObjectMethodCall`；
    - `w64_launchui_832c0.asm`：带注解的建管道与启动界面。
  - **伪代码 `dec/f_<地址>.c`：**
    - `14001b3a0` 应用设置；
    - `1400489a0` 重载判定；
    - `14006c280` 引擎级设置；
    - `140046f20` 填默认值；
    - `140041250` 写文件；
    - `140036080` 取消时恢复；
    - `14010df40` 场景加载；
    - `14006cea0` 播放策略判定；
    - 以及本轮反编译的其他函数。
  - **脚本：**
    - `cfgkeys.py`：列出配置键路径；
    - `ctx.py`：在大的单行脚本里按正则取上下文；
    - `pdata.py`：用 `.pdata` 求函数边界；
    - `a.py`：带索引的快速反汇编注解，生成 `wp64.idx` / `ui.idx`；
    - `xr2.py`：在 objdump 输出里找引用；
    - `dumpstr.py`：列出区间内字符串；
    - `vtref.py`：查虚表槽位；
    - `qw.py`：打印指针表；
    - `bx.py`：拆分批量反编译结果。
  - **导入表：** `wallpaper64_imp.txt`、`wallpaperui_imp.txt`。
- **沿用的已有文件：** `wndproc_21e50.c`（本报告提到的 wndproc 行号都以它为准）、`main_a220.c`、`run_1eae0.c`、`control_8270.c`、`ann.py`、`run.py`、`strs.py`、`rs.py`。

---

## 附：`get_settings` 应列出的键

键路径都在 `config.json` → `<Windows 用户名>` 下（当前用户段是 `cmtheit`）。「当前值」取自 `config.before.json`。

### 渲染 / 画质（场景）

| 键路径 | 含义 | 取值（界面 / 主进程） | 缺失时默认 | 当前值 | 类别 |
|---|---|---|---|---|---|
| `general.user.fps` | 帧率上限 | 整数；界面 10…显示器最高刷新率 | 15 | 20 | 就地 / 新窗口 |
| `general.user.msaa` | 抗锯齿 | `none` `x2` `x4` `x8` | `x2` | `none` | 桌面重载 / 新窗口 |
| `general.user.postprocessing` | 后处理（泛光 / HDR） | `disabled` `enabled` `ultra` `displayhdr`（仅支持 HDR 时） | `disabled` | `disabled` | 桌面重载 / 新窗口 |
| `general.user.resolution` | 纹理分辨率 | `full` `half` `auto` | `full` | `full` | 桌面重载 / 新窗口 |
| `general.user.shadows` | 阴影 | `disabled` `low` `medium` `high` `ultra` | `medium` | `low` | 桌面重载 / 新窗口 |
| `general.user.volumetrics` | 体积光 | 同上 | `medium` | `low` | 桌面重载 / 新窗口 |
| `general.user.reflection` | 反射 | bool | true | false | 就地 / 新窗口 |
| `general.user.preset` | 界面画质标签 | `low` `medium` `high` `ultra` | — | `low` | 主进程不读 |

### 播放策略（只作用于桌面壁纸，测试窗口不受影响）

| 键路径 | 含义 | 取值 | 当前值 | 类别 |
|---|---|---|---|---|
| `general.user.playbackfocus` | 其他程序获得焦点 | `run` `mute` `pause`（多显示器时 `pauseall`） | `run` | 就地 |
| `general.user.playbackmaximized` | 其他程序最大化 | `run` `mute` `pause` / `pauseall` `stop` | `pause` | 就地 |
| `general.user.playbackfullscreen` | 其他程序全屏 | 同上 | `pause` | 就地 |
| `general.user.playbacksleep` | 显示器休眠 | `run` `pause` `stop` | `stop` | 就地 |
| `general.user.playbackonbattery` | 使用电池 | `run` `pause` `stop` | `run` | 就地 |
| `general.user.playbackaudio` | 其他程序在播放声音 | `run` `mute` `pause` | `run` | 就地 |
| `general.user.apprules` | 按程序的规则 | 数组 / null | null | 就地 |
| `general.user.unpauseaero` | — | bool | true | 就地 |
| `general.user.pausevram` | 显存不足时暂停 | bool | false | 就地 |

### 性能 / 运行

| 键路径 | 含义 | 取值 | 当前值 | 类别 |
|---|---|---|---|---|
| `general.user.processpriority` | 进程优先级 | `normal` `belownormal` | `normal` | 就地 |
| `general.user.highprecisiontimer` | 高精度计时器 | bool | true | 就地 |
| `general.user.windowupdaterate` | 播放策略轮询间隔（ms） | 整数，夹在 50–5000；默认 1000 | 1000 | **启动** |
| `general.user.loglevel` | 日志级别 | `none` `error` `verbose` | `error` | 就地 |
| `general.user.safemode` | 防止崩溃 | bool；默认 true | true | **启动** |
| `general.user.anticrash` | 崩溃后重启 | bool / null | null | **启动** |
| `general.user.monitordetection` | 显示器识别方式 | `managed` `devicepath` `layout` `shellapi` `gdi` … | `managed` | **启动** |
| `general.user.vdesktopenabled` | 虚拟桌面支持 | bool | false | **启动** |
| `general.user.plugindelay` | 插件延迟 | 整数 | 0 | 启动 |
| `general.user.plugins.ledextensions.enabled` | LED 插件 | bool | true | 界面标为需重启 |

### 视频 / 音频

| 键路径 | 取值 | 当前值 | 类别 |
|---|---|---|---|
| `general.user.videoframework` | `mfEngine` `mf` `dshow.lav.vmr9` | `mfEngine` | 桌面重载 |
| `general.user.webmframework` | `cef` `native` / null | null | 桌面重载 |
| `general.user.videohardwareacceleration` | bool | true | 就地（推） |
| `general.user.videoreadmode` | `fromdisk` `frommemory` | `fromdisk` | 就地（推） |
| `general.user.videoloopmode` | `default` `syncclock` `synctopo` | `default` | 就地（推） |
| `general.user.videoaudiooutput` | bool | true | 就地 |
| `general.user.videomfstutterhack` | bool | false | 界面标为需重启 |
| `general.user.audioinputdevice` | `default` / 设备 id | `default` | 就地 |
| `general.user.audioinputvolume` | 0–200 | 50 | 就地 |
| `general.user.audioinputthreshold` | 0–10，步长 0.1 | 0 | 就地 |
| `general.user.reloadaudio` | bool | true | 就地 |
| `general.user.mediaintegration` | bool | true | 就地 |
| `general.user.mediablocklist` | 数组 / null | null | 就地 |

### 其他上下文（供参考）

- **壁纸选择：**
  - `general.wallpaperconfig.selectedwallpapers.<Monitor>.file`；
  - `general.wallpaperconfigscreensaver`；
  - `wproperties.<壁纸路径>.<Monitor>`。
- **注册表 `HKCU\Software\WallpaperEngine`：** `faultyShutdown`、`hideTrayIcon`、`disablePlugins`。
- **运行状态：**
  - 设置窗口是否开着（命令行带 `-window settings` 的 `wallpaperui.exe`）；
  - WPE 的进程号及其完整性级别。
- **界面相关键（可选列出）：**
  - `uiskin`、`uiskinseasonal`、`uiquality`、`uieffects`；
  - `uihardwareacceleration`、`cefcommandline`、`language`、`iconopacity`；
  - `adjustdwmcolormode`、`browsetransition`、`overridewallpaper`、`overridelockscreen`、`slideshowkiller`；
  - `autostart*`。

  其中 `language`、`iconopacity`、`adjustdwmcolormode`、`browsetransition`、`override*`、`slideshowkiller` 主进程也会就地应用。
