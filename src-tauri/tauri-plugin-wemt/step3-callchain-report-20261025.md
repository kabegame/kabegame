# Wallpaper Engine 桌面挂载调查：第 3 步（调用链与行为规格）

日期：2026-10-25（Asia/Tokyo）
目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`
SHA-256：`40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（与第 1、2 步一致）
工具：REA 6.7.0（MCP）/ Ghidra 12.1.4，PE x86_64，image base 0x140000000

范围与限制：纯静态反编译观察；**没有启动 WE、没有注入、没有运行时验证**。伪代码是 Ghidra 反编译产物，不是原始源码；PDB 未加载，类型与函数名是分析器命名。下文的"观察/推断/未知"分别标注。

---

## 1. 结论摘要

1. WE 的桌面挂载不是"渲染窗口直接 SetParent 到 WorkerW"。它有一条内部协议：**容器窗口过程 `FUN_1401287a0` 收到私有消息 `0x404`（wParam=0，lParam=渲染窗口 HWND）后，改写渲染窗口样式、把渲染窗口 `SetParent` 到对象 +0x188 的宿主窗口，并在宿主上做尺寸/位置同步**。（观察）
2. **（已由运行时证据修正）** 对象 +0x188 的宿主就是全局 `DAT_1404e52a0` 指向的 WorkerW，不存在额外的 WE 中间容器层：该 WorkerW 由 explorer.exe 持有、是 Progman 的子窗口、被打上 `WallpaperEngineParent=1`，WE 的渲染窗口（`WPEDesktopDX11Window`，属 wallpaper64.exe）直接作为它的子窗口。详见第 8 节。
3. 宿主在使用前会被**重新校验**：`FUN_14003cb80` 检查 `IsWindow` + 属性，校验通过则 `ShowWindow(host, SW_SHOWNORMAL)` 并返回；失败则把 `DAT_1404e52a0` 清空并返回 0。这解释了"Explorer 重启后旧 HWND 失效必须重新发现"的实现方式。（观察）
4. `TaskbarCreated` 的处理位于 50 KB 事件窗口过程 `FUN_140021e50` 开头：比较 `DAT_1404e80f8`，并再次调用桌面发现 `FUN_14003c840`；该过程同时是 `DAT_1404e52a0` 的第二个写入点。（观察）
5. `DAT_1404e5290` 是"仅在启动期写一次、与 8 比较"的阈值变量，不是可直接映射到 Windows 版本的常量；其取值来源仍未定位。（观察 + 未知）

---

## 2. 挂载协议：`FUN_1401287a0`（容器窗口过程）

Evidence：`ev_9ba92a73d283f70091e1b317f21e28cebedc877317ce686d0211746a807f809f`

对象指针取自 `GetWindowLongPtrW(hwnd, -0x15)`（GWLP_USERDATA）。已知对象字段：

| 偏移 | 含义（观察/推断） |
|---|---|
| +0x140 | 自旋锁/重入标志（手写 busy-wait，非 SRWLock API） |
| +0x144..+0x150 | 目标矩形 left/top/right/bottom |
| +0x170/+0x178/+0x180 | 子窗口 HWND 向量 begin/end/capacity |
| +0x188 | 宿主窗口 HWND（挂载目标） |
| +0x190 | 布尔标志，触发 `FUN_1401282f0` |
| +0x192 | Unity 模式标志 |
| +0xa6 | 位标志；bit1 决定是否登记到全局 `DAT_1404e8d70[16]` 数组 |

### 2.1 消息 0x404（挂载）

伪代码顺序（wParam 必须为 0）：

