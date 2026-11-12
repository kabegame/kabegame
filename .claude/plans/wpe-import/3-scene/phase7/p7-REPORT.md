# P7 步骤 0 实测报告（2026-11-11）

> 上级：[P7 总计划](phase-7-effects-shaders.md)。读码见 [rea-p7-shader.md](rea-p7-shader.md)（WPE 的方言转 HLSL）与 [naga-p7-frontend.md](naga-p7-frontend.md)（naga GLSL 前端）。
> 本报告是对读码结论的实测核对：本机 fxc 编译与反汇编、WPE 抓帧。没有改产品代码。

## 结论

1. **语料里退回的着色器，WPE 都能编过。** 48 个里能在抓帧中按材质常量名认出来的 41 个，在 35 张代表场景的 WPE 抓帧里都是正常编译的绘制。这 35 张一共没有出现一次编译失败回退。阳性对照（故意编不过的工程）能被同一套扫描认出来。所以 P7 要做的是让我们的翻译器接受这些写法，不需要复刻回退。
2. **WPE 的编译语义** 与 HLSL（fxc，`OPTIMIZATION_LEVEL3 | ENABLE_STRICTNESS`）一致，下面「fxc 的隐式规则」逐条实测。加不加 `ENABLE_STRICTNESS`，反汇编逐字相同。
3. **片元里的 varying 用顶点那份声明。** 顶点写 `vec4 v_TexCoord`、片元声明 `vec2` 却读 `.zw`，WPE 编过，并输出顶点写进去的值。片元改写 varying 也合法。所以「两个阶段宽度不同」不需要在片元里截成窄的，而是片元按顶点的类型声明，再由 HLSL 隐式规则处理正文里的用法。
4. **`main` 之前看到的名字是原样的。** WPE 只替换 `main` 签名之后的名字：
   - `main` 之前的辅助函数读 varying 是未声明标识符，编不过，实测走回退；
   - `float` 数组 uniform 在 `main` 之前是打包的 `float4[n/4]`，`main` 里是拆开的 `float[n]`。工坊 `video` 在辅助函数里写 `g_AudioSpectrum64Left[i / 4][i % 4]`，用的正是打包形态，所以能编过。
5. **原来以为「源码损坏」的 `audio` 也能编过。** 那几个 `bc1…` 宏要么没被用到，要么只在这张场景的 COMBO 走不到的 `#if` 分支里。真正挡住我们的是同名宏定义了两次（naga 预处理报 `DefineRedefined`）；fxc 只给警告。
6. **编不过时的样子**：片元回退输出暗红 `(0.5, 0, 0, 1)`，顶点回退只变换位置。WPE 日志写 `<目标> shader <文件> error:` 加 fxc 原文，这一轮能从 `log.txt` 读到。
7. **WPE 编不过、我们能编过的写法在语料里基本没有。** 粗扫「`main` 之前的函数读 varying」「片元独有的 varying」两种，只命中 2 个，而且都是误报（WPE 照常编过）。

## fxc 的隐式规则

用 WPE 自带的 `d3dcompiler_47.dll`（`ignore/p7/fxc/`，`ignore/p7/fxc.py`）编译 `ps_5_0`，flags 取 0 与 WPE 的 `0x8800` 两遍，反汇编相同。

| 写法 | 结果 | 依据（反汇编 / 报错） |
|---|---|---|
| 宽向量赋给窄向量、传给窄形参、`return` | 取前几个分量，警告 X3206 | `float2 a = tc` → `v1.xy` |
| 不同宽度的向量混算 | 截到较窄的一边，逐分量算，警告 X3206 | `float3 m = u_a * u_b` → `cb0[0].x * cb0[1].x` 等 |
| 内置函数实参宽度不一（`lerp`、`mul`） | 全部截到最窄的一边，警告 X3206 | `lerp(float4, float3, float)` → 三维 |
| 标量赋给向量 | 铺满 | `float4 s = u_c` |
| `if (float)`、`if (int)` | `!= 0` | `ne r0.x, l(0), cb0[1].w`、`movc … cb0[5].w` |
| `if (float2)` | 错误 X3019 | — |
| `float` → `int` | 向零截断 | `round_z` |
| 浮点下标 | 向零截断成无符号（`ftou`），负数同样走 `ftou` | `ftou r0.x, -cb0[1].w` |
| `bool` 参与算术 | 0 / 1 | `bfi` |
| 对标量再取下标 | 错误 X3121 | — |
| cbuffer 里的 `float` 数组 | 每个元素占 16 字节（同 std140） | `cb0[r0.x + 2].x` |

## WPE 抓帧

工具：新增 `kbp rdc shaders`（按绘制列出顶点 / 像素着色器、`g_bufStatic` 的变量名、是否回退，反汇编按哈希存一份）。回退的认法：
- 片元只有一句 `mov o0.xyzw, l(0.500000, 0.000000, 0.000000, 1.000000)`；
- 顶点回退和纯色图层的顶点着色器指令完全相同，所以只在配对的像素着色器还读插值输入时才算回退。

