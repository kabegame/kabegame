//! Wallpaper Engine 着色器语言（WPESL）→ WGSL。
//!
//! 输入一个材质 pass 的顶点 / 片元源码原文（WPE 的 `shaders/*.vert|frag`）、它们 `#include` 的头文件、
//! COMBO 取值与绑定的纹理，crate 内部完成全部处理：
//! 1. 注释元数据：`// [COMBO]` 声明与采样器注释（`combo` / `formatcombo`），定出宏表；
//! 2. 预处理（[`preprocess`]）：`#include` 展开、条件编译求值；
//! 3. 请求带几何着色器时（[`geometry`]）：把顶点段的 GS 分支与几何段拼成一个顶点着色器；
//! 4. 改写（[`rewrite`]）：方言 → Vulkan GLSL 450（uniform 块、纹理 / 采样器拆分、location、内建换名）；
//! 5. naga：解析、按 WebGPU 基线校验、输出 WGSL，并读出 uniform 块布局。
//!
//! 头文件按需提供：缺了的会在结果里列出（`phase: "include"`、`missing`），调用方读到后带上重试。
//!
//! 编成 wasm（`deno task build:wpesl2wgsl` → `bin/wasm/wpesl2wgsl/`）给前端渲染器用，不链进应用。
//! 导出 C ABI，不依赖 wasm-bindgen：[`wpesl_alloc`] / [`wpesl_free`] 管理 wasm 内存，[`wpesl_translate`]
//! 接一段 UTF-8 JSON 请求（[`TranslateRequest`]），返回结果缓冲区：前 4 字节是小端 `u32` 长度，其后是 JSON
//! 结果（[`TranslateResult`]），用 `wpesl_free(ptr, 4 + len)` 释放。wasm 用 `panic = "abort"` 构建，panic 会让
//! 实例 trap，前端胶水遇到 trap 会丢弃实例重建。

use std::alloc::{alloc, dealloc, Layout};
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod geometry;
mod library;
mod naga_stage;
mod pack;
pub mod preprocess;
pub mod rewrite;

use preprocess::{scan_annotations, Annotations, Preprocessor};

/// 平台宏：照 WPE 的源码前缀与预处理器种子（2.8.42 `FUN_1400d5070`、`FUN_14016b0e0`）。
/// - `HLSL`：`#ifdef HLSL` 块里是 D3D 坐标约定下的 Y 翻转，WebGPU 的纹理 / 帧缓冲坐标与 D3D 相同；
/// - `HLSL_SM40`、`SHADERVERSION`：WPE 恒定义。
///
/// `GS_ENABLED` WPE 也恒定义，这里只在请求带几何着色器时定义（[`GS_DEFINE`]，三段都定义）：WebGPU 没有几何着色器，
/// 不带几何段时粒子走顶点着色器自己展开四角的分支（`genericparticle` 的非 GS 分支与 GS 路径几何相同）；
/// 带几何段时由 [`geometry`] 把 GS 分支与几何着色器拼成一个顶点着色器（`genericropeparticle` 的非 GS 分支与 GS 路径不同）。
/// `REVERSEDEPTH` WPE 恒定义，这里不定义：深度不是反向的。
/// `HLSL_GS40_DISABLED` 不能定义：WPE 没有这个宏，`shimmering_particles` 的 `particle.vert` 定义后走给几何着色器准备输入的分支，顶点不经过 MVP。
const PLATFORM_DEFINES: &[(&str, &str)] =
    &[("HLSL", "1"), ("HLSL_SM40", "1"), ("SHADERVERSION", "69")];

/// 请求带几何着色器时加进宏表（排在平台宏之后、COMBO 之前）。
const GS_DEFINE: (&str, &str) = ("GS_ENABLED", "1");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Vertex,
    Fragment,
    /// 几何着色器（请求带 `geometry` 时）：只用于报错定位。几何段与顶点段拼成一个顶点着色器（[`geometry`]），
    /// 之后的改写与 naga 编译都按顶点阶段走。
    Geometry,
}

/// 一次翻译请求（一个材质 pass 的着色器对）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    pub vertex: String,
    pub fragment: String,
    /// 几何着色器（`.geom`）原文。给了就定义 `GS_ENABLED`，把顶点着色器的 GS 分支与几何着色器拼成一个顶点着色器：
    /// 每次几何着色器调用是一个实例，`vertex_index` 是第几个输出顶点，拓扑三角形带（见 [`geometry`]）。
    #[serde(default)]
    pub geometry: Option<String>,
    /// 头文件源码，键为 `#include` 里写的名字（相对 `shaders/` 根，如 `common.h`、`base/model_vertex_v1.h`）。
    #[serde(default)]
    pub includes: BTreeMap<String, String>,
    /// 材质 / effect 指定的 COMBO（名字不分大小写，按大写处理；值可为数字或布尔）。
    #[serde(default)]
    pub combos: BTreeMap<String, Value>,
    /// 已绑定的纹理槽位：决定采样器注释里的 `combo` 是否置 1，以及 `TEX<n>FORMAT` 宏。
    #[serde(default)]
    pub textures: Vec<BoundTexture>,
    /// 额外的宏（最后应用，可覆盖平台宏与 COMBO）。
    #[serde(default)]
    pub defines: BTreeMap<String, String>,
    /// 只在最终 `LIGHTING` 非 0 时生效的宏：`LIGHTS_*`（WPE 只在这时写它们，`FUN_1401a5c40`）与光照路径要的 `HDR`。
    /// 材质默认开光照的情况调用方翻译前不知道，所以由这里按最终取值裁决。
    #[serde(default, rename = "litDefines")]
    pub lit_defines: BTreeMap<String, String>,
    /// 成功时也带上生成的 GLSL 450，便于排查。
    #[serde(default)]
    pub debug: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BoundTexture {
    pub slot: u32,
    /// `.tex` 的格式枚举（0 RGBA8888、4 DXT5、8 RG88、9 R8……），即 WPE 的 `TEX<n>FORMAT`。
    #[serde(default)]
    pub format: Option<u32>,
}

