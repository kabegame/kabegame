# P7e — varying 的布局（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7e」。依据：[rea-p7e-varying](rea-p7e-varying.md)（WPE 生成 `VS_OUTPUT` 的读码、确定性工程实测、WPE 编译缓存与抓帧、语料的上限统计）、[rea-p7-shader](rea-p7-shader.md) §2.6（`TEXCOORD` 按顶点的声明顺序分配）。
> 起因：P8 步骤 4 验收时强制渲染 `3243449890`，建管线失败：工坊 effect `auto_sway` 的顶点输出用了 31 个 location，超过 WebGPU 缺省的 16 个阶段间变量（2026-11-13）。

## 总体设计思路

WebGPU 缺省只保证 16 个阶段间变量（`maxInterStageShaderVariables`）。我们的翻译器给每个 varying 一个 location，数组每个元素一个。WPE 把同样的着色器交给 fxc 时，有两件事让寄存器数小得多，P7e 照做这两件事：

- **数组照 WPE 的长度声明。** WPE 生成 `VS_OUTPUT` 时，数组长度对所有类型都按「4 个标量一组」算（`vec2` 按 2 个）。`float` / `vec2` 数组本来就打包成 float4，所以容量刚好够。非 accessArray 的 `vec3` / `vec4` 数组也照这个公式，就只剩 `ceil(n / 4)` 个元素，`n = 1` 时连方括号都没有、退化成普通向量。这是 WPE 的 bug，但它决定了这类着色器在 WPE 里的实际行为：
  - 示波器作者就是照着它写的（`vec4 audioValue[32]` 只写、只读前 8 个元素）；
  - 常量下标越过缩短后的长度时，fxc 报 `X3504`、顶点着色器走回退。

  所以这一条无条件照做，影响的只有语料里这一个着色器。翻译器在收集 varying 时就把数组长度换成 WPE 的长度，正文不动。naga 照常检查常量越界。
- **超过 16 个时把 varying 打包进 vec4。** fxc 会把签名里的标量、`vec2` 装进同一个寄存器（`auto_sway` 的 31 个 varying 在 WPE 的缓存里是 11 个寄存器加位置）。打包只改两阶段之间的接口，插值逐分量进行，值不变；所以只在超过 16 个时才做，其余程序的输出逐字节不变。
  - **原来的 varying 改成私有全局变量**，作者的代码照常读写它们（片元改写 varying、只在片元声明的 varying 都不受影响）。
  - **作者的 `main` 改名 `kb_main`**，再生成一个新的 `main`：顶点阶段先调 `kb_main` 再把全局变量装进 `vec4` 输出，片元阶段先从 `vec4` 输入拆出全局变量再调 `kb_main`。
  - **打包后仍超过 16 个**：翻译失败，场景在编译期就报不支持、退回预览图，而不是到运行时建管线才失败。

不提高设备的 `maxInterStageShaderVariables`：照 WPE 做之后，语料里所有程序都在 16 以内（下面的统计），提高上限只会让结果随显卡不同。语料里没有的角落（越界写、矩阵数组、整数数组）照报不支持，不复刻 WPE 的黑块回退，和 P7 的「回退不用复刻」一致。

## 范围与覆盖（2026-11-14，183 张，`ignore/p8/s4/out/varyings.json`）

| 场景 | 着色器 | 现在 | 照 WPE | 现在其余的不支持项 |
|---|---|---|---|---|
| 3243449890 | 工坊 `auto_sway`（`NODE_COUNT` 5，`AA_VERSION` 2） | 31 | 打包 11 | 26 项 |
| 3486806915 | 同上（三个程序：31、24、17） | 31 | 打包 11 | 20 项 |
| 3492627662 | 同上（两个程序） | 31 | 打包 11 | 23 项 |
| 3516174947 | 同上 | 24 | 打包 9 | 30 项 |
| 3585875739 | 工坊 `audio_responsive_oscilloscope`（`RESOLUTION` 32） | 35 | 数组 8 + 3 = 11 | 4 项，都是 P11a 做的音频键 |

- **只做 P7e 解锁 0 张**：5 张都还差别的节。
- **3585875739**：P11a 的记录把它算作能渲染（`phase-11a-audio.md`），但没有 P7e 时它到运行时建管线就失败、退回预览图。P7e 是它真正能渲染的前提。
- **其余程序**：最多 13 个（`blur_gaussian` 的 `vec2 v_TexCoord[13]`，36 张），不受影响。
- **非 accessArray 的 varying 数组**：语料和 WPE 自带着色器里只有示波器一处；矩阵 varying 只出现在注释里；整数 varying 没有。

