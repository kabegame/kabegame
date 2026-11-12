# REA：P8 步骤 0 —— 图层依赖、合成 RT 引用与写入状态（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出（只做静态分析，没有运行、附加或启动 WPE）。置信度三档：**静态确认**（反编译或汇编直接看到）、**推断**（由代码推出，或依赖 D3D11 / 驱动自身的行为）、**未知**。
> 反编译出的字符串与代码只当数据看。地址一律是镜像基址 `0x140000000` 下的虚拟地址。

## 方法

- 分析副本：`d:\Codes\kabegame\ignore\p8\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（REA 会话报告的摘要一致）。
- REA（Ghidra 12.1.4）：开工时会话已经由并行的 layer 代理打开在同一个副本上（`ignore\p8\rea\render\start.rea-snapshot` 与 `layer\start.rea-snapshot` 逐字节相同），为了不打断它，本代理没有重新 `open_binary`，只做只读查询、没有任何元数据改动。快照见文末「快照」。
- 汇编按地址切自 `ignore\p4\rea\wp.asm`（全量反汇编），常量、字符串、虚表用 `ignore\p8\rea\*.py` 读副本；前几轮的反编译文本直接复用：`ignore\p5\rea\modelflags\f_1401e8aa0.c`、`f_1401ea500.c`、`f_1401ebf60.c`、`f_140207b50.c`、`f_140208670.c`、`f_1401ebbc0.c`，`ignore\p4\rea\p4a\m_14018ff60.c`。
- 本轮的脚本与摘录在 `ignore\p8\rea\render\`：
  - `near1518.py`（找「读设备对象 `ctx+0x1518` 后调某槽」）、`dump.py`（批量切摘录）、`tmp\`（grep 模式与中间结果）。
  - 汇编摘录 `asm\`：`deps_objctor_1401ddd5d.asm`（对象基类读 `dependencies`）、`deps_scenector_140187e95.asm`（场景构造里的依赖段）、`shouldrender_1401ea2d0.asm`、`e8aa0_head_1401e8aa0.asm`、`ea500_name_1401ea720.asm`、`blendstate_140099f60.asm`、`devstate_14009af50.asm`、`devctor_140098ea0.asm`、`reset_14011ffc0.asm`、`bindmat_state_140157150.asm`、`unbindmat_140157480.asm`、`alphawriting_map_140157d60.asm`、`a2c_combo_14015649d.asm`、`a2c_combo_140154bbc.asm`、`e8aa0_alpha_1401e930b.asm`、`e8aa0_pt_1401e9fd0.asm`、`e8aa0_tail_1401ea1a1.asm`、`final_override_1401ec5ee.asm`、`texget_14014d0a0.asm`、`texreg_14014c9a0.asm`、`rtctor_tail_1400d30e4.asm`、`rtdtor_1400d3290.asm`、`texswap_1400eeea0.asm`、`texload_fallback_1400ec330.asm`、`checker_140170510.asm`、`devcreatert_14009ada0.asm`、`devloadtex_14009aa20.asm`。
- 锚点：字符串 `dependencies`（`0x140490248`）、`_rt_imageLayerComposite_`（`0x1404906f8`）、后缀 `a`（`0x140490714`，全文件只有 `0x1401ea82b` 一处引用）、`alphawriting`（`0x14048b6c0`）、`alphatocoverage`（`0x14048b510`）、宏名 `ALPHATOCOVERAGE`（`0x14048b5a0`）、`error`（`0x14047228c`）。
- WPE 自带着色器只读查看：`assets\shaders\genericimage2.frag`、`genericimage4.frag`、`base\model_fragment_v1.h`。
- 命名（沿用前几轮）：
  - **图层 L**：图像层，虚表 `0x1404911a8`（类型号 1）；文本层虚表 `0x140491950`（类型号 4）；形状虚表 `0x140491d10`（类型号 0xa）。类型号是虚函数 `+0x60` 的返回值（`0x140050790` → 1、`0x1400fde90` → 4、`0x14025fa30` → 0xa）。
  - **`ctx`**：渲染上下文 `L+0xc8`；**设备对象 `dev`**：`ctx+0x1518`，虚表 `0x140485b90`。
  - **纹理表**：`ctx+0x1520` 处按名字（FNV-1a）索引的哈希表，文件纹理与渲染目标的纹理对象都登记在这里。
  - **RT 池**：`ctx+0x16c0`（`FUN_1401ab410` 按名字查，`FUN_1401ab570` 查不到就建）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | `dependencies` | 对象基类构造 `FUN_1401ddbb0` 读它（数组或对象，元素须能转成无符号整数，非整数元素丢弃），存成对象 `+0x1f8` 的 `unordered_set<uint64>`。**唯一的消费点**在场景构造 `FUN_140186c90`：所有对象加载完以后，把全部对象的 `dependencies` 取并集，对 id 在集合里、且类型是图像层（1）或文本层（4）的对象置 `L+0x304 \|= 0x1010`，原先没有 `0x10` 的再调虚函数 `+0x110` 重建资源。效果是：**被依赖图层强制走合成路径（`0x10`），第 0 张合成 RT 起名 `_rt_imageLayerComposite_<id>_a`；`0x1000` 让它不可见时也照画、跳过视锥剔除**。不改绘制顺序、不改加载顺序。 | 静态确认（「没有别的读取点」是在 `.text` 里有界搜索的结果） |
| 2a | 名字怎么解析 | 不按 id 查表。材质创建时（`FUN_1401515b0` → `FUN_14014cf90`）按**纹理名字**在 `ctx+0x1520` 纹理表里找；找不到就当文件纹理新建一个同名纹理对象登记进去。被依赖图层建 RT 时用同一个名字登记，发现已有同名对象，就把 RT 的 D3D 资源和纹理头**换进**那个已有对象（`vfunc+0x50` 交换）。所以绑定在加载时按名字定一次，材质手里的对象不变，内容随 RT 的建立 / 销毁而换。 | 静态确认 |
| 2b | 何时建、尺寸、格式、`_b` | 在场景构造的依赖段（加载末尾，所有对象都建完以后）经 `+0x110` → `FUN_1401ea500` 建；之后每次 `FUN_1401ea500` 重跑都先销毁再建。尺寸同 p2 B5（`FUN_1402091e0`：基础纹理的图像尺寸，组合层取 `round(size)`，最小 4）；格式 HDR 为 RGBA16F，否则 RGBA8；纹理标志 = 图层 `nointerpolation` / `clampuvs`（与本图层采样自己合成 RT 同一套）。**`_b` 不存在**：只有第 0 张、且只有 `0x10` 时才起这个名字，后缀写死 `a`。 | 静态确认 |
| 2c | RT 里装什么 | **走完整条 effect 链后的结果**：`0x10` 下所有 effect pass 都留在合成 RT，乒乓的起点按奇偶选，最终结果总落在第 0 张，即 `_a`。没有 effect 也有一张 `_a`（个数 = 1），装基础 pass 的结果（图层图像 × `g_Color4`，图层局部像素空间，不经 `W`）。组合层（`copybackground` 缺省）装的是它背后那块场景快照。 | 静态确认（「最终落在第 0 张」由奇偶推出，和起名只在第 0 张一致） |
| 2d | 写死 `visible:false` | 照画进 RT（层首快照、基础 pass、整条 effect 链都跑），**不上屏**：上屏只在「真可见」时做。可见的被依赖图层改走 passthrough 上屏（`effectpassthrough(_4)`，`BLENDMODE` 0，`g_Color4` = 1，混合取基础材质），最后一个 effect 不再直接上屏。 | 静态确认 |
| 2e | 先后 | WPE **不按 `dependencies` 排序**，仍按对象列表顺序画。被引用者排在引用方之后时，引用方读到的是 `_a` 里**上一帧**留下的内容（独占 RT 跨帧保留、不清）。 | 静态确认（不排序）；读到上一帧为推断 |
| 2f | id 不存在 / 不是图像或文本层 | 没有对象会建这个名字的 RT，槽里一直是加载时新建的「文件纹理」：文件找不到，退回 **6×6 RGBA8 黄黑棋盘格**（(0,0) 黑，相邻格 (255,255,0,255)，纹理标志 9）。`_b` 后缀同样落到这里。形状、模型、粒子被列进 `dependencies` 都不会建 RT。 | 静态确认（棋盘格生成代码）；「这类名字一定走到退回分支」为推断 |
| 3 | 自引用 | **`bind` 胜出**：每次执行 pass 时，`FUN_1401ebf60` 先按 `bind` 把 RT 写进材质的槽（`material+0xd0+8*slot`），再绑定材质；实例 `textures` 只在材质创建时写一次，被覆盖。例外：当前没有合成 RT（`param_4 < 0`，形状对象那条路）时 `-1`（`previous`）的 bind 跳过，槽里保留实例纹理。 | 静态确认 |
| 4 | `alphawriting` | 写掩码由设备状态字 `dev+0x28` 决定：`0x200` 写颜色、`0x8` 写 alpha、`0x10` alpha 取 MAX；混合描述的 `RenderTargetWriteMask` 缺省 7，有 `0x8` 或 `0x10` 时 0xF。**缺省状态**：画到场景目标时颜色写、alpha 不写（掩码 7）；进入合成路径（画合成 RT、effect fbo）时 `vfunc_0xd8(1,1)`（掩码 0xF），画完恢复 `(1,0)`。`enabled` = 绑定材质时设 `(1,1)`，`disabled` = `(1,0)`，画完恢复绑定前的值；`default` 不动。**最后一个 effect 的上屏 pass 绑定材质之后会被强制改成 `(1, 在 copybackground:false 的组里)`，`alphawriting` 对它无效。** | 静态确认 |
| 5 | `alphatocoverage` | 混合 3：`AlphaToCoverageEnable = TRUE`，`BlendEnable = FALSE`（ONE / ZERO / ADD，alpha 同），写掩码照第 4 节（场景上 7）；深度写**不**被强制关（translucent / additive 才强制关），照材质 `depthwrite`。绑定时另给材质加组合键 `ALPHATOCOVERAGE=1`，`genericimage4` 据此把 alpha 锐化成 `saturate((a-0.5)/max(fwidth(a),1e-4)+0.5)`（HLSL 不 discard）。混合状态的缓存键里没有采样数，**`msaa: none` 时 A2C 照样打开**，单采样下的覆盖由硬件决定。画进合成 RT 的基础 pass 混合被强制改成 0（A2C 关），但着色器变体仍带 `ALPHATOCOVERAGE`；最后上屏的 effect pass 借基础材质的混合 3。 | 静态确认；单采样 A2C 的结果未知 |

**对 Kabegame 的直接含义**（推断，供步骤 4、5 参考）：
- 被依赖 = 「强制 passthrough 合成 + 不可见也画」。实现上：编译期对全部对象的 `dependencies` 求并集，命中的图像 / 文本层标成「出 RT」：建资源（不看 `visible` 与祖先可见性）、照画基础 pass 与整条 effect 链进一张按图层独占的 RT、不做视锥剔除；可见时再用 passthrough 上屏，不可见时跳过上屏。
- 引用方的槽在加载时按名字绑到这张独占 RT，**不需要按 `dependencies` 改绘制顺序**；被引用者在后面时读到上一帧（我们的 RT 跨帧保留即可对齐）。
- 被依赖图层可见时，上屏方式和普通带 effect 图层不同（全部 pass 留在 RT + passthrough 上屏），影响它自己的画面，要单独核对。
- 引用了不存在的 id、形状、模型，或写成 `_b`：WPE 绑的是 6×6 黄黑棋盘格，不是透明。
- 写掩码规则：场景上 7（现状一致）；合成 RT 与 fbo 上 0xF（现状一致）；`enabled` 只在直接上屏的图层材质上把场景掩码改成 0xF；`disabled` 在合成 RT / fbo 上改成 7；最后上屏的 effect pass 忽略 `alphawriting`。语料里 `cursorripple` 的 `enabled` 都在画进 fbo 的 pass 上，WPE 里本来就写 RGBA，是空操作。
- `alphatocoverage`：不混合直接覆盖 + 着色器把 alpha 锐化成近似 0/1 的阶跃，单采样下按 0.5 阈值近似（要实测）。

---

## 1. 图层依赖 `dependencies`

### 结论

1. **读取点**（静态确认）：对象基类构造 `FUN_1401ddbb0`（所有场景对象共用，rea-p5：`+0x120` 初值 `0x2001` 也在这里置）。
   - `0x1401ddd8e`–`0x1401dddb2`：在对象 JSON 里找键 `"dependencies"`（`FUN_140087490`）。
   - `0x1401dde17`–`0x1401dde29`：值的类型是数组（jsoncpp 6）或对象（7）才遍历，其它类型等于没写。
   - `0x1401dde99`–`0x1401ddeae`：每个元素先 `FUN_140088800`（能否转成整数），不能就跳过；能就 `FUN_140086000` 取成 64 位无符号整数。
   - `0x1401ddeb3`–`0x1401de0b2`：用 FNV-1a 64（`0xcbf29ce484222325` / `0x100000001b3`）散列插入对象 `+0x1f8` 处的 `unordered_set`：`+0x1f8` 最大负载因子、`+0x200` 链表哨兵、`+0x208` 元素数、`+0x210` 桶、`+0x228` 掩码、`+0x230` 桶数。重复 id 只存一次。
   - 粒子对象另有一套同名键（`FUN_14022af30`，元素是 `{id, type: "emitterimage" | "collisionmodel", index, mask}` 的对象），那是粒子自己的发射图 / 碰撞模型依赖；这种对象元素在基类构造里过不了整数检查，不进上面的集合。
2. **唯一的消费点**（静态确认，有界）：场景构造 `FUN_140186c90` 在 `objects` 全部加载完之后（`0x140187f00`–`0x140187f72` 逐个 `FUN_14018ff60`，每个对象当场跑完 `vfunc+0x40` 的 JSON 加载，即 effect 与材质都已建好），有一段依赖处理：
   - `0x140187f93`–`0x140188084`：遍历场景对象表 `scene+0x158`，先按 `+0x188` 认父对象（`FUN_1401de750`），再把每个对象 `+0x200` 链表里的 id 全部插进一个临时集合（`FUN_140078250`）。即**全部对象的 `dependencies` 取并集**，不区分是谁列的（模型对象列的也算）。
   - `0x14018808a`–`0x1401881de`：集合非空时再遍历一遍场景对象，按对象 id（`vfunc+0x8`）查集合；命中后看类型 `vfunc+0x60`：
     ```asm
     1401881a3: call qword ptr [rax + 0x60]   ; 类型
     1401881a6: cmp eax, 0x1 ; je            ; 图像层
     1401881ab: cmp eax, 0x4 ; jne skip       ; 文本层
     1401881b0: mov edx, dword ptr [rbx + 0x304]
     1401881b8: or  eax, 0x1010               ; 置 0x10 与 0x1000
     1401881c0: mov dword ptr [rbx + 0x304], eax
     1401881c6: test dl, 0x1 ; jne skip       ; 原先就有 0x10 的不重建
     1401881d1: call qword ptr [rax + 0x110]  ; 重建 effect 资源
     ```
   - 图像层的 `+0x110` 是 `FUN_1402065e0`：调 `+0xb0`（几何）、`+0xb8` = `FUN_1401ea500`（合成 RT 与 fbo）、`+0xc0` = `FUN_140206ae0`（基类 `FUN_1401ebbc0`：有 `0x10` 时建 passthrough 材质，`BLENDMODE` = cbm ∉ {0, 31} ? cbm : 0，`FOG_COMPUTED` = 1）。
   - 有界核对：对象 `+0x228`（集合掩码）只在 `FUN_1401ddbb0` 里被读写；读对象 `+0x200` 链表的只有 `0x14018803a`；字符串 `dependencies` 只被 `FUN_1401ddbb0` 与 `FUN_14022af30` 引用；`.text` 里对 `+0x304` 的 `0x1000` 位只有三处 `test …, 0x1100`（下一条）。所以 `dependencies` **不参与排序、不改加载顺序**。
3. **两个位的作用**（静态确认）：
   - `0x10`：p2 B8 的「合成上屏」位。`FUN_1401ea500` 据此把第 0 张合成 RT 建成独占的 `_rt_imageLayerComposite_<id>_a`（第 2 节），渲染时全部 effect pass 留在合成 RT、最后用 passthrough 材质上屏（B8）。
   - `0x1000`（和 `0x100` 并列，J1 推断 `0x100` 是 `ledsource`）：
     - 「该不该画」虚函数 `+0x68` = `FUN_1401ea2d0`：`(visible && 父链可见) || (+0x304 & 0x1100)`。场景渲染循环（`0x14018adc8` 等四处）与组合层画子层都先问它，所以被依赖图层不可见也会进渲染函数。
     - `FUN_1401e8aa0` 开头 `0x1401e8b75`：`ctx+0x11c & 2`（视锥剔除）时，带 `0x1100` 的图层跳过剔除。
     - 文本层 `0x140257805`、形状 `0x14025fb5b` 有同样的 `test 0x1100`。
4. **作用小结**：建 RT（强制 `0x10`）、保活（不可见也画、不剔除）。**不影响绘制顺序，也不影响加载顺序**。

### 对 P8 / 其它节

- 模型对象列的 `dependencies`（3509243656 的两个）同样会给它们指向的图像层置 `0x1010`。P8 不做模型依赖，但被指向的图像层这一侧（不可见也画进 RT、改走 passthrough 上屏）属于图像层，步骤 4 要一并处理，否则那两张场景里被指向的图层画法会和 WPE 不同。
- 形状（类型 0xa）、模型、粒子被列进 `dependencies` 时什么都不发生。

---

## 2. `_rt_imageLayerComposite_<id>_a`

### 2.1 名字怎么解析到另一个图层（静态确认）

- **不按 id 查对象表，按纹理名字查纹理表**：材质创建 `FUN_1401515b0` 对每个着色器槽取纹理名（材质 / 实例 `textures` 给的，没给就用注解 `default`，再没有就 `"error"`），`0x140151b61`–`0x140151b87` 调 `FUN_14014cf90(ctx+0x1520, 名字, 1)` 拿纹理对象，存进 `material+0xd0+8*slot`。只在材质创建（加载、effect 重载）时做，**不是每帧查**。
- `FUN_14014cf90`（摘录 `texget_14014d0a0.asm`）：
  - 表里有同名对象就直接返回；
  - 没有时先查一张全局别名表（`FUN_140002050` 初始化，只有 `_alias_lightCookie` 一项）；不是别名就 `dev->vfunc_0x60(名字)` = `FUN_14009aa20`：新建纹理对象（0x170 字节，虚表 `0x140487088`）并 `FUN_1400ec220(对象, 名字)` 当文件纹理同步加载，然后按名字登记进表。
  - 所以引用方加载时如果被依赖图层的 RT 还没建（按第 1 节，经 `dependencies` 才置 `0x10` 的图层一定还没建），表里先有一个同名的「文件纹理」占位，文件当然找不到，内容是 2.6 的棋盘格。
- **RT 建立时接管同名对象**：RT 构造 `FUN_1400d2c60` 末尾（`rtctor_tail_1400d30e4.asm`）：
  - `FUN_1400eb440` 新建 RT 自己的纹理对象（`RT+0x20`），名字非空时 `FUN_14014c8f0(ctx+0x1520, &RT+0x20)` 登记；
  - `FUN_14014c8f0`（`texreg_14014c9a0.asm`）发现同名已存在：`已有对象->vfunc_0x50(新对象)` 交换，删掉新对象，`RT+0x20` 改指已有对象（`0x14014cc1c`–`0x14014cc45`）；
  - 纹理 `vfunc_0x50` = `FUN_1400eeea0`：交换 `+0x140`–`+0x160`（D3D 资源、视图、格式）与 `+0xd0`，再尾跳 `FUN_14015f8d0` 交换纹理头 `+0x18`–`+0x38`（格式、标志、纹理尺寸、图像尺寸，经 `FUN_14014e410` 双向拷贝）；
  - 回到 RT 构造再把尺寸写进（已有）对象的 `+0x20/+0x24/+0x2c/+0x30`（`0x1400d319d`–`0x1400d31ca`）。
  - 结果：引用方材质里那个指针不变，内容变成 RT，`g_Texture<n>Resolution` = (W, H, W, H)，采样器标志 = RT 的标志。
- **RT 销毁时换回占位**：RT 析构 `FUN_1400d3220`（`rtdtor_1400d3290.asm`）调 `FUN_14014cc70(ctx+0x1520, &RT+0x20, 1)`：在表里找到这个对象后，新建 `"error"` 纹理并对表里的具名对象调 `vfunc_0x50` 交换（`0x14014ce35`–`0x14014ce80`），再删掉换出来的那份。具名对象一直留在表里。（静态确认调用；「换回的就是 error 内容」是推断，没有逐行读完。）
- 名字里的 id：`FUN_140153110(layer+0x8)`，64 位无符号十进制（两位一查的表 `0x140474390`），前缀 `_rt_imageLayerComposite_`、接 `_`、接 `a`（`ea500_name_1401ea720.asm`）。所以引用方必须写成完全相同的十进制 id。

### 2.2 何时建、尺寸、格式、采样器，`_b` 存不存在（静态确认）

- **建立条件**（`0x1401ea733`–`0x1401ea746`）：第 i 张合成 RT，`(L+0x304 & 0x10) != 0 && i == 0` 时走独占分支：`dev->vfunc_0x70` = `FUN_14009ada0` → `FUN_1400d2c60(w, h, 1, 名字, 格式, 0x1b, 纹理标志, …)`，不进 RT 池；否则走 `FUN_1401ab570` 池化 `sc.<W>.<H>.<n|b><c|r><k>`（p2 B5）。
- **时机**：
  - 经 `dependencies` 置位的：场景构造依赖段的 `vfunc+0x110` 里（加载末尾，所有对象、所有材质都建好之后）。
  - 本来就有 `0x10`（cbm ∉ {0, 31}、`0x100`、渲染标志 `0x1800000`）的：它自己加载末尾的 `+0x110`。
  - 之后每次 `FUN_1401ea500` 重跑（effect 可见性真的变化、重载、尺寸变化，见 rea-p7d 第 3 节）：开头无条件释放两张合成 RT（引用计数减到 0 就析构），再按新张数重建。独占 RT 不在池里，**每次都销毁再建，新 RT 没有初始数据、不清屏**（p3 J6）。
- **张数**：`min(2, (0x10 ? 1 : 0) + L+0x320)`；被依赖图层没有 effect 时是 1，只有 `_a`；有 effect 时第 1 张是池化 RT。
- **尺寸**：`vfunc+0x128` = `FUN_1402091e0`（p2 B5、rea-p5 2.3）：基础材质槽 0 纹理的图像尺寸（精灵表取单帧），非 fullscreen 的组合层 / solidlayer 取 `round(size)`，再除纹理降级系数（fullscreen 不除），最后 `max(4, ·)`。
- **格式**：`local_f0 = (ctx+0x118 & 0x2000) ? 0xe : 0`，即 HDR 场景 RGBA16F，否则 RGBA8。
- **纹理标志 / 采样器**：`local_b8 = 点采样 | 夹取 << 1`，点采样 = `L+0x304` bit14（`nointerpolation`）或尺寸函数的输出，夹取 = bit15（`clampuvs`，基类缺省 1）。这是 RT 纹理对象的标志，经 2.1 的交换成为引用方那个槽的标志。引用方采样它的寻址 / 过滤与被依赖图层自己采样合成 RT 的规则相同（来源细节归 `rea-p8-layer.md`）。
- **`_b` 不存在**：拼名字只在上面这个分支，后缀字符串 `a` 只有这一处引用；没有任何代码拼出 `_b`。p2 的结论成立。

### 2.3 RT 里装的是什么（静态确认，奇偶部分为推断）

- `FUN_1401e8aa0` 的合成路径（`f_1401e8aa0.c` 第 395 行起）：
  - 起始 RT 下标：`uVar55 = L+0x320`（`0x10` 时）或 `L+0x320 − 1`（否则），取奇偶；基础 pass 画进 `RT[uVar55]`（第 549 行）。
  - effect 循环（第 785 行起）：`local_124 = (+0x304 >> 4) & 1`；为 0 时，计数到 `count − 1` 就把最后一个 effect 转成 final 上屏；**为 1 时永远不进 final**，所有 pass 都画进合成 RT 与 fbo。
  - 每次合成写入都在两张 RT 间切换。`0x10` 下总写入次数 = 1 + Σ(1 + compose 数) = 1 + count，起点是 `count & 1`，所以最后一次写入落在下标 0，也就是 `_a`（推断，由奇偶算出；与「只给第 0 张起独占名」的设计一致）。
  - 循环结束后（`LAB_1401e9cc9`）若图层真可见：`g_Color4 = (1,1,1,1)`，passthrough 材质 `+0x2c0` 的槽 0 = `RT[当前]`，混合 = cbm 31 ? 2 : 基础材质混合（`vfunc+0x120`），`vfunc+0xf8` = `FUN_140208c80` 画世界四边形 `+0x2e8`。
- 所以 `_a` = **走完整条（启用的）effect 链之后的结果**；没有 effect 时 = 基础 pass 的结果。
- **基础 pass 的内容**（rea-p5 2.4、p2 B7 / B10）：
  - 普通图像层：模型矩阵换成对着 RT 像素的正交，不乘 `W`，即图层局部像素空间；混合关（`FUN_140207b50` 绑定基础材质后 `dev->vfunc_0x128(0)`）、写 RGBA；`g_Color4 = (color·k, alpha)`（k = HDR 时的 brightness，否则 1），`genericimage2.frag` 第 72 行 `color *= g_Color4`，所以 RT 里是乘过图层 alpha / color 的直通 alpha 图像。
  - 组合层（`composelayer`，`copybackground` 缺省 true）：层首按 B8 规则拷 `_rt_FullFrameBuffer`（基础材质要帧缓冲 → 拷，这一步在可见性判断之前），基础 pass 用 composelayer 着色器把层背后那块快照透视正确地铺满 RT。`copybackground: false` 时清成 (0,0,0,0) 再画子层。
- **被依赖图层没有 effect**（语料里很多）：仍有一张 `_a`，装基础 pass。没有 effect、没有子层的组合层平时整层不画（rea-p5 2.7），被依赖后会画（快照 + composelayer 进 `_a`）。

### 2.4 写死 `visible:false`（静态确认）

- `FUN_1401e8aa0` 开头（`e8aa0_head_1401e8aa0.asm`）：`dl = vfunc+0x68()`（第 1 节，带 `0x1000` 恒真），`r14b = 真可见 = (+0x120 & 1) && 父链可见`。两者都假才返回。被依赖图层不会在这里返回。
- 层首快照、基础 pass、effect 链都不看真可见（第 165–170 行的快照条件也不看）。
- 只有 `LAB_1401e9cc9` 之后的上屏块是 `if (bVar39)`（第 903 行）。不可见时整块跳过，只做收尾：`vfunc_0xd8(1,0)`、弹栈（第 1128–1141 行）。
- 结论：**照画进 RT，不上屏**。绑用户属性的 `visible` 一样，运行时改的只是 `+0x120` bit0，影响上屏与否，不影响画进 RT。
- **可见的被依赖图层**改走 passthrough 上屏：最后一个 effect 的最后一个绘制 pass 画进 RT 而不是场景，另有一次 passthrough draw（`effectpassthrough.json` / 能力等级 > 2 时 `effectpassthrough_4.json`，`BLENDMODE` 0、`FOG_COMPUTED` 1、`g_Color4 = 1`）用基础材质混合把 `_a` 画到图层世界四边形 `+0x2e8`（不内缩）。cbm 仍为 0 时不触发层首快照（B8 条件看 cbm 和基础材质，不看 `0x10`）。

### 2.5 被引用者排在引用方之后（不排序：静态确认；读上一帧：推断）

- 渲染循环按对象列表顺序画（正交场景；透视场景按 rea-p5 1.4 的透明表规则），没有任何代码因为 `0x1000` / `dependencies` 提前画被依赖图层（第 1 节的有界搜索）。引用方采样纹理只是绑定 SRV，不会触发被引用图层渲染。
- `_a` 独占、只在 `FUN_1401ea500` 里销毁，帧之间不清。所以被引用者在后面时，引用方那次绘制读到的是**上一帧**被引用者最后写进 `_a` 的结果；在前面时读到本帧的结果。
- 第一帧（以及每次被引用者 `FUN_1401ea500` 重建后、它再次画之前）读到的是新建 RT 的初值。D3D11 不给初始数据时内容未定义，实际多为 0（推断）。
- 语料里排在后面的 6 处：2251857160 的 `foggy_glass#1389`（→ 1442、1512、1680、1755）、`screen_frost#88`（→ 356），3554161528 的 `1111`（→ 411）。

