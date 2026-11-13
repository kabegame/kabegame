> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`；`scenescript64.dll` 按 `0x180000000`；`winrtutil64.exe` 按 `0x140000000`，与 `wallpaper64.exe` 是不同的文件，下文凡 `winrtutil` 的地址都会注明）。只读码，没有实测。

# WPE 2.8.42 P11 脚本侧：系统媒体集成（SMTC）与 `engine.openUserShortcut` 静态逆向

**概括**

- **媒体数据不在 `wallpaper64.exe` 里取，而是一个子进程。** 第一个媒体监听者登记时，`wallpaper64` 拉起 `bin\winrtutil64.exe -mediainterface`（C++/WinRT，`Windows.Media.Control`），经命名管道通信；最后一个监听者注销时发消息 5 让它退出（等 3 s 不退就强杀）【确】。媒体集成可用的条件是 Windows 10 build ≥ 17763 且设置 `mediaintegration` 为真【确】。
- **会话选择完全交给系统的「当前会话」。** `winrtutil` 订阅管理器的 `CurrentSessionChanged` 与 `SessionsChanged`，两者都只做一件事：重新取 `GetCurrentSession()`。当前会话的 `SourceAppUserModelId` 在黑名单里时，按 `GetSessions()` 的顺序取第一个不在黑名单里的会话；都不行就当作没有会话【确】。换会话时注销旧会话的三个事件、在新会话上注册 `MediaPropertiesChanged` / `PlaybackInfoChanged` / `TimelinePropertiesChanged`，并立即各取一次【确】。没有会话时推一个「全部字段复位」的事件（字符串全空、无封面、状态 0、时间 0）【确】。
- **三类数据全是事件驱动，没有轮询，时间轴也不插值。** 属性：`TryGetMediaPropertiesAsync` 最多等 5 s，取 7 个字段；有封面时异步读流、重新编码成 PNG 并算配色之后，属性和封面一起入队，没封面立即入队【确】。播放：`PlaybackStatus` 4（Playing）→ 1、5（Paused）→ 2，其余（Closed / Opened / Changing / Stopped）→ 0【确】。时间轴：`position = Position`、`duration = EndTime`，都是 TimeSpan **整数截断到秒**再转 float；只在应用自己发 `TimelinePropertiesChanged` 时才取，`StartTime` 与 `LastUpdatedTime` 不用【确】。
- **字段的具体取值。** `contentType` 来自 `MediaProperties.PlaybackType`：1 → `"music"`、2 → `"video"`、3 → `"image"`，空或 0 → `""`（不是 d.ts 说的 `"audio"`）【确】。`genres` 用 `,` 连接、不加空格【确】。超长字段整段清空（不是截断）：`title` / `artist` / `genres` 超过 1024 字节，`subTitle` / `albumTitle` / `albumArtist` 超过 256 字节【确】。
- **三层去重 / 合并，场景里不合并。**
  1. `winrtutil` 每 100 ms 取一次自己的队列，丢掉不是当前会话发来的事件；每类数据和上次发出的值比，没变就不发（属性比 7 个字符串，封面比字节，播放比状态，时间轴比两个 float）【确】。
  2. `wallpaper64` 主线程在定时器 `0x68`（间隔 = 设置 `windowupdaterate` 钳到 50–5000 ms，本机 config 为 1000）里读管道，把收到的消息并进一个「待发事件」（flags 按位或，值取最后一条），然后每个监听者收两个事件：先是属性 / 播放 / 时间轴 / 状态合成的一个（`flags & 0x1d`），再是封面单独一个（`flags = 2`）【确】【推：读管道的函数没逐行核对】。
  3. 场景侧的监听回调把每个事件原样拷进场景自己的队列，**不合并**；每帧把队列取空，逐条派发【确】。
- **场景什么时候接入。** 场景的媒体状态对象 `M`（`P+0x140`）按需创建：某个脚本导出了任一媒体回调（回调掩码 `& 0x7c000`），或场景里有 `type: "system"` 的纹理绑定；创建时向全局媒体对象登记监听，并要求收解码后的 RGBA 封面【确】【推：绑定种类 1 = system 是推断】。
- **新监听者的补发（全局层）。** 登记时：若媒体集成不可用 → 立即给它一个 `{status, enabled: false}`；若可用且已有别的监听者（子进程在跑）→ 立即给它一个合成事件：`status(enabled: true)`，加上缓存里非空的项（`title` 非空才带属性、有封面字节才带封面、状态非 0 才带播放、`duration` 非 0 才带时间轴）；若可用且它是第一个 → 只拉起子进程，数据随后由子进程送来（子进程的去重缓存是新的，会把非缺省的值都发一遍）【确】。
- **补发（脚本层，init 之后）。** `FUN_140172830` 对本次刚跑完 `init` 的脚本，按 状态 → 播放 → 属性 → 封面 → 时间轴 的顺序补发 `M` 里的当前值：`M.enabled` 非 0 才发状态（`M` 新建时 enabled = 1，所以通常会发 `{enabled: true}`），状态非 0、`title` 非空、有封面、`duration` 非 0 才发后四个【确】。补发直接调引擎，不走每帧派发；补发之后才是首次 `applyUserProperties`【推：沿用 P3 的顺序】。
- **每帧派发的位置与顺序。** 每帧脚本函数 `FUN_140171440` 最先处理媒体队列（之后才是 `P+0x148` 快捷方式图标队列、动画与 `animationEvent`、`engine.Tick` 与计时器、`update`）。每取出一条事件，按固定顺序处理：
  1. `flags & 2`：先把封面当用户属性增量应用（`$mediaThumbnail = "mediaThumbnail_<N>.system"`，有上一张时另带 `$mediaPreviousThumbnail`），走 `FUN_1401731d0`，导出了 `applyUserProperties` 的脚本会收到 `{}`；
  2. `& 0x10` → `mediaStatusChanged`；3. `& 4` → `mediaPlaybackChanged`；4. `& 1` → `mediaPropertiesChanged`；5. `& 2` → `mediaThumbnailChanged`；6. `& 8` → `mediaTimelineChanged`。
  每个回调发给场景里**全部**状态为 2（init 已跑）且导出该回调的脚本，按脚本登记顺序；收到就调，不比较新旧值【确】。所以全局层的一次刷新，在场景里通常表现为：状态 / 播放 / 属性 / 时间轴，然后（下一条事件）封面属性增量 → `applyUserProperties({})` → `mediaThumbnailChanged`【推】。
- **事件对象是普通对象，不是 d.ts 里那几个类的实例。** dll 用 `Object::New` 现建，字段名用引擎缓存的字符串；颜色是带 `Vec3` 原型的对象（`r/255, g/255, b/255`，float32 除法再转 double）；`hasThumbnail` / `enabled` 是布尔；`state` 是整数；`position` / `duration` 是 float32 转 double（值本身是整秒）【确】。只有 `MediaPlaybackEvent` 在全局里存在（`baseclasses.js` 顶层的 `class`，带三个 `static` 常量），其余四个事件类运行时没有定义【确】。
- **回调参数与返回值。** 媒体回调只有一个参数（事件对象），没有 `value`；返回值不写回（CallCallback 只对 0、1、6 号回调写回）【确】。
- **暂停 / 被遮挡。** 帧函数不跑时 `FUN_140171440` 不跑，事件留在场景队列里（无上限、不丢、不合并），恢复后的第一帧按先后全部派发【推：依据 rea-p10 第 12 条与队列代码】。`ctx+0x118 & 0xc000000` 置位时同样整段跳过【确】。
- **`usershortcut` 的值是一个字符串：`<类型>:<6 位系统哈希>:<路径>[|<参数>]`。** 类型只认 `file` / `directory` / `web` / `cmd`；`file` 的参数用 `|` 分隔，`cmd` 在第一个空格处拆成程序与参数；`web` 在界面里补 `https://`（已以 `http://`、`https://`、`www.`、`steam://` 开头的不补）；路径为空即未绑定（值为 `""`）【确】。系统哈希 = `sha256(MachineGuid 的 UTF-16 字节 ‖ 14 27 db 88 1d)` 小写十六进制的前 6 位，所以别的机器上配的值在本机启动时会被拒（`User shortcut blocked.`）【确：结构】【推：注册表缓冲区是否含结尾 NUL】。
- **`engine.openUserShortcut(name)` 的门禁。**
  - dll：当前正在执行的回调必须是 `cursorClick` / `cursorDown` / `cursorUp`（编号 11–13），否则**抛** `Error("Cannot execute user command outside of cursor callbacks.")`；参数缺失或不是字符串返回 `false`【确】。
  - exe：一个「用户命令令牌」（场景对象 `+0xe0` 的 bit 28）在左键**按下**的那一帧置位、在左键**松开**的那一帧光标处理末尾清除；每次调用先消耗令牌，没有令牌时 dll **抛** `Error("Cannot execute more than one user command per cursor click.")`。所以一次按下—松开最多成功调一次，失败的调用也会用掉令牌【确】。
  - 之后按名字在用户属性全集里查值：查不到、`value` 不是字符串、值解析失败（类型不认识 / 中段不是 6 位 / 路径为空）、系统哈希不符、`ShellExecuteW` 返回 ≤ 32，都返回 `false`；成功返回 `true`【确】。**不检查属性的 `type` 是不是 `usershortcut`**【确】。