## 现状锚点（HEAD `5889b490`）

**a. 收集 varying：数组长度原样记下**（`src-tauri/wpesl2wgsl/src/rewrite.rs:300`）
```rust
Storage::Varying => match varyings.iter().find(|v| v.name == decl.name) {
    // 片元自己的 varying 声明作废、用顶点那份
    Some(_) if stage == Stage::Fragment && vertex_varyings.contains(&decl.name) => {}
    Some(existing) if existing.ty != decl.ty || existing.array != decl.array => {
        return Err(fail(format!("varying {} 在两个阶段的类型不同", decl.name)));
    }
    Some(_) => {}
    None => {
        if stage == Stage::Vertex {
            vertex_varyings.insert(decl.name.clone());
        }
        varyings.push(InterfaceDecl {
            name: decl.name.clone(),
            ty: decl.ty.clone(),
            array: decl.array,                                    // 现状：GLSL 的长度，vec4[32] 就是 32
            location: next_varying,
        });
        next_varying += location_slots(&decl.ty, decl.array);   // 现状：每个元素一个 location
    }
},
```

**b. 每个 varying 一个 location**（`rewrite.rs:662`）
```rust
/// 一个 attribute / varying 占几个 location：矩阵按列数，数组乘以长度。
fn location_slots(ty: &str, array: Option<u32>) -> u32 {
    let columns = match ty { "mat2" | … => 2, "mat3" | … => 3, "mat4" | … => 4, _ => 1 };
    columns * array.unwrap_or(1)
}
```

**c. 生成接口声明：一行一个，没有上限检查**（`rewrite.rs:811`）
```rust
// 顶点阶段输出全部 varying（包括只在片元阶段声明的），片元阶段只声明自己用的
let direction = if stage == Stage::Vertex { "out" } else { "in" };
for varying in varyings.iter().filter(|v| stage == Stage::Vertex || declared.contains(&v.name.as_str())) {
    let flat = if is_integer_type(&varying.ty) { "flat " } else { "" };
    out.push_str(&format!(
        "layout(location = {}) {flat}{direction} {} {}{};\n",
        varying.location, varying.ty, varying.name, array_suffix(varying.array)
    ));
}
out.push_str(&broadcast_helpers(&body));
out.push_str(&body);                                           // 现状：作者的 main 就是入口
```

**d. 反射原样给出声明**（`src-tauri/wpesl2wgsl/src/lib.rs:520`）
```rust
varyings: interfaces(&program.varyings, None),               // 现状：产品代码不读它，只有测试读
```

**e. 运行时才失败**：管线创建报 `Vertex output variable "<retval>.v_MotionRadian2_" has a location (16) that is too large`，`SceneRenderError`，整张退回预览图（`3243449890`，2026-11-13 屏外宿主强制渲染）。

## 步骤 0 — 调研（2026-11-14，已完成）

见 [rea-p7e-varying](rea-p7e-varying.md)：
- **读码**：`FUN_1400f52e0` 的长度公式、`main` 里三段 accessArray 文本只对 `float` / `vec2` / `int` / `uint` 生成、几何阶段同一公式。
- **确定性工程 `ignore/varying/proj/p-va`**：12 种情况的签名、画面与日志，全部和公式一致；常量越界、循环写过头都是 `X3504`，顶点回退、整块黑。
- **WPE 编译缓存**：`auto_sway` 的 32 个输出元素装进 12 个寄存器（含位置）。
- **示波器抓帧**：`TEXCOORD0`–`10`。

## 步骤 1 — 数组照 WPE 的长度

