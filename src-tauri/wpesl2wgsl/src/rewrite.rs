//! 把预处理后的 WPESL 改写成 naga 能接的 Vulkan GLSL 450：
//! - 全局声明：普通 uniform 并成一个 std140 uniform 块（顶点 / 片元两阶段同一份、同一顺序，共用一块缓冲）；
//!   `sampler*` 拆成纹理 + 采样器，按 `g_Texture<n>` 的 n 固定绑定号；`attribute` / `varying` 加 `layout(location)`，
//!   varying 的 location 在两阶段之间统一分配。
//! - 正文：`texSample2D` 系列改成 `texture(sampler2D(t, s), …)`；`gl_FragColor` 等内建换成 Vulkan GLSL 写法；
//!   与 GLSL 450 保留字冲突的标识符改名；精度限定符去掉；其余 HLSL 风格内建由 [`MACRO_HEADER`] 的宏补上
//!   （照 WPE 自己翻 HLSL 时的宏头一一对应）。

use std::collections::BTreeMap;

use crate::preprocess::{parse_json_object, split_ident, Line};
use crate::Stage;

/// WPE 方言里的 HLSL 风格内建 → GLSL。WPE 在 Windows 上翻成 HLSL 时也是一张宏头（`#define frac frac`、
/// `#define mix lerp` 方向相反），这里是镜像。`mul(v, M)` 是行向量左乘，GLSL 里写成 `M * v`。
pub const MACRO_HEADER: &str = "\
#define mul(a, b) ((b) * (a))
#define frac fract
#define lerp mix
#define atan2 atan
#define saturate(x) clamp((x), 0.0, 1.0)
#define ddx dFdx
#define ddy dFdy
#define rsqrt inversesqrt
#define fmod(x, y) ((x) - (y) * trunc((x) / (y)))
#define log10(x) (log2(x) * 0.30102999566398120)
#define clip(x) if ((x) < 0.0) discard
#define CASTF(x) float(x)
#define CASTI(x) int(x)
#define CASTU(x) uint(x)
#define CAST2(x) vec2(x)
#define CAST3(x) vec3(x)
#define CAST4(x) vec4(x)
#define CAST4U(x) uvec4(x)
#define CAST3X3(x) mat3(x)
";

/// GLSL 450 的保留字里，WPE 作者拿来当变量名的（HLSL 下合法）。改成 `kb_<名字>`。
const RESERVED_RENAMES: &[&str] = &[
    "sample",
    "input",
    "output",
    "buffer",
    "smooth",
    "flat",
    "filter",
    "active",
    "common",
    "partition",
    "shared",
    "half",
    "fixed",
    "packed",
    "patch",
    "resource",
    "precise",
    "texture",
    "superp",
];

/// uniform 块固定在 group 0 / binding 0；纹理 n 在 binding 1 + 2n，其采样器在 2 + 2n。
pub const UNIFORM_BINDING: u32 = 0;

pub fn texture_binding(slot: u32) -> u32 {
    1 + 2 * slot
}

pub fn sampler_binding(slot: u32) -> u32 {
    2 + 2 * slot
}

fn sampler_name(texture: &str) -> String {
    format!("kb_sampler_{texture}")
}

#[derive(Debug, Clone)]
pub struct RewriteError {
    pub stage: Stage,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureKind {
    D2,
    D2Comparison,
    D3,
    Cube,
}

impl TextureKind {
    fn parse(ty: &str) -> Option<Self> {
        match ty {
            "sampler2D" => Some(Self::D2),
            "sampler2DComparison" | "sampler2DShadow" => Some(Self::D2Comparison),
            "sampler3D" => Some(Self::D3),
            "samplerCube" => Some(Self::Cube),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::D2 => "2d",
            Self::D2Comparison => "2d-comparison",
            Self::D3 => "3d",
            Self::Cube => "cube",
        }
    }

    fn glsl_texture(self) -> &'static str {
        match self {
            Self::D2 | Self::D2Comparison => "texture2D",
            Self::D3 => "texture3D",
            Self::Cube => "textureCube",
        }
    }