- **启动方式。** 在脚本线程（即渲染线程）上同步调 `ShellExecuteW(NULL, NULL, 路径, 参数或 L"", NULL, SW_SHOWNORMAL)`，不按类型区分处理，`.lnk` / `.url` / 目录 / exe / URL 都交给 Shell 的缺省动词【确】。
- **`applyUserProperties` 与 `engine.userProperties` 里的 `usershortcut`。** 增量里的对象是 `{isbound, commandtype, file}`：值能解析时 `isbound = true`、`commandtype` 经静态表映射（`file`→`file`、`directory`→`directory`、`web`→`website`、`cmd`→`command`）、`file` 对 `web` / `cmd` 是整串路径，对 `file` / `directory` 是最后一个 `/` 之后的文件名（路径先经 `FUN_1400187b0` 规整）【确：映射表与取文件名】【推：`isbound` 不校验系统哈希、解析失败时的取值】。

**对 Kabegame 的提示**（推断，供 P11c / P11d 子计划参考）
- 宿主收到的媒体消息形状照「待发事件」做：一次刷新给场景两条（`0x1d` 合成 + 封面），场景里照 `FUN_140171440` 的固定顺序逐条处理；封面先走用户属性增量（`applyUserProperties({})` 也要调），再调 `mediaThumbnailChanged`。
- 时间轴不要自己插值、不要按帧推：WPE 只在源应用发事件、且整秒数变了时才更新，再被主线程定时器（本机 1 s）节流。
- `MediaPlaybackEvent` 进 realm（带 `static` 常量），其余四个事件类不定义；事件对象用普通对象，颜色用 `Vec3`。
- init 后的补发与「新监听者补发」是两层：宿主只需实现脚本层（按 `M` 当前值、`M` 新建时 `enabled = 1`）加上「订阅时由后端回放缓存状态」。
- `openUserShortcut` 我们比 WPE 多做一道 `type === "usershortcut"` 检查是安全的（WPE 不查，但 WPE 有机器哈希兜底，我们没有）。

**元数据**
- 目标：`wallpaper64.exe` 副本 `ignore/p9/rea/wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`；`scenescript64.dll` 副本 `ignore/p10/rea/scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`。开工时与安装目录原件逐个 `sha256sum` 核对，一致。
- 另拷了两个原件（同样核对过哈希）到工作目录：`bin\winrtutil64.exe`（SHA-256 `42c4801b194bf06408e176d6869407c193e47ad995714ccdcfd5b4e7a0daf1e0`，SMTC 子进程）、`bin\mediaextensions64.dll`（SHA-256 `898ffaa06ac56f46b7ac7e182fc0b6c750fc585f8554606713e0468977e0dbc3`，OpenAL 声音，只用来排除）。
- 只读码，没有运行 WPE，没改 Steam 目录；只读了本机 `config.json`（`general.user.mediaintegration = true`、`mediablocklist = null`、`windowupdaterate = 1000`）、`assets\scripts\jsclasses\baseclasses.js`、`ui\dist\scripts\scripts.js`、`lib.sceneScript.d.ts` 与 3 个语料工程的 `project.json`。
- 方法：`ignore/p4/rea/wp.asm` 按地址切片读汇编；dll、`winrtutil64.exe`、`mediaextensions64.dll` 用 `llvm-objdump` 反汇编；SMTC 的 vtable 偏移按本机 Windows SDK 10.0.26100 的 `winrt/windows.media.control.h` 对照（IInspectable 6 槽之后按声明顺序，`+0x30` 起）；委托用参数化 IID 定位。
- REA：把 `ignore/p10/rea/wallpaper64-2.8.42-p10.rea-snapshot` 拷成 `ignore/p11/rea/media/wp-media-work.rea-snapshot` 打开，Ghidra 两次都在 330 s 启动期限内没导入完（同时有别的代理在用 REA），这一轮**没有用 REA 反编译**。结束时照要求另存了 `ignore/p11/rea/media/wallpaper64-2.8.42-p11-media.rea-snapshot` 并 close，内容与 p10 快照相同，没有新增标注。
- 工作文件都在 `ignore/p11/rea/media/`：
  - 脚本：从 `ignore/p10/rea/` 拷来并改了相对路径的 `fn.py`、`slice.py`、`xr.py`、`strs.py`、`pe.py`、`rd.py`、`dpe.py`、`dxref.py` 等；新写的 `strs_any.py`（任意 PE 的 ASCII / UTF-16 串）、`guid.py`（按 IID 找常量）、`wsl.py`（切 `wu.asm`）、`wfn.py`（`winrtutil` 的 .pdata）、`wq.py`（读 `winrtutil` 虚表）、`dd.sh`（dll 区间反汇编）、`jtd.py` / `jt2.py`（跳转表）、`cs.py`（读串）、`f32.py`、`qref.py`（找虚表槽）、`vt.py`、`imp.py`（IAT）、`mexp.py`、`pat158.py`、`cfg.py`、`us.py`。
  - 全量反汇编：`wu.asm`（`winrtutil64.exe`）。
  - 汇编摘录 `asm/`：exe 的 `frame_media_140171440.asm`、`init_140172830.asm`、`ensure_media_140177cf0.asm`、`scene_listener_14017a8b0.asm`、`add_media_listener_1400c76a0.asm`、`flush_media_1400c1890.asm`、`pipe_in_1400cbaa0.asm`、`set_enabled_1400c8340.asm`、`settings_media_14006cd8b.asm`、`host_openusershortcut_14018f7d0.asm`、`parse_shortcut_1401708c0.asm`、`launch_shortcut_1400c5090.asm`、`cursor_140189e10.asm`、`add_shellthumb_listener_1400c66d0_tail.asm`；dll 的 `dll_media_events_18164ee18.asm`、`dll_openusershortcut_181656b70.asm`、`dll_field_strings_181648400.asm`；`winrtutil` 的 `wu_mi_main*.asm`、`wu_setsession_1400338d0.asm`、`wu_refresh_current_140035e60.asm`、`wu_props.asm`、`wu_thumb.asm`、`wu_playback_1400355b0.asm`、`wu_timeline_1400359d0.asm`、`wu_pipe_in_140045cc0.asm`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。