/// 翻译结果。成功时带两段 WGSL 与反射；失败时带出错阶段、所在着色器与诊断。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertex: Option<StageOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<StageOutput>,
    /// uniform 块（group 0 / binding 0，两阶段共用一块缓冲）的成员布局。两阶段同名、取值来源不同的 uniform
    /// 各占一格（见 `rewrite::merge_uniforms`）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub uniforms: Vec<Uniform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uniform_block_size: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub textures: Vec<Texture>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<Interface>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub varyings: Vec<Interface>,
    /// 最终生效的 COMBO 取值。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub combos: Vec<Combo>,
    /// 请求带几何着色器且翻译成功时才有：渲染器把全部顶点属性按实例步进（每次几何着色器调用一个实例），
    /// 每个实例画 `maxVertices` 个顶点、拓扑三角形带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry: Option<GeometryInfo>,
    /// 失败阶段：`request` / `include` / `require` / `preprocess` / `rewrite` / `parse` / `validate` / `write`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<Diagnostic>,
    /// `phase: "include"` 时缺少的头文件。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// `phase: "require"` 时展开不了的库：未知的名字，或要阴影 / cookie 的 `LightingV1/shadow`。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wgsl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_point: Option<String>,
    /// 生成的 GLSL 450：失败时总是带上（诊断的行号指向它），成功时只在 `debug` 下带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glsl: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Uniform {
    pub name: String,
    /// 块里实际的 WGSL 类型。标量 / 二三分量向量的数组会被补成四分量向量数组（`array<vec4<f32>, N>`），
    /// 布局与 std140 相同：第 i 个元素在 `offset + i * stride`，只用前几个分量（见 `declared`）。
    #[serde(rename = "type")]
    pub ty: String,
    /// WPESL 里声明的类型（`float`、`vec3`、`mat4`……）。
    pub declared: String,
    pub offset: u32,
    pub size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub array: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stride: Option<u32>,
    /// 声明行尾的 JSON（`material` 名、`default`、`range` 等）；引擎内建的 `g_*` 没有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// 两阶段同名、取值来源不同而拆成两格时，这一格只给哪个阶段用；两半各标自己的阶段，合并的没有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
    /// 拆分后改了名的那一格（`kb_vs_<名字>` / `kb_fs_<名字>`）：着色器里写的原名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    /// 两个阶段入口可达的代码都没读这一格（naga IR 里没有语句用到对 uniform 块这个成员的 `AccessIndex`，见
    /// `naga_stage::read_members`）；拆开的两半（带 `stage`）只看自己的阶段，几何段拼进顶点段后按顶点算。
    /// WPE 只认反射里被使用的 uniform：没被使用的不进常量缓冲、不分配材质常量槽位，两阶段同键时合并类型取读到它的阶段
    /// （vector-constant-REPORT 2.1，p7-REPORT「P7d 的实测」）。为假时不输出，字段缺失当被读。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Texture {
    pub slot: u32,
    pub name: String,
    pub kind: &'static str,
    pub binding: u32,
    pub sampler_binding: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Interface {
    pub name: String,
    pub location: u32,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub array: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryInfo {
    /// `[maxvertexcount(…)]` 按最终宏表求出的常量（`genericropeparticle` 是 `4 + 2·TRAILSUBDIVISION`）。
    pub max_vertices: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Combo {
    pub name: String,
    pub value: i64,
    /// 取值来源：`default`（`// [COMBO]` 声明）/ `texture`（绑定了带 `combo` 注释的纹理）/ `request`。
    pub source: &'static str,
}

/// 一条诊断：`file` 为头文件名或 `<vertex>` / `<fragment>`；没有 `file` 时行号指向生成的 GLSL。
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

impl Diagnostic {
    fn at(message: String, location: Option<naga::SourceLocation>) -> Self {
        Self {
            message,
            file: None,
            line: location.map(|loc| loc.line_number),
            column: location.map(|loc| loc.line_position),
        }
    }
}

impl TranslateResult {
    fn failure(phase: &'static str, stage: Option<Stage>, errors: Vec<Diagnostic>) -> Self {
        Self {
            ok: false,
            phase: Some(phase),
            stage,
            errors,
            ..Self::default()
        }
    }

    fn request_error(message: String) -> Self {
        Self::failure(
            "request",
            None,
            vec![Diagnostic {
                message,
                file: None,
                line: None,
                column: None,
            }],
        )
    }
}

/// 翻译一个着色器对。
pub fn translate(request: &TranslateRequest) -> TranslateResult {
    // 1. 注释元数据：不看条件分支，扫描两段源码与可达的头文件
    let mut annotations = Annotations::default();
    scan_annotations(&request.vertex, &mut annotations);
    scan_annotations(&request.fragment, &mut annotations);
    if let Some(geometry) = &request.geometry {
        scan_annotations(geometry, &mut annotations);
    }
    let mut visited = BTreeSet::new();
    let mut cursor = 0;
    while cursor < annotations.includes.len() {
        let name = annotations.includes[cursor].clone();
        cursor += 1;
        if visited.insert(name.clone()) {
            if let Some(source) = request.includes.get(&name) {
                scan_annotations(source, &mut annotations);
            }
        }
    }

    // 2. 宏表：平台宏 < COMBO（声明默认 < 纹理推导 < 请求）< 纹理格式 < 请求的额外宏
    let combos = match resolve_combos(request, &annotations) {
        Ok(combos) => combos,
        Err(message) => return TranslateResult::request_error(message),
    };
    let mut defines: BTreeMap<String, String> = PLATFORM_DEFINES
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if request.geometry.is_some() {
        defines.insert(GS_DEFINE.0.to_string(), GS_DEFINE.1.to_string());
    }
    for combo in &combos {
        defines.insert(combo.name.clone(), combo.value.to_string());
    }
    for texture in &request.textures {
        // WPE 只给声明了 `formatcombo` 的槽位定义，没声明的在 `#if` 里按 0（法线图走 `normal.wy`，不走 DXT 分支）
        let declared = annotations.samplers.iter().any(|(slot, meta)| {
            *slot == texture.slot && meta.get("formatcombo").and_then(Value::as_bool) == Some(true)
        });
        if !declared {
            continue;
        }
        if let Some(format) = texture.format {
            defines.insert(format!("TEX{}FORMAT", texture.slot), format.to_string());
        }
    }
    defines.extend(request.defines.clone());
    if defines.get("LIGHTING").is_some_and(|value| value != "0") {
        defines.extend(request.lit_defines.clone());
    }

    // 3. 预处理两段
    let mut stages = Vec::with_capacity(2);
    for (stage, file, source) in [
        (Stage::Vertex, "<vertex>", &request.vertex),
        (Stage::Fragment, "<fragment>", &request.fragment),
    ] {
        let mut pp = Preprocessor::new(&request.includes, &defines);
        if let Err(error) = pp.run(file, source) {
            return TranslateResult::failure(
                "preprocess",
                Some(stage),
                vec![Diagnostic {
                    message: error.message,
                    file: Some(error.file),
                    line: Some(error.line),
                    column: None,
                }],
            );
        }
        stages.push(pp);
    }
    // 几何段：同一张宏表，跳过顶点段已经展开过的头文件（`common_particles.h` 没有头文件保护，两段都 include 它）
    let geometry_pp = match &request.geometry {
        Some(source) => {
            let mut pp = Preprocessor::new(&request.includes, &defines);
            pp.skip_includes(stages[0].expanded.clone());
            if let Err(error) = pp.run("<geometry>", source) {
                return TranslateResult::failure(
                    "preprocess",
                    Some(Stage::Geometry),
                    vec![Diagnostic {
                        message: error.message,
                        file: Some(error.file),
                        line: Some(error.line),
                        column: None,
                    }],
                );
            }
            Some(pp)
        }
        None => None,
    };
    let missing: BTreeSet<String> = stages
        .iter()
        .chain(&geometry_pp)
        .flat_map(|pp| pp.missing.iter().cloned())
        .collect();
    if !missing.is_empty() {
        // 只有几何段缺头文件时记作几何阶段；顶点 / 片元缺的（含两段都缺的）照旧不带阶段
        let geometry_only = stages.iter().all(|pp| pp.missing.is_empty());
        return TranslateResult {
            missing: missing.into_iter().collect(),
            ..TranslateResult::failure("include", geometry_only.then_some(Stage::Geometry), vec![])
        };
    }
    let requires: BTreeSet<String> = stages
        .iter()
        .chain(&geometry_pp)
        .flat_map(|pp| pp.requires.iter().cloned())
        .collect();
    if !requires.is_empty() {
        return TranslateResult {
            requires: requires.into_iter().collect(),
            ..TranslateResult::failure("require", None, vec![])
        };
    }

    // 4. 几何着色器展开：顶点段的 GS 分支与几何段拼成一个顶点着色器
    let mut geometry = None;
    let merged;
    let vertex_lines = match &geometry_pp {
        Some(pp) => match geometry::merge(&stages[0].lines, &pp.lines, pp) {
            Ok((lines, max_vertices)) => {
                geometry = Some(GeometryInfo { max_vertices });
                merged = lines;
                &merged
            }
            Err(error) => {
                return TranslateResult::failure(
                    "rewrite",
                    Some(error.stage),
                    vec![Diagnostic {
                        message: error.message,
                        file: error.file,
                        line: error.line,
                        column: None,
                    }],
                );
            }
        },
        None => &stages[0].lines,
    };

    // 5. 改写成 GLSL 450
    let program = match rewrite::build(vertex_lines, &stages[1].lines) {
        Ok(program) => program,
        Err(error) => {
            return TranslateResult::failure(
                "rewrite",
                Some(error.stage),
                vec![Diagnostic {
                    message: error.message,
                    file: error.file,
                    line: error.line,
                    column: None,
                }],
            );
        }
    };

    // 6. naga 编译两段
    let mut outputs = Vec::with_capacity(2);
    for (stage, glsl) in [
        (Stage::Vertex, &program.vertex_glsl),
        (Stage::Fragment, &program.fragment_glsl),
    ] {
        match naga_stage::compile(stage, glsl, &defines) {
            Ok(compiled) => outputs.push(compiled),
            Err(failure) => {
                let output = StageOutput {
                    glsl: Some(glsl.clone()),
                    ..StageOutput::default()
                };
                let mut result =
                    TranslateResult::failure(failure.phase, Some(stage), failure.errors);
                match stage {
                    Stage::Vertex | Stage::Geometry => result.vertex = Some(output),
                    Stage::Fragment => result.fragment = Some(output),
                }
                return result;
            }
        }
    }
    let (vs, fs) = (&outputs[0], &outputs[1]);

    // 7. 反射：两阶段的 uniform 块是同一份声明，取先有的那一侧
    let block = if vs.block.is_empty() {
        &fs.block
    } else {
        &vs.block
    };
    let uniforms = program
        .uniforms
        .iter()
        .filter_map(|uniform| {
            let member = rewrite::block_member_name(uniform);
            let layout = block.get(&member)?;
            // 拆开的两半只给自己的阶段用，只看自己的阶段；合并的与只在一个阶段声明的，两个阶段都没读才算没读
            let read = match uniform.stage {
                Some(Stage::Vertex | Stage::Geometry) => vs.read.contains(&member),
                Some(Stage::Fragment) => fs.read.contains(&member),
                None => vs.read.contains(&member) || fs.read.contains(&member),
            };
            Some(Uniform {
                name: uniform.name.clone(),
                ty: layout.ty.clone(),
                declared: uniform.ty.clone(),
                offset: layout.offset,
                size: layout.size,
                array: uniform.array,
                stride: layout.stride,
                meta: uniform.meta.clone(),
                stage: uniform.stage,
                original: uniform.original.clone(),
                unused: !read,
            })
        })
        .collect();
    let stage_output = |compiled: &naga_stage::Compiled, glsl: &str| StageOutput {
        wgsl: Some(compiled.wgsl.clone()),
        entry_point: Some(compiled.entry_point.clone()),
        glsl: request.debug.then(|| glsl.to_string()),
    };
    TranslateResult {
        ok: true,
        vertex: Some(stage_output(vs, &program.vertex_glsl)),
        fragment: Some(stage_output(fs, &program.fragment_glsl)),
        uniforms,
        uniform_block_size: vs.block_size.or(fs.block_size),
        textures: program
            .textures
            .iter()
            .map(|texture| Texture {
                slot: texture.slot,
                name: texture.name.clone(),
                kind: texture.kind.as_str(),
                binding: rewrite::texture_binding(texture.slot),
                sampler_binding: rewrite::sampler_binding(texture.slot),
                meta: texture.meta.clone(),
            })
            .collect(),
        attributes: interfaces(&program.attributes),
        varyings: interfaces(&program.varyings),
        combos,
        geometry,
        ..TranslateResult::default()
    }
}

fn interfaces(decls: &[rewrite::InterfaceDecl]) -> Vec<Interface> {
    decls
        .iter()
        .map(|decl| Interface {
            name: decl.name.clone(),
            location: decl.location,
            ty: decl.ty.clone(),
            array: decl.array,
        })
        .collect()
}

/// COMBO 取值：`// [COMBO]` 声明的默认值；绑定了带 `combo` 注释的纹理则置 1；请求里的值最后覆盖。
fn resolve_combos(
    request: &TranslateRequest,
    annotations: &Annotations,
) -> Result<Vec<Combo>, String> {
    let mut combos: BTreeMap<String, Combo> = BTreeMap::new();
    let mut set = |name: &str, value: i64, source: &'static str| {
        let name = name.trim().to_ascii_uppercase();
        combos.insert(
            name.clone(),
            Combo {
                name,
                value,
                source,
            },
        );
    };
    for decl in &annotations.combos {
        if let Some(name) = decl.get("combo").and_then(Value::as_str) {
            let default = decl
                .get("default")
                .map(combo_value)
                .transpose()?
                .unwrap_or(0);
            set(name, default, "default");
        }
    }
    for (slot, meta) in &annotations.samplers {
        let bound = request.textures.iter().any(|texture| texture.slot == *slot);
        if let (true, Some(name)) = (bound, meta.get("combo").and_then(Value::as_str)) {
            set(name, 1, "texture");
        }
    }
    for (name, value) in &request.combos {
        set(name, combo_value(value)?, "request");
    }
    Ok(combos.into_values().collect())
}

fn combo_value(value: &Value) -> Result<i64, String> {
    match value {
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|f| f as i64))
            .ok_or_else(|| format!("COMBO 值无法转为整数：{number}")),
        Value::String(text) => text
            .trim()
            .parse()
            .map_err(|_| format!("COMBO 值不是整数：{text}")),
        other => Err(format!("COMBO 值类型不支持：{other}")),
    }
}