1. `IsWindow(lParam)` 失败 → 返回 0。
2. 先清理向量中已销毁的 HWND，再查重；已存在 → 返回 0。
3. `GetClassNameW(lParam)`；类名为 `UnityWndClass` 时置 +0x192。
4. 把 lParam 追加进 +0x170 向量（含 capacity 扩容逻辑）。
5. 若 +0xa6 bit1，登记到 `DAT_1404e8d70` 前 16 个空槽/失效槽。
6. 若 `DAT_1404e8d60` 不是窗口 → `EnumChildWindows(GetDesktopWindow(), FUN_140126590, 0)` 重新枚举桌面结构。
7. `host = *(HWND*)(obj+0x188)`；`IsWindow(host)` 失败 → 跳到清理并返回。
8. 非 Unity：
   - `SetWindowLongW(child, GWL_STYLE, (style & 0xde33ffff) | 0x40000000)`
     —— 按位解释（推断）：清 `WS_MINIMIZE|WS_MAXIMIZE|WS_CAPTION|WS_SYSMENU|WS_THICKFRAME`，强制加 `WS_CHILD`；`WS_POPUP` 位被掩码保留但 `WS_CHILD` 已置位。
   - 取对象矩形，`SetWindowPos(host, NULL, left, top, right-left, bottom-top, 0x4324)`。
     `0x4324` = `SWP_NOSIZE?` 否，按位为 `SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED|SWP_NOOWNERZORDER|SWP_NOCOPYBITS|SWP_ASYNCWINDOWPOS`（推断）。
   - `SetParent(child, host)`。
   - `SetWindowPos(child, NULL, 0, 0, w, h, 0x4304)`（同上，去掉 `SWP_FRAMECHANGED`）。
9. Unity：不调用 `SetParent`；仅当 `GetParent(child)==host` 时做尺寸同步。

### 2.2 其它消息

| 消息 | 行为 |
|---|---|
| 0x20 | 直接返回 0 |
| 0x46（WM_WINDOWPOSCHANGING） | `FUN_1400fdcc0` 取矩形，覆盖 WINDOWPOS 的 x/y/cx/cy；随后 `DefWindowProcW` |
| 0x113 且 wParam==100 | 遍历子窗口向量，逐个 `FUN_1401253c0`（刷新/可见性维护，具体语义未知） |
| 0x413 | 从向量移除 lParam；若等于 `DAT_1404e8d70..de8` 任一全局则清空 |
| 其它 | `DefWindowProcW` |

---

## 3. 桌面宿主：发现、校验、重建

### 3.1 发现（第 2 步已确认，本节只补消费关系）

`FUN_14003c840`：`FindWindowW("Progman")` → 必要时 `SendMessageTimeoutW(...,0x52c,...)` → `EnumChildWindows(GetDesktopWindow(), FUN_14003c760, ...)` 找 `WorkerW`+`SHELLDLL_DefView` → 保存 `DAT_1404e52a0` 并 `SetPropW(host,"WallpaperEngineParent",(HANDLE)1)`。

`DAT_1404e52a0` 的 32 个引用归入 6 个函数（Evidence `ev_383482691d33ed2d719be690fae59581501171d30fc7a6944c5bb33e0eec08fa`）：

| 函数 | 角色 |
|---|---|
| 0x14003c840 | 生产者 |
| 0x14001eae0 | 启动：读宿主；`CMP DAT_1404e5290, 8` 分支；调用发现函数 |
| 0x140021e50 | 事件窗口过程：宿主第二写入点 + 重新发现 |
| 0x14002faa0 | 轻量回调：`msg==0x8003 && hwnd==host` → `ShowWindow(host, SW_SHOWNOACTIVATE)`；150 ms 定时器（id 0x6a）防抖后 `PostMessage(0x113,0x68,0x1092)` |
| 0x140068fc0 | 预览/缩略图渲染（见 3.4），把宿主作为渲染上下文传入 `FUN_14005aaf0` |
| 0x140072190 | 以宿主为第 1 参数调用（`0x1400721af: MOV RCX,[host]`） |
| 0x140074da0 | 2.5 s 上限循环：`EnumChildWindows(host, FUN_140062ed0, &rect)` + PeekMessage + vtable 回调（疑似渲染就绪/性能测量），与挂载无关 |

### 3.2 校验与"陈旧宿主"清理

`FUN_14003cb80`（Evidence `ev_3e98be5f7e240ff748d948fac49bdef7c0f5a1eaa38c634b88da90e777e3d148`）：

