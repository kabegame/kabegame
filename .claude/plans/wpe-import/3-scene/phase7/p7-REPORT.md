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
