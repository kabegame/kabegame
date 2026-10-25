# Windows 窗口壁纸挂载

Windows 标准版的窗口壁纸由 `tauri-plugin-wemt` 挂到 Explorer 的背景 `WorkerW`。壁纸页面（`index.html?window=wallpaper`，根组件 `WallpaperWindow.vue`）仍由 `WindowWallpaperManager` 按需创建，等页面 ready 后挂载，离开窗口壁纸模式时先解绑再销毁。主程序保留 CEF 窗口与页面生命周期，插件只处理桌面宿主、父子关系、窗口样式、位置及状态。

## WPE 证据与实现边界

本机 Wallpaper Engine 2.8.0.42 的 `wallpaper64.exe` SHA-256 为 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`。REA 静态证据 `ev_98646988f59bc6e9d8dc6a5f0ff9cf811e579189b8a41df17f008a0553c6c1ac` 显示：桌面准备函数查找 `Progman`，按条件发送 `0x52c`（新桌面分支参数 `0xd,1`），枚举并重试查找 `WorkerW`，设置 `WallpaperEngineParent`。运行时切换壁纸记录显示：主渲染窗口创建时已经是 WorkerW 子窗口，不经过临时容器的 `0x404` 路径。报告见 [step3-callchain-report-20261025.md](../../src-tauri/tauri-plugin-wemt/step3-callchain-report-20261025.md)。

Tauri/CEF 的窗口先由应用创建，再由插件转成 `WS_CHILD` 并 `SetParent` 到 WorkerW；这与 WPE 主窗口最终层级一致，但创建顺序不同。插件使用自己的 `WemtHost` 属性，不占用 WE 的标记。宿主选择优先 `Progman` 直属、无图标视图子窗口的整屏 WorkerW；若尚未创建则发送 `0x52c` 并有界重试。子窗口位置用 `MapWindowPoints` 转为宿主客户区坐标。

## 为什么移除 Z-order 修正

旧 Win11 实现把壁纸窗口挂在 `Progman`，与 `SHELLDLL_DefView` 同为子窗口，再在挂载、主窗口隐藏/最小化和壁纸点击时反复调整两个窗口的先后。新层级为 `Progman → WorkerW → 壁纸窗口`，图标层与壁纸不再是同父兄弟；旧修正既不适用，也会额外改变 Explorer 图标层。Linux/macOS/Android 的其它壁纸路径不受此 Windows 挂载变化影响。

## 尚待真机确认

- CEF 壁纸窗口在 `show()` 后的实际父 HWND、样式、像素尺寸、可见性及图标遮挡关系。
- 点击桌面、主窗口最小化/隐藏/恢复、Win+D 后，无 Z-order 修正也保持图标在上。
- 多显示器、负坐标与不同 DPI、分辨率变化时的位置与尺寸。
- Explorer 重启后的宿主失效与恢复；当前插件提供 `refresh`，尚无自动重挂。
- WPE 会改写宿主扩展样式；插件当前使用现有 WorkerW 的样式，未改写 Explorer 窗口以避免影响其它桌面组件。

运行时观测 IPC/事件/加载次数仍用 [DEBUG_INGEST.md](../debug/DEBUG_INGEST.md)；窗口层级可由只读 Win32 枚举核对。
