# Linux 插件模式：离屏渲染 + PipeWire 推流 —— 总纲

> 状态：P0、P1（含 P1b dmabuf）、P2 鼠标、P3 安装与切换完成（2026-11-22；插件源码在 `src-plasma-wallpaper-plugin/`）；P4 起未开始。
> 范围：KDE Plasma 6（Wayland 与 X11 会话都适用）。GNOME 不在本计划内。
> 插件仓库：`kabegame/plasma-wallpaper-plugin2`（本地工作副本 `../plasma-wallpaper-plugin2`）。插件端的界面与实现由插件仓库
> 自己决定，本计划只规定 Kabegame 一侧、插件的分发方式，以及两边之间的约定（§ 点 7）。
> 参考：`ignore/waywallen`（守护进程）与 `ignore/waywallen-display`（KDE 插件 `extensions/kde`、嵌入式 QML 模块 `plugins/qml`）
> 走的是同一种「守护进程渲染、Plasma 插件显示」架构，帧与输入走它自己的 Unix socket 协议；本计划的帧改走 PipeWire，
> 分发方式与鼠标的取法照它。

## 总体设计思路

Linux 上的壁纸改由 Kabegame 自己渲染，Plasma 插件只负责显示和转发鼠标。Kabegame 用 CEF 离屏渲染（windowless / OSR）打开
与 Windows、macOS 窗口模式**同一个**壁纸页面（`index.html?window=wallpaper&slot=<n>` → `WallpaperWindow.vue` → `Wallpaper.vue`
→ `ImageContent`），把每一帧作为 PipeWire 视频源（`Video/Source` 节点）推出去。Plasma 壁纸插件用 Plasma 自带的 KPipeWire
（`org.kde.pipewire` 的 `PipeWireSourceItem`）把流铺满自己所在的屏。图片、视频、GIF、WPE 网页、WPE 场景全部走同一条路，
插件不认识任何壁纸类型。

组件边界这样移动：Linux 的「插件模式」(`plasma-plugin`) 在后端变成**离屏版的窗口模式**。窗口表、每屏一窗、布置
（`WindowAssignment`）、就绪握手、ping 看门狗、label 池、ACL 与 `file:` 登记全部复用 `WindowWallpaperManager` 现有的逻辑；
不同的只是「窗口落到哪里」：Windows 挂 WorkerW，macOS 设桌面层级，Linux 是一个不建原生窗口的 CEF browser，帧交给 PipeWire。
插件不再经 app IPC 读设置、不再自己显示图片和做过渡。

数据有两个方向，各走一条单向通道。**帧**：Kabegame → PipeWire → 插件。**鼠标**：插件 → 一个只收不回的 Unix socket → Kabegame。
插件对 Kabegame 的状态完全只读（它要的流地址、输入 socket 路径、对应哪块屏，都写在 PipeWire 节点属性里），只写出输入事件，
不读任何回复，所以没有请求 / 应答、没有协议握手与重连状态机。鼠标的取法照 waywallen：插件的 C++ 模块在 plasmashell 的桌面窗口上
装事件过滤器、只看不吞，落在壁纸范围内的移动与按键换算成归一化坐标发出去；桌面图标、桌面右键菜单照常工作。Kabegame 收到后
不另起一套注入：它实现 `tauri-plugin-cursor` 的一个 Linux 探针，把插件推来的样本当作「全局光标」，之后的点击规则、frame 登记、
经 CEF 补丁 11 注入 frame，都与 Windows / macOS 的壁纸窗口相同。

帧的传输默认用 dmabuf，失败时降级到共享内存。CEF 的 `OnAcceleratedPaint` 在 Linux 上给出的是 CEF 自己缓冲池里的 dmabuf，
**只在回调期间有效**，不能直接交给 PipeWire。所以 Kabegame 在 EGL 上维护一组自己的 GBM 缓冲（按与消费者协商出的 modifier 分配），
在回调里把 CEF 的纹理 GPU 拷贝进去再入队；协商不出 dmabuf 时，同一张纹理读回到 memfd 共享内存；CEF 拿不到加速绘制时（软件合成），
用 `OnPaint` 的 CPU 缓冲直接写共享内存。唯一需要的反向「信号」来自 PipeWire 自身：没有消费者在拉流时，对应的离屏 browser 停止出帧。

插件随 Kabegame 一起分发、自动安装。插件是一个 KPackage，里面嵌着一个小的私有 C++ QML 模块（节点发现 + 鼠标转发），
`main.qml` 用相对目录导入它；这种包能用 `kpackagetool6 --type Plasma/Wallpaper -i` 装到用户目录，不需要 root（waywallen 的 KDE 插件
就是这样发布的）。插件仓库的 CI 产出 zip，Kabegame 构建时按固定版本取进 resources。切到插件模式时，Kabegame 按位置检查插件
（用户目录 `~/.local/share/plasma/wallpapers/org.kabegame.wallpaper` 优先，其次 `/usr/share/plasma/wallpapers/…`），缺失或协议版本过旧
就安装 / 升级，再经 `evaluateScript` 把各桌面的 `wallpaperPlugin` 切过去。

关键决策与理由：
- **离屏 + 推流，而不是置底窗口或 layer-shell**：KWin 脚本置底的窗口在 BelowLayer，会盖住桌面图标与桌面右键菜单（2026-11-21 实测，
  见「已否决的方案」）；Chromium 的 Ozone Wayland 不能建 layer surface。只有 Plasma 壁纸插件处在 plasmashell 桌面内部、图标下面。
- **复用窗口模式**：壁纸页面、过渡、WPE 垫片、场景宿主、轮播、frame 鼠标注入都已在窗口模式里调通，离屏只改「帧从哪来、
  光标从哪来」。多显示器计划（`.claude/plans/multi-screen/README.md`）当时就预留了「Linux 以后用 Chromium 离屏渲染实现窗口模式」。
- **帧走 PipeWire 而不是自定 socket**：dmabuf 导入、格式与 modifier 协商、共享内存兜底、X11 / Wayland 差异都由 PipeWire 与 KPipeWire
  处理，插件不用写 GPU 代码。代价是没有显式同步（acquire / release fence），由生产端在入队前等 GPU 完成。
- **插件只读状态、只写输入**：插件不连 app IPC，与 IPC 协议版本解耦；Kabegame 没运行时节点不存在，插件显示占位，节点出现后自动接上。
- **鼠标进 `tauri-plugin-cursor`，不另写注入**：点击规则（`OverDesktop`）、按下抬起配对、frame 销毁补离开等语义只有一份。
- **`CefSettings.windowless_rendering_enabled` 只在 Linux 打开**：CEF 注明打开它可能降低普通 browser 的渲染性能；它是进程级设置，
  不能按模式切换。Linux 没有窗口模式壁纸，由主窗口与畅游窗口承担这个代价，P0 要量实际影响。

## 现状锚点

