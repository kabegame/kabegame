# tauri-plugin-wemt：实现目标与调查计划

目标：用 Rust 编写面向 Tauri 2.12 的 Windows 桌面壁纸挂载插件，尽量复现当前 Wallpaper Engine 2.8.0.42 的可观察挂载行为。

项目路径：D:\Codes\tauri-plugin-wemt
状态：已完成 REA 第一步（模块定位）、第二步（候选函数定位）、第三步（挂载调用链）、两轮运行时观测（只读层级 + 注入式消息/窗口观测），以及插件 crate 骨架（平台层 + Tauri 2.12 命令层，编译通过）。报告：step1/step2（C:\Users\Lenovo\we-rea-analysis）、step3-callchain-report-20261025.md；插件代码见 src/ 与 README.md。
Tauri 版本要求来自用户。实际编译时应核验并锁定 tauri 2.12.x，不能只测试其他 Tauri 2 版本后宣称兼容。

## 实现边界

- 第一目标是把应用自己的 Tauri Window/WebviewWindow 挂到桌面图标层后方。
- 提供 Rust 接口，以及受 Tauri capability/permission 控制的前端命令与 TypeScript 类型。
- 负责发现桌面宿主、设置/恢复窗口父子关系和样式、布局、状态报告与恢复。
- 渲染内容由应用提供，插件独立运行，不依赖已安装 WE。
- 普通 Tauri WebView 挂载是首要路径；WE 的 Unity/外部 EXE 嵌入分支单独分类，不能直接当作 Tauri 挂载实现。
- 非 Windows 平台应有明确的 unsupported 行为；当前调查没有为其他系统建立同等行为证据。

## 已确认的 WE 静态证据

目标 SHA-256：40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0

| 地址 | 行为 |
|---|---|
| 0x14003c840 | 查找 Progman，条件性发送 0x52c，查找 WorkerW，保存候选父 HWND 并设置 WallpaperEngineParent 属性 |
| 0x14003c760 | 枚举 WorkerW，查找 SHELLDLL_DefView，并选择后续的 WorkerW |
| 0x1401287a0 | 消息 0x404 分支将传入窗口挂到对象 +0x188 的宿主 HWND；有 Unity 特殊分支 |
| 0x140127d00 | SetParent(hwnd,NULL) 并关闭/清理窗口 |
| 0x14001eae0 | 注册 TaskbarCreated，创建 WPEEventWindow，并调用桌面发现函数 |

限制：这些是静态反编译观察，还没有完成“桌面父窗口 → Tauri 对应渲染窗口”的全链验证，也没有运行验证。

原始调查资料位于 C:\Users\Lenovo\we-rea-analysis：
- step1-module-report-20261025.md
- step2-function-report-20261025.md
- step2-rea-evidence-20261025.json
- step2-wallpaper64-snapshot-20261025.json

核心证据：
- 桌面准备：ev_98646988f59bc6e9d8dc6a5f0ff9cf811e579189b8a41df17f008a0553c6c1ac
- 桌面枚举：ev_bd72bcfd192653ff0c29609c4ec1ee244a66483bfb8c0919640d4fb5254582c2
- 条件挂载：ev_9ba92a73d283f70091e1b317f21e28cebedc877317ce686d0211746a807f809f

## 第三步进展（2026-10-25）

完整报告见 step3-callchain-report-20261025.md。

已闭环：
1. DAT_1404e52a0 的 32 处引用归入 6 个函数；唯一生产者 0x14003c840，事件窗口过程内的第二写入点 0x140022187。
2. 挂载协议：容器窗口过程 0x1401287a0 的 0x404 分支完成"样式改写(WS_CHILD) → 宿主定位 → SetParent → 子窗口 0,0 尺寸同步"；Unity 分支不 SetParent，只在已是宿主子窗口时同步尺寸。
3. 宿主校验与失效清理：FUN_14003cb30 / 0x14003cb80（属性 WallpaperEngineParent + IsWindow + ShowWindow + 校验失败清空全局）。
4. TaskbarCreated：DAT_1404e80f8 在事件窗口过程中比较，随后再次调用 0x14003c840 重新发现。
5. 排除项：0x140068fc0 是预览/缩略图渲染，不是容器创建者。