**确定性工程 `p7-sem`**（`ignore/p7/gen_sem.py`，四个纯色图层各挂一个自写 effect，抓帧 `A:\p7\sem\p7-sem`）：

| effect | 写法 | 预测 | WPE |
|---|---|---|---|
| `kbfail` | 片元引用未声明的标识符 | 回退 | 回退；日志 `error X3004: undeclared identifier 'kb_undefined_identifier'` |
| `kbhelper` | `main` 之前的函数读 `v_TexCoord` | 回退（rea 2.9） | 回退；日志 `error X3004: undeclared identifier 'v_TexCoord'` |
| `kbwidth` | 顶点 `vec4 v_TexCoord = (uv, 0.25, 0.75)`，片元声明 `vec2`，改写 `.x`、读 `.zw` | 编过，输出 `(0.25, 0.75, 0.5)` | 编过；`dcl_input_ps linear v0.zw`，`mov o0.xy, v0.zwzz` |
| `kbtrunc` | `vec3 c = mix(vec4, vec3, 0.5)`；顶点多一个 `#endif`；同名宏定义两次 | 编过，输出 `(0.5, 0, 0.5)` | 编过；`mov o0.xyzw, l(0.5, 0, 0.5, 1)` |

**工坊场景**：每个失败着色器挑一张其余退回键最少的场景（`ignore/p7/pick.py` → `out/pick.json`），共 35 张，各抓 1 帧（`A:\p7\step0`、`A:\p7\sweep\s-<场景>`），`kbp rdc shaders` 扫完：**回退 0 次**。
- 按着色器源码里带 `"material"` 注解的 uniform 名去配抓帧的 `g_bufStatic`（`ignore/p7/match.py`）：48 个里 41 个配上了正常编译的绘制。
- 没配上的 7 个（`fluidsimulation_advection`、`pixelate`、`2798319181/gaussian`、`topographic`、`frame_builder_by_gariam`、`procedural_noise`，以及只配上 1 个常量名的几个）：这一帧里可能没画、effect 关着，或常量被编译器剔除。场景里同样没有回退，P7a 的确定性工程再逐个确认。
- `video`（`3815289650`，事件 320）：`g_AudioSpectrum64Left` 是 `float4[16]`，`dp4 r0.w, cb1[r1.w + 0].xyzw, icb[r0.w + 0].xyzw`。
- `audio`（`3706286085`，事件 2165）正常编译。

## 对 P7 各节的影响

- **P7b 规则类**（不需要类型信息）：
  - 栈空时多余的 `#endif` 忽略；
  - `#if` 表达式后面的 `;` 等尾随字符（WPE 自己的求值器，`3409595232` 实测编过；具体规则在子计划里定）；
  - 同名宏可以重定义；
  - `varying vec4 v_Size.xy;` 当成 `vec4 v_Size`；
  - `main` 之前引用 `float` / `vec2` / `int` / `uint` 数组 uniform 时用打包形态 `vec4[ceil(n/4)]`（`video`）；
  - `editable` 中性。
- **P7c HLSL 隐式转换**（naga 前端）：
  - 上表的规则；
  - 片元的 varying 按顶点的类型声明（改写阶段换声明，正文的截断交给 HLSL 模式）；
  - 片元可以写 varying：HLSL 模式下输入可写，naga 里一行（`mutable: !input || self.hlsl`）。原计划在 P7b 用私有副本，不再需要。
- **回退不用复刻**：语料里没有 WPE 编不过、我们能编过的着色器。以后遇到再按「日志 + 暗红」复刻。
- **解锁数重算**（P7b / P7c 的分界变了）：只做 P7，能渲染 35 → 37，两张都在 P7c；P4–P6 先做完时 56 → 65，P7b 2 张（`3498150384`、`3815289650`），P7c 7 张。

## 仍未知

1. 没配上的 7 个着色器在 WPE 里的编译结果（场景里没有回退，但没有直接看到它们的绘制）。
2. `#if` 求值器遇到尾随字符的确切规则，以及未定义标识符按不按 0（rea 仍未知 5）。
3. 其它「WPE 编不过、我们能编过」的写法（`mat2` / `ivec2` 的 uniform 或 varying 声明、`main` 之后的函数、`main` 里提前 `return;`）没有扫。
4. Tint 对 HLSL 模式新产出写法的接受度：P7a 建基线时一起测。

## 工具与数据