**a. 插件模式后端什么都不输出**（`src-tauri/kabegame/src/wallpaper/manager/plasma_plugin.rs`）
```rust
async fn set_wallpaper(
    &self,
    _file_path: &str,
    _style: &str,
    _transition: &str,
    _placement: &Placement,
) -> Result<(), String> {
    // 插件模式：不调用 qdbus。rotator / 命令把当前壁纸、样式、过渡写进目标配置，
    // 触发 setting-change 事件，插件通过 IPC 获取并显示。
    Ok(())
}
```
现状：插件（C++ `plugin/ipcclient.cpp` 连 `temp_dir/Kabegame/kabegame.sock`、`subscribe-events`）自己读设置、自己显示图片 / 视频与过渡；
`init` / `cleanup` 只经 `evaluateScript` 切 `wallpaperPlugin`。插件装在系统 QML 路径（`sudo make install` / deb），.so 名带版本号
（`libplasma_wallpaper_kabegame_<x_y_z>.so`）以避开 plasmashell 的缓存。

**b. 窗口后端只在 Windows / macOS 编译**（`src-tauri/kabegame/src/wallpaper/manager/mod.rs`）
```rust
pub struct WallpaperController {
    native: Arc<dyn WallpaperManager + Send + Sync>,
    #[cfg(target_os = "linux")]
    plasma_plugin: Arc<dyn WallpaperManager + Send + Sync>,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    window: Arc<dyn WallpaperManager + Send + Sync>,
}
```

**c. 插件模式只在「已安装」时列出**（同文件 `capabilities`）
```rust
#[cfg(target_os = "linux")]
if plasma_qdbus::is_kabegame_plasma_plugin_installed() {
    modes.push(wallpaper_option(
        "plasma-plugin",
        "settings.modePlugin",
        None,
    ));
}
```
`is_kabegame_plasma_plugin_installed`（`plasma_qdbus.rs`）只看 `/usr/share/plasma/wallpapers/<id>` 与 `<data_dir>/plasma/wallpapers/<id>` 两个目录在不在；
前端 `composables/useDesktop.ts` 另调 `is_plasma_wallpaper_plugin_installed` 命令做同样判断。

**d. Linux 直接拒绝 WPE 壁纸**（`src-tauri/kabegame/src/commands/wallpaper.rs`）
```rust
// 目录型 WPE 壁纸第一阶段只支持窗口模式；用与视频相同的错误码让前端引导切换模式。
// Linux 没有窗口模式，引导过去也切不了，直接报错。
if kabegame_core::media::image_type::is_wpe_type(media_type.as_deref())
    && settings.get_wallpaper_mode() != "window"
{
    return Err(if cfg!(target_os = "linux") {
        "Linux 暂不支持把 Wallpaper Engine 壁纸设为桌面".to_string()
    } else {
        "REQUIRES_WINDOW_MODE".to_string()
    });
}
```

**e. CEF 运行时没有离屏渲染路径**（`src-tauri/tauri-runtime-kbcef/src/`）：没有 `RenderHandler`，所有 browser 都是 Views 窗口；
Linux 的 Ozone 平台按会话探测（`runtime.rs` 的 `linux_ozone_platform`，Wayland 会话跑原生 Wayland）。

**f. CEF 对 Linux 共享纹理的约束**（`third/cef/include/cef_render_handler.h`，`OnAcceleratedPaint`）
```
/// ... on Linux it contains several planes, each
/// with an fd to the underlying system native buffer.
///
/// The underlying implementation uses a pool to deliver frames. As a result,
/// the handle may differ every frame depending on how many frames are
/// in-progress. The handle's resource cannot be cached and cannot be accessed
/// outside of this callback. It should be reopened each time this callback is
/// executed and the contents should be copied to a texture owned by the
/// client application.
```
`cef_types_linux.h` 里 `shared_texture_enabled` 的注释仍写「Currently only supported on Windows (D3D11)」，与上面矛盾，P0 实测为准。
waywallen 的 README 记了一条：NVIDIA 上网页壁纸要关掉 `shared_texture_enabled`。

**g. 光标插件只有 Windows / macOS 的探针**（`src-tauri/tauri-plugin-cursor/src/hub.rs`，`platform/` 下只有 `windows.rs`、`macos.rs`）
```rust
/// 平台探针：轮询线程独占，所有方法都在那条线程上调用。
pub(crate) trait Probe: Send + 'static {
    /// 窗口还在不在；不在就移除订阅。每轮调用一次。
    fn alive(&mut self) -> bool;
    /// 读一次光标与左键；读不到返回 `None`，本轮跳过。
    fn sample(&mut self) -> Option<Sample>;
    /// 上一次 [`Self::sample`] 的光标下是不是桌面。
    fn over_desktop(&mut self) -> bool;
    /// 上一次 [`Self::sample`] 的光标下的顶层窗口是不是被观察的窗口。
    fn over_window(&mut self) -> bool;
}
```
现状：Linux 拿不到全局光标，网页 / 场景壁纸退回 iframe 直接收真实鼠标（只对预览有效）。

**h. Linux 没有显示器枚举**（`src-tauri/kabegame/src/wallpaper/screens.rs`）：只有 macOS 实现，Linux 的在线屏列表为空，布局退化成一个不绑屏的目标。

## 点 1 —— 运行时：离屏 browser（`tauri-runtime-kbcef`）

- **新增** `offscreen.rs`
  - 建窗时 `extra_info` 带 `kabegame.offscreen`（与 04 / 05 / 10 的 `kabegame.*` 键同一个入口）的窗口，不建 Views 窗口，改建 windowless browser：
    `windowless_rendering_enabled = 1`、`shared_texture_enabled = 1`（拿不到加速绘制时 CEF 退回 `OnPaint`；NVIDIA 视 P0 结论可能要关）、
    `windowless_frame_rate` 取壁纸帧率设置、背景色不透明。
  - `RenderHandler`：`GetViewRect` 返回窗口请求的逻辑尺寸，`GetScreenInfo` 给出缩放（画布像素 = 屏的物理像素），
    `OnAcceleratedPaint` / `OnPaint` 转给按 label 登记的帧接收器。
  - 应用注册帧接收器的入口，写法同 `set_file_scope_resolver`：
    ```rust
    // 新增
    pub enum OffscreenFrame<'a> {
        /// CEF 池里的 dmabuf：只在本次回调内有效，接收器必须在返回前拷走
        DmaBuf { planes: &'a [DmaBufPlane], modifier: u64, fourcc: u32, width: u32, height: u32 },
        /// 软件绘制的 BGRA（CEF 没有加速绘制时）
        Cpu { data: &'a [u8], width: u32, height: u32, stride: u32 },
    }

    pub trait OffscreenFrameSink: Send + Sync {
        fn on_frame(&self, frame: OffscreenFrame<'_>);
    }

    pub fn set_offscreen_frame_sink(label: &str, sink: Option<Arc<dyn OffscreenFrameSink>>);
    ```
  - 窗口操作映射：`set_size` → `WasResized`，`show` / `hide` → `WasHidden(false/true)`，位置、置顶、装饰等 → 空操作；
    帧率设置变化 → `SetWindowlessFrameRate`；`inner_size` / 缩放返回离屏视图的值（`frame_mouse` 的尺寸核对要用）。