**命名**
- `A`：全局媒体 / 音频对象 `0x1404e55a0`（rea-p4e-audio 叫 `AudioProcessor`，就是同一个对象）。**真正的 vptr 是 `0x140485fe0`**（构造函数 `0x1400c0c80`，`0x1400c0c99`）。P3 报告写的「应用对象虚表 `0x140485fa8` 第 39 槽」与这里「`0x140485fe0` 第 32 槽」是同一个函数 `0x1400c4e80`；下文槽号一律按 `0x140485fe0` 计。
- `E`：`MediaIntegration::Event`，0x178 字节，两个进程同一布局：`+0` flags（1 属性、2 封面、4 播放、8 时间轴、0x10 状态）、`+8` appId（`std::string`）、`+0x28` 会话的 `IUnknown`（只在 `winrtutil` 里用）、`+0x30/+0x50/+0x70/+0x90/+0xb0/+0xd0/+0xf0` 依次是 title / subTitle / albumTitle / albumArtist / artist / genres / contentType（各一个 `std::string`）、`+0x110` 封面块（`+0x110` 字节 vector、`+0x128` MIME 串、`+0x150..+0x160` 五个打包颜色：主 / 次 / 第三 / 文字 / 高对比）、`+0x168` 播放状态、`+0x16c` position、`+0x170` duration、`+0x174` enabled（构造时为 1，exe `FUN_1400c1390`、`winrtutil` `0x140033c30` 一致）。
- `A.pending` = `A+0x4f0` 处的一个 `E`；`A+0x450` 监听者表的锁；`A+0x4b0` 监听者表（无序表，链头 `+0x4b0`、大小 `+0x4b8`）；`A+0x668` 子进程 / 管道对象（`-1` 表示没在跑）；`A+0xb60` bit0 媒体集成开关、bit1 屏保模式；`A+0xb68` 黑名单 JSON 串。
- `R`：场景渲染器；`P = R+0x1718`（脚本与动画管理器，同 rea-p10）；`ctx = [P+8]`（帧标志在 `ctx+0x118`）。`M = [P+0x140]`：场景的媒体状态对象，0x288 字节（`+0` 监听者 id、`+4` 封面计数器、`+8` 当前封面纹理名、`+0x28..+0xe8` 七个字符串、`+0x108` 当前封面块、`+0x160` 上一张封面块、`+0x1b8` 状态、`+0x1bc/+0x1c0` position / duration、`+0x1c4` enabled、`+0x1c8` 队列锁、`+0x218..+0x238` 事件 deque、`+0x240` 条件变量）。
- `SC`：光标处理函数 `FUN_140189e10` 的第一个参数（场景对象，通用标志在 `SC+0xe0`，`R = [SC+0xd8]`）。
- `G`：脚本引擎（dll），`G+0x628` 当前回调位、`G+0x62c` 当前回调编号（空闲时为 0x13）；事件字段名的持久串在 `G+0x230..+0x2b0`。

---

## 1. 数据来源：`winrtutil64.exe -mediainterface`

### 1.1 进程与开关【确】

