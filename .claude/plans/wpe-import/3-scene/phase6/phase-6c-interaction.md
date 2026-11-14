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

## 实施记录

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