```
h = DAT_1404e5288                  // 显式覆盖
if (h == 0) {
    if (IsWindow(DAT_1404e52a0) && GetPropW(DAT_1404e52a0,"WallpaperEngineParent") == 1) {
        ShowWindow(DAT_1404e52a0, SW_SHOWNORMAL);
        return DAT_1404e52a0;
    }
    DAT_1404e52a0 = 0;             // 校验失败即丢弃
    return 0;
}
return h;
```

`FUN_14003cb30`（Evidence `ev_0b013e2a72fc40b04bfe36f2fdc0a280570f9aeae2cd60b84bbc3db629df2e91`）是同一条件的布尔版：`DAT_1404e5288 != 0 || (IsWindow(host) && 属性==1)`。

要点（观察）：**属性是宿主身份的一部分**；宿主窗口失效或属性丢失时 WE 会主动清空全局，而不是继续使用。

### 3.3 TaskbarCreated 与重建

- `RegisterWindowMessageW("TaskbarCreated")` 结果存于 `DAT_1404e80f8`（写点 0x14001eb17，比较点 0x140021e82）。Evidence：`ev_2dba6054f21a176b16760eb569cf496427b84ea74ac68fd2d5c8362b3e527c59`
- 事件窗口过程 `FUN_140021e50`（0x140021e50–0x14002e3a5，50,518 字节）是 `WPEventWindow` 的过程；其内部：
  - `0x140022187: MOV [DAT_1404e52a0], R13` ← 宿主第二写入点（`ev_927fe56c1d13a62c1cabcdde7eb94de831e7735f122ebf098d7b72c46594944d`）
  - `0x140023fc4` 处读宿主，`0x140023fcb` 处调用 `FUN_14003c840` 重新发现
  - `DAT_1404e5298`（第二桌面 HWND，图标层相关）在此过程内被写/读（0x14002218e、0x140024013/022）
- 结论（观察 + 部分推断）：TaskbarCreated 会触发"重新发现 → 更新宿主 → 让容器/子窗口重新挂接"的重建路径；**完整重建序列尚未按基本块读完**，不能断言每一步顺序。

### 3.4 排除项：0x140068fc0 不是容器创建者

Evidence `ev_f8670c88d5ab10bd962ff9fa2d7a6ba65855364b03da56f0bce831ece69c0135`。该函数按壁纸条目计算"等比适配矩形"（多显示器/宽高比分支），分配 0xf0 字节对象，做 `FUN_140109ba0`（图像缩放）与 `FUN_14005aaf0(..., DAT_1404e52a0)`（以宿主为上下文的绘制/呈现），并把帧率上限钳到 0x1a（26）。角色为**预览/缩略图渲染**，与 0x404 挂载链无调用关系。

---

## 4. 仍未解决的调用链缺口

| # | 问题 | 现状 |
|---|---|---|
| 1 | 容器窗口（`FUN_1401287a0` 的窗口）由谁创建、类名是什么 | 未定位。`search_strings("Container")` 无结果（Evidence `ev_f06863179bd860265ea5e3f8d5fa82193abeaa42d5267a8eb51f0edd4c9f6d5b`，仅覆盖 Ghidra 已定义字符串，是有限否定）；`CreateWindowExW`/`RtlGetVersion` 不在 Ghidra 名称清单（外部符号命名空间问题，不能据此断言未导入） |
| 2 | 对象 +0x188 的写入点 | 数据流已确认（见第 7 节）：`FUN_14003cb80` 返回值被写入壁纸对象描述符，再由工厂 `FUN_1401048b0` 构造对象；精确 store 指令在基类构造 `FUN_14010a0e0` 内，尚未读取 |
| 3 | 谁发送 0x404、何时发送 | 未定位（发送方可能在主程序控制器代码或渲染子进程协作代码中） |
| 4 | TaskbarCreated 重建的完整顺序 | 只确认比较、宿主重写、再调用发现；未逐块读取 50 KB 过程 |
| 5 | `DAT_1404e5290` 的取值来源 | 仅知启动期写入一次（`0x14000a742`）、启动处与 8 比较（`0x14001edc8`），发现函数中另有 4 处、透明度函数 3 处引用；不能映射到具体 Windows 版本 |
| 6 | Unity 分支的实际语义 | 只知"不 SetParent，仅在已是 host 子窗口时同步尺寸"；外部程序嵌入的完整路径未追 |