- **修改** `runtime.rs` 的 CEF 初始化：Linux 上 `CefSettings::windowless_rendering_enabled = 1`（理由见总体设计）。
- **核对**：04 / 05 / 06 / 07 / 08 / 09 补丁对 windowless browser 的条件判断（「非弹窗、最外层主 frame」等），确保离屏壁纸窗口
  拿到与现在壁纸窗口相同的 `file:` 能力；11（`ConvertPointFromView` / `SendMouse*EventToFrame`）在 windowless browser 上可用，
  不可用时退到 `CefBrowserHost::SendMouse*Event`（离屏 browser 的原生输入入口）。

## 点 2 —— PipeWire 视频源（`src-tauri/kabegame/src/wallpaper/pipewire/`，仅 Linux）

- **新增** `stream.rs`：一个 `pw_thread_loop`，每个离屏壁纸窗口一个 `Video/Source` 节点（`pipewire` crate）。
  - 节点属性（与插件的约定，见点 7）：
    ```text
    media.class                  = Video/Source
    node.name                    = kabegame-wallpaper-<slot>
    node.description             = Kabegame Wallpaper (<屏名>)
    kabegame.wallpaper.protocol  = 1
    kabegame.wallpaper.screen    = <接口名，如 DP-5；不绑屏的那一路为空>
    kabegame.wallpaper.input     = <输入 socket 的绝对路径，见点 4>
    kabegame.wallpaper.slot      = <slot 序号，输入消息里用它指明是哪一路>
    ```
    不设 `media.role`：Plasma 的共享屏幕 / 摄像头指示按 `media.role` 的 Screen / Camera 判断，壁纸流不该触发它们。
  - 格式：只用 `BGRA`（DRM `ARGB8888`，与 CEF 的 `BGRA_8888` 一致；KPipeWire 6.6 的消费者不收 `BGRx`，P0 实测），
    尺寸 = 屏的物理像素，帧率可变（`0/1`，`maxFramerate` 取帧率设置）。先提供带 modifier 列表的 dmabuf 格式，
    再提供 `MemFd` 共享内存格式，由消费者选。
  - 节奏：Kabegame 是驱动方，有新帧才入队；静态图片只在换图、过渡期间出帧。
  - 状态反馈：所有链接都不在 `Streaming`（插件不可见、Plasma 暂停了流）时，对该 label 调 `hide`（`WasHidden(true)`），恢复时 `show`。
- **新增** `gpu.rs`：EGL（GBM 平台）+ GLES。render node 取合成器的主设备（Wayland 的 linux-dmabuf v4 feedback `main_device`；
  X11 取 plasmashell 所用的卡），CEF 的 GPU 进程也在这张卡上（P0：双 NVIDIA 机器上 CEF 与 KWin 都在 4070）。
  KPipeWire 不做设备协商（EnumFormat 里没有 `deviceId`）：在别的卡上分配的 dmabuf 它导入报 `EGL_BAD_ALLOC`，
  逐个剔掉 modifier 重协商，全部失败后才落到共享内存（P0：约 200 ms、12 次重协商），所以不能靠它兜底，必须选对卡。
  - 导入：`EGL_EXT_image_dma_buf_import_modifiers` 把 CEF 的 planes 包成 `EGLImage` → 纹理。
  - 缓冲池：按协商出的 modifier 用 GBM 分配，也包成 `EGLImage` → FBO；回调里 blit 一次，用 EGL fence 等完成后入队。
  - 读回：协商结果是共享内存时，blit 之后 `glReadPixels`（PBO）到 memfd 映射。
- **新增** `shm.rs`：`MemFd` 缓冲池；`OffscreenFrame::Cpu` 直接按行拷进去。
- 来源 × 输出：

  | CEF 给出 | 消费者接受 dmabuf | 只接受共享内存 |
  |---|---|---|
  | `DmaBuf`（加速绘制） | GPU blit 到 GBM 缓冲（默认路径） | GPU blit + 读回到 memfd |
  | `Cpu`（软件绘制） | 不提供 dmabuf 格式 | 按行拷贝到 memfd |
  | EGL 初始化失败 | 不提供 dmabuf 格式 | `Cpu` 路径（这时让 CEF 关共享纹理） |

  降级只在协商时决定；运行中 dmabuf 入队失败时重新协商一次，再失败就固定走共享内存并 `warn!`。
  X11 会话里 plasmashell 默认用 GLX，KPipeWire 导入不了 dmabuf，会自然选共享内存（waywallen 要求用户给 plasmashell 设
  `QT_XCB_GL_INTEGRATION=xcb_egl`；我们不要求，只是 X11 下走慢路径）。

## 点 3 —— 壁纸后端：Linux 插件模式 = 离屏的窗口模式

- **修改** `manager/window.rs`：把「窗口落到哪里」抽成按平台的一小段（Windows 的 wemt 挂载、macOS 的桌面层级、Linux 的离屏 + 推流），
  `plan_windows` / `diff_windows` / 槽位 / 布置 / 就绪握手 / ping 不动。Linux 版本：
  - 建窗：同一个 `index.html?window=wallpaper&slot=<n>`，加 `kabegame.offscreen`，尺寸取 `WindowPlan.screen` 的逻辑尺寸
    （没有屏幕信息时取主屏，见点 5）；建好后 `set_offscreen_frame_sink(label, 该 label 的 PipeWire 流)`，并登记点 4 的指针源。
  - 换尺寸 / 换屏：`set_size` + 流重新协商；销毁：先摘接收器与指针源、再关节点、再关 browser。
  - 点击规则：`set_click_rule(label, ClickRule::OverDesktop)`，与 Windows / macOS 壁纸窗口相同。
- **修改** `manager/mod.rs`：Linux 也编译 `window`，`manager_for_mode("plasma-plugin")` 返回离屏窗口后端（设置值仍叫 `plasma-plugin`，
  不做迁移）；`init` / `cleanup` 在建窗 / 销毁之外再切 `wallpaperPlugin`（沿用 `plasma_qdbus`）。样式 / 过渡与窗口模式相同。
- **修改** 能力表：插件模式在「Plasma 6 会话」时列出，不再要求事先装好插件（会自动装，见点 6）。显示器模式：P1 只有 `multiple`；
  P4 起 `single` 可用；`span` 不可用。
- **修改** `commands/wallpaper.rs`：Linux 上 WPE 壁纸不在插件模式时返回 `REQUIRES_PLUGIN_MODE`（前端已有引导），不再直接报「暂不支持」；
  `set_wallpaper_mode` 里「WPE 只在窗口模式有内容」的兜底改成「只在窗口模式或插件模式有内容」。
- **删除** `plasma_plugin.rs` 里「什么都不输出、由插件经 IPC 读设置」的语义（文件可合并进窗口后端的 Linux 部分）。

