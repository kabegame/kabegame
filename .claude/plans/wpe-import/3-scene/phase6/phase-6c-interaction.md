# P6c — 交互（子计划）

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)「P6c — 交互」。P6a、P6b 已提交（P6b 最后一笔 `45e1cb89`）。
> 语料是 2026-11-14 在 HEAD `45e1cb89` 快照上的扫描（`ignore/p6/c0/corpus-head.json`，183 个工程，能渲染 92 张）；光标回调与 `input.*` 的细节读 `ignore/p6/c0/cursor.json`，脚本在 `ignore/p6/c0/`（`ana.py`、`scan_cursor.py`、`ana2.py`）。现状锚点取自 HEAD `45e1cb89`。
> 分步：步骤 0 只调研；之后每步能单独验收、单独提交。各实现步骤的细节在步骤 0 之后补写。P5d、P10b、P11b、P13 在别的会话进行，`script/api.ts`、`script/runtime.ts`、`compile/scriptApi.ts` 工作区里有别人没提交的改动，实现步骤动工前再核对一次共享文件。

## 总体设计思路

交互在 WPE 里是两样东西：一组导出回调（`cursorEnter` / `Leave` / `Move` / `Down` / `Up` / `Click`，另有覆盖命中的 `cursorHitTest`），和一个全局对象 `input`（`cursorWorldPosition`、`cursorScreenPosition`、`cursorLeftDown`）。回调参数是 `CursorEvent`，WPE 的类型声明里只有 `worldPosition` 与 `localPosition` 两个成员在用。回调按对象派发：图层自己的脚本收到「光标进出、按下、抬起、点击了这个图层」，所以要命中测试；图层的 `solid` 字段声明「为 true 时触发光标事件」。

所以 P6c 的形态是：宿主把指针的移动与左键按下 / 抬起交给渲染器，渲染器每帧按 WPE 的规则做一次命中测试，比较上一帧的命中结果，派发进出、移动、按下、抬起、点击，再维护 `input`。指针换算复用 P4c 的 `sceneCursor` / `pointerScenePoint`，桌面靠已有的鼠标转发，预览在可交互时 iframe 本来就收指针事件。

语义要靠步骤 0 定，计划里先不猜。语料给了几条硬约束：
- 带光标回调的 575 段脚本里 544 段挂在**没写 `solid`** 的图像层、文本层上，所以 `solid` 的缺省值必须让这些图层能被命中（或者命中根本不看 `solid`）。
- 75 段挂在 `visible: false` 的图层上（看不见的按钮），隐藏图层收不收事件直接决定这些场景能不能用。
- 没有场景导出 `cursorHitTest`；`CursorEvent` 只用到 `worldPosition`（106 段）。
- 回调挂在 `scale`（282）、`visible`（139）、`origin`（119）、`alpha` 等字段的脚本上，没有挂在 general 上的。

## 范围与解锁

用到 P6c 的 50 张（报 `script:callback:cursor*` 或 `script:api:input.*`）：

| 键 | 场景数 |
|---|---|
| `script:callback:cursorClick` | 38 |
| `script:callback:cursorDown` | 33 |
| `script:callback:cursorUp` | 31 |
| `script:callback:cursorMove` | 28 |
| `script:callback:cursorEnter` / `cursorLeave` | 27 / 27 |
| `script:api:input.cursorWorldPosition` | 19 |
| `script:api:input.cursorLeftDown` / `cursorScreenPosition` | 2 / 2 |

**只差 P6c 的 11 张**（能渲染 92 → 103）：`3146703458`、`3173418061`、`3340707146`、`3451555874`、`3460973721`、`3605722997`、`3637191856`、`3809965824`、`3810092560`、`3817779853`、`3832004152`。总计划（165 张口径）估的是 2 张，后来的 P4、P5、P6b、P7–P11 把这些场景上的别的键清掉了。

再差 1–2 项的 6 张：4 张差 `script:api:object.getAnimation`（P10b，别的会话在做），`2964778792` 差 puppet，`3509243656` 差透视文本与 `createLayer`。

**P6c 不做：**
- `openUserShortcut`（只能在光标回调里调）：现在报 `script:api:engine.openUserShortcut`，P11 的用户快捷方式一起做。
- 别的鼠标键、滚轮：WPE 的声明里 `button` 注释为「总是 0，没有用」。

## 现状锚点

**a. 宿主只收 `pointermove`**（`main.ts:45`）
```ts
document.addEventListener("pointermove", (event) => {
  pointer.move(event.clientX / innerWidth, event.clientY / innerHeight); // 现状：没有 pointerdown / pointerup
});
```

**b. 光标回调都照报**（`compile/scriptApi.ts:503`）
```ts
export const MISSING_SCRIPT_CALLBACKS: readonly string[] = [
  // …
  // 光标命中与事件 → P6c
  "cursorHitTest", "cursorEnter", "cursorLeave", "cursorMove", "cursorClick", "cursorDown", "cursorUp",
  // …
];
```

**c. 整个 `input` 都没有**（`compile/scriptApi.ts:110`）
```ts
  /** 整个 `input` 都没有（W4）。 */
  input: fields(["cursorWorldPosition", "cursorScreenPosition", "cursorLeftDown"]),
```

**d. 运行时只调四个回调**（`script/runtime.ts:28`）
```ts
export const RUNTIME_CALLBACKS = ["init", "update", "applyUserProperties", "destroy"] as const; // 现状：工作区里 P10b 加了 animationEvent
```

**e. `solid` 是能力表里的中性键**（`compile/features.ts` 的 `SUPPORTED_OBJECT`），脚本侧的 `layer.solid` 在缺口表里（`compile/scriptApi.ts` 的 `layer` 字段）。

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

见上「范围与解锁」与「总体设计思路」的硬约束。

### 0b — 读码（两个代理并行）