---

## 5. 对 tauri-plugin-wemt 的可验证含义（设计输入，非 WE 复刻承诺）

1. **不要假设"SetParent 到 WorkerW 就完成挂载"**。WE 在渲染窗口与桌面层之间保留了独立承载窗口，并让渲染窗口成为该承载窗口的 `WS_CHILD`、定位 0,0、尺寸等于承载窗口。Tauri 若直接挂到 WorkerW，需要自己承担"承载窗口"的布局/尺寸职责，否则会出现内容不随分辨率/缩放更新的问题。
2. **样式改写顺序**：改 `GWL_STYLE` 后必须 `SetWindowPos(..., SWP_FRAMECHANGED|SWP_NOZORDER|SWP_NOACTIVATE)`，否则框架缓存不刷新；WE 两处 `SetWindowPos` 的 flags 正是这个组合（0x4324 / 0x4304）。
3. **宿主身份校验应包含属性或等价的私有标记**，并在 `IsWindow` 失败时清空缓存、重新发现，而不是抛错给调用方。
4. **重建触发点**至少包括 `TaskbarCreated`（Explorer 重启）与显示配置变化；WE 在事件窗口过程内做重新发现。
5. **解绑**沿用第 2 步观察：`FUN_140127d00` 对受管窗口 `SetParent(hwnd, NULL)`，随后发关闭类消息并清理；插件应保存原 parent/style/ex_style/rect 以恢复。
6. 插件不应依赖 `WS_POPUP`/`WS_CHILD` 的"位运算照抄"来保证行为；WE 的掩码是它自身窗口类型的前提，Tauri/WebView2 窗口需要实测后再定常量。

---

## 6. 本步 REA Evidence 索引

| 内容 | Evidence ID |
|---|---|
| 宿主全局 32 处引用 | ev_383482691d33ed2d719be690fae59581501171d30fc7a6944c5bb33e0eec08fa |
| 容器窗口过程 0x404 伪代码 | ev_9ba92a73d283f70091e1b317f21e28cebedc877317ce686d0211746a807f809f |
| 宿主校验布尔版 0x14003cb30 | ev_0b013e2a72fc40b04bfe36f2fdc0a280570f9aeae2cd60b84bbc3db629df2e91 |
| 取宿主并清理 0x14003cb80 | ev_3e98be5f7e240ff748d948fac49bdef7c0f5a1eaa38c634b88da90e777e3d148 |
| 轻量回调 0x14002faa0 | ev_8d9c0d0c0a1ac31a12e88d94bd64ff92f6eb03c1edd086d9a5ff2e714dfd1f5a |
| 预览渲染 0x140068fc0 | ev_f8670c88d5ab10bd962ff9fa2d7a6ba65855364b03da56f0bce831ece69c0135 |
| 渲染就绪循环 0x140074da0 | ev_880cfd0ba5773db69f74393b9b921d5a9a7abef52c838f8842ecce3853129bf7 |
| TaskbarCreated 消息值引用 | ev_2dba6054f21a176b16760eb569cf496427b84ea74ac68fd2d5c8362b3e527c59 |
| 宿主第二写入点 0x140022187 | ev_927fe56c1d13a62c1cabcdde7eb94de831e7735f122ebf098d7b72c46594944d |
| 宿主作为参数 0x1400721af | ev_e90c4db233528dd07826326b9530de418b5d57d37bb6a15b8346484e8d389371 |
| DAT_1404e5290 引用 | ev_35e8d690ecef35967eef3056a11552046d13acfc90d17de4ee125cdb71093638 |
| DAT_1404e5290 写点 | ev_2fe091f441aea05031667c7c912b8c88cfbc467a431b09b8bb05cf602fda2bce |
| DAT_1404e5290 与 8 比较 | ev_777b6f4fa26e1868e9a83bff3cd7877a63d38b39980419b94d8a1eac4c0809f3 |
| DAT_1404e5288（覆盖）引用 | ev_9012338299b51d54351cf44f2e9d7a7787988db8764f27992314ae53af7296d6 |
| DAT_1404e5288 与 0 比较 | ev_6187bd76f4cedd96328853fd55fd709d90950cf07d134134344f38c4c3af8beb |
| DAT_1404e5298 引用 | ev_8093090724a75c3fd323a20f8b42714caeba0a281eaba81e68b2c4726c1f94e2 |
| 0x140068fc0 调用关系 | ev_8f0257991f5bcd018ff0b6bddca3b4404044e5c058838c69c989e9e8e5d7d06d |
| 字符串 Container 检索（空） | ev_f06863179bd860265ea5e3f8d5fa82193abeaa42d5267a8eb51f0edd4c9f6d5b |

