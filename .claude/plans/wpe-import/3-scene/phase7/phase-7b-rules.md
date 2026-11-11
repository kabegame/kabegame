# P7b — 规则类（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7b」。依据：[rea-p7-shader](rea-p7-shader.md)（WPE 自带的预处理、声明正则、accessArray）、[p7-REPORT](p7-REPORT.md)、P7a 的请求夹具与逐字节基线（[phase-7a](phase-7a-corpus-naga.md)）。
> 比较基准：`ignore/p7/baseline/p7a-9508c531`（3468 个文件，P7a 收尾后导出）。

## 总体设计思路

P7b 处理不需要类型信息的差异：照 WPE 在交给 fxc 之前自己做的文本处理，在我们的预处理和改写阶段做同样的事。共四类，加一处 Tint 问题：
- **预处理：**
  - 栈空时多余的 `#endif` 忽略；
  - `#if` 表达式后面的尾随字符（`#elif AUDIOSAMPLES == 32;`）按 WPE 求值器的规则处理；
  - 同名宏、内容不同的重定义，照 fxc 的「后者覆盖前者」。
- **声明名带分量：** `varying vec4 v_Size.xy;` 当成 `vec4 v_Size`（WPE 的声明正则只取到名字）。
- **`main` 之前的打包数组：** `float` / `int` / `uint`（可能还有 `vec2`）数组 uniform 在 WPE 里分两种形态：
  - `main` 之前的文本看到的是 cbuffer 里打包的 `float4[ceil(n/4)]`；
  - `main` 里看到的是拆开的 `float[n]`。

  我们现在两处都给拆开的形态，所以 `main` 之前的辅助函数读到的值和 WPE 不同。夹具里 5 个工坊音频 effect 是这种写法，其中 2 个我们现在能翻译，但画法和 WPE 不一样。只是它们都还因为音频 uniform（P11）整张退回，所以眼下看不出来。
- **几何段展开的指针别名：** `rope` / `ropetrail` 带 `REFRACT` 时，Tint 拒绝几何展开后的代码（P7a 步骤 2 发现）。

每一类只改真正用到这种写法的着色器的输出，其余逐字节不变。这由 P7a 的基线比较把关，每步都用 `WPESL2WGSL_BASELINE_ALLOW` 列出预期会变的键。

P7b 单独做完，能渲染数不变：用到这些写法的场景多半还缺类型类的修正（P7c）或别的能力。`video` 那张也一样，打包形态之后，它的 `[barID % 4]` 是浮点下标，要 P7c。所以 P7b 的验收以翻译器语料、与 WPE 比的确定性工程为主，不以解锁数为准。

## 现状锚点

**a. 多余的 `#endif` 直接失败**（`src-tauri/wpesl2wgsl/src/preprocess.rs:151`）
```rust
                    "endif" => {
                        if stack.pop().is_none() {
                            return Err(fail("#endif 没有对应的 #if".into())); // 现状：WPE 栈空时忽略
                        }
                    }
```

**b. `#if` 表达式遇到不认识的字符就失败**（`preprocess.rs:525`）
```rust
        } else {
            return Err(format!("#if 表达式里无法识别的字符 {c:?}")); // 现状：`32;` 的分号走到这里
        }
```

**c. `#define` 行原样留给 naga 的预处理器**（`preprocess.rs:181`）
```rust
                    "define" => {
                        // …
                        self.macros.insert(macro_name.to_string(), entry); // 现状：只记下来供 #if 求值
                        self.push(code, None, file, line_no);              // 原样输出；内容不同的重定义由 naga 报 DefineRedefined
                    }
```

**d. 补齐过的数组只有一种形态**（`src-tauri/wpesl2wgsl/src/rewrite.rs:706`）
```rust
        // 补齐过的数组：用函数还原成原类型，再让原名字指过去（下标访问与整体传参都照常可用）
        // 现状：main 之前、main 里看到的都是还原后的 float[n]
            out.push_str(&format!(
                "{ty}[{count}] kb_load_{name}() {{ … r[i] = kb_u_{name}[i].{swizzle}; … }}\n#define {name} kb_load_{name}()\n",
```

