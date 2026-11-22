# Kabegame GNOME Shell 扩展（插件模式，Linux / GNOME 42–51）

GNOME 会话下的插件模式由它把 Kabegame 的壁纸窗口放到桌面上：
- 按标题 `kabegame-wallpaper <序号>` 认出壁纸窗口，序号 0 放主屏；
- 让窗口铺满那块屏、钉在所有工作区、压在最底层，不让最小化，并跟着显示器变化重新铺放；
- 经 D-Bus 告诉应用窗口在全局坐标里的位置，两边据此互相跟光标。

应用侧是 `src-tauri/kabegame/src/wallpaper/manager/gnome/`：
- `extension.rs`：版本门槛、在线检测、安装、掉线监听；
- `mod.rs`：插件模式要求扩展在线，掉线就退回原生模式；
- `window_locator.rs`：问窗口位置。

## 组成

- `core.js`：两份共用的逻辑。不写 `import`，也不定义入口。
- `legacy.js`：GNOME 42–44 的包装（`imports.*` 模块），`init()` 返回扩展对象。
- `esm.js`：GNOME 45+ 的包装（ES 模块），`export default class extends Extension`。

扩展不单独构建。应用用 `include_str!` 把三个文件编进程序，安装时按当前 Shell 的主版本选一个包装，把 `core.js` 填进
`/* @@KABEGAME_CORE@@ */` 拼成 `extension.js`；`metadata.json` 由应用生成：
- `shell-version` 按同一条线分开写：旧式那份是 42–44，ESM 那份是 45–51。
- `session-modes` 含 `unlock-dialog`，锁屏时也保持启用，否则一锁屏应用就会退回原生模式。

## 两条线

- **模块格式按 45 分**：45 起扩展必须是 ES 模块，之前只能是 `imports.*`，一个文件两边都加载不了。
- **挂到桌面的手段按 49 分**：mutter 49 才把 `Meta.Window.set_type` / `hide_from_window_list` 公开。这是对照 42–51 每个版本的
  `gir1.2-mutter-*` typelib 查到的；46–48 只有 `Meta.WaylandClient.make_desktop`，它要求窗口属于扩展自己拉起的进程，用不上。
  `core.js` 运行时看 `Meta.Window.prototype.set_type` 在不在：
  - **49+**：设成 `DESKTOP` 类型并从窗口列表里藏起来。
  - **42–48，X11 窗口**：用 `xprop` 给窗口写 `_NET_WM_WINDOW_TYPE_DESKTOP`，mutter 读到后重新定窗口类型，窗口就成了真正的桌面窗口。
  - **42–48，Wayland 窗口**：仍是普通窗口，被压在普通窗口层的最底层。补丁把它从 Alt+Tab（`Meta.Display.get_tab_list`）、概览和工作区缩略图
    （`_isOverviewWindow`）里滤掉，每处都先确认方法存在，`disable()` 时还原。已知局限：
    - 窗口受顶栏、Dock 的保留区约束，铺不到它们下面；
    - 盖住桌面图标（DING 的窗口在更低的桌面层）；
    - Dash 里 Kabegame 的图标把这个窗口算作 Kabegame 的窗口。

## 与应用的约定

- `PROTOCOL`（`core.js`）等于 `extension.rs` 的 `PROTOCOL`（单测核对）。改了 D-Bus 接口或窗口处理就加一：应用把约定版本不同的扩展
  当作不在线，用户再切插件模式时会重装。
- 扩展启用期间在会话总线上占着 `app.kabegame.Shell`（应用监听它的属主变化来发现掉线），并在 `/app/kabegame/Shell` 导出
  `app.kabegame.Shell1`：
  - 属性 `Protocol`（`u`）；
  - `GetWindowFrame(s 标题) -> (b 找到, d x, d y, d 宽, d 高)`：只回答调用方进程自己的窗口（按 D-Bus 连接核对进程号），最小化的算找不到。
- 壁纸窗口的标题前缀是 `wallpaper::manager::window::WINDOWED_TITLE_PREFIX`（单测核对）。

## 安装与在线（应用侧）

- 切到插件模式前，前端调 `get_plugin_mode_readiness`，按结果处理：
  - Shell 版本不在 42–51：提示升级系统，比 51 新的提示等 Kabegame 更新；
  - 扩展不在线：问用户要不要安装。确认后 `install_gnome_shell_extension` 把扩展写进
    `~/.local/share/gnome-shell/extensions/kabegame@kabegame.app/`（整个覆盖，不看装没装过），把 UUID 加进
    `org.gnome.shell enabled-extensions`、从 `disabled-extensions` 拿掉，再提示注销重新登录（GNOME 只在登录时扫描扩展目录）。
    系统的扩展总开关关着时一并提示。
- 在插件模式里任何地方发现扩展不在线就退回原生模式，并经 `user-message` 告诉用户。检查的地方有：
  - 后端 `init` / `set_wallpaper` / `reconcile`；
  - 问窗口位置开始失败时；
  - 监听到 `app.kabegame.Shell` 没了属主。
- 开机自启时 Shell 可能还在加载扩展：恢复壁纸前最多等 15 s。

## 测试

- `scripts/gnome-nested.sh` 起一个嵌套 GNOME Shell（自带会话总线），它加载用户目录里的扩展（扩展代码按进程缓存，改了要重启嵌套 Shell）。
  `scripts/gnome-nested.sh run <命令>` 往里开程序。用一个标题为 `kabegame-wallpaper 0` 的窗口就能测，不必起应用。
- Shell 的日志里搜 `[kabegame]`：启用时打印约定版本和走的是哪条路（`desktop window type` / `kept at the bottom`），认出窗口时打印 `managing`。
- 2026-11-22 在 Ubuntu 22.04 虚拟机（GNOME 42，X11）里起嵌套 Shell 时，它一直没导出 `/org/gnome/Shell`、也没加载扩展；当时外层会话
  正处于锁屏（`LockedHint=yes`），疑与此有关，未确认。在这种环境里测，先解锁外层会话。
