# WPE 上次是否正常退出的判定与正常退出路径（静态逆向，2026-11-09）

**结论概括。** WPE 用注册表值 `HKCU\Software\WallpaperEngine\faultyShutdown`（REG_DWORD）判断上次是否正常退出。`wallpaper64.exe` 每次启动先读这个值，读完立刻写成 1；消息循环正常结束后写回 0，Windows 注销 / 关机时（`WM_QUERYENDSESSION`，或 `WM_ENDSESSION` 且 wParam 为 TRUE）也会写 0。强杀会把值留在 1。下次启动读到 1，并且 `config.json` 的 `general.user.safemode` 不是 `false`（默认 `true`，界面叫「防止崩溃」），主进程就自己补上 `-nowallpapers -showbrowse` 两个参数。前者让桌面壁纸不加载，后者打开浏览界面，并让界面弹出「安全启动 / 程序似乎没有正常关闭」对话框。这条路径根本不看 `-silent`，所以加了 `-silent` 也会弹。

托盘「退出」的菜单命令号是 `0x9c4a`（40010），处理函数只做一件事：给事件窗口 `WPEEventWindow` 投递 `WM_QUIT`。WPE 自带的 `apputil32.exe -closewe`（launcher 更新时用）和 WPE 自己的更新路径用的都是这一招，所以从外部 `PostMessageW(FindWindowW(L"WPEEventWindow", NULL), WM_QUIT 或 WM_COMMAND 0x9c4a, …)` 可以触发正常退出。`-control` 里没有退出命令。如果只能强杀，在下次启动前把 `faultyShutdown` 写成 0（或删掉）即可。launcher 的更新流程在关闭 WPE 后也是这样清这个值的。

「强杀后不自动加载壁纸」与崩溃提示是同一个机制。

另外发现一处和用户实测对不上的地方：代码里，已有实例时带 `-silent` 再启动，第二个进程会直接 `return 0`，不弹界面。用户这次运行中的 WPE 命令行（只读查询 `Win32_Process`）是 `wallpaper64.exe  -slient`，拼错了，这很可能就是「已有进程时也弹界面」的原因，详见 Q5。

---

### 头部

- **目标：** `wallpaper64.exe` 2.8.42，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，与安装目录一致。另外读了 `launcher.exe`（SHA-256 `bbb416da…af02`）、`bin/apputil32.exe`，以及 `ui/dist/scripts/scripts.js`、`locale/*.json`。所有 exe 都拷到 `ignore/wpe-mcp/rea/` 后再分析。
- **方法：**
  - REA（Ghidra 12.1.4）从 `ignore/wpe-mcp/rea/wp-exit.rea-snapshot` 打开（拷自 p4 的快照），反编译了 `FUN_14000a220`（主函数）、`FUN_14001eae0`（建窗与消息循环）、`FUN_140021e50`（事件窗口过程）、`FUN_140008270`（`-control`）等函数。
  - 用 `ignore/p4/rea/wp.asm` 对照汇编，launcher / apputil32 用本机 llvm-objdump 现做反汇编。
- **地址：** 基址 `0x140000000`（apputil32 为 32 位，基址 `0x400000`）。函数名是 Ghidra 自动名。
- **证据等级：**
  - 【确】：读到了代码或文件内容。
  - 【推】：由代码推出，没有逐行确认，或者依赖 Win32 的标准行为。
  - 【未知】：没读到。
  - 全部结论都没有实测。
- **运行时只做了只读观察：**
  - `reg query HKCU\Software\WallpaperEngine`：WPE（PID 443348）运行期间 `faultyShutdown = 0x1`，与「启动写 1」一致。
  - `Win32_Process` 只读查询：运行中实例的命令行是 `wallpaper64.exe  -slient`，子进程 `wallpaperui.exe … -window browsewallpapers` 已打开。
  - `config.json`：`general.user.safemode = true`，`anticrash = null`。7 份 `config_backups` 里也都是这两个值。

---

## Q1 判定机制

### 存放位置：注册表，不是文件或 config 键 【确】

