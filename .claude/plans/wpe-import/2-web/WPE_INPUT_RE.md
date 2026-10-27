# WPE 网页壁纸输入转发逆向（函数级）

> 目标：Wallpaper Engine 2.8.42（`version.json` `2.8.42`）。
> - `bin/webwallpaper64.exe`（SHA-256 `51173dab085628159b1af7d9b745c15768497d738c7bab7b72d667a35b4f6d9d`，CEF 构建路径 `D:\dev\welibs\cef_7680\...`）
> - `wallpaper64.exe`（SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`）
>
> 方法：只做静态分析，没有运行任何 WPE 程序，没有写 WPE 目录。`webwallpaper64.exe` 用 REA（Ghidra 12.1.4）反编译，并用 `objdump -d` 对照汇编；`wallpaper64.exe` 只用 `objdump -d` 加自写的 PE 导入表 / 字符串定位脚本（没有放进 REA 做完整反编译）。镜像基址都是 `0x140000000`。IAT 地址由解析导入表得到，例如 `0x140104498` = `USER32!WindowFromPoint`。REA 快照：`C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\e28fbcb9-4d4d-47e9-a5ac-d3fa167b4760\scratchpad\webwallpaper64.rea-snapshot`。
>
> 标注：**[确认]** 表示有反编译或汇编直接证据；**[推断]** 表示由证据推理得出，或依赖 Windows / Chromium 的行为。

## 总体机制

WPE 的网页壁纸输入**全部在 `webwallpaper64.exe` 里完成**，`wallpaper64.exe` 不参与转发。`wallpaper64` 只负责三件事：找到 WorkerW，并给它挂 `WallpaperEngineParent=1` 属性；为每个显示器建一个承载窗口 `WPEDesktopCEFWindow`（`WS_CHILD`，`WS_EX_NOACTIVATE|WS_EX_LAYERED|WS_EX_NOREDIRECTIONBITMAP`，可能再加 `WS_EX_TRANSPARENT`），挂到 WorkerW 下；用 `-parenthwnd <该窗口句柄>` 启动 `webwallpaper64`，再通过命名管道下发加载 URL、尺寸、暂停、属性等命令。管道协议里**没有任何鼠标或键盘消息**。

`webwallpaper64` 用**窗口化**（不是 OSR）的 CEF 浏览器，以 `SetAsChild` 的方式挂到 `-parenthwnd` 下。进程主线程跑一个约 200 Hz 的自建循环，在同一个线程里依次做三件事：`PeekMessage`、`cef_do_message_loop_work`、输入轮询。输入轮询的步骤如下：

- 用 `GetKeyState(VK_LBUTTON)` 读左键，用 `GetCursorPos` 读光标。
- 用 `ScreenToClient(浏览器 HWND)` 把光标换算成客户区坐标。
- 光标坐标一变，就无条件 `SendMouseMoveEvent`，不做命中判定，也不检查显示器。
- 左键状态变化时，用 `WindowFromPoint` 加类名 / 属性判定光标下是不是桌面。按下只在命中桌面时转发；**抬起无论落在哪里都转发**。
- `SendMouseClickEvent` 的参数固定为 `MBT_LEFT`、`clickCount=1`、`modifiers=0`。

不转发滚轮、右键和中键。键盘用 `WH_KEYBOARD_LL` 收集，只在本地文件壁纸上安装，还有两个前提：上一次鼠标按键落在桌面上，且桌面图标已隐藏（`FWF_NOICONS`）。

**WPE 不吞桌面框选，关键是它把输入队列从 Explorer 上拆开了，而不是改用 OSR，也不是只转发移动。** WPE 在两层窗口上都显式调用 `AttachThreadInput(child_thread, parent_thread, FALSE)`：

1. `wallpaper64` 用 `CreateWindowExW` 建好 `WPEDesktopCEFWindow`（父窗口是 WorkerW，属于 Explorer 线程）后，立即 `AttachThreadInput(本窗口线程, WorkerW 线程, FALSE)`。`wallpaper64` 里一共 8 处 `AttachThreadInput`，第三个参数全是 `FALSE`，覆盖视频、应用、CEF 等各类壁纸窗口。
2. `webwallpaper64` 在浏览器创建回调里（`FUN_14000d9a0`，`OnAfterCreated` 一类）立即 `AttachThreadInput(浏览器 HWND 线程, -parenthwnd 线程, FALSE)`。

Windows 在跨线程父子窗口关系建立时，会**隐式**把两个线程的输入队列合并。这种合并可以传递：Explorer ← `wallpaper64` ← `webwallpaper64`。WPE 把两段都拆开以后，Chromium 在 `RenderWidgetHostViewAura::OnMouseEvent` 按下路径上做的 `SetCapture`，只作用于 `webwallpaper64` 自己的队列，不会把 Explorer 的 `SysListView32` 的捕获抢走，框选也就不会被打断 [推断：依据 Windows 输入队列语义，WPE 实装在用]。

Chromium 这一侧的路径和 Kabegame 完全相同：都是窗口化 CEF，`CefBrowserPlatformDelegateNativeAura::SendMouseClickEvent` 调 `view->OnMouseEvent`（见 `third/cef/libcef/browser/native/browser_platform_delegate_native_aura.cc:72`）。所以差别不在 CEF 用法，而在**窗口所在线程的输入队列拓扑**。

Kabegame 现在把 CEF Views 窗口直接 `SetParent` 到 WorkerW（`tauri-plugin-wemt/src/platform/windows.rs:345`），之后没有拆队列。结果是 Kabegame 的 CEF UI 线程（也就是主线程）和 Explorer 桌面线程共用一个输入队列：注入按下时 aura 的 `SetCapture` 会让 Explorer 收到 `WM_CAPTURECHANGED`，框选随即结束。之后再 `ReleaseCapture` 也晚了。

## 逐问题证据

### 1. 进程分工与 IPC

- [确认] 轮询、钩子、注入都在 `webwallpaper64.exe` 里：
  - `GetCursorPos`（xref `0x14002322b`）、`WindowFromPoint`（`0x1400233bf`）、`GetKeyState`（`0x140023206`、`0x140022e6c`）都在主函数 `FUN_140021a40` 的主循环里。
  - `SetWindowsHookExW` 在 `0x14002008d`（命令处理函数 `FUN_14001fda0`）。
- [确认] `wallpaper64` 用以下格式拼出 `webwallpaper64` 的命令行（`0x14011a3dd` 起）：

  ```
  -parenthwnd %llu  （值是 [obj+0x430]，即刚建好的 WPEDesktopCEFWindow 句柄）
  -mainwelaunch
  -screensaver
  -cacheId ...
  ```

  字符串依次为 `0x140489938 "-parenthwnd"`、`0x140489930 "%llu"`、`0x140489910 " -mainwelaunch"`、`0x140489920 " -screensaver"`、`0x140489980 " -cacheId "`，同一处还有 `"WPEWebIpcHandler"`（`0x1404898f8`）和 `"monitor"`。`webwallpaper64` 能解析的参数：`-halfresolution`、`-cefcommandline`、`-screensaver`、`-hideCursor`、`-loglevel`、`-mainwelaunch`、`-parenthwnd`（主函数 737–944 行）。
- [确认] IPC 用命名管道：
  - `webwallpaper64` 的 `FUN_14003c060` 拼出 `L"\\\\.\\pipe\\" + name`，可选再接 `L"Client"`，因此是一对单向管道。`wallpaper64` 在 `0x1400837ff` 和 `0x140083844` 调 `CreateNamedPipeW`（服务端）。
  - 读线程把消息放进队列。主循环空闲时调 `FUN_14003c970(0x140135480)` 取出，交给 `FUN_14001fda0` 分发。分发参数是 `{uint32 cmd; uint32 len; void* data}`，用 `param_1[0]`、`param_1[1]`、`*(param_1+2)` 访问。
- [确认] 已识别的命令（`FUN_14001fda0` 的 switch）：

  | 命令 | 作用 |
  |---|---|
  | 1 | 加载 URL，按 URL 前缀决定是否装键盘钩子，见第 6 节 |
  | 2 | 16 字节 RECT，即尺寸 / 位置 |
  | 3 | 断开 / 退出（`DAT_140133fc4=0`） |
  | 4 | 暂停 / 恢复（写 `app+0xd8`，同时执行 `wallpaperPropertyListener.setPaused` 等 JS） |
  | 5 | 布尔开关（`FUN_140018420`，具体含义未查） |
  | 6 | 用户属性 JSON（`properties`） |
  | 7、10、0xc、0x11–0x13、0x15、0x18 | 属性、语言、音频、截图、媒体时间轴等 |

  **没有鼠标或键盘命令。**
- [推断] 管道名大概以 `WPEWebIpcHandler` 为基础，再接显示器或缓存 ID。完整拼法没有追到底。

### 2. 输入采集

- [确认] 鼠标采集只有两个调用：`GetKeyState(1 /*VK_LBUTTON*/)` 和 `GetCursorPos`（主函数 1218、1223 行）。
  - `webwallpaper64` 的导入表里**没有** `GetAsyncKeyState`、`RegisterRawInputDevices`、`GetRawInputData`，也没有 `WH_MOUSE_LL`。全文件只有一处 `SetWindowsHookExW`，参数 `idHook=0xd`，即 `WH_KEYBOARD_LL`。
  - 左键状态的算法是 `up = (~(GetKeyState(VK_LBUTTON) >> 8)) & 1`（`0x140023218`–`0x140023223`：`shr 8; not; and 1`）。
- [确认] 线程与频率：全部在进程主线程上，也就是 CEF UI 线程。CEF 跑外部泵：`FUN_14001f810` 内部会调 `cef_do_message_loop_work`。
  - 每次循环先 `PeekMessageW(PM_REMOVE)`。有消息就 `Translate/Dispatch`；没有消息才往下执行：取 IPC、取键盘队列、做鼠标轮询、做 CEF 泵。
  - 节流方式（1423–1437 行）：`QueryPerformanceCounter` 忙等加 `Sleep(1)`，周期是 `freq/200`，即 **5 ms，约 200 Hz**。
  - 导入表里没有 `timeBeginPeriod`，所以实际周期还取决于系统计时器精度。
- [确认] 暂停时（`app+0xd8 != 0`，命令 4）跳过整段鼠标轮询，只调 `cef_do_message_loop_work`，同时清掉 `DAT_140137d9c`（下面称 desktopFocused）（1418–1421 行）。

### 3. 命中判定

[确认] 命中判定**只在左键状态变化时**执行（`0x1400233a9`：上一帧 up 与本帧 up 不同才进入）。汇编 `0x1400233bf`–`0x140023468` 还原如下（`_wcsicmp` 为 `FUN_1400ec430`，不区分大小写）：

```c
HWND h = WindowFromPoint(screenPt);
GetClassNameW(h, cls, 32);
HANDLE prop = GetPropW(h, L"WallpaperEngineParent");
bool desk;
if (_wcsicmp(cls, L"SysListView32") == 0) {
    GetClassNameW(GetParent(h), cls, 32);
    desk = _wcsicmp(cls, L"SHELLDLL_DefView") == 0;
} else {
    desk = prop == (HANDLE)1
        || _wcsicmp(cls, L"SHELLDLL_DefView") == 0
        || _wcsicmp(cls, L"Progman") == 0;
}
bool isRelease = (prevUp == 0);           // 上一帧按着、这一帧松开
bool sendClick = isRelease || desk;      // r12b
```

- 类名全集只有 `SysListView32`、`SHELLDLL_DefView`、`Progman`，外加属性 `WallpaperEngineParent`。**判定里没有 `WorkerW`、`Shell_TrayWnd`、`FolderView`。** WorkerW 能被识别，靠的是 `wallpaper64` 给它挂的属性。
- [确认] **不区分图标和空白处**：两个二进制里都没有 `LVM_HITTEST` 或其它 `LVM_*` 消息。`webwallpaper64` 全文件只有一处 `SendMessageW`，在 IPC 投递里；`wallpaper64` 的 `SendMessage*` 消息号都在 `0x4a`、`0x111`、`0x112`、`0x40x`–`0x46x`、`0x52c` 这些范围内。点在图标上同样会转发按下。
- [确认] **不检测 Explorer 是否正在框选或拖拽**，也不看前台窗口、全屏、遮挡。抑制只来自两处：按下时 `WindowFromPoint` 命中的不是桌面，或者壁纸处于暂停状态。移动事件完全没有抑制（第 4 节）。
- [确认] 属性来源：`wallpaper64` 的 WorkerW 查找流程（`0x14003c8b8` 起）依次执行：
  1. `FindWindowW("Progman")`；
  2. `SendMessageTimeoutW(0x52c, ...)`；
  3. 用 `EnumChildWindows(GetDesktopWindow(), 0x14003c760)` 找到 WorkerW。新版布局（版本序号 ≥ `0xb`）改为 `FindWindowExW(Progman, NULL, "WorkerW")`，并取 `SHELLDLL_DefView`、`SysListView32`；
  4. `SetWindowLongW(WorkerW, GWL_EXSTYLE, 0x080000A0)`，即 `NOACTIVATE|TOOLWINDOW|TRANSPARENT`；
  5. `SetPropW(WorkerW, "WallpaperEngineParent", 1)`（`0x14003cacb`）。

  `wallpaper64` 自己给 Scene 用的鼠标命中逻辑（`0x14010d9df` 附近）和上面这段一模一样。
- [确认] 按键焦点状态 `DAT_140137d9c`（desktopFocused）：每次按键变化都按 `desk` 结果更新。命中时置 1，并把 `app+0x180` 开始的 256 字节键盘状态清零；不命中时置 0。抬起也会更新它。

### 4. 注入方式

- [确认] **窗口化，不是 OSR。** `FUN_14000bd80` 在 `0x14000d589`–`0x14000d7c4` 构造 `cef_window_info_t`（大小 `0x70`，字段偏移按 `third/cef/include/internal/cef_types_win.h`），然后调 `cef_browser_host_create_browser`（IAT `0x140104658`，经 `0x1400ff998` → `FUN_140085a70`）：

  | 字段 | 值 |
  |---|---|
  | `ex_style` | `0x08200000` = `WS_EX_NOACTIVATE \| WS_EX_NOREDIRECTIONBITMAP` |
  | `style` | `0x56010000` = `WS_CHILD\|WS_VISIBLE\|WS_CLIPSIBLINGS\|WS_CLIPCHILDREN\|WS_TABSTOP`，即 `SetAsChild` 的标准样式 |
  | `bounds` | IPC 命令 2 下发的 RECT（`DAT_140138f38..44`） |
  | `parent_window` | `-parenthwnd`（`DAT_140138f30`） |
  | `windowless_rendering_enabled` | 0 |
  | `shared_texture_enabled` | 0 |
  | `external_begin_frame_enabled` | 0 |
  | `runtime_style` | 0（DEFAULT） |

  没有 `CefRenderHandler` 的使用迹象（OSR 关闭）。
- [确认] vtable 槽位：用 CEF C++ `CefBrowserHost` 的虚函数顺序核对（虚基 `CefBaseRefCounted` 走 vbtable，自有虚表从 `GetBrowser`=0 开始）。

  | 偏移 | 方法 | 调用点 |
  |---|---|---|
  | `+0x28` | `GetWindowHandle` | 多处 |
  | `+0x130` | `SendKeyEvent` | `0x14002310c`、`0x14002318e` |
  | `+0x138` | `SendMouseClickEvent` | `0x14002355c` |
  | `+0x140` | `SendMouseMoveEvent` | `0x1400236a8` |

  没有找到 `SendMouseWheelEvent`（`+0x148`）作用在 host 上的调用。那三处 `+0x148` 调用都返回 int 并参与循环比较，属于其它类。`SetFocus`（`+0x20`）、`SendFocusEvent` 用启发式没有扫到 [推断：未穷举]。
- [确认] 点击参数（`0x140023509`–`0x14002355c`）：

  ```
  SendMouseClickEvent(&{x, y, modifiers=0}, MBT_LEFT=0, mouseUp=up, clickCount=1)
  ```

  `x`、`y` 是 `ScreenToClient(浏览器 HWND)` 后的客户区像素；带 `-halfresolution` 时再各除以 2。**`modifiers` 永远是 0，不带 `EVENTFLAG_LEFT_MOUSE_BUTTON`。**
- [确认] 移动参数（`0x14002365f`–`0x1400236a8`）：

  ```
  SendMouseMoveEvent(&{x, y, modifiers=0}, mouseLeave=false)
  ```

  只要客户区坐标和上次不同就发送，不做 `WindowFromPoint` 判定，拖动时也不带左键标志，**从不发 `mouseLeave`**。带 `-hideCursor`（屏保）时，会先 `PostMessageW(GetParent(浏览器), WM_MOUSEMOVE, 0, 0)` 通知 `wallpaper64`。
- [确认] DPI：两个 exe 的清单都是 `<dpiAware>true/PM</dpiAware>`，并且 `webwallpaper64` 给 CEF 加了 `force-device-scale-factor=1`、`high-dpi-support=1`（`0x14000e6cf`–`0x14000e84e`；带 `-halfresolution` 时 `force-device-scale-factor=2`）。所以 DIP 等于物理像素，坐标不需要再除以 DPI。
- [确认] `ScreenToClient` 用的 HWND 是 `host->GetWindowHandle()`，在 `local_3e8` 里缓存。旁边调了一次 `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)`，但结果没用到。

### 5. 窗口与捕获

- [确认] `webwallpaper64` 浏览器创建回调 `FUN_14000d9a0` 的调用顺序：

  ```c
  SetPropW(browserHwnd, L"WallpaperEngineWallpaper", (HANDLE)1);
  SetLayeredWindowAttributes(browserHwnd, 0, 0xff, LWA_ALPHA);
  SetWindowPos(browserHwnd, 0, rect..., 0x21c);   // NOZORDER|NOREDRAW|NOACTIVATE|NOOWNERZORDER
  SetWindowPos(GetWindow(browserHwnd, GW_CHILD), 0, 0, 0, w, h, 0x21c);
  AttachThreadInput(GetWindowThreadProcessId(browserHwnd),
                    GetWindowThreadProcessId(parentHwnd /* -parenthwnd */),
                    FALSE);                       // ← 拆开输入队列
  if (-hideCursor) ShowCursor(FALSE);
  ```

- [确认] `wallpaper64` 创建承载窗口（`0x140118cd9`–`0x140118f3f`）：
  1. `RegisterClassExW`：类名 `WPEDesktopCEFWindow`，`lpfnWndProc = DefWindowProcW`；
  2. `CreateWindowExW(ex = 0x08280000 或 0x08280020, "WPEDesktopCEFWindow", "WPELiveWallpaper", WS_CHILD, rect, parent=[obj+0x60], ...)`。`ex` 是 `NOACTIVATE|LAYERED|NOREDIRECTIONBITMAP`，`[obj+0xa6]` 第 `0x10` 位为 1 时再加 `TRANSPARENT`；
  3. `AttachThreadInput(本窗口线程, 父窗口线程, FALSE)`；
  4. `ShowWindow(SW_SHOWNOACTIVATE)`。

  视频壁纸窗口（`0x14005894c`）也是同样做法，额外调了 `EnableWindow(hwnd, FALSE)`。CEF 承载窗口**没有** `EnableWindow(FALSE)`。
- [确认] 两个进程都**没有**直接调 `SetCapture` 或 `ReleaseCapture`（两份导入表里都没有），也没有 `WM_NCHITTEST`/`HTTRANSPARENT` 的处理：`WPEDesktopCEFWindow` 直接用 `DefWindowProcW`。
- **为什么不吞框选**：
  - [确认] WPE 不靠 OSR（浏览器是窗口化的），也不靠只转发移动（按下也照常转发）。
  - [推断，高置信] 机制是逐层 `AttachThreadInput(..., FALSE)` 拆掉隐式的输入队列合并，让 Chromium 的 `SetCapture`、焦点变化、按键状态都留在 WPE 自己的队列里。真实的鼠标消息按命中窗口路由给 Explorer 的 `SysListView32`，按下时的 mouse owner 也在 Explorer 的队列里，WPE 的后台捕获抢不到。
  - [推断] 辅助因素：承载窗口是 `LAYERED`（加 `TRANSPARENT` 时完全点击穿透）+ `NOACTIVATE`，浏览器窗口是 `NOACTIVATE`，避免激活和点击落到壁纸窗口上。

### 6. 键盘

- [确认] 安装条件：命令 1（加载 URL）时，如果 URL 以 `http://`、`https://`、`www.`、`edge://` 开头，就 `UnhookWindowsHookEx`；否则（本地 `file` 壁纸）`SetWindowsHookExW(WH_KEYBOARD_LL, FUN_14000a720, GetModuleHandleW(NULL), 0)`（`0x140020039`–`0x14002008d`）。退出时卸载（主函数 619 行）。
- [确认] 钩子过程 `FUN_14000a720`：
  - 不检查 `nCode`，**从不拦截**，最后总是 `CallNextHookEx`。
  - 在互斥锁 `0x140135380` 保护下，把 `{wParam(消息), vkCode, scanCode}` 压进双端队列，并通知条件变量 `0x1401353f8`。
