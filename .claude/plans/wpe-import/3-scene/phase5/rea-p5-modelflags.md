> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。全部没有实测，P5 步骤 0 实测核对后以报告为准。

# WPE 2.8.42 图像模型 JSON 标志静态逆向（P5 前置）

**概括**
- **模型 JSON 只读 11 个键：** `material`、`width`、`height`、`fullscreen`、`nopadding`、`autosize`、`passthrough`、`solidlayer`、`projectlayer`、`instanced` 在构造函数 `FUN_1401fac50` 里读，`puppet` 在虚函数 +0x40（`FUN_1401fbae0`）里读。布尔键只认 JSON 布尔 `true`，写成 `1` 等于没写。
- **`cropoffset` 与对象 `config`：** `wallpaper64.exe` 里没有 `cropoffset` 这个字符串，只有编辑器 `wallpaperui.exe` 有。`config` 只在托盘、播放列表代码里被读，`passthrough` 只在模型解析里被读，所以 `config.passthrough` 渲染时不读。两者都可以当中性键处理。
- **`fullscreen`：** 尺寸取槽 0 纹理的图像尺寸（这类模型的槽 0 都是 `_rt_FullFrameBuffer`），会覆盖对象 `size`，也不除纹理降级系数。几何是 2×2 的 NDC 四边形，直接上屏时靠着色器不乘 MVP 来铺满。走合成路径时**不画基础材质**，合成 RT 直接 `CopyResource` 当前目标；上屏用单位矩阵和 NDC 正交，忽略 `origin`、`scale`、`angles` 与相机。
- **`passthrough`（组合层）：** 加载时给对象置 `+0x120 |= 4`。所有子孙（任意深度）都被打上 `0x2`，不在顶层画，由这个层画进自己的合成 RT。画的时候用层的局部正交（`inverse(W)`、单位视图、`±w/2, ±h/2, ±1000`），超出层矩形的部分被裁掉。`copybackground: true` 时，基础 pass 用 `composelayer` 着色器把层背后的屏幕快照透视正确地铺满合成 RT；`false` 时清成 (0,0,0,0)，子层画进去时打开「RGBA 都写、alpha 取 MAX」的设备状态。**没有效果、没有子层、colorBlendMode ∈ {0, 31} 时整层不画。**
- **`projectlayer`（「全组合层」）：** 是带 `autosize` 的 composelayer。`autosize` 让尺寸取 `general.orthogonalprojection` 的宽高（`ctx+0x84/+0x88`），并且置排序键 −∞ 标志 `+0x120 |= 0x200`（和 `fullscreen` 共用）。只在透视的排序渲染里起作用，效果是画在所有透明物体之后。
- **`nopadding`：** 编辑器把纹理补成 2 的幂时不写它，写它的纹理图像尺寸等于纹理尺寸。运行时只关掉直接上屏四边形 `+0x490` 的 0.15 texel UV 内缩，带效果时末 pass 的内缩照旧。L22 的条件读码确认无误。
- **`instanced`：** 编辑器生成的「纯色图层」（`solid_instance_model_*`，同时有 `solidlayer`）。材质按对象的 `instance` 键实例化（覆盖 `textures`、`combos`、`usertextures` 等），`instance.usertexturereference.width/height` 写成对象 `size`。合成 RT **不**按 `size`，而按纹理图像尺寸，`util/white` 是 32×32，带效果时整条效果链在 32×32 上跑，需要实测。
- **更正 B9：** 透明标志 `0x100` 在构造函数里定，那时 `copybackground` 还没解析（默认 1），所以它只由材质混合模式决定，和 `copybackground` 无关。四个 util 组合层的材质都是 translucent，所以总是置位。另外，`autosize` 在纹理就绪回调里**覆盖**对象 `size`，`features.ts` 注释里「`size` 缺失时才取纹理尺寸」与 WPE 不符。