（本步新增地址级证据的 `ev_` ID 均为内容寻址，可被同一 SHA-256 目标重新复现；引用时以本表为准。）

---

## 7. 补查（同日续）：宿主如何进入壁纸对象

### 7.1 载入路径把宿主写入对象描述符

`FUN_140072a70`（从 `project.json` 载入壁纸，伪代码 `ev_016616a890e2699396f09e46cff078f867dd8e6bfedb258c17a18d1751f2c89c`）：

```
lVar13 = FUN_14003cb80();                    // 取"有效宿主"，失败返回 0
if (lVar13 != 0 && 条目存在 && !条目已标记) {
    local_1f8 = lVar13;                      // 描述符首字段 = 宿主 HWND
    local_1f0 = DAT_1404e5280;               // 事件窗口
    local_1b8 = *(条目+0xb8);  local_1e8 = *(条目+0xc0);
    local_1b4 = *(条目+0x51);
    local_1b2 = 2;                           // 类型/标志字节
    if (条目集合大小 > 1)                 local_1b2 |= 0x20;
    if (DAT_1404e5288 != 0 && !(flags>>0xf&1)) local_1b2 |= 0x08;   // 覆盖模式
    if (flags>>0xe&1)                     local_1b2 |= 0x10;
    plVar7 = FUN_1401048b0(param_4, &local_1f8);   // 工厂：按类型构造壁纸对象
    ...
}
```

观察：**宿主是通过"壁纸对象描述符"传给对象构造的**，不是构建完后单独赋值；覆盖模式（`DAT_1404e5288`）会在描述符标志里留下 0x08 位。

### 7.2 工厂与容器对象

`FUN_1401048b0(type, descriptor)`（661 字节，11 个基本块，`ev_b0a3886842a7508c585d3eac4ad6bd19576ac62f02fb111c7fb45669977ab602`）：

| type | 分配大小 | 构造 |
|---|---|---|
| 1 | 0x4C0 | FUN_14010db90 |
| 2 | 0x518 | FUN_14010a0e0 + 大量字段初始化（vtable `PTR_FUN_140489bf8`） |
| 3 | 0x198 | FUN_14010a0e0 + `+0x2b = -1`、`+0x192 = 0`（vtable `PTR_FUN_14048a5f0`） |
| 4 | 0x378 | FUN_1400fdeb0 |
| 5 | 0x1A8 | FUN_14010a0e0 + QPC 初始化（vtable `DAT_14048a6f8`） |

type 3 的 0x198 字节与 `+0x192`（Unity 标志）初值 0，正好对上 `FUN_1401287a0` 使用的容器对象布局（+0x188 宿主、+0x192 Unity）。因此：**容器对象 = 类型 3 壁纸对象**，由 `FUN_14010a0e0` 从描述符构造；`+0x188` 的具体 store 指令在该基类构造内（未读）。

### 7.3 壁纸窗口的标记属性