### 2.6 id 不存在、不是图像 / 文本层、写成 `_b`（棋盘格：静态确认；走到这条路：推断）

- 没有对象会以这个名字建 RT，表里一直是 2.1 的占位：`FUN_1400ec220` 经资源文件系统找不到文件 → `0x1400ec509` 退回分支（`texload_fallback_1400ec330.asm`）：
  - 纹理尺寸、图像尺寸都是 6（`edi = 6`），格式 0（RGBA8888），标志 `+0x1c = 9`（bit0 点采样 + bit3）；
  - `FUN_140170510(buf, 6)` 生成像素：第 i 个像素，行 = i / 6，若 `(行 & 1) != (i & 1)` 则 v = 255 否则 0，RGBA = (v, v, 0, 255)。即**不透明的黄黑棋盘格**，(0,0) 黑、(1,0) 黄；
  - 名字是 `error` 时同样走这里（`0x1400ec384`），`_rt_shadowAtlas` 另设格式 0x10、标志 `0x8000008`。
- 这些情况都会走到这里：引用的 id 不存在；id 是形状、模型、粒子等（不置 `0x10`）；是图像层但谁都没在 `dependencies` 里列、它自己也没有 `0x10`；后缀写成 `_b`。
- 推断依据：占位走 `dev->vfunc_0x60` 的文件纹理路径，而场景工程里不会有叫 `_rt_imageLayerComposite_…` 的纹理文件。没有核对资源文件系统对 `_rt_` 前缀有没有别的特殊处理（`FUN_140279790` 没读）。