**e. 带初始值或限定符的全局声明报错**（`rewrite.rs:580`）
```rust
            return Err(format!("不支持的全局声明（带初始值或限定符）：{text}")); // 现状：`varying vec4 v_Size.xy;` 走到这里
```

**f. `editable` 不在 effect 字段白名单里**（`apps/wpe-scene/src/compile/features.ts:250`）
```ts
const SUPPORTED_EFFECT = new Set([
  "version", "name", "description", "group", "preview", "dependencies", "replacementkey", "performance", "gizmos", "passes", "fbos",
  // 现状：没有 editable，语料 1 张报 effect:jian:editable
]);
```

**夹具里的用法**（`ignore/p7/scan_p7b.py`，文本粗扫、不展开 `#if`）：
- 多余 `#endif` 5 个着色器；
- `#if` 里的分号 1 个；
- 同名宏多次定义 33 个，大多内容相同、现在就能编过，只有工坊 `audio` 内容不同；
- 声明名带分量 1 个；
- `main` 之前引用 `float` 数组 5 个工坊 effect（都是 `g_AudioSpectrum64*`）。

## 步骤

### 步骤 0 — 调研

**读码**（交给代理，REA 看 `wallpaper64.exe`，续 rea-p7-shader）：
1. `#if` 求值器 `FUN_140167e10` 遇到尾随字符（`32;`、`32 // 注释`、多余的右括号）怎么办：忽略剩下的、按 0、还是报错；未定义标识符按不按 0（rea 仍未知 5）；栈空时的 `#else` / `#elif` 怎么办。
2. WPE 自己的宏表：`#define` 重定义时 `#if` 用哪一个；`#undef` 是否处理。
3. 声明正则：`uniform` / `attribute` 的名字后带分量时是否和 `varying` 一样；带初始值的写法怎么办。
4. accessArray 的确切布局：`vec2` / `int` / `uint` 数组在 cbuffer 里的打包（`vec2[n]` 是 `ceil(n/4)` 个还是 `ceil(n/2)` 个 `float4`）；`main` 的起点怎么认（签名的写法有没有变体）。

**实测**（我做，本机 fxc 与 WPE 抓帧）：
- cbuffer 里打包数组越界读的结果：fxc 反汇编，加 D3D11 规范（越界的常量缓冲读返回 0）。WGSL 对私有数组越界会钳位到范围内，所以我们要显式判界才能照 WPE。
- `p7-sem` 加三个图层：`#if` 尾随分号、声明名带分量、`main` 之前读打包数组（用材质常量数组或固定值，不依赖音频）。看 WPE 编不编得过、画出什么。

**产出：** rea-p7-shader 追加一节；p7-REPORT 追加「P7b 规则的实测」；本子计划的步骤 0 实施记录。

### 步骤 1 — 预处理三条

- **修改** `preprocess.rs`：
  - 栈空时的 `#endif` 忽略，不出行（WPE 的处理过的指令行抹成空格）；`#else` / `#elif` 按步骤 0 的结论。
  - `#if` 的尾随字符按步骤 0 的结论。
  - `#define` 遇到同名、内容不同的宏时，先输出一行 `#undef <名>` 再输出新定义（照 fxc 的「后者覆盖前者」）；内容相同的照旧不动，保证这 32 个着色器的输出逐字节不变。
- **单测**：每条一正一反。

**验收：**
- 对基线：只有用到这几种写法的着色器变化（ALLOW 列出），预期是原来失败的那几个变成通过或换成下一个错误；
- 新通过的回读通过、Tint 0 error；
- 确定性工程 `p7-sem` 的 `kbtrunc`（多余 `#endif` + 宏定义两次）和步骤 0 新加的分号图层，在 Kabegame 里渲染，和 WPE 抓帧逐像素比。

### 步骤 2 — 声明名带分量

- **修改** `rewrite.rs` 的全局声明解析：`uniform` / `varying` / `attribute` 声明里名字后跟 `.分量` 时，按步骤 0 的结论当成不带分量的同名声明。
- **单测** 与验收同步骤 1；`frame_builder` 的 3 个版本预期会露出下一个错误（类型类），在报告里写清楚。