- [确认] 主循环消费键盘队列（1030–1209 行），要求同时满足：
  - desktopFocused 为真，即上一次左键变化发生在桌面上；
  - `app+0x178` 为真：页面已加载，在 `FUN_1400120a0` 的加载状态回调里置位；
  - 每个按键都要 `CoCreateInstance(CLSID_ShellWindows)` → `IShellWindows::FindWindowSW(CSIDL_DESKTOP, SWC_DESKTOP, SWFO_NEEDDISPATCH)` → `IServiceProvider::QueryService(SID_STopLevelBrowser, IID_IShellBrowser)` → `QueryActiveShellView` → `IFolderView2::GetCurrentFolderFlags`，并且结果含 `FWF_NOICONS (0x1000)`，即**桌面图标已隐藏**。COM 链失败时照样转发。

  这和 UI 文案 `ui_browse_open_url_hotkey_info`（"To use your keyboard on the wallpaper, hide the icons with this hotkey first"）对得上。
- [确认] 构造 `cef_key_event_t`（大小 `0x28`）：
  - 自己维护 256 字节键盘状态：左右 Shift 归一成 `VK_SHIFT`，左右 Ctrl / Alt 归一成 `VK_CONTROL` / `VK_MENU`；CapsLock 用 `GetKeyState(VK_CAPITAL)`。
  - `modifiers`：SHIFT=2、CTRL=4、ALT=8。
  - `type`：`WM_KEYDOWN` / `WM_SYSKEYDOWN` → `KEYEVENT_KEYDOWN(1)`；`WM_KEYUP` / `WM_SYSKEYUP` → `KEYEVENT_KEYUP(2)`；SYS 版本再置 `is_system_key=1`。
  - `windows_key_code = vk`，`native_key_code = scanCode`（只是扫描码，不是 lParam 格式）。`character` / `unmodified_character` 取 `ToAscii` 的结果。
  - 按下且 `ToAscii` 有字符时，再补一次 `KEYEVENT_CHAR(3)`。