---

## 3. 自引用：实例 `textures` 写在 `bind` 占了的槽上（静态确认）

- 实例 `textures` 在材质创建时按名字解析一次，写进 `material+0xd0+8*slot`（2.1）。
- 执行 pass 时 `FUN_1401ebf60`（`f_1401ebf60.c` 第 125–170 行），在绑定材质（第 327 行 `FUN_140155fc0`）**之前**：
  - pass 没有 `bind`：`param_4 ≥ 0` 时把槽 0 改成当前合成 RT `RT[param_4]+0x20`（p2 B6）；
  - pass 有 `bind`：逐项 `{fbo 下标, 槽}`，下标 < 0（`previous`）取 `RT[param_4]`，否则取 fbo 条目的 RT；RT 的纹理指针 `+0x20` 非空就**写进 `material+0xd0+8*槽`**，覆盖实例纹理。
- 所以 **`bind` 胜出**，而且是持久覆盖（材质对象上的值被改掉）。语料的 `blur` 第 3 个 pass 槽 2 绑到 `previous`，实例写的 `_rt_imageLayerComposite_148_a` 只在加载时建了个占位（148 不在任何 `dependencies` 里，没有 `0x10`，这个名字的 RT 不存在），画的时候用不上。
- 例外：`param_4 < 0`（当前没有合成 RT，例如形状对象 `FUN_1401ebf60(…, -1, 1)` 那条路）时，`fbo < 0` 的 bind 被跳过（第 143–153 行只处理 `fbo ≥ 0`），槽里保留实例纹理。语料的自引用都在有合成 RT 的图层上，不受影响。