### 步骤 3 — `main` 之前的打包数组

- **修改** `rewrite.rs`：`float` / `int` / `uint` 数组 uniform（accessArray 只看类型，rea「P7b 补查」第 4 条），在 `main` 签名之前的正文里出现时，`X[e]` 改成 `kb_pack_X(e)`，返回打包后的一行（`vec4` / `ivec4` / `uvec4`）：
  - 第 `k` 行是原数组的 `4k … 4k+3` 号元素，不足的补 0；
  - **越界照 D3D11**（步骤 0 实测）：`k` 超出本数组时，读同一 cbuffer 里按本阶段声明顺序排在后面的成员（按 HLSL cbuffer 的打包规则换算成行），出了整个 cbuffer 是 0。cbuffer 的分流按名字（rea 第 5 条：材质名与 5 个内置名进 `g_bufStatic`，其余内置名进 `g_bufDynamic`）；
  - `main` 里照旧用 `kb_load_<名>()`；
  - 只有 `main` 之前引用了这类数组的着色器才生成 `kb_pack_*`，其余输出逐字节不变。
  ```glsl
  // 新增（示意）：g_AudioSpectrum64Left / Right 都是 float[64]，同在 g_bufDynamic；main 之前看到的是 vec4[16]，越界读到 Right
  vec4 kb_pack_g_AudioSpectrum64Left(int k) {
      if (k >= 0 && k < 16) return vec4(kb_u_g_AudioSpectrum64Left[4 * k].x, /* … */);
      if (k >= 16 && k < 32) return vec4(kb_u_g_AudioSpectrum64Right[4 * (k - 16)].x, /* … */);
      return vec4(0.0);                       // 出了整个 cbuffer
  }
  ```
  `vec2` 数组 WPE 也声明成 `float4[ceil(n/4)]`（装不下，WPE 的缺陷），语料没有实例，不做、照旧报错。
- **单测**：`[i/4][i%4]` 两级下标、`arr[i]` 取整个 `vec4`、越界到下一个成员、出了缓冲。

**验收：**
- 对基线：`audioline`、`highly_customizable_audio_visualizer` 等 5 个 effect 的输出变化（ALLOW），其余不变；`video` 预期露出浮点下标（P7c）的错误。
- 确定性工程：`main` 之前读打包数组的图层，和 WPE 抓帧比。

### 步骤 4 — 几何段展开的指针别名

- **修改** `geometry.rs`（或几何展开后的改写）：几何段里把 `PS_INPUT` 变量的两个字段同时以 `inout` / `out` 实参传给同一个函数时，改成先传两个临时变量，调用后拷回字段。
- **验收：**
  - 几何门槛 27/27；
  - `geom__rope__refract`、`geom__ropetrail__refract` 的输出变化（ALLOW），其余逐字节不变；
  - 这两份 Tint 0 error；
  - 粒子绳的确定性工程（P4d 的 `p4d-*`）在 Kabegame 里画面不变。

### 步骤 5 — `editable`

- **修改** `apps/wpe-scene/src/compile/features.ts`：`SUPPORTED_EFFECT` 加 `editable`，注释写依据（`wallpaper64.exe` 里没有这个字符串，推断是编辑器键）。
- **验收：** 语料扫描只少 `effect:jian:editable` 一个键；tsc、vitest、Prettier。
- **并行：** `features.ts` 是 P4–P6 共用的文件。这一步只加一行，动工前看一次别的会话的工作区，同一时刻不和它们改同一个文件。

## 收尾

- **文档：**
  - `src-tauri/wpesl2wgsl/README.md`：「内部流程」的预处理与改写两节写进四条规则，「已知不支持」删掉对应行；
  - 总计划实施记录。
- **重扫：** 语料扫描与请求夹具各重扫一次，重算总计划的解锁数，并导出新基线给 P7c。
- **回归：** `versions/latest/regression.md` 加 P7b 节。
- **实施方式：** 步骤 1–4 交给代理（翻译器），步骤 5 我自己改（一行）。我独立验收：查越界、自己跑基线比较、Tint、和 WPE 比。

