# P7f — 片元读顶点的 varying 与 `gl_Position`（照 WPE 的共享 `VS_OUTPUT`）

起因：工坊 effect「Silk」（`workshop/3649458761/effects/silk`，壁纸 3823412318 的四个对象都挂着）在我们这里报
`shader:workshop/3649458761/effects/silk:parse:Unknown variable: v_TexCoord`，整张退回预览图；WPE 照常画。

## 总体设计思路

WPE 的两阶段只有一份 `VS_OUTPUT`：片元自己写的 varying 声明整体作废、换成顶点的列表，列表末尾还有 `gl_Position : SV_POSITION`，
片元正文里这些名字都换成 `IN.<名字>`（rea-p7-shader §2.6 第 1、2 条，§4「标识符替换」）。所以作者可以：
- 片元不声明、直接读顶点声明的 varying（Silk 的 `v_TexCoord`）；
- 片元读 `gl_Position`，得到 `SV_POSITION`，即当前渲染目标里的像素坐标（Silk 拿它除以 `g_Screen` 当屏幕 UV）。

P7c 已经照这一条做了「两阶段都声明时片元按顶点的类型」，没做「片元没声明也有」，也没给片元的 `gl_Position`。本步补上这两半，都在改写阶段
（`rewrite.rs`）：
1. 片元声明的 varying = 自己声明的 ∪ 正文里用到名字的顶点 varying。只补用到的：没用到就不声明，现有着色器的输出逐字节不变；
   打包时同一份集合决定拆哪些片段。
2. 片元正文里的 `gl_Position` 换成 `kb_PsPosition`，用到时在声明区加一行宏
   `#define kb_PsPosition vec4(gl_FragCoord.xyz, 1.0 / gl_FragCoord.w)`。xy（左上原点、像素中心）与 z（深度）两边相同；
   w 不同：D3D 像素着色器的 `SV_Position.w` 是裁剪空间的 w（DXC 的 `-fvk-use-dx-position-w` 就是为此取倒数），
   WebGPU 的 `position.w` 是插值后的 1/w（WebGPU 规范 `perspectiveDivisor`），所以取一次倒数。

关键决策：
- **只补用到的**而不是全部顶点 varying：全部补也合法，但会改动所有片元的输出，回归基线全变；按用到的补，变化只落在原来编不过的着色器上。
- **宏而不是私有全局**：私有全局要在 `main` 开头赋值，打包、`kb_main` 改名、全局 const 现算都要跟着协调；宏只读、零协调。
  代价是片元**写** `gl_Position` 会编不过（宏展开后不是左值），WPE 里 `IN` 按值传入、可写。语料里还没有这种写法，照报（naga 报错 → 不支持）。
- **比 WPE 宽的地方不照抄**：WPE 只替换 `main` 签名之后的文本，`main` 之前的辅助函数里直接读 varying / `gl_Position` 在 WPE 编不过（推断，§4 第 5 条）；
  我们是全局声明，辅助函数也读得到。按「语料依赖的 WPE 缺陷才复现」不照做，记为有意不同。

## 现状锚点

**a. 片元只声明自己写过的 varying**（`rewrite.rs` `render`，约 1161–1201 行）
```rust
let declared: Vec<&str> = parts
    .decls
    .iter()
    .map(|(decl, _)| decl.name.as_str())   // 现状：只有本阶段自己的声明
    .collect();
...
// 顶点阶段输出全部 varying（包括只在片元阶段声明的），片元阶段只声明自己用的
let used = |name: &str| stage == Stage::Vertex || declared.contains(&name);
match packing {
    None => { for varying in varyings.iter().filter(|v| used(&v.name)) { out.push_str(&interface_line(varying)); } }
    Some(packing) => { /* 同样按 used 挑 vec4 槽与私有全局 */ }
}
...
if let Some(packing) = packing {
    out.push_str(&packed_entry(stage, packing, &declared));   // 现状：片元按 declared 拆包
}
```

**b. 片元的 `gl_Position` 没有处理**（`rewrite_identifiers`，约 1528 行）
```rust
let replaced = match ident {
    "gl_FragColor" if stage == Stage::Fragment => "kb_FragColor".to_string(),
    "gl_VertexID" => "gl_VertexIndex".to_string(),
    "gl_InstanceID" => "gl_InstanceIndex".to_string(),
    // 现状：片元里的 gl_Position 原样交给 naga → validate 报
    // `Built-in Position { invariant: false } is not available at this stage`
    ...
};
```