---

## 4. `alphawriting` 与写掩码

### 4.1 设备状态与混合描述（静态确认）

- 设备对象 `dev`（虚表 `0x140485b90`，构造 `FUN_140098ea0` 把 `+0x24`、`+0x26`、`+0x28` 都清 0）。状态位（`devstate_14009af50.asm`）：
  - `vfunc_0xd8(c, a)` = `FUN_14009aff0`：`+0x28` 的 `0x200` = c（写颜色），`0x8` = a（写 alpha）；`vfunc_0xe0` 读 `0x8`。
  - `vfunc_0xe8(x)`：`0x10` = x（alpha 取 MAX，组合层 `copybackground: false` 画子层时用）。
  - `vfunc_0xf0`：`0x80`；`0xf8`：`0x20`；`0x100`：`0x40`；`0x108`：`0x100`（其它混合变体，本报告不涉及）。
  - `vfunc_0x128(m)`：`+0x26` = 混合模式。
  - `vfunc_0xc8(x)`：`+0x24` bit1 = !x（关深度测试）；`vfunc_0xd0(x)`：`+0x24` bit0 = !x（关深度写）；`vfunc_0xa8` / `0xb0`：`+0x25` 光栅化状态位。
- 混合状态构建 `FUN_140099f60`（`blendstate_140099f60.asm`）：
  - 缓存键 = `+0x28` 状态字 | (颜色写 ? `+0x26` 模式 : 4)，低 3 位是模式。
  - `D3D11_BLEND_DESC` 清零后：`RenderTargetWriteMask` 缺省 **7**；
  - 模式 0 normal：`BlendEnable` 0，ONE / ZERO / ADD，alpha 同；
  - 模式 1 translucent：开混合，SRC_ALPHA / INV_SRC_ALPHA，alpha 同；
  - 模式 2 additive：开混合，SRC_ALPHA / ONE，alpha 同；
  - 模式 3 alphatocoverage：`AlphaToCoverageEnable = 1`，其余同模式 0；
  - 模式 4（颜色写关）：掩码 8；
  - `0x8` 或 `0x10` → 掩码 **0xF**；`0x10` 另把 alpha 改成 ONE / ONE / MAX；`0x80` / `0x20` / `0x40` / `0x100` 改颜色通道（预乘、MAX、MIN、DEST_COLOR）。
  - `OMSetBlendState(state, NULL, 0xffffffff)`（上下文槽 `+0x118`）。
  - 深度模板状态下标 = `+0x24` | (模式 ∈ {1, 2} ? 1 : 0)，即 translucent / additive **强制关深度写**，normal 与 alphatocoverage 不强制（上下文槽 `+0x120` = `OMSetDepthStencilState`）。