- 字符串线索：`wallpaper64.exe` 里没有任何 `Windows.Media.*` 串，只有 `-mediainterface`（`0x1404865e0`）、`__WPXProviderAPIMediaControlPID`（`0x1404865f0`）/ `…SSPID`（`0x1404865b0`）。`winrtutil64.exe` 里有 `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`（UTF-16，`0x14034af00`）和 `-mediainterface`（`0x14034b438`），`main` 在 `0x1400381f6` 认这个开关后进 `0x140031fb0`。
- 启动：`A` 的 `StartMediaControl`（`0x1400c8b60`，另有一份内联在 `0x1400c66d0`）拼 `<安装目录>\bin\winrtutil64.exe`，命令行 `-mediainterface`，再按 `A+0xb60 & 2` 选 `…SSPID`（屏保）或 `…PID`，交给 `0x1400832c0`（通用的「起子进程 + `\\.\pipe\` 管道」）。起来后立刻发消息 6，内容是 `A+0xb68` 的黑名单 JSON（为空也发）（`0x1400c8dc8`）。
- 停止：`0x1400c8e60` 发消息 5（`winrtutil` 把运行标志清零，`0x1400468a2`），最多等 3000 × `Sleep(1)`，还没发完就 `TerminateProcess(-1)`，再关句柄（`0x1400c9246`–`0x1400c92e1`）。
- 谁拉起、谁停：
  - `AddMediaListener` = `A` 的 vtable `+0x158`（第 43 槽，`0x1400c76a0`）：监听者表为空且「可用」时拉起（`0x1400c7763`）。
  - `AddShellThumbnailListener` = `+0x120`（第 36 槽，`0x1400c66d0`，快捷方式图标用）也会拉起同一个子进程（表为空时）。
  - 注销监听者使表变空时停止（`0x1400c70ea`–`0x1400c70f7`）。
- 「可用」（`0x1400c76d1`–`0x1400c7736`）：`GetVersionExW`（`OSVERSIONINFOW`，大小 0x114）后，`0x140015180(10, 0, 0)` 为真且 `dwBuildNumber ≥ 0x4563`（17763，即 1809），且 `A+0xb60 & 1`（设置 `mediaintegration`）。

### 1.2 会话选择（`winrtutil`）【确】

- 启动：`RequestAsync`（statics IID `2050c4ee…` 在 `0x14034a4f8`，`0x14002d840`）同步等到管理器，然后在管理器上 `add_CurrentSessionChanged`（`+0x40`，委托 vtable `0x14034a050`）、`add_SessionsChanged`（`+0x50`，`0x14034a178`）（`0x140032257`、`0x1400322cb`）。两个委托的 `Invoke` 都是 `0x1400469e0` → `RefreshCurrentSession(0x140035e60)`。
- 首次取会话不是在启动时，而是收到消息 6（黑名单）之后：消息 6 的处理（`0x140045fe8`）清空集合、解析 JSON、把每个对象的 `appid` 串放进集合，最后调 `RefreshCurrentSession`（`0x140046805`）。因为 `wallpaper64` 拉起后必发消息 6，效果上就是「启动即取」。
- `RefreshCurrentSession`（`0x140035e60`，持锁）：
  ```c
  cur = manager.GetCurrentSession();                  // +0x30
  if (!cur) { SetSession(null); return; }
  if (blocklist.find(cur.SourceAppUserModelId) == end) { SetSession(cur); return; }
  for (s : manager.GetSessions())                     // +0x38，IVectorView 的 Size/GetAt
      if (s && blocklist.find(s.SourceAppUserModelId) == end) { SetSession(s); return; }
  SetSession(null);
  ```
  集合是 FNV-1a 哈希的无序集合，按 appId 完整匹配、区分大小写（`0x140041700` 比较）。
- `SetSession(s)`（`0x1400338d0`，持锁）：
  1. 在旧会话上 `remove_MediaPropertiesChanged`（`+0xf0`）、`remove_PlaybackInfoChanged`（`+0xe0`）、`remove_TimelinePropertiesChanged`（`+0xd0`），清掉三个 token。
  2. 当前会话换成 `s`。
  3. `s` 为空：构造一个 `E`，**flags = `0xffffffff`**，其余全是缺省值（空串、无封面、状态 0、0/0、enabled 1），入队（`0x1400339cb`–`0x1400339ec`）。
  4. 否则：`add_MediaPropertiesChanged`（`+0xe8`，委托 `0x14034a880`）后立即 `GetProperties`；`add_PlaybackInfoChanged`（`+0xd8`，`0x14034a688`）后立即 `GetPlayback`；`add_TimelinePropertiesChanged`（`+0xc8`，`0x14034a0c0`）后立即 `GetTimeline`。三个委托的 `Invoke`（`0x140046b20`、`0x140046ac0`、`0x140046a60`）就是分别再调这三个函数。
- 会话身份：每个 `E` 里存了会话的 `IUnknown`（`E+0x28`）。主循环取出事件时与当前会话的 `IUnknown` 比，不同就丢（`0x140032883`–`0x1400328ba`），所以切会话后旧会话的迟到事件不会发出去。

### 1.3 三类数据（`winrtutil`）【确】

- **属性** `GetProperties`（入口 `0x140033d80`，主体 `0x140033dd2`–`0x1400352ff`）：
  - `TryGetMediaPropertiesAsync`（`+0x38`），等最多 5000 ms（`0x1400337c0(…, 0x1388)`，状态不是 Completed 就整次放弃，什么也不入队）【推：`0x1400337c0` 的语义】。
  - 新建 `E`，flags = 1（`0x140034013`）；`Title`（`+0x30`）→ `E+0x30`、`Subtitle`（`+0x38`）→ `+0x50`、`AlbumTitle`（`+0x50`）→ `+0x70`、`AlbumArtist`（`+0x40`）→ `+0x90`、`Artist`（`+0x48`）→ `+0xb0`；会话的 `SourceAppUserModelId`（`+0x30`）→ `E+8`；会话 `IUnknown` → `E+0x28`。字符串都是 UTF-16 → UTF-8（`WideCharToMultiByte(CP_UTF8)`）。
  - `PlaybackType`（`+0x70`，`IReference<MediaPlaybackType>`）：1 → `"music"`、2 → `"video"`、3 → `"image"`，其它（含空引用、0）不写，`contentType` 保持空（`0x140034db9`–`0x140034dee`，串在 `0x14034b3e0..0x14034b3f0`）。
  - `Genres`（`+0x60`，`IVectorView<HSTRING>`）逐项拼进 `E+0xd0`，项与项之间追加一个 `,`（`0x140035117`，`dl = 0x2c`），没有空格。
  - `Thumbnail`（`+0x78`）：为空 → 立即入队（`0x1400351a8`–`0x1400351b7`）；否则 `OpenReadAsync`（`+0x30`）挂完成回调，在协程 `0x140046c20` 里读流、解码、重新编码成 PNG（`0x140066b90`，MIME `image/png` 写进 `E+0x128`）、算五个颜色（`0x140065590` 与 `0x140048280` 一段），然后把**同一个** `E`（flags 仍是 1）入队（`0x140048600`、`0x14004863f`）。其中对 appId 以 `spotify` 开头的会话有特殊处理（`0x140047de1`）——这些归纹理侧代理，这里只记地址。
- **播放** `GetPlayback`（`0x1400355b0`）：`GetPlaybackInfo`（`+0x48`）→ `PlaybackStatus`（`+0x38`）；`4 → 1`、`5 → 2`、其余 `→ 0`（`0x14003565f`–`0x140035684`）；flags = 4。
- **时间轴** `GetTimeline`（`0x1400359d0`）：`GetTimelineProperties`（`+0x40`）；`Position`（`+0x50`）与 `EndTime`（`+0x38`）的 100 ns 计数各做有符号整数除以 10⁷（魔数 `-0x29406b2a1a85bd43`、`sar 0x17`，即 `duration_cast<seconds>` 截断），再 `cvtsi2ss` → `E+0x16c` / `E+0x170`；flags = 8。不读 `StartTime`、`LastUpdatedTime`、`MinSeekTime`、`MaxSeekTime`。
- **没有轮询**：三个取值函数的调用者只有 `SetSession` 和三个委托（全文件交叉引用）。时间轴多久更新一次完全取决于源应用多久发一次 `TimelinePropertiesChanged`，再叠加后面的去重与节流。

### 1.4 `winrtutil` 主循环与管道消息【确】

`0x140031fb0` 主循环：取空内部事件队列（锁 `0x140396e00`，deque `0x140396e58..`），队列空时 `Sleep(100)`（`0x140033373`），直到收到消息 5。每条事件：

| `E.flags` 位 | 去重 | 管道消息码与载荷 |
|---|---|---|
| 1 属性 | 7 个字符串与上次发出的全部相同则不发（`0x1400329c9`–`0x140032b59`）。发之前超长的整段清空：title、artist、genres > 0x400；subTitle、albumTitle、albumArtist > 0x100（`0x140032caf`–`0x140032d84`） | 码 1：七个以 NUL 结尾的串（顺序同 `E`）+ appId（截到 64 字节，`0x1400328c0`） |
| （随属性）封面 | 只在处理属性事件时比较：字节与上次发出的不同（含「有 → 无」）才发（`0x140032b5b`–`0x140032b92`）；MIME 超过 0x100 清空 | 码 2：五个 u32 颜色 + MIME 串 + 字节长度 + PNG 字节 + appId |
| 4 播放 | 与上次发出的状态相同不发（`0x1400331f9`） | 码 3：状态 + appId |
| 8 时间轴 | `(position, duration)` 与上次发出的完全相同（`ucomiss`）不发（`0x1400332a5`） | 码 4：两个 float + appId |
| 0x10 状态 | `winrtutil` 不处理这一位 | — |

- 去重缓存只在进程里，进程重启后清零，所以重启后第一次会把所有非缺省的值都发一遍。
- 「没有会话」的 `0xffffffff` 事件经这张表变成：属性全空（若上次不是全空）、封面清空（若上次有）、状态 0（若上次非 0）、`0/0`（若上次不是）。
- 码 10 是快捷方式图标的应答（入站消息 8、9 → `0x14002f990` / `0x14002fb10`，`InternetShortcut` 段读 `.url`），归纹理侧。

### 1.5 `wallpaper64` 侧：合并与刷新【确】（另注【推】处）

- 管道消息处理 `0x1400cbaa0`（`A` 的回调）：
  - 码 1（`0x1400ccc29`）：七个串按顺序读进局部，再整块拷进 `A.pending` 的 `+0x30..`（`0x1400c2030`），appId → `pending+8`，`pending.flags |= 1`。
  - 码 2（`0x1400cc8f7`）：封面块 → `pending+0x110`，`|= 2`（中间调了 `0x14009c500`，归纹理侧）。
  - 码 3（`0x1400cc856`）：`pending.state`，`|= 4`。码 4（`0x1400cc781`）：position、duration，`|= 8`。
  - 所以两次刷新之间同类消息只留最后一条，各类的 flags 按位或。
- `FlushMedia`（`0x1400c1890`）：
  1. `A+0x668 == -1`（子进程没在跑）就什么也不做；否则先 `0x140084700(A+0x668)` 处理管道收件（这一步就是上面的 `0x1400cbaa0`）【推：`0x140084700` 的内部没逐行读】。
  2. `pending.flags & 0x1d` 非 0：拷一份事件，flags = `pending.flags & 0x1d`，带上 pending 的全部当前值（字符串、状态、时间、enabled），清掉这几位；持锁遍历监听者表，逐个调其回调（`0x1400c1a4c`）。
  3. `pending.flags & 2`：另拷一份 flags = 2 的封面事件，清掉 bit1；监听者登记时若要求像素（`+0x98` 字节为 1），给它一份把 PNG 解成 `w × h × 4` RGBA 的事件（`0x1400c0710`，解一次复用），否则给 PNG 原样（`0x1400c1c75`–`0x1400c1e78`）。
  4. pending 的值字段不清，只清 flags，所以它同时是「最近一次已知状态」的缓存。
- 刷新时机：`FlushMedia` 唯一的调用点是 `0x14006cee0`，由主线程窗口过程处理定时器 `0x68`（及 `0x6a`）的分支调用（`0x140023e5b` 跳转表、`0x140023f27`）。定时器 `0x68` 在 `0x14001f523` 以 `SetTimer(hwnd, 0x68, clamp(config["windowupdaterate"].asInt(), 50, 5000))` 设置（键名串 `0x140474a80`）。本机 config 的 `windowupdaterate` 为 1000，即约 1 s 一次【确：这一处设置点】【推：没有别处改这个定时器的间隔】。
- 初始状态位：`A` 构造时 `pending.flags |= 0x10`（`0x1400c132f`，enabled 为缺省 1），所以进程里第一次成功刷新会带一次「状态 enabled = true」。之后只有改设置时才再置 0x10（1.6）。

### 1.6 设置 `mediaintegration` / `mediablocklist`【确】（另注【推】处）

- 应用设置的函数在 `0x14006cd8b`：`config["mediaintegration"].asBool()` → `SetMediaIntegrationEnabled(A, b)`（`0x1400c8340`）；`config["mediablocklist"]` → `0x1400c88c0`。本机两键的位置是 `general.user.mediaintegration` / `general.user.mediablocklist`。
- `SetMediaIntegrationEnabled`（`0x1400c8340`）：
  - 与当前位相同直接返回。
  - 打开：置位；子进程没在跑且有监听者 → 拉起。
  - 关闭：清位；子进程在跑时，若没有快捷方式图标的监听者（`A+0x4ec == 0`）就停掉子进程；然后 `pending.flags = 0xffffffff`，把 pending 的字符串、封面、状态、时间全部清空（`0x1400c83dc`–`0x1400c8832`）。
  - 最后（开关两种都走）：`pending.flags |= 0x10`，`pending.enabled = b`（`0x1400c8856`–`0x1400c8864`）。
  - **推论**：关闭时若子进程被停（`A+0x668 = -1`），`FlushMedia` 不跑，正在运行的场景收不到 `enabled: false` 与清空事件，要等下次子进程拉起后的第一次刷新才收到（那时 0x10 位已被打开操作改成 enabled = true）【推：依据 `0x1400c92e1` 跳 `0x140084130` 关闭进程对象后句柄变 −1；未逐行核对】。
- 黑名单：`0x1400c88c0` 把 JSON 序列化存进 `A+0xb68`，子进程在跑就立即以消息 6 发过去。形状来自设置界面（`ui\dist\scripts\scripts.js` 的 `SettingsMediaBlocklistCtrl`）：数组，每项 `{appid: <AUMID>}`；界面每 1 s 调 `settingsObject.getCurrentMediaSession` 显示当前会话的 appId 供用户加入。`winrtutil` 只取每项的 `appid` 字符串（`0x140046740`–`0x140046777`）。

### 1.7 新监听者登记时的补发（`AddMediaListener` `0x1400c76a0`）【确】

```c
lock(A+0x450); id = ++A.nextId;
available = win10 && build >= 17763 && (A+0xb60 & 1);
if (listeners.empty() && available) { StartMediaControl(); }          // 不给新监听者任何事件
else {
    E e;                                                             // flags 0、enabled 1
    if (!available) { e.flags = 0x10; e.enabled = 0; }              // 0x1400c7771–0x1400c7782
    else {
        e.flags = 0x10;                                             // enabled 保持 1
        if (pending.title.size())  { e.flags |= 1; copy 7 strings; }   // A+0x530
        if (pending.thumb.size())  { e.flags |= 2; copy thumb; 要像素则解码; }
        if (pending.state)         { e.flags |= 4; e.state = …; }
        if (pending.duration != 0) { e.flags |= 8; e.position/duration = …; }
    }
    listener(e);                                                     // 0x1400c7a40，同步调用
}
insert listener;                                                     // 0x1400c7aa9 起
```
- 注意第一个分支：表为空且可用时只拉起子进程，**不**给新监听者补发；数据随后由新进程送来（它的去重缓存是空的）。
- 表为空且不可用、或表不空且不可用，都立即给 `{flags: 0x10, enabled: false}`。

---

## 2. 场景侧：队列、每帧派发与补发

### 2.1 按需创建 `M` 并登记【确】（另注【推】处）

- `EnsureMediaIntegration`（`0x140177cf0`，即 RTTI 里的 `PropertySystem::LoadMediaIntegrationOnDemand`，`P` 就是 `PropertySystem`）：`P+0x140` 为空才建；`M` 新建时 enabled = 1（`0x140177e62`）、封面计数器 = 1（`0x140177d86`）、其余清零；然后 `[ctx+0x158]->AddMediaListener(回调, wantPixels = 1)`（`0x140177ef5` 设 `r8b = 1`，`0x140177f3b`），返回的 id 存 `M+0`。
- 两个调用点（都在 `FUN_140175880` 里）：
  - 脚本加载完取回调掩码后，`mask & 0x7c000`（14–18 号任一）就建（`0x1401766e2`–`0x1401766ec`）【确】。
  - 登记绑定时绑定种类 `[b+0x18] == 1` 就建（`0x1401762c9`–`0x1401763ef`）；种类 2 则建 `P+0x148` 的快捷方式图标通道（`[ctx+0x158]` 的 `+0x120`，即 `AddShellThumbnailListener`）。种类 1 / 2 对应 `usertextures` 的 `system` / `usershortcut` 项【推】。

### 2.2 监听回调：原样入队、不合并【确】

`0x14017a8b0`（std::function `_Do_call`，vtable `0x14048df18`）：拷贝事件（`0x1400c22d0`）、锁 `M+0x1c8`、`push_back` 进 `M+0x218` 起的 deque（必要时扩容）、`notify`（`M+0x240`）、解锁。没有上限，也不和队尾已有事件合并。它在调用 `listener(e)` 的线程上执行：刷新时在主线程，登记补发时在登记线程（场景加载）。

### 2.3 每帧：`FUN_140171440` 的媒体段【确】

```c
if (ctx->flags(+0x118) & 0xc000000) return;                    // 整段跳过，队列保留
if (M) {
  thumbChanged = false;
  lock(M+0x1c8);
  while (!queue.empty()) {
    E e = queue.pop_front(); unlock();
    if (e.flags & 2) {                                          // 0x14017166c
      M.prevThumb = M.thumb; M.thumb = e.thumb;                 // M+0x160 ← M+0x108 ← e
      old = M.name;                                             // M+8
      M.name = "mediaThumbnail_" + to_string(M.counter) + ".system";
      delta = { "$mediaThumbnail": {value: M.name} };
      if (old.size()) delta["$mediaPreviousThumbnail"] = {value: old};
      P.delta(+0x38) = delta; P.full(+0x10) = merge(P.full, delta);
      FUN_1401731d0(P);                                        // 0x140171a8d：直接绑定 → updateScriptProperties → applyUserProperties
      M.counter++; thumbChanged = true;
    }
    if (e.flags & 0x10) { M.enabled = e.enabled; dispatch(14, &M.enabled); }        // 0x140171b36
    if (e.flags & 4)    { M.state = e.state;     dispatch(15, &M.state); }          // 0x140171b81
    if (e.flags & 1)    { copy 7 strings → M+0x28..; dispatch(16, ptrs); }          // 0x140171bcb
    if (e.flags & 2)    { dispatch(17, {hasThumb: M.thumb.size()!=0, M+0x148..0x158}); } // 0x140171e0e
    if (e.flags & 8)    { M.pos, M.dur = e…; dispatch(18, {M.pos, M.dur}); }           // 0x140171ea7
    lock(M+0x1c8);
  }
  unlock();
  if (thumbChanged) FUN_140150d60(ctx+0x1630);                  // 材质缓存，归纹理侧
}
// 之后：P+0x148 队列（快捷方式图标）→ 动画 → engine.Tick → update（rea-p10 第 1 节）
```
- `dispatch(n, arg)` = `FUN_140177ad0(P, 0, 0, n, arg)`：遍历 `P+0xd8` 的全部脚本，状态为 2 且掩码含第 n 位的逐个经引擎槽 8 `CallCallback` 调用，第一次调用前 Enter、最后 Leave（rea-p10 已读）。scope、object 传 0，所以是全场景广播。
- `FUN_1401731d0` 里 `applyUserProperties` 的参数只收同时带 `value` 和 `type` 的项（P3 I4 已确认），封面增量只有 `value`，所以导出了 `applyUserProperties` 的脚本在每次封面变化时收到 `{}`【推：两条【确】合起来的结论】。`engine.userProperties` 的缓存同时作废，之后读到 `$mediaThumbnail` 为 `"mediaThumbnail_<N>.system"` 字符串（没有 `type`，按缺省分支取 `value`）【推】。
- 封面名每次都是新的（计数器从 1 起），即使图片相同；`$mediaPreviousThumbnail` 是上一次的名字（第一次没有这一键）。`M.thumb` 为空（无封面）时同样换名、同样调 `applyUserProperties`。

### 2.4 帧内位置【确】

`FUN_14017fa70` 的顺序（rea-p10 第 1 节）里，媒体段在 `FUN_140171440` 的最前面：粒子 / 相机（`0x14017fd26`）之后，`P+0x148`、动画、`animationEvent`、`engine.Tick`（计时器）、`update` 之前；渲染在其后，属性面板排队的改值在渲染之后（`0x140180d0c`）。光标回调（`FUN_140189e10`）与本节的先后没有追【未知】，归 P6c。

### 2.5 init 之后的补发（`FUN_140172830`）【确】

- 本次把状态 0 / 1 的脚本改成 2 时，按掩码分别收进 6 个列表：bit0（init）、bit16（属性）、bit15（播放）、bit18（时间轴）、bit14（状态）、bit17（封面）（`0x1401729c3`–`0x140172b14`）。条件不满足（`P+0x134 ≠ 0` 或 `ctx+0x118 & 0xc000000`）就置 `P+0x138 = 1` 推迟（P3 已读）。
- 先对 init 列表逐个调 `init`；再（`M` 存在时）依次：
  1. `M.enabled ≠ 0` → 状态列表逐个 `mediaStatusChanged({enabled: M.enabled})`（`0x140172beb`）；
  2. `M.state ≠ 0` → 播放（`0x140172c53`）；
  3. `M.title.size() ≠ 0` → 属性（`0x140172cc1`，只看 title）；
  4. `M.thumb` 非空 → 封面，`hasThumbnail = true`（`0x140172dce`）；
  5. `M.duration ≠ 0.0` → 时间轴（`0x140172e8e`）。
- 这一段直接经引擎槽 8 调用，不经 `FUN_140177ad0`，只发给本次刚 init 的脚本。
- 推论（时序上的特例）：`M` 在脚本加载时就已建好，但监听回调推进队列的事件要到第一帧才写进 `M`。所以 init 补发时 `M` 往往还是新建值：通常只有一次 `{enabled: true}`；
  - 若媒体集成关着，登记时队列里已有 `{enabled: false}`，脚本会先在 init 补发里收到 `true`，第一帧再收到 `false`【推】；
  - 若已有别的监听者，第一帧还会再收到一次 `true` 和其余补发数据【推】。

### 2.6 一帧多条与合并：小结

| 层 | 合并方式 |
|---|---|
| `winrtutil` | 每类与上次发出的值相同就不发；切会话后旧会话事件丢弃 |
| `wallpaper64` 主线程 | 两次刷新（约 `windowupdaterate` ms）之间：同类只留最后一条；一次刷新给每个监听者至多两条（`0x1d` 合成一条、封面一条） |
| 场景 | 不合并；一帧把队列取空，每条事件按 2.3 的顺序逐位派发；每次派发前先把该条的值写进 `M`，所以每次回调看到的是那一条事件自己的值 |

所以「同一帧同类多条」只会在渲染帧率低于刷新频率、或暂停后恢复时出现，出现时逐条调用，不只调最新一条【推】。

### 2.7 暂停、被遮挡【推】

- WPE 暂停淡出完成后不再调帧函数（rea-p10 第 12 条引 rea-framework Q6），`FUN_140171440` 不跑，监听回调照常在主线程往 `M` 的队列里推，队列无上限。
- 恢复后第一帧把积压的全部事件按先后派发：每次刷新一条状态 / 播放 / 属性 / 时间轴合成事件、一条封面事件，都会逐条触发回调，封面每条都会换一次纹理名。
- 「被遮挡时暂停」走同一条路（帧函数不调用），没单独追。

### 2.8 返回值与参数【确】

- dll `CallCallback`（`0x18164e4d0`）的 14–18 号分支（跳转表 `0x18164f7b4`：14 → `0x18164f56a`、15 → `0x18164f41d`、16 → `0x18164ee18`、17 → `0x18164f12b`、18 → `0x18164f4dc`）都以 `argc = 1` 调用函数，参数是新建的事件对象；接收者取脚本绑定的 `[S+8]`（与其它回调相同）。
- 调用后只有编号 ≤ 1 或 == 6 时才走返回值写回（`0x18164f719`–`0x18164f731`），媒体回调的返回值被丢弃。
- 抛错时按 P3 E 节的规则只禁用这个脚本的这个回调。

---

## 3. 事件对象（dll）【确】

字段名的 V8 字符串在引擎初始化时建好存在 `G+0x230..+0x2b0`（`0x18164852c`–`0x18164891c`）：title +0x230、artist +0x238、albumArtist +0x240、albumTitle +0x248、subTitle +0x250、genres +0x258、contentType +0x260、hasThumbnail +0x268、primaryColor +0x270、secondaryColor +0x278、tertiaryColor +0x280、textColor +0x288、highContrastColor +0x290、state +0x298、position +0x2a0、duration +0x2a8、enabled +0x2b0。

| 回调 | exe 传的结构 | 对象（键的插入顺序） | 类型 |
|---|---|---|---|
| 14 `mediaStatusChanged` | `bool*`（`&M.enabled`） | `{enabled}` | 布尔（`byte ≠ 0` 取 isolate 根 `+0x380`，否则 `+0x388`；按 V8 根表顺序 undefined 4 → `+0x368`、null 6 → `+0x378`、true 7 → `+0x380`、false 8 → `+0x388`，`openUserShortcut` 的缺省返回取 `+0x368` 也与此一致） |
| 15 `mediaPlaybackChanged` | `int*` | `{state}` | `Integer::New`，0 / 1 / 2 |
| 16 `mediaPropertiesChanged` | 7 个 `const char*`：`+0` title、`+8` subTitle、`+0x10` albumTitle、`+0x18` albumArtist、`+0x20` artist、`+0x28` genres、`+0x30` contentType | `{title, artist, albumArtist, albumTitle, subTitle, genres, contentType}` | 每个都 `String::NewFromUtf8`（kNormal，长度 −1）；缺的就是 `""` |
| 17 `mediaThumbnailChanged` | `{u8 has; u32 c[5]}`（`+0` has、`+4..+0x14` 主 / 次 / 第三 / 文字 / 高对比） | `{hasThumbnail, primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor}` | 颜色：`r = c & 0xff`、`g = (c >> 8) & 0xff`、`b = (c >> 16) & 0xff`，各自 `cvt` 成 float 除以 `255.0f`（`0x1819a512c`），再由 `0x181624910` 建对象、`SetPrototype(G+0x178 = _Vec3.prototype)`、设 `x/y/z`（float32 → double） |
| 18 `mediaTimelineChanged` | `float[2]` | `{position, duration}` | `Number::New(double(float))`；`winrtutil` 送来的已是整秒 |

- 对象都是 `Object::New` 新建的普通对象，原型是 `Object.prototype`，不是 d.ts 里五个类的实例，`instanceof` 都是 false。
- `hasThumbnail` 为 false 的情况：`M.thumb` 字节为空，即会话没有缩略图、读流失败没得到字节、会话被清空，或关闭媒体集成清空。此时颜色是事件里带来的值，正常为全 0，即 `Vec3(0, 0, 0)`【推】。init 补发只在有封面时发，`hasThumbnail` 恒为 true。
- `MediaPlaybackEvent`：`baseclasses.js` 第 1364–1368 行顶层 `class MediaPlaybackEvent { static PLAYBACK_STOPPED = 0; static PLAYBACK_PLAYING = 1; static PLAYBACK_PAUSED = 2 }`。经典脚本顶层 `class` 是全局词法绑定，同一 Context 里的模块直接可见（P3 B 节）。三个常量是普通可写的静态字段。`MediaStatusEvent` / `MediaPropertiesEvent` / `MediaThumbnailEvent` / `MediaTimelineEvent` 在 `baseclasses.js` 与 dll 里都没有定义，运行时引用会 `ReferenceError`。

---

## 4. `usershortcut` 与 `engine.openUserShortcut`

### 4.1 属性值的格式（设置界面与 exe 解析两边一致）【确】

- 界面（`ui\dist\scripts\scripts.js` 的 `BrowseAssignUserShortcutModalCtrl`）：
  - 选类型 `file` / `directory` / `web` / `cmd`，填路径；`file` 另有 arguments。
  - 保存时先调宿主 `browseWallpaperObject.getUserShortcutSystemHash` 得 6 位哈希，拼 `type + ":" + hash + ":" + path`，`file` 有参数时再拼 `"|" + arguments`。
  - `web` 不以 `http://`、`https://`、`www.`、`steam://` 开头就补 `https://`。
  - 路径为空就存 `""`；「清除」也存 `""`。
  - 读回时要求 `splitTimes(":", 2)` 得 3 段、类型在四个之内、中段长 6。
  - 界面另有「测试」按钮 `testUserShortcut`。