### 点 1 — WPE 的数组长度（`rewrite.rs`）
- **新增** `wpe_varying_array`：
```rust
/// varying 数组在 WPE 的 `VS_OUTPUT` 里的长度（rea-p7e-varying 第 1 条，`FUN_1400f52e0` `0x1400f53f0`–`0x1400f5434`）。
/// WPE 对所有类型都按「4 个标量一组」算长度（vec2 按 2 个），accessArray 与否走同一段：
/// - float / vec2（accessArray）：WPE 打包成 float4、容量刚好够，值与 GLSL 数组相同，这里保持原长度（布局只在超出上限时由打包处理）；
/// - vec3 / vec4 / ivec4 / uvec4：只剩 ceil(n / 4) 个元素；n · 分量数 ≤ 4（vec3 / vec4 / ivec4 / uvec4 的 n = 1）时没有方括号、退化成普通变量，
///   正文的 `a[0]` 就成了取分量（HLSL 模式按 fxc 截断赋值）；
/// - int / uint 数组（WPE 当 float4 插值再转回整数）、矩阵数组（WPE 每个元素只推进 1 个编号，推断与下一个成员重叠）：照报，语料 0 处。
/// 不在 WPE 类型表里的类型（ivec2 等）WPE 解析不了声明，这里保持现状。
fn wpe_varying_array(ty: &str, n: u32) -> Result<Option<u32>, String> {
    match ty {
        "vec3" | "vec4" | "ivec4" | "uvec4" => {
            let components = if ty == "vec3" { 3 } else { 4 };
            Ok((n * components > 4).then(|| n.div_ceil(4)))
        }
        "int" | "uint" => Err(format!("{ty} 数组 varying：WPE 按 float4 插值传递，没有实现（语料 0 处）")),
        _ if ty.starts_with("mat") => Err(format!("{ty} 数组 varying：WPE 的语义编号会重叠，没有实现（语料 0 处）")),
        _ => Ok(Some(n)),
    }
}
```
- **修改** `build` 收集 varying 时用它，两阶段比较也按换算后的长度：
```rust
let array = match decl.array {                                   // 新增
    Some(n) => wpe_varying_array(&decl.ty, n).map_err(fail)?,
    None => None,
};
// …
Some(existing) if existing.ty != decl.ty || existing.array != array => {   // 修改：比较换算后的
// …
varyings.push(InterfaceDecl { name: decl.name.clone(), ty: decl.ty.clone(), array, location: next_varying });  // 修改
next_varying += location_slots(&decl.ty, array);                  // 修改
```
  > 几何展开（绳）的 `out` 也经这里，WPE 的几何分组用同一公式（rea-p7e-varying 第 4 条），不另分支。

### 点 2 — 文档
- **修改** `src-tauri/wpesl2wgsl/README.md`「绑定布局」：varying 数组的长度规则、退化与照报的情形，链接 rea-p7e-varying。
- `rea-p7-shader.md`「仍未知」第 12 条已在写本计划时划掉（2026-11-14），指向 rea-p7e-varying。

### 点 3 — 单测（`rewrite.rs` / `lib.rs` 的测试）
- 长度表：vec3、vec4、ivec4 的 n = 1、2、4、5、32；float、vec2 不变；int / uint / mat 数组报错。
- 示波器形状（`vec4 a[32]` 写 0–7、`vec2`、两个 `vec3`）：location 0–10，WGSL 里 `array<vec4<f32>, 8>`。
- `vec4 a[1]` 退化：`a[0] = vec4(…)` 与读 `a[0].xyz` 的 WGSL 照 fxc（截断取 `.x`、标量铺满），先按步骤 1 的 WPE 实测定期望值。
- 常量越界（`vec4 a[4]` 写 `a[2]`）翻译失败，错误信息指向越界。

### 验收
- `cargo test`（`deno task test` 注入环境）全过。语料请求重放：
  - 动工前在当时的 HEAD 重录夹具（`kbp corpus scan --extra requests:ignore/p7/requests-p7e`），导出基线；
  - 改后只有示波器的键变化（`WPESL2WGSL_BASELINE_ALLOW` 列出），其余逐字节相同；
  - 重放的 `ok` 与夹具一致（示波器原来就「通过」，只是运行时失败）。
- WPE 实测补两种退化情况：给 `p-va` 加 `vec4 a[1]`、`vec3 a[1]`（写 `a[0]`、读 `a[0].xyz`），把常量越界的两种挪进单独的工程（我们翻译失败、整张退回，和 WPE 的黑块不同，语料 0 处，记作已知差异）。
- 画面：`p-va` 其余情况与示波器形状的新工程（`vec4 a[32]` 加三个 varying，超过 16 个）导入 dev 库，`render_scene` 和 WPE 抓帧逐像素比。改前示波器形状的工程在建管线时失败。
- 语料：3585875739 编译后示波器程序 11 个 location；屏外宿主强制渲染没有 WebGPU 校验错误。
- 示波器复制工程（只留挂它的图层与父链，照 [FINAL_CHECK](../FINAL_CHECK.md) 第 5 条）：频谱输入按 P11a 的探针接口喂 WPE 抓帧里读到的 `g_AudioSpectrum32*`，逐像素比；接口不够时退到双方静音。