- 键里没有渲染目标的采样数或格式。

### 4.2 缺省状态从哪来（静态确认）

- 重置：`FUN_14011fd20`（虚表 `0x140489d68` 槽 `+0xa8`，释放 / 重建渲染目标的函数）末尾 `0x14011ffcc`–`0x14011fff3`：`vfunc_0xb0(0)`、`vfunc_0xc8(1)`、**`vfunc_0xd8(1, 0)`**。
- 每个图像 / 文本层渲染 `FUN_1401e8aa0`：
  - 进合成路径时 `0x1401e9312`–`0x1401e93cb`：**`vfunc_0xd8(1, 1)`**（无 effect 有子层那条是 `0x1401e900b`）；
  - passthrough 上屏前 `0x1401e9ff3`：`vfunc_0xd8(1, 0)`；
  - 收尾 `0x1401ea1dd`：**`vfunc_0xd8(1, 0)`**。
- 所以稳态是「写颜色、不写 alpha」，只在合成路径内部写 alpha。其它改它的地方：降采样工具 `FUN_1401d3c92`（`materials/util/downsample_quarter.json`，画时 (1,1)、画完 (1,0)），组合层画完子层后恢复 (1,1)（`0x1402085f1`、`0x1401ecf31`）。

### 4.3 `alphawriting` 的作用（静态确认）