### 7. 设置开关

- [确认] `webwallpaper64` 里没有任何鼠标设置字符串（例如 `mouseinput`、`bubble`）。
- [确认] UI 和本地化里也只找到 `ui_browse_properties_mouse_parallax`、`cameraparallaxmouseinfluence` 这类 Scene 相关项，没有「网页壁纸鼠标输入」开关。
- [确认] 实际起作用的门控只有：暂停（命令 4）、页面加载标志（`+0x178`）、`-hideCursor` / `-screensaver`（屏保模式）、`-halfresolution`（坐标除以 2）。键盘另外受 URL 类型和桌面图标是否隐藏的约束。

### 8. 多显示器与坐标

- [确认] 每个显示器一个 `webwallpaper64` 进程（`-parenthwnd` 是各自显示器的 `WPEDesktopCEFWindow`，命令行里有 `monitor` 字段）。每个进程都**独立轮询全局光标**。
- [确认] 坐标只靠本进程浏览器 HWND 的 `ScreenToClient` 换算，不过滤显示器：光标在别的屏时，移动事件照样发出，坐标会是负数或越界。按下的 `WindowFromPoint` 命中桌面（`SysListView32` 跨越全部显示器）时，每个进程都会收到一次点击，坐标同样可能越界。
- [确认] DPI：清单声明 PMv1，加上 `force-device-scale-factor=1`，所以全程使用物理像素。