**c. WPE 实测**（`A:\silk\wpe\silk-frame222.rdc`，1280×540，event 73 是背景图层的 Silk pass）：像素着色器是 Silk 本体（不是暗红回退），
`dcl_input_ps linear v0.xy`（`v_TexCoord`，片元没声明）、`dcl_input_ps_siv linear noperspective v1.xy, position`（`gl_Position`），
`div r1.xy, v1.xyxx, g_Screen.xyxx`；`g_Screen = (1280, 540, 2.37)`。画面 `A:\silk\wpe\ev73-after-silk.png`。

## 点 1 — 片元补上用到的顶点 varying（`rewrite.rs` `render`）

- **修改** `declared`：片元阶段并入「正文里出现、在 `varyings` 里、本阶段没声明」的名字。
```rust
// 片元可见的 varying = 自己声明的 ∪ 正文用到的顶点 varying（新增）：WPE 的片元列表整体换成顶点那份（rea-p7-shader §2.6），
// 片元不声明也读得到。只补用到的，原来能翻译的着色器输出不变
let referenced = if stage == Stage::Fragment { identifiers(&body) } else { BTreeSet::new() };
let declared: Vec<&str> = parts
    .decls
    .iter()
    .map(|(decl, _)| decl.name.as_str())
    .chain(
        varyings
            .iter()
            .filter(|v| referenced.contains(&v.name))
            .map(|v| v.name.as_str()),
    )
    .collect();   // 重复无妨，只用于 contains
```
- `used`、打包分支、`packed_entry` 都沿用这份 `declared`，不另改。
- **修改** 注释「片元阶段只声明自己用的」改成「片元阶段声明自己声明的与正文用到的」。

## 点 2 — 片元的 `gl_Position`（`rewrite.rs`）

- **修改** `rewrite_identifiers`：
```rust
"gl_FragColor" if stage == Stage::Fragment => "kb_FragColor".to_string(),
// 新增：WPE 的共享列表末尾是 `gl_Position : SV_POSITION`，片元读到像素坐标（rea-p7-shader §2.6）
"gl_Position" if stage == Stage::Fragment => "kb_PsPosition".to_string(),
```
- **新增** `render` 里片元正文用到 `kb_PsPosition` 时，在 varying 声明之后、正文之前输出：
```rust
/// 片元的 `gl_Position`（WPE 的 `SV_POSITION`）。xy、z 同 `gl_FragCoord`；w 在 D3D 是裁剪空间的 w，WebGPU 是 1/w，取倒数
const PS_POSITION_MACRO: &str = "#define kb_PsPosition vec4(gl_FragCoord.xyz, 1.0 / gl_FragCoord.w)\n";
```
- 片元写 `gl_Position` 编不过（宏不是左值），照报。

## 点 3 — 单测（`rewrite.rs` 的 `tests`，端到端放 `lib.rs` 的 `tests`）

改写层：
- 顶点声明 `v_X`、片元不声明但读它：片元 GLSL 有 `layout(location = 0) in vec2 v_X;`。
- 顶点声明 `v_X`、`v_Y`，片元只读 `v_X`：片元不声明 `v_Y`。
- 片元读 `gl_Position`：片元 GLSL 有宏行、正文是 `kb_PsPosition`；不读时没有宏行。顶点的 `gl_Position` 不受影响。
- 打包（> 16 个 location，复用现有打包用例的写法）：片元不声明、只读某个顶点 varying，拆包语句里有它、没读的没有。

端到端（经 naga 到 WGSL，`translate` 的请求形态同现有用例）：
- Silk 同形的最小对（顶点 `varying vec2 v_TexCoord`；片元不声明，读 `v_TexCoord` 与 `gl_Position.xy / g_Screen.xy`）：`ok`，
  片元 WGSL 入口有 `@builtin(position)` 与 `@location(0)` 输入；反射 `varyings` 仍只有 `v_TexCoord`。
- 片元写 `gl_Position = …`：报错（不支持，记录用）。

不把工坊原文放进仓库：用例都是自写的最小着色器。

## 点 4 — 文档（`src-tauri/wpesl2wgsl/README.md`）