- 值存在 `config.json` 的 `wproperties`（与其它用户属性一样，P3 I5）。语料 3 张的 `usershortcut` 属性缺省 `value` 全是 `""`。
- exe 解析 `FUN_1401708c0(str, out)`：
  1. 找第一个 `:` 位置 i、第二个 `:` 位置 j，要求 `j − i == 7`；
  2. `out+0` 类型 = `[0, i)`、`out+0x20` 哈希 = `[i+1, j)`、`out+0x40` 路径 = `[j+1, end)`、`out+0x60` 参数 = `""`；
  3. 类型为 `file` 时在路径里找第一个 `|`、为 `cmd` 时找第一个空格，拆出参数；
  4. 返回值 = 类型 ∈ {`file`, `directory`, `web`, `cmd`} 且路径非空。
- 系统哈希（`0x1400c5090` 前半）：`RegGetValueW(HKLM, "SOFTWARE\Microsoft\Cryptography\", "MachineGuid", RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY)` 读进缓冲区，对「缓冲区的 `pcbData` 字节 ‖ `14 27 db 88 1d`」做 SHA-256（SHA-256 初值常量 `0x1400c5137` 起），转小写十六进制（`0x140144930`，字符表 `0x140478310`），取前 6 位与值的中段比较【确：结构与盐】【推：`pcbData` 含 UTF-16 结尾 NUL；界面的 `getUserShortcutSystemHash` 用的是同一算法】。

