//! Wallpaper Engine 着色器语言（WPESL）→ WGSL。
//!
//! 输入一个材质 pass 的顶点 / 片元源码原文（WPE 的 `shaders/*.vert|frag`）、它们 `#include` 的头文件、
//! COMBO 取值与绑定的纹理，crate 内部完成全部处理：
//! 1. 注释元数据：`// [COMBO]` 声明与采样器注释（`combo` / `formatcombo`），定出宏表；
//! 2. 预处理（[`preprocess`]）：`#include` 展开、条件编译求值；
//! 3. 改写（[`rewrite`]）：方言 → Vulkan GLSL 450（uniform 块、纹理 / 采样器拆分、location、内建换名）；
//! 4. naga：解析、按 WebGPU 基线校验、输出 WGSL，并读出 uniform 块布局。
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

mod library;
mod naga_stage;
pub mod preprocess;
pub mod rewrite;

use preprocess::{scan_annotations, Annotations, Preprocessor};

/// 平台宏：照 WPE 的源码前缀与预处理器种子（2.8.42 `FUN_1400d5070`、`FUN_14016b0e0`）。
/// - `HLSL`：`#ifdef HLSL` 块里是 D3D 坐标约定下的 Y 翻转，WebGPU 的纹理 / 帧缓冲坐标与 D3D 相同；
/// - `HLSL_SM40`、`SHADERVERSION`：WPE 恒定义。
///
/// `GS_ENABLED`、`REVERSEDEPTH` WPE 也恒定义，这里有意不定义：WebGPU 没有几何着色器，粒子走顶点着色器展开四角；深度也不是反向的。
/// `HLSL_GS40_DISABLED` 不能定义：WPE 没有这个宏，`shimmering_particles` 的 `particle.vert` 定义后走给几何着色器准备输入的分支，顶点不经过 MVP。
const PLATFORM_DEFINES: &[(&str, &str)] =
    &[("HLSL", "1"), ("HLSL_SM40", "1"), ("SHADERVERSION", "69")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Vertex,
    Fragment,
}

/// 一次翻译请求（一个材质 pass 的着色器对）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    pub vertex: String,
    pub fragment: String,
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
    let missing: BTreeSet<String> = stages
        .iter()
        .flat_map(|pp| pp.missing.iter().cloned())
        .collect();
    if !missing.is_empty() {
        return TranslateResult {
            missing: missing.into_iter().collect(),
            ..TranslateResult::failure("include", None, vec![])
        };
    }
    let requires: BTreeSet<String> = stages
        .iter()
        .flat_map(|pp| pp.requires.iter().cloned())
        .collect();
    if !requires.is_empty() {
        return TranslateResult {
            requires: requires.into_iter().collect(),
            ..TranslateResult::failure("require", None, vec![])
        };
    }

    // 4. 改写成 GLSL 450
    let program = match rewrite::build(&stages[0].lines, &stages[1].lines) {
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

    // 5. naga 编译两段
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
                    Stage::Vertex => result.vertex = Some(output),
                    Stage::Fragment => result.fragment = Some(output),
                }
                return result;
            }
        }
    }
    let (vs, fs) = (&outputs[0], &outputs[1]);

    // 6. 反射：两阶段的 uniform 块是同一份声明，取先有的那一侧
    let block = if vs.block.is_empty() {
        &fs.block
    } else {
        &vs.block
    };
    let uniforms = program
        .uniforms
        .iter()
        .filter_map(|uniform| {
            let layout = block.get(&rewrite::block_member_name(uniform))?;
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
}