新发现字符串 `WallpaperEngineWallpaper`（0x1404885f8，`ev_d481db80f79a0e761161a55af2674a7ef62eb733ac8c92c2623b902d72712f44`），4 处引用（`ev_7e8a9f817937c4132536523e486e8a78fc542a3ca3c8069979cdd40c88928ade`）：

| 站点 | 所在函数 | 已观察 |
|---|---|---|
| 0x1400ff684 | FUN_1400ff… | 未展开 |
| 0x1401107c8 | FUN_140110… | 未展开 |
| 0x140126e1b | FUN_140126830 | `LEA RDX,[0x1404885f8]`（`ev_47aa603e…`），第 2 参数传入 |
| 0x14012938b | FUN_140129040 | `LEA RDX,[0x1404885f8]`（`ev_e9793332…`），第 2 参数传入 |

推断：与 `WallpaperEngineParent` 同一套属性机制，用于标记/识别壁纸窗口；两处 `RDX = 字符串` 表明第 2 参是属性名（`GetPropW`/`SetPropW` 或等价的 `SetWindowLongPtrW` 名称参数），具体 API 未逐站确认。

### 7.4 补查后仍未闭合

- 0x14010a0e0 内 `+0x188` 的精确赋值语句（数据流已闭合，指令级未读）。
- 0x404 的发送方与触发时机。
- `TaskbarCreated` 分支的逐块顺序（50 KB 过程，未逐块读取）。
- `DAT_1404e5290` 的取值来源。

---

## 8. 运行时验证（第一轮：只读，不注入修改）

环境：Windows 11 实体机，wallpaper64.exe（WE 2.8.0.42）由 Steam 正常启动，桌面上有一个 DX11 壁纸。
只读证据：`windows-snapshot.json`（窗口树）、`tools/inspect_owner_pids.py`（属主解析）、Frida 只读内存读取（`ev_bcb494a6779d1759d2b0d78af89b9dcc561ced4ba9eb1b9fabe35490ad0e8841`）。

### 8.1 实测窗口层级

| HWND | 类名 | 属主 | 父 | 样式 / 扩展样式 | 属性 |
|---|---|---|---|---|---|
| 0x00010172 | Progman | explorer.exe (16584) | — | 0x96000000 / 0x00200080 | — |
| 0x00010178 | SHELLDLL_DefView | explorer.exe | Progman | 0x56010000 / 0x00080000 | — |
| 0x00020176 | SysListView32 | explorer.exe | DefView | 0x56203A40 / 0 | — |
| **0x000E05D0** | **WorkerW** | explorer.exe | Progman | **0x58000000 / 0x080000A0** | **WallpaperEngineParent=1** |
| **0x000C0B60** | **WPEDesktopDX11Window** | **wallpaper64.exe (37492)** | 上述 WorkerW | **0x50000000 / 0x08280000** | **WallpaperEngineWallpaper=1** |

另有两个 WE 顶层窗口：`WPETrayWindow` 0x00160824、`WPEEventWindow` 0x00220AAC（均不可见，style 0x04C00000）。

样式解码（按位，推断）：
- 宿主 WorkerW：`WS_CHILD|WS_VISIBLE|0x08000000`；扩展 `WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW|WS_EX_TRANSPARENT`。
- 渲染窗口：`WS_CHILD|WS_VISIBLE`；扩展 `WS_EX_NOACTIVATE|WS_EX_NOREDIRECTIONBITMAP|WS_EX_LAYERED`。

**关键校验**：把第 2 节的挂载公式作用于改造前样式 `0x10000000`（WS_VISIBLE 顶层）：
`(0x10000000 & 0xde33ffff) | 0x40000000 = 0x50000000`，与实测渲染窗口样式**完全一致**。这同时确认：0x404 的 `param_4` 就是 `WPEDesktopDX11Window`，而 `+0x188` 就是那个 WorkerW；此前"渲染窗口→WE 容器→WorkerW"的两层推断被否定。

### 8.2 静态全局 vs 运行时值（同一进程，ASLR base 0x7ff7d1db0000）