## 步骤 2 — 超过 16 个时打包

### 点 1 — 打包布局（`rewrite.rs`）
- **新增**常量与布局：
```rust
/// WebGPU 缺省的 `maxInterStageShaderVariables`，每台设备都保证；设备不申请更高的上限（P7e 已定）。
const MAX_INTER_STAGE: u32 = 16;

/// 一个 varying（数组的一个元素、矩阵的一列）装进第 `slot` 个 vec4 的 `offset` 起的 `components` 个分量。
struct PackedPiece { name: String, element: Option<u32>, column: Option<u32>, components: u32, slot: u32, offset: u32 }

/// 步骤 1 换算后仍超过上限时，把浮点 varying 装进 vec4（fxc 的签名打包，rea-p7e-varying「和 WebGPU 上限的关系」）：
/// 按分量数从大到小（同大小按声明顺序）放进第一个放得下的 vec4，不拆开一个元素；整数 varying 不打包、各占自己的 location。
/// 不超过上限时返回 None，输出与原来逐字节相同；打包后仍超过时报错，场景在编译期报不支持。
fn pack_varyings(varyings: &[InterfaceDecl]) -> Result<Option<Vec<PackedPiece>>, String>;
```

### 点 2 — 生成（`render`）
- **修改**有打包时的顶点阶段：
```glsl
layout(location = 0) out vec4 kb_varying_0;         // 新增：打包后的输出
layout(location = 1) out vec4 kb_varying_1;
// …
float v_Len1;                                        // 修改：原来的 varying 改成私有全局，正文照常读写
vec2 v_Direction1;
// …（正文，作者的 main 改名 kb_main）
void kb_main() { … }
void main() {                                        // 新增：入口
    kb_main();
    kb_varying_0 = vec4(v_TexCoord);
    kb_varying_1 = vec4(v_Len1, v_Direction1, v_aspect);
    // …
}
```
- **修改**片元阶段：只为自己声明的 varying 所在的 vec4 声明输入，入口先拆包再调 `kb_main`：
```glsl
layout(location = 1) in vec4 kb_varying_1;
float v_Len1;
vec2 v_Direction1;
void main() {
    v_Len1 = kb_varying_1.x;
    v_Direction1 = kb_varying_1.yz;
    // …
    kb_main();
}
```
  > 改名用 `pack::main_signature` 定位作者的 `void main()`，放在 `pack::rewrite_head` 与 `hoist_runtime_consts` 之后（两者按原来的 `main` 切分正文），几何展开的程序不打包（它的 `main` 是生成的，varying 很少）。`kb_` 前缀是翻译器保留的。

### 点 3 — 反射与文档
- **修改** `varyings` 反射给实际的 WGSL 接口：打包时是 `kb_varying_<i>`（`vec4`）加未打包的整数 varying。产品代码不读它。
- **修改** README：「varying 超过 16 个时打包」一节，写明布局、入口包装与报错。

### 点 4 — 单测
- 16 个以内：输出与改前逐字节相同（`build` 层面断言，语料靠基线）。
- 31 个的 `auto_sway` 形状：11 个 vec4，各片段的位置与 WGSL 片段；顶点 `main` 里提前 `return` 时仍装箱；片元改写 varying、只在片元声明的 varying 照常。
- 打包后仍超过 16 个时报错。

### 验收
- 语料请求重放：只有 `auto_sway` 与示波器的键变化，其余逐字节相同；全部通过 naga 的 `wgsl-in` 重新校验；语料统计里没有程序超过 16。
- 确定性工程 `p-vpack`：`auto_sway` 形状的 31 个 varying，值来自插值的顶点属性（各不相同的线性函数），片元按 `v_TexCoord` 分成 31 格、每格显示一个 varying。导入 dev 库，和 WPE 抓帧逐像素比；改前建管线失败。
- 语料：4 张 `auto_sway` 场景强制渲染，没有 WebGPU 校验错误；`3492627662` 的 `auto_sway` 图层复制工程（照 FINAL_CHECK 第 5 条）按 WPE 帧时间回放逐像素比。
- 变异：
  - 打包不排序；
  - 拆包错位一个分量；
  - 不包装 `main`（顶点提前 `return` 时丢输出）；
  - 阈值改成 15 或 17；
  - 退化的 n = 1 仍按数组。

  单测或比图要能检出。

