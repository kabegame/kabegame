> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。P6c 步骤 0c 实测核对后以报告为准。范围是 exe 侧：光标输入从哪来、光标位置、命中测试、回调派发与时序、`input.*` 的数据来源；`scenescript64.dll` 侧（`CursorEvent` 怎么构造、`input` 对象、`solid` 的脚本读写、`cursorHitTest` 返回值）见并行的 `rea-p6c-script.md`，重叠处各写各的。

# WPE 2.8.42 场景壁纸的光标输入、命中测试与光标回调派发（exe 侧静态逆向）

**概括**
1. **输入来源：** 位置和左键都是渲染线程**每帧轮询**，不走窗口消息、不走钩子、不走 Raw Input。位置 `GetCursorPos` → `ScreenToClient(渲染窗口)` → 除以后备缓冲宽高（已知）；左键 `GetKeyState(VK_LBUTTON)`（`0x1401115b1`），**按下只在光标下的窗口是渲染窗口本身或桌面（图标 `SysListView32`、`SHELLDLL_DefView`、`Progman`、带 `WallpaperEngineParent` 属性的窗口）时才登记**，松开在任何地方都登记。移动没有任何窗口 / 前台门：光标在别的窗口上照样跟踪。渲染窗口的窗口过程不处理 `WM_LBUTTONDOWN/UP`。桌面与窗口化测试窗口是同一段代码。【确；`GetKeyState` 在桌面点击时怎么拿到状态是【推】】
2. **光标位置：** `CursorEvent.worldPosition` 与 `input.cursorWorldPosition` 是同一个量：把 `(px, 1 − py)` 在 NDC z = 0 处经本帧 `inverse(V·P)` 反投影，正交场景再把 z 置 0；和 P4c 的指针反投影是同一个公式（时机不同：这里用本帧相机），和 P5a 的视差点不是一个量。透视场景里它落在远平面上。`input.cursorScreenPosition` = `(px·Ws, py·Hs, 0)`，窗口客户区像素、左上原点、y 向下、不钳制（`alignmentfliph` 时 x 镜像）。`localPosition` = 图层四边形上的参数坐标乘 `size`：**左上角为原点、y 向下、单位是图层 `size`（不乘缩放）**，四边形经过旋转、缩放、父链、`alignment`；`fullscreen` 图层的 `localPosition` 是窗口像素；模型是模型空间里的命中点。【确；左上 / y 向下的解读是【推】】
3. **命中测试：** 只有图像层（类型 1）、文本层（4）、模型对象（5）参与；粒子、sprite、声音、分组、形状、灯、相机不参与。**`solid` 缺省为真**（基类构造 `+0x120 = 0x2001`，bit13 = `solid`），`solid: false` 才退出。图像 / 文本用射线对四边形（双面、t ≥ 0，不看纹理 alpha），模型用 mdl 的包围盒。**不看可见性、不看 `alpha`、不看父链可见性**：隐藏的图层照样被命中、收事件。层叠时**命中的全部都收事件**（自上而下），只有命中一个**自身与父链都可见且 `disablepropagation: true`** 的对象时才停在它这里。exe 里没有调用 `cursorHitTest` 的地方。【确】
4. **派发：** 回调发给「绑定对象（脚本条目 `+0x48`）就是该对象」的全部脚本条目（该对象所有字段上的脚本、按登记顺序），只发给导出了该回调（掩码位）且已 `init` 的。悬停态下：命中且不在悬停集合 → `cursorEnter`；命中且光标的世界坐标变了 → `cursorMove`；没命中且在悬停集合 → `cursorLeave`。按下沿：命中的对象 `cursorDown`、记进按下集合。松开沿：命中的对象 `cursorUp`，其中在按下集合里的再 `cursorClick`；没命中但在按下集合里的只 `cursorUp`。**按住期间**（按下集合非空）只给按下集合里的对象发 `cursorMove`（不管命中不命中），不发进出。【确】
5. **时机：** 帧函数里在相机更新之后、脚本 `FUN_140171440`（媒体事件、关键帧动画、计时器、`update`）之前（`0x1401802d5`），只在场景里有脚本导出了光标回调时才跑。按钮每帧只采一次当前状态，一帧内的多次按下抬起会丢。回调里写的图层字段当帧画出，但随后的关键帧动画可能把它盖掉；相机字段下一帧生效。暂停时不跑（采样也不跑）。【确，时序；暂停沿用 P4c】
6. **`input.*`：** 三个都是现读：`cursorWorldPosition` / `cursorScreenPosition` 是宿主接口 `+0xa8`（参数 false / true），`cursorLeftDown` 是 `+0xc0(3)` = `ctx+0xa4 & 1`；指针与按钮在帧函数之前采好，一帧内不变。【确】
8. **`openUserShortcut`：** 令牌是 `G+0xe0` bit28，按下沿（不论命中了什么）在命中函数开头置位，松开那一帧的派发结束后清掉；宿主函数取用即清，所以一次按下最多一次。dll 只许在 `cursorClick` / `Down` / `Up` 里调（rea-p11 4.3–4.5）。本文补上 rea-p11 没找到的 `cursorDown` 派发点。【确】

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42），副本 `ignore/p6/rea/cursor/exe/wallpaper64.exe`，开工时核对 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（前缀一致）。没运行、没附加 WPE，没写 Steam / WPE 目录。
- 方法：先用 REA 打开副本并导入 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot`，Ghidra 两次超过 330 s 启动期限（快照没有生效、在重新分析），按约定关掉，改用 `ignore/p4/rea/wp.asm` 切片 + 脚本直接读副本 exe（导入表、字符串、常量、虚表）。另瞄了一眼并行代理的 `ignore/p6/rea/cursor/script/dll_input_getters.asm`（只读），核对 dll 调宿主接口的槽号。
- 工作文件 `ignore/p6/rea/cursor/exe/`：
  - 汇编摘录：`f_140189e10.asm`（命中与派发主函数）、`rl_cursor_140111440.asm`（渲染循环里的指针 / 左键采样）、`f_14010d9b0_dab0.asm`（窗口白名单、按钮位写入）、`render_window_create_140110630.asm`（渲染窗口建立、`AttachThreadInput`）、`wndproc_140115b90.asm`（渲染窗口过程）、`hook_140126600.asm`（应用壁纸的低级鼠标钩子，场景不用）、`f_14019dbb0.asm`（图像 / 文本命中）、`f_14019d5a0.asm`（射线对平行四边形）、`f_140185520.asm`（模型命中）、`f_1401fd690.asm` / `f_140223810.asm`（虚函数 +0x88：骨骼包围盒、取骨骼名）、`img_world_1401fd3f0.asm`（图像层世界矩阵含 `alignment`）、`iface_14018e010.asm`（宿主接口 +0xa8 / +0xb0：光标世界 / 屏幕坐标、光标射线）、`iface_buttons_14018e330.asm`（+0xc0：左键）、`f_14018fc40.asm`（`perspective` 图层的射线）、`f_14019df90.asm`（反投影）、`solid_desc_14019c3f0.asm`、`desc_solid_dispropagation_1401e1180.asm`（`solid` / `disablepropagation` 描述符）、`base_ctor_flags_1401ddc60.asm`（基类构造的 `0x2001`）、`parent_visible_140185010.asm`、`sort_1401865c0.asm`、`frame_1401802d5.asm`（帧函数里的调用点）、`f_140175880.asm` / `f_140175880_head.asm`（脚本绑定、`+0x130` 门）、`bind_1401a4db0.asm`。
  - 脚本：沿用 text/layout 那套（`xr.py` / `slice.py` / `fn.py` / `grepfn.py` / `strs.py` / `rd.py` / `vtdump.py` 等），新增 `imports.py`（导入表与 IAT 地址，`all_imports.txt` 是全表）、`leastr.py`（区间里 lea 引用的 ASCII / UTF-16 串）、`wsat.py`（读某地址的 UTF-16 串）、`vt60.py` / `vtype.py`（按虚函数 +0x60 的返回值找对象类型号）、`showerr.py`（拆 REA 报错）。
- 标记：【确】汇编直接看到；【推】由代码推出，或依赖 Windows 行为；【确，有界】在注明范围内搜过。

**命名**（与 rea-p5-camera 相同）
- `R`：场景渲染器；`G = *R`：场景对象（命中函数 `FUN_140189e10` 的参数，rea-p11 叫 `SC`）；`ctx = R+0x10 = *(G+0xd8)`。
- `S`：渲染循环 `FUN_140110630` 的会话对象（循环里的 `r15`）；`*(S+0x180) = R`，`*(S+0x1c8)` 是渲染窗口 `renderHwnd`（rea-p4c-sim 1.7 的 `session`）。
- `H = G+0x48`：场景的宿主接口（虚表 `0x14048ea50`，dll 经它取 `input.*`、`openUserShortcut`；`*(H+0x90) = ctx`，`H+0x98` 就是 `G+0xe0`）。
- `ptr = ctx+0x8c / +0x90`：窗口客户区归一化指针（左上 0、右下 1、y 向下、不钳制）。`Ws`、`Hs = ctx+0x74 / +0x78`：后备缓冲宽高（float，`max(2, ·)`）。
- `btn = ctx+0xa4`（= `R+0xb4`）：bit0 本帧左键，bit1 上一帧左键（帧尾 `0x140181623` 复制）。
- 场景标志 `G+0xe0`：bit3 正交，bit8 `cameraparallax`，**bit28 快捷方式令牌**。
- 对象标志 `O+0x120`：bit0 `visible`，bit7 `perspective`，bit9 `0x200`（fullscreen / projectlayer 的排序位），**bit13 `solid`**，**bit14 `disablepropagation`**。图层标志 `O+0x304`：bit1 `fullscreen`。
- 对象字段：`O+0x128` `origin`、`O+0x170` `parallaxDepth`、`O+0x180` 父对象、`O+0x2f0` `size`（图像层描述符，`0x1401ee5da`；文本层是排版结果）。
- 命中函数内的状态：`G+0x280` 悬停集合、`G+0x2c0` 按下集合（都是以对象指针为键的 `unordered_set`，FNV-1a 哈希；`G+0x2d0` 是按下集合的元素数），`G+0x300 / +0x304` 上一帧光标世界坐标 xy，`G+0x308` 上一帧左键。
- 脚本条目（`ctx+0x17e0` = 脚本管理器 `R+0x1718` 的 `+0xd8` 链表）：`+0x8` 名字来源对象、`+0x38` 模块句柄、`+0x40` 导出回调掩码、`+0x44` 状态（2 = `init` 已跑）、`+0x48` 绑定对象（`CallCallback` 的 this）。
- 引擎 `E = *(ctx+0x1830)`：+0x20 Enter、+0x28 Leave、+0x40 `CallCallback(E, 模块, 绑定对象, 编号, &事件, 0)`。回调编号与掩码位：7 `cursorHitTest`（0x80）、8 `cursorEnter`（0x100）、9 `cursorLeave`（0x200）、10 `cursorMove`（0x400）、11 `cursorClick`（0x800）、12 `cursorDown`（0x1000）、13 `cursorUp`（0x2000）（p3 C 节的表）。
- 对象类型号（虚函数 +0x60）：1 图像（虚表 `0x1404911a8`）、2 粒子（`0x1404915b0`）、3 sprite（`0x140491680`）、4 文本（`0x140491950`）、5 模型（`model` 键，`0x140491338`）、7 声音（`0x140490ae8`）、8 基础对象 / 分组（`0x140490980`）、10 形状（`0x140491d10`）。

---

## 1. 输入来源

### 1.1 采样（渲染循环，`FUN_140110630` 的循环体 `0x1401115a4`–`0x14011164b`）【确】
```c
GetCursorPos(&pt);                                       // 0x1401115a8，屏幕坐标
down = (GetKeyState(VK_LBUTTON /* r14d = 1 */) >> 8) & 1; // 0x1401115b1；按下时返回 0xFF80/0xFF81，测的是 bit8
prev = R->btn & 1;                                       // R+0xb4
if (down) {
    if (!prev) {
        h = WindowFromPoint(pt);                         // 0x1401115d8
        if (IsDesktopLike(h) /* FUN_14010d9b0 */ || h == renderHwnd /* [S+0x1c8] */)
            SetBtn(R, 1);                                // FUN_14010dab0：bit0 置 1
        // 否则这一帧不登记；下一帧仍按住会再判一次
    }
} else if (prev) SetBtn(R, 0);                           // 松开在哪里都登记
if (ScreenToClient(renderHwnd, &pt))                     // 0x14011161a，失败保留旧值
    R->ptr = float2(pt) / (Ws, Hs);                      // R+0x9c = ctx+0x8c