    fn glsl_sampler(self) -> &'static str {
        match self {
            Self::D2Comparison => "samplerShadow",
            _ => "sampler",
        }
    }

    fn combined(self) -> &'static str {
        match self {
            Self::D2 => "sampler2D",
            Self::D2Comparison => "sampler2DShadow",
            Self::D3 => "sampler3D",
            Self::Cube => "samplerCube",
        }
    }
}

#[derive(Debug, Clone)]
pub struct UniformDecl {
    pub name: String,
    pub ty: String,
    pub array: Option<u32>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct TextureDecl {
    pub slot: u32,
    pub name: String,
    pub kind: TextureKind,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct InterfaceDecl {
    pub name: String,
    pub ty: String,
    pub array: Option<u32>,
    pub location: u32,
}

/// 两阶段改写后的程序：共用的 uniform 块与纹理表，以及各自的 GLSL 450 源码。
#[derive(Debug, Clone)]
pub struct Program {
    pub uniforms: Vec<UniformDecl>,
    pub textures: Vec<TextureDecl>,
    pub attributes: Vec<InterfaceDecl>,
    pub varyings: Vec<InterfaceDecl>,
    pub vertex_glsl: String,
    pub fragment_glsl: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Storage {
    Uniform,
    Attribute,
    Varying,
}

#[derive(Debug, Clone)]
struct Decl {
    storage: Storage,
    ty: String,
    name: String,
    array: Option<u32>,
}

/// 一个阶段拆成：全局声明 + 其余正文行。
struct StageParts {
    decls: Vec<(Decl, Option<serde_json::Value>)>,
    body: Vec<String>,
}

pub fn build(vertex: &[Line], fragment: &[Line]) -> Result<Program, RewriteError> {
    let vs = split_stage(Stage::Vertex, vertex)?;
    let fs = split_stage(Stage::Fragment, fragment)?;

    let mut uniforms: Vec<UniformDecl> = Vec::new();
    let mut textures: BTreeMap<u32, TextureDecl> = BTreeMap::new();
    let mut attributes: Vec<InterfaceDecl> = Vec::new();
    let mut varyings: Vec<InterfaceDecl> = Vec::new();
    let mut next_attribute = 0;
    let mut next_varying = 0;

    for (stage, parts) in [(Stage::Vertex, &vs), (Stage::Fragment, &fs)] {
        let fail = |message: String| RewriteError {
            stage,
            message,
            file: None,
            line: None,
        };
        for (decl, meta) in &parts.decls {
            match decl.storage {
                Storage::Uniform => {
                    if let Some(kind) = TextureKind::parse(&decl.ty) {
                        let slot = decl
                            .name
                            .strip_prefix("g_Texture")
                            .and_then(|n| n.parse::<u32>().ok())
                            .ok_or_else(|| {
                                fail(format!("采样器 {} 不是 g_Texture<n> 形式", decl.name))
                            })?;
                        match textures.get(&slot) {
                            Some(existing) if existing.kind != kind => {
                                return Err(fail(format!("g_Texture{slot} 在两个阶段的类型不同")));
                            }
                            Some(_) => {}
                            None => {
                                textures.insert(
                                    slot,
                                    TextureDecl {
                                        slot,
                                        name: decl.name.clone(),
                                        kind,
                                        meta: meta.clone(),
                                    },
                                );
                            }
                        }
                    } else if decl.ty.starts_with("sampler") {
                        return Err(fail(format!("不支持的采样器类型 {}", decl.ty)));
                    } else {
                        if !is_builtin_type(&decl.ty) {
                            return Err(fail(format!(
                                "uniform {} 的类型 {} 不是内建类型",
                                decl.name, decl.ty
                            )));
                        }
                        match uniforms.iter_mut().find(|u| u.name == decl.name) {
                            Some(existing)
                                if existing.ty != decl.ty || existing.array != decl.array =>
                            {
                                return Err(fail(format!(
                                    "uniform {} 在两个阶段的类型不同",
                                    decl.name
                                )));
                            }
                            Some(existing) => {
                                if existing.meta.is_none() {
                                    existing.meta = meta.clone();
                                }
                            }
                            None => uniforms.push(UniformDecl {
                                name: decl.name.clone(),
                                ty: decl.ty.clone(),
                                array: decl.array,
                                meta: meta.clone(),
                            }),
                        }
                    }
                }
                Storage::Attribute => {
                    if stage != Stage::Vertex {
                        return Err(fail(format!("片元着色器里出现 attribute {}", decl.name)));
                    }
                    attributes.push(InterfaceDecl {
                        name: decl.name.clone(),
                        ty: decl.ty.clone(),
                        array: decl.array,
                        location: next_attribute,
                    });
                    next_attribute += location_slots(&decl.ty, decl.array);
                }
                Storage::Varying => match varyings.iter().find(|v| v.name == decl.name) {
                    Some(existing) if existing.ty != decl.ty || existing.array != decl.array => {
                        return Err(fail(format!("varying {} 在两个阶段的类型不同", decl.name)));
                    }
                    Some(_) => {}
                    // 只在片元阶段声明的 varying（如 fade.frag 的 v_TexCoord）也分配 location：
                    // 顶点阶段渲染全部 varying，没写的输出是零（WGSL 私有变量零初始化），对应 D3D 下的未定义值；
                    // 否则 WebGPU 建管线会因片元输入没有对应的顶点输出而失败。
                    None => {
                        varyings.push(InterfaceDecl {
                            name: decl.name.clone(),
                            ty: decl.ty.clone(),
                            array: decl.array,
                            location: next_varying,
                        });
                        next_varying += location_slots(&decl.ty, decl.array);
                    }
                },
            }
        }
    }

    let textures: Vec<TextureDecl> = textures.into_values().collect();
    let vertex_glsl = render(
        Stage::Vertex,
        &vs,
        &uniforms,
        &textures,
        &attributes,
        &varyings,
    )?;
    let fragment_glsl = render(
        Stage::Fragment,
        &fs,
        &uniforms,
        &textures,
        &attributes,
        &varyings,
    )?;
    Ok(Program {
        uniforms,
        textures,
        attributes,
        varyings,
        vertex_glsl,
        fragment_glsl,
    })
}

fn split_stage(stage: Stage, lines: &[Line]) -> Result<StageParts, RewriteError> {
    let mut decls = Vec::new();
    let mut body = Vec::new();
    for line in lines {
        let trimmed = line.code.trim();
        let keyword = split_ident(trimmed).0;
        // `in uint gl_InstanceID;`：fur4 在 HLSL 分支里声明的内建，GLSL 450 本来就有
        if keyword == "in" && trimmed.contains(" gl_") {
            continue;
        }
        let storage = match keyword {
            "uniform" => Storage::Uniform,
            "attribute" => Storage::Attribute,
            "varying" => Storage::Varying,
            _ => {
                body.push(line.code.clone());
                continue;
            }
        };
        let parsed = parse_decl(storage, trimmed).map_err(|message| RewriteError {
            stage,
            message,
            file: Some(line.file.clone()),
            line: Some(line.line),
        })?;
        let meta = line.comment.as_deref().and_then(parse_json_object);
        // `varying uint gl_ViewportIndex;` 这类是几何着色器路径遗留的内建声明，不是接口变量
        for decl in parsed
            .into_iter()
            .filter(|decl| !decl.name.starts_with("gl_"))
        {
            decls.push((decl, meta.clone()));
        }
    }
    Ok(StageParts { decls, body })
}

/// `uniform [lowp] vec3 a, b[4];`：只接受一行内写完的声明，带初始值或跨行的直接报错。
fn parse_decl(storage: Storage, text: &str) -> Result<Vec<Decl>, String> {
    let Some(body) = text.strip_suffix(';') else {
        return Err(format!("全局声明没有在本行结束：{text}"));
    };
    let mut rest = split_ident(body).1.trim_start();
    let mut ty = "";
    while !rest.is_empty() {
        let (word, after) = split_ident(rest);
        if word.is_empty() {
            return Err(format!("无法解析的全局声明：{text}"));
        }
        rest = after.trim_start();
        if matches!(word, "lowp" | "mediump" | "highp" | "const") {
            continue;
        }
        ty = word;
        break;
    }
    if ty.is_empty() {
        return Err(format!("全局声明缺少类型：{text}"));
    }
    let mut decls = Vec::new();
    for part in rest.split(',') {
        let part = part.trim();
        let (name, after) = split_ident(part);
        if name.is_empty() {
            return Err(format!("全局声明缺少名字：{text}"));
        }
        let after = after.trim();
        let array = if after.is_empty() {
            None
        } else if let Some(size) = after.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            Some(
                size.trim()
                    .parse::<u32>()
                    .map_err(|_| format!("数组长度不是整数：{text}"))?,
            )
        } else {
            return Err(format!("不支持的全局声明（带初始值或限定符）：{text}"));
        };
        decls.push(Decl {
            storage,
            ty: ty.to_string(),
            name: rename(name),
            array,
        });
    }
    Ok(decls)
}

fn is_builtin_type(ty: &str) -> bool {
    matches!(
        ty,
        "float"
            | "int"
            | "uint"
            | "bool"
            | "vec2"
            | "vec3"
            | "vec4"
            | "ivec2"
            | "ivec3"
            | "ivec4"
            | "uvec2"
            | "uvec3"
            | "uvec4"
            | "bvec2"
            | "bvec3"
            | "bvec4"
            | "mat2"
            | "mat3"
            | "mat4"
            | "mat2x2"
            | "mat2x3"
            | "mat2x4"
            | "mat3x2"
            | "mat3x3"
            | "mat3x4"
            | "mat4x2"
            | "mat4x3"
            | "mat4x4"
    )
}

fn is_integer_type(ty: &str) -> bool {
    matches!(
        ty,
        "int" | "uint" | "ivec2" | "ivec3" | "ivec4" | "uvec2" | "uvec3" | "uvec4"
    )
}

/// 一个 attribute / varying 占几个 location：矩阵按列数，数组乘以长度。
fn location_slots(ty: &str, array: Option<u32>) -> u32 {
    let columns = match ty {
        "mat2" | "mat2x2" | "mat2x3" | "mat2x4" => 2,
        "mat3" | "mat3x2" | "mat3x3" | "mat3x4" => 3,
        "mat4" | "mat4x2" | "mat4x3" | "mat4x4" => 4,
        _ => 1,
    };
    columns * array.unwrap_or(1)
}

/// std140 的数组元素步长是 16，但 WGSL 的 `array<f32, N>` 步长固定是 4，而 uniform 地址空间要求步长为 16 的倍数：
/// 标量 / 二三分量向量的数组写不成合法的 WGSL。这类数组在块里改成四分量向量数组（内存布局与 std140 完全相同），
/// 返回（块里的类型, 还原用的分量）。
fn padded_array(ty: &str) -> Option<(&'static str, &'static str)> {
    match ty {
        "float" => Some(("vec4", "x")),
        "vec2" => Some(("vec4", "xy")),
        "vec3" => Some(("vec4", "xyz")),
        "int" => Some(("ivec4", "x")),
        "ivec2" => Some(("ivec4", "xy")),
        "ivec3" => Some(("ivec4", "xyz")),
        "uint" => Some(("uvec4", "x")),
        "uvec2" => Some(("uvec4", "xy")),
        "uvec3" => Some(("uvec4", "xyz")),
        _ => None,
    }
}

/// uniform 在块里的类型：需要补齐的数组换成四分量向量。
pub fn block_type(uniform: &UniformDecl) -> &str {
    match (uniform.array, padded_array(&uniform.ty)) {
        (Some(_), Some((padded, _))) => padded,
        _ => &uniform.ty,
    }
}

/// uniform 在块里的成员名：补齐过的数组改名为 `kb_u_<名字>`，原名字留给还原函数的宏。
pub fn block_member_name(uniform: &UniformDecl) -> String {
    match (uniform.array, padded_array(&uniform.ty)) {
        (Some(_), Some(_)) => format!("kb_u_{}", uniform.name),
        _ => uniform.name.clone(),
    }
}

fn array_suffix(array: Option<u32>) -> String {
    array.map(|n| format!("[{n}]")).unwrap_or_default()
}

fn render(
    stage: Stage,
    parts: &StageParts,
    uniforms: &[UniformDecl],
    textures: &[TextureDecl],
    attributes: &[InterfaceDecl],
    varyings: &[InterfaceDecl],
) -> Result<String, RewriteError> {
    let mut out = String::from("#version 450\n");
    out.push_str(MACRO_HEADER);
    if !uniforms.is_empty() {
        out.push_str("layout(set = 0, binding = 0, std140) uniform KbUniforms {\n");
        for uniform in uniforms {
            out.push_str(&format!(
                "    {} {}{};\n",
                block_type(uniform),
                block_member_name(uniform),
                array_suffix(uniform.array)
            ));
        }
        out.push_str("};\n");
        // 补齐过的数组：用函数还原成原类型，再让原名字指过去（下标访问与整体传参都照常可用）
        for uniform in uniforms {
            let (Some(count), Some((_, swizzle))) = (uniform.array, padded_array(&uniform.ty))
            else {
                continue;
            };
            out.push_str(&format!(
                "{ty}[{count}] kb_load_{name}() {{ {ty} r[{count}]; for (int i = 0; i < {count}; i++) {{ r[i] = kb_u_{name}[i].{swizzle}; }} return r; }}\n#define {name} kb_load_{name}()\n",
                ty = uniform.ty,
                name = uniform.name,
            ));
        }
    }
    for texture in textures {
        out.push_str(&format!(
            "layout(set = 0, binding = {}) uniform {} {};\nlayout(set = 0, binding = {}) uniform {} {};\n",
            texture_binding(texture.slot),
            texture.kind.glsl_texture(),
            texture.name,
            sampler_binding(texture.slot),
            texture.kind.glsl_sampler(),
            sampler_name(&texture.name),
        ));
    }
    let declared: Vec<&str> = parts
        .decls
        .iter()
        .map(|(decl, _)| decl.name.as_str())
        .collect();
    match stage {
        Stage::Vertex => {
            for attribute in attributes {
                out.push_str(&format!(
                    "layout(location = {}) in {} {}{};\n",
                    attribute.location,
                    attribute.ty,
                    attribute.name,
                    array_suffix(attribute.array)
                ));
            }
        }
        Stage::Fragment => out.push_str("layout(location = 0) out vec4 kb_FragColor;\n"),
    }
    // 顶点阶段输出全部 varying（包括只在片元阶段声明的），片元阶段只声明自己用的
    let direction = if stage == Stage::Vertex { "out" } else { "in" };
    for varying in varyings
        .iter()
        .filter(|v| stage == Stage::Vertex || declared.contains(&v.name.as_str()))
    {
        let flat = if is_integer_type(&varying.ty) {
            "flat "
        } else {
            ""
        };
        out.push_str(&format!(
            "layout(location = {}) {flat}{direction} {} {}{};\n",
            varying.location,
            varying.ty,
            varying.name,
            array_suffix(varying.array)
        ));
    }

    let body = rewrite_identifiers(stage, &parts.body.join("\n"));
    let body = rewrite_texture_calls(&body, textures).map_err(|message| RewriteError {
        stage,
        message,
        file: None,
        line: None,
    })?;
    out.push_str(&broadcast_helpers(&body));
    out.push_str(&body);
    out.push('\n');
    Ok(out)
}

/// HLSL 会把标量自动扩展成向量（`pow(v3, 2.4)`、`max(0, v3)`），GLSL 没有这些重载。
/// 正文用到 `pow` / `max` / `min` 时，补一组覆盖原有重载与「标量扩展」的辅助函数，再用宏把调用指过去
/// （辅助函数体在宏之前定义，里面的 `pow` 仍是内建）。
fn broadcast_helpers(body: &str) -> String {
    const FLOAT_VECTORS: [&str; 3] = ["vec2", "vec3", "vec4"];
    const SAME_TYPE: [&str; 12] = [
        "float", "vec2", "vec3", "vec4", "int", "ivec2", "ivec3", "ivec4", "uint", "uvec2",
        "uvec3", "uvec4",
    ];
    const VECTOR_SCALAR: [(&str, &str); 9] = [
        ("vec2", "float"),
        ("vec3", "float"),
        ("vec4", "float"),
        ("ivec2", "int"),
        ("ivec3", "int"),
        ("ivec4", "int"),
        ("uvec2", "uint"),
        ("uvec3", "uint"),
        ("uvec4", "uint"),
    ];
    let mut out = String::new();
    if calls(body, "pow") {
        for ty in ["float", "vec2", "vec3", "vec4"] {
            out.push_str(&format!(
                "{ty} kb_pow({ty} a, {ty} b) {{ return pow(a, b); }}\n"
            ));
        }
        for ty in FLOAT_VECTORS {
            out.push_str(&format!(
                "{ty} kb_pow({ty} a, float b) {{ return pow(a, {ty}(b)); }}\n"
            ));
        }
        out.push_str("#define pow kb_pow\n");
    }
    for function in ["max", "min"] {
        if !calls(body, function) {
            continue;
        }
        for ty in SAME_TYPE {
            out.push_str(&format!(
                "{ty} kb_{function}({ty} a, {ty} b) {{ return {function}(a, b); }}\n"
            ));
        }
        for (vector, scalar) in VECTOR_SCALAR {
            out.push_str(&format!(
                "{vector} kb_{function}({vector} a, {scalar} b) {{ return {function}(a, b); }}\n"
            ));
            out.push_str(&format!(
                "{vector} kb_{function}({scalar} a, {vector} b) {{ return {function}({vector}(a), b); }}\n"
            ));
        }
        out.push_str(&format!("#define {function} kb_{function}\n"));
    }
    out
}

/// 正文里是否以函数调用形式用到 `name`（标识符后紧跟 `(`）。
fn calls(body: &str, name: &str) -> bool {
    let mut rest = body;
    while let Some(at) = rest.find(name) {
        let before = rest[..at].chars().next_back();
        let after = rest[at + name.len()..].trim_start();
        let boundary = before.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if boundary && after.starts_with('(') {
            return true;
        }
        rest = &rest[at + name.len()..];
    }
    false
}

fn rename(name: &str) -> String {
    if RESERVED_RENAMES.contains(&name) {
        format!("kb_{name}")
    } else {
        name.to_string()
    }
}

/// 按标识符逐个替换：保留字改名、内建换名、去掉精度限定符。
fn rewrite_identifiers(stage: Stage, body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        let c = rest.chars().next().expect("non-empty");
        if c.is_ascii_alphabetic() || c == '_' {
            let (ident, after) = split_ident(rest);
            let replaced = match ident {
                "gl_FragColor" if stage == Stage::Fragment => "kb_FragColor".to_string(),
                "gl_VertexID" => "gl_VertexIndex".to_string(),
                "gl_InstanceID" => "gl_InstanceIndex".to_string(),
                "lowp" | "mediump" | "highp" => String::new(),
                other => rename(other),
            };
            out.push_str(&replaced);
            rest = after;
        } else if c.is_ascii_digit() {
            // 数字字面量整体拷贝，避免把 `1e10` 的 `e10` 当成标识符
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            out.push_str(&rest[..end]);
            rest = &rest[end..];
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// `texSample2D(t, uv)` 系列 → `texture(sampler2D(t, kb_sampler_t), uv)` 等；参数里嵌套的调用一并改写。
fn rewrite_texture_calls(body: &str, textures: &[TextureDecl]) -> Result<String, String> {
    const FUNCTIONS: &[&str] = &[
        "texSample2DBackBuffer",
        "texSample2DCompare",
        "texSample2DLod",
        "texSample2D",
        "texSample3D",
        "texLoad2D",
    ];
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        let c = rest.chars().next().expect("non-empty");
        if !(c.is_ascii_alphabetic() || c == '_') {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let (ident, after) = split_ident(rest);
        let Some(function) = FUNCTIONS.iter().find(|f| **f == ident) else {
            out.push_str(ident);
            rest = after;
            continue;
        };
        let open = after.trim_start();
        if !open.starts_with('(') {
            out.push_str(ident);
            rest = after;
            continue;
        }
        let (args, remaining) =
            split_call_args(&open[1..]).ok_or_else(|| format!("{function} 的括号没有闭合"))?;
        let args = args
            .iter()
            .map(|arg| rewrite_texture_calls(arg, textures))
            .collect::<Result<Vec<_>, _>>()?;
        let texture_name = args.first().map(|a| a.trim()).unwrap_or_default();
        let Some(texture) = textures.iter().find(|t| t.name == texture_name) else {
            return Err(format!(
                "{function} 的第一个参数不是已声明的纹理：{texture_name}"
            ));
        };
        let combined = format!(
            "{}({}, {})",
            texture.kind.combined(),
            texture.name,
            sampler_name(&texture.name)
        );
        let arg = |i: usize| {
            args.get(i)
                .map(|a| a.trim().to_string())
                .ok_or_else(|| format!("{function} 参数不足"))
        };
        let call = match *function {
            "texSample2D" | "texSample3D" | "texSample2DBackBuffer" => {
                format!("texture({combined}, {})", arg(1)?)
            }
            "texSample2DLod" => format!("textureLod({combined}, {}, {})", arg(1)?, arg(2)?),
            "texSample2DCompare" => format!("texture({combined}, vec3({}, {}))", arg(1)?, arg(2)?),
            // texLoad2D(t, uv, resolution)：按分辨率换算成整数像素坐标取 mip 0
            _ => format!(
                "texelFetch({combined}, ivec2(({}) * ({})), 0)",
                arg(1)?,
                arg(2)?
            ),
        };
        out.push_str(&call);
        rest = remaining;
    }
    Ok(out)
}

/// 从 `(` 之后切出顶层逗号分隔的参数，返回（参数列表, `)` 之后的剩余文本）。
fn split_call_args(text: &str) -> Option<(Vec<String>, &str)> {
    let mut depth = 0usize;
    let mut args = Vec::new();
    let mut start = 0;
    for (at, c) in text.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' if depth > 0 => depth -= 1,
            ')' => {
                args.push(text[start..at].to_string());
                return Some((args, &text[at + 1..]));
            }
            ',' if depth == 0 => {
                args.push(text[start..at].to_string());
                start = at + 1;
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(source: &str) -> Vec<Line> {
        source
            .lines()
            .enumerate()
            .map(|(i, raw)| {
                let (code, comment) = crate::preprocess::split_line_comment(raw);
                Line {
                    code,
                    comment,
                    file: "<t>".into(),
                    line: i as u32 + 1,
                }
            })
            .collect()
    }

    const VS: &str = "uniform mat4 g_ModelViewProjectionMatrix;\nuniform float g_Time;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvarying vec4 v_Extra;\nvoid main() { gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); v_TexCoord = a_TexCoord; v_Extra = vec4(g_Time); }";
    const FS: &str = "uniform sampler2D g_Texture0;\nuniform float g_Time;\nuniform vec3 g_Color1; // {\"material\":\"color1\",\"default\":\"0 0 0\"}\nvarying vec2 v_TexCoord;\nvoid main() { vec4 sample = texSample2D(g_Texture0, v_TexCoord.xy); gl_FragColor = sample * vec4(g_Color1, 1); }";

    #[test]
    fn uniforms_merge_and_varyings_share_locations() {
        let program = build(&lines(VS), &lines(FS)).unwrap();
        let names: Vec<_> = program.uniforms.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, ["g_ModelViewProjectionMatrix", "g_Time", "g_Color1"]);
        assert_eq!(
            program.uniforms[2].meta.as_ref().unwrap()["material"],
            "color1"
        );
        assert_eq!(program.textures[0].slot, 0);
        assert!(program
            .vertex_glsl
            .contains("layout(location = 0) out vec2 v_TexCoord;"));
        assert!(program
            .fragment_glsl
            .contains("layout(location = 0) in vec2 v_TexCoord;"));
        // 片元阶段没声明 v_Extra，不出现
        assert!(!program.fragment_glsl.contains("v_Extra"));
        // 两阶段同一份 uniform 块
        let block = |glsl: &str| {
            glsl[glsl.find("uniform KbUniforms").unwrap()..glsl.find("};").unwrap()].to_string()
        };
        assert_eq!(block(&program.vertex_glsl), block(&program.fragment_glsl));
    }

    #[test]
    fn body_rewrites_textures_builtins_and_reserved_names() {
        let program = build(&lines(VS), &lines(FS)).unwrap();
        let fs = &program.fragment_glsl;
        assert!(fs.contains("vec4 kb_sample = texture(sampler2D(g_Texture0, kb_sampler_g_Texture0), v_TexCoord.xy);"), "{fs}");
        assert!(fs.contains("kb_FragColor = kb_sample"));
        assert!(fs.contains("layout(set = 0, binding = 2) uniform sampler kb_sampler_g_Texture0;"));
    }

    #[test]
    fn nested_and_variant_texture_calls() {
        let textures = [
            TextureDecl {
                slot: 0,
                name: "g_Texture0".into(),
                kind: TextureKind::D2,
                meta: None,
            },
            TextureDecl {
                slot: 6,
                name: "g_Texture6".into(),
                kind: TextureKind::D2Comparison,
                meta: None,
            },
        ];
        let out = rewrite_texture_calls(
            "texSample2DLod(g_Texture0, uv + texSample2D(g_Texture0, uv).xy, 0.0) + texSample2DCompare(g_Texture6, uv, d)",
            &textures,
        )
        .unwrap();
        assert_eq!(
            out,
            "textureLod(sampler2D(g_Texture0, kb_sampler_g_Texture0), uv + texture(sampler2D(g_Texture0, kb_sampler_g_Texture0), uv).xy, 0.0) + texture(sampler2DShadow(g_Texture6, kb_sampler_g_Texture6), vec3(uv, d))"
        );
        assert!(rewrite_texture_calls("texSample2D(tex, uv)", &textures).is_err());
    }

    #[test]
    fn fragment_only_varying_gets_a_vertex_output() {
        let program = build(
            &lines("void main() {}"),
            &lines("varying vec2 v_X;\nvoid main() {}"),
        )
        .unwrap();
        assert!(program
            .vertex_glsl
            .contains("layout(location = 0) out vec2 v_X;"));
        assert!(program
            .fragment_glsl
            .contains("layout(location = 0) in vec2 v_X;"));
    }

    #[test]
    fn broadcast_helpers_only_when_called() {
        let helpers = broadcast_helpers("x = pow(v, 2.0); y = smin(a, b);");
        assert!(helpers.contains("vec3 kb_pow(vec3 a, float b)"));
        assert!(helpers.ends_with("#define pow kb_pow\n"));
        assert!(!helpers.contains("kb_min"));
    }

    #[test]
    fn integer_varyings_are_flat_and_matrices_take_columns() {
        let vs =
            "attribute mat4 a_M;\nattribute vec2 a_UV;\nvarying uvec4 v_Bones;\nvoid main() {}";
        let program = build(&lines(vs), &lines("varying uvec4 v_Bones;\nvoid main() {}")).unwrap();
        assert_eq!(program.attributes[1].location, 4);
        assert!(program
            .fragment_glsl
            .contains("layout(location = 0) flat in uvec4 v_Bones;"));
    }
}