## 点 4 —— 鼠标回传（插件 → Kabegame，单向）

- **新增** `src-tauri/kabegame/src/wallpaper/pointer_socket.rs`（仅 Linux）：在 `$XDG_RUNTIME_DIR/kabegame[-dev]/wallpaper-input.sock`
  收 `SOCK_DGRAM`（一条消息一个包，不用自己分帧）；只读、从不回写。dev 与已安装版各用自己的路径（与 CEF profile 的区分方式一致），
  路径经点 2 的节点属性告诉插件。第一个壁纸流建起来时起（`ensure_started`），一条线程阻塞读到进程结束。
  （2026-11-22 实现时由 `SOCK_SEQPACKET` + `SO_PEERCRED` 改成数据报：插件只管 `sendto`，没有连接，Kabegame 重启后不用重连，
  正合「插件不读回复、没有重连状态机」；`XDG_RUNTIME_DIR` 本身 0700，别的用户本来就发不进来，不用再核 uid。）
  - 消息（小端、定长 32 字节）：
    ```text
    u16 version = 1
    u16 kind            // 1 move, 2 button, 3 leave（光标离开壁纸范围）, 4 axis（预留）
    u32 slot            // 节点属性 kabegame.wallpaper.slot
    f32 x, y            // 在插件壁纸 item 里的归一化坐标 0..1（可越界）
    u32 button          // kind = 2：变化的那个键（Linux BTN_*）
    u32 buttons         // 事件之后按着的键：bit0 左、bit1 右、bit2 中（每条都带，丢一条按键消息左键也不会一直按着）
    f32 dx, dy          // kind = 1 / 2：光标的全局逻辑坐标（屏的左上角 + 桌面窗口里的位置）；kind = 4：滚轮
    ```
    用归一化坐标：插件 item 的逻辑尺寸、缩放与离屏视图未必逐像素一致，换算只在 Kabegame 一侧做（视图尺寸 × 坐标，视图尺寸取
    runtime 新增的 `offscreen_geometry`）。
- **新增** `tauri-plugin-cursor` 的 `platform/linux.rs`：外部来源的探针，替代轮询全局光标：
  ```rust
  // 新增：Linux 没有全局光标，应用先把窗口登记成外部来源，再把插件发来的指针推给它
  pub fn register_external_pointer(label: &str);
  pub fn unregister_external_pointer(label: &str);
  pub fn push_external_pointer(label: &str, sample: Sample);
  ```
  - 登记在建流时（`WallpaperWindow::attach_stream`）、注销在窗口销毁时；没登记的窗口 `native_window` 仍是 `None`（预览照旧）；
  - 每个订阅一条样本队列：连续的同状态样本合并，按下 / 抬起 / 离开另起一项，轮询线程一轮全部交出（`Probe::has_more`），
    两轮之间的一次点击也不丢；新订阅先拿到最近一次推送；
  - `over_desktop()` 恒为真：插件只在事件到达 plasmashell 桌面窗口时才发，事件到了就说明光标下是桌面（图标上也算，同 Windows）；
  - `Sample` 加 `present`：离开后为假，`frames.rs` 发一次新的 `FrameInput::Leave`（应用映射到 `FrameMouse::Release`：补抬起与离开、
    清状态），之后再有位置照常移动，页面看到重新进入；
  - 之后的 frame 登记（垫片的 `plugin:cursor|attach_frame`）、点击规则、按下抬起配对、收尾补离开全部沿用 `frames.rs`，注入器还是
    `tauri_runtime_kbcef::frame_mouse`（点 1 核对它在离屏 browser 上可用）。
- **主窗口也跟桌面上的光标**（2026-11-22 加，同 Windows 的全局光标：图库预览里的网页 / 场景壁纸在光标落在桌面上时也跟着，钳到 frame 边上）：
  Wayland 下应用不知道自己的窗口在屏上哪里，**新增** `wallpaper/kwin_window.rs` 经 KWin 的 D-Bus 查：krunner 的窗口搜索
  （`/WindowsRunner` `org.kde.krunner1.Match "kabegame"`）拿 uuid，`org.kde.KWin.getWindowInfo(uuid)` 取框架几何（含装饰，全局逻辑坐标）、
  标题、类名、是否最小化，类名 `kabegame` 且标题等于主窗口标题的就是主窗口（记住 uuid，几何 250 ms 缓存）；消息里的全局坐标减去框架
  左上角、再扣掉装饰（框架比视图多出的宽两侧平分、下边框同侧边、其余是标题栏，尺寸差超过装饰的不认），推给主窗口的外部来源
  （socket 起来时登记）。主窗口的点击规则是「光标下是本窗口」，桌面上的光标只带移动；光标进了主窗口时插件发离开、注入停下，
  iframe 照旧直接收真实鼠标。kbcef 窗口 browser 的 `inner_size` 给的是 DIP（CEF Views `GetSize()`，类型却是 `PhysicalSize`），
  原样值与除以缩放的值都拿去匹配。
- 滚轮：`FrameInput` 现在只有移动与左键，`axis` 消息先收下丢弃，留作以后（Windows / macOS 也还没有滚轮）。
- 垫片：网页 / 场景壁纸在离屏壁纸窗口里照常判定 `interactive`，与 Windows / macOS 一致；不再需要「Linux 退回 iframe 直接收真实鼠标」
  这条特例（它只对预览生效，预览不变）。

## 点 5 —— Linux 显示器枚举（`wallpaper/screens/linux.rs`）

- **新增**：Wayland 会话用一条独立的 `wayland-client` 连接读 `wl_output`（v4 的 `name`）与 `zxdg_output_v1`（逻辑位置 / 尺寸）、缩放；
  X11 会话用 XRandR。屏的 `id` 取接口名（`DP-5`），与插件里 QML `Screen.name` 是同一个值，用来对上流。热插拔照 macOS 的 watcher：
  输出事件只负责唤醒，快照稳定 300 ms 才提交。
- 取舍：接口名换线会变，持久性不如 macOS 的 display UUID；但插件只能拿到接口名，用别的 id 还得再映射一次。
- 有了枚举，`plan_windows` 自然变成每屏一个离屏窗口、每屏一路流；`single` 可用。

## 点 6 —— 插件分发、安装与模式切换

（2026-11-22 实现时用户定：插件源码放进 Kabegame 仓库，不再由插件仓库 CI 出 zip。下面是实现后的样子。）

- **插件源码** `src-plasma-wallpaper-plugin/`（原 `.gitmodules` 里那个没检出的同名子模块条目已删）：C++ QML 模块（`StreamFinder`、
  `PointerForwarder`）+ KPackage（`metadata.json.in`、`contents/config/main.xml.in`、永不改的壳 `contents/ui/main.qml`、内容
  `contents/ui/content.qml.in`）。`PROTOCOL` 是约定版本（应用单测核对它与节点属性的版本相等），`REVISION` 是修订号：QML 模块 URI、
  `.so` 名、内容文件名都是 `KabegameWallpaperR<修订号>`，改了插件就加一。`.so` 只直接依赖 Qt Core / Gui / Qml / Quick 与 `libpipewire-0.3`。