## 步骤 3 — 收尾
- `cocs/wpe/WPE_SCENE.md` 的着色器翻译器摘要补一句 varying 规则；回归文档、changelog 各一条；P7 总计划与 `PLAN.md` 的 P7 节记结果；实施记录。

## 实施方式

翻译器是 Rust（`src-tauri/wpesl2wgsl`），并行会话改得少，但宿主用的 wasm（`apps/wpe-scene/src/wpesl2wgsl/wpesl2wgsl.wasm`，不入库）是共用的：
- 子代理在独立工作树（HEAD 快照）里实现与跑 `cargo test`；
- 我验收后三方合并到工作区；
- 新 wasm 只在合并之后、问过你再拷进工作区，宿主同样问过再重建。

画面比较用 `kbp gen`（数据目录 `ignore/varying`）、wpe-renderdoc MCP 与 kabegame-dev MCP。

## 和其它节的交界
- **P11a**：3585875739 的音频键由 P11a 去掉，运行时能不能渲染要等 P7e 步骤 1。哪边先合并都不冲突（P7e 只改翻译器）。
- **P7 的回退规则**：常量越界等 WPE 编不过的写法，照「回退不用复刻」处理，翻译失败、照报。
- **探针 / `kbp corners`**：把顶点着色器改写成计算着色器时读的是输出结构，只有超过 16 个的程序会变，粒子着色器没有这种。

## 决定

**已定**（2026-11-14 用户，三条都按推荐）：
1. **打包的时机**：只在超过 16 个时打包，其余输出逐字节不变；不照 WPE 总把 `float` / `vec2` 数组打包成 vec4（那样 `blur_gaussian` 等 36 张的输出都会变，画面不变）。
2. **设备上限**：不申请更高的 `maxInterStageShaderVariables`，结果不随显卡变。
3. **语料 0 处的角落**（常量越界、矩阵数组、整数数组）：照报不支持，不复刻 WPE 的黑块回退。
4. **不分步**（2026-11-14 用户）：步骤 1–3 一次做完，中间不单独验收、不单独提交，最后按两步的验收项一起验、一次提交。

## 风险
1. **`main` 改名的连带**：正文里其它按 `main` 定位的改写（`pack::rewrite_head`、`hoist_runtime_consts`）必须在改名之前做完；作者的着色器若有别的函数叫 `kb_main`，报错（`kb_` 保留）。
2. **动态下标越界**：示波器的读取在范围内。WGSL 对越界的运行时下标做钳制，D3D 是未定义行为；语料没有越界的，不处理。
3. **插值精度**：打包不改插值方式（都是透视插值）。D3D 与 WebGPU 的插值在最后一位上可能不同，确定性工程按 8 位输出比较，`p-va` 现有的 10 种情况两边一致是旁证。
4. **退化的 n = 1**：靠 HLSL 模式的截断赋值复刻，没实测前期望值待定（步骤 1 先补 WPE 实测）。

## 实施记录

### 步骤 1–3（2026-11-14，一次做完）

**做法**：子代理在独立工作树 `ignore/p7e/wt`（HEAD `5889b490`，`third` 是指向主仓库的目录联接）里改翻译器，我验收后把 3 个文件拷回工作区（期间主工作区的翻译器没有别的改动，diff 逐字节相同）。另一个子代理并行造确定性工程、拿 WPE 真值（`ignore/p7e/wpe-REPORT.md`）。

**改动**（只有 `src-tauri/wpesl2wgsl` 的 `rewrite.rs`、`lib.rs`、`README.md`）：
- `wpe_varying_array`：照 WPE 的公式 `n·(t+1) > 4` 时 `[ceil(n/d)]`。
- `pack_varyings` / `packed_entry` / `rename_main`：超过 16 个时打包，作者 `main` 改名 `kb_main`。
- `Program.varyings` 给实际接口。
- 12 个新单测。