```
- `FUN_14010d9b0(h)`：取类名与 `GetPropW(h, L"WallpaperEngineParent")`。
  - 类名 `SysListView32` 时，看父窗口类名是不是 `SHELLDLL_DefView`（桌面图标层）。
  - 否则：属性值为 1 → 真；类名是 `SHELLDLL_DefView` → 真；类名是 `Progman` → 真；其余假。
- 这一段只在非暂停帧跑：暂停分支（`0x140111452`–`0x140111498`）置 `S+0x1b8` bit27、`Sleep(250)` 后回到循环头，不采样（与 rea-p4c-sim 1.7 一致）。
- `GetCursorPos` 全 exe 只有两处引用：这里和托盘菜单（`0x14002178a`，`WM_CONTEXTMENU`）【确，有界：IAT `0x140426940` 的全部引用】。所以桌面壁纸和 `-control openWallpaper` 的窗口化测试窗口走同一段，区别只在 `renderHwnd`（桌面是挂在 WorkerW 下的子窗口，测试窗口是测试窗口的子窗口）【推：渲染窗口都由 `FUN_140110630` 建，`CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP | WS_EX_LAYERED, "WPEDesktopDX11Window", …, WS_CHILD, …)`】。

### 1.2 不走的路【确】
- **没有 Raw Input、没有 `GetAsyncKeyState`**（导入表里没有）。
- **低级鼠标钩子**（`SetWindowsHookExW(WH_MOUSE_LL = 14)`，`0x140126902`，回调 `0x140126640`）属于应用壁纸（`WPEAppIntermediateWorker`、`UnityWndClass`、`-WINDOWED -parentHWND` 那一套）：把 `WM_MOUSEMOVE / LBUTTONDOWN / LBUTTONUP` `PostMessage` 给最多 16 个子程序窗口（表 `0x1404e8d70`）。场景不经过它。
- **渲染窗口的窗口过程**（`0x140115b90`）只处理 `WM_DESTROY`、`WM_SIZE`、`WM_PAINT`、`WM_ERASEBKGND`、`WM_SETCURSOR`、`WM_WINDOWPOSCHANGING`、`WM_NCCALCSIZE`、`WM_MOUSEMOVE`（原样转发给父窗口）与 `WM_USER + 11` 以上的私有消息；`WM_LBUTTONDOWN / UP` 落到缺省处理。窗口消息不改 `btn`。

### 1.3 各种情形下派不派发
- 光标在别的应用窗口上（遮住了壁纸）：**移动照样跟踪**，进出、移动照样派发（没有前台 / 遮挡门）。**按下不登记**（`WindowFromPoint` 返回那个窗口）。【确】
- 在别的窗口上按住、拖到桌面上：到达桌面的那一帧 `down && !prev` 再判一次，这时登记为按下，场景收到 `cursorDown`。【确】
- 在桌面图标上按：`SysListView32` 在白名单里，登记；图标下面的图层照样收按下。任务栏不在白名单里。【确】
- 别的显示器：指针按本壁纸窗口归一化，不钳制，会超出 0..1；四边形一般命中不到（`fullscreen` 图层除外，见 3.3）。每个壁纸实例各采各的，在任一显示器的桌面上按下，各实例都会登记。【推】
- **`GetKeyState` 的语义问题：** 它返回调用线程输入队列的键状态。渲染窗口是别的线程（WorkerW / 测试窗口）窗口的子窗口，系统会自动连起两线程的输入队列，而 WPE 建窗后立刻 `AttachThreadInput(渲染线程, 父窗口线程, FALSE)` 断开（`0x1401107bf`）。断开之后，点在资源管理器窗口（桌面图标层）上的按键怎么反映到渲染线程的 `GetKeyState`，静态读码定不下来【推：语料里可点的壁纸在桌面上能用，所以实际是能拿到的】。见「未查清」1。

---

## 2. 光标位置

### 2.1 世界坐标（`CursorEvent.worldPosition`、`input.cursorWorldPosition`）【确】
宿主接口 `H` 的 +0xa8 = `FUN_14018e070(H, out, screen = false)`：
```c
in = (ptr.x, 1 - ptr.y, 0.5);                        // 视口 (0, 0, 1, 1)
out = Unproject(in, V = *(ctx+0x38), P = *(ctx+0x40)); // FUN_14019df90：inverse(V·P) · (2x−1, 2y−1, 2z−1 = 0, 1)，除 w
if (ctx+0x118 & 0x400 /* 正交 */) out.z = 0;
```
- 即 NDC `(2px − 1, 1 − 2py, 0)` 经 `inverse(V·P)`，和 P4c 的指针反投影是同一个公式。`V`、`P` 是调用时的栈顶：命中函数和脚本都在相机更新（步骤 2–5，含抖动、正交 `zoom`）之后跑，所以用的是**本帧**相机；不含逐对象的视差平移（视差只在绘制时压栈）。P4c 的粒子用的是上一帧的相机（rea-p4c-sim 1.6）。
- **透视场景：** 反向深度下 NDC z = 0 是远平面（rea-p5-camera 1.2），所以 `worldPosition` 是光标射线和远平面（缺省 farz 10000）的交点【推：由投影推出】。
- `alignmentfliph`：投影第 0 行已取反，反投影自然镜像，不另处理。
- 和 P5a 视差点 `P = eye.xy + lerp(场景中心, (W·mx, H·my), mi)`（带平滑）不是一个量；和 `g_PointerPosition`（就是 `ptr`）也不是。

### 2.2 屏幕坐标（`input.cursorScreenPosition`）【确】
同一函数，`screen = true`：
```c
out = (ctx+0x118 & 0x800 /* alignmentfliph */) ? ((1 - ptr.x)·Ws, ptr.y·Hs, 0) : (ptr.x·Ws, ptr.y·Hs, 0);
```
- 窗口客户区（后备缓冲）像素，左上原点，y 向下，不钳制（光标在窗口外会是负数或大于宽高）。不是场景像素。

### 2.3 `localPosition`【确，解读【推】】
命中函数对每个参与的对象都算一遍（没命中也算，见 3.2 末尾），只是写进事件的值：
- **图像 / 文本：** 四边形 `c0 = T − A/2 − B/2`、`c1 = T + A/2 − B/2`、`c2 = T − A/2 + B/2`，`A = 世界矩阵第 0 行 × size.x`，`B = 第 1 行 × size.y`，`T = 平移 + 视差偏移`。射线交点的参数 `(u, v)`（`c0` 起沿 `A`、`B`）→ `local = (u·size.x, (1 − v)·size.y, 0)`。
  - 世界场景 y 向上，第 1 行是本地 +y，所以 `local` 是**以四边形左上角为原点、y 向下**，范围 `[0, size.x] × [0, size.y]`，和图层纹理的像素坐标一致。
  - 单位是 `size`，**不乘缩放**；旋转、缩放、父链、`alignment` 只改变四边形的位置与形状，不改 `local` 的量程。
  - 文本层的 `size` 是排版结果（文字框），世界矩阵含文字框中心偏移与 `anchor`（rea-p6b-layout 的 +0x80 / +0xa8）。
- **`fullscreen` 图层：** `local = (ptr.x·Ws, ptr.y·Hs, 0)`，窗口像素（不做 fliph 镜像）。
- **模型：** 射线进包围盒的交点在模型空间里的 xyz（`FUN_140185520` 尾部）。
- 没命中时：参数照算，会落在 `[0, size]` 之外（外推）；射线与四边形平行或在相机后面时保持 0（每个对象开始前清零，`0x14018a210`）。所以拖出图层后的 `cursorMove` / `cursorUp`、`cursorLeave` 带的是外推坐标。

### 2.4 事件结构（exe 传给 `CallCallback` 的 `&事件`，`rsp+0x68`）【确】
| 偏移 | 内容 |
|---|---|
| +0x0 | `worldPosition`（vec3，每帧算一次，所有对象相同） |
| +0xc | `localPosition`（vec3，逐对象） |
| +0x18 | `const char*`：被命中的**骨骼名**（见 3.4），没有时为 null |
dll 怎么把它变成 `CursorEvent` 见 `rea-p6c-script.md`。

---

## 3. 命中测试（`FUN_140189e10`）

### 3.1 入口门【确】
- 帧函数 `0x1401802af`：`R+0x1848`（= `ctx+0x1838`）为 0 就整段不调；函数开头（`0x140189e31`）再判一次。
- 这一字节在脚本绑定 `FUN_140175880` 里置位：取回调掩码后 `mask & 0x3f80`（编号 7–13 任一）就置 1（`0x14017670a`）；场景卸载 / 重置时清 0（`0x14017111c`、`0x140171302`）。**只导出 `cursorHitTest` 的脚本也会打开它。**

### 3.2 遍历与筛选【确】
```c
H->vt[0xb0](H, &rayO, &rayD);          // 普通射线（3.3 末尾）
G->vt[0x40](G, &rayOp, &rayDp);        // perspective 图层的射线
H->vt[0xa8](H, &world, false);         // 2.1
moved = world.xy != G->lastWorld.xy;   G->lastWorld = world.xy;     // 比较的是世界坐标
cur = ctx->btn & 1;  prev = G->lastBtn;  pressedCount = G->pressed.size();
parallax = (G->flags & 0x108) == 0x108;                             // 视差且正交
if (cur && cur != prev) G->flags |= 1 << 28;                        // 快捷方式令牌（第 8 节）
list = ortho ? G->objects /* G+0x158，建对象顺序 */
             : sortByViewDepth(copy(G->objects))  /* G+0x268，FUN_1401865c0 */;