- `rea-p6c-dispatch.md`（exe 侧）：输入从哪来、光标位置、命中测试、派发与时序。工作文件 `ignore/p6/rea/cursor/exe/`。用 REA 打开 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot`，REA 不可用时用 `ignore/p4/rea/wp.asm` 切片。
- `rea-p6c-script.md`（`scenescript64.dll` 侧与两边的接口）：`CursorEvent` 怎么构造、`input` 全局对象、`solid` 的读写、`cursorHitTest` 的返回值、作用域限制。工作文件 `ignore/p6/rea/cursor/script/`。只用 `llvm-objdump` 与脚本，不占 REA 会话。

两份重叠的地方各写各的，0c 实测时以 WPE 的实际行为为准。

目标 `wallpaper64.exe` 2.8.42（SHA-256 前缀 `40e2ce021e935232`）、`bin/scenescript64.dll`（`58039ef912fcd51c`）。要回答：
1. **输入来源：** 桌面壁纸怎么拿到鼠标（低级钩子、Raw Input、`GetCursorPos` 轮询、窗口消息）；`-control openWallpaper` 开的窗口化测试窗口走哪条；左键按下 / 抬起从哪来；光标在别的窗口上（被遮住、桌面图标上）时还派不派发。
2. **光标位置：** 回调与 `input.cursorWorldPosition` 的世界坐标怎么算，和 P4c 的指针反投影（`pointerScenePoint`）、P5a 的视差点、`g_PointerPosition` 是不是同一个量；`cursorScreenPosition` 的像素是窗口坐标还是场景坐标、原点与 y 方向；`localPosition` 是相对图层的什么（原点、四边形左上、是否除以尺寸、是否经过图层的旋转缩放）。
3. **命中测试：** 哪些对象参与（图像、文本、粒子、声音、模型、组）；`solid` 的缺省值与各类对象上的意义；用四边形（含 `alignment`、父链变换、`perspective`）还是纹理 alpha；隐藏图层、`alpha` 为 0 的图层、被父层隐藏的图层参不参与；层叠时只给最上面一个还是给所有命中的；`cursorHitTest` 导出时怎么覆盖（返回值类型、调用时机）。
4. **派发：** 每个回调在哪些脚本上调（命中图层上挂的全部字段脚本、只有某一段、还是全场）；`cursorMove` 是只给命中的图层还是全部；`cursorEnter` / `cursorLeave` 的判定（比较上一帧的命中集合？最上面一个变了就算？）；`cursorDown` / `Up` / `Click` 的关系（按下与抬起在同一个图层才算点击？拖出再抬起？按下时没命中？）；`cursorUp` 是给按下的图层还是抬起处的图层。
5. **时机：** 回调在一帧里的什么位置（`update` 之前还是之后、动画与粒子之前还是之后），一帧里多次移动、多次点击怎么排（合并还是逐个），回调里写的字段当帧还是下帧生效。
6. **`input.*`：** 三个字段的类型（`Vec3` / `Vec2` / 布尔）、每帧更新还是事件驱动、`cursorLeftDown` 只看左键吗、光标离开窗口后的值；模块顶层访问时报什么错。
7. **`solid` 的脚本读写：** `thisLayer.solid` 读回什么、写入生效时机；文本、粒子层上有没有这个字段。
8. **别的：** `openUserShortcut` 的「只在光标回调里、每次点击最多一次」怎么判定（只记下来，P6c 不做）；暂停时派不派发。

产出照以前的读码文档：概括、元数据（目标哈希、方法、工作文件）、逐题结论带地址与置信度（【确】/【推】）、未查清的列表、建议的实测。

### 0c — 确定性工程与实测（Claude）

- **测试手段先定：** 不移动用户的鼠标（P4c 的约定）。先试给 MCP 开的测试窗口发 `WM_MOUSEMOVE` / `WM_LBUTTONDOWN` / `WM_LBUTTONUP`（`PostMessage` / `SendMessage`），看测试工程的 `cursor*` 回调与 `input.*` 有没有反应；不行再按读码的输入来源找别的办法（比如只能经钩子收的，就只能人工点）。这一条决定 0c 和后面的验收能不能自动化。
- **工程：** 测试工程的脚本用 `console.error` 把回调名、参数、`input.*`、帧号写进 WPE 的 `log.txt`（`[kbp]` 日志），两边逐帧比。按读码的结论分组：重叠图层、隐藏图层、带旋转缩放与 `alignment` 的图层、`solid` 显式 true / false、文本层、粒子层、拖出再抬起。
- **我们这边：** dev 探针按同一串指针事件回放，取同样的日志。

### 步骤 0b 实施记录（2026-11-14）

读码在 [rea-p6c-dispatch.md](rea-p6c-dispatch.md)（exe）与 [rea-p6c-script.md](rea-p6c-script.md)（dll），代理写，没有实测。两份都**没用上 REA**：exe 代理导入快照两次都在 330 s 的启动时限内没分析完（运行中的 REA 用的是 330000，`~/.claude.json` 里写的 900000 没生效），改读 `wp.asm` 切片；dll 代理按分工只用 `llvm-objdump`。REA 修好后重核关键函数。

**我核对过的**（`wp.asm` 加自写的导入表解析 `scratchpad/iat.py`）：
- `0x1401115a8` / `0x1401115b1`：IAT `0x140426940` 是 `GetCursorPos`、`0x1404267f8` 是 `GetKeyState`，参数 `r14d` 在这个函数里只被赋过 1（`VK_LBUTTON`），之后 `shr eax, 8; test al, 1`。光标与左键都是每帧轮询。
- `0x1401ddc72`：基类构造 `mov word ptr [r14 + 0x120], 0x2001`，`solid`（bit13）缺省为真。
- 命中循环 `0x14018a024`–`0x14018a40b`：倒序遍历，先 `test [r15 + 0x120], 0x2000`（`solid`），再按虚函数 +0x60 只留类型 1 / 4 / 5，`0x80` 选透视射线；循环头没有读可见位。
- `0x14018a86f`–`0x14018a899`：`bt ax, 0xe`（`disablepropagation`）且 `test al, 1`（可见）且父链可见（`FUN_140185010`）才跳到循环出口 `0x14018a411`。

**结论摘要**（详见两份读码）：
- **输入：** 每帧 `GetCursorPos` 与 `GetKeyState(VK_LBUTTON)`；按下只在 `WindowFromPoint` 是本渲染窗口或桌面类窗口（图标层、`Progman` 等）时登记，松开在哪都登记；移动不设门。渲染窗口的窗口过程不处理 `WM_LBUTTONDOWN / UP`，所以给测试窗口发窗口消息无效（推断）。一帧里完整的一次按下抬起会丢。
- **位置：** `worldPosition` 与 `input.cursorWorldPosition` = NDC `(2px − 1, 1 − 2py, 0)` 经本帧 `inverse(V·P)`，正交时 z 置 0；`cursorScreenPosition` 是窗口客户区像素；`localPosition` = 四边形左上原点、y 向下、单位 `size`。
- **命中：** 图像、文本、模型参与，`solid` 缺省真；射线对平行四边形（双面、不看纹理 alpha）；**不看可见性**；层叠时全部命中的对象都收事件，自上而下，只有可见且 `disablepropagation` 的对象挡住下面（语料 2228 处都是 `false`）；`cursorHitTest` 没有调用点，导出它只打开拾取。
- **派发：** 命中对象上挂的全部脚本（各字段各一段），按登记顺序，只调导出了该回调、`init` 跑完的。进出按集合判；按下集合里的对象在松开那帧命中才有 `cursorClick`；按住拖动期间只给按下集合发 `cursorMove`、不发进出；`cursorMove` 比的是世界坐标，相机在动时光标不动也发。
- **时机：** 相机更新之后、脚本函数（媒体、关键帧动画、计时器、`update`）之前；只在有脚本导出光标回调时才跑；暂停时不采样不派发。
- **事件对象：** 每次新建，`button`（0）、`worldPosition`、`localPosition`（`Vec3` 原型、float32），木偶模型命中骨骼时另有 `hitBox`。`input` 三个成员每次读现问 exe，模块顶层访问抛 `SyntaxError`。

### 0c-1 — 测试手段：wpe-renderdoc 的输入驱动（Frida，2026-11-14 用户定 A，并入 MCP）

#### 总体设计思路

WPE 的场景每帧在渲染线程上调一次 `GetCursorPos`、一次 `GetKeyState(VK_LBUTTON)`，左键刚按下时再调 `WindowFromPoint` 过门（读码第 1 节）。所以不动用户的鼠标也能测：用 Frida 挂进 WPE，**只在测试窗口那一条渲染线程上**改这三个函数的返回值，按帧喂一串写好的光标位置与左键状态。桌面壁纸在另一条线程上，不受影响。

线程按「对本窗口的渲染窗口调 `ScreenToClient` 的线程」认，不按窗口所属线程认：实测测试窗口的轮询线程正好是渲染窗口的所属线程，但桌面壁纸的轮询线程（568104）和它渲染窗口的所属线程（513896）不是同一条。时间线第 i 项给这条线程认出之后的第 i 次 `GetCursorPos`，即第 i 帧；位置用渲染窗口客户区的归一化坐标，每帧按 `ClientToScreen` / `GetClientRect` 现算屏幕坐标（窗口被拖动也对）。`WindowFromPoint` 在这条线程上一律返回渲染窗口：测试窗口不一定在最上面，真实的 `WindowFromPoint` 会返回盖在上面的别的窗口，按下就登记不上。

另有录制模式：同样只挂这一条线程，但不改返回值，逐帧记下真实的光标（换成归一化坐标）与左键，得到同格式的时间线。人在测试窗口上点一遍、录下来，之后 WPE 回放（播放模式）和我们的 dev 探针都用这一份。

Frida 放进 MCP 目录下一个独立的小 uv 工程 `frida_input/`，MCP 拉起它做子进程，经 stdin / stdout 的 JSON 行通信。不加进 MCP 自己的依赖：MCP 由 `uv run` 启动、每次按锁文件同步，改 MCP 的依赖会让下一次启动重装项目本身、覆盖别的会话正在运行的入口 exe；子进程也把 Frida 的原生代码和 MCP 隔开，子进程退出时 Frida 自动卸掉脚本（钩子随之撤销）。

可行性已在 `ignore/p6/c0/frida/` 验证（`count.py` 只读计数、`drive.py` 驱动，工程 `ignore/p6/c0/proj/p6c-probe`）：时间线与场景回调逐帧对齐（时间线第 i 帧 = 场景第 2187 + i 帧），进入、移动、按下、抬起、点击、离开、「空白处按住拖进来再松开只有 `up`」都和读码一致；挂钩期间用户真实的鼠标移动不影响测试窗口。

#### 现状锚点

**a. 测试窗口只有开、关、抓帧、改属性**（`mcp_server/server.py` 的 `open_wallpaper` / `close_wallpaper` / `capture` / `apply_properties`），没有输入。

**b. 日志游标的 `created` 是纳秒整数**（`mcp_server/wpe/log.py:29`、`:88`）
```python
def _created_ns(st: os.stat_result) -> int:
    return getattr(st, "st_birthtime_ns", None) or st.st_ctime_ns   # 现状：19 位整数，超过 JS 的安全整数