| 用途 | 位置 |
|---|---|
| 分类与解锁数 | `ignore/p7/ana_p7.py`、`extract_shaders.py` → `src/`、`out/shaders.json` |
| 本机 fxc | `ignore/p7/fxc.py`、`fxc/t1–t5.hlsl` 与反汇编 |
| 代表场景、抓帧扫描、配对 | `ignore/p7/pick.py`、`ana_shaders.py`、`match.py`、`peek.py`；结果 `out/wpe-*-shaders.json` |
| 确定性工程 | `ignore/p7/gen_sem.py` → `proj/p7-sem` |
| 「WPE 编不过」的粗扫 | `ignore/p7/scan_quirks.py` → `out/quirks.json` |
| 抓帧 | `A:\p7\step0`、`A:\p7\sweep`、`A:\p7\sem` |

## P7b 规则的实测（2026-11-11）

读码见 [rea-p7-shader](rea-p7-shader.md)「P7b 补查（预处理、声明、打包）」。确定性工程 `p7-sem` 加了四个图层（`ignore/p7/gen_sem.py`），抓帧 `A:\p7\sem\p7-sem-b0`、`-b1`、`-b2`：

| 图层 | 写法 | 预测 | WPE |
|---|---|---|---|
| `kbsemi` | `#if KB_ONE == 1;`（尾随分号） | 求值器只读一个表达式，分支照常选中，画绿 | 编过，`mov o0, l(0, 1, 0, 1)` |
| `kbswz` | 两段都声明 `varying vec4 v_Size.xy;`，顶点写 `(0.1, 0.2, 0.3, 0.4)`、片元输出 `.xyz` | 当成 `vec4 v_Size` | 编过，片元读第二个插值寄存器 `v1.xyz` |
| `kbredef` | `#define KB_V 0.2` 后 `#define KB_V 0.8` | 后者覆盖前者 | 编过，`mov o0, l(0.8, 0.8, 0.8, 1)` |
| `kbpack` | `main` 之前读 `g_AudioSpectrum16Left[i].x`（`i` 来自 varying，运行时为 4），声明后面紧跟 `g_Time`；`main` 里另读 `frac(g_Time)`，再读 `[i + 100]` | 打包形态 `float4[4]`；越界读到同一 cbuffer 里下一个成员，出了缓冲是 0 | 编过，`cb1[r0.x + 0].x`；像素 `(0.051, 0.051, 0)`，`g_Time` = 9.0511：越界的第 5 行就是 `g_Time`，`[i + 100]` 是 0 |

另外：
- `-b1` 那一版 `g_Time` 只被越界读到、没被直接引用，fxc 把声明缩成 `cb1[4]`，像素读到 0。区分不了是「越界出了声明范围」还是「没引用的成员 WPE 不上传」；真实的音频着色器里两个数组都被引用，属于 `-b2` 的情形。
- 夹具里没有 WPE 认不出 `main`（`main(void)`、`)` 与 `{` 之间有行注释）或数组长度是源码里 `#define` 的宏的着色器（`ignore/p7/scan_quirks2.py`），这两种「WPE 编不过」暂不处理。

对 P7b 的影响：
- 预处理三条按读码实现：尾随字符忽略（只解析一个表达式）、栈空时的 `#else` / `#elif` / `#endif` 忽略、宏后者覆盖前者。
- 声明名带分量：`uniform` / `varying` 都只取名字。
- 打包数组越界：照 D3D11 的实际行为，读到同一 cbuffer 里按本阶段声明顺序排在后面的成员，出了整个缓冲才是 0。子计划原写「读到 0」，按实测改正。

## P7c 规则的实测（2026-11-12）

**fxc 补测**（`ignore/p7/fxc/c1–c3.hlsl`，flags `0x8800`）：

| 写法 | 结果 |
|---|---|
| 用户函数 `g(float2)`、`g(float3)`，实参 `float4` | 错误 X3067 `ambiguous function call` |
| 用户函数 `h(float2)`、`h(float)`，实参 `float4` | 错误 X3067 |
| 向量当 `?:` 的条件 | 逐分量选择（`ne` + `movc`） |
| 标量分量访问 `f.xxxx`、`f.x` | 合法 |
| `float acc; acc += float4` | 截成 `.x` 再加，警告 X3206 |
| `!float` | `== 0` 得 1 / 0 |
| `float && float` | 两边各自 `!= 0` 再与 |

所以用户函数的第二遍是「只有一个重载能经隐式转换匹配上才选它，多个就报二义」，不按截掉的分量多少挑；内置函数照「fxc 的隐式规则」一节：实参截到最窄的一边。

**WPE 抓帧**（`p7-sem` 加 `kbconv1–4`，`ignore/p7/gen_sem.py`，抓帧 `A:\p7\sem\p7-sem-c0`，读整帧图图层中心 `ignore/p7/read_sem.py`）：