// ---- C ABI ----

fn byte_layout(len: usize) -> Layout {
    // 长度 0 也分配 1 字节，保证指针非空、alloc / dealloc 用同一布局
    Layout::from_size_align(len.max(1), 1).expect("byte layout")
}

/// 分配 `len` 字节，供 JS 写入请求。
#[no_mangle]
pub extern "C" fn wpesl_alloc(len: usize) -> *mut u8 {
    // SAFETY: 布局非零大小、对齐为 1
    unsafe { alloc(byte_layout(len)) }
}

/// 释放 [`wpesl_alloc`] 分配的内存，或 [`wpesl_translate`] 返回的结果缓冲区（`len` 为整个缓冲区长度）。
///
/// # Safety
/// `ptr` 必须来自本模块的分配，且 `len` 与分配时一致。
#[no_mangle]
pub unsafe extern "C" fn wpesl_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, byte_layout(len));
    }
}

/// 翻译一个着色器对：`ptr..ptr+len` 是 UTF-8 JSON 请求，返回结果缓冲区（见模块文档）。
///
/// # Safety
/// `ptr..ptr+len` 必须是可读的有效内存。
#[no_mangle]
pub unsafe extern "C" fn wpesl_translate(ptr: *const u8, len: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(ptr, len);
    let result = match serde_json::from_slice::<TranslateRequest>(input) {
        Ok(request) => translate(&request),
        Err(error) => TranslateResult::request_error(error.to_string()),
    };
    let json = serde_json::to_vec(&result).expect("serialize translate result");
    let total = 4 + json.len();
    let out = wpesl_alloc(total);
    std::ptr::copy_nonoverlapping((json.len() as u32).to_le_bytes().as_ptr(), out, 4);
    std::ptr::copy_nonoverlapping(json.as_ptr(), out.add(4), json.len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 接近 WPE `genericimage` 的最小着色器对（含头文件、COMBO 与 HLSL 风格内建）。
    const VERT: &str = r##"
#include "common_vertex.h"
uniform mat4 g_ModelViewProjectionMatrix;
uniform float g_Time;
uniform float g_ScrollX; // {"material":"Scroll 1 X","default":0,"range":[-2,2]}
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord = a_TexCoord + g_Time * CAST2(g_ScrollX);
}
"##;

    const FRAG: &str = r##"
#include "common_fragment.h"
// [COMBO] {"material":"Tint","combo":"TINT","default":0}
uniform sampler2D g_Texture0; // {"material":"albedo","default":"util/white"}
uniform sampler2D g_Texture1; // {"combo":"NORMALMAP","formatcombo":true}
#if TINT
uniform vec3 g_Color1; // {"material":"color1","default":"0 0 0"}
#endif
varying vec2 v_TexCoord;
void main() {
	vec4 albedo = texSample2D(g_Texture0, v_TexCoord.xy);
#if TINT
	albedo.rgb = mix(albedo.rgb, g_Color1, 0.5);
#endif
#if NORMALMAP
	albedo.rgb *= DecompressNormal(texSample2D(g_Texture1, v_TexCoord));
#endif
	gl_FragColor = vec4(saturate(albedo.rgb * 2), 1);
}
"##;

    fn includes() -> BTreeMap<String, String> {
        [
            ("common_vertex.h".to_string(), "vec2 unused_vertex_helper(vec2 v) { return frac(v); }\n".to_string()),
            (
                "common_fragment.h".to_string(),
                "#define FORMAT_RG88 8\nvec3 DecompressNormal(vec4 n)\n{\n#if TEX1FORMAT == FORMAT_RG88\n\treturn vec3(n.rg * 2.0 - 1.0, 1);\n#else\n\treturn vec3(n.wy * 2.0 - 1.0, 1);\n#endif\n}\n".to_string(),
            ),
        ]
        .into_iter()
        .collect()
    }

    fn request() -> TranslateRequest {
        TranslateRequest {
            vertex: VERT.to_string(),
            fragment: FRAG.to_string(),
            includes: includes(),
            textures: vec![BoundTexture {
                slot: 0,
                format: Some(4),
            }],
            ..TranslateRequest::default()
        }
    }

    #[test]
    fn translates_a_material_pass() {
        let result = translate(&request());
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        assert!(result
            .vertex
            .as_ref()
            .unwrap()
            .wgsl
            .as_deref()
            .unwrap()
            .contains("@vertex"));
        assert!(result
            .fragment
            .as_ref()
            .unwrap()
            .wgsl
            .as_deref()
            .unwrap()
            .contains("@fragment"));
        let names: Vec<_> = result
            .uniforms
            .iter()
            .map(|u| (u.name.as_str(), u.offset))
            .collect();
        assert_eq!(
            names,
            [
                ("g_ModelViewProjectionMatrix", 0),
                ("g_Time", 64),
                ("g_ScrollX", 68)
            ]
        );
        assert_eq!(
            result.uniforms[2].meta.as_ref().unwrap()["material"],
            "Scroll 1 X"
        );
        let attributes: Vec<_> = result
            .attributes
            .iter()
            .map(|a| (a.name.as_str(), a.location))
            .collect();
        assert_eq!(attributes, [("a_Position", 0), ("a_TexCoord", 1)]);
        assert_eq!(result.textures.len(), 2);
        assert_eq!(
            result
                .combos
                .iter()
                .find(|c| c.name == "TINT")
                .unwrap()
                .value,
            0
        );
    }

    #[test]
    fn combos_from_request_and_bound_textures() {
        let mut req = request();
        req.combos.insert("tint".into(), Value::Bool(true));
        req.textures.push(BoundTexture {
            slot: 1,
            format: Some(8),
        });
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        let combo = |name: &str| {
            result
                .combos
                .iter()
                .find(|c| c.name == name)
                .map(|c| (c.value, c.source))
        };
        assert_eq!(combo("TINT"), Some((1, "request")));
        assert_eq!(combo("NORMALMAP"), Some((1, "texture")));
        assert!(result.uniforms.iter().any(|u| u.name == "g_Color1"));
    }

    /// 翻译后有没有 `g_Mark`：判断 `#if condition` 走了哪一支。
    fn reaches_mark(condition: &str, annotation: &str, format: Option<u32>) -> bool {
        let mut req = request();
        req.fragment = format!(
            "uniform sampler2D g_Texture1; // {annotation}\n#if {condition}\nuniform float g_Mark;\n#endif\nvoid main() {{\n\tgl_FragColor = texSample2D(g_Texture1, vec2(0, 0));\n#if {condition}\n\tgl_FragColor.r = g_Mark;\n#endif\n}}\n"
        );
        req.textures = vec![BoundTexture { slot: 1, format }];
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        result.uniforms.iter().any(|u| u.name == "g_Mark")
    }

    #[test]
    fn format_macro_requires_formatcombo() {
        assert!(reaches_mark(
            "TEX1FORMAT == 8",
            r#"{"formatcombo":true}"#,
            Some(8)
        ));
        // eagleflag：`g_Texture1` 没有注释，DXT5 也不定义 TEX1FORMAT
        assert!(!reaches_mark(
            "TEX1FORMAT == 4",
            r#"{"label":"x"}"#,
            Some(4)
        ));
    }

    #[test]
    fn platform_macros_follow_wpe() {
        let plain = r#"{"label":"x"}"#;
        assert!(reaches_mark("HLSL_SM40", plain, None));
        assert!(reaches_mark("SHADERVERSION == 69", plain, None));
        assert!(!reaches_mark("HLSL_GS40_DISABLED", plain, None));
        assert!(!reaches_mark("GS_ENABLED", plain, None));
    }

    /// 输出的 WGSL 必须能被 naga 自己的 WGSL 前端重新接受。
    fn assert_wgsl_reparses(result: &TranslateResult) {
        for output in [&result.vertex, &result.fragment] {
            let wgsl = output.as_ref().and_then(|o| o.wgsl.as_deref()).unwrap();
            let module = naga::front::wgsl::parse_str(wgsl)
                .unwrap_or_else(|e| panic!("{}", e.emit_to_string(wgsl)));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::empty(),
            )
            .validate(&module)
            .unwrap_or_else(|e| panic!("{e:?}\n{wgsl}"));
        }
    }

    /// `fluidsimulation_advection` 的形状：`return` 之后还有 `min(...)`。`min` 被宏成用户函数 `kb_min`，
    /// 死代码里就有用户函数调用；嵌入的 naga 带了行为补丁（naga/KABEGAME.md「行为补丁」）后能翻译通过。
    /// 死代码不进输出：同一函数去掉死代码后，两阶段的 WGSL 逐字节相同。
    #[test]
    fn dead_code_after_return_is_dropped() {
        let fragment = |dead: &str| {
            format!(
                "uniform sampler2D g_Texture0;\nvarying vec2 v_TexCoord;\nvec4 AddEmitterColor(vec4 currentColor, float amt)\n{{\n\tvec4 prevColor = texSample2D(g_Texture0, v_TexCoord);\n\treturn mix(currentColor, prevColor, amt);\n{dead}}}\nvoid main() {{\n\tvec4 c = AddEmitterColor(vec4(0.5, 0.5, 0.5, 1.0), 0.25);\n\tgl_FragColor = min(c, vec4(1.0, 1.0, 1.0, 1.0));\n}}\n"
            )
        };
        let translate_with = |dead: &str| {
            let req = TranslateRequest {
                vertex: "attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord = a_TexCoord; }".into(),
                fragment: fragment(dead),
                textures: vec![BoundTexture {
                    slot: 0,
                    format: Some(0),
                }],
                ..TranslateRequest::default()
            };
            let result = translate(&req);
            assert!(result.ok, "{result:#?}");
            assert_wgsl_reparses(&result);
            result
        };
        let with_dead =
            translate_with("\treturn min(currentColor + vec4(amt), vec4(1.0, 1.0, 1.0, 1.0));\n");
        let without_dead = translate_with("");
        let wgsl = |result: &TranslateResult| {
            [&result.vertex, &result.fragment].map(|o| o.as_ref().unwrap().wgsl.clone().unwrap())
        };
        assert_eq!(wgsl(&with_dead), wgsl(&without_dead));
    }

    /// 标量数组（如音频频谱）在块里补成 vec4 数组，下标访问与整体传参都照常可用，WGSL 合法。
    #[test]
    fn scalar_uniform_arrays_are_padded() {
        let fragment = "uniform float g_Spectrum[4];\nfloat total(float s[4]) { return s[0] + s[3]; }\nvoid main() { gl_FragColor = vec4(g_Spectrum[1] + total(g_Spectrum)); }";
        let req = TranslateRequest {
            vertex: "void main() { gl_Position = vec4(0); }".into(),
            fragment: fragment.into(),
            ..TranslateRequest::default()
        };
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let spectrum = &result.uniforms[0];
        assert_eq!(spectrum.name, "g_Spectrum");
        assert_eq!(spectrum.declared, "float");
        assert_eq!(spectrum.ty, "array<vec4<f32>, 4>");
        assert_eq!((spectrum.stride, spectrum.size), (Some(16), 64));
    }

    /// P7b 步骤 3：`main` 之前的下标访问是 WPE 的打包形态（`[i/4][i%4]` 取元素、`[i]` 取整行、越界读后面的成员），
    /// `main` 里仍是还原后的 `float[n]`；naga 接受、WGSL 能回读，且只有这个阶段生成 `kb_pack_*`。
    #[test]
    fn packed_arrays_before_main_end_to_end() {
        let fragment = "uniform float g_AudioSpectrum16Left[16];\nuniform float g_Time;\nfloat bar(int i) { return g_AudioSpectrum16Left[i / 4][i % 4]; }\nvec4 row(int i) { return g_AudioSpectrum16Left[i]; }\nvoid main() { gl_FragColor = vec4(bar(5) + g_AudioSpectrum16Left[5]) + row(4); }";
        let req = TranslateRequest {
            vertex: "uniform float g_AudioSpectrum16Left[16];\nvoid main() { gl_Position = vec4(g_AudioSpectrum16Left[0]); }".into(),
            fragment: fragment.into(),
            debug: true,
            ..TranslateRequest::default()
        };
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let glsl = |output: &Option<StageOutput>| output.as_ref().unwrap().glsl.clone().unwrap();
        let fs = glsl(&result.fragment);
        assert!(
            fs.contains("float bar(int i) { return kb_pack_g_AudioSpectrum16Left(i / 4)[i % 4]; }"),
            "{fs}"
        );
        assert!(fs.contains("vec4 row(int i) { return kb_pack_g_AudioSpectrum16Left(i); }"));
        // 第 4 行越界读到同一缓冲里紧跟的 g_Time，再往后是 0
        assert!(
            fs.contains(
                "    if (k == 4) return vec4(g_Time, 0.0, 0.0, 0.0);\n    return vec4(0.0);\n}\n"
            ),
            "{fs}"
        );
        assert!(fs.contains("vec4(bar(5) + g_AudioSpectrum16Left[5])"));
        assert!(!glsl(&result.vertex).contains("kb_pack_"));
    }

    /// 两阶段同名、材质键不同的 uniform 拆成两格：各自的偏移、注解，改名的一格带 `stage` / `original`，WGSL 合法，
    /// 每个阶段只读自己那一格。补齐过的数组（`kb_u_`）同样能拆。
    #[test]
    fn split_stage_uniforms_end_to_end() {
        let req = TranslateRequest {
            vertex: "uniform float g_Time;\nuniform float g_Speed; // {\"material\":\"speed\",\"default\":1}\nuniform float g_Bars[4]; // {\"material\":\"bars\"}\nattribute vec3 a_Position;\nvoid main() { gl_Position = vec4(a_Position * (g_Speed * g_Time + g_Bars[1]), 1.0); }".into(),
            fragment: "uniform float g_Speed; // {\"material\":\"speeduv\",\"default\":5}\nuniform float g_Bars[4]; // {\"material\":\"bars2\",\"default\":\"1 2 3 4\"}\nuniform float g_Time;\nvoid main() { gl_FragColor = vec4(g_Speed * g_Time + g_Bars[2]); }".into(),
            ..TranslateRequest::default()
        };
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let layout: Vec<_> = result
            .uniforms
            .iter()
            .map(|u| (u.name.as_str(), u.ty.as_str(), u.offset))
            .collect();
        assert_eq!(
            layout,
            [
                ("g_Time", "f32", 0),
                ("g_Speed", "f32", 4),
                ("g_Bars", "array<vec4<f32>, 4>", 16),
                ("kb_fs_g_Speed", "f32", 80),
                ("kb_fs_g_Bars", "array<vec4<f32>, 4>", 96),
            ]
        );
        let json = serde_json::to_value(&result.uniforms).unwrap();
        assert!(json[0].get("stage").is_none() && json[0].get("original").is_none());
        assert_eq!(json[1]["stage"], "vertex");
        assert!(json[1].get("original").is_none());
        assert_eq!(json[3]["stage"], "fragment");
        assert_eq!(json[3]["original"], "g_Speed");
        assert_eq!(json[3]["meta"]["material"], "speeduv");
        assert_eq!(json[4]["original"], "g_Bars");
        assert_eq!(json[4]["meta"]["default"], "1 2 3 4");
        // 只看入口函数体：补齐数组的还原函数两阶段都会生成（块是同一份），不算引用
        let main_body = |output: &Option<StageOutput>| {
            let wgsl = output.as_ref().unwrap().wgsl.clone().unwrap();
            let start = wgsl.find("fn main_1()").unwrap();
            let end = start + wgsl[start..].find("\n}\n").unwrap();
            wgsl[start..end].to_string()
        };
        let (vs, fs) = (main_body(&result.vertex), main_body(&result.fragment));
        assert!(vs.contains(".g_Speed") && !vs.contains("kb_fs_"), "{vs}");
        assert!(vs.contains("kb_load_g_Bars()"), "{vs}");
        assert!(
            fs.contains(".kb_fs_g_Speed") && !fs.contains(".g_Speed"),
            "{fs}"
        );
        assert!(
            fs.contains("kb_load_kb_fs_g_Bars()") && !fs.contains("kb_load_g_Bars()"),
            "{fs}"
        );
    }

    #[test]
    fn missing_includes_are_listed() {
        let mut req = request();
        req.includes.clear();
        let result = translate(&req);
        assert_eq!(result.phase, Some("include"));
        assert_eq!(result.missing, ["common_fragment.h", "common_vertex.h"]);
    }

    #[test]
    fn unknown_require_is_reported() {
        let mut req = request();
        req.fragment = format!("#require LightingV2\n{FRAG}");
        let result = translate(&req);
        assert_eq!(result.phase, Some("require"));
        assert_eq!(result.requires, ["LightingV2"]);
    }

    #[test]
    fn lighting_require_is_empty_when_lighting_is_off() {
        let mut req = request();
        req.fragment = format!("#require LightingV1\n{FRAG}");
        let result = translate(&req);
        assert!(result.ok, "{:?}", result.errors);
    }

    /// `common_pbr_2.h` 的最小替身：只保留库要调用的签名，验证生成的代码能一路翻到 WGSL。
    const PBR_STUB: &str = "\
vec3 ComputePBRLightShadow(vec3 N, vec3 L, vec3 V, vec3 albedo, vec3 lightColor, float radius, float exponent, vec3 tint, vec3 f0, float roughness, float metallic, float shadow) { return L * radius * exponent; }
vec3 ComputePBRLightShadowInfinite(vec3 N, vec3 L, vec3 V, vec3 albedo, vec3 lightColor, vec3 tint, vec3 f0, float roughness, float metallic, float shadow) { return L; }
vec3 PointSegmentDelta(vec3 p, vec3 a, vec3 b) { return a - p; }
";

    fn lit_request() -> TranslateRequest {
        let mut req = request();
        req.fragment = format!(
            "{PBR_STUB}#require LightingV1\nvoid main() {{ vec3 c = PerformLighting_V1(vec3(0, 0, 0), vec3(1, 1, 1), vec3(0, 0, 1), vec3(0, 0, 1), vec3(1, 1, 1), vec3(0.04, 0.04, 0.04), 0.5, 0.0); gl_FragColor = vec4(c, 1.0); }}\n"
        );
        req.combos.insert("LIGHTING".into(), serde_json::json!(1));
        req
    }

    #[test]
    fn lighting_library_translates_every_light_type() {
        let mut req = lit_request();
        for name in [
            "LIGHTS_POINT",
            "LIGHTS_SPOT",
            "LIGHTS_TUBE",
            "LIGHTS_DIRECTIONAL",
        ] {
            req.lit_defines.insert(name.into(), "2".into());
        }
        let result = translate(&req);
        assert!(result.ok, "{:?}", result.errors);
        let names: Vec<_> = result.uniforms.iter().map(|u| u.name.as_str()).collect();
        for name in [
            "g_LPoint_Color",
            "g_LSpot_Exponent",
            "g_LTube_OriginB",
            "g_LDirectional_Direction",
        ] {
            assert!(names.contains(&name), "缺 {name}: {names:?}");
        }
    }

    /// WPE 只在最终 `LIGHTING` 非 0 时写 `LIGHTS_*`（`FUN_1401a5c40`）：LIGHTING=0 的材质拿到它们也不生效。
    #[test]
    fn lit_defines_apply_only_when_lighting_is_on() {
        let mut req = request();
        req.fragment = format!("#if LIGHTS_POINT\nuniform vec4 g_Marker;\n#endif\n{FRAG}");
        req.lit_defines.insert("LIGHTS_POINT".into(), "1".into());
        let result = translate(&req);
        assert!(result.ok, "{:?}", result.errors);
        assert!(!result.uniforms.iter().any(|u| u.name == "g_Marker"));
    }

    #[test]
    fn lighting_shadows_stay_reported() {
        let mut req = lit_request();
        req.lit_defines
            .insert("LIGHTS_SPOT_COOKIE".into(), "1".into());
        let result = translate(&req);
        assert_eq!(result.phase, Some("require"));
        assert_eq!(result.requires, ["LightingV1/shadow"]);
    }

    // ---- 几何着色器展开 ----

    /// 没有头文件保护、两段都 include 的头文件（同 `common_particles.h`）：uniform、函数与几何段 `#if` 要用的宏。
    const GS_HEADER: &str = "uniform mat4 g_ModelViewProjectionMatrix;\n#define KB_HALF 0.5\nvec3 Shared(vec3 v) { return v * KB_HALF; }\n";

    const GS_VERT: &str = "#include \"particles.h\"