- 映射（`alphawriting_map_140157d60.asm`）：`"default"` → 0，`"enabled"` → 1，`"disabled"` → 2，存 `pass+0x1f1`（`0x140157998` 登记偏移）。
- 绑定 `FUN_140155fc0`（`bindmat_state_140157150.asm`）：
  ```asm
  140157201: movzx ecx, byte ptr [r12 + 0x1f1] ; 0 → 跳过
  140157226: call qword ptr [rax + 0xe0]         ; 读当前 alpha 写位
  14015723e: cmove …  → pass+0x1f8 bit4 = 旧值
  140157249: mov dl, 0x1                           ; 写颜色
  14015725c: sete r8b                              ; 写 alpha = (alphawriting == 1)
  14015726a: call qword ptr [rax + 0xd8]
  ```
- 解绑 `FUN_140157430`（`unbindmat_140157480.asm` `0x14015753d`–`0x140157568`）：`alphawriting != 0` 时 `vfunc_0xd8(1, 保存的旧值)`。
- **最后一个 effect 的上屏 pass 被覆盖**：`FUN_1401ebf60` 在 `0x1401ec5f3` 绑定材质之后，`0x1401ec5f8` 判断是上屏 pass，`0x1401ec61f` 调 `vfunc_0xd8(1, ctx+0x1c9 > 0)`。`ctx+0x1c9` 是「正在 `copybackground: false` 的组里画子层」的计数。所以这个 pass 上的 `alphawriting` 不起作用。

### 4.4 三种目标上的实际写掩码（静态确认）

| 绘制 | `default`（0） | `enabled`（1） | `disabled`（2） |
|---|---|---|---|
| 场景目标，直接上屏的图层（无 effect，`FUN_140208670` 绑定基础材质） | **7** | 0xF | 7 |
| 场景目标，最后一个 effect 的上屏 pass | 7 | 7（被覆盖） | 7（被覆盖） |
| 场景目标，passthrough 上屏（`0x10`，passthrough 材质） | 7 | —（材质自带，语料无） | — |
| 合成 RT：基础 pass（`FUN_140207b50`，混合强制关） | **0xF** | 0xF | 7 |
| 合成 RT / effect fbo：其余 effect pass | **0xF** | 0xF | 7 |
| 在 `copybackground: false` 组里画子层（`0x10` MAX 打开） | 0xF（alpha MAX） | 0xF | 0xF（`0x10` 强制） |

- 「场景目标」指当前绑定的场景渲染目标，后备缓冲、HDR / 泛光时的场景 RT、MSAA RT 都一样（混合状态不区分）。
- `disabled` 写 7 时 alpha 保留目标原值：fbo 是上一帧或 `clear` 的值，合成 RT 是上次写入的值（RT 不清）。
- `cursorripple` 的 `cursorripple_apply_force` / `cursorripple_simulate_force` 画进 `_rt_EightBuffer1/2`，合成路径里本来就是 0xF，`enabled` 是**空操作**。
- 和 J3 的抓帧一致：「基础 pass 不混合写四通道，上屏借基础材质 blend 且 write_mask = 7」。

---

## 5. `alphatocoverage`（混合 3）

1. **映射**（静态确认）：`"alphatocoverage"` → 3（`0x140157e4a`；另一个解析器 `FUN_1401531c0` 同）。
2. **混合描述**（静态确认，`0x14009a0f2`）：`AlphaToCoverageEnable = TRUE`、`IndependentBlendEnable = FALSE`；RT0 `BlendEnable = FALSE`，SrcBlend ONE、DestBlend ZERO、BlendOp ADD，SrcBlendAlpha ONE、DestBlendAlpha ZERO、BlendOpAlpha ADD；`RenderTargetWriteMask` 按第 4 节（场景上 7）；`SampleMask 0xffffffff`，混合因子 NULL。
3. **深度**（静态确认）：不进「强制关深度写」那一档，照材质 `depthtest` / `depthwrite`（`"disabled"` → 1，绑定时 `vfunc_0xc8(0)` / `vfunc_0xd0(0)`）。语料两张的材质都是 test、write 关。
4. **着色器宏**（静态确认）：
   - 绑定 `FUN_140155fc0` 在 `0x1401564a4`–`0x140156508`，以及 `FUN_140154480` 在 `0x140154bc1`：`pass+0x1f0 == 3` 就给组合键加 `ALPHATOCOVERAGE = 1`；变体材质也继承混合 3（`0x140156543`–`0x140156556`）。
   - 图层另一处（`FUN_14020ab12`，`0x14020ad1d`）给基础材质派生出的材质（推断是阴影 / 反照率用的变体）加同样的键。
   - `genericimage4.frag` 第 223 行（`genericimage3.frag` 第 291 行、`base/model_fragment_v1.h` 的 `ApplyAlphaToCoverage` 相同）：
     ```glsl
     #if ALPHATOCOVERAGE
     	gl_FragColor.a = saturate((gl_FragColor.a - 0.5) / max(fwidth(gl_FragColor.a), 0.0001) + 0.5);
     #if GLSL
     	if (gl_FragColor.a < 0.5) discard;
     #endif
     #endif
     ```
     D3D11 下 `GLSL` 为 0，不 discard，只把 alpha 锐化成以 0.5 为中心、过渡约一个像素的阶跃。