## Kabegame 精确复刻建议

1. **（核心，解决吞框选）挂载后拆开输入队列。** 在 `tauri-plugin-wemt` 的 `mount` 里，`SetParent(window, host)` 成功后立刻执行：

   ```rust
   let child_tid = GetWindowThreadProcessId(window, null_mut());
   let host_tid  = GetWindowThreadProcessId(host, null_mut());   // Explorer 桌面线程
   if child_tid != host_tid { AttachThreadInput(child_tid, host_tid, FALSE); }
   ```

   - 每次重新挂载（包括 Explorer 重启后重挂、换 WorkerW）都要再做一次。
   - `restore` 前后也可以再调一次 `FALSE`（无副作用）。
   - CEF Views 窗口内部的 `Chrome_*` 子 HWND 都在同一个线程上，拆一次就覆盖全部。

   这样拆开之后，Kabegame 主线程不再和 Explorer 共用队列，aura 的 `SetCapture` / `Focus` 不会影响桌面框选和图标焦点。还有一个附带好处：Explorer 卡顿时不会拖住 Kabegame 主窗口，反过来也一样。
   - 拆开以后，`inject_mouse` 里按下后立刻 `release_own_mouse_capture()` 可以保留，作为防御，但不再是关键。
   - 真机验证：注入按下期间，Explorer 框选不会中断，`GetCapture()` 在 Explorer 线程上下文中仍然指向 `SysListView32`。