# since()：
if cursor.get("created") is not None and now["created"] != cursor["created"]:   # 现状：游标经 MCP 客户端来回一趟丢了精度，误判「重写过」
```

#### 点 1 — 驱动子进程（新增 `frida_input/`）
- **新增** `frida_input/pyproject.toml`：`requires-python >= 3.10`，依赖 `frida>=17,<18`，不打包（`[tool.uv] package = false`）；`uv.lock` 一并生成入库。
- **新增** `frida_input/driver.py`：`python driver.py --pid <WPE pid> --hwnd <渲染窗口 hwnd> --mode play|record`。
  - 启动后从 stdin 读第一行：`{"timeline": [...]}`（play）或 `{}`（record）。
  - attach WPE，加载 JS（照 `ignore/p6/c0/frida/drive.py`；Frida 17 用 `Process.getModuleByName('user32.dll').getExportByName(…)`）：
    - `ScreenToClient` 的 `onEnter`：第一个参数等于目标 hwnd 时记下 `threadId`（只记一次）；
    - `GetCursorPos` 的 `onLeave`（只在该线程、返回非 0 时）：帧号 +1；play 写入时间线这一帧的屏幕坐标（超出末尾停在最后一项），record 读出真实坐标换成归一化坐标记下；
    - `GetKeyState` 的 `onLeave`（该线程、参数为 1）：play 按这一帧返回 `0xff80` / `0`，record 记下 `(ret & 0x8000) != 0`；
    - `WindowFromPoint` 的 `onLeave`（该线程，只在 play）：返回目标 hwnd。
  - stdout 每行一个 JSON：认出线程后 `{"event": "ready", "tid": …}`（2 s 内认不出就 `{"event": "error", "message": …}` 并退出）。
  - stdin 后续命令：`{"cmd": "state"}` → `{"event": "state", "frame": …, "played": 时间线是否放完}`；`{"cmd": "stop"}` → 卸载脚本、detach，输出 `{"event": "stopped", "frames": …, "log": [...]}` 后退出。`log` 每帧一项：play 是 `[帧, 屏幕 x, 屏幕 y, down]`，record 是 `[x, y, down]`（归一化，就是时间线格式）。stdin 关闭也按 stop 处理。
  - WPE 进程退出、attach 失败：输出 error 行并退出。

#### 点 2 — MCP 侧（新增 `mcp_server/wpe/input.py`，修改 `server.py`、`session.py`）
- **新增** `input.py`：
  - 时间线校验：每项 `[x, y, down]` 或 `[x, y, down, n]`（重复 n 帧），x / y 有限数，down 是布尔或 0 / 1，n 正整数；展开后 1…100000 帧。
  - 找渲染窗口：本会话窗口表里该窗口的 hwnd 下，类名 `WPEDesktopDX11Window` 的子窗口（`EnumChildWindows`），找不到报错；WPE pid 取它的所属进程。
  - 每个窗口至多一个驱动；子进程用 `uv --directory <frida_input> run python -X utf8 driver.py …` 拉起，读到 `ready` 才返回。
  - `start(window, mode, timeline)`、`status(window)`、`stop(window, out)`：`stop` 返回帧数与摘要（play：首末几帧的应用值；record：时间线），`out` 给了就把完整 `log`（record 时就是时间线）写成 JSON 文件（路径要是绝对路径，不能在 WPE / Steam 目录里）。
  - `play(window, timeline, tail, log_grep)`：一步做完「取日志游标 → start(play) → 等放完再等 `tail` 秒 → stop → 读日志（`log_grep` 过滤）」。等待上限按「时间线帧数 ÷ 5 帧/秒 + 30 s」防挂死。
  - MCP 退出时（`atexit`）停掉全部驱动；`close_wallpaper` 先停掉该窗口的驱动。
- **修改** `server.py`：登记工具 `input_play(window, timeline, tail=1.0, log_grep=None, out=None)`、`input_start(window, mode="play", timeline=None)`、`input_status(window)`、`input_stop(window, out=None)`，docstring 写清时间线格式、帧对齐、只影响本窗口那条线程、record 的用法。服务说明里加一段「输入」。
- 只操作本会话的窗口（同 `apply_properties` 的检查）。

#### 点 3 — 日志游标的 `created`（修改 `mcp_server/wpe/log.py`）
- **修改** 游标里的 `created` 改成字符串（十进制纳秒）；比较时两边都转成整数，差超过 1 ms 才算变了（兼容旧的整数游标经客户端丢精度）。

#### 点 4 — 文档
- **修改** `README.md`、`.claude/skills/wpe-renderdoc/SKILL.md`：新增「输入（光标与左键）」一节：原理（只挂本窗口那条线程、桌面壁纸不受影响）、时间线格式与帧对齐、play / record、`input_play` 一步用法、注意事项（WPE 暂停时帧不前进；一帧内的按下抬起会被 WPE 丢掉，所以时间线里按下至少持续 1 帧；第一次用会经 uv 下载 Frida）。

#### 验收（Claude）
- `frida_input` 用 `uv` 能装上，`driver.py` 对 `p6c-probe` 的测试窗口重跑 `tl-probe.json`，场景日志与本次探针逐帧相同（进入、移动、按下、抬起、点击、离开、拖入只有 `up`）。
- record：人在测试窗口上点几下，录出的时间线再 play 一遍，场景回调序列相同。
- 桌面壁纸线程的 `GetCursorPos` 返回值不变（另起只读计数核对）。
- MCP 重连后 `input_play` 走一遍；`close_wallpaper` 停驱动；`log_since` 用经客户端回传的游标不再误判。

### 0c-1 实施记录（2026-11-14）

sonnet 代理按上面的计划实现，我核对后验收。

**改动**（都在 `.claude/mcps/wpe-renderdoc/`，另有 `.claude/skills/wpe-renderdoc/SKILL.md`）：
- 新增 `frida_input/`（`pyproject.toml`、`uv.lock`、`.gitignore`、`driver.py`），Frida 17.26.3；MCP 根目录的依赖没动。
- 新增 `mcp_server/wpe/input.py`：不依赖窗口表的内部函数（`validate_timeline`、`compress`、`find_render_window`、`launch` / `Driver`、`run_play` 等），外面薄薄一层按本会话窗口检查的 `start` / `status` / `stop` / `play`；子进程用 `uv --directory frida_input run python -X utf8 driver.py …` 拉起，结束用 `taskkill /T`（uv 下面还有一层 python）。
- `server.py` 登记 `input_play`、`input_start`、`input_status`、`input_stop`，退出时停掉全部驱动；`close_wallpaper` 先停该窗口的驱动。
- `log.py`：游标的 `created` 改成十进制字符串，两边转整数、差超过 1 ms 才算变了。
- 代理自己定的：`timeline` 参数类型是 `list[list[Any]]`（写成 float 会让 pydantic 把 `n` 转成浮点）；record 的结果是压缩时间线（连续相同的帧合成 `[x, y, down, n]`，6 位小数，可以直接喂给 `input_play`），内联最多 400 项、超出用 `out`；`out` 要绝对路径、不能在 WPE / Steam 目录里。

**我核对的：**
- 范围：只动了上面这些文件。改过的几个文件工作区是 CRLF，属性 `eol=lf`，提交时规范成 LF，`diff --stat` 只算实际改动。
- 读了 `driver.py` 的钩子：四个钩子都按 `ScreenToClient` 认出的线程过滤，record 不挂 `WindowFromPoint`、不改返回值。
- 经 `input.run_play` 对 `p6c-probe` 重放 `tl-probe.json`（窗口 `kb-551520-23`）：回调序列与偏移（enter+move 0、move +5、down +10、up+click +15、leave +20、enter+move +27、up +30、leave +32）和 0c 探针逐帧相同，世界 / 局部坐标的值也相同；读日志的游标判为 valid（`log.py` 的修复生效）。
- 播放进行中另挂只读脚本（`ignore/p6/c0/frida/check_desktop.py`）：测试窗口的线程 40 次全是喂进去的 (1145, 899)，桌面壁纸的线程 40 次全是真实光标。
- 没有残留的 `driver.py` 进程；测试窗口已关。
- 还没做：MCP 重连后经工具本身走一遍；人点一遍录下来再回放（record 只录过静止 / 用户自己在动的光标，格式对）。

### 0c 实测记录（2026-11-14，wpe-renderdoc `input_play`）

四个确定性工程（场景 1920×1080 正交，测试窗口 1280×720），生成脚本 `ignore/p6/c0/make_hit.py`、`make_cam.py`，时间线 `ignore/p6/c0/frida/tl-*.json`（段落表 `tl-*-segs.json`），WPE 日志截在 `ignore/p6/c0/out/wpe-{hit,par,shake,zoom}.log`（`cut_log.py`），按段落归组用 `by_seg.py`。每段脚本导出全部光标回调，日志 `[kbp6c] f=<本段 update 次数> <层.字段> <回调> w=… l=…`。**读码（含 REA 更正）全部成立**，下面是逐项结果。

**`p6c-hit`**（时间线 169 帧，回调帧 = 时间线帧 + 409，所有回调都落在段首那一帧）：
- 重叠的 A（上）、B（下）：两个都收到，先 A 后 B；A 身上的两段脚本（`origin`、`scale`）每个回调都各调一次、按登记顺序；同一帧里按对象依次派发（A 的 enter、move 都发完才轮到 B）。
- 按下 / 抬起 / 点击：A、B 都收到 `down`、`up`、`click`。
- 隐藏的 H：`enter`、`move`、`down`、`up`、`click` 全有。`solid: false` 的 NS：什么都没有。
- 可见且 `disablepropagation` 的 D1 挡住 D0；移到只在 D0 上：D1 `leave`、D0 `enter`；回到重叠处：D1 `enter`，D0 **不收** `leave`（被挡住的这一帧不处理）；移出去两个都 `leave`。隐藏的 D2 开了 `disablepropagation` 也不挡，D2、D3 都 `enter`。
- R（`scale 1.5 1 1`、z 转 30°）、AL（`alignment: topleft`）、C（父层 `scale 2`）：命中区跟着变换走，没旋转 / 居中 / 不乘父缩放的对照点都不中；`localPosition` 以四边形左上为原点、y 向下、单位是 `size`（不乘缩放），离开时是外推值。
- 拖动：只在 A 上按下：同一帧 `enter → move → down`；按住拖出去只有 A 的 `move`（外推）、没有 `leave`；拖回来松开：`up`、`click`。在 A 上按住拖到只在 B 上松开：同一帧 A `up`、A `leave`、B `enter`、B `up`，A 没有 `click`、B 没有 `down`；拖动期间 B 没有 `enter`。
- 事件对象：每次回调新建（`same=false`），`worldPosition instanceof Vec3`，改了它不影响同一回调里别的脚本拿到的对象。`input.cursorLeftDown` 在 `cursorDown` 里是 true。
- 模块顶层访问 `input.cursorWorldPosition` 抛 `SyntaxError: cursorWorldPosition cannot be accessed from global scope.`
- 帧内顺序：同一帧的回调都在这一帧的 `update` 之前。`input.cursorScreenPosition` 是窗口客户区像素（如 (200, 187)），光标在窗口外时是负数、不钳制；回调的 `worldPosition` 与同帧 `input.cursorWorldPosition` 相同。世界坐标带 float32 的痕迹（`799.5001220703125`），实现要照 f32 反投影才能逐值对上。

**`p6c-par`**（视差 amount 1、delay 0、mouseinfluence 1）：深度 0 的 L2 命中在原位（x 1150–1450）；深度 1 的 L1 命中区随视差点移动（光标 x 时中心约 1200 − x，命中 x 550–700），即偏移 `amount·(origin − P)·parallaxDepth`。L1 的子层 L3（本地 `origin 0 250`、自己的 `parallaxDepth 3 3`）在它画出来的位置一次都没命中：命中用对象**自己的本地** `origin` 与自己的深度（读码 3.2），偏移把命中区推出画面；绘制用根对象的深度，两者不一致，照 WPE。

**`p6c-shake`**：光标停在图层上 40 帧，收到 40 次 `move`；世界坐标每帧随抖动变，图层本身的命中区不抖（`localPosition` = 世界坐标 − 左上角）。

**`p6c-zoom`**（缩放 1.5、`perspective: true` 的图层 PL、`fullscreen` 图层 FS）：
- 光标在 Z1 缩放后的位置命中，世界坐标是未缩放的场景坐标 (1300, 700)、`local` (100, 100)；同一场景坐标在不缩放时的屏幕位置不中。
- FS 第一帧就 `enter`，之后从不 `leave`，光标在窗口外照样每帧 `move`（世界坐标变就发）。
- PL 的 5×5 网格命中与 `localPosition` 记为真值，实现时逐值比。

**对实现的影响：**
1. 命中与派发照读码与上面的实测写，包括 WPE 的几处怪处：隐藏图层收事件、子层视差命中用自己的本地 `origin` 与深度、`fullscreen` 恒命中、被挡住的对象不发 `leave`、`moved` 比世界坐标。
2. 世界坐标要 f32 反投影（同 P4c 的指针反投影、用本帧相机），日志才能逐值对上。
3. 桌面的鼠标转发（`wallpaper/input_forward.rs`）已经照 WPE：移动在壁纸窗口范围内都转发（被别的窗口盖住也转发），按下只在光标下是桌面或图标时转发，抬起成对；宿主只差把按下 / 抬起交给场景。
4. 验收：同一份时间线在我们这边经 dev 探针回放，日志和上面四份逐行比。

## 步骤 1 — 命中与派发（含 dev 探针回放；能力表不动）

### 总体设计思路

命中与派发是一个不依赖 GPU 的纯逻辑模块：每个实时帧，渲染器在相机定好之后、`beforeFrame`（关键帧动画、计时器、`update`）之前，把「本帧的光标世界坐标与射线、左键、可拾取对象表」交给它，它按读码 3.2–4.4 的规则更新悬停集合与按下集合，返回本帧要派发的回调序列；宿主按序列交给脚本运行时，运行时照 P10b 的 `animationEvent` 把回调派给该对象上的全部脚本。这一步不改能力表，场景照样因 `script:callback:cursor*` 退回，验收靠 dev 探针强制跑脚本、按 WPE 的同一份时间线回放，脚本日志和 0c 的四份 WPE 日志逐行比（含 float 值）。

可拾取对象表从 bundle 与 `SceneState` 现算，不从 GPU 的 draw 取：隐藏图层、写死不可见的祖先下面的图层（`buildableLayers` 不建资源）照样要参与命中。每个对象给出：绘制矩阵（`drawMatrixOf`，带对齐 / 文本框偏移，文本再乘 `anchor`）、`size`（文本是排版后的文字框）、自己的本地 `origin` 与 `parallaxDepth`（视差偏移用）、`solid`（状态里现读）、`perspective`、`fullscreen`、`disablepropagation` 与父链可见性。遍历顺序：正交场景按 `objects` 顺序倒序；透视场景按 `transparentSortKey(本地 origin, 视线)` 降序稳定排序后倒序（`fullscreen` / `projectlayer` 的键 −∞），同 WPE `FUN_1401865c0`。

数值照 WPE 的 float32 运算顺序写（反投影用 P4c 的 `pointerScenePoint`，射线与四边形求交、视差偏移、`localPosition` 照 REA 反编译 `ignore/p6/rea/cursor/exe/dec-rea/functions/` 逐步 `Math.fround`），日志里的值才能逐位对上（WPE 打出来的是 `799.5001220703125` 这种 f32 痕迹）。

### 现状锚点

**a. 运行时的按对象派发样板**（`script/runtime.ts` 的 `animationEvent`，P10b）
```ts
animationEvent(object: number | null, json: string): void {
  if (this.halted) return;
  for (const record of this.records) {
    if (record.state !== "inited" || scriptObject(record.script.owner) !== object) continue;   // 同一对象上的全部脚本、按记录顺序
    if (record.disabled.has("animationEvent") || typeof record.exports?.animationEvent !== "function") continue;
    const result = this.call(record, "animationEvent", parse(json), this.value(record));
    this.writeReturn(record, result);   // 现状：动画事件写回；光标回调 WPE 丢弃返回值
    …
```

**b. 一帧的顺序**（`render/renderer.ts` 的 `render`）
```ts
scene.setCamera(camera);                                    // 本帧相机（含抖动、缩放）
if (live) this.options.stepObjects?.(frametime);            // 声音
if (live) this.options.beforeFrame?.(frametime, this.spectrum); // 宿主：关键帧动画 → 动画事件 → runtime.frame（计时器、update）
// 现状：没有光标命中与派发
```

**c. 反投影**（`particles/controlpoints.ts:123`）：`pointerScenePoint(viewProjection, cursor)` 是 WPE 的 f32 反投影到 z = 0，`cursor` 是光标下的场景纹理坐标（`renderer.cursorOf`），P4c 已和 WPE 逐位对上（粒子跟随）。

**d. 探针**（`dev/probe.ts`）：`renderFrame` 收逐帧 `pointers`（窗口归一化）与 `window`；脚本 `console` 只留最后 `MAX_CONSOLE_TAIL` 条；没有逐帧左键。

### 点 1 — 命中与派发模块（新增 `render/cursor.ts`）
- **新增** 纯函数与状态机，不 import GPU：
```ts
/** 一个可拾取对象（类型 1 图像 / 4 文本；模型见待定 2）。 */
export interface Pickable {
  object: number;
  matrix: Mat4;                       // drawMatrixOf（文本再乘 anchor）
  size: readonly [number, number];
  origin: readonly [number, number];  // 对象自己的本地 origin（视差偏移用，子层也是本地值，0c p6c-par）
  parallaxDepth: readonly [number, number];
  solid: boolean;
  perspective: boolean;               // 图层 perspective：用透视覆盖相机的射线
  fullscreen: boolean;                // 恒命中，local = 窗口像素
  blocks: boolean;                    // disablepropagation && 自身可见 && 父链可见
}
export interface CursorFrame {
  world: Vec3;                        // 反投影到 NDC z = 0；正交 z 置 0
  ray: Ray; perspectiveRay: Ray | null;
  down: boolean;
  parallax: { amount: number; point: [number, number] } | null;   // 只在正交 + 视差开
  windowPixels: [number, number];     // fullscreen 的 local
}
export type CursorCallback = "cursorEnter" | "cursorLeave" | "cursorMove" | "cursorDown" | "cursorUp" | "cursorClick";
export interface CursorDispatch { object: number; callback: CursorCallback; world: Vec3; local: Vec3 }
export class CursorTracker {
  /** 照读码 3.2–4.4：悬停集合、按下集合、lastWorld（初值 (0, 0)，第一帧几乎必 moved）、lastDown、停止传播的 break。 */
  step(frame: CursorFrame, pickables: readonly Pickable[] /* 已是命中顺序，最上面的在前 */): CursorDispatch[];
}
export function hitQuad(ray: Ray, p: Pickable, offset: [number, number]): { hit: boolean; local: Vec3 };
```
  - 四边形与求交照读码 2.3 / 3.3 与 REA 重核的更正（`t < 0` 或平行时 `local` 保持 0、越界照写外推值、`fullscreen` 恒命中）。
  - `cursorHitTest` 不调用（WPE 没有调用点），导出它只打开拾取。
- **单测** `render/cursor.test.ts`：把 0c 的 `p6c-hit` 段落（重叠、隐藏、`solid`、停止传播可见 / 隐藏、旋转缩放、对齐、父子、拖出拖回、拖到别的层上松开）写成纯数据用例，预期序列照 0c 记录。

### 点 2 — 渲染器接上（修改 `render/renderer.ts`、`render/scene.ts` 或新增的拾取表构建函数）
- **新增** 每个实时帧在 `scene.setCamera(camera)` 之后、`beforeFrame` 之前：只在本场景有脚本导出光标回调时（编译期由 `compile/scripts.ts` 扫出，放进 bundle）建拾取表、算 `CursorFrame`、`tracker.step`，把派发序列交给宿主的新回调 `cursorEvents(dispatches)`；补画帧（暂停、隐藏）不做。
- 世界坐标与射线：正交用当帧 `viewProjection` 反投影（世界点 z = 0；射线起点 `(p.x, p.y, eye.z)`、方向 `(0, 0, −1)`，`p` 是 NDC z = 0.5 的反投影）；透视场景起点 eye、方向 `normalize(p − eye)`；`perspective` 图层用 `perspectiveViewProjection` 的相机。
- `input.*` 的本帧快照（世界坐标、屏幕坐标 = 画布指针 × `engine.screenResolution`、左键）也在这里定，交给脚本 API。

### 点 3 — 运行时与脚本 API（修改 `script/runtime.ts`、`script/api.ts`、`render/state.ts`）
- **新增** `runtime.cursorEvent(object, callback, world, local)`：同 `animationEvent` 的遍历（同一对象上的全部脚本、按记录顺序、只调 `inited` 且导出了这个回调、没被禁用的），参数是 realm 里新建的 `{ button: 0, worldPosition: new Vec3(…), localPosition: new Vec3(…) }`（每个接收者各建一个），**不写回返回值**；出错只禁用这个回调。`RUNTIME_CALLBACKS` 加上六个光标回调与 `cursorHitTest`（后者从不调用）。
- **新增** 全局 `input`：三个只读 getter，每次读新建 `Vec3` / `Vec2`、读本帧快照；模块求值期间读抛 realm 的 `SyntaxError`，消息照 WPE `cursorWorldPosition cannot be accessed from global scope.`（另两个同式）。
- **新增** 图层字段 `solid`：状态 `LayerState.solid`（初值取 JSON，缺省 true；JSON 的 `{user}` 绑定走 P3a 就地路径），脚本读回布尔、写入只收布尔、别的类型不写不报错；命中时现读。
- **新增** 编译期读对象的 `disablepropagation`（JSON 布尔，缺省 false）进 bundle。

### 点 4 — dev 探针（修改 `dev/probe.ts`、`dev/probeScripts.ts`）
- `renderFrame` 新增 `buttons?: boolean[]`（和 `pointers` 等长、逐帧左键）与 `inputTimeline?`（直接收 wpe-renderdoc 的时间线格式 `[x, y, down, n]`，展开成 `pointers` / `buttons`）；脚本 `console` 新增全量收集选项（`consoleGrep` 正则，命中的全留，不受 `MAX_CONSOLE_TAIL` 限制）。

### 验收（Claude）
- 宿主 tsc 0 error，vitest 全过，Prettier；变异检查（去掉隐藏图层参与、去掉停止传播、`moved` 改比屏幕坐标、按下集合不清、子层视差改用根层的深度等）。
- 0c 的四个工程（`p6c-hit`、`p6c-par`、`p6c-shake`、`p6c-zoom`）导入 dev 库，探针 `scripts: true` 按同一份时间线（`ignore/p6/c0/frida/tl-*.json`）、dt = 1/20 s 回放，`[kbp6c]` 行按时间线帧对齐后和 `ignore/p6/c0/out/wpe-*.log` 逐行比：回调名、对象、顺序、`w` / `l` 的值都相同（`upd` 行的 `input.*` 也比）。抖动与视差两份的数值依赖 P5a 的视差点与抖动，已和 WPE 逐位对上，这里一起核。
- 新增透视场景工程 `p6c-persp`（P5d 的透视相机，两层前后错开），WPE 用 `input_play` 抓日志、我们回放比。
- 测试行用 `projects_remove` 移除。

## 步骤 2 — 输入通路、放开能力表、走查

### 点 1 — 宿主收左键（修改 `main.ts`、`host.ts`、`render/renderer.ts`）
- `pointerdown` / `pointerup`（只认 `button === 0`）→ `host.setButton(down)` → 渲染器记下当前状态，每个实时帧开头采一次（同 WPE 每帧 `GetKeyState`：一帧里完整的按下抬起会丢，照 WPE）。`pointercancel` 当抬起。
- 桌面：`wallpaper/input_forward.rs` 已照 WPE 注入 `LeftDown` / `LeftUp`（按下只在桌面或图标上），宿主不另加门。
- 预览：`interactive` 时 iframe 收指针事件；核对预览弹窗在画布上的点击有没有被别的交互（工具条显隐、拖动）吃掉，必要时按场景有无光标回调决定。应用背景不交互。

### 点 2 — 能力表（修改 `compile/scriptApi.ts`、`compile/features.ts`）
- `MISSING_SCRIPT_CALLBACKS` 删掉七个光标回调；`MISSING_SCRIPT_API` 删掉 `input` 三个字段与 `layer.solid`；`OBJECT_FLAGS` 删掉 `disablepropagation`。
- 模型对象见待定 2。

### 点 3 — 走查与文档
- 语料：183 张，能渲染 92 → 103（只差 P6c 的 11 张），没有掉出的。
- 按 FINAL_CHECK 走查两张解锁场景（`3637191856`、`3810092560`），WPE 用 `input_play` 点同一串、我们用探针回放，比日志与画面。
- `cocs/wpe/WPE_SCENE.md` 加「交互（P6c）」一节、索引同步；回归文档加用例；changelog 照 P6b 的约定不加（待用户确认）。

## 已定（2026-11-14 用户按推荐；changelog 不加）
1. **照 WPE 的怪处：** 隐藏图层收事件、子层的视差命中用自己的本地 `origin` 与深度（命中区和画出来的位置不一致）、`fullscreen` 图层恒命中且不发 `leave`、被停止传播挡住的对象不发 `leave`、一帧里完整的按下抬起丢掉。推荐全部照 WPE（作者是对着 WPE 调的，语料 75 段脚本靠隐藏图层当按钮）。
2. **模型对象的命中：** 语料里挂光标回调的模型 0 个、`disablepropagation` 全是 false，模型被命中不会改变任何派发。推荐不实现模型命中，只在「模型对象上有脚本导出光标回调」或「可见且 `disablepropagation`」时照报 `cursor:model`（0 张受影响）；读码与 REA 更正已记在 rea-p6c-dispatch 3.4，要做时直接照写。
3. **木偶模型的 `hitBox`：** 事件对象没有 `hitBox`（puppet 是 P12，别的会话在做），P6c 不做。

**`p6c-persp`**（2026-11-14 补，`make_persp.py`，透视相机 eye (0, 0, 10) 看原点，PB 最远、PA、PC 最近，网格 9×6 每点 3 帧）：世界坐标落在远平面上（z = −9990 = 10 − 10000），重叠处最近的 PC 先处理；日志 `ignore/p6/c0/out/wpe-persp.log`，时间线 `frida/tl-p6c-persp.json`。

## 实施记录

- 2026-11-14 用户：步骤 1、2 一次做完，最后的走查单独做；待定 1–3 按推荐，changelog 不加。
- 2026-11-14 步骤 1、2（不含走查）由 sonnet 代理实现，Claude 验收：
  - **改动：** 新增 `render/cursor.ts`（求交、命中、反投影、两种射线、`CursorTracker`、`pickablesOf`、`CursorSession`）、`render/inverseF32.ts`（WPE 的 float32 4×4 求逆 `0x14005f730`，由 `ignore/p6/c1/gen_inv.py` 从反汇编生成；P4c 的 `pointerScenePoint` 用 double 余子式，正交矩阵上差 1 ulp，日志对不上）；`compile/` 里 `SceneLayer.pick / solid / disablePropagation`、`solid` 成就地绑定目标、能力表放开、新增 `cursor:model`（模型对象上有光标回调或可见且 `disablepropagation`）；`render/renderer.ts` 的 `stepCursor`（`setCamera` 之后、`stepObjects` 之前，只在实时帧）；`script/runtime.ts` 的 `cursorEvent` / `hasCursorCallbacks`；`script/api.ts` 的全局 `input` 与图层 `solid`；`host.ts` / `main.ts` 的左键（`pointerdown/up/cancel`、`blur` 当抬起）；探针的 `inputTimeline` / `buttons` / `scripts.consoleGrep`；文档 `WPE_SCENE.md`「交互（P6c）」、索引、回归 C1–C7。
  - **代理自己定的：** 拾取开关看运行时（已 init 的脚本导出光标回调，`cursorHitTest` 也算），`input` 快照每个实时帧都算；`inputTimeline` 把指针量化成整数像素（同 Frida 驱动）；`solid` 的属性绑定同 `visible` 的规则。
  - **我核对的：** 改动范围（别的会话的块没动；`bundle.ts` / `features.ts` 中途出现过对方的冲突标记，已由对方解决，现在全仓库没有冲突标记）；读了 `cursor.ts` 的求交、命中、状态机与拾取表，和读码一致；tsc 0 error、vitest 161 个文件 3833 条全过。
  - **变异检查**（快照 `ignore/p6/c1/mut`，`ignore/p6/c1/mutate.py`）：12 处，第一轮漏掉「拾取表的视差深度不取对象自己的」「t < 0 也写 local」两处，补了两条单测（`render/cursor.test.ts`）后 12 / 12 抓到。
  - **对 WPE 日志：** 代理的比对（`ignore/p6/c0/cmp_logs.py`，我们这边 `ignore/p6/c1/run_ours.py`）：`p6c-hit` 回调 98 / 98、`upd` 169 / 169 逐字相同；`p6c-par` 13 / 13、464 / 464 逐字相同；`p6c-shake` 回调序列 42 / 42 相同，数值差 ≤ 0.13（WPE 当时的 `g_Time` 未知，抖动是它的函数）；`p6c-zoom` 49 条里 35 条逐字相同，其余 14 条是 `perspective` 图层 PL 的 `l` 差 ≤ 4.6e-5（覆盖相机的 float32 链没逐步搬）；`p6c-persp` 序列 20 / 20 相同，`w` 的 z 是 −9990.0009765625 对 WPE 的 −9990、x / y 差 1 ulp（透视相机矩阵的 float32 组合不同，远平面放大）。命中与否、回调序列五份全部相同。
  - **我补比的文本层：** `p6c-probe`（被点的是文本层 s2）按 `tl-probe.json` 回放，`w` / `l` 和 0c-1 验收那次的 WPE 日志逐位相同（`w.y = 499.5000305175781`、`l = (474.5, 70.49996948242188)`），序列相同。最早手写探针那次 WPE 的 `w.y` 是 `499.5001220703125`（窗口被人拖动过），`l` 两次相同。
  - **语料**（192 个工程）：干净场景里因 P6c 新增 17 张（预期的 11 张加上 `3336377291`、`3354880265`、`3427691867`、`3560102937`、`3611425904`、`3714324957`，它们之前只被光标键挡着），没有新增键、没有掉出的；另 3 张是别的会话 P13b1 带来的。
  - **已知差异：** `perspective` 图层与透视场景的光标坐标差 1–3 ulp（不影响命中与序列）；抖动场景的数值没法逐位比（WPE 的时间未知）。
  - **没做：** 走查（单独做）；预览弹窗里画布点击会不会被工具条或拖动吃掉、桌面真机点击，留在回归 C4–C7。
- 2026-11-14 提交 `3d6f4d86`（文档里别的会话的两处挪动没收）。

## 走查（按 FINAL_CHECK，2026-11-14 用户：「可以，开始走查」）

两张解锁的真实壁纸，各做复制工程（`kbp content isolate --instrument`，只留交互相关的对象及其闭包），WPE 用 `input_start` / `input_play` 喂同一串光标与左键并连续抓帧，我们按 FR 日志的逐帧帧时间、光标与时间线的左键回放，整帧逐像素比，差异逐处解释。
- **`3637191856`**（拖动时钟）：留时钟文本层「时间」（id 29）。剧本：时钟上双击（两次点击间隔 < 500 ms）进入拖动模式，按住拖到别处松开。拖动中的位置只看光标；时钟文字取录制时刻（探针 `scripts.clock`）。场景 3936×2208 比窗口大，文字有已登记的分辨率差异（P6b），比较时单列。
- **`3810092560`**（隐藏按钮触发卡片压扁动画）：留一组卡片（组 33、卡片「1」34）与它的隐藏按钮（27）及脚本按名字找的目标。动画按 `Date.now()` 推进：复制工程另加一个只写日志的对象记每帧 `Date.now()` 与目标卡片的 `scale`（同 FR 的先例，不改被测对象）；我们按 WPE 的 `Date` 差值给帧时间回放，逐帧比缩放值与画面。

### 走查记录（2026-11-14，走查代理）

**共用做法**（脚本都在 `ignore/p6/cw/`）：
- 复制工程：`kbp content isolate <id> --keep … --instrument --data ignore/p6/cw`，再用 `add_logger.py` 在 `objects` 末尾加一个只写日志的对象 `kbp6w-LOG`（模型同 FR、放在画面外），每帧记 `Date.now()`、被测图层的字段与 `input.cursorLeftDown`，每 10 帧一条 `console.error('[kbp6w] …')`；被测对象一个字段都没改。WPE 与 Kabegame 用同一份目录。
- WPE（fps 20、后处理 ultra；两张都没开泛光 / HDR）：`open_wallpaper` → `input_start(play)`（时间线 `tl/*.json`，`make_tl.py`）→ 按 `input_status` 的帧数在关键段 `capture` → `input_stop` → 按线程截 `log.txt`（`cut_wpe_log.py`，同时有别的会话的窗口在写日志）。抓帧文件名的 RenderDoc 帧号 + 1 = FR 帧号（FR 的 `g_Color` 与长帧的位置两种办法核对过）。抓帧在 `A:\p6c\walk\<标签>\`。
- 我们：`projects_import` 导入，经 vite REST 开屏外宿主直接调探针 `renderFrame`（`run_frame.py`；`render_scene`、REST `render`、`renderFrames.ts` 都不收 `inputTimeline` / `buttons`）。帧时间、`g_Time` 取 FR 的 frametime / runtime 列；逐帧光标取 FR 记的屏幕光标、左键取 kbp6w 记的 `input.cursorLeftDown`（时间线开始之前的帧也照日志），组成每帧一项的 `inputTimeline`（`build_args.py`、`build_card_args.py`）；`window` = `canvas` = WPE 窗口；`scripts: { clock, consoleGrep: "kbp" }`。渲染前在 `apps/wpe-scene` 跑过 `deno task build --mode development`，产物里有 `cannot be accessed from global scope`。
- 比较：`kbp rdc frame --present` 出 WPE 的图（`out/wpe-*.png`），`kbp cmp frames` 比（报告在 `cmp/`）；kbp6w 逐帧比用 `cmp_logs.py`。测完 `projects_remove` 移除三个导入行，测试窗口全部关掉。

#### `3637191856`（拖动时钟）

- **复制工程** `proj/3637191856-iso-clock`：留时钟文本层「时间」（29）、FR、kbp6w，删 5 个背景图层。属性 `time`（「Show」，绑在 29 的 `visible` 上）缺省是 false、时钟本来就隐藏，复制工程的 `project.json` 里改成 true（等于用户打开 Show），其余属性取缺省。窗口 1920×1080（场景 3936×2208，`fill` 横向裁掉 5.3 个场景像素）。时间线 841 帧：场外 20 → 时钟上点两下（按 2 抬 2 按 2 抬 4）→ 第三次按住、逐帧拖 200 帧 → 松开停 600 帧。
- **结果：发现 bug，根因已定位（不是 P6c 引入的）。** WPE 的时钟画出来了，我们的不画：
  - WPE：`init` 收到 JSON 的 `value`（false），日志里 `Uncaught TypeError: Cannot create property 'x' on boolean 'false' (line 116, col 9)`（`update` 第一次就抛错，整段只报一次）；kbp6w 从第 1 帧起读到 `visible` 为 true。
  - 我们：探针和真实宿主都是 false（屏外宿主 `host.state()` 的 `layers[0].visible: false`）。比了 2 帧（1689、1932），各 2121 个像素、最大 77，就是整块时钟；kbp6w 的 `visible` 列 1930 帧全不同，拖动的 `origin` 照样在变（隐藏图层收光标事件，两边一致）。
  - 根因：字段同时挂 `script` 和 `{user}` 时，编译期 `compile/model.ts` 的 `resolveValue` 对带 `script` 的值直接返回 JSON 的 `value`（这是给 `init` 的入参，这一半对）；之后整个加载过程没有再按属性全集走一次字段的直接绑定：`host.ts` 首包走整场编译，首帧之前的 `runtime.applyUserProperties(全集…)` 只更新 `scriptproperties` 绑定、调脚本导出的 `applyUserProperties`，字段的直接绑定（`planApply(...).writes` → `renderer.applyBindings`）只在之后的属性增量里走（`applyChanges`）；探针 `dev/probeScripts.ts:420` 同样。WPE 的顺序是「解析期写 JSON `value` → 构造完 `init` 并写回 → 以全集为增量走一次绑定 → 首帧」（`phase3/p3-script-REPORT.md` 第 911、1309 行；第 430 行「同时带 user 与 script，先由直接绑定写值」），所以 `init` 拿到 false、画面是属性值。
  - 影响：语料 32 张场景有「同一字段同时 `script` + `{user}`」（`scan_script_user.py`，结果 `out/scan-script-user.txt`），能渲染的 6 张：`2903412088`、`3336377291`、`3427691867`、`3429479356`、`3460973721`、`3637191856`。缺省属性下 JSON `value` 和属性值几乎都一样，看不出来；用户改了这类属性（时钟的 Show、`enabletips`、`clock`、`music` 这类开关，`2903412088` 的位置滑块）之后，每次重新加载（启动、整场重编译）都回到 JSON `value`。运行中改属性走增量路径，是对的。`update` 每帧原样返回 `value` 的脚本会把错值一直带下去。
  - 按要求没改产品代码。
- **绕开这个 bug 看 P6c**：变体 `proj/3637191856-iso-clockv`，在上面的基础上 `--fix '29:/visible/value=true'`（`init` 拿到 true，两边都画出时钟；光标回调与拖动逻辑不变，只是 `update` 报错的文字变成 `'true'`）。
  - **1920×1080**，抓 6 帧（拖动中 759–761、松开后 956–958，`A:\p6c\walk\clockv-drag`、`clockv-after`）：
    - 日志：双击判定、进入拖动、拖动中的 `cursorMove` 都和 WPE 在同一帧；kbp6w 950 帧里 746 帧逐字相同，其余帧 `origin.x` 差 1 个 float32 ulp（如第 759 帧 WPE `1340.35546875`、我们 `1340.3555908203125`；松开后 WPE `986.6666259765625`、我们 `986.6665649414062`），`y` 全同。
    - 1 ulp 的原因（已定位，没登记）：WPE 把 `fill` 的居中盖满裁切做进 `P·V`（抓帧里 FR 的 MVP `m0 = 0.0005095108645036817` = 2 / 3925.33，不是 2 / 3936），直接反投影窗口指针；我们的 `P·V` 不裁（场景目标），先用 `sceneCursor`（double）把指针换成场景纹理坐标再反投影，float32 舍入不同。`crop_world.ts` 用产品的 `invertF32` 和同一串 float32 反投影复算：「裁切做进 `P·V`」复现 WPE 日志 968 / 968 帧（另 1 帧是松开后光标移出窗口、`origin` 不再变，不算），「`sceneCursor` + 不裁的 `P·V`」复现我们的日志 319 / 319 帧。窗口与场景同比例时两条路一样（下面 3936×2208 逐位相同，P6c 验收的 `p6c-*` 工程也逐位相同）。P4c 的 `pointerScenePoint`（粒子跟随指针）是同一种写法，裁切时同样可能差 ulp（没测）。要逐位对上得照 WPE 在反投影时用裁过的 `P·V`。
    - 画面：6 帧都有差，每帧 960–1139 个像素 > 0、最大 40–41，只在字形边缘（`cmp/clockv.txt`，并排放大 `cmp/clockv-f759-zoom.png`，位置对齐）。第 760 帧两边 `origin` 逐位相同，差异像素数和相邻帧同量级，所以差异全是已登记的「场景比窗口大时 WPE 按窗口分辨率直接画字形，我们先按场景分辨率画再缩」，1 ulp（6e-5 场景像素）在画面上看不出。
  - **3936×2208 无边框窗口**（等于场景尺寸；比屏幕大，WPE 照开，客户区 3936×2208），同一份时间线，抓 4 帧（拖动中 784–785、松开后 1013–1014，`A:\p6c\walk\clockv4k-*`）：**4 帧整帧逐像素相同**（`cmp/clockv4k.txt`），kbp6w 1010 帧逐字相同（含拖动中每一帧的 `origin`）。
- **结论**：P6c 的命中、双击、按住拖动、`worldPosition` 与 `origin` 写回，在窗口等于场景尺寸时逐像素、逐位相同；1080p 的差异已解释（字形分辨率，已知；`origin.x` 1 ulp，原因已定位、未登记）；另发现上面的 `script` + `{user}` 绑定 bug。

#### `3810092560`（隐藏按钮触发卡片压扁动画）

- **复制工程** `proj/3810092560-iso-card1`：留组 33、卡片「1」（34，带 waterwaves effect）、隐藏按钮「1」（27，`scale` 上的脚本按 `scriptproperties.targetLayerNames` 用 `getLayer('1')` 找目标，两边拿到的都是卡片 34，kbp6w 记的 `size.x` 是 829）、FR、kbp6w（记 `Date.now()`、`getLayer('1').scale`、左键）；删 51 个对象（另两组卡片、纯色背景）。isolate 报一条 `script-index` 警告（`getLayer` 的参数是变量），实际按名字 `"1"` 找，无影响。
- 窗口 2560×1440，等于场景尺寸（避开分辨率差异）。时间线 1264 帧：场外 20 → 移到按钮（窗口 (152, 956)）→ 40 轮「按 2 帧、抬 14 帧」→ 移出停 600 帧。抓 34 帧：两段各连续 16 帧（624–639、899–914，含两次完整的压扁—回弹）与动画之后的 1190–1191（`A:\p6c\walk\card-anim`、`card-anim2`、`card-after`）。
- **只按 runtime 回放时对不上，查下来是两件和产品无关的事：**
  1. WPE 里每段脚本各自取 `Date.now()`：按钮脚本（`cursorDown` 在光标派发时取 `animationStart`，`update` 在它自己的 `update` 里取）和排在最后的日志对象拿到的差 ±3 ms，按日志对象的 Date 复算不出 WPE 的 `scale`。`card_infer.py` 照脚本公式（脚本属性取 JSON 的 double；取 float32 只对得上 217 / 303 帧），在日志 Date 差 ±6 ms 内找整数「`Date.now()` − `animationStart`」：303 个动画中的帧全部唯一解、逐位复现记下的 `scale`（`out/card-infer.json`）。WPE 偶尔在按下那一帧就已经差 1 ms（40 次里有 1 次 `scale` 当帧就变）。
  2. **探针的 bug（工具缺口）**：`renderFrame` 回放时光标派发在 `enterFrame` 之前（`dev/particleCorners.ts` 的 `replayEncoded`：`scripts.cursor(...)` 在 `scripts.enterFrame(...)` 之前），光标回调里的 `Date`、`engine.runtime`、`engine.frametime` 是上一帧的。宿主是对的（`render/renderer.ts` 帧开头 `frameClock.advance` 在 `stepCursor` 之前，`Date` 是真时钟）。表现：我们按下那一帧 D 已经压扁了一整帧，WPE 在 D 帧 elapsed 是 0（或 1 ms）。P6c 验收的测试工程没在光标回调里读时间，所以没暴露。
  - 绕法（`build_card_args.py`）：脚本时钟 `clock = 0`（Date = g_Time × 1000；1.8e12 的时间戳在 double 里只剩 2.4e-4 ms 的分辨率，两个 Date 相减就带误差）；要比的第 N 帧在动画中时，把 D − 1 帧的 g_Time 改成 runtime_N − e_N / 1000（N 本身是按下帧时改成 runtime_N），这样 `cursorDown` 拿到的 `animationStart` 正好让第 N 帧的差等于 WPE 的 e_N；D − 1 帧不比，它的 g_Time 只影响它自己画的 waterwaves；帧时间仍取 WPE 的 frametime。核对：第 910 帧（日志正好刷到）我们的 `scale` 是 `(0.66, 0.7041299343109131)`，和 WPE 逐位相同。没绕之前，动画中的帧整张卡片错位，每帧 23.7 万–27.7 万个像素差、最大 255。
- **结果**（`cmp/card.txt`）：34 帧里 7 帧逐像素相同（628、631、901、905、907、908、914）；其余 27 帧各 2–19 个像素差 1，第 1190 帧有一个像素差 2，全在卡片里、散点，动画中的帧（624、625、637–639、899、909–911）和静止帧是同一量级。40 次按下两边在同一帧派发（`card_downs.py`）。
  - 解释：waterwaves 的片元按 `sin(g_Time·speed + dot·scale)`、`pow`、`strength²` 扰动 UV 再双线性采样卡片的合成 RT。WPE 是 fxc 的 DXBC（`out/wpe-card-after-shaders/1ace7959-aef9c1c3-18fa5f1b-148475ab.txt`：`mad`、`sincos`、`log` / `exp`），我们是 WGSL 经 Dawn；UV 差在 float 舍入量级，偶尔跨过 GPU 双线性 1/256 子纹素权重的量化台阶，在边上差 1 级。第 1190 帧 (280, 779) 周围 5×5 的值从 30 到 191，u、v 两个方向同时跨台阶，差 2。归 `WPE_SCENE.md`「音频频谱 uniform（P11a）」已知差异里的「片元的零星舍入差」（那里写最大 1 级，这里陡边上见到 2 级，建议补一句）。
- **结论：差异已解释。** 隐藏按钮的命中（随卡片的父链缩放一起变）、`cursorDown` 派发、`getLayer` 按名字找目标、压扁—回弹的缩放写回，和 WPE 逐帧一致；画面残差是 waterwaves 的片元舍入。

#### 发现、缺口与没做的

1. **bug（P3a / P3b 的加载顺序，不是 P6c 引入的）**：同一字段同时挂 `script` 与 `{user}` 时，加载后不按属性全集走一次直接绑定，字段停在 JSON `value` / `init` 的返回值。见上「3637191856」。
2. **未登记的差异**：`fill` 裁切（窗口与场景比例不同）时，光标世界坐标与 WPE 差 1 个 float32 ulp（WPE 的裁切在 `P·V` 里，我们的在 `sceneCursor` 里）。不影响命中与派发、画面上看不出；要么登记成已知差异，要么照 WPE 用裁过的 `P·V` 反投影。
3. **工具缺口**：
   - 探针光标回调用上一帧的时钟（`replayEncoded` 的调用顺序），要改成先 `enterFrame` 再 `cursor`（宿主没有这个问题）；
   - 探针每帧只有一个 `Date`，WPE 每次调用都是真时钟、一帧里各段脚本差几毫秒；按 `Date` 推进的脚本要「每段 / 每次调用的 Date」才能直接回放，这次靠从记下的值反推、改 g_Time 绕过；
   - `render_scene`、REST `render`、`renderFrames.ts` 不收 `inputTimeline` / `buttons`，只能经 host eval 调 `renderFrame`；
   - FR 与日志对象每 10 帧刷一次，回放到第 N 帧时 N 不是 10 的倍数就拿不到我们这边第 N 帧的值。
4. **没做的**：`3637191856` 的原始复制工程（不 fix `visible.value`）只比了 2 帧、记录 bug 用；`3810092560` 没录 1920×1080（窗口比场景小的分辨率差异在时钟那张已经单列）；`WPE_SCENE.md` 的已知差异（裁切的 1 ulp、片元舍入见到 2 级）没改，留给主会话定。

### 走查发现的问题与处理（2026-11-14 用户：「先修你发现的产品bug」）

**修复 1 — 首次加载时「挂脚本又绑属性」的字段没套属性值（P3a / P3b 的缺口，不是 P6c 引入）**

总体设计思路：WPE 首次加载是「解析期 setter 写 JSON 的 `value` → `init` 写回 → 以属性全集为增量走一次直接绑定 → `updateScriptProperties` → `applyUserProperties` → 首帧」（p3-script-REPORT I1、K3：`init` 读到 JSON 的 `value`，第一次 `update` 起是属性值；同时带 `user` 与 `script` 的属性先由直接绑定写值，下一帧被 `update` 覆盖）。我们的编译期对不挂脚本的字段直接取属性值（等价于那次全集绑定），挂脚本的字段取 JSON 的 `value` 给 `init`，这一半对；缺的是 `init` 之后那次全集绑定。修法：首次加载（`scriptNeedsFullApply`，即 `init` 刚跑过的那次）在 `beforeFirstFrame` 里、`runtime.applyUserProperties` 之前，按属性全集算 `planApply(bundle.bindings, 全集)`，只取落在「有脚本的目标」（脚本表里 `targetKey(script.target)` 的集合）上的就地写，交给 `renderer.applyBindings`，并对这些目标 `runtime.forgetWrite`（同运行中增量路径：属性覆盖了 `init` 的写回，重编译重放不该再放回 `init` 的值）；重编译类的条目忽略（编译期已按当前属性编过）。dev 探针（`dev/probeScripts.ts` 首帧前那段）照做。

现状锚点：`host.ts` 的 `beforeFirstFrame` 只有 `this.runtime.applyUserProperties(全集, …)`（脚本属性与回调）；`compile/model.ts` 的 `resolveValue` 对带 `script` 的值返回 JSON `value`；`compile/bindings.ts` 的 `bind` 对这种值照样登记绑定。

验收：`host.script.test.ts` 加用例（图层 `visible` / 数值字段 / 材质常量各一，`{script, value: false, user: "show"}`、属性为 true：`init` 收到 false，首帧前状态已是 true，第一次 `update` 收到 true；带 `condition` 的一例；重编译之后不再回到 `init` 的值）；探针同样的用例；走查的 `ignore/p6/cw/proj/3637191856-iso-clock`（「Show」= true）按走查的同一份输入回放，第 1689、1932 帧和 WPE 抓帧（`A:\p6c\walk\clock-*`）比，时钟出现，差异只剩已登记的字形边缘；kbp6w 日志的 `visible` 列和 WPE 相同。语料：受影响的 6 张（`2903412088`、`3336377291`、`3427691867`、`3429479356`、`3460973721`、`3637191856`）`unsupported` 不变。

**修复 1 的实施与验收（2026-11-14，sonnet 实现，Claude 验收）**
- 改动：新增 `script/initialApply.ts` 的 `applyScriptedProperties`（宿主与探针共用：按属性全集算 `planApply`，只取目标在脚本目标集合里的就地写，经 `state.write` 写进新场景的状态；`needsRecompile` 挡下的与重编译类目标忽略）；`host.ts` 在 `beforeFirstFrame` 的 `replayWrites` 之后、`runtime.applyUserProperties` 之前调用；`dev/probeScripts.ts` 在 `runtime.load` 之后同样调用；`script/runtime.ts` 加 `hasWrite`。
- 代理自己定的：写进 `beforeFirstFrame` 收到的新状态（`renderer.applyBindings` 写的是渲染器当前那份，加载中可能还是旧场景）；**重编译那次也补**——首次加载后 `init` 的写入记录已忘掉，只补脚本没有写入记录的目标（有记录的是脚本最近一次写回，照常重放），否则只有 `init` 的字段重编译后会退回 JSON `value`；首次加载才 `forgetWrite`。两条旧用例按 WPE 的顺序改了期望（`init` 写 0.2、属性 0.3 → 首帧前 0.3；文本字段重编译后是属性值）。
- 我核对的：只动了 `host.ts`（+11）、`runtime.ts`（+4）、`probeScripts.ts`（+3）、新模块与两个测试文件、文档；工作区里 `bindings.ts` / `bundle.ts` / `model.ts` / `scripts.ts` / `state.ts` 等的改动是别的会话的（布尔字段只收布尔）。tsc 0 error；`host.script.test.ts`、`probeScripts.test.ts`、`render/p3a.test.ts` 126 条全过（代理跑时 `p3a.test.ts` 有 1 条失败，是别的会话改 `state.ts` 时测试还没跟上，现在已过）。
- 对 WPE：`3637191856-iso-clock`（「Show」= true）第 1689、1932 帧：修之前各 2121 个像素（整块时钟）、最大 77；修之后 861 / 968 个像素、最大 26 / 29，没有 > 32 的块，只在字形边缘（同 `clockv` 变体在 1080p 下的已登记字形差异）；kbp6w 的 `visible` 列 1930 帧 0 帧不同（修之前全不同）；其余不同只有 `origin` 的 1 ulp（走查已记的 fill 裁切）。报告 `ignore/p6/cw/cmp/clockfix.txt`。
- 语料：HEAD 快照与工作区各 192 个场景，`corpus diff` 无变化（`ignore/p6/fix1/`）。