- **构建** `deno task build:plasma-plugin`（`scripts/build-plasma-plugin.ts`）：cmake 构建、拼出 KPackage 目录
  `bin/linux/<arch>/plasma-wallpaper-plugin-build/package/org.kabegame.wallpaper`（`metadata.json` 带 `X-Kabegame-StreamProtocol`、
  `X-Kabegame-PluginRevision`、`X-Kabegame-Entry`；另存一份固定名的 `content.qml` 给壳在 `Entry` 失效时退回）。Linux standard 的
  dev / build 由 `scripts/plugins/plasma-wallpaper-plugin.ts` 拷进 resources 的 `plasma-wallpaper/`，随 deb 分发；缺产物只告警。
  不用 zip：装的时候直接拷目录。**出货构建的 Qt 下限**还没解决（用户的 Qt 不能比构建时的旧；本机 Qt 6.10，出货 guest 是 Qt 6.2），
  见「待定」1。
- **新增** `wallpaper/manager/plasma_install.rs`：
  - `PluginPackage::read`：读 `metadata.json` 的三个键，旧的 C++ / IPC 版没有，视为约定版本 0、修订 0；
  - 找已装的：照 Plasma 的顺序，用户目录（`XDG_DATA_HOME`）优先，再 `XDG_DATA_DIRS`，第一个找到的就是 plasmashell 会加载的；
  - `ensure_installed`：约定版本相同且修订号不比内置的旧就用它（新的不降级，dev 与已安装版轮流跑时不来回装）；否则把内置包拷进
    用户目录（先拷到 `plasma/` 下的临时目录、再把旧的挪开换上，不放在 `wallpapers/` 里免得被当成插件包；系统目录里别的包装的旧版
    不碰）。没有内置包（dev 没构建插件）时只能用装着的、约定版本相同的那份。不用 `kpackagetool6`：它做的也只是拷目录。
  - `available`：Plasma 6 会话（`KDE_SESSION_VERSION=6`）且有内置包或装着能用的，能力表据此列出插件模式。
- **修改** `plasma_plugin.rs`：切到插件模式（`init`）与启动对齐（`ensure_plasma_plugin_aligned`，不再先看当前插件）都先
  `ensure_installed`，再经 `evaluateScript` 把各桌面换成本插件、`General/Entry` 写成生效那份的内容文件（文件名只许字母、数字、
  `.` `_` `-`，不合规就只换插件）。值变了壳里的 `Loader` 就换到新修订，plasmashell 不用重启（2026-11-22 实测：从试验插件升到 R1、
  删掉后全新安装，plasmashell 的 PID 都没变）。
  第一次安装时 plasmashell 里若已缓存了旧版（C++ / IPC 版）同路径的 `main.qml`（旧版装在用户目录、本次会话加载过）就要重启
  plasmashell；目前只记日志，没有界面提示。
- **删除** `is_plasma_wallpaper_plugin_installed` 命令、`plasma_qdbus` 里按目录判断的 `is_kabegame_plasma_plugin_installed` 与
  `get_current_plasma_wallpaper_plugin`、`useDesktop.ts` 里的 `plasmaPluginInstalled` / `isPlasmaPluginAvailable`：前端只看能力表。
- **卸载**（用户要求）：deb 的 `src-tauri/kabegame/deb/postrm.sh` 在 `remove` / `purge` 时（`upgrade` 不动）遍历 uid ≥ 1000 的用户，
  用户目录里的插件带 `X-Kabegame-StreamProtocol` 才处理：用户登录着（有会话总线且 plasmashell 在跑）就以该用户身份经 `dbus-send`
  让 plasmashell 把用着本插件的桌面换回 `org.kde.image`（回到之前的图片），否则改 `~/.config/plasma-org.kde.plasma.desktop-appletsrc`
  里的 `wallpaperplugin=`（以该用户身份 `sed`，不改属主）；再删掉插件目录。用户自定义了 `XDG_DATA_HOME` 的装在别处，卸载找不到。
  `KABEGAME_POSTRM_DRY_RUN=1` 只打印。
- 同一个包可以另外上架 KDE Store，给不用自动安装的用户；不是本计划的必需项。

## 点 7 —— 与插件的约定（插件实现不在本计划内）

插件端要做到下面几条，其余（界面、配置页、占位画面）由插件仓库决定：

1. **发现**：C++ 模块连默认 PipeWire，监听 registry；registry 的 global 只带白名单属性（`object.serial`、`node.name`、
   `media.class` 等），自定义的 `kabegame.*` 不在里面，所以对每个 `Video/Source` 节点要 bind 后读 node info 的 props，
   收集 `kabegame.wallpaper.protocol` 存在的节点；
   选 `kabegame.wallpaper.screen` 等于自己 `Screen.name` 的，没有就选 `screen` 为空的那一路；有多个候选（dev 与已安装版都在插件模式）时
   取 `object.serial` 最大的。
2. **显示**：把选中节点的 `object.serial` 交给 `PipeWireSourceItem.nodeId`，`fd` 留 0（默认连接），`allowDmaBuf: true`，铺满；
   节点消失时清空，重新出现时再接上。**不要调 `PipeWireSourceItem.error()`**：流还没建起来时调用会让 plasmashell 段错误
   （KPipeWire 6.6.4，P0 实测）。要暂停（例如被全屏窗口挡住）时把 item 设为不可见，生产端约 20 ms 内看到流变 `paused`。
3. **鼠标**：在 plasmashell 桌面窗口（`window()`）上装事件过滤器，只看不吞（总是返回 `false`）；`MouseMove` / `MouseButtonPress` /
   `MouseButtonRelease` 落在壁纸 item 范围内时（按着键拖出范围也照发，Kabegame 要配对抬起），按点 4 的格式用 `SOCK_DGRAM` 的
   `sendto`（`MSG_DONTWAIT`）发到选中节点的 `kabegame.wallpaper.input`，`slot` 取节点的 `kabegame.wallpaper.slot`，`dx` / `dy` 填光标的
   全局逻辑坐标（`QScreen::geometry()` 左上角 + 场景坐标）；没按键时移出范围、或窗口收到 `QEvent::Leave` 时发一次 `leave`。发失败就丢弃，
   不重试、不读回复。**不要在插件里用任务管理器模型（`TaskManager.TasksModel`）**：2026-11-22 试验插件在壁纸里建了它取窗口几何，
   plasmashell 随后开始报 `QWaylandGLContext::makeCurrent: eglError 0x3006`、内核报 `nvidia-drm … invalid sync FD`，约 5 分钟后主线程
   空转卡死（D-Bus 无应答），去掉后重启 plasmashell 恢复；窗口几何改由 Kabegame 自己问 KWin。（同日 03:34 起换成不用它的 R1 后，同样的 `eglError 0x3006` 与内核 `invalid sync FD` 又出现了（在插件刚装上 / 刚加载时），所以元凶未必是它，原因未明；仍不用它，
   几何由 Kabegame 问 KWin 也更干净。见 P3 进度。）参考实现：`ignore/plasma-p0/plugin/PointerForwarder.cpp`。
