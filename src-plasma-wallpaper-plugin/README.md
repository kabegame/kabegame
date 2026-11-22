# Kabegame Plasma 壁纸插件（插件模式，Linux / KDE Plasma 6）

插件模式下 Kabegame 自己渲染壁纸（离屏壁纸窗口），每一帧作为 PipeWire 视频源推出去；这个插件在 plasmashell 的桌面里
把流铺满显示，再把落在桌面上的鼠标发回 Kabegame。插件不连 app IPC、不读 Kabegame 的设置、不认识壁纸类型。
设计见 `.claude/plans/plasma-pipewire/README.md`（点 6、点 7）。

## 组成

- `src/StreamFinder.*`：连默认 PipeWire，找带 `kabegame.wallpaper.protocol` 的 `Video/Source` 节点，按屏选一路
  （`kabegame.wallpaper.screen` 等于本屏的优先，其次不绑屏的；同级取 `object.serial` 最大的）。
- `src/PointerForwarder.*`：在桌面窗口上装事件过滤器（只看不吞），把移动 / 按键 / 离开按定长 32 字节的消息用
  `SOCK_DGRAM` 发到节点属性 `kabegame.wallpaper.input` 给的 socket（协议见 `src-tauri/kabegame/src/wallpaper/manager/pointer_socket.rs`）。
  主窗口在哪由 Kabegame 自己问 KWin，插件里不用任务管理器模型（`TaskManager.TasksModel`）：试验时壁纸里建了它，之后 plasmashell
  报 GL 上下文错误并卡死过（2026-11-22；后来不用它也出现过同样的报错，元凶未必是它，原因未明）。
- `package/contents/ui/main.qml`：永不改的壳，按配置项 `General/Entry` 加载内容文件，加载失败退回 `content.qml`。
- `package/contents/ui/content.qml.in`：这个修订的内容（`PipeWireSourceItem` 铺满 + 上面两个模块）。不要调
  `PipeWireSourceItem.error()`：流还没建起来时会让 plasmashell 段错误（KPipeWire 6.6.4）。

## 版本

- `PROTOCOL`：与 Kabegame 的约定版本，节点属性 `kabegame.wallpaper.protocol`、输入消息的 `version`、`metadata.json` 的
  `X-Kabegame-StreamProtocol` 都是它（应用的单测核对它与 `wallpaper::manager::plasma::pipewire::PROTOCOL_VERSION` 相等）。改约定时两边一起升。
- `REVISION`：插件修订号，**改了插件就要加一**。QML 模块 URI、`.so` 名与内容文件名都带它（`KabegameWallpaperR<修订号>`）：
  plasmashell 按 URL 缓存 QML 组件、已加载的 `.so` 卸不掉、注册过的模块 URI 不能再注册，不换名字就只能重启 plasmashell 才生效。

## 构建与分发

```bash
deno task build:plasma-plugin
```

产物是 KPackage 目录 `bin/linux/<arch>/plasma-wallpaper-plugin-build/package/org.kabegame.wallpaper`。kabegame 的 dev / build
（Linux standard）由 `PlasmaWallpaperPlugin` 拷进应用的 `resources/plasma-wallpaper/`，随 deb 分发；没有产物只告警。
需要 cmake、Qt ≥ 6.6 的 Quick / Qml 开发包与 libpipewire-0.3 开发包。

**出货要对着 Qt 6.6 构建。** 插件被 plasmashell 加载进它的进程，用的是用户系统里的 Qt（我们不带 Qt，带了会在同一进程里
冲突）；Qt 的二进制兼容只往前：对着 6.6 编的能在 6.6 及以后加载，对着 6.10 编的在 6.6 上找不到新符号。Plasma 6 要求
Qt ≥ 6.6，所以对着 6.6 编就覆盖全部 Plasma 6 用户。发行版的包管理器多半没有 6.6（Ubuntu 22.04 是 6.2、24.04 是 6.4），
用 Qt 官方二进制装到一个目录，再用 `--qt` 指过去：

```bash
sudo apt install python3-pip                                      # Ubuntu 22.04 默认没有 pip
python3 -m pip install --user aqtinstall
python3 -m aqt install-qt linux desktop 6.6.3 gcc_64 -O ~/Qt      # 6.6 的 arch 名是 gcc_64，6.7 起是 linux_gcc_64
deno task build:plasma-plugin --qt ~/Qt/6.6.3/gcc_64
```

- 出货在 Ubuntu 22.04 构建虚拟机里做（glibc 2.35，比所有 Plasma 6 发行版都旧），见
  `cocs/build/LINUX_BUILD_WORKFLOW.md`「构建步骤」。Ubuntu 22.04 本身没有 Plasma 6，那里的用户照常用 Kabegame，只是没有插件模式。
- 不带 `--qt` 时用系统的 Qt，只适合开发；脚本最后打印用到的 Qt 版本，不是 6.6 时提醒。
- CMake 构建目录按系统与 Qt 分开（`cmake-r<修订>-<系统>-<Qt>`）：仓库在 host 与构建虚拟机之间共享，CMake 缓存记着 Qt 的
  路径与生成器，混用会拿错 Qt。产物目录是同一个，出货时构建完插件紧接着打包，中间别在 host 上重新构建插件。

## 安装、升级与卸载（应用侧）

- 切到插件模式与启动对齐时，`src-tauri/kabegame/src/wallpaper/manager/plasma/install.rs` 照 Plasma 的查找顺序看装着的那份：没有、
  约定版本不同或修订号比内置的旧，就把内置包拷进 `~/.local/share/plasma/wallpapers/org.kabegame.wallpaper`（系统目录里别的包装的
  旧版不碰，用户目录的盖过它），再经 `evaluateScript` 把各桌面换成本插件、`General/Entry` 写成新修订的内容文件，plasmashell
  不用重启。
- 应用正常退出（托盘「退出」、关主窗口时确认退出，都经 `RunEvent::Exit`）时，插件模式下把各桌面换回 `org.kde.image`
  （`plasma::restore_system_plugin_on_exit`）：不换的话推流随进程结束而断，桌面一片黑。下次启动时再换回本插件。崩溃、被杀、
  注销时没有这一步，桌面会停在本插件上，直到 Kabegame 再次启动。
- deb 卸载（`src-tauri/kabegame/deb/postrm.sh`）把各用户用着本插件的桌面换回 `org.kde.image`，删掉用户目录里带
  `X-Kabegame-StreamProtocol` 的这份。

## 调试

plasmashell 的日志里搜 `[kabegame-wallpaper]`：选中的节点变了、连不上 PipeWire 时各打一行。