for (i = list.size - 1; i >= 0; --i) {                              // 倒序
    O = list[i];
    if (!(O->flags120 & 0x2000)) continue;                          // solid
    t = O->vt[0x60]();  if (t != 1 && t != 4 && t != 5) continue;
    persp = O->flags120 & 0x80;
    off = (parallax && (t == 1 || t == 4))
        ? amount · (O->origin.xy − G->parallaxP) ⊙ O->parallaxDepth : 0;   // 对象自己的，不是根
    local = 0;
    hit = (t == 5) ? HitModel(O, persp ? rayOp : rayO, persp ? rayDp : rayD, &local)
                   : HitQuad(ctx, O, &off, persp ? rayOp : rayO, persp ? rayDp : rayD, &local);
    … 派发（第 4 节）…
}
G->lastBtn = cur;
if (!cur) { if (prev) G->flags &= ~(1 << 28);  G->pressed.clear(); }
```
- **不看可见性：** 循环与 `FUN_14019dbb0` / `FUN_140185520` 都不读 `O+0x120` bit0、不调虚函数 +0x68（可见）。所以 `visible: false` 的图层、父层隐藏的图层、`alpha` 为 0 的图层都照样被命中【确】。可见性只在「停止传播」那一步用（3.5）。
- 类型号来自虚函数 +0x60（命名表）。**组合层 / passthrough 图层**是图像层，按自己的四边形参与；分组节点（类型 8）不参与【确】。
- 遍历顺序：
  - 正交：`G+0x158` 倒序，即建对象顺序（JSON 顺序）的倒序 = 画的顺序的倒序（最上面的先）【确；「建对象顺序 = 画的顺序」引 rea-p5 / rea-p13】。
  - 透视：`G+0x158` 的拷贝按 `dot(origin, g_ViewForward)` 降序稳定排序（同透明排序，rea-p13-lights 5.1；`O+0x120 & 0x200` 的键是 −∞），再倒序遍历：离相机近的先，`fullscreen` / `projectlayer` 最先【确】。

### 3.3 图像与文本：`FUN_14019dbb0`【确】
1. `O+0x304 & 2`（`fullscreen`）：直接算命中，`local` = 窗口像素（2.3）。
2. 否则 `M = O->vt[0x80]()`（世界矩阵）：
   - 图像层 `FUN_1401fd3f0`：基类世界矩阵 `FUN_1401850a0`（父链），`alignment ≠ center`（`O+0x4b1`）时再加对齐偏移；
   - 文本层 `FUN_140256e10`：基类 × 文字框中心平移。
3. `O->vt[0xa8](&N)` 返回真时 `M = M × N`（文本的 `anchor`；图像层是空函数）。
4. `T = M.平移 + off`，四边形见 2.3，`size = O+0x2f0`。
5. `FUN_14019d5a0(rayO, rayD, c0, c1, c2, &uv, &t)`：Möller–Trumbore 式，`det = e1·(d × e2)`，`|det| < 1.19e-7` 判平行；**正负 det 都接受（双面）**；只要求 `0 ≤ u ≤ det`、`0 ≤ v ≤ det`（没有 `u + v ≤ det`，所以是平行四边形）。
6. 命中 = 上一步为真且 `t ≥ 0`。
- **不看纹理 alpha、不看 `colorBlendMode`、不看材质**：透明区域也算命中。
- `perspective: true` 的图层（`O+0x120` bit7）用 `G` 虚函数 +0x40（`FUN_14018fc40`）给的射线：照 `FUN_1401e5b60` 现建一个透视覆盖相机（fov = `ctx+0x110`、相机放在可见区中心、距离 d），反投影光标，射线从这个相机位置出发（rea-p5-camera 第 7 节）【确】。
- 普通射线 `H+0xb0`（`FUN_14018e1a0`）：反投影 `(px, 1 − py, 0.5)` 得 `p`；正交 → 起点 `(p.x, p.y, eye.z)`、方向 `(0, 0, −1)`（`eye = ctx+0x68`，正交时 z = 2000，rea-p5-camera 2.1），透视 → 起点 `eye`、方向 `normalize(p − eye)`【确】。所以正交场景里 `origin.z > 2000` 的图层命中不到（`t < 0`）【推】。

### 3.4 模型与骨骼【确】
- 模型（类型 5）：`FUN_140185520` 把射线变到模型空间，对 mdl 的包围盒（`mdl+0x1b8` 起 min / max）做 slab 测试。不对三角形测试。
- 虚函数 +0x88（图像层 `FUN_1401fd690`、模型 `FUN_140223810`，其余类型 `xor al, al`）：在**按下集合非空、或这一帧左键变了**时，对每个参与的对象都调一次（不管命中不命中）。它倒序遍历 puppet / mdl 的骨骼，把射线变到骨骼空间对骨骼包围盒做 slab 测试，第一个命中的骨骼把**骨骼名**（为空时用下标的十进制串）写进事件 +0x18。不影响命中结果，也不改 `localPosition`。dll 是否把它暴露给脚本见 `rea-p6c-script.md`。

### 3.5 层叠：全部命中都收，`disablepropagation` 才挡【确】
命中路径的末尾（`0x14018a86f`）：
```c
if ((O->flags120 & 0x4000 /* disablepropagation，描述符 0x1401e131a */) && (O->flags120 & 1) &&
    (O->parent == 0 || ParentChainVisible(O->parent) /* FUN_140185010 */))
    break;                                 // 下面的对象这一帧都不处理（也不发 Leave / Up）