**和计划不同的地方**：
1. **`ivec4` / `uvec4` 的 `n = 1` 不退化**（`int4 X[1]`）。计划的函数按 4 个分量算，但 WPE 的公式用类型表下标 `t+1`（13 / 15），调研的表也是 `[1]`；照表。语料 0 处。
2. **几何展开的程序超过 16 个时报错**，不拖到建管线。语料 0 处。
3. **保留名只查 `kb_main` 与 `kb_varying_*`**：正文里本来就有翻译器自己生成的 `kb_FragColor`、`kb_sample` 等，不能对整个 `kb_` 前缀报错。认不出 `void main() {` 签名时也报错。
4. **整数 varying 接在 vec4 之后**按声明顺序分配；`pack_varyings` 返回 `Packing { pieces, slots, interface }`，先按分量数估下界、超过就直接报错。
5. **被顶点覆盖的片元声明不再检查长度**（WPE 的片元列表被共享列表覆盖），片元写 `varying int b[5]` 而顶点已声明 `b` 时不报整数数组。
6. **`n = 1` 的期望值改按 WPE 实测**（计划写的「`.xyz` 截断取 `.x`、标量铺满」与实测不符）：
   - 顶点 `a[0] = vecN(…)` 只写 `.x`（fxc X3206，DXBC `dcl_output o0.x`），片元 `a[0]` 读成标量、参与运算时铺满，和我们一致；
   - `a[0].xyz` 等多分量取法 WPE 是 X3018、把 `a[0]` 交给构造函数是 X3014，都是片元回退（暗红）。我们 `.xyz` 解析失败、`vec4(a[0], 1.0)` 校验失败，整张退回；`vec4(a[0])` 照 GLSL 铺满、能渲染。照「回退不用复刻」，语料 0 处。
7. **两个本来就不复刻的差异**（语料 0 处，写进 README）：
   - 循环写过缩短后的长度：WPE 是 fxc 展开循环后 X3504、顶点回退（整块黑），我们是动态下标、照常渲染。
   - 顶点 `main` 里的裸 `return;`：WPE 的 `main` 返回 `VS_OUTPUT`，编不过（X3080）；我们照 GLSL 执行，包装入口保证也装箱。
8. **几何段 `out` 声明 `vec3` / `vec4` 数组**：长度换算了，但展开生成的 `PS_INPUT` 仍按原长度，两边对不上、naga 报错。语料与 WPE 自带着色器 0 处，没有另做，README 写明。

**验收**（我自己重跑）：
- **翻译器**：
  - `cargo test -p wpesl2wgsl` lib 94 个（新增 12 个）全过；WPE 安装目录 161/167、几何门槛 27/27 不变，WGSL 回读失败 0。
  - 请求夹具在 `5889b490` 重录（`ignore/p7/requests-p7e`，921 个请求），基线导出 `ignore/p7/baseline/p7e-5889b490`（4484 个文件）。改后相同 4460、变了 24、新通过 0、新失败 0；夹具 `ok` 与记录全部一致。
  - 变了的只有示波器 1 个请求（35 → 11 个 location，不打包）与 `auto_sway` 5 个请求（打包：31 / 31 / 31 / 24 / 17 → 11 / 11 / 11 / 9 / 6）。`auto_sway` 的 5 个请求改前都超过 16，没有「16 个以内应当不变」的那种。
  - Tint：变了的 12 份 WGSL 在 dev 应用里 0 error 0 warning，location 最大 10。
- **变异**（`ignore/p7e/mutate_rs.py`，按原字节还原、核对哈希）：8 处全部被单测检出。
  - 打包不排序、拆包错位一个分量、顶点先装箱再跑作者代码；
  - 阈值 15、阈值 17；
  - `n = 1` 仍按数组、数组不缩短、片元声明全部 vec4。
- **语料**：
  - 同一份产品源码（`82653a66`）配新旧 wasm 各扫一次，183 张逐张相同（干净 87），一张不解锁，和计划一致。
  - `ignore/p8/s4/varyings.test.ts` 统计：改前超过 16 的 5 张（31 / 31·24·17 / 31·31 / 24 / 35），改后没有程序超过 16，最多 13（`blur_gaussian`）。
  - 中途 HEAD 被别的会话推进过：头一次拿 HEAD 导出的快照扫，结果混进了相机对象的提交（18 张少了 `object:camera` 等键）。所以改用固定提交的两份快照比。