5. **和 MSAA 的关系**（静态确认 + 未知）：
   - 混合状态缓存键不含采样数；`.text` 里所有比较 `+0x1f0 == 3` 的地方（`0x140154bc1`、`0x1401564a4`、`0x140156543`、`0x14020ad1d`）都只加组合键，没有按 MSAA 设置改混合模式的分支（有界）。所以 `msaa: none` 时 **A2C 照样打开**，渲染目标是单采样。
   - 单采样下 A2C 的覆盖是 1 位，具体按阈值还是抖动由驱动决定，**未知**（风险 2）。着色器已经把 alpha 锐化成近似 0/1，阈值实现时基本等于「alpha ≥ 0.5 覆盖」。
   - `msaa: x2` 时场景目标是多重采样 RT，覆盖按 alpha 分到 0 / 1 / 2 个样本，解析后边缘约 50%。
6. **画进合成 RT 时**（静态确认）：
   - 图层有 effect 时，基础 pass 画进合成 RT 前 `FUN_140207b50` 在绑定后调 `vfunc_0x128(0)`，A2C 关、不混合、写 RGBA；但着色器变体已经按 `+0x1f0 == 3` 选了带 `ALPHATOCOVERAGE` 的那份，所以 RT 里是锐化后的 alpha。
   - 最后一个 effect 的上屏 pass 经 `vfunc+0x108`（`FUN_140209160`）把基础材质的混合 3 拷过去，上屏时 A2C 打开（effect 着色器一般不声明这个组合键）。
   - 直接上屏（无 effect）就是第 2 条的状态。

---

## 6. 实测要核对的预测

> 确定性工程按 `p8-dep` / `p8-alpha` / `p8-a2c` 的设计；下面的「资源」指 RenderDoc 里的 ResourceId，「事件」指 action 序号。默认场景 LDR、无泛光，后备缓冲 RGBA8。

### 6.1 图层依赖（`p8-dep`）

1. **隐藏 + 无 effect 的普通图层 A，被 B 引用**：一帧里 A 恰有一次 draw，目标是一张宽高等于 A 基础纹理图像尺寸（不是 `size`、不是 2 的幂补齐尺寸）的 RGBA8 纹理 `T_A`，混合关、写掩码 0xF；A 没有任何画到后备缓冲的 draw。B 读 `_rt_imageLayerComposite_<A>_a` 的那次 draw，对应槽绑定的 SRV 资源就是 `T_A`，采样器线性 + 夹取（A 写 `nointerpolation: true` 时点采样，写 `clampuvs: false` 时重复）。
2. **A 不在任何对象的 `dependencies` 里**（其它不变）：B 那个槽绑的是 6×6 RGBA8 纹理，像素 (0,0) = (0,0,0,255)、(1,0) = (255,255,0,255) 交替，点采样；A 一个 draw 都没有。
3. **A 有两个 effect**：A 有基础 pass + 每个 effect pass 的 draw，全部画进合成 RT 与 fbo；最后一次写入的目标是 `T_A`（下标 0 那张，独占），另一张是池化 RT（与同尺寸的别的图层共用同一个资源）。B 读到的是 `T_A`，内容是两个 effect 都做完的结果。
4. **A 可见 + 有 effect + 被依赖**：A 的最后一个 effect pass 画进 `T_A` 而不是后备缓冲；之后多一次 draw，像素着色器是 genericimage3 / 4（带 `g_Color4`，`g_Color4` = (1,1,1,1)），采样 `T_A`，画到后备缓冲，混合 = A 基础材质的混合，写掩码 7。去掉 `dependencies` 对照：最后一个 effect pass 直接画到后备缓冲，没有这次 passthrough draw。
5. **A 在 B 之前 / 之后**：之前时 A 写 `T_A` 的事件在 B 读的事件之前；之后时 B 读的事件在前。A 由脚本每帧改颜色（帧号编码）时，「之后」的情况下 B 采到的值等于 A 上一帧的颜色，「之前」等于本帧。
6. **A 是 `composelayer`（缺省 `copybackground`），隐藏，无 effect**：A 的位置上有一次 `ResolveSubresource` / `CopyResource` 到 `_rt_FullFrameBuffer`，接着一次 composelayer 着色器的 draw 画进 `T_A`（尺寸 = `round(size)`）；没有画到后备缓冲的 draw。去掉 `dependencies`：A 一个 draw 都没有、也不拷快照。
7. **A 放在视口外（`origin` 远离画面）且隐藏**：A 仍然有画进 `T_A` 的 draw（不做视锥剔除）。
8. **B 引用 `_rt_imageLayerComposite_<A>_b`**：同第 2 条，6×6 棋盘格。
9. **B 引用一个形状或模型的 id**（并列在 `dependencies` 里）：同第 2 条。
10. **A 是文本层**：同第 1 条（文本层也置位）。（文本对象要等 P6b，可只记录。）
11. **A 隐藏、有 effect，A 的 effect `visible` 由脚本在某帧切换**：切换那一帧之后，`T_A` 的资源 ID 会变（销毁重建），B 那个槽绑定的 SRV 跟着变成新资源（同一个纹理对象换了资源）。

### 6.2 自引用

12. `blur` 第 3 个 pass 的槽 2（实例写 `_rt_imageLayerComposite_<自己>_a` 或 `_b`）绑定的 SRV 是本图层当前合成 RT（第 2 个 pass 的输出那张），不是 6×6 棋盘格。

### 6.3 `alphawriting`（`p8-alpha`）

13. **直接上屏的图层（无 effect）**，基础材质 `alphawriting` 缺省 / `enabled` / `disabled`：OM 混合状态 `RenderTargetWriteMask` 分别为 0x7 / 0xF / 0x7。后备缓冲的 alpha：缺省时保持清屏值，`enabled` 时等于该图层输出的 alpha。
14. **两个 pass 的 effect，第 1 个 pass 画进 fbo**，第 1 个 pass 的 `alphawriting` 缺省 / `enabled` / `disabled`：那次 draw 的写掩码 0xF / 0xF / 0x7；`disabled` 时 fbo 的 alpha 保持上一帧 / `clear` 的值。
15. **同一个 effect 的最后一个 pass（上屏）写 `alphawriting: enabled`**：上屏那次 draw 的写掩码仍是 0x7。
16. **图层有 effect，基础材质 `alphawriting: disabled`**：基础 pass 画进合成 RT 的那次 draw 写掩码 0x7、`BlendEnable` FALSE；缺省时 0xF。
17. `cursorripple` 的两个力场 pass：写掩码 0xF；把 `enabled` 改成缺省，写掩码不变。

### 6.4 `alphatocoverage`（`p8-a2c`）