```
- 缺省 `disablepropagation` 为假（基类构造 `+0x120 = 0x2001`，`0x1401ddc72`；rea-p4a 已记）。
- 隐藏的图层即使写了 `disablepropagation` 也不挡。
- 只在命中路径里 `break`；按住拖动的路径（4.3）不 `break`。

### 3.6 `solid`【确】
- 描述符（基类表 `0x1404e8250`，登记于 `0x1401e122c` 起）：`+0x120` bit13，类型 6（位），JSON setter `0x14019c3f0`（JSON 布尔直接写；对象形式读 `value` 并走用户属性绑定 `FUN_1401a4db0`），脚本 setter `0x14019c5c0`（`bts/btr 13`，无改值回调），getter `0x14019c600`。
- **缺省为真**：基类构造 `FUN_1401ddbb0` 写 `+0x120 = 0x2001`（visible | solid）；在 `0x140150000`–`0x140280000` 里搜清 bit13 的代码，只有这三个 setter【确，有界】。所以语料里没写 `solid` 的 544 段都能被命中。
- 写入当场生效：命中循环每个对象现读这一位；在某个回调里改了**排在后面**的对象的 `solid`，本帧就会影响它【推】。

### 3.7 `cursorHitTest`【确，有界】
- 命中函数里没有任何地方测掩码 0x80 或以编号 7 调 `CallCallback`；在 `0x140150000`–`0x140260000` 里搜 `mov r9d, 7` 与 `test [x+0x40], 0x80`，只有两处无关代码。exe 侧**不调用** `cursorHitTest`。dll 会不会在派发别的光标回调前自己调它，见 `rea-p6c-script.md`。语料没有场景导出它。

---

## 4. 派发

### 4.1 发给谁【确】
对当前对象 `O`，遍历全部脚本条目（`ctx+0x17e0` 链表，按登记顺序）：
```c
if ((S->obj48 == O || S->ptr8 == 0) && (S->mask & bit) && S->state == 2)
    E->CallCallback(S->module, S->obj48, 编号, &事件, 0);        // 一批调用前后各 Enter / Leave 一次