## 决定

**已定：**
1. 规则照 WPE 自己的文本处理，不照 GLSL 规范（P7 总计划）。
2. 只改用到这些写法的着色器，其余逐字节不变。
3. **打包数组越界读：** 照 D3D11 的实际行为，不照 WGSL 的钳位（2026-11-11 用户）。步骤 0 实测改正了细节：越界先读到同一 cbuffer 里后面的成员，出了整个缓冲才是 0。
4. **步骤 5 放在哪：** 跟在步骤 4 之后、单独提交；别的会话正在改 `features.ts` 时挪到收尾（2026-11-11 用户）。

## 风险

1. **WPE 的预处理规则还有未知：** 步骤 0 若查不清尾随字符的规则，就只认语料里出现的写法（尾随 `;`），别的照旧报错，不猜。
2. **打包数组的写法不止一种：** 语料里只有 `g_AudioSpectrum64*`，`vec2` / `int` 数组没有实例，只按读码实现，测试用合成的着色器覆盖。
3. **修好一处露出下一处：** 规则类修好后，多数着色器会露出类型类的错误（P7c），所以 P7b 的验收看「错误换成了下一个」，不看通过数。

## 实施记录

### 步骤 0 — 调研（2026-11-11）

- 读码（REA，续 rea-p7-shader「P7b 补查」）：
  - `#if` 先按 WPE 的宏表做宏替换，未定义按 0；只解析一个表达式，后面的一律忽略、不报错；栈空的 `#else` / `#elif` / `#endif` 都抹掉。
  - 宏重定义后者覆盖前者，`#undef` 处理；`#define` / `#undef` 行原样留给 fxc。
  - `uniform` / `varying` 名字后带分量都只取名字，初始值丢弃，多个声明符只认第一个。
  - accessArray 只看类型，长度一律 `ceil(n/4)` 行（`vec2` 也是，装不下）。
  - uniform 进哪个 cbuffer 按名字分；每个 cbuffer 按本阶段声明顺序排，两阶段各自一份。
  - `main` 的识别正则认不出 `main(void)`。
- 实测见 [p7-REPORT](p7-REPORT.md)「P7b 规则的实测」：分号、声明名带分量、宏重定义、打包数组四个图层的 WPE 结果都和读码一致；打包数组越界读到同一 cbuffer 的下一个成员（`g_Time`），出了缓冲是 0。
- 夹具里没有 `main(void)` 或数组长度是源码宏的着色器，这两种「WPE 编不过」暂不处理。
- 计划调整：步骤 3 的越界规则按实测改写（见上文与「决定」第 3 条）；声明名带分量对 `uniform` 一样适用。
- 我的失误：子计划起初写「越界读到 0」，只照了 D3D11 规范里「出了缓冲」那一半；第一版 `kbpack` 的 `g_Time` 没被直接引用，结果也区分不了，改成直接引用后才得出结论。

### 步骤 1–4 — 翻译器规则（2026-11-11）