2. **不需要改成 OSR。** WPE 本身就是窗口化 + `SendMouse*Event` → NativeAura → `RenderWidgetHostViewAura::OnMouseEvent`，和 Kabegame 是同一条 Chromium 路径。
3. **样式**：给壁纸窗口（`WorkerW` 的直接子窗口）补上 `WS_EX_NOACTIVATE`（wemt 已经加了），视情况再加 `WS_EX_LAYERED | WS_EX_TRANSPARENT`，让真实点击穿透、不被它截走（WPE 的承载窗口就是这么做的）。另外，WPE 的 WorkerW 被设成了 `NOACTIVATE|TOOLWINDOW|TRANSPARENT`，Kabegame 不需要去改 Explorer 的窗口。
4. **命中判定**可以向 WPE 对齐，或者保留现在的「根窗口 `Progman` / `WorkerW`」规则。现有规则在 24H2 新布局（DefView 在 Progman 下）和旧布局（DefView 在顶层 WorkerW 下）下都成立，并且已经覆盖 WPE 的类名集合。
   - 按下：只有命中桌面才转发，WPE 和 Kabegame 一致。
   - 抬起：WPE 总是转发，即使按下没有转发，页面会收到孤立的 mouseup。Kabegame 现在只在按下被转发过时才发抬起，更干净，**不必照搬**。
   - 不需要区分图标和空白处（WPE 也不区分），也不需要检测框选是否在进行：队列拆开后，框选和页面点击可以同时存在。