**元数据**
- 目标 `D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对前缀 `40e2ce021e935232` 一致。另外只读扫了 `bin\wallpaperui.exe` 的字符串。没有运行或附加 WPE，没写 Steam 目录。
- 方法：REA（Ghidra 12.1.4，从 `p4b-mod` 快照的副本 `ignore/p5/rea/modelflags/wp-modelflags.rea-snapshot` 打开）反编译，`ignore/p4/rea/wp.asm` 按地址读汇编，Python 脚本读 PE 常量和样本。REA 会话和相机代理共用（中途活动目标变成了它的副本，二进制相同），为了不打断它，**没有调 `close_binary`**。
- 工作文件在 `ignore/p5/rea/modelflags/`：
  - 反编译：`f_<地址>.c`（`1401e8aa0`、`140207b50`、`140208670`、`140208c80`、`1402066a0`、`1401ea310`、`1401ea500`、`1402091e0`、`140209360`、`1401ede30`、`1401ec720`、`1401ecb20`、`1401ebf60`、`1401fbae0` 等）。
  - 汇编摘录：`modelparse.asm`、`size.asm`、`texcb.asm`、`blend.asm`、`children.asm`、`sort.asm`、`sceneloop.asm`、`ortho.asm`。
  - 脚本：`pe.py`、`fn.py`、`strref.py`、`suffref.py`、`findstr.py`、`fnstrs.py`、`xr.py`、`vt.py`、`vtscan.py`、`infn.py`、`ex.py`、`exb.py`。
  - 语料扫描：`scan/scan.py`、`scan_out.txt`、`ptstat.py`、`instfx.py`、`texhdr.py`、`white.py`、`uistr.py`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明的范围里搜过，范围外没排除。

**命名与位表**（图像层类 vtable `0x1404911a8`，对象 0x4d0 字节）
- `ctx`：渲染上下文，`layer+0xc8`。`dev`：`ctx+0x1518` 的设备对象，vtable `0x140485b90`【推：靠 `vtscan.py` 找到，槽 0xd8/0xe8/0x118/0x120/0x128 的实现和调用语义吻合】。`W`：对象世界矩阵，虚函数 +0x80（`FUN_1401fd3f0`，含父链，`alignment` 不为 0 时再加 `+0x2f8..+0x300` 偏移）。
- 对象标志 `+0x120`（u16，基类构造 `FUN_1401ddbb0` 置初值 `0x2001`）【确】：
  - `0x1`：`visible`，属性表 `0x1401ee8d0`。
  - `0x2`：由祖先组合层代画，顶层跳过（`FUN_1401dd9a0` 传播）。
  - `0x4`：组合层模型，负责画子树（构造函数里置）。
  - `0x80`：`perspective`，属性表 `0x1401ee9a4`，访问器 `FUN_14019c830` 读 bit7。
  - `0x100`：透明，进场景透明表 `+0x170`（`0x140190952`）。
  - `0x200`：透明排序键固定 −∞（`fullscreen`、`projectlayer`）。
  - `0x800`：`castshadow`，访问器 `FUN_1401ef120` 用 bit 0xb。
  - `0x2000`：`solid`，默认 1。
- 图层标志 `+0x304`（u32，基类构造 `FUN_1401e6980` 置初值 `0x8040`）【确】：
  - `0x2` `fullscreen`；`0x4` `nopadding`；`0x8` `autosize`。
  - `0x10`：colorBlendMode 混合上屏（B8）。
  - `0x20`：`passthrough`。
  - `0x40`：`copybackground`，**默认 1**。
  - `0x100`：J1 推断是 `ledsource`。
  - `0x200` `solidlayer`；`0x400` `projectlayer`；`0x800` `instanced`。
  - `0x2000`：不建 `+0x2d8` 四边形（B5 的 bit13）。
  - `0x4000` / `0x8000`：合成 RT 的点采样 / 夹取，`0x8000` 默认 1。
- 图层字段【确】：
  - `+0x180` 父对象；`+0x198/+0x1a0` 子对象 vector。
  - `+0x2c0` passthrough 上屏材质；`+0x2c8/+0x2d0` 合成 RT 0/1。
  - 四边形：`+0x2d8` 基础 pass；`+0x2e0` 2×2；`+0x2e8` 世界四边形（上屏、组合层基础 pass）；`+0x490` 直接上屏。
  - `+0x2f0/+0x2f4` 尺寸（float，即 `size`，属性表 `0x1401ee5bd` 偏移 0x2f0）；`+0x320` 效果合成计数；`+0x32c` colorBlendMode；`+0x498` 基础材质；`+0x4b1` `alignment`（`0x140211157`）。
- 纹理字段：`+0x1c` 标志（bit0 点采样，bit2 精灵表）；`+0x20/+0x24` 纹理尺寸；`+0x2c/+0x30` 图像尺寸；`+0xb0/+0xb4` 精灵帧尺寸。

---

## 1. `fullscreen`

### 1.1 解析与尺寸【确】
- 构造函数 `0x1401fadf6`：只在值是 JSON 布尔 `true` 时生效（`type == 5` 且 `asBool`，下同），置 `+0x304 |= 2`、`+0x120 |= 0x200`。
- 纹理就绪回调 `FUN_140209360`（`vfunc+0x110` = `FUN_1402065e0` 在加载末尾调一次，纹理重载时再调）：`fullscreen` 时 `+0x2f0/+0x2f4 :=` 槽 0 纹理的**图像尺寸**（`tex+0x2c/+0x30`），给几何的尺寸改成 **(2, 2)**。
- 这个回调在属性解析（`FUN_1401e6f50` → `FUN_1401de470`）**之后**才跑，所以对象 `size` 和模型 `width`/`height` 都被覆盖。
- 合成 RT 尺寸（`FUN_1402091e0`）：先取图像尺寸，精灵表取帧尺寸；`fullscreen` 不走 `solidlayer`/passthrough 的「按 `size`」分支。**`fullscreen` 且不是精灵表时，不除纹理降级系数 `ctx+0x1218`**（`0x140209310`），B5 写的「再除以全局纹理降级系数」对 fullscreen 不成立。最后 `max(4, ·)`。
- 语料里 `fullscreen` 模型的槽 0 全是 `_rt_FullFrameBuffer`：`fullscreenlayer.json` 的材质是这样，neon_sunset 的 `cloudsbg.json` 也是，它的片元着色器只用 `g_Texture0Resolution` 算宽高比、不采样它。所以尺寸实际就是场景帧缓冲的尺寸。【确：样本】

### 1.2 几何【确】
- `FUN_1402066a0`（图像层 +0xb0）建四边形：
  - `+0x2e0` 一律 2×2。
  - `+0x2e8` 用尺寸参数，fullscreen 时就是 2×2，居中、不内缩。
  - `+0x490` 在没有合成时同样 2×2，`flags & 0x226` 里有 fullscreen 位，所以不内缩。
- 结果是一块 [−1, 1]² 的四边形。`W` 照常算（`origin`/`scale`/`angles` 都在里面），不同路径对它的处理不同，见 1.3。

### 1.3 绘制流程
- **无效果直接上屏**（`+0x320 < 1` 且没有 `0x10`）【确】：`FUN_1401e8aa0` 把 `W` 乘进模型矩阵，视图投影用场景相机，然后 `vfunc+0xf0` = `FUN_140208670` 画 `+0x490`。也就是说引擎并不把 fullscreen 层换成单位矩阵，**铺满靠的是着色器不乘 MVP**：
  - `passthrough.vert` 没定义 `TRANSFORM` 时 `gl_Position = a_Position`；
  - `cloudsbg.vert` 也是 `gl_Position = vec4(a_Position, 1)`。
  - 【推】如果 fullscreen 模型的着色器乘了 `g_ModelViewProjectionMatrix`，这块 2×2 会被当成世界里 2×2 像素的方块。
- **合成路径**（有效果，或有 `0x10`，或是带子层的组合层）【确】：
  - 不压合成 RT、不画基础材质：`FUN_1401e8aa0` 的 fullscreen 分支（`0x1401e98ea`）直接调合成 RT 的 `vfunc+8`，即 B6/B8 的「从当前绑定的目标拷贝」（`CopyResource`）。合成 RT 0 = **当前目标**（场景目标，或外层组合层的合成 RT）的整张拷贝。
  - 有子层时再压合成 RT，用 `FUN_1401ecb20` 把子树画上去，见 2.5。
  - 之后效果 pass 的投影是 `ortho(−1, 1, −1, 1, −1000, 1000)`（`0x1401e9a1e`）。
- **上屏**【确】：`0x1401e9cc9` 之后，fullscreen 时模型、视图都设成单位矩阵，投影设成 `ortho(−1, 1, −1, 1, −1, 1)`，所以末 pass（或 passthrough 上屏）画的 `+0x2e8`（2×2）正好铺满。非 fullscreen 时才乘 `W`，`perspective`（`+0x120 & 0x80`）的层另外压相机（`FUN_1401e5b60`）。
- **快照**【确】（B8 规则 1 的读码确认，`FUN_1401e8aa0` 开头）：只在（材质要帧缓冲或 cbm ∉ {0, 31}）且（非 fullscreen 或 cbm ∉ {0, 31} 或有子层）且（父层不是组合层）时，才在层开始时拷 `_rt_FullFrameBuffer`。fullscreen 走合成路径时不需要快照，因为合成 RT 本身就是拷贝。
- **颜色**【推】：合成路径不画基础 pass，`g_Color4` 不会被这一层设置（B10：效果 pass 不重设颜色），所以效果 pass 里拿到的是上一个设置过颜色的层的值。这一层的 `alpha`/`color` 在这条路径上不生效。

### 1.4 和相机、排序的关系
- `+0x120 & 0x200` 只用在两处【确】：
  - **透明物体排序** `FUN_1401865c0`（`0x14018ae3f` 调）：排序键 = `dot(对象 +0x128..+0x130, ctx+0x160..)`，带这个位的对象键是 −∞（`0x140492a28` = `-inf`）。插入排序 `FUN_14019ee60` 是**降序**的稳定排序（大于表头就挪到前面），排完按序写回再依次画，所以 −∞ 的对象**最后画**。
  - **光标拾取**的同类排序（`FUN_140189e10`），不影响画面。
- 透明表只在场景标志 `(+0xe0 & 0x1008) == 0x1000` 时用【确】，`0x8` 是正交投影（`0x1401875df`：`orthogonalprojection` 的宽高非 0 时置位）。
  - 这时先按列表顺序画不在透明表里的对象，再画排好序的透明表。
  - 其它情况按列表顺序全部画（`0x14018aedf` 分支），`0x200` 不起作用。
  - `0x1000` 由谁置位没查到，见「未查清」。
- 进透明表的条件是构造之后 `+0x120 & 0x100`（`0x140190952`）。图像层的 `0x100` 在构造函数里定，见 2.1。

### 1.5 neon_sunset（透视场景）【推】
- `Fullscreen`（id 52，`cloudsbg.json`）：材质 blend 是 normal，不是 passthrough → 没有 `0x100`，在第一遍按列表顺序画，它是第一个对象。没有效果 → 直接上屏，着色器不乘 MVP，铺满成为背景。
- `Fullscreen`（id 53，`fullscreenlayer.json` + filmgrain）：translucent + passthrough → 有 `0x100`，排序键 −∞ → 在所有透明物体之后画。
  - 合成 RT = 那时场景目标的拷贝，跑 filmgrain，末 pass 用单位矩阵、NDC，混合取基础材质的 translucent。
  - 相机路径、视差都不影响它。

**对实现的含义**
- fullscreen 层不跟相机：上屏一律用 NDC 四边形，忽略 `origin`/`scale`/`angles`/`size`、透视、视差、抖动。
- 没有效果的 fullscreen 层：画一块 [−1, 1]² 四边形，MVP 照常算出来交给着色器，用不用由着色器决定。
- 有效果的 fullscreen 层（语料里都是 `fullscreenlayer.json`）：合成 RT 0 = 当前目标的 `copyTextureToTexture`，跑效果链，末 pass 在 NDC 上屏，blend 取基础材质（translucent）。尺寸 = 场景目标尺寸，不受纹理降级影响。
- 透视场景还要「透明表 + −∞」的排序规则，正交场景按列表顺序即可。语料 41/42 个 fullscreen 对象是 `fullscreenlayer.json`。

**建议实测**
- 工程 A（正交 1920×1080）：
  - 背景放一张棋盘图。
  - 加一个 `fullscreenlayer.json` 层，`origin` 设 (100, 50)、`scale` 0.5、`angles` z = 0.7、`size` 300×200，挂一个 tint 效果。
  - RenderDoc 抓帧，核对：
    - 合成 RT 是 1920×1080，第一次写入是 `CopyResource`，没有基础材质的 draw；
    - 末 pass 的顶点是 ±1，MVP 是单位阵；
    - 画面整屏都染了色。
  - 再去掉效果，核对没有任何 draw（见 2.7）。
- 工程 B：在 A 的基础上，把棋盘图层的模型换成 fullscreen + 乘 MVP 的自写着色器，核对是不是一块按 `W` 变换的 2×2 像素方块。这个工程验证「铺满靠着色器」。
- 工程 C（透视）：在列表**最前面**放一个 translucent 的 fullscreenlayer 层（带效果），后面放一个透明粒子。核对它是不是最后画、粒子有没有被它盖住；再把场景改成正交，核对它是不是变成最先画。

---

## 2. `passthrough`（组合层）

### 2.1 加载时的对象标志【确】（构造函数尾 `0x1401fb32b`–`0x1401fb35f`）
| 基础材质 blend（`+0x1f0`） | passthrough | `copybackground`（`+0x304 & 0x40`） | 置位 |
|---|---|---|---|
| 0 normal / 3 alphatocoverage | 否 | — | 无 |
| 0 / 3 | 是 | 1 | `0x4` |
| 0 / 3 | 是 | 0 | `0x100`、`0x4` |
| 1 translucent / 2 additive | 否 | — | `0x100` |
| 1 / 2 | 是 | — | `0x100`、`0x4` |

- **更正 B9「加载时标记为透明排序对象」**：构造函数在 `FUN_14018ff60`（`0x1401902b6`）里调，属性解析要等虚函数 +0x40 → `FUN_1401e6f50` → `FUN_1401de470`。所以这里读到的 `copybackground` 总是基类默认的 1，表中第三行从 JSON 走不到，入透明表（`0x140190952`）只看材质 blend。四个 util 组合层的材质都是 translucent → 总是 `0x100 | 0x4`，`copybackground` 不影响排序。【确：调用顺序；`copybackground` 的 setter `FUN_1401ef350` 只改 `0x40` 位】
- `puppet` 在 `(flags & 0x22) != 0` 时整段跳过（`FUN_1401fbae0`，`0x1401fbb9b`），fullscreen 和组合层不加载木偶网格。

### 2.2 子树归属【确】（`FUN_1401dd9a0` / `FUN_1401dd900`，`children.asm`）
- 设置父对象时：父层有 `0x2` 或 `0x4` → 自己置 `0x2`，所有子孙递归置 `0x2`。否则清掉自己的 `0x2`；如果自己是组合层（`0x4`），子孙递归置 `0x2`，否则把子孙重新按同一规则算。结果：**组合层的所有子孙（任意深度）都带 `0x2`**。
- 场景渲染循环（`0x14018adb9`、`0x14018ae63`、`0x14018aef3`）对 `+0x120 & 0x2` 的对象直接跳过，这些子孙在顶层不画。它们仍可能在透明表里，只是同样被跳过。
- 子树由组合层自己画，`FUN_140207b50` 尾部和 `FUN_1401ecb20` 是同一段逻辑：
  - 按子对象 vector 顺序，直接子层先过 `vfunc+0x68`（可见性），再调 `vfunc+0x50`（渲染）；
  - 直接子层不是组合层时，再用 `FUN_1401eca70` **先序递归**画它的整棵子树；遇到嵌套组合层就停止下探，那棵子树由嵌套层自己画进自己的合成 RT；
  - 递归里不再预先检查可见性，但图像层的 `vfunc+0x50` = `FUN_140206430` 进入 `FUN_1401e8aa0`，一开头就检查自己和父链的可见性。【推】效果等同于尊重可见性。
- 【推】子 vector 的顺序就是 scene.json 里的加载顺序，没核对。

### 2.3 合成 RT（`FUN_1401ea500`，补充 B5）【确】
- 个数：`(+0x304 >> 4 & 1) + +0x320`。为 0 且是组合层（`0x4`）且有子层时取 1，否则 `min(2, ·)`，< 1 就不分配。
- 尺寸：非 fullscreen 的组合层取 `round(size)`；fullscreen 取帧缓冲尺寸（1.1）；最后 `max(4, ·)`。
- UV：纹理回调里，`+0x320 > 0` 或有 `0x10` 时 UV 上界取 1，否则取图像/纹理尺寸比（`_rt_FullFrameBuffer` 上应为 1【推】）。
- 内缩：组合层的 `+0x2e8` 和 `+0x490` 都不内缩（L22）。
- 池化 RT 命名里的 `k`（B5）按父链上组合层的计数错开（`0x1401eaf15` 附近），避免嵌套组合层和外层争用同一张池 RT。

### 2.4 基础 pass（`FUN_1401e8aa0` 合成分支 + `FUN_140207b50`）【确】
- 非 fullscreen：压合成 RT。
  - 普通图像：模型矩阵换成对着 RT 像素的正交（B7）。
  - 组合层：**模型 = `W`、视图投影 = 场景相机**（`0x1401e9690` 之后的 `else` 分支）。
- `copybackground: true`：画 `+0x2e8`（世界四边形，`size` 大小，居中，不内缩），材质 `composelayer`：
  - 顶点着色器 `gl_Position = vec4(uv·2 − 1, 0, 1)`，HLSL 下翻 v，四边形铺满整个合成 RT；
  - `v_ScreenCoord = MVP·pos` 的 `.xyw`，片元按 `xy / w · 0.5 + 0.5` 采 `g_Texture0` = `_rt_FullFrameBuffer`。
  - 结果：合成 RT = **层四边形在屏幕上覆盖的那块快照**，按透视正确地重采样到层的局部 UV（旋转、透视都对）。
  - `CLEARALPHA` 组合键会把 alpha 写成 0，util 材质没开。
- `copybackground: false`：不画基础材质，`dev->vfunc_0x118(0, 0, 0, 0)` 设清屏色，`vfunc_0x120(1, 0)` 只清颜色、不清深度 → 合成 RT = (0, 0, 0, 0)。
- fullscreen：见 1.3（`CopyResource`，不画基础材质）。
- **嵌套组合层**（自己 `0x4`，又在别的组合层子树里 `0x2`，`(+0x120 & 6) == 6`）：基础 pass 前把视图、投影换回 `ctx+0x1168..` / `ctx+0x11a8..`【推：保存下来的场景相机】，好让 composelayer 按真实屏幕坐标采快照。它的父层是组合层，按 1.3 的快照规则不会自己拷快照，所以采到的是外层开始时那份快照（外层背后的场景，不含外层组里先画的兄弟层）。【推】
- 颜色：`g_Color4 = (color·k, alpha)`；组合层或 instanced、且材质 `+0x1f8 bit2`（绑了用户纹理，见 6.2）时强制 (1, 1, 1, 1)。`composelayer.frag` 和 `passthrough.frag` 都不读 `g_Color4`。【推】组合层的 `alpha`/`color` 只有效果着色器读引擎颜色时才有作用。

### 2.5 子树画进合成 RT【确】
- 前提 `+0x120 & 4` 且子 vector 非空（`LAB_140208217`；fullscreen 时是 `FUN_1401ecb20`）。
- 保存模型、视图、投影。非 fullscreen 时设：
  - **模型 = `inverse(W)`**（`FUN_14005f730`）；
  - 视图 = 单位阵；
  - **投影 = `ortho(−w/2, w/2, −h/2, h/2, −1000, 1000)`**，`w, h` = `+0x2f0/+0x2f4`。
  - 子层自己再乘自己的世界矩阵，所以子层落在层的局部坐标系里（去掉了层的旋转、缩放、平移），**层矩形以外的部分被裁掉**。
- fullscreen 时矩阵不变：子层按场景相机画进全屏 RT。
- `ctx+0xaf0..` = 当前模型矩阵，画完恢复单位阵。这就是 rea-p4c 提到的「组合层里世界空间粒子系统用 `ctx+0xaf0`」。
- `copybackground: false` 时：`ctx+0x1c9` 计数加一并调 `dev->vfunc_0xe8(1)`，计数归零时调 `vfunc_0xe8(0)`。它置设备状态字 `+0x28` 的 `0x10`。混合状态构建 `FUN_140099f60`（`blend.asm`）的读法【确】：
  - 状态 `0x8` 或 `0x10` → 写掩码 RGBA，否则 **RGB**（7）；
  - `0x10` → alpha 通道 `SrcBlendAlpha = ONE`、`DestBlendAlpha = ONE`、`BlendOpAlpha = MAX`；
  - 颜色通道仍按各子层自己的混合模式。
  - 混合模式本身：0 不混合；1 translucent，颜色和 alpha 都是 `SRC_ALPHA / INV_SRC_ALPHA`；2 additive，`SRC_ALPHA / ONE`；3 = 0 + alpha-to-coverage。
  - 结论：「只合成子层」的组，**alpha = 各子层 alpha 的最大值**，颜色在 (0, 0, 0, 0) 上按普通混合累积，translucent 子层画在空底上得到 `rgb·a`。
- `copybackground: true` 时不开 `0x10`，子层按普通混合画在背景快照上。
- 写 alpha：合成渲染开始时 `dev->vfunc_0xd8(1, 1)`（`0x1401e9312`/`0x1401e93cb`，颜色、alpha 都写），结束时 `(1, 0)`。`vfunc_0xd8` 置 `0x200` 颜色写、`0x8` alpha 写；`0x200` 关时模式被换成 4，写掩码只剩 A。【推】场景上的普通绘制默认不写 alpha。

### 2.6 效果链与上屏【确】
- 效果链同 B6/B7：基础 pass + 子树的结果是第一张输入。
- 末 pass：普通情况在最后一个启用效果的最后一个绘制 pass 上屏，用 `+0x2e8`，blend 和深度状态取基础材质（B7）。fullscreen 上屏用单位矩阵和 NDC（1.3）。
- 有 `0x10`（colorBlendMode 混合）时：
  - 所有 pass 都留在合成 RT；
  - 最后 `g_Color4 = (1, 1, 1, 1)`，passthrough 材质 `+0x2c0` 的槽 0 = 合成 RT；
  - blend：cbm 31 时取 2，否则 `vfunc+0x120`【推：基础材质 blend】；
  - `vfunc+0xf8` = `FUN_140208c80` 画 `+0x2e8`。
- **无效果、有子层**（`FUN_1401e8ff3` 分支）：
  - 先 `vfunc_0xd8(1, 1)` 和 `FUN_1401ec720`（压合成 RT，按 copybackground 画背景或清屏，再画子树）；
  - 回到直接上屏：`FUN_140208670` 把**基础材质**槽 0（`+0xd0`）换成合成 RT 的纹理（不恢复），画 `+0x490`；
  - blend：cbm 31 → additive；`(flags & 0x60) == 0x20`（组合层且 `copybackground: false`）→ 强制 translucent（B9 确认）；否则取基础材质 blend。
  - 【推】这里仍用 composelayer 着色器：输出铺满整个目标，按层四边形的屏幕投影坐标采合成 RT。只有层四边形正好覆盖全屏时结果才对，层比屏幕小时会把合成 RT 的一块子区域拉满全屏。fullscreenlayer 用的 `passthrough.vert` 没有这个问题（2×2 本来就是 NDC）。需要实测。

### 2.7 不画的情况【确】
- 走直接上屏（`+0x320 < 1` 且没有 `0x10`）的组合层，没有子层就直接 `goto LAB_1401ea215`，整层没有任何 draw。
- 语料里这样的对象有 22 个：composelayer 9 + 4 + 2 + 1、fullscreenlayer 6、projectlayer 1 + 1 中 cbm 为 0/空的那些（`scan/ptstat.py`）。

### 2.8 四个 util 模型
| 模型 | 模型键 | 材质 | 着色器 | 深度 | 区别 |
|---|---|---|---|---|---|
| `composelayer.json` | passthrough | `materials/util/composelayer.json` | composelayer | test、write 都关 | 尺寸 = 对象 `size`，几何随 `W` 与相机 |
| `composelayer_depthtest.json` | passthrough | `composelayer_depthtest.json` | composelayer | **depthtest 开**，write 关 | 基础 pass 和末 pass（B7 把基础材质的 `+0x1f2/+0x1f3` 拷给末 pass）做深度测试，组可以被 3D 物体遮住【推】 |
| `fullscreenlayer.json` | fullscreen、passthrough | `fullscreenlayer.json` | passthrough（无 `TRANSFORM`） | 关 | 见第 1 节：拷贝当前目标、NDC 上屏、不跟相机、尺寸 = 帧缓冲 |
| `projectlayer.json` | passthrough、autosize、projectlayer | 同 composelayer | composelayer | 关 | 尺寸 = 正交投影宽高；排序键 −∞（第 3 节） |

四个材质都是 translucent、`nocull`，槽 0 都是 `_rt_FullFrameBuffer`。

### 2.9 对象 `config: {"passthrough": true}`【确，有界】
- `wallpaper64.exe` 里 `\0config\0` 只有一处（`0x140474c14`），6 个引用都在 `0x14001fdc0`、`0x140021e50` 两个函数里，读的是托盘、播放列表、配置文件（`wallpaperconfigrecent`、`playlists`、`profiles`）。没有 `config` 结尾的尾部合并串指向场景代码（`suffref.py`，只有 `wallpaperconfig`、`monitorconfig`、`lightconfig`）。
- `passthrough` 只在模型解析 `0x1401fae95` 读一次，所以对象级的 `config.passthrough` 渲染时没人读。
- 【推】编辑器的元数据：`wallpaperui.exe` 里 `config` 挨着 `showimportoptions`、`copycommand`、`addcommand`、`shaderpresetkey`、`ismodel`，像是「添加资源」命令的配置。语料 25 个都挂在 composelayer 上，和模型自带的 `passthrough` 重复。

**对实现的含义**
- `object:config` 改成中性。
- 组合层是一套「组」机制，要做三件事：
  1. 子孙在顶层不画，由组合层先序画进合成 RT，遇到嵌套组合层就停止下探；
  2. 组的合成 RT 按层 `size` 分配，子层用 `inverse(W)` 加局部正交画进去，层矩形外裁掉；
  3. 基础 pass 按 `copybackground` 分两种：true 用 composelayer 着色器从快照透视正确地拷层背后的屏幕，false 清成透明并用「alpha = MAX」的混合。
- 上屏和普通带效果层一样，走最后一个效果 pass 加基础材质的 blend（translucent）。没有效果也没有子层就跳过。
- 语料里绝大多数（174 个中 140 多个）是「有效果、无子层」，只需要「背景快照 → 效果链 → 世界四边形 translucent 上屏」，可以先做这部分，带子层的 6 个对象后做。
- WebGPU：快照用已有的 `copyTextureToTexture`。composelayer 的透视采样可以照抄着色器（以 `v_ScreenCoord.z` 做透视除法）。alpha MAX 对应 `blend.alpha = {srcFactor: "one", dstFactor: "one", operation: "max"}`，写掩码 RGBA。

**建议实测**
- 工程 D（正交 1920×1080）：
  - 背景放渐变图。
  - 加一个 composelayer：`size` 800×400，`origin` (700, 600)，`angles` z = 0.4，挂 tint 效果。
  - 核对：合成 RT 800×400；基础 pass 的 draw 用 composelayer 着色器、顶点是 RT 全屏；末 pass 画旋转的世界四边形；屏幕上只有那块矩形被染色。
  - 再去掉效果，核对没有 draw。
- 工程 E：
  - 在 D 的组合层下挂两个子图像层：红、蓝，各 alpha 0.5，部分重叠，其中一个伸出组合层矩形之外。
  - 分别开、关 `copybackground`，读合成 RT 的像素值，核对：false 时重叠处 alpha = 0.5（MAX），而不是 0.75；伸出部分被裁掉；子层不在顶层再画一次（数 draw）。
- 工程 F：组合层无效果，挂子层，`size` 小于屏幕，核对 2.6 的「直接上屏铺满全屏并拉伸」推断。
- 工程 G（透视）：composelayer_depthtest 组前面放一个 3D 网格，核对组有没有被深度遮挡。

---

## 3. `projectlayer`

### 3.1 作用【确】
- 构造函数 `0x1401faef6`：`+0x304 |= 0x400`、`+0x120 |= 0x200`（和 fullscreen 共用排序键 −∞，见 1.4）。
- 纹理回调 `FUN_140209360` 的 autosize 分支（`0x1402093f6`）：不是精灵表且有 `projectlayer` 时，`size := (ctx+0x84, ctx+0x88)`。
  - 这两个值是 `general.orthogonalprojection` 的 `width`/`height` 取整（`0x1401875eb`/`0x1401875fb`，`ortho.asm`）。
  - `"auto"` 时这里不写，由别处写【未知】。
- **`projectlayer` 只在 `autosize` 分支里读**；单独写 `projectlayer` 不写 `autosize` 时，只剩排序键的作用。在 `0x1401e0000`–`0x140212000` 里搜 bit 10，只有 `0x1402093f6` 是读图层 `+0x304`，其余三处读的是材质、木偶标志。【确，有界】
- 别的方面它就是 composelayer：同样的材质、几何随 `W` 与相机、合成 RT = `round(size)`、不内缩。
- 「投影」指的是**尺寸跟随场景的投影尺寸**：放在场景中心、`scale` 为 1 的正交场景里，它正好覆盖整屏，是编辑器的「全组合层」（Full Composition Layer）。语料 11 个对象的 `size` 都等于正交投影尺寸，`origin` 都在中心。

**对实现的含义**
- 实现成「`size` = 正交投影宽高的 composelayer」即可。正交场景按列表顺序画，排序键不起作用。
- 透视场景里（正交投影为 null）尺寸来源未知，语料里没有这种用法。

**建议实测**
- 工程 H（正交 1920×1080）：projectlayer 的 `size` 写成 500×300，挂 tint，核对染色区域是 1920×1080（size 被覆盖）。
- 再把 `orthogonalprojection` 改成 1280×720，核对合成 RT 尺寸变成 1280×720。

---

## 4. `cropoffset`

### 4.1 运行时不读【确，有界】
- `wallpaper64.exe` 全文件按 ASCII 和 UTF-16LE 搜 `cropoffset`、`crop`，都没有（`findstr.py`）；`wallpaper32.exe` 没查。
- 安装目录的 exe/dll（深度 3 以内）里，只有 `bin\wallpaperui.exe` 和 `distribution\bin\wallpaperui.exe` 有。它周围的字符串是 `croptransparent`、`croppadding`、`cropandresize`、`nopadding`、`autosize`、`cropx0/x1/y0/y1`、`cropoffset`、`'Failed writing image model metadata to %S.'`。
- 所以这是编辑器导入图片时写进图像模型 JSON 的元数据，渲染器忽略。

### 4.2 含义（编辑器侧）【推】
- 语料 275 个对象，255 个是 `{autosize, cropoffset, material}`，20 个另有 `puppet`。
- 样本 `2833017810` 的 `grid`：纹理图像 3840×956，原图应是 3840×2160。`cropoffset "0 -602"`，`origin.y = 478 = 1080 − 602`。
- 推断：`cropoffset` = **裁掉透明边后的图像中心相对原图中心的像素偏移**（y 向上），编辑器导入时已经把它加进了 `origin`。
- `pillar` 的 `"1435.5 -20"` 与 609×1733 的图像也能对上「横向在原图里很偏右」。
- 它和 `size`、`autosize`、`solidlayer` 在运行时没有关系。

**对实现的含义**
- `model:cropoffset` 改成中性，不做任何平移，不然会重复加偏移。

**建议实测**
- 拿一张带 `cropoffset` 的样本，在副本里把值改成 `"500 500"`，在 WPE 里比改前改后的画面哈希，应当一致。

---

## 5. `nopadding`

### 5.1 padding 指什么【确：样本】
- 编辑器把普通图片的纹理补到 2 的幂：`pillar` 纹理 1024×2048、图像 609×1733，`grid` 纹理 4096×1024、图像 3840×956。写了 `nopadding` 的纹理不补：
  - `3146703458` 的 `Persona 3 Reload`：纹理 = 图像 = 3840×2160；
  - `3173418061`：纹理 = 图像 = 2560×1600。
- 这两个样本的纹理标志是 `0x22`/`0x23`，补边的是 `0x2`（`texhdr.py`）。【推】纹理标志 `0x20` 对应「未补边」，`FUN_140207b50` 在纹理降级时检查的 `tex+0x1c & 0x20` 可能就是它，没深究。
- 语料 50 个对象都是 `{width, height, material, nopadding}`，模型的 `width`/`height` = 图像尺寸。

### 5.2 运行时作用（补全 L22）【确，有界：读了 `FUN_1401fac50`、`FUN_1402066a0`、`FUN_1401ea310`、`FUN_1402091e0`、`FUN_140207b50`、`FUN_140208670`、`FUN_1401e8aa0`、`FUN_140209360`，并在 `wp.asm` 里搜了对 `+0x304` 的 bit 2 测试，只有 `0x1402068fc` 的 `test ecx, 0x226`】
- 只有一处：`FUN_1402066a0` 建 `+0x490`（直接上屏四边形）时，`flags & 0x226`（fullscreen、nopadding、passthrough、solidlayer）不为 0 就**不内缩**，flags = 1，否则 flags = 3（居中 + 内缩）。
- 内缩量 `e = 0.15 / 纹理尺寸`，UV = `e .. uvScale − e`（`FUN_1401ede30`）。
- `+0x2e8`（带效果末 pass、colorBlendMode 上屏）看 `flags & 0x222`，**不含 nopadding**，所以带效果时 nopadding 层的末 pass 仍内缩 `0.15 / 纹理尺寸`。L22 的结论成立。
- 几何、合成 RT 尺寸、基础 pass（`+0x2d8`，flags 0）都不受影响。

| | 无 nopadding | 有 nopadding |
|---|---|---|
| 无效果直接上屏 `+0x490` | UV `e .. imgW/texW − e` | UV `0 .. imgW/texW`（这类纹理比值是 1） |
| 基础 pass `+0x2d8` | `0 .. scale` | 同左 |
| 末 pass `+0x2e8` | `e .. 1 − e` | 同左 |
| 合成 RT | 图像尺寸 | 同左 |
| 几何 | `(int) size` | 同左 |

**对实现的含义**
- `uvInset` 增加一个条件：无效果的层在 `nopadding` 时不内缩；有效果的层末 pass 照旧内缩。不需要别的改动，可以直接放进支持表。

**建议实测**
- 工程 I：拿一张 1920×1080 的 NPOT 纹理（编辑器不补边导入），图层 1:1 铺满屏幕，模型写和不写 `nopadding` 各抓一帧，比较最外一圈像素：不写时边缘采样往里缩 0.15 texel。
- 再给它挂一个中性效果（如 alpha 1 的 opacity），核对两种写法结果一致。

---

## 6. `instanced`

### 6.1 这类模型是什么【确：样本 + 代码】
- 语料 103 个对象都是 `models/solid_instance_model_<hash>.json` = `{instanced, solidlayer, material: materials/util/solidlayer_instance[_3|_4|_depthtest…].json}`。材质是 translucent 的 `genericimage2`/`genericimage4`，槽 0 `util/white`（32×32，`white.py`）。
- 对象上另有 `instance` 键：66 个是 `{combos, id, textures}`，37 个多了 `usertextures`，例如 `[{"name": "$mediaThumbnail", "type": "system"}]`。
- 这是编辑器的「纯色图层 / 占位图层」，名字有「纯色占位符」「黑色遮罩」「Music Cover」等。

### 6.2 加载（构造函数 `0x1401faf5e` 之后）【确】
- `instanced` 时**不**直接按名字加载材质，改为：
  1. 读对象 `size`（必须是字符串 `"w h"`，两次 `atof`）写进 `+0x2f0/+0x2f4`，后面属性解析还会再写一次同样的值；
  2. 复制对象 `instance` 对象，把 `instance.usertexturereference.width/height` 改成这个尺寸；
  3. `FUN_140150770(ctx+0x1630, 材质名, instance)` 生成实例材质，名字带 `_instance_`。
- 材质加载 `FUN_140155785` 一带读 `shader`、`combos`、`textures`、`usertextures`（`name`、`type`，`system`/`user`，`keepaspect`）、`usertexturereference`、`constantshadervalues`、`usershadervalues`。【推】`instance` 按材质 pass 的同名键覆盖。
- `usertexturereference` 的宽高只在绑了**用户纹理**时用（`0x140155a4a`）：
  - 写进材质 `+0x2b0/+0x2b2`，按宽高比生成 `usershortcut_*` 纹理；
  - 置材质 `+0x1f8 |= 4`（`0x140155e41`）。
- 材质 `+0x1f8 bit2` 的两个后果：
  - 组合层或 instanced 的颜色强制 (1, 1, 1, 1)（`FUN_140207b50`、`FUN_140208670` 开头）；
  - `autosize` 时尺寸取 `+0x2b0/+0x2b2`（`FUN_140209360`）。

### 6.3 「合成 RT 仍按纹理尺寸」的含义【确】
- `FUN_1402091e0`（`0x1402092db`）：`solidlayer`/passthrough 本来让合成 RT 改按 `round(size)`，但 `instanced` 跳过这一步。所以 instanced 纯色层的合成 RT = 槽 0 纹理的图像尺寸：
  - `util/white` 是 **32×32**；
  - 绑了用户纹理时是那张纹理的尺寸。
- 几何不受影响：`+0x490`、`+0x2e8` 按 `(int) size`。没有效果时直接上屏，32×32 的白纹理拉伸到 `size`，纯色看不出差别。
- **有效果时**（语料 45/103，如 opacity 遮罩、tint、blendgradient、自定义用户纹理效果），基础 pass 和整条效果链都在 32×32（降级系数之后，至少 4）上跑，最后拉伸上屏。遮罩类效果会明显变糊。【推：画面后果】这个结论读码明确，但和直觉差得多，必须实测。
- UV 内缩：`solidlayer` 位让 `+0x490` 和 `+0x2e8` 都不内缩（L22）。

### 6.4 和粒子、别的对象的关系
- 【确，有界】`0x800` 只在图像层的这几个函数里读：构造函数、`FUN_1402091e0`、`FUN_140207b50`（`0x140207de5`，只在 `+0x4b0` 木偶附件路径下按 `size / 纹理尺寸` 缩放 `ctx+0xa70` 矩阵）、`FUN_140207b50`/`FUN_140208670` 的 `0x820` 颜色判断。
- 粒子的「instance」（`instanceoverride`）是另一套，和这里无关。

**对实现的含义**
- 没有效果的 instanced 纯色层：按「`size` 大小、实例材质（覆盖 `textures` 等）」的普通图层画即可。
- 有效果的：合成 RT 尺寸按纹理图像尺寸（32×32），是 `compositeSize` 现有逻辑的特例。`bundle.ts` 的 `solidLayer = solidlayer && !instanced` 已经是这个意思。
- `instance` 的覆盖规则和用户纹理（`usertextures`、`$mediaThumbnail`）属于材质系统，P5 可以只支持 `textures`/`combos` 覆盖，`usertextures` 照报。

**建议实测**
- 工程 J（正交 1920×1080）：
  - 在 WPE 编辑器里建一个纯色图层，`size` 1920×1080，挂 opacity 效果，遮罩用一张锐利的黑白棋盘。
  - RenderDoc 核对合成 RT 尺寸（预期 32×32）和遮罩边缘是否糊。
  - 再复制一个，把模型里的 `instanced` 去掉、材质改成普通 genericimage2 + `util/white`，对比合成 RT 是不是 1920×1080。

---

## 7. 模型解析读的全部键

`FUN_1401fac50`（构造函数，`modelparse.asm`）加上 `FUN_1401fbae0`（虚函数 +0x40）。两处都先用 `FUN_1401fd330` 按对象 `image` 读模型 JSON，`FUN_1401fd330` 只有这两个调用者。所有模型键字符串的引用都核过（`suffref.py`），只在这两处。【确】

| 键 | 类型要求 | 缺省 | 写到 | 影响画面 |
|---|---|---|---|---|
| `material` | 字符串 | 空串 | 加载后存 `+0x498`（instanced 走实例化） | 是 |
| `width` | 数字（JSON int/uint/real，`type 1..3`） | 保留基类初值 **1.0** | `+0x2f0` | 是，但会被对象 `size`、`fullscreen`、`autosize` 依次覆盖（见下） |
| `height` | 同上 | 1.0 | `+0x2f4` | 同上 |
| `fullscreen` | 布尔 true | 关 | `+0x304 \|= 2`、`+0x120 \|= 0x200` | 是（第 1 节） |
| `nopadding` | 布尔 true | 关 | `+0x304 \|= 4` | 是，只影响直接上屏的 UV 内缩（第 5 节） |
| `autosize` | 布尔 true | 关 | `+0x304 \|= 8` | 是（见下） |
| `passthrough` | 布尔 true | 关 | `+0x304 \|= 0x20`，尾部 `+0x120 \|= 4`（可能还有 `0x100`） | 是（第 2 节） |
| `solidlayer` | 布尔 true | 关 | `+0x304 \|= 0x200` | 是，合成 RT 按 `size`、不内缩（L22），instanced 时前者不生效 |
| `projectlayer` | 布尔 true | 关 | `+0x304 \|= 0x400`、`+0x120 \|= 0x200` | 是（第 3 节） |
| `instanced` | 布尔 true | 关 | `+0x304 \|= 0x800`，并读对象 `size`、`instance` | 是（第 6 节） |
| `puppet` | 字符串，且 `(flags & 0x22) == 0` | 无 | `+0x4b8` 木偶 | 是，归 mdl 代理 |

- 没读的键：`cropoffset`（第 4 节）和编辑器写的其它键都被忽略。
- 布尔键必须是 JSON 布尔：`FUN_140086de0` 取值后判 `type == 5` 再 `asBool`，`1`、`"true"` 都不算。`features.ts` 的 `active()` 把 `1`、`"x"` 也当作开，可以对齐。
- 构造函数尾部还按材质 blend 定 `+0x120` 的 `0x100`/`0x4`（2.1），并在材质槽 0 纹理上登记就绪回调 `FUN_140209360`。

**尺寸的最终取值顺序**【确】
1. 基类构造：1 × 1。
2. 模型 `width`/`height`（数字）。
3. 对象 `size`（属性表，偏移 0x2f0；在 `FUN_1401e6f50` → `FUN_1401de470` 里解析，晚于构造函数）。
4. 纹理就绪（`FUN_140209360`，加载末尾和每次纹理就绪都跑）：
   - `fullscreen`：纹理图像尺寸，几何 2 × 2；
   - 否则 `autosize`：
     - 精灵表 → 帧尺寸；
     - `projectlayer` → 正交投影宽高；
     - 材质绑了用户纹理 → 用户纹理参考尺寸；
     - 否则 → 纹理图像尺寸。
   - **`autosize` 覆盖对象 `size`**。语料里两者一致（`pillar` 609×1733 = 图像），所以以前没暴露。
- `features.ts` 写的「`autosize`：`size` 与模型 `width`/`height` 都缺失时取基础纹理的图像尺寸」与此不符。`bundle.ts` 在三者都缺失时取纹理尺寸，而 WPE 此时是 1 × 1（没有 `autosize` 时），这一点同样不符，但语料里应该没有这种情况【推】。

**对实现的含义**
- `checkModelFeatures` 可以放开：
  - `cropoffset` 中性；
  - `nopadding` 支持（一处 UV 条件）；
  - `projectlayer` = autosize 取投影尺寸 + composelayer；
  - `fullscreen`、`passthrough` 需要第 1、2 节的流程；
  - `instanced` 需要实例材质，以及「合成 RT 按纹理尺寸」。
- 对象 `config` 中性。
- 尺寸取值改成上面的顺序（`autosize` 优先于 `size`）。

**建议实测**
- 工程 K：普通图像模型加 `autosize`，对象 `size` 写成纹理图像尺寸的一半，核对屏幕上的尺寸是图像尺寸。
- 再去掉 `autosize`、去掉模型 `width`/`height`、去掉对象 `size`，核对是不是 1 × 1 像素。

---

## 未查清
- **透视排序模式的开关**：场景标志 `+0xe0` 的 `0x1000` 由谁置位没找到（只看到 `0x8` 是正交、`0x10` 是 `auto`）；排序方向向量 `ctx+0x160` 是什么（推测是相机前向），以及对象 `+0x128..+0x130` 是不是世界位置。这些属于相机代理的范围。
- **组合层上屏和相机**：组合层的世界四边形 `+0x2e8` 受视差、抖动、相机路径怎样影响，归相机代理。`perspective`（`+0x120 & 0x80`）的层压的是哪套相机（`FUN_1401e5b60`），没查。
- **深度**：`composelayer_depthtest` 的深度测试对哪张深度缓冲生效，组合 RT 本身没有深度（B5），归 mdl 与深度代理。
- **画面推断**：2.6「无效果、有子层的 composelayer 直接上屏会铺满全屏并拉伸」是由着色器推出来的，没在代码里看到别的补偿。
- **`ctx+0x84/+0x88`**：`orthogonalprojection` 为 `"auto"` 或 null 时由谁写，不清楚。
- **`_rt_FullFrameBuffer` 的图像尺寸**：等于场景目标尺寸还是窗口尺寸，没确认。它决定 fullscreen 层的合成 RT 尺寸。
- **场景普通绘制默认不写 alpha**：帧开始时由谁调 `vfunc_0xd8`、取什么值，没追。
- **设备 vtable**：`0x140485b90` 是扫出来的，靠槽语义吻合认定，没找到它的构造点。
- **未深入的路径**：`+0x4a0/+0x4a8/+0x4b0`（木偶附件 / `transformAttachmentToTexture` 的替代材质与渲染到纹理）只看了它们对本文流程的旁路，没深入。
- **`instance` 的覆盖细节**：哪些键能覆盖、`usertextures` 的 `system` 类型怎样取数据，归材质系统。
- **`wallpaper32.exe`**：没扫 `cropoffset`、`config`。