### 4.2 脚本看到的 `usershortcut`【确】（另注【推】处）

- `_Internal.convertUserProperties`（`baseclasses.js` 1401–1418 行）对 `type === "usershortcut"` 的项取 `{isbound, commandtype, file}`。
- 这三个字段由 exe 在 `FUN_1401731d0` 组装增量时生成（`0x140173b14` 起）：
  - 解析成功：`isbound = true`（`0x140173c62`–`0x140173cac`，没有看到系统哈希比对【推】）；
  - `commandtype` 查静态表（`0x1401744c6` 初始化）：`file → "file"`、`directory → "directory"`、`web → "website"`、`cmd → "command"`；
  - `file`：类型为 `cmd` / `web` 时是整串路径，否则把路径经 `FUN_1400187b0` 规整后取最后一个 `/` 之后的部分（没有 `/` 就整串）（`0x140173d35`–`0x140173e85`）。
  - 解析失败走 `0x140173ee5`，取值没读【未知】。
- `engine.userProperties`（`FUN_14018dc70`）是否同样展开成这三个字段【未知】。

### 4.3 dll 侧门禁（`0x181656b70`，`engine` 模板上的 `openUserShortcut`，登记于 `0x181649936`）【确】

```c
G = isolate->[+0x248];
if ((unsigned)(G->curCallback(+0x62c) - 11) > 2)                       // 只认 11 cursorClick、12 cursorDown、13 cursorUp
    throw Error("Cannot execute user command outside of cursor callbacks.");   // 0x1819a3c28
if (info.Length() < 1) return false;
if (!info[0]->IsString()) return false;                                // 实例类型 < 0x80
r = host(+0x498)->vtbl[+0xf0](Utf8(info[0]));                          // exe 的 0x14018f7d0
if (r == 0) return false; if (r == 1) return true;
if (r == 2) throw Error("Cannot execute more than one user command per cursor click.");  // 0x1819a3c68
return undefined;
```
- `G+0x62c` 在 `CallCallback` 开头设为本次回调编号（`0x18164e654`），结束时恢复成 0x13（`0x18164f750`），所以 `init`、`update`、计时器回调、媒体回调、`cursorEnter/Leave/Move/HitTest` 里调都会抛错。
- 抛出的异常若没被脚本捕获，按 P3 E 节会禁用这个脚本的这个光标回调。