4. 不连 app IPC，不读 Kabegame 的设置，不处理壁纸类型、样式与过渡。

约定的版本号是节点属性 `kabegame.wallpaper.protocol`、输入消息的 `version` 与插件 `metadata.json` 的 `X-Kabegame-StreamProtocol`；
不一致时 Kabegame 按点 6 升级插件。

## P0 结果（2026-11-21，本机：Plasma 6.6.4 Wayland、KPipeWire 6.6.4、PipeWire 1.6.2、Qt 6.10.2、RTX 4090 D + RTX 4070 驱动 580）

现场记录与试验代码在 `ignore/plasma-p0/`（`notes.md`、C 生产端 `producer/producer.c`、试验插件 `plugin/` + `package/` + `build.sh`、
cef-rs 离屏例子的改动 `cef-osr-p0.patch`）。

| 项 | 结论 |
|---|---|
| ① 离屏 dmabuf | ✅ CEF 156 在 Linux 走 `OnAcceleratedPaint`：单 plane、`BGRA_8888`、NVIDIA block-linear modifier，GPU 进程在合成器的卡上；纯 HTML / CSS 画面正确 |
| ① 离屏 WebGPU | ✅（21:34 重启后复测）合成器与 Dawn 在同一张卡上时，窗口与离屏的 WebGPU canvas 都正常；之前的花屏是双卡环境的跨卡问题，见下「双卡注意」 |
| ② 打开 windowless 的代价 | ✅ 60 Hz 屏上窗口模式 browser 的 rAF 帧率、p95 / p99 与掉帧数开关前后看不出差别（120 Hz 屏未测） |
| ③ 生产端 → 插件 | ✅ shm 与同卡 dmabuf 都通，桌面图标照常在上面；跨卡 dmabuf KPipeWire 逐个剔 modifier 后落到 shm |
| ④ 一源多消费者 | ✅ 两个 KPipeWire 消费者同时拉同一路、都走 dmabuf，生产端不重协商 |
| ⑤ 不设 `media.role` | ✅ 不触发 Plasma 的指示 |
| ⑥ 用户目录 / 新 `.so` / 不重启升级 | ✅ 用户目录覆盖系统目录；不同 URI 的 `.so` 同进程共存；壳 + `Entry` 换内容文件不重启生效（同路径 QML 有缓存，见点 6） |
| ⑦ 消费者可见性 | ✅ item 不可见约 20 ms 内生产端 `paused`，可见后 `streaming`；普通窗口遮挡不改变可见性 |
| ⑧ 补丁 11 在 windowless 上 | ✅ 换算与注入都正常（可信事件、`:hover`、点击配对、离开），只进 iframe、父页收不到。两个前提：客户端声明实验版 API（`CEF_API_VERSION`，runtime 已是）；只对跨站点的 OOPIF 生效，同站点同进程的 iframe 换算直接失败（壁纸页是应用页套 `file:`，天然满足） |

**双卡注意**（与本计划的插件方案无关，Linux 的场景预览同样受影响）：
- 合成器（KWin）在一张卡、Dawn 默认挑了另一张（第一张）时，WebGPU canvas 跨卡共享 → 花屏（未初始化显存）。普通窗口、离屏、系统 Google Chrome 154 都一样；
  用户在应用里打开场景预览报 WebGPU 初始化失败。
- 本机重启后 KWin 改到 4090 D（与 Dawn 选的同一张），窗口与离屏的 WebGPU canvas 都恢复正常，场景预览也恢复。
- 用 `MESA_VK_DEVICE_SELECT` 只露出合成器那张卡不行（canvas 全黑、`Error creating wgpu::Texture`），不能拿它当修法。
- 以后可另起一项：双卡时让 Dawn 跟着合成器的卡走，或在应用里认出这种环境并提示；离屏推流本身同样要求 CEF、EGL 拷贝、PipeWire 消费者三方在同一张卡（点 2）。

## P1 进度（2026-11-21）

已完成（P1a：软件绘制 + 共享内存，本机真机联调通过，回归见 `versions/latest/regression.md`「Linux 插件模式：离屏渲染 + PipeWire 推流（P1）」）：

- 点 1：`tauri-runtime-kbcef/src/offscreen.rs` + runtime / webview 的离屏分支；登记时宽高为 0 由 runtime 换成 CEF 主显示器（`OffscreenGeometry::or_primary_display`）。
- 点 2：`wallpaper/pipewire_stream.rs`（P1b 起是 `wallpaper/pipewire/stream.rs`；底层 FFI + `pw_thread_loop`；BGRA、memfd、本流做驱动、帧尺寸变了重新宣告格式）。
  **新增心跳**：推流中超过 1 s 没有新帧就调 `on_idle` 请离屏 browser 整帧重画（`invalidate`）。静态页面不出帧，后连上的消费者
  （另一块屏上的插件实例、调试抓帧）在页面下一次变化之前拿不到画面——新链接不会让流的状态变化，状态回调里的那次重画只管第一个消费者。
- 点 3：`WindowWallpaperManager` 在 Linux 编译、构造时带所属壁纸模式；`PlasmaPluginWallpaperManager` 包一层；常量 `RENDERED_WALLPAPER_MODE`
  统一「壁纸窗口渲染」的判断（WPE 能否设为桌面、窗口布置、屏幕变化后对齐、轮播能否选 WPE）；前端 `WallpaperWindow.vue` 读样式 / 过渡的模式、
  设置页的「暂停」可见性同步改。
- 五类壁纸（图片、视频、网页、场景、WPE 视频）显示与淡入过渡正常；切原生再切回，节点与线程清干净、重新建起。

联调中修掉的共用组件问题（与插件模式无关，Windows / macOS 窗口模式同样受影响）：`Wallpaper.vue` 每层加 `isolation: isolate`（旧层不成层叠上下文时，
层里 `z-2` 的图盖在淡入中的新层之上，淡入 / 缩放整段看不到）；`ImageContent` 壁纸变体的图片 `decode()` 完再报 ready。