```
- 即 **`O` 上挂的全部脚本**（`scale`、`visible`、`origin`……每个字段的脚本各一段）凡导出该回调的都调，按脚本登记顺序；没导出的按掩码跳过，`init` 没跑完的跳过。
- `S+0x8 == 0` 的条目对每个对象都收（含义没查清，见「未查清」3）。
- `场景标志 [ctx+0x1710]+0x118 & 0xc000000`（只在销毁资源期间置位，p2）时整批不调，但悬停 / 按下集合照常更新。
- 光标回调的返回值不写回（p3 D 节：只有 `init`、`update`、`animationEvent` 写回）。

### 4.2 悬停态（按下集合为空，或本帧左键是松开的）【确】
对每个参与的对象（直到 3.5 的 `break`）：
- **命中：**
  1. 不在悬停集合 → 加入，`cursorEnter`；
  2. `moved` → `cursorMove`；
  3. 左键变了：按下 → `cursorDown`（编号 `(cur ^ 1) | 0xc` = 12，`0x14018a6ef`–`0x14018a766`），并加入按下集合；松开 → `cursorUp`（13），且对象在**帧初的**按下集合里 → 再 `cursorClick`（11）；
  4. 3.5 的停止判断。
- **没命中：**
  1. 左键这一帧松开、且对象在按下集合里 → `cursorUp`（拖出图层后松开；不发 `cursorClick`）；
  2. 在悬停集合 → 移出，`cursorLeave`。
- 一帧里同一对象的顺序：`Enter → Move → Down` / `Enter → Move → Up → Click`；没命中时 `Up → Leave`。
- `cursorMove` 只发给命中的对象，不是全场。`moved` 比的是**世界坐标**的 xy：光标不动但相机在动（抖动、视差、`zoom`、透视相机移动）时也会每帧发 `cursorMove`。
- 进出按**集合**判（每个对象一条记录），不是只看最上面一个：叠在一起的几个图层可以同时处于「已进入」。
- 被 3.5 挡住的对象这一帧完全不处理：本来在悬停集合里的不会收到 `Leave`，直到挡住它的对象不再命中。

### 4.3 按住拖动（帧初按下集合非空且左键仍按住）【确】
- 只处理按下集合里的对象：`moved` 时发 `cursorMove`（**不管命中不命中**，`localPosition` 是外推值）。
- 不发 `cursorEnter` / `cursorLeave`，不改悬停集合，不 `break`。
- 按下时什么都没命中（按下集合为空）就按住：仍走悬停态，进出、移动照常；在某个图层上松开时它收到 `cursorUp`，**没有 `cursorDown`、也没有 `cursorClick`**。

### 4.4 点击的判定【确】
- `cursorClick` = 松开那一帧命中、且按下那一帧在它上面按下（在按下集合里）。中间拖出再拖回来照样算。
- `cursorUp` 给**两类**对象：松开处命中的全部对象（不论在哪里按下），加上按下集合里没命中的。
- 按下集合在每个「左键松开」的帧末清空（`0x14018a46f`），不跨点击保留。

---

## 5. 时机

### 5.1 帧内位置（`FUN_14017fa70`）【确】
| 顺序 | 动作 | 地址 |
|---|---|---|
| 0 | 渲染循环：指针、左键采样（1.1） | `0x1401115a8`–`0x14011164b` |
| 1 | `g_Time` 推进 | 帧函数开头 |
| 2 | `FUN_1401891a0`：对象 +0x48 更新（粒子模拟、puppet 动画、视频等）→ 相机、视差点 | `0x14017fd26` |
| 3–5 | 投影、正交 `zoom`、`g_View*` | `0x14017fd2e`–`0x1401802c7` |
| **6** | **光标命中与派发 `FUN_140189e10`**（门 `R+0x1848`） | `0x1401802af`–`0x1401802d5` |
| 7 | `FUN_140171440`：媒体事件 → 关键帧动画 → `animationEvent` → 计时器 → `update` | `0x1401802e5` |
| 8 | 渲染 | `0x14018031a` 起 |
| 9 | 帧尾：`R+0xa4 ← R+0x9c`，`btn` bit1 ← bit0 | `0x140181615`–`0x14018169e` |

- 命中用的世界矩阵是上一帧脚本 / 动画写完后的状态，也就是上一帧画出来的样子【推】。
- 回调里写的图层字段：在第 8 步当帧画出；但第 7 步的关键帧动画会覆盖同一字段（P10a 的写入）。写相机字段要到下一帧的第 2 步才进 `V / P`（rea-p5-camera）。
- 回调里读 `input.*` 与 `update` 里读到的是同一帧的值。

### 5.2 一帧内多次按下 / 抬起【确】
- 每帧只采一次 `GetKeyState`，只比较「本帧 vs 上一帧」；两帧之间完整的一次按下抬起会**整个丢掉**（没有 `Down` / `Up` / `Click`）。不排队、不合并。低帧率（如 10 fps）时快速单击可能不响应。

### 5.3 暂停【确，沿用 rea-p4c-sim】
- 暂停时渲染循环在采样之前就 `Sleep(250)` 回到循环头，帧函数不调，命中与派发不跑，`input.*` 冻结。恢复后的第一帧按「当前 vs 暂停前」比较：光标动过 → `moved`，左键状态变了 → 当作一次按下或松开。

---

## 6. `input.*` 的数据来源【确】

| 字段 | dll 调的宿主接口（`H` 虚表 `0x14048ea50`） | exe 实现 | 数据 |
|---|---|---|---|
| `cursorWorldPosition` | +0xa8，第三参 `0`（dll `0x1816580b6`） | `FUN_14018e070` | 2.1：本帧 `V / P` 反投影 `ptr`，正交 z = 0 |
| `cursorScreenPosition` | +0xa8，第三参 `1`（dll `0x1816582f4`） | `FUN_14018e070` | 2.2：`ptr × (Ws, Hs)`，z = 0 |
| `cursorLeftDown` | +0xc0，参数 `3`（dll `0x18165864d`） | `FUN_14018e380` | `ctx+0xa4 & 1`；参数不是 3 时返回假 |

- dll 侧槽号取自并行代理的 `dll_input_getters.asm`，只核对了槽号与参数。
- 三个都是**每次访问现算**：`ptr`、`btn` 在第 0 步采好，一帧内不变；世界坐标还依赖调用时的 `V / P` 栈顶（第 6、7 步都是本帧相机）。
- `cursorLeftDown` 只看左键，且是**登记过的**状态：在别的窗口上按下（没登记）时为假；登记后拖到哪里都为真，直到松开。
- 光标离开窗口：两个坐标都照常外推，不钳制；`cursorLeftDown` 保持。

---

## 8. 顺带：`openUserShortcut` 的「每次点击最多一次」【确】
- 令牌是 `G+0xe0` bit28（= `H+0x98`）。
  - 置位：命中函数开头，左键按下沿（`cur && cur != prev`）就置位（`0x140189f88`），**不管命中了什么**。
  - 清除：左键松开那一帧、全部派发结束后（`0x14018a45e`）。
- 宿主 `H` +0xf0 = `0x14018f7d0`：没有令牌返回 2（dll 抛「Cannot execute more than one user command per cursor click.」），有就先清掉再启动（rea-p11-media 4.4）。
- dll 只许在当前回调编号是 11 / 12 / 13（`cursorClick` / `Down` / `Up`）时调（rea-p11-media 4.3），所以 `Enter` / `Leave` / `Move` 里调会抛错。
- 合起来：一次按下到松开之间（`Down` → 拖动若干帧 → `Up` / `Click`）共用一个令牌，谁先用谁得；在空白处按下、在图层上松开，`cursorUp` 里也能用。
- 补 rea-p11 4.5：`cursorDown` 的派发点就在本函数（`0x14018a74e`，编号由 `(cur ^ 1) | 0xc` 算出，按下 12、松开 13）。

---

## 未查清

1. **`GetKeyState` 在桌面上怎么拿到状态。** 渲染线程建窗后用 `AttachThreadInput(…, FALSE)` 断开了与父窗口线程的输入连接；点在资源管理器的图标层上时，渲染线程的队列键状态怎么更新，静态读不出（可能是 Windows 对没有输入焦点的线程的同步规则，也可能 `[S+0x60]` 不是父窗口）。只影响「为什么能用」，不影响 Kabegame 的语义。
2. **`[S+0x60]` 与 `AttachThreadInput` 的对象**：没核对 `[S+0x60]` 是 WorkerW、测试窗口还是 WPE 主窗口。
3. **脚本条目的 `+0x8` 与 `+0x48`。** 派发条件是 `+0x48 == 对象 || +0x8 == 0`。`+0x48` 是 `CallCallback` 的 this（绑定对象）；`+0x8` 在绑定时被当成名字来源解引用（`0x14017663f`），所以正常条目不为空。什么条目会是 0（销毁对象后？场景级脚本？）没查到；若存在，它会收到**所有**对象的光标事件。另外没查清材质常量、effect 上的脚本的 `+0x48` 是不是所属图层（如果是，它们也收所属图层的光标事件）。
4. **文本层 `size`（`+0x2f0`）带不带 `padding`**：rea-p6b-layout 说文字框只在合成路径加 `padding`；命中四边形用的就是这个值，没逐情形核对。
5. `G+0x300 / +0x304` 的初值（第一帧 `moved` 是否为真）没读构造函数。
6. 场景重载、`destroyLayer` 后悬停 / 按下集合里的悬空指针怎么处理，没看。
7. `thisScene.sortLayer` 是否改 `G+0x158` 的顺序（影响正交场景的命中顺序），没看。
8. 骨骼名（事件 +0x18）在 dll 侧有没有暴露成 `CursorEvent` 的成员，归 `rea-p6c-script.md`。

## 建议的实测

**先定手段（不移动用户的鼠标）：**
- **发窗口消息没用（预测）：** 位置来自 `GetCursorPos`，左键来自 `GetKeyState`，渲染窗口过程不处理 `WM_LBUTTONDOWN/UP`；投递的鼠标消息也不更新线程键状态【推，Windows 行为】。建议仍花一分钟验证：给 MCP 测试窗口的渲染子窗口（类名 `WPEDesktopDX11Window`）`PostMessage` / `SendMessage` 一组 `WM_MOUSEMOVE` / `WM_LBUTTONDOWN` / `WM_LBUTTONUP`，测试工程的 `cursor*` 与 `input.*` 应当都没有反应。
- **移窗口代替移光标：** 光标保持不动，用 `SetWindowPos` 移动本会话的测试窗口，让光标落在客户区的目标位置；`GetCursorPos` → `ScreenToClient` 得到的就是相对窗口的坐标，等价于移动光标。可以驱动进出、移动、`input.cursor*Position`，前提是用户在测试期间不碰鼠标、测试窗口在光标处位于最上层。
- **左键（二选一，都要用户同意）：**
  - `SendInput` 只发 `MOUSEEVENTF_LEFTDOWN / LEFTUP`、不带 `MOUSEEVENTF_MOVE`：不移动光标，但是真实点击，落在光标下的窗口（应当就是测试窗口）。
  - 辅助线程 `AttachThreadInput(辅助线程, WPE 渲染线程, TRUE)` 后 `SetKeyboardState` 置 `VK_LBUTTON` 高位，渲染线程的 `GetKeyState` 应当读到按下【推，没验证过】；`WindowFromPoint` 仍要求光标下是渲染窗口。
- 都不行就只能人工点，按读码结论把实测压到最少。

**语义核对（测试工程用 `console.error` 打 `[kbp]` 日志：帧号、回调名、`JSON.stringify(event)`、`input.*`）：**
1. `solid` 缺省：不写 `solid` 的图层收事件；`solid: false` 不收；脚本运行中改 `solid`。
2. 隐藏图层：`visible: false` 的图层收 `Enter` / `Down` / `Click`；父层隐藏的子层同样收。
3. 层叠与传播：两个重叠图层都收 `Enter` / `Down` / `Click`，上面的先；上面的写 `disablepropagation: true` 后下面的不再收；上面的同时隐藏时又能收。
4. `localPosition`：旋转 30°、`scale (2, 0.5)`、带父层、`alignment: topleft` 的图层，光标放在四角和中心，应得 `(0, 0)`、`(w, 0)`、`(0, h)`、`(w, h)`、`(w/2, h/2)`（`w, h` 是 `size`）。`fullscreen` 图层的 `localPosition` 是窗口像素。
5. 拖动：在 A 上按下、拖出、在外面松开 → `Down`、若干 `Move`（外推坐标、拖动期间无 `Leave`）、`Up`、无 `Click`，松开那一帧才 `Leave`。在空白处按下、在 A 上松开 → 只有 `Up`。
6. 光标不动 + `camerashake`：每帧都有 `cursorMove`。
7. 世界坐标：正交场景 `worldPosition.z = 0`、与 `input.cursorWorldPosition` 相同；透视场景里它在远平面上（长度约等于 farz）。
8. 视差：开 `cameraparallax` 的正交场景里，子图层（自身 `parallaxDepth` 与根不同）的命中区域和画面错开。
9. 快速单击：把 fps 设到 10，单击短于一帧时没有任何按键回调。
10. 遮挡：光标在别的窗口上时仍有进出 / 移动；在别的窗口上按下不发 `Down`，拖到壁纸上才发。
11. `openUserShortcut`：`Down` 里用掉后，同一次点击的 `Click` 里再调应抛「more than one」；`Enter` 里调应抛「outside of cursor callbacks」。

## REA 重核（2026-11-14）

**方法**
- REA 6.9.0（`binary_session` 的 server_identity），后端 Ghidra 12.1.4。`inspect_analysis_settings` 读到 `ghidra.startup_timeout_ms` 当前值 900000、启动值 900000、来源 setting（缺省 330000），用户改的环境变量已生效。
- 目标副本 `ignore/p6/rea/cursor/exe/wallpaper64.exe`，开工核对 SHA-256 `40e2ce02…993b0` 一致。带 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot` 打开被拒（`evidence_integrity_mismatch`：分析配置摘要不同，快照 `bb0af088…`，当前 `b119a543…`），改为不带快照打开。打开（15:21:21）到第一次反编译 `FUN_140189e10` 返回（15:27:47）约 6 分 26 秒，全量自动分析在这期间做完，没有超时。
- 反编译用 `decompile_all` 按地址区间导出到 `ignore/p6/rea/cursor/exe/dec-rea/functions/<地址>.c`（索引 `decompile-index.json`、`decompile-journal.jsonl`）。伪代码丢参数或拿不准的地方用 REA 的 `procedure_assembly`（`0x140185520`、`0x14019df90`）、`read_bytes`（`0x1404926c0` = 0.5f，`0x140492dd0` = 4×0.5f）、`procedure_callers`、`procedure_pseudo_code`（`0x140178e20`）补；`0x14018a250`–`0x14018a265` 的调用实参与类名串 `0x140477f98` 用旧的 `f_140189e10.asm` / `wsat.py` 对照（同一份字节）。
- 关闭时存快照 `ignore/p6/rea/cursor/exe/wallpaper64-2.8.42-p6c.rea-snapshot`（176 KB，18 条 Evidence）。注意：REA 报 Ghidra checkpoint 模式在本机关闭（`REA_GHIDRA_CHECKPOINT_DIR` 只支持 Linux / macOS），快照不含 Ghidra 的程序库，下次导入仍要重做约 6.5 分钟的自动分析。
- 主会话已核的四处（`0x1401115b1`、`0x1401ddc72`、`0x14018a024`、`0x14018a86f`）没有重复花时间，反编译里看到的与之一致。