运行时第一轮（只读）已确认：Progman → WorkerW（explorer 持有，WallpaperEngineParent=1）→ WPEDesktopDX11Window（wallpaper64.exe 持有，WallpaperEngineWallpaper=1，style 0x50000000）；全局值 DAT_1404e52a0=0xE05D0、DAT_1404e5298=DefView、DAT_1404e5290=11。详见 step3 报告第 8 节。

运行时第二轮（注入观测，切换壁纸）已确认：0x404 由 FUN_140125440（+0x1262A1）用 PostMessageW 发出、由 FUN_1401287a0 接收；容器由 FUN_140126830（+0x126D85，同时打 WallpaperEngineWallpaper 属性）创建，渲染窗口由 FUN_140110630（+0x110775）以 hWndParent=WorkerW 直接创建；销毁 FUN_1401276E0、解绑 FUN_140127D00。该 0x404 容器为临时窗口（数秒内销毁），桌面主窗口不走 0x404。DPI 实测：3840×2160 @150%，WE 全程物理像素。详见 step3 报告第 9 节。

未闭环：TaskbarCreated 重建的完整顺序；多显示器/混合 DPI；Unity 外部程序嵌入全链。

## 第三步：为实现补齐调用链（原始清单，保留）

1. 追踪 DAT_1404e52a0 的消费者，找到普通渲染窗口通过 CreateWindowExW 或其他方式建立父子关系的路径。
2. 追踪 0x1401287a0 中对象 +0x188 的来源，明确外部程序嵌入路径与普通壁纸路径的关系。
3. 查明 DAT_1404e5290 的赋值和版本分支，避免凭数值猜测 Windows 版本。
4. 追踪 TaskbarCreated 的实际消息处理、宿主失效检测及重建策略。
5. 提取窗口样式、Z 序、位置/尺寸、坐标转换、输入/激活行为、失败返回与重试条件。

输出应为行为规格和调用链；对每项区分已观察、推断和未知。

## 拟定插件结构（已实现为 crate 骨架）

- Windows 核心：发现宿主、执行挂载、布局、解绑恢复、错误与诊断。→ `src/platform/windows.rs`
- Tauri 适配：窗口句柄获取、线程调度、生命周期接入、命令权限。→ `src/commands.rs`、`src/lib.rs`、`permissions/`
- 接口草案：attach、detach、status、refresh；参数和 Rust 签名待调用链和 Tauri API 验证后确定。→ 已固化为 `wemt_attach / wemt_detach / wemt_status / wemt_refresh`
- 每个挂载窗口保存原 parent/owner、style、ex_style、位置及必要状态；失败回滚与重复调用应有定义。→ `WindowSnapshot` + `WemtState`，重复 attach 幂等
- Explorer 重建不能依赖永久有效的 HWND，应重新发现并处理窗口已被销毁的情况。→ `is_host_valid` + `wemt_refresh`
- 状态应区分未挂载、挂载成功、待恢复和失败，避免仅凭 API 调用返回就报告长期正常。→ `MountState::{Detached,Attached,HostLost,Failed}`
- 编译验证：`cargo check --no-default-features` 与 `cargo check`（tauri 2.12.0）均通过；见 README「构建」。
- 有意差异：使用自有属性 `WemtHost`（不冒用 `WallpaperEngineParent`），不实现 0x404 内部容器协议（运行时证实桌面主窗口创建时即 parent=host）。

## 验证要求

- 编译并测试 Tauri 2.12 集成示例；验证插件权限及 TypeScript 接口。
- 验证 GetParent、窗口样式、物理坐标、可见性和实际桌面层级。
- 单显示器、多显示器、负坐标、不同缩放比例及显示配置变化。
- 重复挂载/解绑、失败回滚、应用关闭、宿主失效。
- Explorer 重启恢复属于需受控执行的测试，不因静态发现 TaskbarCreated 就判定通过。
- Windows 10 / 11 或其他版本支持以实际验证范围标注，不宣称未经测试的全面兼容。

## 官方实现参考

- Tauri 插件结构与权限：https://tauri.app/develop/plugins/
- Tauri WebviewWindow API：https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html
- Microsoft SetParent：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent

SetParent 不自动修改 WS_CHILD/WS_POPUP，跨进程 DPI awareness 也可能影响行为；必须结合 Tauri/WebView2 实测，不能机械照抄 WE 的样式常量。