5. **移动**：WPE 不做命中判定、不发 leave、`modifiers=0`。Kabegame 现在在客户区内才发移动、离开时发 `Leave`、拖动时带 `EVENTFLAG_LEFT_MOUSE_BUTTON`，语义更完整，可以保留。如果要和 WPE 逐像素一致，可以去掉 leave 和按键标志，但没有必要。
6. **坐标 / DPI**：WPE 强制 `force-device-scale-factor=1`，所以直接传物理像素。Kabegame 用真实 DSF，并把物理像素除以 `GetDpiForWindow/96`，这在 NativeAura（location 按 DIP 处理）下是对的，保持即可。
7. **频率**：WPE 约 200 Hz（5 ms），Kabegame 是 16 ms。点击边沿检测在 16 ms 下可能漏掉极短的点击（<16 ms 按下又抬起）。可以把左键边沿改成低级鼠标钩子，或者把周期降到 5–8 ms。
8. **键盘（可选）**：复刻的话，在主线程装 `WH_KEYBOARD_LL`（只观察、不拦截），只对本地网页壁纸生效。转发条件：desktopFocused 为真，且桌面 `FWF_NOICONS`（`IFolderView2::GetCurrentFolderFlags`）成立。用 `ToAscii` 生成 `KEYDOWN` / `KEYUP` + `CHAR`。