**第 1 节 输入来源**
- 1.1 采样：**成立**。`0x140110630.c` 734–763 行：`GetCursorPos` → `GetKeyState(1) & 0x100` → `prev = R+0xb4 & 1`；按下且 `prev == 0` 时 `WindowFromPoint` 后 `FUN_14010d9b0(h) || h == [S+0x1c8]` 才 `FUN_14010dab0(R, 1)`；松开且 `prev == 1` 直接 `FUN_14010dab0(R, 0)`；`ScreenToClient([S+0x1c8])` 成功才写 `R+0x9c = pt / R+0x84`（`R+0x84` = `ctx+0x74`）。暂停分支 `LAB_140111452` 置 `S+0x1b8` bit27、`Sleep(250)`、回循环头，在采样之前。
- `FUN_14010d9b0`：**成立**，逐字一致。补充：`SysListView32` 分支只看父窗口类名是不是 `SHELLDLL_DefView`，不看 `WallpaperEngineParent` 属性。
- 渲染窗口：**补充**，原文 1.1 末尾的 `CreateWindowExW` 写法要分开类名和窗口名：类是 `WPEDesktopDX11Window`（`RegisterClassExW` 的 `lpszClassName` = `0x140477f98`），窗口名是 `WPELiveWallpaper`，扩展样式 `0x8280000`（NOACTIVATE | NOREDIRECTIONBITMAP | LAYERED）、`WS_CHILD`、父窗口 `[S+0x60]`。建窗后依次 `SetLayeredWindowAttributes(h, 0, 0xff, LWA_ALPHA)`、`AttachThreadInput(渲染窗口线程, [S+0x60] 所属线程, FALSE)`、`SetPropW(h, L"WallpaperEngineWallpaper", 1)`；`S+0xa6 & 8` 时 `ShowCursor(FALSE)`。
- 1.2（不走 Raw Input、钩子、窗口过程）：没重核。