| 静态符号 | 运行时值 | 与窗口树对照 |
|---|---|---|
| `DAT_1404e52a0` | 0xE05D0 | 即宿主 WorkerW，**直接可辨** |
| `DAT_1404e5298` | 0x10178 | 即 `SHELLDLL_DefView`（图标视图），不是 SysListView32 |
| `DAT_1404e5280` | 0x220AAC | 即 `WPEEventWindow` |
| `DAT_1404e5288` | 0 | 未启用显式父窗口覆盖 |
| `DAT_1404e5290` | **11** | 见 8.3 |
| `DAT_1404e80f8` | 0xC0B9 | `RegisterWindowMessageW("TaskbarCreated")` 的实际消息号（会话内） |
| `DAT_1404e52e0` | 0 | 非 2，未走预览渲染分支 |
| `DAT_1404e52e4` | 0x271800 | 功能位掩码 |
| `DAT_1404e8d60` / `0x4e8d70` | 0 / 0 | 未使用独立桌面枚举缓存 |

### 8.3 `DAT_1404e5290 = 11` 的含义修正

启动处与 8 比较、发现函数里与 10 比较，实测该机为 **11**。因此它是"单调递增的能力/环境等级"，**不是**"Windows 10 → 10"这类直接映射；在没有多台不同版本机器对照前，不应把它写成版本号。

### 8.4 挂载链的最终形态（观察）

```
Progman (explorer)                      ← WE 向其发送 0x052C，使 Explorer 生成背景 WorkerW
└─ WorkerW 0x000E05D0 (explorer)        ← WE 发现、调整尺寸、打 WallpaperEngineParent=1
   └─ WPEDesktopDX11Window 0x000C0B60   ← wallpaper64.exe 创建；0x404 后成为 WS_CHILD，样式 0x50000000
```
即：**渲染窗口直接是 WorkerW 的子窗口**，WE 没有中间承载窗口；`DAT_1404e52a0` 与对象 `+0x188` 是同一个 HWND。

### 8.5 本轮仍未验证

- 0x404 的发送方与精确时机（需 hook `SendMessageW/PostMessageW`，并切换壁纸触发）。
- `TaskbarCreated` 重建序列（需受控重启 explorer）。
- 多显示器/DPI 变化下的矩形计算（需改显示配置）。
- 以上都属 WE 内部实现细节；对插件实现而言，8.4 的层级与样式已足够作为设计基线。

---

## 9. 运行时验证（第二轮：注入观测，切换壁纸）

手段：Frida 17.23.2 attach 到 wallpaper64.exe，仅读取参数（不修改）。钩子：`FUN_1401287a0` 入口、`FUN_14003cb80` 返回值、`FUN_14003c840` 入口、user32 `CreateWindowExW` / `DestroyWindow` / `SetParent` / `SendMessageW` / `PostMessageW` / `SendMessageTimeoutW`。
证据：`ev_962ee0ab…`、`ev_9ba10be9…`、`ev_aa2c119c…`、`ev_14708849…`（会话消息）、`ev_621c4752…`。

### 9.1 一次切换的实测事件序列（按发生顺序）

| # | 事件 | 关键参数 | 调用者（模块+偏移） |
|---|---|---|---|
| 1 | `CreateWindowExW` 类原子 0xC306 | ex `0x08080000`，style **`0x40000000`(WS_CHILD)**，0,0, **3840×2160**，**parent=0xE05D0** | `+0x126D85` → FUN_140126830 |
| 2 | `CreateWindowExW` 类原子 0xC327 | ex `0x08280000`，style `0x40000000`，0,0, 3840×2160，**parent=0xE05D0** | `+0x110775` → FUN_140110630 |
| 3 | `PostMessageW` **0x404** → 容器窗口，lParam=子窗口 | wParam=0 | `+0x1262A1` → FUN_140125440 |
| 4 | `FUN_1401287a0` 收到 0x404 | 同一 hwnd / wParam / lParam | USER32 分发 |
| 5 | `FUN_1401287a0` 反复收到 0x113（wParam=0x64=100） | — | USER32 定时器 |
| 6 | `DestroyWindow(容器)` | — | `+0x12774E` → FUN_1401276E0 |
| 7 | `SetParent(child, **NULL**)` ×2 | — | `+0x128163` → **FUN_140127D00**（第二步已识别为解绑/清理） |