- 代理实现，我独立核对。改动在 `src-tauri/wpesl2wgsl/`：`preprocess.rs`（步骤 1）、`rewrite.rs` 的 `parse_decl`（步骤 2）、新文件 `pack.rs` 与 `rewrite.rs` 的接入（步骤 3，内置名表 140 项写成常量、注明来源）、`geometry.rs`（步骤 4）。翻译器单测 68 个、naga 128 个全过；几何门槛 27/27；WPE 安装目录 158/167 不变。
- **步骤 1 预处理：** 对 `p7a-9508c531` 基线 3468 个文件全部不变。多余 `#endif` 的 5 个着色器与带分号的 1 个越过了预处理，但在夹具里报缺头文件：夹具是旧翻译器录的，那时预处理就失败、没走到补头文件。代理从 WPE `assets/` 补齐头文件另试（`ignore/p7/requests-p7b-aug`），49 个请求通过 26 个，其余 23 个是类型类。工坊 `audio`：`DefineRedefined` → `Variable cannot be used in LHS position`（类型类）。
- **步骤 2 声明名带分量：** 基线不变。`frame_builder` 露出 `if` 条件不是布尔（类型类）。
- **步骤 3 打包数组：** `audioline`、`highly_customizable_audio_visualizer` 从通过变成失败——在 `float` 的位置用了打包出来的整行，WPE 靠 HLSL 隐式截断取 `.x`，要等 P7c；用到它们的 4 张场景（`3811769317`、`3817779853`、`3823859141`、`3823864170`）本来就因音频 uniform（P11）整张退回，画面无变化。`video` 露出浮点下标（P7c）。用户 2026-11-11 定：现在提交，退步在测试里刻意列出。为此语料测试加了 `WPESL2WGSL_BASELINE_ALLOW_REGRESS`，和普通的 ALLOW 分开；不列时测试照样失败（已验证）。
- **步骤 4 指针别名：** 只有 `geom__rope__refract`、`geom__ropetrail__refract` 的顶点段变化，两份 Tint 0 error（dev 主窗口），其余不变。
- **偏离：** `#if` 去掉三元（WPE 没有，语料也没用到）；`g_Bones` 与 `g_L*` 灯光按 rea 表另有缓冲，不进 dynamic；WPE 声明正则不认的类型不进布局；几何展开拼成的顶点段不做打包；`main` 之前不带下标地用打包数组、`vec2` 数组、`main(void)` 不处理（README 写明）；别名改写只处理单独成句的调用。
- 本步的比较命令：`WPESL2WGSL_BASELINE_DIR=ignore/p7/baseline/p7a-9508c531`，`ALLOW` = `effects/fluidsimulation_advection-`、两个 `geom__rope*__refract`、`audioline`、`highly_customizable_audio_visualizer`，`ALLOW_REGRESS` = 后两个。新基线 `ignore/p7/baseline/p7b-final`（3460 个文件）。

### 步骤 5 — `editable`（2026-11-11，`58253353`）

- `features.ts` 的 `SUPPORTED_EFFECT` 加 `editable`，注释写依据。动工时别的会话没有在改这个文件。
- 在 HEAD 快照上加这一行重扫：只少 `effect:jian:editable` 一个键，能渲染 38 → 38。
- tsc 0 error；vitest 1702 / 1703。唯一的失败是 `pipeline.test.ts` 的请求次数上限（`3830255100` 发了 219 次，上限 200），在不带本改动的 HEAD 快照上同样失败，与 P7b 无关，原样报告。

### 收尾（2026-11-11）

- **重录夹具：** 用 `e2345b19` 编出的 wasm（`ignore/p7/wasm/p7b-e2345b19.wasm`，1 652 802 字节）放进 HEAD 的产品源码快照（`ignore/p7/snap-p7b`），重扫语料并录夹具到 `ignore/p7/requests-p7b`：779 个请求，通过 689、失败 90；原生重放与 wasm 的结果全部一致。新基线 `ignore/p7/baseline/p7b-e2345b19`（3572 个文件），供 P7c 比较。
- **Tint：** 新基线 1786 份 WGSL 在 dev 主窗口全部 0 error、0 warning（P7a 时几何门槛的两个 error 已消失）。
- **语料扫描**（同一份 HEAD 产品源码，P7 之前的 wasm 对 P7b 的 wasm，`ignore/p7/out/diff-before-p7b.txt`）：能渲染 38 → 38。
  - 预处理、声明名带分量、宏重定义、分号这几类全部换成下一个错误（类型类，P7c）；
  - `Simple_Audio_Bars`（`3082978660` 版）用到它的 21 张里 10 张已完整翻译，只剩音频 uniform（P11）；
  - 流体那张（`3286859278`）在 advection 能翻译后露出新键 `constant:slots`，留给 P7d。
- **没做的：** 在 Kabegame 里渲染 `p7-sem` 的新图层、和 WPE 逐像素比。dev 里的 wasm 是 P7 之前的，要等重建 wasm（`deno task build:wpesl2wgsl`，各会话的 dev 重启时生效）之后再比。规则的语义已由 WPE 抓帧（步骤 0）与翻译器单测覆盖。