- **确定性工程**（1920×1080，`render_scene` 的 `canvas` 与 WPE 抓帧逐格比，`ignore/p7e/cmp_p7e.py`）：
  - `p7e-va-ok`（`p7e-va` 去掉我们翻译失败的三种，用 `p7e-va` 的 WPE 抓帧当真值）：我们能翻译、WPE 也编得过的 14 种全部差 0，含改前建管线失败的 `v4n32` 与 `n = 1` 的 `vec` / `.x` 两种读法。不同的 4 格都是预期的：去掉的 3 种，以及 `v4n1ctor`（WPE 编不过回退暗红，我们铺满）。
  - `p7e-osc`（示波器形状，35 → 11 个 location）：36 格全部一致，全图最大差 0。改前建管线失败。
  - `p7e-vpack`（`auto_sway` 形状，31 → 11 个 location）：`vpack_noret` 32 格全部一致。`vpack_ret` 在 WPE 里编不过（X3080），和解析式比 32 格差 ≤ 1，证明提前返回时也装了箱。改前建管线失败。
  - `p7e-oob`：常量越界那层翻译失败，整张退回（`render:no-program`），预期的已知差异。
- **语料场景强制渲染**（屏外宿主，新 wasm）：3243449890、3492627662、3516174947、3585875739 都渲染成功，日志里不再有「location 超限」。
  - 3486806915 在加载前的自查里报 `render:texture-missing:1`：第 1 号纹理是 `materials/鸟_00020.tex`（7680×7920 的多图纹理动画，不支持项 `tex:animation:multi-image`），没有 mip，和 varying 无关。
  - 3585875739 的不支持项已经是空的（P11a 去掉了音频键），P7e 之后它在运行时真正能画。
- **共享 wasm**（2026-11-14 用户：直接合并代码重建）：工作区编出的 wasm 与验收用的 `ignore/p7e/wasm/p7e.wasm` 逐字节相同（`8c04986a…`），已拷进 `bin/wasm` 与场景宿主、dev 宿主已重建。
- **真实着色器对照**（复制工程 `kbp content isolate`，按 WPE 帧时间回放逐 pass 比；报告 `ignore/p7e/iso-REPORT.md`）：
  - **`auto_sway`**（3492627662 的「前景2 / 3 / 4」三个图层 × 4 帧）：基础 pass 0 差；`auto_sway` pass 最大差 1，差 > 2 的像素为 0。按 WPE 的 `vs_out`（31 个 varying 装进 11 个寄存器）复算采样坐标，我们和 WPE 不同的像素都在纹素过滤量化边界附近，两边 uv 只差约 1e-6，是 sin / cos 的 float32 求值差；varying 只要错一个分量，uv 就会差到纹素级以上。整帧上屏的差是已登记的「先按场景分辨率画再缩」。
  - **示波器**（3585875739）：WPE 的 `TEXCOORD0`–`10` 与我们的 location 0–10 一一对应。喂 WPE 抓帧录到的频谱时，示波器 pass 改动区域的交并比 0.978–0.997，差异在波形线陡峭的边缘。静态底图变体里底图、色差、pulse 三个 pass 四帧逐像素 0 差。
  - **另发现的问题（与 P7e 无关，没改）**：静音时示波器的线宽为 0，代码成了 `smoothstep(+0, 0.0, dist)`。fxc 把 `0.0 - low` 化简成 `-low`，`1/(-0) = -inf`，结果 0、WPE 画面不变；我们用 WGSL 内置函数得 `+inf`，结果 1，整张提亮约 39%。WPE 反汇编与我们的 WGSL 对上了，闭式公式只在 `dist = 0` 的圆环上和我们的输出差 1 以上，印证这个机制。用户定为当场修，见下面「收尾：上界是字面量 0 的 smoothstep」。