**第 2 节 光标位置**
- 2.1：**成立**。`FUN_14018e070(H, out, 0)`：win = `(ctx+0x8c, 1 − ctx+0x90, 0.5)`，视口 `(0, 0, 1, 1)`，`FUN_14019df90(out, &win, *(ctx+0x38), *(ctx+0x40), &视口)`，`ctx+0x118 & 0x400` 时 `z = 0`。`FUN_14019df90` 汇编：`FUN_14005ecb0(tmp, rdx = P, r8 = V)` 相乘、`FUN_14005f730` 求逆，NDC = `2·(win − vp.xy)/vp.zw − 1`、`2·win.z − 1`，除 w，即 glm::unProject。
- 2.2：**成立**（`ctx+0x118 & 0x800` 时 `x = (1 − px)·Ws`，z = 0）。
- 2.3 图像 / 文本：**成立，补全边界**。`FUN_14019d5a0` 输出的 `uv` 已除以 `det`，`t` 不论范围内外都写；平行时写 `uv = 0`、`t = −1` 并返回假。`FUN_14019dbb0` 收尾：**`t < 0` 时返回 0 且不写 `local`**；`t ≥ 0` 时不论 `uv` 是否越界都写 `local = (u·size.x, (1 − v)·size.y, 0)`。所以「外推」只发生在交点在射线前方的情形，平行与在后方时 `local` 保持命中循环清的 0，与原文一致。
- `fullscreen`：**补充**：这一支（`O+0x304 & 2`）**不做射线测试、恒返回命中**（写完 `local` 直接 `return 1`）。`fullscreen` 图层只要 `solid` 就每帧都算命中，光标在窗口外也一样（`moved` 时收 `cursorMove`，永远不收 `cursorLeave`）。
- 模型的 `localPosition`：**不成立**，见 3.4。

**第 3 节 命中测试**
- 3.1：**成立**。帧函数 `if ((char)R[0x309]) FUN_140189e10(*R)`（`R+0x1848`）；命中函数开头判 `*(ctx+0x1838)`。`FUN_140175880` 里 `LoadScript` 成功后 `mask & 0x3f80` 就 `S+0x130 = 1`。
- 3.2：**成立**。三次宿主调用的顺序（`H+0xb0` 射线、`G` 虚函数 +0x40 透视射线、`H+0xa8` 世界坐标）、`moved` 只比 xy、`parallax = (G+0xe0 & 0x108) == 0x108`、令牌、正交用 `G+0x158` 否则拷进 `G+0x268` 后 `FUN_1401865c0(G+0x268, ctx+0x160)`、倒序、`solid` → 类型 1 / 4 走 `FUN_14019dbb0`、5 走 `FUN_140185520`、`local` 与 `off` 每对象清零、视差偏移 `G+0x334 · (O+0x128 − G+0x340) · O+0x170`（y 同理，z = 0）只给 1 / 4，全部一致。补充：类型 5 的调用实参（`0x14018a250`–`0x14018a265`）和四边形一样是「按 `persp` 选的射线起点、方向、`&local`」，Ghidra 伪代码把这几个参数丢了，以汇编为准。排序比较器没重核。
- 3.3：**成立**。`FUN_14019dbb0`：`M = vt[0x80]()`；`vt[0xa8](&N)`（`N` 先置单位阵）为真时 `M = M·N`；`T = M.平移 + off`；`c0 = T − A/2 − B/2`、`c1 = T + A/2 − B/2`、`c2 = T − A/2 + B/2`；`size = O+0x2f0`。`FUN_14019d5a0`：`|det| ≤ 1.1920929e-7` 判平行；`det > 0` 要求 `0 ≤ u, v ≤ det`，`det < 0` 要求 `det ≤ u, v ≤ 0`（双面），没有 `u + v` 条件；命中 = 范围内且 `t ≥ 0`。
- 图像层世界矩阵 `FUN_1401fd3f0`：**成立**。`O+0x4b1 == 0` 直接返回基类 `FUN_1401850a0`；否则把基类矩阵拷到 `O+0x450`，平移加上 `O+0x2f8..+0x300` 经三个轴变换后的偏移。（Ghidra 把 `0x1401fd407` 的尾调用当成终止调用，不影响这段。）`0x4b1 == 0` 是否就是 center 没核。
- 透视射线 `FUN_14018fc40`：**成立，补参数**。拷 `V = *(ctx+0x38)`；`d = 1 / (tan(fov/2) · P[1][1])`，fov = `ctx+0x110`；`V` 的平移 z 换成 `−d`，x、y 各减 `(int)ctx+0x84 · ctx+0xf8`、`(int)ctx+0x88 · ctx+0xfc`；投影由 `ctx+0x1518` 的虚函数 +0x10 现建（fov、宽高比 `ctx+0x74 / ctx+0x78`、near 5、far `max(15000, d + 1000)`）；反投影 `(px, 1 − py, 0.5)` 得 `p`，起点 = `inverse(V)` 的平移，方向 `normalize(p − 起点)`。
- 普通射线 `FUN_14018e1a0`：**成立**。补充：这里的正交判定是 `H+0x98 & 8`（= `G+0xe0` bit3），而世界坐标置 z = 0 用的是 `ctx+0x118 & 0x400`，两处读的不是同一个标志位（正常应同真同假，没核两者的来源）。
- 3.4 模型：**部分不成立**（`FUN_140185520` 逐条对了 REA 汇编）：
  - 前提：`O+0x2e8` 非空、`*(O+0x2e8) != 0`、`mdl+0x1c4 > mdl+0x1b8`（x 方向 max > min），否则不命中。
  - 射线用 `inverse(O->vt[0x80]())` 变进模型空间（方向不带平移）。
  - 设 `h = (mdl+0x1c4.. − mdl+0x1b8..) · 0.5`。代码把起点**再减 `h`**（`o'' = o' − h`），然后对 `[−h, h]` 做 slab。等价于在模型空间测 **`[0, max − min]`**，不是 `[min, max]`；只有 `min = 0` 时两者相同。包围盒中心 `(min + max)/2` 没被用到。【确：汇编；`+0x1b8` / `+0x1c4` 是 min / max 沿用 rea-p5 的读法】
  - **不要求 `t ≥ 0`**：只判 `tmin ≤ tmax`，盒子整个在射线起点后面也算命中（和四边形不同）。
  - `localPosition = o'' + tmin · d'`，即「模型空间里的命中点 − h」，不是模型空间的命中点本身；起点在盒内时 `tmin` 为负。