| 图层 | 写法 | 预测 | WPE |
|---|---|---|---|
| `kbconv1` | `vec2 a = v4`、`vec3 s = 0.5`、`int i = 2.7`、`float f = v4`、`return` 截断 | `(0.3, 0.5, 0.6)` | `(0.298, 0.498, 0.600)` |
| `kbconv2` | `vec3 m = v4 * v3`、`if (float)`、`float ? :` | `(0.4, 0.5, 0.25)` | `(0.400, 0.498, 0.251)` |
| `kbconv3` | `v4[float]`、`mix(vec4, vec3, float)`、`texSample2D(t, vec4)` | `(0.2, 0.3, 0.45)` | `(0.200, 0.298, 0.451)` |
| `kbconv4` | 用户函数实参截断、`!float`、`float && float`、`f.xx`、`float += vec4` | `(0.3, 0.5, 0.2)` | `(0.298, 0.498, 0.200)` |

同一帧里先前的图层也照旧：`kbwidth` `(0.251, 0.749, 0.498)`、`kbtrunc` `(0.498, 0, 0.498)`、`kbswz` `(0.098, 0.2, 0.298)`、`kbredef` 0.8、`kbsemi` 绿、两个阳性对照暗红。这一帧留作 P7c 步骤 4 在 Kabegame 里渲染 `p7-sem` 的对照真值。

## P7d 的实测（2026-11-12）

工具与数据在 `ignore/p7d/`：
- 工程生成：`mk_fluid.py`（流体预览工程的变体）、`gen_uni.py`（`p7d-uni`）；
- 语料重算：`slots.mjs`（重放请求夹具、按「被引用」重算槽位，结果 `out/slots-p7c.json`）、`wg.mjs`（取一个请求的 WGSL）；
- 读结果：`show_corpus.py`、`show_shaders.py`、`show_shaders2.py`、`imgdiff.py`；
- 抓帧：`A:\p7d\cond2`（条件变体）、`A:\p7d\det`（确定性）、`A:\p7d\uni`（引擎 uniform 与槽位）。

### 流体 effect 的条件

工程是 WPE 自带的 `effects/fluidsimulation/preview`。去掉对象的 `depth`、`cursorinfluence` 改 0，effect / 材质 / 着色器换成 assets 的现版，放在工程根下：
- WPE 不去 effect 目录里找 `materials/effects/*.json`。只留 assets 里那份时，日志报 `Material materials/effects/fluidsimulation_curl.json error: * Line 1, Column 1`，全部 effect pass 换成同一个缺省着色器。
- 工坊 `3286859278` 的 pkg 就是把材质与着色器放在工程根下。Kabegame 按 effect 目录也能找到，比 WPE 宽，不影响结果。

| 变体 | 写法 | 绘制数 | combine 的着色器 | 结论 |
|---|---|---|---|---|
| `fluid` | 原样（实例没有顶层 `combos`） | 18 | `5d4d6561`（`RENDERING` 0） | 基准：normal pass 被 `LIGHTING: 1` 去掉 |
| `ltop` | 实例顶层 `combos: {LIGHTING: 1}` | 19 | `5d4d6561`（没有光照） | 条件看顶层；顶层不并进 pass 的 COMBO |
| `lpass` | combine 的实例覆盖 `LIGHTING: 1` | 18 | `233d1c79`（多出 `u_Roughness`、`u_Metallic`） | pass 覆盖改了着色器，条件不认它 |
| `r3top` | 顶层 `RENDERING: 3` | 18 | `5d4d6561` | 同 `ltop` |
| `r3pass` | combine 覆盖 `RENDERING: 3` | 18 | `8c252fe3`（读槽 4） | 槽 4 绑的不是速度场，是一张 6×6 的纹理：bind 的条件不满足 |
| `r3both` | 顶层与覆盖都写（编辑器的写法） | 18 | `8c252fe3` | 槽 4 绑 256×256 `R16G16_FLOAT`，即 `_rt_SmokeVelocity2` |

另外两条：
- **被条件去掉的 pass 仍占实例覆盖的位置：** 基准里 normal（第 17 个绘制 pass）被去掉，combine 的 `u_Feather` 是 0.68，正是第 18 项覆盖的值（缺省 1.0），`BLENDMODE` 也是那一项的 0。
- **fbo 跨帧保留：** 一帧里只有后备缓冲的两次 Clear，没有清 fbo 的操作。

### 流体的确定性

同一工程开三次窗口各抓 4 帧（`A:\p7d\det\run1–3`，帧号 154–166），Present 图逐像素比：

| 比较 | 平均差 | 差 > 16 | 差 > 64 |
|---|---|---|---|
| 同一次运行相邻两帧（155 / 156） | 2.9 | 7.3% | 0.8% |
| 同一次运行隔 3 帧（155 / 158） | 7.0 | 19.9% | 4.0% |
| 两次运行的相近帧（158 / 160、158 / 164、163 / 164） | 8.8–12.3 | 22–38% | 6–9% |

火焰的轮廓与亮度分布相同，细节完全不同：dt 每帧都不一样，模拟是混沌的。和 WPE 逐像素比只能在同一份输入（模拟 RT 与 `g_Frametime`）上做单步；长时间只能比统计量。