- **宿主测试**：同一份产品源码（`82653a66`）配新旧 wasm 各跑一遍全部 vitest（带 `KABEGAME_WPE_ROOT`），708 个文件、3047 个用例结果完全相同（失败 0）。
- **格式化**（2026-11-14 用户：rustfmt 改了就改了）：`cargo fmt -p wpesl2wgsl` 连带 `naga_stage.rs` 原有的 4 行。格式化后语料输出与验收时逐字节相同（4484 个文件变了 0），单测 94 个全过。wasm 因 panic 信息里的行号变成 `4917633d…`，已重新拷进 `bin/wasm` 与场景宿主。重建宿主时 vite 清空输出目录报 EBUSY（目录被占用），改用 `--emptyOutDir false` 重建；示波器工程渲染的像素摘要与之前相同。
- **清理**：dev 库里的测试行（14527–14531、14539、14541、14542、14544）用 `projects_remove` 移除，库里不再有 `ignore\p7e` 下的行。独立工作树先单独删 `third` 联接再移除，主仓库 `third` 完好。`target-p7e`（翻译器的独立构建目录）保留。

### 收尾：上界是字面量 0 的 smoothstep（2026-11-14，用户：现在修）

**问题**：真实着色器对照时发现，与 varying 无关。fxc 把内建 `smoothstep(lo, hi, x)` 展开成 `saturate((x - lo) * (1 / (hi - lo)))`，上界是常量 0 时把 `0.0 - lo` 化成 `-lo`。下界为 +0 时分母是 -0、倒数 -inf，结果与照 IEEE 算的相反。示波器开了 `AUDIOTHICKNESS`，没有声音时线宽为 0，WPE 什么都不画，我们整张提亮约 39%。

**语料**（`ignore/p7e/ss_scan.py` 扫 921 个请求的原文）：`smoothstep` 上界是字面量 0 的 57 处、去重 18 种写法。下界是非零字面量的（`0.2`、`1`、`-0.3` 等）`0.0 - lo` 与 `-lo` 完全相等，不受影响。会改写的是下界为运行期值的 5 种：示波器 `thickness * 0.015`、vhs `0.01 * g_DistortionWidth`、swing `feather` / `-feather`、流体 advection `size`。

**改动**（`rewrite.rs`、`naga_stage.rs`、`lib.rs`、README）：
- `rewrite_zero_edge_smoothstep`：上界是字面量 +0、下界不是数字字面量的调用改成 `kb_smoothstep0(lo, x)`，参数里嵌套的一并改写；不改写的原样拼回（函数名后的空白也留着）。
- `SMOOTHSTEP0_HELPERS`：照 fxc 的 `(x - lo) * (1 / -lo)` 算，分母为 ±0 时不靠无穷大、按 `floatBitsToUint` 取下界的符号直接得 0 / 1。有 float、vec2–4 四个重载，在 `INTRINSIC_WRAPPERS` 里登记，标量下界配向量 `x` 时铺满。
- 单测 3 个：改写规则、字面量判定、端到端翻译与重载选择。lib 共 97 个全过。

**验证**：
- **语料基线**（对 `dump-fmt`）：相同 4460、变了 24，正好是上面那些着色器的 12 个片元程序（含 WPE 安装目录里的 swing、vhs、advection 原件），各 GLSL / WGSL 两个文件。`ok` 与夹具全部一致，12 份 WGSL 过 Tint 0 error 0 warning。
- **语料与宿主测试**：同一份产品源码（`82653a66`）配这版 wasm，语料 183 张与改前逐张相同；宿主 vitest 3047 个用例结果与改前完全相同。
- **确定性工程 `p7e-ss0`**（`ignore/p7e/gen_ss0.py`，抓帧 `A:\p7e\p7e-ss0\`，1600×900，`ignore/p7e/cmp_ss0.py`）：
  - 下界 +0、-0、整数上界 0、标量下界配向量 x 四种，图层内最大差 0；
  - 非零下界与字面量对照两种渐变，最大差 1；
  - 差 > 2 的只在图层边缘的 1 像素线上，是已知的「先按场景分辨率画再缩」。
- **示波器复制工程**（静态底图、静音，按 WPE 帧时间回放）：
  - 示波器 pass 与 shake pass 四帧 0 差（每帧 829 万个像素）；
  - 整帧平均差 78.1 → 0.88，剩下的是上屏缩放。
- **变异**（`ignore/p7e/mutate_ss0.py`）：6 / 6 被单测检出。
  - `-0.0` 也算 0、下界是字面量也改写、参数里嵌套的不改写；
  - 不登记为内置包装、不补辅助函数、不保留函数名后的空白。
  - 辅助函数本身的取值由上面的画面对照守着。
- **共享 wasm**：`8bf20b6b…`，已拷进 `bin/wasm` 与场景宿主，dev 宿主已重建。