- 骨骼 vt+0x88（`FUN_1401fd690`）：**成立，补细节**。遍历木偶 `O+0x4b8` 的命中框下标表（`+0x1d8..+0x1e0` 的 int 数组，倒序），每个框取 `+0x1a8` 表（步长 0x4c：`+0x0..+0x8` 半尺寸、`+0xc..+0x48` 3×4 矩阵）乘骨骼矩阵（`+0x340`，步长 0x40）后求逆，把射线变进去对 `[−h, h]` 做 slab，**同样不要求 `t ≥ 0`**；函数**不读图层世界矩阵、不读视差偏移**（第 2 参 `&off` 没用到；骨骼矩阵是否已含世界变换没查）。第一个命中框的骨骼名为空时用下标十进制串（`FUN_140053e40`）。第 5 参 `&local` 没被读写，「不改 `localPosition`」成立。
- 3.5：**成立**。`(O+0x120 >> 14 & 1) && (O+0x120 & 1)` 时：父 `O+0x180` 为空直接 `break`，否则 `FUN_140185010(父)`（自身 bit0 且递归父链）为真 `break`；只在命中分支里。
- 3.6、3.7：没重核（`solid` 由主会话核过）。命中函数里的派发编号只有 8–13，没有 7，与 3.7 一致。

**第 4 节 派发**
- 4.1：**成立**。七处循环条件都是 `node[2] != 0 && (B+0x48 == O || B+0x8 == 0) && (B+0x40 & 位) && B+0x44 == 2`，第一次调用前 `E->vt[0x20]`、结束后 `E->vt[0x28]`，`CallCallback(E, B+0x38, B+0x48, 编号, &D, 0)`；`[ctx+0x1710]+0x118 & 0xc000000` 时整批不调，集合照常更新。**补充**：绑定时插链表的 `FUN_140178e20` 是 `std::list::push_back`（新节点挂到尾部），所以「登记顺序」= `LoadScript` 成功的先后。
- 4.2：**成立**。分支条件精确为「帧初按下集合元素数 == 0 或本帧 `cur == 0`」走悬停态，否则走按住拖动。悬停态命中：不在悬停集合 → 先插入（销毁期也插）再 Enter；`moved` → Move；`cur != prev` → 编号 `(cur ^ 1) | 0xc`，`cur == 1` 时插入按下集合，`cur == 0` 时若对象在按下集合（处理该对象前查得）→ Click。没命中：`cur == 0 && prev != 0 && 在按下集合` → Up；在悬停集合 → 删除并 Leave。顺序与原文一致。
- 4.3：**成立**：`else if (在按下集合 && moved && !销毁期) Move`；不改悬停集合、不 `break`。
- 4.4：**成立，补一个字面**：清按下集合（`FUN_140077f50(G+0x2c0)`）的条件是「帧末 `cur == 0`」，左键一直松着时每帧都清（空集合，无副作用）；令牌只在 `cur == 0 && prev != 0` 那一帧清。

**第 5 节 时机**
- 5.1：**成立**。`FUN_14017fa70`：`g_Time` 推进（> 432000 回绕到 0）→ `FUN_1401891a0(G, dt)` → `FUN_140183a70` → 投影 / 正交 `zoom` 一段 → `if (R+0x1848) FUN_140189e10(G)` → `FUN_140171440(R+0x1718, dt)`。**补充**：其后、渲染前还有 `FUN_14018b390(G)`、`G+0xe0` bit31 时 `FUN_140184020(R)`、`FUN_140190c80(G)`；帧尾 `R+0xa4 ← R+0x9c`、`R+0xb4` bit1 ← bit0。
- 5.2、5.3：**成立**（每帧一次采样；暂停分支在采样前）。

**第 6 节 `input.*`**：世界 / 屏幕两支**成立**（同 2.1、2.2）。`+0xc0`（`0x14018e380`）在 Ghidra 里没被识别成函数（地址区间 `0x14018e010`–`0x14018e380` 只导出了 `e070`、`e1a0`），没重核。

**第 8 节 `openUserShortcut`**：**成立**。`FUN_14018f7d0`：`H+0x98` bit28 为 0 返回 2；为 1 先清位，再按名字查 `ctx+0x1718` 下的用户属性 → `value` → 类型 4 → 解析成四段 → `[ctx+0x1710]+0x158` 的虚函数 +0x108 执行；成功返回 1，其余返回 0（名字查不到也已清位）。置位 / 清位地址与原文一致。

**未查清（能用反编译回答的）**
1. 不变，静态读不出。
2. **部分回答**：`[S+0x60]` 就是建渲染窗口时传的 `hWndParent`（`FUN_140110630` 开头读出、`IsWindow` 后传给 `CreateWindowExW`），`AttachThreadInput(…, FALSE)` 断开的是渲染线程和**父窗口所属线程**。父窗口具体是 WorkerW 还是测试窗口取决于建会话的调用者，没追。
3. **部分回答**：绑定时 `B+0x8` 的虚函数 [1] 被无条件调用来拼脚本名，`LoadScript` 成功后条目才 `push_back` 进链表，所以入链时 `B+0x8` 必不为空；之后有没有代码把它清零没找到。
4. 没查。
5. **已回答**：场景构造 `FUN_140186c90` 把 `G+0x300`（8 字节，上一帧世界 xy）和 `G+0x308`（上一帧左键）清 0。所以场景第一次跑命中时只要世界坐标不恰好是 (0, 0) 就 `moved = true`，命中的对象当帧收 `Enter` + `Move`；`prev = 0`，加载时左键已经按着（且已登记）的话，第一帧当作按下沿（`cursorDown`、令牌置位）。
6. **部分回答**：按对象从悬停集合删除的 `FUN_14019ed60` 只有 `FUN_140189e10` 一个调用者（`procedure_callers`），销毁图层的路径不经它；按下集合只在帧末整体清。悬停集合里被销毁对象的指针最终怎么处理（整体清空的地方）没找到。
7. 没查。
8. 归 dll 文档（dll 这次没能用 REA 打开，见那份末节）。