### 材质常量的槽位（`p7d-uni` 的 `kbslot`）

顶点 `vec2 u_M`（键 k_m），片元 `float u_M`（同键、读到）。片元另有五个键，声明顺序 b、z、m、mo、n、a：
- k_mo 只以 `* 0.0` 读；
- k_n 只在 `#if 0` 里读。

值：a 3、b 2、m 7、mo 13、n 11、z 5。

| 读到的 | 值 |
|---|---|
| 顶点 `u_M` | `[7, 5]` |
| 片元 `u_Q`（k_mo）、`u_N`（k_n） | `referenced: false`，常量缓冲里是垃圾值 / 0 |

几种假设的预测：
- 按键名排序、只给 fxc 优化后还在用的键分配槽位 → 5；
- 语法上读到就算 → 13；
- 插入顺序（顶点表在前）→ 2。

所以 WPE 按键名排序，只给反射里被使用的键分配槽位，越界多读的分量来自排序后的下一个被使用的键。这和 vector-constant-REPORT 2.1「本阶段反射里有才收」一致，并定下了合并表的顺序。

### 两个引擎 uniform（`p7d-uni` 的其余图层）

**`g_LayerModelMatrix`（读顶点常量缓冲）：**

| 绘制 | 值 |
|---|---|
| `kbfx` effect 第一个 pass（画进 fbo）与第二个 pass（上屏） | 图层世界矩阵：列 `(1.3816, 0.5841)`、`(-0.1947, 0.4605)`、平移 `(960, 600)` = T · R(0.4) · S(1.5, 0.5)，不含 size |
| `kbchild`（`kbfx` 的子图层）的 effect pass | 父链累乘的世界矩阵：平移 `(1088.42, 681.44)` = W_父 · (100, 50) |
| `kbbase` 直接上屏、`kbbasefx` 的基础 pass | 上一个带 effect 的图层（`kbchild`）的矩阵：没有写，残留 |

`g_EffectModelMatrix` 在这几处与 `g_LayerModelMatrix` 相同，也是基础 pass 里残留。

**`g_FrameTime`（大写 T）：**
- 进 `g_bufStatic`（和材质常量同一个缓冲），值 `3.32e12`，没有人写；
- 同一帧 `g_Frametime` 是 0.0518。

### 语料按「被引用」重算

`slots.mjs` 用 P7c 的 wasm 重放 `requests-p7c` 的 798 个请求。「被引用」取本阶段 WGSL 里出现 `global.<成员>`，是语法判据，不看入口可达，也不做 fxc 的死代码消除。

| 着色器 | 场景 | 现在的算法 | 只数被引用的键 |
|---|---|---|---|
| `fluidsimulation_advection`（`DYE` 1） | `3286859278` | 55 个 float，31 个键 | 10 个 float，7 个键 |
| `procedural_noise`（工坊 3632410990） | `3643916956` | 49 个 float | 19 个 float |
| `frame_builder`（两个版本，`REF_RES` 缺省 0） | `3577990983`、`3643916956` | 同键不同类型 | 两个阶段都没读 `u_refResolution` |
| `frame_builder_by_gariam`（`REF_RES` 1） | `3643916956`、`3660962877` | 同键不同类型 | 只有顶点读；片元定义了 `res` 却没用，合并类型取顶点的 `vec2` |

另外两个引擎 uniform：
- `uniform:g_FrameTime` 的唯一样本是 `procedural_noise` 的顶点：只声明、没读。
- `uniform:g_LayerModelMatrix` 的 7 个请求都在顶点里读它，是真的。

fxc 只会比语法判据删掉更多读取。少一处读取不会多占槽位，也造不出同键不同类型，所以「语料里没有真实的 `constant:*`」这个结论在 fxc 的判据下同样成立。

两种判据只在一种情况下给出不同的值：两个阶段同键、类型或缺省不同，片元的读取被 fxc 优化掉了。这时 WPE 取顶点那一半的类型与缺省，我们取片元的。语料里没有这种情况。

### 对 P7d 的影响

- **条件：** 编译期按实例顶层 `combos` 求值，不并进 pass 的 COMBO；实例覆盖按全部绘制 pass 计位。
- **翻译器反射加 `unused`：** 宿主只给被引用的键分配槽位；合并类型取「读到它的最后一个阶段」（片元优先）；没被引用的引擎 uniform 不报。这样 5 处 `constant:*` 与 `uniform:g_FrameTime` 都消失。真读到的 `g_FrameTime` 在 WPE 里是垃圾值，照报。
- **同键不同类型的溢读：** 语料里没有真实样本。
- **`g_LayerModelMatrix`：** effect pass 里是图层世界矩阵（含父链、不含 size）。基础 pass 与直接上屏的残留值复刻不了也不必复刻，语料里只有 effect 着色器读它。
- **流体验收：** 逐像素只能比单步；长程比统计量，以 WPE 自身两次运行的差异为参照。