#if GS_ENABLED
attribute vec4 a_PositionVec4;
varying vec4 v_Color;
void main() {
	gl_Position = vec4(Shared(a_PositionVec4.xyz), a_PositionVec4.w);
	v_Color = vec4(1, 0, 0, 1);
}
#else
attribute vec4 a_PositionVec4;
void main() { gl_Position = a_PositionVec4; }
#endif
";

    /// 带 for 变量遮蔽、HLSL 截断（`vec3 = mul(vec4, mat4)`）、normalize 与两次 Append 的几何着色器。
    const GS_GEOM: &str = "#include \"particles.h\"
#ifndef SUB
#define SUB 0
#endif
in vec4 v_Color;
in vec4 gl_Position;
out vec2 v_TexCoord;
out vec4 v_Color;
out vec4 gl_Position;
#if defined(KB_HALF)
[maxvertexcount(4 + SUB * 2)]
#endif
void main() {
	vec3 p = Shared(IN[0].gl_Position.xyz);
	vec3 eye = mul(vec4(p, 1.0), g_ModelViewProjectionMatrix);
	vec3 r = normalize(cross(eye, vec3(0, 0, 1))) * IN[0].gl_Position.w;
	PS_INPUT v;
	v.v_Color = IN[0].v_Color;
	for (int s = 0; s < 2 + SUB; ++s)
	{
		float s = 0.5;
		v.v_TexCoord = vec2(s, 0);
		v.gl_Position = mul(vec4(p + r * s, 1.0), g_ModelViewProjectionMatrix);
		OUT.Append(v);
		v.gl_Position = mul(vec4(p - r, 1.0), g_ModelViewProjectionMatrix);
		OUT.Append(v);
	}
}
";

    fn gs_request() -> TranslateRequest {
        TranslateRequest {
            vertex: GS_VERT.into(),
            fragment: "varying vec2 v_TexCoord;\nvarying vec4 v_Color;\nvoid main() { gl_FragColor = v_Color * v_TexCoord.x; }\n".into(),
            geometry: Some(GS_GEOM.into()),
            includes: [("particles.h".to_string(), GS_HEADER.to_string())]
                .into_iter()
                .collect(),
            debug: true,
            ..TranslateRequest::default()
        }
    }

    #[test]
    fn geometry_expands_into_one_vertex_shader() {
        let result = translate(&gs_request());
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        assert_eq!(result.geometry.as_ref().map(|g| g.max_vertices), Some(4));
        let vertex = result.vertex.as_ref().unwrap();
        let glsl = vertex.glsl.as_deref().unwrap();
        // 走的是 GS_ENABLED 分支，几何段的 [maxvertexcount] 由头文件里的宏放行
        assert!(
            glsl.contains("kb_gsin_gl_Position = vec4(Shared("),
            "{glsl}"
        );
        // 跨段的头文件只展开一次：函数与 uniform 都只有一份
        assert_eq!(glsl.matches("vec3 Shared(vec3 v)").count(), 1, "{glsl}");
        assert_eq!(
            result
                .uniforms
                .iter()
                .filter(|u| u.name == "g_ModelViewProjectionMatrix")
                .count(),
            1
        );
        // 输出顶点下标是 vertex_index；varying 是几何段的 out
        assert!(vertex
            .wgsl
            .as_deref()
            .unwrap()
            .contains("@builtin(vertex_index)"));
        let varyings: Vec<_> = result
            .varyings
            .iter()
            .map(|v| (v.name.as_str(), v.ty.as_str()))
            .collect();
        assert_eq!(varyings, [("v_TexCoord", "vec2"), ("v_Color", "vec4")]);
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["geometry"], serde_json::json!({ "maxVertices": 4 }));
        // TRAILSUBDIVISION 这类宏按最终宏表求值
        let mut req = gs_request();
        req.defines.insert("SUB".into(), "16".into());
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert_eq!(result.geometry.map(|g| g.max_vertices), Some(36));
    }

    /// 不带几何段：没有 `geometry` 字段，也不定义 GS_ENABLED（走非 GS 分支）。
    #[test]
    fn without_geometry_nothing_changes() {
        let mut req = gs_request();
        req.geometry = None;
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert!(result.geometry.is_none());
        assert!(serde_json::to_value(&result)
            .unwrap()
            .get("geometry")
            .is_none());
        let glsl = result.vertex.unwrap().glsl.unwrap();
        assert!(
            glsl.contains("gl_Position = a_PositionVec4;") && !glsl.contains("kb_gs"),
            "{glsl}"
        );
    }

    #[test]
    fn geometry_errors_carry_the_geometry_stage() {
        // 只有几何段缺头文件
        let mut req = gs_request();
        req.geometry = Some(format!("#include \"geom_only.h\"\n{GS_GEOM}"));
        let result = translate(&req);
        assert_eq!(result.phase, Some("include"));
        assert_eq!(result.stage, Some(Stage::Geometry));
        assert_eq!(result.missing, ["geom_only.h"]);
        // 两段都缺：照旧不带阶段
        let mut req = gs_request();
        req.includes.clear();
        let result = translate(&req);
        assert_eq!((result.phase, result.stage), (Some("include"), None));
        assert_eq!(result.missing, ["particles.h"]);
        // 预处理错误（多余的 #endif 照 WPE 忽略，没闭合的 #if 仍报错）
        let mut req = gs_request();
        req.geometry = Some(format!("{GS_GEOM}#if 1\n"));
        let result = translate(&req);
        assert_eq!(
            (result.phase, result.stage),
            (Some("preprocess"), Some(Stage::Geometry))
        );
        assert_eq!(result.errors[0].file.as_deref(), Some("<geometry>"));
        // 改写错误：IN[1]、RestartStrip
        for (from, to) in [
            ("IN[0].v_Color", "IN[1].v_Color"),
            (
                "\t\tOUT.Append(v);\n\t}",
                "\t\tOUT.Append(v);\n\t\tOUT.RestartStrip();\n\t}",
            ),
        ] {
            let mut req = gs_request();
            req.geometry = Some(GS_GEOM.replace(from, to));
            let result = translate(&req);
            assert_eq!(
                (result.phase, result.stage),
                (Some("rewrite"), Some(Stage::Geometry)),
                "{to}"
            );
            assert_eq!(serde_json::to_value(&result).unwrap()["stage"], "geometry");
        }
    }

    /// 按 JS 胶水的方式走一遍 C ABI：写请求、调用、读长度头、解析、释放。
    #[test]
    fn abi_round_trip() {
        let body = serde_json::json!({
            "vertex": "attribute vec3 a_Position;\nvoid main() { gl_Position = vec4(a_Position, 1); }",
            "fragment": "void main() { gl_FragColor = vec4(1); }",
        })
        .to_string();
        unsafe {
            let input = wpesl_alloc(body.len());
            std::ptr::copy_nonoverlapping(body.as_ptr(), input, body.len());
            let out = wpesl_translate(input, body.len());
            wpesl_free(input, body.len());
            let mut header = [0u8; 4];
            std::ptr::copy_nonoverlapping(out, header.as_mut_ptr(), 4);
            let len = u32::from_le_bytes(header) as usize;
            let value: Value =
                serde_json::from_slice(std::slice::from_raw_parts(out.add(4), len)).unwrap();
            wpesl_free(out, 4 + len);
            assert_eq!(value["ok"], true, "{value}");
        }
    }

    #[test]
    fn malformed_request_is_reported() {
        let request = b"{not json";
        unsafe {
            let out = wpesl_translate(request.as_ptr(), request.len());
            let mut header = [0u8; 4];
            std::ptr::copy_nonoverlapping(out, header.as_mut_ptr(), 4);
            let len = u32::from_le_bytes(header) as usize;
            let value: Value =
                serde_json::from_slice(std::slice::from_raw_parts(out.add(4), len)).unwrap();
            wpesl_free(out, 4 + len);
            assert_eq!(value["phase"], "request");
        }
    }

    /// P7c 2h（工坊 `radial_blur` 的形状）：全局 const 的初始值引用 uniform，`main` 之前的辅助函数也用它。
    /// WPE 写成 `static const`，fxc 每次调用现算；这里改成私有全局、在 `main` 开头赋值，翻译通过、WGSL 能回读。
    #[test]
    fn runtime_global_const_end_to_end() {
        let req = TranslateRequest {
            vertex: "attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord = a_TexCoord; }".into(),
            fragment: "uniform float u_strength; // {\"material\":\"strength\",\"default\":1}\nuniform float u_samples; // {\"material\":\"samples\",\"default\":8}\nvarying vec2 v_TexCoord;\nconst float strength = -u_strength * 0.1 / u_samples;\nconst vec2 offset = vec2(strength, 0.0);\nvec2 computeUV(vec2 uv) { return uv + offset; }\nvoid main() {\n\tgl_FragColor = vec4(computeUV(v_TexCoord), strength, 1.0);\n}\n".into(),
            debug: true,
            ..TranslateRequest::default()
        };
        let result = translate(&req);
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let fs = result.fragment.as_ref().unwrap().glsl.clone().unwrap();
        assert!(fs.contains("float strength;\nvec2 offset;\n"), "{fs}");
        assert!(
            fs.contains("void main() { strength = -u_strength * 0.1 / u_samples; offset = vec2(strength, 0.0);\n"),
            "{fs}"
        );
    }

    /// P7c 步骤 3：片元的 varying 按顶点的类型声明（WPE 只有一份 `VS_OUTPUT`），不论哪边宽；片元可以改写 varying。
    /// p7-sem 的 `kbwidth`：顶点写 vec4，片元声明 vec2、改 `.x` 读 `.zw`。片元更宽的（`glitter_prepare`）只读顶点有的分量就能过，
    /// 读了顶点没有的分量照常报错（fxc 也报错）。
    #[test]
    fn fragment_varyings_follow_vertex_types() {
        let translate_pair = |vs_ty: &str, fs: &str| {
            translate(&TranslateRequest {
                vertex: format!("attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying {vs_ty} v_TexCoord;\nvoid main() {{ gl_Position = vec4(a_Position, 1.0); v_TexCoord = {vs_ty}(a_TexCoord, 0.25, 0.75); }}"),
                fragment: fs.into(),
                debug: true,
                ..TranslateRequest::default()
            })
        };
        // 顶点更宽：片元按 vec4 声明，改写 `.x`、读 `.zw`
        let result = translate_pair(
            "vec4",
            "varying vec2 v_TexCoord;\nvoid main() { v_TexCoord.x = 0.5; gl_FragColor = vec4(v_TexCoord.zw, v_TexCoord.x, 1.0); }",
        );
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let fs = result.fragment.as_ref().unwrap().glsl.clone().unwrap();
        assert!(fs.contains("layout(location = 0) in vec4 v_TexCoord;"), "{fs}");
        let varyings: Vec<_> = result.varyings.iter().map(|v| (v.name.as_str(), v.ty.as_str())).collect();
        assert_eq!(varyings, [("v_TexCoord", "vec4")]);

        // 片元更宽：按顶点的 vec2 声明，只读 `.xy` 能过，读 `.zw` 报错
        let narrow = |fs: &str| {
            translate(&TranslateRequest {
                vertex: "attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord = a_TexCoord; }".into(),
                fragment: fs.into(),
                ..TranslateRequest::default()
            })
        };
        let result = narrow("varying vec4 v_TexCoord;\nvoid main() { gl_FragColor = vec4(v_TexCoord.xy, 0.0, 1.0); }");
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        let result = narrow("varying vec4 v_TexCoord;\nvoid main() { gl_FragColor = vec4(v_TexCoord.zw, 0.0, 1.0); }");
        assert!(!result.ok);
        assert_eq!(result.phase, Some("parse"), "{result:#?}");
    }

    // ---- P7d 步骤 1：反射的 `unused` ----

    /// 只有位置与纹理坐标的顶点段，不读任何 uniform。
    const PLAIN_VERT: &str = "attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord = a_TexCoord; }";

    fn translate_ok(vertex: &str, fragment: &str) -> TranslateResult {
        let result = translate(&TranslateRequest {
            vertex: vertex.into(),
            fragment: fragment.into(),
            ..TranslateRequest::default()
        });
        assert!(result.ok, "{result:#?}");
        assert_wgsl_reparses(&result);
        result
    }

    /// 按块里的顺序列出（名字, 拆开时的阶段, 没被读）。
    fn unused_flags(result: &TranslateResult) -> Vec<(&str, Option<Stage>, bool)> {
        result
            .uniforms
            .iter()
            .map(|u| (u.name.as_str(), u.stage, u.unused))
            .collect()
    }

    /// 被读（直接读、经两层调用读、补齐数组的下标读）的不标；只在关掉的 `#if` 里、只在没被调用的函数里、只在 `return`
    /// 之后、只声明的都标。GLSL 前端给每个函数开头都放了全部块成员的表达式，这里的辅助函数都会带上它们，不能因此算被读。
    #[test]
    fn unused_marks_uniforms_no_reachable_code_reads() {
        let fragment = "uniform float u_Read; // {\"material\":\"read\"}
uniform float u_Chain; // {\"material\":\"chain\"}
uniform float u_Off; // {\"material\":\"off\"}
uniform float u_Dead; // {\"material\":\"dead\"}
uniform float u_After; // {\"material\":\"after\"}
uniform vec2 u_Never; // {\"material\":\"never\"}
uniform float g_Bars[4];
uniform float g_Weights[4];
varying vec2 v_TexCoord;
float inner() { return u_Chain; }
float outer() { return inner() * 2.0; }
float orphan() { return u_Dead; }
float early() { return 1.0; return u_After; }
void main() {
	float x = u_Read + outer() + early() + g_Weights[2];
#if 0
	x += u_Off;
#endif
	gl_FragColor = vec4(x, v_TexCoord, 1.0);
}
";
        let result = translate_ok(PLAIN_VERT, fragment);
        assert_eq!(
            unused_flags(&result),
            [
                ("u_Read", None, false),
                ("u_Chain", None, false),
                ("u_Off", None, true),
                ("u_Dead", None, true),
                ("u_After", None, true),
                ("u_Never", None, true),
                // 补齐数组的还原函数 kb_load_* 两阶段都生成，只有被调用的那个算读
                ("g_Bars", None, true),
                ("g_Weights", None, false),
            ]
        );
        // 被读的不输出这个字段，没被读的是 true
        let json = serde_json::to_value(&result.uniforms).unwrap();
        assert!(json[0].get("unused").is_none(), "{json}");
        assert_eq!(json[2]["unused"], true);
        // 只改反射：WGSL 与不标 unused 时相同（块照旧是全部成员）
        let wgsl = result.fragment.as_ref().unwrap().wgsl.as_deref().unwrap();
        assert!(wgsl.contains("u_Never: vec2<f32>"), "{wgsl}");
    }

    /// 合并的（两阶段同名同来源）与只在一个阶段声明的：两个阶段都没读才标。
    #[test]
    fn unused_merged_needs_both_stages_unread() {
        let vertex = "uniform float g_Time;\nuniform float u_Both; // {\"material\":\"both\"}\nuniform float u_Vs; // {\"material\":\"vs\"}\nattribute vec3 a_Position;\nvoid main() { gl_Position = vec4(a_Position * u_Vs, 1.0); }";
        let fragment = "uniform float g_Time;\nuniform float u_Both; // {\"material\":\"both\"}\nuniform float u_Fs; // {\"material\":\"fs\"}\nvoid main() { gl_FragColor = vec4(g_Time); }";
        let result = translate_ok(vertex, fragment);
        assert_eq!(
            unused_flags(&result),
            [
                ("g_Time", None, false),
                ("u_Both", None, true),
                ("u_Vs", None, false),
                ("u_Fs", None, true),
            ]
        );
    }

    /// 拆开的两半只看自己的阶段：另一个阶段读的是另一格，不算这一格被读。
    #[test]
    fn unused_split_halves_follow_their_own_stage() {
        let pair = |vs_reads: bool, fs_reads: bool| {
            let vertex = format!(
                "uniform float g_Speed; // {{\"material\":\"speed\"}}\nuniform vec2 u_Res; // {{\"material\":\"res\"}}\nattribute vec3 a_Position;\nvoid main() {{ gl_Position = vec4(a_Position{}, 1.0); }}",
                if vs_reads { " * g_Speed * u_Res.y" } else { "" }
            );
            let fragment = format!(
                "uniform float g_Speed; // {{\"material\":\"speeduv\"}}\nuniform float u_Res; // {{\"material\":\"res\"}}\nvoid main() {{ gl_FragColor = vec4({}); }}",
                if fs_reads { "g_Speed + u_Res" } else { "1.0" }
            );
            translate_ok(&vertex, &fragment)
        };
        let vs = Some(Stage::Vertex);
        let fs = Some(Stage::Fragment);
        // 键不同（g_Speed）与同键不同类型（u_Res，frame_builder 的形状）都拆
        assert_eq!(
            unused_flags(&pair(true, false)),
            [
                ("g_Speed", vs, false),
                ("u_Res", vs, false),
                ("kb_fs_g_Speed", fs, true),
                ("kb_fs_u_Res", fs, true),
            ]
        );
        assert_eq!(
            unused_flags(&pair(false, true)),
            [
                ("g_Speed", vs, true),
                ("u_Res", vs, true),
                ("kb_fs_g_Speed", fs, false),
                ("kb_fs_u_Res", fs, false),
            ]
        );
        assert!(unused_flags(&pair(false, false))
            .iter()
            .all(|(_, _, unused)| *unused));
        assert!(unused_flags(&pair(true, true))
            .iter()
            .all(|(_, _, unused)| !unused));
    }

    /// 几何段拼进顶点段后按顶点算：MVP 只在几何段里读。
    #[test]
    fn unused_counts_geometry_reads_as_vertex() {
        let result = translate(&gs_request());
        assert!(result.ok, "{result:#?}");
        assert_eq!(
            unused_flags(&result),
            [("g_ModelViewProjectionMatrix", None, false)]
        );
    }
}