18. **alpha 0→1 渐变图层，`blending: alphatocoverage`，无 effect，`msaa: none`**：那次 draw 的 OM 混合状态 `AlphaToCoverageEnable` TRUE、`IndependentBlendEnable` FALSE；RT0 `BlendEnable` FALSE，Src ONE、Dest ZERO、Op ADD，SrcAlpha ONE、DestAlpha ZERO、OpAlpha ADD，写掩码 0x7；后备缓冲 `msaa_samples` = 1。像素着色器反汇编里有 `deriv_rtx` / `deriv_rty`（`fwidth`）与 `(a − 0.5) / max(…, 0.0001) + 0.5` 的饱和运算。
19. 同上，读像素：渐变 alpha < 0.5 的一侧保持背景，> 0.5 的一侧是图层颜色（不混合），过渡约 1 像素宽。抖动还是阈值，以实测为准。
20. `depthwrite` 写 `enabled` 的对照（深度目标存在时）：深度模板状态 `DepthWriteMask` = ALL；同一图层改成 `translucent` 时为 ZERO。
21. **`capture_sweep` 的 `msaa: x2`**：场景目标 2 采样，A2C 仍为 TRUE，解析后渐变边缘出现约 50% 的一列。
22. **A2C 图层带一个 effect**：基础 pass 画进合成 RT 的那次 draw 的 `AlphaToCoverageEnable` FALSE、`BlendEnable` FALSE、写掩码 0xF，但像素着色器仍是带 `fwidth` 锐化的变体；上屏的 effect pass `AlphaToCoverageEnable` TRUE。

---

## 未查清

- 单采样渲染目标上 A2C 的覆盖规则（阈值或抖动），属驱动行为（预测 19）。
- 被依赖图层的 `_a` 重建（effect 可见性切换）那一帧，引用方读到什么：RT 析构时具名对象换回的是否就是 `error` 棋盘格，新 RT 的初值是否为 0（2.1、2.5）。
- 资源文件系统（`FUN_140279790`、`FUN_1400d4160`）对 `_rt_` 开头的名字有没有特殊处理；本报告按「当普通文件找不到」推断走棋盘格（2.6）。
- 棋盘格纹理标志 9 的 bit3 对采样器的含义（只确认了 bit0 是点采样）。
- 文本层（`+0x110` = `0x140258900`）被置位后建 RT 的细节没有逐行读，只确认它同样过 `test 0x1100`、虚表 `+0xb8` 也是 `FUN_1401ea500`。
- 透视场景透明表里，被依赖图层的排序有没有被别的标志影响（只确认 `0x1000` 不参与排序键）。

## 快照

开工时 REA 会话已由并行的 layer 代理打开在同一个副本上，本代理没有切换目标、没有任何元数据改动，结束时不 `close_binary`（会关掉对方的会话）。`ignore\p8\rea\render\wallpaper64-2.8.42-p8render.rea-snapshot` 是 `start.rea-snapshot` 的拷贝：分析状态与开工时相同，本轮的证据都在上面的汇编摘录与已有反编译文本里。

## 函数与地址索引

| 地址 | 作用 | 用途 |
|---|---|---|
| `FUN_1401ddbb0`（`0x1401ddd8e`–`0x1401de171`） | 对象基类构造：读 `dependencies` 进 `+0x1f8` 集合 | 1 |
| `FUN_140186c90`（`0x140187f87`–`0x1401881de`） | 场景构造：依赖并集、给图像 / 文本层置 `0x1010` 并调 `+0x110` | 1 |
| `FUN_14018ff60` | 单个对象加载（构造后立即 `vfunc+0x40`） | 1、2.1 |
| `FUN_1401ea2d0` | 图层 `vfunc+0x68`：`(可见 && 父链可见) \|\| (+0x304 & 0x1100)` | 1、2.4 |
| `FUN_1401e8aa0` | 图层渲染：剔除跳过（`0x1401e8b75`）、合成路径、`if (真可见)` 上屏、alpha 写开关 | 2.3、2.4、4.2 |
| `FUN_1401ea500`（`0x1401ea733`–`0x1401ea881`） | 合成 RT：`0x10 && i == 0` 时建独占 `_rt_imageLayerComposite_<id>_a` | 2.2 |
| `FUN_1402065e0` / `FUN_140206ae0` / `FUN_1401ebbc0` | 图层 `+0x110` / `+0xc0`：重建资源、建 passthrough 材质 | 1、2.4 |
| `FUN_1401515b0`（`0x140151b61`） | 材质创建：按名字取槽纹理 | 2.1 |
| `FUN_14014cf90` | 纹理表按名取，缺失时 `dev->vfunc_0x60` 新建文件纹理并登记 | 2.1、2.6 |
| `FUN_14014c8f0` | 纹理表登记；同名已存在时交换资源并改指已有对象 | 2.1 |
| `FUN_14014cc70` | 纹理表注销：具名对象换回 `error` | 2.1 |
| `FUN_1400d2c60` / `FUN_1400d3220` | RT 构造 / 析构 | 2.1、2.2 |
| `FUN_1400eeea0` / `FUN_14015f8d0` | 纹理 `vfunc+0x50`：交换 D3D 资源与纹理头 | 2.1 |
| `FUN_1400ec220`（`0x1400ec509` 起） | 文件纹理加载；找不到时 6×6 退回 | 2.6 |
| `FUN_140170510` | 生成黄黑棋盘格像素 | 2.6 |
| `FUN_1401ebf60`（第 125–170 行；`0x1401ec5ee`–`0x1401ec61f`） | pass 执行：`bind` 写槽、上屏 pass 强制 alpha 写 | 3、4.3 |
| `FUN_140155fc0`（`0x140157150`–`0x14015726a`；`0x1401564a4`） | 材质绑定：混合、深度、剔除、`alphawriting`、`ALPHATOCOVERAGE` 组合键 | 4.3、5 |
| `FUN_140157430`（`0x1401574b5`–`0x140157568`） | 材质解绑：恢复以上状态 | 4.3 |
| `FUN_1401577e0`（`0x140157d60`–`0x140158100`） | 材质 pass 属性登记与字符串映射（blending / alphawriting / depthtest / depthwrite / cullmode = `+0x1f0`–`+0x1f4`） | 4.3、5 |
| `FUN_140099f60` | 设备混合 / 深度状态构建（`D3D11_BLEND_DESC`、A2C、写掩码） | 4.1、5 |
| `FUN_14009aff0` 等（虚表 `0x140485b90` 槽 `0xa8`–`0x128`） | 设备状态位 setter | 4.1 |
| `FUN_14011fd20`（`0x14011ffcc`–`0x14011fff3`） | 重置：`vfunc_0xd8(1, 0)` | 4.2 |
| `FUN_140207b50`（第 275–277 行） | 基础 pass 进合成 RT：绑定后混合强制 0 | 4.4、5 |
| `FUN_140209160` | 上屏 pass 借基础材质混合 / 深度 | 5 |
| `FUN_14022af30` | 粒子对象自己的 `dependencies`（`emitterimage` / `collisionmodel`） | 1 |