## P7d 流体的对照（2026-11-12，步骤 3 验收 3b）

> 3a（结构对照）已做完 80/80。这一节是「决定」4 的另外两层：单步隔离与长程统计。工具与数据在 `ignore/p7d/`，结果在 `ignore/p7d/out/`，WPE 抓帧在 `A:\p7d\step`。

### 方法

**WPE 单步真值**：`p7d-fluid` 在 768×768 测试窗口里连续抓 3 帧（`A:\p7d\step`）。在其中一帧里：
- 按各绘制实际绑定的资源认出全部模拟 RT（速度两张 RG16F 256²、压力两张 R16F、散度、旋度 R16F、染料两张 RGBA8 128²），以及这一帧开始时每个名字扮演的是哪一张（WPE 的 `swap` 只改 pass 的下标、不交换纹理，rea-p7d-fluid 第 3 节第 3 条）；
- 第一个流体绘制（curl）之前存全部模拟 RT 作输入，最后一个绘制（combine）之后存作输出，DDS 保留原格式；
- 读各 pass 常量缓冲里的 `g_Frametime`、`g_Time`、指针。

**dev 探针**（`apps/wpe-scene/src/dev/fluidProbe.ts`，挂 `__kabegameSceneProbe.fluid`）：编译并建好场景；把指定图层 effect 的 fbo 换成给定内容（DDS 经 `fetch(file:)` 读）；按给定的逐帧 `frametime` / `time` / 指针每帧完整编码一次；读回指定的 fbo（按当前扮演的名字）与场景目标（可按 `fill` 铺到画布），原始数据（float 为 float32）经 `chunk` 取。

**单步隔离**：同一份输入、同一组 uniform，在 Kabegame 里跑一帧，和 WPE 这一帧的输出逐个 RT 比：最大绝对差、平均绝对差、超过 fp16 一个 ulp 级别的像素占比。

**长程统计**：从清空的状态起按 WPE 实测的帧时长跑到第 150 帧左右，读回 768×768 画布（`fill`），和 WPE 三次运行的 Present 图用 `imgdiff.py` 比，对照 WPE 自身两两之间的差异。

### WPE 真值

抓帧 `A:\p7d\step\step-frame120–122.rdc`（768×768，18 个绘制：基础 pass + 17 个流体 pass，normal 被 `LIGHTING` 条件去掉）。提取用 `ignore/p7d/rdc_fluid.py`（无界面 qrenderdoc 调 MCP 的服务层），认名字用 `fluid_map.py`，产物在 `ignore/p7d/proj/p7d-fluid/kbstep/step-frame<N>/`（放在测试工程里，宿主才读得到）：
- `in-<资源>.dds`：第一个绘制（基础 pass，事件 20）之后、curl（事件 36）之前的全部模拟 RT 与合成 RT；`out-<资源>.dds`：combine（事件 347）之后；`ev<事件>-<资源>.dds`：每个绘制之后它自己的目标；`backbuffer.png`；
- `draws.json`：每个绘制的 SRV / RT / 采样器与两个阶段常量缓冲的全部变量；`roles.json`：这一帧开始时每个 fbo 名字扮演哪张纹理。

DDS 保留原格式：速度 `R16G16_FLOAT`、压力 / 散度 / 旋度 `R16_FLOAT`（DX10 头），染料与合成 RT `R8G8B8A8_UNORM`（RenderDoc 写老式掩码头）。这一帧只被读、不被写的那张染料也要存（第一版漏了，按 SRV 补上）。

各帧的名字对应与输入（vorticity 的常量缓冲）：

| 帧 | `Velocity1` / `Velocity2` | `Dye1` / `Dye2` | `g_Frametime` | `g_Time` |
|---|---|---|---|---|
| 120 | 25401 / 25404 | 25419 / 25422 | 0.050423 | 6.102491 |
| 121 | 25404 / 25401 | 25422 / 25419 | 0.098484 | 6.200974 |
| 122 | 25401 / 25404 | 25419 / 25422 | 0.110432 | 6.311407 |

- swap 的奇偶逐帧交替，和「只改下标」一致；压力两张、散度、旋度不参与 swap，名字对应不变。
- 抓到的帧是长帧，dt 偏大（第 121、122 帧超过 advection 的钳制 1/20，vorticity 里线发射器的 `g_Frametime · speed` 不钳）。
- 指针 `(2.80, 1.61)` 在窗口外，`g_PointerState` 全 0。
- 测试窗口实际约 20 fps：det 三次运行 12 帧的 `g_Time / 帧号` 都是 0.0503–0.0506（`ignore/p7d/det_times.py`）。

### 单步隔离