- 「内部流程 → 改写 → 声明」：「两阶段都声明、类型不同……」之后加一条「片元不声明、正文用到的顶点 varying 也声明（按顶点的类型）」。
- 「内建」一条补 `gl_Position`（片元）→ `kb_PsPosition` 与宏、w 的倒数、写入不支持。
- 「HLSL 隐式转换 → 改写阶段」的「片元的 varying 按顶点的类型声明」补「片元不声明也读得到」，并写明 `main` 之前的辅助函数在 WPE 编不过、我们读得到（有意不同）。
- 「测试」末尾加本步的回归结果（验收时由验收方填数字）。

## 验证（验收方做）

- `cargo test -p wpesl2wgsl --lib`；变异：去掉点 1 的并入、去掉点 2 的换名、宏里 w 不取倒数（宏行断言要能抓到）。
- 请求夹具：改动前在 HEAD 录全语料（`ignore/silk/requests`）、导出基线（`ignore/silk/baseline/head-af726345`），改后对它：
  只允许原来失败的请求变成通过（Silk 及其拷贝），相同的逐字节相同、变了 0、新失败 0。
- 重编 wasm、拷进前端、重建 dev 宿主；`kbp corpus scan` 前后 `corpus diff`，看 3823412318 与别的场景的不支持项变化。
- 真机：3823412318 的预览不再退回，与 WPE 抓帧（`A:\silk\wpe\`）同窗口尺寸对照 Silk 的色调。

## 实施记录（2026-11-20）

- **实现**：sonnet 执行代理在主树里按点 1–4 改 `rewrite.rs`（`PS_POSITION_MACRO`、`render` 的 `referenced` / `declared`、`rewrite_identifiers` 的片元 `gl_Position`）、
  `lib.rs`（2 个端到端用例）、`README.md`；`rewrite.rs` 新增 4 个改写层用例。工作树 `ignore/p6/d1/wt` 不能跑 cargo（工作区的 `[patch.crates-io]` 指向空的 `third/*`），
  翻译器目录又没有别的会话在改，所以直接在主树改，基线先导出、再动源码。
- **单测**：`cargo test -p wpesl2wgsl --lib` 120 个全过（改前 114）。
- **变异**（`ignore/silk/mutate/mutate.py`，按原字节还原）：片元不并入用到的顶点 varying（4 个用例失败）、片元不换 `gl_Position`（2）、宏的 w 不取倒数（1）、不输出宏（2），4 / 4 检出。
- **请求夹具**：`f05e75e9`（翻译器源码同 `af726345`）上 `kbp corpus scan --extra requests:` 录全语料 233 张（1358 个请求）加 myprojects `3823412318`（23 个，新增 11 个）共 1369 个；
  基线 `ignore/silk/baseline/head-f05e75e9` 6280 个文件。改后相同 6280、变了 0、新失败 0，新通过 4 个文件（Silk `50bc303d`，在 ALLOW 里）；夹具通过 1358 → 1359，
  `ok` 与夹具全部一致；WPE 安装目录 166/167、几何门槛 27/27、WGSL 回读失败 0 不变。夹具里片元源码提到 `gl_Position` 的只有 Silk（只读）。
- **wasm**：HEAD 重编的与前端原有的逐字节相同（`ignore/silk/wasm-head-af726345.wasm`）；改后重编拷进 `apps/wpe-scene/src/wpesl2wgsl/`，前端胶水 vitest 3 个通过，dev 宿主重建（`index-D9foXPFy.js`）。
- **语料**：全语料 233 张前后都干净、0 变化（`ignore/silk/out/corpus-diff.txt`）；`3823412318` 由 `shader:…/silk:parse:Unknown variable: v_TexCoord` 变干净。
- **WPE 对照**（`A:\silk\wpe\silk-frame222.rdc`，1280×540，WPE 后处理 ultra）：event 73 的像素着色器是 Silk 本体，`v0.xy` 是没声明的 `v_TexCoord`、`v1.xy, position` 是 `gl_Position`。
  dev 探针 `render_scene`（canvas 1280×540、`g_Time` 13.51435、postprocess ultra）对 WPE 上屏帧（`Present(2230)`），挖掉顶部中间的文字（探针不跑脚本，文字停在初值）后：
  差 ≤ 1 的 98.86%，p99 = 2，平均 0.40，三通道均值相差 ≤ 0.03；更大的差是随机的雨滴粒子。
- **myprojects**（`ignore/silk/scan_myprojects.py`，同一份产品源码配新旧 wasm）：210 张，干净 206 → 207，只多 `3823412318`，没有变坏的；出错的 1 张（`3838255453`，缺 `scene.json`）前后相同。
- **未做**：预览与桌面的真机观感（回归 S6，待用户）。
