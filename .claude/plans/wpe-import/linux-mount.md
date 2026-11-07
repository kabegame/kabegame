# Linux 壁纸挂载调研：linux-wallpaperengine（LWE）

> 状态：调研结论，未排期（2026-11-07）
>
> 依据：本地源码 `ignore/linux-wallpaperengine`（提交 `a0ddce5`，2026-10-30），只读了代码，没有在 Linux 上实跑。
> 下文 LWE 的路径都相对 `ignore/linux-wallpaperengine/src/WallpaperEngine/`。`ignore/` 不进 git，行号以这个提交为准。

## 结论

LWE 没有统一的挂载机制。启动时按 `XDG_SESSION_TYPE` 选后端（`Application/WallpaperApplication.cpp:667`，变量缺失时直接报错）：

- **X11**：不放窗口，把每帧画面写进根窗口背景。
- **Wayland**：用 `wlr-layer-shell` 给每个显示器建一个壁纸层 surface。

源码里没有 GNOME 或 KDE 的专门处理。

这两条路都不能直接搬到 Kabegame：LWE 自己掌握 GL 和 surface，我们的画面在 CEF 里。如果以后做 Linux 窗口壁纸，建议只做 Wayland layer-shell，
写 CEF 补丁，覆盖 Hyprland、Sway 这类合成器；GNOME 继续走原生壁纸，KDE 已有 Plasma 插件。

## X11：写根窗口背景

1. 建一个隐藏的 GLFW 窗口（`GLFW_VISIBLE` 为 false，`Render/Drivers/GLFWOpenGLDriver.cpp:34`），只用来拿 GL 上下文。
2. 建一张根窗口大小的 pixmap，设成根窗口背景（`Render/Drivers/Output/X11Output.cpp:207`）。
3. 每帧把所有屏幕按 XRandR 的位置画进同一块帧缓冲，再用 `glReadnPixels` 读回内存（`GLFWOpenGLDriver.cpp:117-135`）。
4. `XPutImage` 写进 pixmap，更新两个根窗口属性，再清根窗口触发刷新（`X11Output.cpp:226`）：

```cpp
XPutImage (m_display, m_pixmap, m_gc, m_image, 0, 0, 0, 0, m_fullWidth, m_fullHeight);
// _XROOTPMAP_ID 与 ESETROOT_PMAP_ID 让合成器等程序知道背景换了（原注释：实测 picom）
XChangeProperty (m_display, m_root, prop_root, XA_PIXMAP, 32, PropModeReplace, (unsigned char*)&m_pixmap, 1);
XChangeProperty (m_display, m_root, prop_esetroot, XA_PIXMAP, 32, PropModeReplace, (unsigned char*)&m_pixmap, 1);
XClearWindow (m_display, m_root);
```

- **开销**：每帧都经 CPU 读回，没用 PBO 或 MIT-SHM。缓冲是整个根窗口大小，单块 4K 屏每帧约 33 MB。
- **限制**：根窗口被盖住就看不到。README 写明，GNOME、KDE、Nautilus 或合成器在画背景时不能用，只能关掉合成器；代码注释说 picom 能显示。
- **全屏暂停**：遍历根窗口的子窗口，比对位置和尺寸是否等于某块屏幕（`Render/Drivers/Detectors/X11FullScreenDetector.cpp:86`）。

## Wayland：每个显示器一个 layer surface

不用 GLFW，直接用 `wl_display` + EGL（`Render/Drivers/WaylandOpenGLDriver.cpp`）。

1. 绑定 `zwlr_layer_shell_v1`，合成器没有这个协议就报错（`WaylandOpenGLDriver.cpp:290`）。`xdg-output` 是可选的，只有跨屏壁纸要用它取准确位置。
2. 给命令行选中的每个显示器建一个 layer surface（`Render/Drivers/Output/WaylandOutputViewport.cpp:163`）：