探针 `__kabegameSceneProbe.fluid`（`apps/wpe-scene/src/dev/fluidProbe.ts`），驱动 `ignore/p7d/fluid_run.ts`，参数由 `fluid_step_job.py` 从 `roles.json` / `draws.json` 生成，比较 `fluid_cmp.py`（结果 `ignore/p7d/out/step/cmp-<帧>.json`）。半精度 RT 按 ulp 距离比（读回的 float32 换回半精度位，按有序整数相减）。

| RT | 帧 120 | 帧 121 | 帧 122 |
|---|---|---|---|
| 旋度 R16F | 逐位相同 | 逐位相同 | 逐位相同 |
| 速度 1 RG16F（131072 个值） | 1 个差 1 ulp | 4 个，最大 2 ulp | 20 个，最大 16 ulp / 0.0625 |
| 速度 2 RG16F | 逐位相同 | 4 个，最大 2 ulp | 25 个，最大 18 ulp / 0.0625 |
| 散度 R16F（65536） | 逐位相同 | 1 个，4 ulp | 2 个，最大 184 ulp / 0.031 |
| 压力 2 R16F | 逐位相同 | 1 个，1 ulp | 18 个，最大 8 ulp / 0.012 |
| 压力 1 R16F | 逐位相同 | 2 个，最大 2 ulp | 23 个，最大 24 ulp / 0.012 |
| 染料两张 RGBA8 | 逐字节相同 | 逐字节相同 | 逐字节相同 |
| 合成 RT（基础 pass） | 逐字节相同 | 逐字节相同 | 逐字节相同 |

对照（第 121 帧，`--control`）：WPE 自己这一帧的输入对输出，各半精度 RT 逐位相同的只有 0.02–0.41%，98–99.5% 的值差超过 16 ulp，平均绝对差 7.6–18。所以上表的接近不是因为一步本来就不怎么变。

不同的值都挤在一个点附近（`fluid_spots.py`）：
- 第 121 帧在 (1–3, 231–233)；
- 第 122 帧在 (144–153, 123–137)。散度在 (148, 132) 差 0.03125，正好是速度场一个 |v| ≈ 64–97 的值差 1 ulp（0.0625）再乘 0.5：散度是速度的差分，大值上的 1 ulp 落到小值上就成了 184 ulp。之后压力、梯度相减、平流照着传开。
- 源头是 vorticity 输出里个别大幅值的 1 ulp 舍入（它的输出在帧末被 advection 覆盖，帧末读不到；散度只有这两个点不同，说明 vorticity 的输出只差这一两个值）。

结论：**单步只差半精度舍入**，达到「决定」4 的这一层。

画布（参考，不算验收项）：我们的 768² 画布对 WPE 后备缓冲平均差 0.96、最大 75–92、像素差 > 16 的 1.3%。原因是分辨率：WPE 按窗口分辨率直接画最后一个 effect pass（combine 的视口 768×768），我们按场景分辨率 256² 画、上屏再放大。WPE 像素 (3i+1, 3j+1) 的中心正好是场景第 (i, j) 个像素的中心，拿这些采样点和我们的场景目标比（`combine_centers.py`，第 121 帧）：99.63% 逐字节相同，最大差 5，平均 0.005。这是渲染器已知的分辨率差异（kabegame-chromium SKILL「读回画布」的「已知差异」，这里场景比窗口小，WPE 同样按窗口分辨率画），不是流体的问题。

### 长程统计

从清空的状态起在 Kabegame 里跑 167 帧，读回第 154–167 帧的 768² 画布（`fill`），和 WPE 三次运行的 12 张 Present 图（`ignore/p7d/out/wpe-run*-f*.png`）比。参数 `fluid_long_job.py`，比较 `long_cmp.py`（结果 `ignore/p7d/out/long/cmp.json`）：
- 帧时间固定 0.050426（det 12 帧 `g_Time / 帧号` 的均值），`g_Time` 按它累加；指针放在窗口外（同抓帧）；
- 167 帧跑完约 0.8 s。

| 比较（最小 / 中位 / 最大） | 对数 | 平均差 | 差 > 16 | 差 > 64 | 行均值曲线最大差 |
|---|---|---|---|---|---|
| WPE 两次运行之间（帧号差 ≤ 8） | 38 | 8.79 / 11.97 / 14.55 | 22.0 / 33.5 / 40.6% | 6.2 / 8.8 / 11.5% | 5.2 / 9.6 / 14.3 |
| 我们对 WPE（帧号差 ≤ 8） | 143 | 8.34 / 10.50 / 15.45 | 22.3 / 28.6 / 42.2% | 4.6 / 6.8 / 12.4% | 4.9 / 8.8 / 13.5 |
| 我们对 WPE（同帧号） | 12 | 8.88 / 9.11 / 9.37 | 23.0 / 24.4 / 24.9% | 5.2 / 5.6 / 6.3% | 7.4 / 8.4 / 9.8 |
| WPE 同一次运行隔 1 帧 | 9 | 2.88 / 3.03 / 3.07 | 7.2 / 7.5 / 7.7% | 0.7 / 0.8 / 0.9% | 3.0 / 3.5 / 6.6 |
| 我们同一次运行隔 1 帧 | 13 | 2.81 / 2.87 / 2.93 | 6.8 / 7.0 / 7.2% | 0.6 / 0.6 / 0.7% | 3.3 / 4.5 / 6.4 |
| WPE 同一次运行隔 3 帧 | 3 | 6.97 / 7.22 / 7.23 | 19.9 / 20.7 / 23.6% | 3.5 / 4.0 / 4.1% | 5.5 / 6.1 / 9.9 |
| 我们同一次运行隔 3 帧 | 11 | 6.87 / 7.08 / 7.18 | 20.4 / 20.8 / 21.0% | 3.5 / 3.7 / 3.9% | 5.6 / 7.4 / 8.6 |