## 仍未解决的未知项

- `AttachThreadInput(..., FALSE)` 能不能完全撤销 `SetParent` 或建窗时产生的**隐式**队列合并，以及之后 Windows 会不会在某些时机（例如再次 `SetParent`、`SetWindowPos`）重新合并：静态分析无法证明。WPE 在两层都这么做，而且只在创建后做一次，说明实际有效 [推断]。需要在 Kabegame 真机上验证。
- 后台线程（队列已拆开、本身收不到鼠标消息）调 `GetKeyState(VK_LBUTTON)` 能不能及时拿到按键状态：WPE 依赖这一点。Kabegame 用 `GetAsyncKeyState` 更稳，建议保留。
- `wallpaper64` 中 `[obj+0xa6] & 0x10`（决定承载窗口是否加 `WS_EX_TRANSPARENT`）的含义。
- 管道名的完整拼法（`WPEWebIpcHandler` + ?），以及命令 5、7、10、0xc、0x11–0x18 的精确语义。
- `SetLayeredWindowAttributes` 作用在没有 `WS_EX_LAYERED` 的 CEF 子窗口上实际是否生效。
- `runtime_style=DEFAULT` 在 CEF 146 下落到 Chrome 还是 Alloy 风格。两种风格的输入都走 NativeAura delegate，不影响结论。
- `wallpaper64.exe` 没有做 Ghidra 级反编译，结论基于汇编直读。

