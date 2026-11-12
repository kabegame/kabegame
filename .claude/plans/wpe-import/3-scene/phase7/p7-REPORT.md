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