- **行均值曲线去掉了 21 个分辨率伪影行。** 不去掉时我们对 WPE 是 17.4–20.0，WPE 之间只有 5.2–14.3。差最大的几行（14、44、726、750）在单步第 121 帧（模拟状态与 WPE 逐位相同）的画布上就已经差 17–19，是 "TEST IMAGE" 字的上下边，原因同上一节的分辨率。所以 `long_cmp.py` 按单步画布挑出行均值差 > 3 的行，从这一列里去掉；其余各列不受影响。
- 32 行一段的行均值，我们对 WPE 均值曲线的差在 −1.3 … +4.2 之间，和 WPE 各帧在同一段里的离散（0.2–4.3）同一量级（`long_rows.py`）。
- 火焰覆盖（像素 R − B > 64 的占比）：WPE 57.5–59.0%，我们 57.4–58.3%。整图平均亮度我们高约 0.3–0.7，其中 0.16 在单步画布上就有（分辨率），其余落在 WPE 三次运行之间的离散里（129.5–131.0）。
- 换一个帧时间（固定 0.0500，正好是 advection 钳制的边界）再跑一次（`out/long/cmp-dt0500.json`）：对 WPE 平均差 8.10 / 9.95 / 14.19、差 > 16 21.5 / 28.3 / 41.4%；我们这两次运行之间（`long_self.py`）平均差 7.38 / 9.66 / 14.57、差 > 16 21.2 / 28.0 / 40.1%，和 WPE 两次运行之间同一量级。

结论：**长程统计落在 WPE 自身两次运行之间**，达到「决定」4 的这一层。单帧变化量（隔 1 帧、隔 3 帧）也和 WPE 几乎相同，说明模拟的「速度」一致。我们对 WPE 的最大值比 WPE 之间略大（15.45 对 14.55），因为配对多（143 对 38），中位数反而更小。

### 工具（`ignore/p7d/`）

| 用途 | 文件 |
|---|---|
| 从抓帧取单步真值（各绘制的 SRV / RT / 常量、各 RT 的 DDS） | `rdc_fluid.py` + `rdc_fluid_inner.py` |
| 认出各绘制、推出这一帧开始时的名字对应 | `fluid_map.py` → `roles.json` |
| det 各帧的 `g_Time` / `g_Frametime` | `rdc_cbuf.py` → `out/det-cbuf/`、`det_times.py` |
| 跑探针、落盘读回 | `fluid_run.ts`（参数 `fluid_step_job.py`、`fluid_long_job.py`、`job_scene.py`） |
| 单步比较与定位 | `fluid_cmp.py`（`--control`）、`fluid_spots.py`、`fluid_worst.py`、`combine_centers.py`、`canvas_res.py`、`row_peak.py`、`signed_mean.py` |
| 长程比较 | `long_cmp.py`、`long_rows.py`、`long_self.py`、`side.py`（并排图 `out/long/side-155.png`） |

探针的 `inject` 文件要放在已导入的场景目录里（宿主的 `file:` 范围），所以真值放在 `ignore/p7d/proj/p7d-fluid/kbstep/`。WPE 只读工程引用的文件，这个子目录不影响 WPE 抓帧。

### 遗留

- 单步验的是 WPE 第 120–122 帧（抓帧的长帧，dt 0.05–0.11）。dt 正常（约 0.05）时 advection 的 `min(1/20, dt)` 正好在边界上，没有单独抓 dt < 0.05 的帧；长程的两次运行（0.050426、0.0500）覆盖了边界两侧。
- 最后一个 effect pass 的分辨率：WPE 按窗口分辨率画，我们按场景分辨率画再放大。画布上平均差约 1、字边的行差 17–19，所有带 effect 的场景都有，不是 P7d 的范围（kabegame-chromium SKILL「读回画布」的已知差异；这里场景比窗口小，WPE 同样按窗口分辨率画）。
- combine 在采样点上还有 0.37% 的值差 1–5（第 121 帧）。可能是槽 2 的渐变纹理（64×2，WPE 用各向异性采样器）的采样差，没再往下查。