- 键：`HKEY_CURRENT_USER\Software\WallpaperEngine\`。
  - 字符串 `L"Software\\WallpaperEngine\\"` 在 `0x140472880`。
- 值：`faultyShutdown`，类型 REG_DWORD。
  - 字符串 `L"faultyShutdown"` 在 `0x140473f28`，UTF-16，所以 ASCII 扫描找不到。
- 只有恰好等于 1 才算「上次没正常退出」（`0x14000c1de: cmp dword [rbp+0x1110], 1`）。值不存在或读失败都按正常处理。
- `wallpaper64.exe` 里引用这个字符串的只有 4 处：主函数 3 处、窗口过程 1 处。
- `config.json` 里没有崩溃标记。`safemode` 只是一个开关，见下文。
- 互斥体 `cxWallpaperEngineGlobalMutex` 只用于单实例判断，与崩溃判定无关。

### 检查与置位（启动时），`FUN_14000a220` 【确】

| 地址 | 内容 |
|---|---|
| `0x14000c15b` | `test [0x1404df540], 0x1000`。整段只在**非屏保模式**下执行（0x1000 由 `-screensaver` 置位：`0x14000a930: or [0x1404df540], 0x1001`） |
| `0x14000c18c` | `RegOpenKeyExW(HKCU, L"Software\\WallpaperEngine\\", 0, KEY_ALL_ACCESS)` |
| `0x14000c1d0` | `RegQueryValueExW(L"faultyShutdown")`，等于 1 时进入下一步 |
| `0x14000c1f1`–`0x14000c277` | 读 `config[用户名].general.user.safemode`。jsoncpp 类型 5 是 bool：值为 bool `false` 就跳过；值为 `true`、缺失或不是 bool 都继续 |
| `0x14000c28a` / `0x14000c2a2` | 往全局参数表（`0x1404e8b20`，`FUN_14000dad0`）插入 `-nowallpapers` |
| `0x14000c2b8` / `0x14000c2d0` | 插入 `-showbrowse` |
| `0x14000c311` | **无条件**执行 `RegSetValueExW(L"faultyShutdown", REG_DWORD, 1)` |
| `0x14000c346` | 读 `hideTrayIcon`，等于 1 时置位标志 0x1 |
| `0x14000c38e` | 读 `disablePlugins`，等于 1 时删除该值，并把 `plugins.ledextensions.enabled` 写成 false |

### 清除

**a. 正常退出，主函数里 【确】**

`FUN_14001eae0` 返回后，`0x14000c6b0` 同样检查非屏保模式，然后：

- `0x14000c6cf` 调 `RegOpenKeyW(HKCU, L"Software\\WallpaperEngine\\")`；
- `0x14000c709` 调 `RegSetValueExW(L"faultyShutdown", REG_DWORD, 0)`。

`FUN_14001eae0` 是建窗加 `GetMessageW` 主循环。循环收到 `WM_QUIT` 就结束（`0x14001fa57`–`0x14001fa9b`），做完清理后返回。

**b. 注销或关机，窗口过程里 【确】**

`FUN_140021e50` 处理 `msg == WM_QUERYENDSESSION (0x11)`，或者 `msg == WM_ENDSESSION (0x16)` 且 `wParam == 1` 的情况：

- 位置：`0x1400221eb`–`0x14002223a`，跳转表已核对，见 `jt.py`；
- 动作：`RegOpenKeyW` 后 `RegSetValueExW(faultyShutdown, 0)`，再交给 `DefWindowProcW`；
- 这个分支**没有**屏保模式检查。

**c. 外部：launcher 的更新流程 【确】**

`launcher.exe` 的 `InstallDistribution` 在 `0x14000bb2b`–`0x14000bbb9` 依次做这几件事：

1. 用 `FindWindowW(L"WPEEventWindow")` 判断 WPE 是否在跑，找不到再试 `L"WPETrayWindow"`（`0x14000a270`）。
2. 独占打开 `config.json`（`0x140009d70`，`CreateFileW`，`GENERIC_READ|WRITE`，只共享读）。
3. 以 `runas` 运行 `distribution\bin\apputil32.exe -closewe` 并一直等它结束（`0x14000af10`）。
4. 放开 `config.json`。
5. 关过 WPE 的话，执行 `RegOpenKeyW` 和 `RegSetValueExW(L"faultyShutdown", 0)`（`0x14000bb6e`–`0x14000bbb9`）。

可见开发者自己也采用「关进程后清标记」的做法。

### 时间线上的一个窗口期 【确】顺序 / 【推】后果

`FUN_14001eae0` 退出消息循环后先释放互斥体（`0x14001fabb`：`ReleaseMutex` + `CloseHandle`），再做清理、`DestroyWindow(事件窗口)`（`0x14001fccf`），最后回到主函数写 0（`0x14000c709`）。所以存在一段「互斥体已经没了、`faultyShutdown` 还是 1、进程还活着」的时间。这段时间里启动新实例：

- 带 `-silent` 时：
  - 如果互斥体还在，新进程会直接退出；
  - 如果互斥体已经释放，新进程会当成第一个实例启动，读到 1 后进入安全启动。
- 不带 `-silent` 时也一样：如果互斥体已经释放，新进程会当成第一个实例，读到 1 后进入安全启动。

**结论：正常退出后，要等进程句柄被触发（进程完全退出）再重新启动。**

---

## Q2 谁弹的；为什么 `-silent` 不起作用

### 决定由 `wallpaper64.exe` 做，界面由 `bin/wallpaperui.exe`（CEF）显示 【确】

1. 启动时判定 `faultyShutdown == 1`，并且 `safemode` 不为 false，就往参数表补上 `-nowallpapers -showbrowse`（Q1 表格）。
2. `FUN_14001eae0` 建窗后检查参数 `-showbrowse`。
   - 位置：`0x14001f770` 附近。
   - 前提：`hasshownwelcomedialog` 为真；为假时改走欢迎界面。
   - 动作：`PostMessageW(事件窗口, WM_COMMAND, 0x9c59, lParam)`，lParam 在有 `-nowallpapers` 时为 2，否则为 0（`0x14001f82a`、`0x14001f835`）。
3. 窗口过程的 `WM_COMMAND 0x9c59`（「更换壁纸」，打开浏览界面）在 lParam == 2 时，往发给界面的 JSON 里写 `browseroptions.safemodewarning = true`（字符串引用在 `0x14002587c`、`0x140025dc0`）。然后启动 `bin/wallpaperui.exe -window browsewallpapers`，handler 是 `WPEhandlerBrowseWallpapers`。
   - 这和此刻运行中的界面进程命令行一致：`-messagehandler WPEhandlerBrowseWallpapers … -window browsewallpapers`。
4. 前端 `ui/dist/scripts/scripts.js` 处理这个字段（文件内字节偏移约 83822）：

   ```js
   a.browseroptions.safemodewarning ? (
     l = function(){ s.checkboxChecked || F.callDeferred("browseWallpaperObject", "disableSafeMode") },
     W.open("genericConfirm", { data: s = {
       title: "ui_browse_modal_safe_mode_header",   // 「安全启动」
       message: "ui_browse_modal_safe_mode_body",    // 「程序似乎没有正常关闭，上次的壁纸和插件尚未加载……」
       okVisible: !0, cancelVisible: !0, checkboxLowVisible: !0,
       checkboxChecked: !0, checkboxTitle: "ui_browse_use_safe_mode" }})   // 「防止崩溃」
     .then(function(){ F.callDeferred("browseWallpaperObject", "reloadWallpaperConfig"), l() })
     .catch(function(){ l() })
   ) : …
   ```

   - 点「确定」：重新加载壁纸配置，也就是把上次的壁纸放回去。
   - 点「取消」：保持不加载壁纸。
   - 取消勾选「防止崩溃」：`disableSafeMode`。【推】它会把 `safemode` 永久改成 false：`wallpaperui.exe` 里有这个方法名，但具体处理没有读。
5. 文字在 `locale/ui_*.json` 里（`ui_browse_modal_safe_mode_*`），不在 exe 里。所以之前按「crash」扫 exe 找不到。

### 为什么 `-silent` 不起作用 【确】

`-silent` 在 `wallpaper64.exe` 里只有 3 处引用：

- `0x14000b5a6`：第二实例分支，见 Q5；
- `0x14000bb51`：低于 Win7 时是否弹系统版本提示；
- `0x14001e330`：更新时给 installer 加 `-silentupdate`。

`-showbrowse` 打开界面的路径（上文第 2、3 步）完全不检查 `-silent`。

---

## Q3 正常退出的路径

### 事件窗口 【确】

`FUN_14001eae0` 注册类 `L"WPEEventWindow"`（屏保模式下是 `L"WPEEventWindowSC"`），窗口过程是 `0x140021e50`。随后 `CreateWindowExW(0, atom, L"", 0, 0,0,0,0, NULL, NULL, hInst, NULL)` 建出一个顶层窗口：

- 标题为空；
- 样式 0，不可见；
- 不是 message-only 窗口，所以 `FindWindowW(L"WPEEventWindow", NULL)` 能找到它，WPE 的第二实例、launcher、apputil32 也都是这样找它的。

窗口过程与消息循环 `GetMessageW(&msg, NULL, 0, 0)` 都在主线程。

### 托盘「退出」 【确】

托盘菜单是 MENU 资源 103（VA `0x140520f30`，用 `menu.py` 解析）：

| 菜单 ID | 词条 |
|---|---|
| `0x9c59` | `core_tray_change_wallpaper` |
| `0x9c61` | `core_tray_change_screensaver` |
| `0x9c4d` | `core_tray_browse_workshop` |
| `0x9c52` | `core_tray_create_wallpaper` |
| `0x9c53` | `core_tray_settings` |
| `0x9c5c` | `core_tray_faq` |
| `0x9c5b` | `core_tray_take_screenshot` |
| `0x9c5f` | `core_tray_mute` |
| `0x9c56` | `core_tray_pause` |
| **`0x9c4a`（40010）** | **`core_tray_quit`** |

窗口过程收到 `WM_COMMAND` 时：

1. 先检查重入标志 `[0x1404df540] & 0x200`，置位时把消息原样重新投递，稍后再处理。
2. `0x140024c92`：`cmp id, 0x9c4a`，相等跳到 `0x140024f0f`。
3. `0x140024f1d`：`PostMessageW(hwnd, WM_QUIT (0x12), 0, 0)`。

之后消息循环结束，执行清理，回到主函数写 `faultyShutdown = 0`。

### 同样以 `WM_QUIT` 退出的其它代码 【确】

- WPE 自己的更新路径 `FUN_14001e2c0`：`ShellExecuteW(installer.exe …)` 之后 `PostMessageW(事件窗口, 0x12, 0, 0)`（`0x14001e4b3`）。
- `apputil32.exe -closewe`（`0x40499f`–`0x404a31`）：
  1. `FindWindowW(L"WPEEventWindow")`，找不到再试 `L"WPETrayWindow"`；
  2. `GetWindowThreadProcessId` 后 `OpenProcess(SYNCHRONIZE)`；
  3. `PostMessageW(hwnd, 0x12, 0, 0)`；
  4. `WaitForSingleObject(进程, 5000)`，再 `Sleep(1000)`；
  5. 调 `0x403d80`：遍历进程，用 `TerminateProcess` 结束名单内残留的进程，跳过自己。名单是 `wallpaper32.exe`、`wallpaper64.exe`、`webwallpaper64.exe`、`wallpaperui.exe`、`applicationwallpaperinject32.exe`、`applicationwallpaperinject64.exe`、`apputil32.exe`。

  这一步不清 `faultyShutdown`，清标记的是 launcher。

### WM_CLOSE 也是正常退出 【确】代码 / 【推】效果

- 系统消息跳转表 `0x140021f65` 里，`WM_CLOSE (0x10)` 落到 `0x14002224a`，即 `DefWindowProcW`，后者会 `DestroyWindow`。
- `WM_DESTROY (2)` 的处理在 `0x140021f8e`：标志 8 没置位时 `PostQuitMessage(0)`（`0x140021f9d`）。标志 8 只在建窗期间和清理末尾短暂置位。
- WPE 自己的「重启」路径（窗口过程中的 `0x14002d180` 附近）就是先 `PostMessageW(hwnd, WM_CLOSE, 0, 0)`（`0x14002d1a1`），再 `ShellExecuteW` 新实例。

`wpe-renderdoc` skill 文档说「也不响应 WM_CLOSE（`taskkill` 不带 `/F` 时主进程不退）」，代码不支持这个结论。【推】更可能的原因是：不带 `/F` 的 `taskkill` 只给进程的可见顶层窗口发 `WM_CLOSE`，事件窗口不可见，从没收到过这条消息。

### `-control` 里没有退出 【确】

`FUN_140008270` 把命令映射成 `WM_COPYDATA` 的 `dwData`，用 `SendMessageTimeoutW(…, 2000 ms)` 发给事件窗口。完整列表：

| dwData | 命令 |
|---|---|
| 1000 | `pause` |
| `0x3e9` | `stop` |
| `0x3ea` | `play` |
| `0x3eb` | `mute` |
| `0x3ec` | `unmute` |
| `0x3ed` | `openWallpaper` |
| `0x3ee` | `openPlaylist` |
| `0x3ef` | `closeWallpaper` |
| `0x3f0` | `applyProperties` |
| `0x3f1` | `nextWallpaper` |
| `0x3f2` | `hideIcons` |
| `0x3f3` | `showIcons` |
| `0x3f4` | `revealWallpaper` |
| `0x3f5` | `openProfile` |
| `0x3f6` | `aws`（内部命令，屏保进程用） |
| `0x3f7` | `getWallpaper` |

窗口过程里 `stop` / `play` 只切换播放状态，不会退出。

### 从外部触发的做法（三选一，都需要实验确认）

- **A.** `PostMessageW(hwnd, WM_COMMAND (0x111), 0x9c4a, 0)`：等同于点托盘「退出」。【确】代码路径。
- **B.** `PostMessageW(hwnd, WM_QUIT (0x12), 0, 0)`：与 `apputil32 -closewe` 和 WPE 更新路径相同。【确】代码路径。按 Win32 文档不推荐用 `PostMessage` 发 `WM_QUIT`，但 WPE 自己就是这么做的。
- **C.** `PostMessageW(hwnd, WM_CLOSE, 0, 0)`：与 WPE 的重启路径相同。【推】

其中 `hwnd = FindWindowW(L"WPEEventWindow", NULL)`。

**前提条件：**

- 调用方的完整性级别不低于 WPE，否则 UIPI 会拦截消息。launcher 用 `runas` 启动 apputil32，应该就是这个原因。【推】
- 每个会话只有一个实例，这个窗口一定属于当前唯一的 WPE。

**退出耗时：** 【未知】。apputil32 给的预算是 5 秒，之后加 1 秒。

---

## Q4 强杀后的补救

### 做法 【确】由代码推出 / 需实验

在被杀进程完全退出之后、下次启动之前，执行下面任一项：

- `HKCU\Software\WallpaperEngine` 下 `faultyShutdown` 写 REG_DWORD 0，命令是 `reg add "HKCU\Software\WallpaperEngine" /v faultyShutdown /t REG_DWORD /d 0 /f`；
- 或者删掉这个值。读失败等同于正常，启动时会重新写成 1。

不需要动 `config.json`，也不需要删文件。

### 时机还能更早 【推】

WPE 只在启动时写一次 1（`0x14000c311`，早于建窗）。所以只要**本实例的事件窗口已经能用 `FindWindow` 找到**，任何时候写 0 都行，包括强杀之前。

另一种办法：给事件窗口发 `WM_QUERYENDSESSION`，让 WPE 自己写 0。分支代码【确】，只写注册表再交给 `DefWindowProc`。不过伪造会话结束消息不如直接写注册表直白，不推荐。

### 副作用

- **就是同一个机制 【确】：** 强杀后壁纸不加载，是因为补上了 `-nowallpapers`。
  - `FUN_14001eae0` 开头：有 `-nowallpapers` 或 `-service` 时调 `FUN_140065110(…, 0)`，否则 `FUN_140065110(…, 1)`。
  - 第二个参数的含义【推】是「是否加载壁纸」，依据是调用点、参数名，以及「点确定后 `reloadWallpaperConfig` 才放回壁纸」。
  - 清掉标记后，下次 `-silent` 启动应当自动加载原来的壁纸，`driver.py --relaunch` 里用 `openWallpaper` 补放壁纸的做法也就不需要了。【推】
- **这一次失去崩溃保护：** 如果被杀是因为某张壁纸真的让 WPE 卡死，清标记后下次会直接再加载它。我们是主动强杀，可以接受。
- **强杀本身的副作用（与标记无关）：**
  - 主函数末尾的清理不会执行：`MFShutdown`、`InvalidateRect` / `ShowWindow(…, SW_SHOWNOACTIVATE)` 恢复桌面相关窗口（`0x14000c782`–`0x14000c7a4`）、关闭各个 `wallpaperui` handler 等。【推】桌面可能残留黑屏或旧画面，直到下次启动 WPE 或 Explorer 重绘。
  - 子进程可能残留，比如 `webwallpaper64.exe`、`applicationwallpaperinject*.exe`。apputil32 就是专门按名单补杀的。【推】
  - WPE 运行中会写 `config.json`（`FUN_140041250`），在写盘过程中被杀可能把文件写坏。【推】概率低，skill 本来也会按字节还原。
- **不推荐把 `config.json` 的 `safemode` 改成 false：** 这样也能不弹，【确】代码分支支持，但它会永久改动用户的「防止崩溃」设置，用户的 WPE 也会写这个文件。

---

## Q5 第二个实例

### 代码行为 【确】（`FUN_14000a220`）

**1. 判断是不是第二实例。** 非屏保模式下：

- `0x14000b341`–`0x14000b384`：`CreateMutexW(NULL, FALSE, L"cxWallpaperEngineGlobalMutex")`，`GetLastError() == ERROR_ALREADY_EXISTS (0xb7)` 时认定为第二实例，`r14d = 1`。
- 互斥体名不带 `Global\`，所以只在当前会话里生效。

**2. 第二实例带 `-silent`：** `0x14000b5a6`–`0x14000b5d1` 直接 `jmp 0x14000c7aa`，`return 0`。

- 不找窗口、不发消息、不弹框。
- 注意 `-silent` 的检查排在 `-control` 前面。**`-silent -control …` 同时出现时，命令根本不会发出去。**

**3. 第二实例不带 `-silent`：**

1. `FindWindowW(L"WPEEventWindow")`（`0x14000b5e0`）。
2. 找到窗口时：
   - 有 `-control`：执行 `FUN_140008270(hwnd)` 发命令，然后返回。
   - 有 `-language`：发 `WM_COMMAND 0x9c5a`。
   - 然后 `SendMessageTimeoutW(hwnd, WM_COMMAND, 0x9c59, 0, SMTO_NORMAL, 2000)`（`0x14000b8b3`、`0x14000b8c1`），**让已有实例打开浏览界面**。lParam = 0，不带安全启动提示。发送成功就 `return 0`。
3. 发送失败或超时（已有实例 2 秒没响应），或者返回值是 `0xb3b0`：
   - 返回值不是 `0xb3b0` 时，先弹 `MessageBoxW(core_msgbox_init_secondinstance_ask_quit, MB_OKCANCEL|MB_ICONWARNING)`（`0x14000b916`）。文字是「似乎已在运行且无响应，要强制重启吗？」。
   - 用户点「确定」，或者返回值是 `0xb3b0`，就 `TerminateProcess` 结束旧进程，等 4 秒后作为新实例继续启动。`0xb3b0` 是谁返回的【未知】，`wallpaper64.exe` 里没有找到产生这个值的代码。
   - 失败时弹 `core_msgbox_init_secondinstance_failed`（`0x14000ba35`）并返回 1。
4. 找不到窗口时（互斥体还在但没窗口，比如旧实例正在启动或正在退出）：用 toolhelp 枚举进程，`TerminateProcess` 结束另一个 `wallpaper32.exe` / `wallpaper64.exe`；失败就打日志 `Failed to terminate existing process without window. STARTING ANYWAY.`（`0x14000b6d4`）。两种情况都会继续作为新实例启动。

后两种情况被杀的旧实例来不及写 0，新实例接着就会读到 `faultyShutdown == 1`，进入安全启动。【推】

### 回答「已有进程时再启动 `-silent` 为什么弹界面」

按代码，这种情况**不该弹**。它属于第 3 步（不带 `-silent`）那种「转发给已有实例，让它打开界面」，而不是 `ask_quit` 询问。`ask_quit` 只在已有实例 2 秒无响应时出现。

和实测对不上的可能原因：

- 【推，可能性最大】命令拼错。此刻运行中实例的命令行是 `wallpaper64.exe  -slient`（2026-11-09 18:29:30 启动，`Win32_Process` 只读查询）。参数表里没有 `-silent`，于是走了第 3 步的转发。这个实例自己当初也是在 `faultyShutdown == 1` 的情况下启动的，所以它启动时打开了界面。
- 【推】完整性级别不同。比如已有实例是以管理员身份或高优先级自启动的，新进程是普通权限。`CreateMutexW` 打开高完整性对象时会返回 NULL 加 `ERROR_ACCESS_DENIED`，不是 0xb7。新进程就被当成第一实例，读到运行中实例写下的 1，进入安全启动，弹界面和对话框，并且会和旧实例同时跑。
- 【推】撞上旧实例正在退出的窗口期，见 Q1 末尾。

---

## Q6 对计划的影响

### a. 正常退出 WPE（外部触发）：可行【推，待实验 E2 / E3】

**做法：**

1. `FindWindowW(L"WPEEventWindow", NULL)`；
2. `PostMessageW(hwnd, WM_COMMAND, 0x9c4a, 0)`，等同托盘「退出」。备选是直接发 `WM_QUIT`；
3. `GetWindowThreadProcessId` 后 `OpenProcess(SYNCHRONIZE)`，`WaitForSingleObject` 等进程完全退出，超时可以设 10 秒；
4. 超时就回退到 b。

**结果：** WPE 自己把 `faultyShutdown` 写回 0，下次 `-silent` 启动不弹界面、自动加载壁纸。

**副作用和注意事项：**

- 每个会话只有一个实例。起点 A 下这样做关掉的就是用户的 WPE，与计划一致。
- 要求调用方的完整性级别不低于 WPE。【推】
- **必须等进程完全退出再重启**，原因见 Q1 末尾的窗口期。
- 退出时会不会写 `config.json`【未知】。skill 的字节还原应放在进程退出之后。
- 被 RenderDoc 注入的实例能不能顺利走完清理【未知】。
- 退出要多久【未知】。WPE 自己给的预算是 5 到 6 秒。
- 不建议直接调用 `apputil32.exe -closewe`：它 6 秒后会按名单强杀，而且不清标记。可以参考它的写法。

### b. 强杀 + 启动前清标记：可行【确】代码 / 【推】效果，待实验 E4

**做法：** `taskkill /F` 后等进程消失，写 `faultyShutdown = 0`，再启动。

**结果：**

- 不弹界面和安全启动对话框。
- 桌面壁纸会自动加载，现在 `--relaunch` 等 12 秒再用 `openWallpaper` 补放的做法可以去掉。

**副作用：**

- 失去这一次的崩溃保护。
- 强杀本身的副作用，见 Q4。
- 厂商的 launcher 也是这么处理的，算是有先例。

### c. 不退出用户正在跑的 WPE

- **不能另起一个普通实例 【确】：**
  - 带 `-silent` 的第二实例会立即退出，所以 RenderDoc 注入的第二实例什么也不会运行；
  - 不带 `-silent` 的第二实例只会让用户的实例弹出浏览界面。
- **只剩两条路：**
  - 对已在运行的进程做注入，不在本次范围内；
  - 屏保模式。
- **屏保模式的情况：**
  - 【确】`-screensaver` 置位 0x1000 后，会跳过互斥体检查，跳过 `faultyShutdown` 的读、写和清除，窗口类改为 `WPEEventWindowSC`，可以和用户实例并存。强杀这种实例也不会留下崩溃标记。
  - 【确】它显示的是 `general.wallpaperconfigscreensaver`，或者在 `sameaswallpaper` 为真时显示桌面壁纸，不是任意测试壁纸。
  - 【确】不带 `-preview` 时，它会另起 `wallpaper64.exe -control aws`，给用户的实例发 `0x3f6`。用户的实例收到后会在状态里置一个 `0x400000` 标志，效果【未知】。
  - 【推】带 `-preview -host <hwnd>` 时，它画进指定的窗口（Windows 屏保预览协议）。
  - 【未知】能不能换成我们的测试壁纸、能不能用 `-control` 控制它（`-control` 找的是 `WPEEventWindow`，会落到用户的实例上），RenderDoc 能不能抓到。
  - 只算探索方向，见 E8。
- **小结：** 想做到「完全不打扰」，目前没有现成的路。起点 A 要么接受「正常退出用户的 WPE，抓完再启动回来」（桌面空几秒、不弹窗），要么放弃。

### 附带结论（对计划步骤 0 有用）

- **我们自己带 `-silent -nowallpapers` 启动不会弹提示 【确】：** 只有 `-showbrowse` 才会打开界面；`-nowallpapers` 只决定 lParam 是不是 2，也就是要不要附带安全启动提示。前提是启动时 `faultyShutdown` 不为 1。
- **`-silent` 不能和 `-control` 一起用 【确】：** 有实例在跑时，命令会被直接丢掉。

---

## 建议的验证实验

做所有实验时都可以同时用 `reg query "HKCU\Software\WallpaperEngine" /v faultyShutdown` 观察这个值。

**E1. 被动观察（已做）**

- 做法：WPE 运行期间读这个值。
- 结果：`0x1`，与「启动写 1」一致。
- 对用户 WPE 的影响：无。

**E2. 托盘退出的基线**

- 做法：用户在 WPE 运行时手动点托盘「退出」。进程消失后读 `faultyShutdown`，看 `config.json` 和 `bin/` 下文件的修改时间，再执行 `wallpaper64.exe -silent`（注意拼写）。
- 预期：
  - 值变为 0；
  - 再启动时不弹界面、壁纸自动加载；
  - 记录从点退出到进程消失的耗时。
- 影响：用户的 WPE 被关掉，桌面空几秒；不需要强杀，不弹窗。

**E3. 外部触发正常退出（关键实验）**

- 做法：写一个小脚本：
  1. `FindWindowW("WPEEventWindow")`；
  2. `PostMessageW(hwnd, 0x111, 0x9c4a, 0)`；
  3. `WaitForSingleObject` 等进程，设 15 秒超时；
  4. 记录耗时、`faultyShutdown`、`wallpaperui` 等子进程是否都消失。

  可以再分别换成 `WM_QUIT (0x12)`、`WM_CLOSE (0x10)` 各做一次。最后 `wallpaper64.exe -silent` 启动回来。
- 预期：进程在几秒内退出，值为 0，再启动时不弹窗、壁纸自动加载。
- 影响：同 E2。如果超时，只能强杀，然后接着做 E4 收尾。

**E4. 强杀 + 清标记**

- 做法：
  1. `taskkill /PID <pid> /F`，等进程消失；
  2. `reg add "HKCU\Software\WallpaperEngine" /v faultyShutdown /t REG_DWORD /d 0 /f`；
  3. `wallpaper64.exe -silent`。
- 预期：不弹界面和安全启动对话框，桌面壁纸自动加载。
- 影响：
  - 用户的 WPE 被强杀一次，桌面可能短暂黑屏；
  - 如果预期不成立，会弹出安全启动对话框，需要用户点「确定」恢复壁纸；
  - 会改一次注册表值，这本来就是 WPE 自己维护的值。

**E5. 第二实例的 `-silent` 拼写对照**

- 做法：WPE 运行时：
  1. 执行 `wallpaper64.exe -silent`（拼写正确），看进程是否立即退出、界面是否出现；
  2. 再执行 `wallpaper64.exe -slient`。
- 预期：
  - 第 1 步什么都不发生，进程立即退出；
  - 第 2 步用户的实例弹出浏览界面，不带安全启动提示。
- 影响：第 2 步会在用户的 WPE 上弹出浏览界面，抢焦点，需要用户手动关掉。不需要强杀。

**E6. 完整性级别（只读）**

- 做法：查用户平时运行的 WPE 的完整性级别，比如用 Process Explorer，或者 `OpenProcessToken` 加 `TokenIntegrityLevel` 做只读查询。
- 预期：普通启动是 Medium。如果是 High（以管理员身份或高优先级自启动），我们的工具要以管理员身份运行才能发退出消息，第二实例检测也会失效。
- 影响：无。

**E7. RenderDoc 注入实例的正常退出（起点 B）**

- 做法：用户的 WPE 不在运行时，用 `renderdoccmd capture … wallpaper64.exe -silent -nowallpapers` 启动，开测试窗口，然后按 E3 发 `0x9c4a`。
- 预期：注入实例在几秒内退出，`faultyShutdown` 为 0，`renderdoccmd` 和 `qrenderdoc` 没有异常；下次普通启动不弹窗。
- 影响：用户的 WPE 本来就没在跑，无影响。如果卡住，就强杀并清标记。

**E8.（探索，可选）屏保模式并存**

- 做法：用户的 WPE 运行时，执行 `wallpaper64.exe -screensaver -preview -host <我们建的窗口句柄>`。观察：
  - 能否和用户的实例并存；
  - 画面画在哪里；
  - 用户的实例是否受影响；
  - 能否注入 RenderDoc；
  - 强杀后 `faultyShutdown` 是否不变。
- 预期：能并存，强杀不影响标记；显示的是屏保配置里的壁纸。
- 影响：
  - 可能出现全屏或额外窗口；
  - 不带 `-preview` 时会给用户的实例发 `aws`，效果未知，所以**一定要带 `-preview`**；
  - 风险未知，建议放到最后。

---

## 没查清的地方

- `0xb3b0` 这个回复值由谁产生、表示什么。
- 退出清理要多久；被 RenderDoc 注入后会不会卡住。
- 退出时会不会写 `config.json`。
- `disableSafeMode` 在 `wallpaperui.exe` 里的具体实现。
- `FUN_140065110` 第二个参数的确切含义（目前推断为「是否加载壁纸」）。
- `disablePlugins` 由 `FUN_140006b10` 写入，推断来自崩溃处理器，没有追。
- 屏保模式下能不能指定壁纸、能不能被控制。

## 工作文件（`ignore/wpe-mcp/rea/`）

- 二进制副本：`wallpaper64.exe`、`launcher.exe`、`apputil32.exe`。
- REA 快照副本：`wp-exit.rea-snapshot`。
- 反汇编：`launcher.asm`、`apputil32.asm`。
- 伪代码：`main_a220.c`（主函数）、`run_1eae0.c`（建窗与消息循环）、`wndproc_21e50.c`（事件窗口过程）、`control_8270.c`（`-control`）。
- 脚本：
  - `strs.py`：ASCII / UTF-16 字符串检索；
  - `rs.py`：按 VA 读字符串；
  - `imp.py`：导入表，支持 32 和 64 位；
  - `menu.py`：MENU 资源；
  - `jt.py`：窗口过程跳转表；
  - `ann.py`：objdump 注解；
  - `run.py`：在 `-I` 模式下调用 `ignore/p4/rea` 下的 `xr.py` / `d.py`；
  - `ex.py`：从 REA 结果里取出伪代码。