### 4.4 exe 宿主实现（场景宿主接口 vtable `0x14048ea50` 的 `+0xf0` → `0x14018f7d0`）【确】

```c
if (!(host->flags(+0x98) & (1u << 28))) return 2;     // 没有令牌
host->flags &= ~(1u << 28);                           // 先消耗令牌
R = host->[+0x90];
e = R->[+0x1718].find(name);                          // 用户属性全集（Json）
if (!e || !e->has("value") || e["value"].type != stringValue) return 0;
if (!parse(e["value"].asString(), &out)) return 0;    // FUN_1401708c0
return [[R+0x1710]+0x158]->vtbl[+0x108](out.hash, out.path, out.args) ? 1 : 0;   // A 的第 33 槽 = 0x1400c5090
```
- 只看 `value`，**不看 `type`**：任何字符串值符合格式且哈希对上的属性都能启动。
- 名字查的是累计全集，所以用户在面板里的当前值优先，工程缺省值作底（P3 I4）。
- `host+0x98` 与 4.5 的 `SC+0xe0` 是同一个字段的两种看法（`host = SC+0x48`）【推：依据偏移相同、`host+0x90` 与 `SC+0xd8` 都指向 `R`】。

### 4.5 令牌的发放与回收（光标处理 `FUN_140189e10`）【确】