### 9.2 与静态分析的对齐

- **0x404 的发送方定位**：`+0x1262A1`，位于 `FUN_140125440`；消息用 `PostMessageW`（异步），wParam 恒为 0，lParam 是被挂接的子窗口。
- **0x404 的接收方确认**：`FUN_1401287a0` 确实收到该消息——即第 2 节那条"样式改写 + SetParent"路径是**真实执行**的，不是死代码。
- **容器窗口创建者**：`FUN_140126830`（`+0x126D85`）；该函数正是引用字符串 `WallpaperEngineWallpaper` 的函数（0x140126E1B），与其"创建并打标"的角色一致。
- **渲染窗口创建者**：`FUN_140110630`（`+0x110775`），创建时即传 `hWndParent=0xE05D0` 且 style 已含 `WS_CHILD`——**主窗口不需要事后 SetParent**。
- **销毁/解绑**：`FUN_1401276E0`（销毁）+ `FUN_140127D00`（`SetParent(child,NULL)`），与第二步"清理函数"结论一致。

### 9.3 重要修正：0x404 用于"临时容器"，不是桌面主窗口

切换后稳定下来的 `WorkerW` 子树只有一个子窗口（`WPEDesktopDX11Window` / `WPEVideoWallpaper`，随壁纸类型变化），**没有** 0x404 装出来的容器残留。第 9.1 表中的 0xC306 容器在数秒内被销毁，且尺寸为整屏 3840×2160。因此：

- **桌面主渲染窗口**：创建时即 parent=WorkerW + `WS_CHILD`，一次建成，长期存在；切换壁纸时销毁重建，**不走 0x404**。
- **0x404 路径**：用于临时容器（推断为预览/缩略图或嵌套 surface 的装配），生命周期短。
- 第 8.4 节的"单层"结论对**桌面主窗口**成立；第 2 节的 0x404 协议对**临时容器**成立。两者不矛盾，但此前把 0x404 当成主挂载入口是不准确的。

### 9.4 DPI 修正（影响坐标计算）

本轮枚举脚本默认 DPI-unaware，Windows 对坐标做了虚拟化：读数为 2560×1440。对进程设置 `PER_MONITOR_AWARE_V2` 后实测：

```
screen = 3840×2160, system_dpi = 144 (150%), monitor = work = 0,0,3840,2160
host WorkerW rect (DPI-aware) = 0,0,3840,2160
```

即：**显示器是 3840×2160 @150%，WE 全程使用物理像素**；它创建的窗口就是 3840×2160。之前报告中 2560×1440 的数字必须按"虚拟化读数"理解。插件必须声明 per-monitor DPI 感知，否则用它自己的逻辑坐标去 SetWindowPos 会得到 2/3 大小。

### 9.5 本轮确立的实现基线（可直接照做）

1. 向 `Progman` 发 `0x052C`（`SendMessageTimeoutW`），使 Explorer 生成背景 `WorkerW`。
2. 枚举 `Progman` 子窗口，取"带 `SHELLDLL_DefView` 的 Progman 之外、整屏尺寸、`WS_CHILD`"的 `WorkerW`，并 `SetPropW(...,"WallpaperEngineParent",1)` 做标记。
3. 渲染窗口：`SetParent(hwnd, host)`；样式加 `WS_CHILD`、去标题/边框/最小化/最大化；尺寸按**物理像素**整屏；`SWP_FRAMECHANGED|SWP_NOACTIVATE|SWP_NOZORDER`。
4. 解绑：`SetParent(hwnd, NULL)` 后恢复原样式/位置；不要依赖旧的 host HWND，先 `IsWindow` + 属性校验。
5. 重新发现：`TaskbarCreated`（消息号 `RegisterWindowMessageW` 返回值，本轮实测 0xC0B9）与显示配置变化后重建。