**新发现：Wayland 下离屏 browser 的设备缩放恒为 1。** CEF OSR 的 `GetScreenInfo` 拿到了 1.45，但 Chromium
`RenderWidgetHostViewBase::UpdateScreenInfo`（`content/browser/renderer_host/render_widget_host_view_base.cc`）在 Ozone 平台
`supports_per_window_scaling` 为真时（Wayland 且合成器支持 viewporter，`WaylandConnection::UsePerSurfaceScaling`）改用
`Screen::GetPreferredScaleFactorForView(GetNativeView())`；离屏 view 的 `GetNativeView()` 为空，`value_or(1.0f)`。结果 1.45 缩放的 4K 屏按
2648×1490 出帧、插件放大显示。不改 Chromium 绕不过去：页面缩放按 host 存（壁纸页与主窗口同 host，会连带主窗口），`--force-device-scale-factor`
是进程级，切 X11 会影响主窗口。**修法（2026-11-21 定）**：CEF 补丁 12（`third-patches/cef/12-osr-device-scale.patch`，Chromium 侧
`kabegame_osr_device_scale.patch`）——只在 `GetNativeView()` 非空时套用窗口缩放，离屏 view 保留 `GetScreenInfo` 给的缩放；只改一个 `.cc`，
增量重编。子 frame（OOPIF）的 `UpdateScreenInfo` 直接取父 view 的屏幕信息，随之一起正确。2026-11-22 重编后验证：流 3840×2161、
壁纸页 DPR 1.45、场景宿主渲染目标 3840×2161，主窗口不受影响（回归 PP10）。重编时注意 depot_tools 自更新可能卡在网络上，增量构建带
`DEPOT_TOOLS_UPDATE=0`。

**P1b dmabuf（2026-11-22 完成）**：模块按点 2 拆成 `wallpaper/pipewire/{stream,gpu,device}.rs`（共享内存池没单拆 `shm.rs`，留在 `stream.rs`）。
- `device.rs`：Wayland 单独连一次合成器，读 `zwp_linux_dmabuf_v1` v4 默认 feedback 的 `main_device`，按 sysfs 的 `device` 链接映射到
  render node；X11 不找（走软件绘制 + 共享内存）；`KABEGAME_PIPEWIRE_RENDER_NODE` 可指定或设 `none`。
- `gpu.rs`：运行时 `dlopen` `libEGL.so.1` / `libGLESv2.so.2` / `libgbm.so.1`（不在编译期链接：装不上就退回共享内存；CEF 自带的 ANGLE 也叫
  `libEGL.so`，链接期依赖易混）。全进程一个 EGL（GBM 平台）+ GLES2 上下文，持锁、设为当前、用完还原调用线程原来的当前上下文
  （帧回调在 CEF UI 线程、建删缓冲在 PipeWire 线程）。CEF 的 dmabuf 每帧导入成 `GL_TEXTURE_EXTERNAL_OES`，全屏四边形画进 GBM 缓冲的
  FBO（纹理坐标必须 highp，4K 下 mediump 会取错像素），`glFinish` 后入队；只收共享内存的消费者用 RGBA8 FBO + 片元里交换 r / b +
  `glReadPixels`。
- `stream.rs`：宣告「定好的 dmabuf（有时）→ modifier 列表（`MANDATORY | DONT_FIXATE`）→ 共享内存」；消费者交回候选时 GBM 试分配挑一个、
  定型后放最前面重新宣告（同 P0）；挑不出就撤掉 dmabuf；共享纹理下若收到软件绘制的帧（GPU 合成退回软件）也撤掉 dmabuf。
- 实测（本机）：定型 NVIDIA block-linear `0x300000000e08014`、1 个 plane；4K 视频每帧拷贝平均 1.1 ms、最长 3 ms；读回路径平均 6–8 ms
  （同步 `glReadPixels`，只有不收 dmabuf 的消费者走，以后要用再改 PBO 异步）；颜色、方向与页面截图一致；插件不再拉流时离屏 browser 停帧。
- 验证工具：KPipeWire 的 `PipeWireSourceItem` + `grabToImage` 写的 QML 消费者 `ignore/plasma-p0/tools/qmlgrab.qml`
  （`/usr/lib/qt6/bin/qml qmlgrab.qml -- <object.serial> <out.png> [ms]`；gst 的 `pipewiresrc` 收不了 NVIDIA 的 tiled dmabuf，
  且同一节点的所有链接共用一个格式，plasmashell 定型 dmabuf 后 gst 连不上）。

未做：样式（适应 / 居中 / 平铺）、X11 会话、`KABEGAME_PIPEWIRE_RENDER_NODE=none` 的真机验证；CEF 的 dmabuf 每帧重新导入（可按 dma-buf
inode 缓存 `EGLImage`，目前 1.1 ms 不急）。

## P2 进度（2026-11-22）

Kabegame 一侧按点 4 完成（实现时的两处改动已写回点 4：数据报代替 `SOCK_SEQPACKET`、消息带按键全集）：
- `tauri-plugin-cursor`：`platform/linux.rs` 外部来源探针、`Sample::present`、`Probe::has_more`、`FrameInput::Leave`；
- `tauri-runtime-kbcef`：`offscreen_geometry(label)`；
- `kabegame`：`wallpaper/pointer_socket.rs`，建流时填 `kabegame.wallpaper.input` 并登记外部来源，窗口销毁时注销；注入器把 `Leave` 映射成
  `FrameMouse::Release`；前端 `framePointer.ts` 只改说明（`NATIVE_FRAME_POINTER` 仍只管预览，离屏 browser 收不到真实鼠标，
  壁纸窗口里 iframe 的 `pointer-events` 不影响注入）。

插件一侧（参考实现，插件仓库照它做）：P0 试验插件加 `PointerForwarder`（`ignore/plasma-p0/plugin/`），装成 `KabegameP2V1`，
经 `evaluateScript` 改 `General/Entry` 换内容文件、不重启 plasmashell。

验证：模拟插件从 Python 往 socket 发消息，网页壁纸 iframe 收到可信的移动 / 按下 / 抬起 / 点击、离开与重新进入，坐标按视图换算正确，
同一轮里的按下抬起不丢（回归 PM2）；用户真鼠标在桌面上试过网页与场景壁纸，响应正常。

主窗口跟桌面上的光标（同日，用户要求）：经 KWin 查主窗口位置（见点 4）。中途一版试验插件在 plasmashell 里用任务管理器模型取窗口几何，
plasmashell 卡死（见点 7），改成现在的做法；模拟消息验证预览里的网页壁纸在光标位于主窗口左侧 / 上方时钳在左边 / 上边、桌面上的点击
不进主窗口、离开时收到 `mouseout`（回归 PM8）；用户真鼠标确认主窗口预览跟着桌面上的光标（回归 PM9）。

## P3 进度（2026-11-22）

按点 6 完成（源码放进仓库、目录形态的内置包、卸载由用户追加）。实测（本机 dev）：
- 从试验插件 P2V4（没有修订号，视为 0）升级：关开一次壁纸，装上 R1、`Entry` 改成 `KabegameWallpaperR1.qml`，plasmashell（PID 不变）
  当场加载 R1、接上节点、dmabuf 推流；
- 卸载逻辑：以当前用户跑 `postrm` 的删除函数，桌面换回 `org.kde.image`（之前的图片），插件目录删掉、别的壁纸插件不动；没登录的
  用户改配置文件（假的家目录验证：只换完全相同的插件 id）；
- 删掉后再关开一次壁纸：全新安装 R1，照常出画。