- 新左键状态 `dl = [输入+0xa4] & 1`，旧状态 `SC+0x308`。
- `dl ≠ 旧` 且 `dl = 1`（按下沿）时，`SC+0xe0 |= 1 << 28`（`0x140189f88`）。
- 函数末尾写回 `SC+0x308 = dl`；`dl = 0` 且与旧值不同（松开沿）时 `SC+0xe0 &= ~(1 << 28)`（`0x14018a45e`）。
- `cursorMove`（10）、`cursorEnter`（8）、`cursorClick`（11）、`cursorUp`（13）、`cursorLeave`（9）都在本函数里、末尾清除之前派发（`0x14018a3b0`、`0x14018a5c5`、`0x14018a833`、`0x14018a944`、`0x14018aa72`）【推：分支块经跳转回到主流程，没逐条走】。所以按下那一帧的 `cursorDown`，以及松开那一帧的 `cursorUp` / `cursorClick`，共用同一个令牌。`cursorDown` 的派发点不在这个函数里，没追【未知】。

### 4.6 启动（`A` 的第 33 槽 `0x1400c5090`）【确】

1. 算系统哈希（4.1），与值的 6 位中段长度、内容都相同才继续；否则写日志 `"User shortcut blocked.\n"`（`0x140486548`，经 `0x140098930`）并返回 false。
2. 路径、参数 UTF-8 → UTF-16。
3. `ShellExecuteW(NULL, NULL, path, args 或 L"", NULL, SW_SHOWNORMAL)`（`0x1400c5633`），返回值 > 32 为成功。
4. 不区分类型：`.lnk` 由 Shell 解析，`.url` 由关联的程序打开，目录用资源管理器打开，`web` 交给 URL 关联（含 `steam://`），`cmd` 拆成程序 + 参数后同样 `ShellExecuteW`。
5. 不换线程：在 dll 回调的调用线程上同步执行，即场景脚本所在的渲染线程（P3 B 节），`ShellExecuteW` 返回前光标回调不会返回。没有 COM 初始化的处理【推：没在本函数里看到 `CoInitialize`】。

---

## 顺手记下的纹理侧地址（没细读，供另一个代理）

- 封面：
  - `winrtutil` 读流、解码、`spotify` 特判（`0x140047de1`）、算配色（`0x140065590`；文字色从次 / 第三 / 高对比里选，`0x140048280`）、重新编码 PNG（`0x140066b90`），都在协程 `0x140046c20`；
  - exe 收封面消息在 `0x1400cc8f7`（中间调 `0x14009c500`）；
  - 场景登记时要求像素（`wantPixels = 1`），`FlushMedia` / `AddMediaListener` 用 `0x1400c0710` 把 PNG 解成 RGBA；
  - 换封面后 `FUN_140150d60(ctx+0x1630)`；纹理名 `mediaThumbnail_<N>.system`（`0x14048de30` + 计数 + `0x14048ddf0`）。
- 快捷方式图标：
  - 绑定种类 2 → `A` 第 36 槽 `0x1400c66d0`（`AddShellThumbnailListener`，同样会拉起 `winrtutil`）；
  - `winrtutil` 入站消息 8、9（`0x140045d19` 起，`0x14002f990` / `0x14002fb10`，读 `.url` 的 `InternetShortcut` 段），应答码 10；
  - exe 在 `0x1400cbaf8` 收码 10（缓存上限 `0xf424000` = 256 MB），场景侧在 `P+0x148` 队列（`FUN_140171440` 的 `0x140171f67` 起）处理。

## 留给实测的问题

媒体实测用可控的 SMTC 会话（夹具）+ 测试工程：脚本导出五个回调，外加 `init`、`applyUserProperties`、`update`、`cursorClick`，每次把 `(帧号, 回调名, JSON.stringify(事件), engine.userProperties["$mediaThumbnail"])` 打进 `[kbp]` 日志。`console.log` 在壁纸模式不写 `log.txt`，用 `console.error`（P3 I4）。

1. **刷新节流**：夹具每 100 ms 改一次时间轴（并每次跨整秒），看 `mediaTimelineChanged` 的间隔是否 ≈ `windowupdaterate`（本机 1000 ms）、`position` 是否恒为整数。再改 `windowupdaterate` 为 50 / 5000（`restart_wpe` 改设置）复测，确认钳制与「主线程定时器节流」。同一个间隔内连续改两次标题，看是否只收到最后一次。
2. **一次刷新内的顺序**：夹具同时换标题、换封面、切到播放，看日志顺序是否为「状态（仅首次）→ 播放 → 属性 → 时间轴 → `applyUserProperties({})` → 封面」，且封面在后一条事件里（同帧或下一帧）；`$mediaThumbnail` 名字是否 `mediaThumbnail_<N>.system`、N 逐次加 1、相同图片也换名。
3. **加载时的补发**：三种情形各开一次测试窗口，看 `init` 之后、第一次 `update` 之前收到什么：
   - (a) 没有别的场景 / 网页壁纸在用媒体（子进程会被新拉起）；
   - (b) 已有另一个用媒体的壁纸在跑（例如桌面壁纸就是媒体场景）；
   - (c) 关掉媒体集成。

   读码预测：(a) init 补发 `{enabled: true}`，数据约一个刷新周期后到；(b) init 补发 `{enabled: true}`，第一帧再来一次 `true` 加全部缓存数据；(c) 先 `true` 后 `false`。
4. **运行中切换「媒体集成」**：场景在跑时关掉再打开，看是否收到 `{enabled: false}`、全空属性、`hasThumbnail: false`。读码推测：没有快捷方式图标监听者时，关掉那一刻什么都不发，重新打开后才一起补到。
5. **暂停积压**：播放中暂停壁纸（或让全屏应用遮挡），期间夹具换几次歌，恢复后看第一帧是否一次性收到全部积压事件（多次 `mediaPropertiesChanged` / `mediaThumbnailChanged`），而不是只收到最后一次。
6. **字段取值**：
   - `contentType` 在音乐 / 视频 / 图片 / 未设置时是否为 `"music"` / `"video"` / `"image"` / `""`；
   - `genres` 多值时是否 `a,b` 无空格；
   - `title` 1025 字节时是否变空串；
   - `PlaybackStatus` 为 Changing / Stopped / Closed 时 `state` 是否都是 0；
   - 夹具不给封面时 `hasThumbnail` 为 false、颜色是否 `(0,0,0)`；
   - 事件对象 `instanceof` / `Object.getPrototypeOf`；`typeof MediaPropertiesEvent`。
7. **黑名单**：把夹具的 AUMID 写进 `mediablocklist`（`[{"appid": …}]`），同时开另一个会话，看 WPE 是否退到 `GetSessions()` 里第一个不在黑名单的会话；只有夹具时是否收到全空事件。
8. **`openUserShortcut`**（只读码，实际点击需用户同意，目标选「打开一个文件夹」）：
   - (a) 在 `cursorClick` 里连调两次，第二次是否抛 `Cannot execute more than one…`；
   - (b) 在 `update` 里调是否抛 `Cannot execute user command outside…`、该回调是否随后被禁用；
   - (c) `cursorDown` 里调了之后 `cursorClick` 再调是否抛；
   - (d) 名字不存在、值为 `""` 时是否返回 false 且仍消耗令牌；
   - (e) 把一个 `textinput` 属性的值设成合法的 `directory:<本机哈希>:C:\…`，看是否也能启动（读码：能）；
   - (f) 中段哈希改一位，看是否返回 false 并在 `log.txt` 出现 `User shortcut blocked.`；
   - (g) `applyUserProperties` 里 `usershortcut` 项的 `{isbound, commandtype, file}`，未绑定时取什么。