## 关键地址速查（webwallpaper64.exe）

| 地址 | 内容 |
|---|---|
| `FUN_140021a40` | `wWinMain` 主体：参数解析、主循环、鼠标轮询、键盘消费 |
| `0x1400231f0`–`0x1400236a8` | 鼠标轮询，`GetKeyState` → `GetCursorPos` → `ScreenToClient` → 命中判定 → Click / Move |
| `FUN_14001fda0` | IPC 命令分发（含键盘钩子安装 / 卸载） |
| `FUN_14000a720` | `WH_KEYBOARD_LL` 钩子过程 |
| `FUN_14000d9a0` | 浏览器创建回调：`SetProp`、`SetWindowPos`、**`AttachThreadInput(FALSE)`**、`ShowCursor` |
| `FUN_14000bd80` @ `0x14000d589` | `cef_window_info_t` 构造与 `CreateBrowser` |
| `FUN_1400120a0` | 加载状态回调，设置 `app+0x178` 页面就绪标志 |
| `FUN_14003c060` / `FUN_14003c970` | 管道名拼接，以及 IPC 队列消费 |
| `0x14000e6cf`–`0x14000e84e` | `force-device-scale-factor` / `high-dpi-support` 开关 |

wallpaper64.exe：`0x14003c8b8`–`0x14003caf4`（WorkerW 查找与 `WallpaperEngineParent` 属性）；`0x140118cd9`–`0x140118f3f`（`WPEDesktopCEFWindow` 创建 + `AttachThreadInput(FALSE)`）；`0x14011a3dd`（`-parenthwnd` 命令行）；8 处 `AttachThreadInput` 都是 `FALSE`：`0x140058a04`、`0x14005ac7f`、`0x1400ff677`、`0x1401107bf`、`0x140118f2d`、`0x14012540f`、`0x1401283df`、`0x14012937e`。