**plasmashell 的 GL 报错又出现了**：R1 装上（03:32 升级、03:33 删掉后重装）之后，03:34 起 plasmashell 又开始报
`QWaylandGLContext::makeCurrent: eglError 0x3006` / `Failed to start frame`（约 5 s 一次，同一个上下文），内核在 03:33:10（插件加载）与
03:34:00 各报一次 `nvidia-drm … invalid sync FD: 0`；R1 不用任务管理器模型，所以 P2 时把卡死归到它身上不成立。plasmashell 这次没卡住
（D-Bus 正常、主线程 CPU 正常），推流也正常。两次的共同点是插件内容在运行中的 plasmashell 里被重新加载（换 `Entry`、换插件再换回），
怀疑与 KPipeWire 在 NVIDIA 上导入 dmabuf / 卸掉旧的 `PipeWireSourceItem` 有关，但同样的换 `Entry` 在 02:43、03:13 没出事，没坐实。
要另起一项查（对照 `allowDmaBuf: false`、反复换 `Entry`、看是哪个窗口的上下文）。

没做：出货构建的 Qt 下限（「待定」1）；旧版插件缓存要重启 plasmashell 时的界面提示；能力表在 Plasma 6 会话下但没有内置包也没装时
不列插件模式（与以前「装了才列」一致）。

## 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0 验证 | ① CEF 156 在 Linux（Wayland 会话）windowless + `shared_texture_enabled` 能否走 `OnAcceleratedPaint`，NVIDIA 与 Mesa 各一台，WebGPU 场景宿主在离屏下能否渲染；② 打开 `windowless_rendering_enabled` 后主窗口的帧时间；③ 最小 Rust 生产者 + 最小插件在 plasmashell 里显示测试图案，dmabuf 与共享内存各一次，X11 会话一次；④ `object.serial` 作 `nodeId`、`fd = 0`、一个源被多块屏的插件同时拉流；⑤ 没有 `media.role` 的 `Video/Source` 不触发 Plasma 的指示；⑥ 用户目录的插件覆盖系统目录的，包内相对导入的 `.so` 能加载，换版本号的 `.so` 能否不重启生效；⑦ 消费者不可见时生产者能否看到状态变化；⑧ 补丁 11 的 frame 注入在 windowless browser 上可用 | 每项有结论，不行的给替代方案并改本计划 |
| P1 单路流 | 点 1、点 2、点 3（不含 `single`）：没有屏幕信息，一个离屏窗口、一路流，各屏插件拉同一路；五类壁纸显示与过渡正常 | 本机 KDE Wayland 上五类壁纸显示正确；dmabuf 与强制共享内存两条路都通；插件不可见时离屏 browser 停帧 |
| P2 鼠标 | 点 4 与插件侧的事件过滤（插件仓库同步做） | 网页壁纸跟随光标、点击生效；在桌面图标上点击、桌面右键菜单照常；光标进出其它应用窗口时页面收到离开 |
| P3 安装与切换 | 点 6，能力表与前端入口，`REQUIRES_PLUGIN_MODE` 对 WPE 生效 | 删掉插件后在设置里切到插件模式能自动装上并显示；从旧 deb 版升级可用；切回原生模式恢复 `org.kde.image` |
| P4 每屏 | 点 5，每屏一路流，`single` 可用，热插拔 | 双屏（或虚拟输出）各自显示自己的目标、鼠标各自对得上；插拔后流与插件对得上 |
| P5 收尾 | `cocs/wallpaper/PLASMA_PIPEWIRE.md` 与 `cocs/README.md` 索引、`AGENTS.md`（进程模型、平台说明、`tauri-plugin-cursor` 一行）、`cocs/wallpaper/MULTI_SCREEN.md` 与 `cocs/wpe/WPE_IMPORT.md`「鼠标」的 Linux 部分、回归文档与 changelog | 文档与实现一致 |

## 不做（本计划之外）

- GNOME（Mutter 没有 layer-shell，也没有可放流的桌面插件机制；waywallen 是用 Shell 扩展做的，以后另起）。
- 键盘输入、滚轮（消息里预留了 `axis`）。
- 被全屏 / 最大化窗口挡住时自动暂停（Windows / macOS 也没有；waywallen 的插件用 `TaskManager.TasksModel` 上报，以后要做可照它加一种消息）。
- Linux 的音频频谱采集（PipeWire / PulseAudio 的 monitor 源，可另起一项，与显示无关）。
- 插件端的界面与配置页。

## 已否决的方案

- **KWin 脚本把普通窗口置底**（2026-11-21 实测，KWin 6.6.4）：`keepBelow` / `noBorder` / `skip*` / `onAllDesktops` / 铺满都能设，「显示桌面」不会藏它；
  但窗口在 BelowLayer（layer 1），plasmashell 桌面在 layer 0，会盖住桌面图标和桌面右键菜单。
- **wlr-layer-shell（linux-wallpaperengine 的 Wayland 做法）**：Chromium Ozone Wayland 只建 `xdg_toplevel`，要改 Chromium；BOTTOM 层同样盖住图标，
  BACKGROUND 层会被 plasmashell 不透明的壁纸挡住。
- **X11 根窗口 pixmap（linux-wallpaperengine 的 X11 做法）**：每帧 CPU 读回，桌面环境自己画背景时看不见。
- **照 waywallen 自定帧协议（dmabuf fd 经 `SCM_RIGHTS` + 显式同步）**：同步更精确，但插件要自己导入 dmabuf、自己做共享内存兜底；
  PipeWire 已有这些，插件只用 KPipeWire 的现成 item。
- **插件里用任务管理器模型取 Kabegame 的窗口几何**（2026-11-22 试过）：之后 plasmashell 的 GL 上下文开始报错、几分钟后主线程卡死
  （见点 7；后来不用它也出现过同样的报错，元凶未必是它）；改由 Kabegame 经 KWin 的 D-Bus 自己查（`wallpaper/kwin_window.rs`）。
- **纯 QML 插件**：发现节点只能靠 `MediaMonitor`（要给流设 `media.role`，还拿不到自定义属性），也没法装窗口事件过滤器、开 Unix socket，
  鼠标做不了。

## 待定

1. 插件 C++ 模块的构建机：要 Qt 6.6 的头文件（用户的 Qt 不能比构建时的旧），又要 glibc 地板够低。本仓库的 Linux 出货 guest 是
   Ubuntu 22.04（只有 Qt 6.2），本机是 Qt 6.10（只适合开发）。可以给 `build:plasma-plugin` 加一个容器构建（带 Qt 6.6 的镜像），或 22.04 +
   aqtinstall 的 Qt 6.6（waywallen-display 另有 `glibc-2.17.h` 压符号版本的做法）。
2. GPU 拷贝用 GLES 还是 Vulkan（倾向 GLES：导入 dmabuf 与 GBM 分配都现成，代码量小）；多显卡时 render node 怎么与 CEF GPU 进程对齐。
3. Plasma 5 是否支持（倾向不支持：插件按 Plasma 6 API 写）。