```cpp
zwlr_layer_surface_v1_set_size (layerSurface, 0, 0);                  // 0×0 + 四边锚定：由合成器给满屏尺寸
zwlr_layer_surface_v1_set_anchor (layerSurface, RIGHT | LEFT | TOP | BOTTOM);
zwlr_layer_surface_v1_set_keyboard_interactivity (layerSurface, false);
zwlr_layer_surface_v1_set_exclusive_zone (layerSurface, -1);          // 不避让面板
wl_surface_set_input_region (surface, region);                        // 开鼠标时全屏，否则为空
```

3. 不透明区域设为全屏，合成器可以跳过下面的内容。
4. 图层默认 `bottom`，`--layer` 可改成 `background`、`top`、`overlay`。参数说明提到，niri 要用 `background` 配 `place-within-backdrop`，否则概览里每个工作区都会复制一份壁纸。
5. 先空提交并等 configure 拿到尺寸，再建 `wl_egl_window` 和 EGL surface。
6. 帧节奏靠 `wl_surface_frame` 回调，并设 `eglSwapInterval(0)`，避免每帧等两次 vblank（`WaylandOutputViewport.cpp:248`、`:269`）。没有 surface 在画时，事件循环会阻塞在 `wl_display_dispatch`（`WaylandOpenGLDriver.cpp:411` 的注释）。

GPU 直接出图，没有读回。

- **鼠标**：指针事件直接进 layer surface。指针不在壁纸上时，只有 Hyprland 能经 socket 发 `j/cursorpos` 查全局坐标（`Input/Drivers/WaylandMouseInput.cpp:109`）。
- **全屏暂停**：用 `wlr-foreign-toplevel-management`（`Render/Drivers/Detectors/WaylandFullScreenDetector.cpp`）。
- **缺口**：
  - 显示器移除还是 TODO（`WaylandOpenGLDriver.cpp:131`）。
  - 合成器关闭 surface 后只释放，不重建（`WaylandOpenGLDriver.cpp:234`）。
  - 只用 `wl_output.scale`，所以只有整数缩放。

## 各桌面的结果

| 环境 | 结果 |
| --- | --- |
| Hyprland、Sway、niri 等 Wayland 合成器 | 可用 |
| KDE Wayland | 协议可用，源码没有专门适配 |
| GNOME Wayland | Mutter 不支持 layer-shell，启动报错 |
| X11 + GNOME / KDE | 显示不出来 |
| X11 + 轻量窗口管理器 | 可用（picom 有代码注释佐证） |

Sway、KWin 和 Mutter 的协议支持情况是已知信息，不在 LWE 源码里，实施前要在目标环境确认。

## 对 Kabegame 的意义

**现状**

- Linux 没有窗口壁纸模式，`WindowWallpaperManager` 只在 Windows / macOS 编译（`src-tauri/kabegame/src/wallpaper/manager/mod.rs:6`）。Linux 只有原生壁纸（GNOME、Plasma）和 Plasma 插件。
- CEF 在 Wayland 会话下跑原生 Wayland，否则跑 X11（`src-tauri/tauri-runtime-kbcef/src/runtime.rs:270` 的 `linux_ozone_platform`）。

**Wayland 要改 CEF**

本机 Chromium（`D:\Codes\cefbuild\chromium_git\chromium\src`）的 `ui/ozone/platform/wayland` 和 `third_party/wayland-protocols/BUILD.gn` 都搜不到 layer-shell，
顶层窗口建的是 `xdg_toplevel`（`ui/ozone/platform/wayland/host/xdg_toplevel.cc:104`）。layer surface 是另一种窗口角色，要在 Chromium 里加协议和窗口类型，走 `third-patches/cef`。

**X11 不值得做**

要每帧从 CEF 取像素再写 pixmap，开销大，而且 GNOME、KDE 上还是看不到，这正是主要的桌面。

**建议**

如果做 Linux 窗口壁纸，只做 Wayland layer-shell。它也是 `.claude/plans/wallpaper-multiscreen-manager.md:283` 里挂着的后续项。

**还没评估**

- CEF 补丁的工作量。
- 不改 Chromium 的替代路线：CEF 离屏渲染，由应用自建 layer surface 出图。
- 场景壁纸另外依赖 Linux CEF 的 WebGPU，未启用时会退回预览图（`cocs/wpe/WPE_IMPORT.md`），这点与挂载无关，要单独确认。
