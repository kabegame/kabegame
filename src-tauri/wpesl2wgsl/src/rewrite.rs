//! 把预处理后的 WPESL 改写成 naga 能接的 Vulkan GLSL 450：
//! - 全局声明：普通 uniform 并成一个 std140 uniform 块（顶点 / 片元两阶段同一份、同一顺序，共用一块缓冲）；
//!   两阶段同名、取值来源不同的 uniform 拆成两格，一侧改名（[`merge_uniforms`]）；
//!   `sampler*` 拆成纹理 + 采样器，按 `g_Texture<n>` 的 n 固定绑定号；`attribute` / `varying` 加 `layout(location)`，
//!   varying 的 location 在两阶段之间统一分配。
//! - 正文：`texSample2D` 系列改成 `texture(sampler2D(t, s), …)`；`gl_FragColor` 等内建换成 Vulkan GLSL 写法；
//!   与 GLSL 450 保留字冲突的标识符改名；精度限定符去掉；其余 HLSL 风格内建由 [`MACRO_HEADER`] 的宏补上
//!   （照 WPE 自己翻 HLSL 时的宏头一一对应）。

use std::collections::{BTreeMap, BTreeSet};

use crate::pack;
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
    /// 块里的成员名；拆分后改了名的一侧是新名字（原名见 `original`）。
    pub name: String,
    pub ty: String,
    pub array: Option<u32>,
    pub meta: Option<serde_json::Value>,
    /// 两阶段同名、取值来源不同而拆开时，这一格只属于哪个阶段（两半各标自己的阶段）；合并的或只在一个阶段声明的为 None。
    pub stage: Option<Stage>,
    /// 拆分后改了名的一侧：着色器里写的原名。
    pub original: Option<String>,
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
    /// 几何着色器展开拼成的顶点段：`main` 是生成的，顶点段与几何段各自的 `main` 已改名，
    /// 「`main` 签名之前」在这里没有 WPE 的含义，不做打包形态（[`pack`]）。绳着色器没有这类数组。
    merged_geometry: bool,
}

pub fn build(vertex: &[Line], fragment: &[Line]) -> Result<Program, RewriteError> {
    let vs = split_stage(Stage::Vertex, vertex)?;
    let fs = split_stage(Stage::Fragment, fragment)?;

    // 普通 uniform 先按阶段各自收集（同阶段的重复声明合并），再跨阶段合并或拆分
    let mut stage_uniforms: [Vec<UniformDecl>; 2] = [Vec::new(), Vec::new()];
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
                        let list = &mut stage_uniforms[stage_index(stage)];
                        match list.iter_mut().find(|u| u.name == decl.name) {
                            Some(existing)
                                if existing.ty != decl.ty || existing.array != decl.array =>
                            {
                                return Err(fail(format!(
                                    "uniform {} 在同一阶段重复声明且类型不同",
                                    decl.name
                                )));
                            }
                            // 同一阶段重复声明（头文件与正文各写一次）：照旧合并，注解取第一个非空的
                            Some(existing) => {
                                if existing.meta.is_none() {
                                    existing.meta = meta.clone();
                                }
                            }
                            None => list.push(UniformDecl {
                                name: decl.name.clone(),
                                ty: decl.ty.clone(),
                                array: decl.array,
                                meta: meta.clone(),
                                stage: None,
                                original: None,
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
    // 改名不能撞上两阶段里已有的任何标识符（声明名、正文里的局部变量 / 函数 / 宏）
    let mut taken: BTreeSet<String> = [&vs, &fs]
        .iter()
        .flat_map(|parts| {
            parts
                .decls
                .iter()
                .map(|(decl, _)| decl.name.clone())
                .chain(identifiers(&parts.body.join("\n")))
        })
        .collect();
    let [vertex_uniforms, fragment_uniforms] = stage_uniforms;
    let (uniforms, renames) = merge_uniforms(vertex_uniforms, fragment_uniforms, &mut taken)?;
    let vertex_glsl = render(
        Stage::Vertex,
        &vs,
        &uniforms,
        &renames[stage_index(Stage::Vertex)],
        &textures,
        &attributes,
        &varyings,
    )?;
    let fragment_glsl = render(
        Stage::Fragment,
        &fs,
        &uniforms,
        &renames[stage_index(Stage::Fragment)],
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

fn stage_index(stage: Stage) -> usize {
    match stage {
        // 几何段已拼进顶点段，不会单独到这里
        Stage::Vertex | Stage::Geometry => 0,
        Stage::Fragment => 1,
    }
}

/// uniform 的取值来源，决定两阶段的同名 uniform 能不能共用一格。
///
/// WPE 在 D3D11 下每个阶段有自己的常量缓冲，但材质常量按**材质键**只有一份存储（vector-constant-REPORT.md 2.1）：
/// - 键不同（`3829603837` 的 foliagesway：顶点 `g_Speed` 是 `speed`，片元 `g_Speed` 是 `speeduv`，缺省 5）是两份存储，
///   两阶段读到的值不同，要拆成两格；
/// - 键相同、缺省不同（foliagesway 的 `g_Phase`）也只有一份：合并表里片元覆盖顶点，缺省只插一份，
///   两阶段都读片元的缺省（报告第 6 节 `stage-def` 实测 0.8 / 0.8）。所以来源只比材质键。
///
/// 没有注解，或注解里没有字符串 `material`（只有 `label` / `hidden` 等）：引擎按名字写入的值，来源相同。
/// 宿主同样只认字符串 `material`（`shader.ts` 按它分组，能力表把没有的当引擎 uniform），这里与之一致。
#[derive(Debug, Clone, PartialEq)]
enum ValueSource {
    Engine,
    Material(String),
}

fn material_key(meta: &Option<serde_json::Value>) -> Option<&str> {
    meta.as_ref()?
        .get("material")
        .and_then(serde_json::Value::as_str)
}

fn value_source(meta: &Option<serde_json::Value>) -> ValueSource {
    material_key(meta).map_or(ValueSource::Engine, |key| {
        ValueSource::Material(key.to_string())
    })
}

/// 每个阶段的改名表（拆分后改名的 uniform，原名 → 新名），按 [`stage_index`] 取。
type StageRenames = [BTreeMap<String, String>; 2];

/// 两阶段各自的 uniform 合成一个块，返回块成员与每个阶段的改名表。
///
/// 两阶段同名的非采样器 uniform：
/// - 类型相同、取值来源（[`ValueSource`]）相同：合并成一格。材质常量的注解取片元的（WPE 合并表里片元覆盖顶点，
///   缺省值取片元的，报告 2.1 / 第 6 节）；引擎值的注解照旧取顶点的（顶点没有时取片元的），宿主不读。
/// - 同一个材质键而类型不同：WGSL 里一格只能有一种类型，照旧拆成两格。WPE 只有一份按片元类型写的存储、
///   各阶段按自己的类型从同一个槽拷分量（报告 2.2）；宿主按两半的 `stage` 复刻：setter 的类型与缺省值取片元那一半，
///   顶点那一半比片元多出的分量会读到下一个常量的存储，宿主报不支持。
/// - 类型或取值来源不同：拆成两格，各带自己的类型与注解；其中一侧在自己的源码里改名为 `kb_vs_<名字>` / `kb_fs_<名字>`
///   （与保留字改 `kb_` 前缀同一惯例，撞名时再加 `_2`、`_3`……）。哪一侧改名：
///   - 一侧是引擎值（没有 `material`）、另一侧是材质常量：材质常量那一侧改名。引擎值保留原名，渲染器照旧按名字写入，
///     宿主也照旧按名字把它认成引擎 uniform；改了名的一侧总带 `material`，宿主按材质常量处理。
///   - 两侧都是材质常量：先声明的顶点阶段保留原名，片元阶段改名。
/// - 两侧都是引擎值而类型不同：报错（引擎值按名字写入，拆开后改了名的那一格没人写）。
///
/// 两半都标上各自的 `stage`，改名的一半另带 `original`。
fn merge_uniforms(
    vertex: Vec<UniformDecl>,
    fragment: Vec<UniformDecl>,
    taken: &mut BTreeSet<String>,
) -> Result<(Vec<UniformDecl>, StageRenames), RewriteError> {
    let mut renames: StageRenames = [BTreeMap::new(), BTreeMap::new()];
    let mut uniforms = vertex;
    for mut decl in fragment {
        let Some(existing) = uniforms.iter_mut().find(|u| u.name == decl.name) else {
            uniforms.push(decl);
            continue;
        };
        let same_type = existing.ty == decl.ty && existing.array == decl.array;
        let (vertex_source, fragment_source) =
            (value_source(&existing.meta), value_source(&decl.meta));
        if same_type && vertex_source == fragment_source {
            if matches!(fragment_source, ValueSource::Material(_)) || existing.meta.is_none() {
                existing.meta = decl.meta;
            }
            continue;
        }
        let name = decl.name.clone();
        match (vertex_source, fragment_source) {
            (ValueSource::Engine, ValueSource::Engine) => {
                return Err(RewriteError {
                    stage: Stage::Fragment,
                    message: format!("uniform {name} 在两个阶段的类型不同"),
                    file: None,
                    line: None,
                });
            }
            // 顶点是材质常量、片元是引擎值：顶点那一格改名，片元保留原名
            (ValueSource::Material(_), ValueSource::Engine) => {
                let renamed = fresh_name("kb_vs", &name, taken);
                renames[stage_index(Stage::Vertex)].insert(name.clone(), renamed.clone());
                existing.name = renamed;
                existing.original = Some(name);
                existing.stage = Some(Stage::Vertex);
                decl.stage = Some(Stage::Fragment);
            }
            _ => {
                let renamed = fresh_name("kb_fs", &name, taken);
                renames[stage_index(Stage::Fragment)].insert(name.clone(), renamed.clone());
                existing.stage = Some(Stage::Vertex);
                decl.name = renamed;
                decl.original = Some(name);
                decl.stage = Some(Stage::Fragment);
            }
        }
        uniforms.push(decl);
    }
    Ok((uniforms, renames))
}

/// `<prefix>_<名字>`，被占用时依次加 `_2`、`_3`……；选中的名字记进 `taken`。
fn fresh_name(prefix: &str, name: &str, taken: &mut BTreeSet<String>) -> String {
    let base = format!("{prefix}_{name}");
    let mut candidate = base.clone();
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = format!("{base}_{n}");
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// 正文里出现的全部标识符（按 [`rewrite_identifiers`] 同样的切分，已套用保留字改名）。
fn identifiers(body: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = body;
    while !rest.is_empty() {
        let c = rest.chars().next().expect("non-empty");
        if c.is_ascii_alphabetic() || c == '_' {
            let (ident, after) = split_ident(rest);
            out.insert(rename(ident));
            rest = after;
        } else if c.is_ascii_digit() {
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            rest = &rest[end..];
        } else {
            rest = &rest[c.len_utf8()..];
        }
    }
    out
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
    let merged_geometry = lines
        .iter()
        .any(|line| line.file == crate::geometry::GENERATED_FILE);
    Ok(StageParts {
        decls,
        body,
        merged_geometry,
    })
}

/// `uniform [lowp] vec3 a, b[4];`：只接受一行内写完的声明，带初始值或跨行的直接报错；名字后带分量（`v_Size.xy`）的
/// 照 WPE 当成不带分量的同名声明。
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
        // 名字后带分量（`varying vec4 v_Size.xy;`）：WPE 的声明正则 `(\w+)\s+<类型>\s+(\w+)(\[…\])?` 在 `.` 处停下，
        // 只取名字、`.xy` 丢弃（rea-p7-shader「P7b 补查」第 3 条，uniform / varying 一样；attribute 按整词找属性名，
        // `a_Position.xyz` 里 `.` 是词边界，同样只认名字）。p7-sem 的 `kbswz` 实测按 `vec4 v_Size` 编译
        let swizzle = after
            .strip_prefix('.')
            .map(|rest| split_ident(rest.trim_start()))
            .is_some_and(|(component, tail)| !component.is_empty() && tail.trim().is_empty());
        let array = if after.is_empty() || swizzle {
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

/// `renames` 是本阶段的改名表（拆分后改名的 uniform，原名 → 新名），正文里的引用随之改写。
fn render(
    stage: Stage,
    parts: &StageParts,
    uniforms: &[UniformDecl],
    renames: &BTreeMap<String, String>,
    textures: &[TextureDecl],
    attributes: &[InterfaceDecl],
    varyings: &[InterfaceDecl],
) -> Result<String, RewriteError> {
    let body = rewrite_identifiers(stage, &parts.body.join("\n"), renames);
    // main 之前对 float / int / uint 数组 uniform 的下标访问是 WPE 的打包形态（P7b 步骤 3，见 pack.rs）
    let (body, pack_functions) = if parts.merged_geometry {
        (body, String::new())
    } else {
        let declared: Vec<pack::Declared> = parts
            .decls
            .iter()
            .filter(|(decl, _)| decl.storage == Storage::Uniform)
            .map(|(decl, _)| pack::Declared {
                wpe_name: &decl.name,
                glsl_name: renames.get(&decl.name).unwrap_or(&decl.name),
                ty: &decl.ty,
                array: decl.array,
                padded: decl.array.is_some() && padded_array(&decl.ty).is_some(),
            })
            .collect();
        pack::rewrite_head(&declared, &body)
    };
    let body = rewrite_texture_calls(&body, textures).map_err(|message| RewriteError {
        stage,
        message,
        file: None,
        line: None,
    })?;

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
        out.push_str(&pack_functions);
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
        Stage::Vertex | Stage::Geometry => {
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

/// 按标识符逐个替换：保留字改名、内建换名、去掉精度限定符，以及拆分后改名的 uniform（`renames`，键是保留字改名之后的名字）。
///
/// 改名对本阶段正文里的每个同名标识符一视同仁（包括 `#define` 行、同名的局部变量与参数）：新名字不与任何已有标识符重名，
/// 整体替换等于换一个变量名，语义不变。
fn rewrite_identifiers(stage: Stage, body: &str, renames: &BTreeMap<String, String>) -> String {
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
                other => {
                    let renamed = rename(other);
                    renames.get(&renamed).cloned().unwrap_or(renamed)
                }
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
        // 两阶段同一份 uniform 块；g_Time 两阶段都没有注解，合并成一格
        assert_eq!(block(&program.vertex_glsl), block(&program.fragment_glsl));
        assert!(program.uniforms.iter().all(|u| u.stage.is_none()));
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

    fn uniform<'a>(program: &'a Program, name: &str) -> &'a UniformDecl {
        program
            .uniforms
            .iter()
            .find(|u| u.name == name)
            .unwrap_or_else(|| panic!("没有 {name}: {:?}", program.uniforms))
    }

    fn uniform_names(program: &Program) -> Vec<&str> {
        program.uniforms.iter().map(|u| u.name.as_str()).collect()
    }

    fn block(glsl: &str) -> String {
        glsl[glsl.find("uniform KbUniforms").unwrap()..glsl.find("};").unwrap()].to_string()
    }

    /// foliagesway：`g_Speed` 两阶段材质键不同（speed / speeduv），`g_Phase` 同键不同缺省（0 / 0.5）。
    const SWAY_VS: &str = "uniform float g_Time;\nuniform float g_Speed; // {\"material\":\"speed\",\"label\":\"ui_editor_properties_speed\",\"default\":1,\"range\":[0.01, 10]}\nuniform float g_Phase; // {\"material\":\"phase\",\"default\":0}\nattribute vec3 a_Position;\nvoid main() { float s = g_Phase + g_Speed * g_Time; gl_Position = vec4(a_Position * s, 1.0); }";
    const SWAY_FS: &str = "uniform float g_Speed; // {\"material\":\"speeduv\",\"label\":\"ui_editor_properties_speed\",\"default\":5,\"range\":[0.01, 20]}\nuniform float g_Phase; // {\"material\":\"phase\",\"default\":0.5}\nuniform float g_Time;\nvoid main() { float s = g_Phase + g_Speed * g_Time; gl_FragColor = vec4(s); }";

    #[test]
    fn stage_uniforms_with_different_keys_are_split() {
        let program = build(&lines(SWAY_VS), &lines(SWAY_FS)).unwrap();
        // g_Speed 键不同：片元那一半改名后排在块末尾；g_Phase 同键：合成一格；g_Time 是引擎值照旧合并
        assert_eq!(
            uniform_names(&program),
            ["g_Time", "g_Speed", "g_Phase", "kb_fs_g_Speed"]
        );
        let speed = uniform(&program, "g_Speed");
        assert_eq!(speed.meta.as_ref().unwrap()["material"], "speed");
        assert_eq!(
            (speed.stage, speed.original.as_deref()),
            (Some(Stage::Vertex), None)
        );
        let speed_uv = uniform(&program, "kb_fs_g_Speed");
        assert_eq!(speed_uv.meta.as_ref().unwrap()["material"], "speeduv");
        assert_eq!(speed_uv.meta.as_ref().unwrap()["default"], 5);
        assert_eq!(
            (speed_uv.stage, speed_uv.original.as_deref()),
            (Some(Stage::Fragment), Some("g_Speed"))
        );
        assert_eq!(uniform(&program, "g_Time").stage, None);
        // 每个阶段只引用自己的那一格
        assert!(program
            .vertex_glsl
            .contains("float s = g_Phase + g_Speed * g_Time;"));
        assert!(
            program
                .fragment_glsl
                .contains("float s = g_Phase + kb_fs_g_Speed * g_Time;"),
            "{}",
            program.fragment_glsl
        );
        // 两阶段仍是同一份块
        assert_eq!(block(&program.vertex_glsl), block(&program.fragment_glsl));
        assert!(block(&program.vertex_glsl).contains("float kb_fs_g_Speed;"));
    }

    /// 报告第 6 节 `stage-def`：同一个材质键、缺省不同（顶点 0、片元 0.5），WPE 只有一份存储、两阶段都读片元的缺省。
    #[test]
    fn same_key_with_different_defaults_merges_with_fragment_annotation() {
        let program = build(&lines(SWAY_VS), &lines(SWAY_FS)).unwrap();
        let phase = uniform(&program, "g_Phase");
        assert_eq!((phase.stage, phase.original.as_deref()), (None, None));
        assert_eq!(phase.meta.as_ref().unwrap()["material"], "phase");
        assert_eq!(phase.meta.as_ref().unwrap()["default"], 0.5);
    }

    #[test]
    fn same_key_with_different_types_is_split() {
        let vs = "uniform vec2 g_CloudSpeeds; // {\"material\":\"speed\",\"default\":\"0.01 -0.02\"}\nvoid main() { gl_Position = vec4(g_CloudSpeeds, 0.0, 1.0); }";
        let fs = "uniform vec4 g_CloudSpeeds; // {\"material\":\"speed\",\"default\":\"0.01 0.01 -0.02 -0.02\"}\nvoid main() { gl_FragColor = g_CloudSpeeds; }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(
            uniform_names(&program),
            ["g_CloudSpeeds", "kb_fs_g_CloudSpeeds"]
        );
        assert_eq!(uniform(&program, "g_CloudSpeeds").ty, "vec2");
        let fragment = uniform(&program, "kb_fs_g_CloudSpeeds");
        assert_eq!(fragment.ty, "vec4");
        assert_eq!(fragment.original.as_deref(), Some("g_CloudSpeeds"));
        assert!(program
            .fragment_glsl
            .contains("kb_FragColor = kb_fs_g_CloudSpeeds;"));
    }

    #[test]
    fn matching_value_sources_still_merge() {
        // label / range 不同、缺省值写法不同（1 与 "1.0"）：同一个材质键，合并，注解取片元的
        let vs = "uniform float g_A; // {\"material\":\"a\",\"default\":1,\"label\":\"x\",\"range\":[0,1]}\nvoid main() { gl_Position = vec4(g_A); }";
        let fs = "uniform float g_A; // {\"material\":\"a\",\"default\":\"1.0\",\"label\":\"y\"}\nvoid main() { gl_FragColor = vec4(g_A); }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(uniform_names(&program), ["g_A"]);
        let a = uniform(&program, "g_A");
        assert_eq!((a.stage, a.original.as_deref()), (None, None));
        assert_eq!(a.meta.as_ref().unwrap()["label"], "y");
        assert!(program.fragment_glsl.contains("kb_FragColor = vec4(g_A);"));
    }

    #[test]
    fn engine_uniforms_are_never_split() {
        // 都没有 material（一侧只有 label）：引擎按名字写的值，合并
        let vs = "uniform float g_Time;\nuniform vec4 g_Texture0Resolution; // {\"label\":\"x\"}\nvoid main() { gl_Position = g_Texture0Resolution * g_Time; }";
        let fs = "uniform float g_Time;\nuniform vec4 g_Texture0Resolution;\nvoid main() { gl_FragColor = g_Texture0Resolution * g_Time; }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(uniform_names(&program), ["g_Time", "g_Texture0Resolution"]);
        assert!(program.uniforms.iter().all(|u| u.stage.is_none()));
        // 引擎值类型不同：拆开后改名的一格没人写，照旧报错
        let error = build(
            &lines("uniform vec2 g_Point;\nvoid main() {}"),
            &lines("uniform vec4 g_Point;\nvoid main() {}"),
        )
        .unwrap_err();
        assert_eq!(error.message, "uniform g_Point 在两个阶段的类型不同");
    }

    /// 改名覆盖本阶段正文里的每一处：多次引用、`#define` 行、同名参数（一起换名，语义不变）；另一阶段一处不动。
    #[test]
    fn rename_reaches_every_reference_in_its_stage() {
        let fs = "uniform float g_Speed; // {\"material\":\"speeduv\",\"default\":5}\n#define SPEED2 (g_Speed * 2.0)\nfloat twice(float g_Speed) { return g_Speed * 2.0; }\nvoid main() { float a = g_Speed; gl_FragColor = vec4(a + g_Speed + SPEED2 + twice(g_Speed)); }";
        let program = build(&lines(SWAY_VS), &lines(fs)).unwrap();
        let body = |glsl: &str, marker: &str| glsl[glsl.find(marker).unwrap()..].to_string();
        let fragment = body(&program.fragment_glsl, "#define SPEED2");
        assert!(!identifiers(&fragment).contains("g_Speed"), "{fragment}");
        assert_eq!(fragment.matches("kb_fs_g_Speed").count(), 6, "{fragment}");
        let vertex = body(&program.vertex_glsl, "void main()");
        assert!(vertex.contains("g_Speed") && !vertex.contains("kb_fs_"));
    }

    #[test]
    fn engine_side_keeps_its_name() {
        // 顶点是材质常量、片元是引擎值：顶点那一格改名
        let vs = "uniform float g_Brightness; // {\"material\":\"brightness\",\"default\":2}\nvoid main() { gl_Position = vec4(g_Brightness); }";
        let fs = "uniform float g_Brightness;\nvoid main() { gl_FragColor = vec4(g_Brightness); }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(
            uniform_names(&program),
            ["kb_vs_g_Brightness", "g_Brightness"]
        );
        let material = uniform(&program, "kb_vs_g_Brightness");
        assert_eq!(material.meta.as_ref().unwrap()["material"], "brightness");
        assert_eq!(
            (material.stage, material.original.as_deref()),
            (Some(Stage::Vertex), Some("g_Brightness"))
        );
        let engine = uniform(&program, "g_Brightness");
        assert!(engine.meta.is_none());
        assert_eq!(
            (engine.stage, engine.original.as_deref()),
            (Some(Stage::Fragment), None)
        );
        assert!(program
            .vertex_glsl
            .contains("gl_Position = vec4(kb_vs_g_Brightness);"));
        assert!(program
            .fragment_glsl
            .contains("kb_FragColor = vec4(g_Brightness);"));

        // 反过来：顶点是引擎值、片元是材质常量，片元那一格改名
        let program = build(&lines(fs), &lines(vs)).unwrap();
        assert_eq!(
            uniform_names(&program),
            ["g_Brightness", "kb_fs_g_Brightness"]
        );
        assert!(uniform(&program, "g_Brightness").meta.is_none());
        assert_eq!(
            uniform(&program, "kb_fs_g_Brightness")
                .meta
                .as_ref()
                .unwrap()["material"],
            "brightness"
        );
    }

    #[test]
    fn renamed_uniform_avoids_existing_identifiers() {
        let vs =
            "uniform float g_A; // {\"material\":\"a\"}\nvoid main() { gl_Position = vec4(g_A); }";
        let fs = "uniform float g_A; // {\"material\":\"b\"}\nvoid main() { float kb_fs_g_A = 1.0; gl_FragColor = vec4(g_A + kb_fs_g_A); }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(uniform_names(&program), ["g_A", "kb_fs_g_A_2"]);
        assert!(
            program
                .fragment_glsl
                .contains("float kb_fs_g_A = 1.0; kb_FragColor = vec4(kb_fs_g_A_2 + kb_fs_g_A);"),
            "{}",
            program.fragment_glsl
        );
    }

    /// P7b 步骤 2：声明名后带分量照 WPE 只取名字（p7-sem 的 `kbswz`；工坊 `frame_builder` 的 `varying vec4 v_Size.xy;`）。
    #[test]
    fn declarations_with_a_component_suffix_keep_the_name() {
        let vs = "attribute vec3 a_Position.xyz;\nuniform vec2 g_Offset.xy; // {\"material\":\"offset\"}\nvarying vec4 v_Size.xy;\nvoid main() { v_Size = vec4(g_Offset, 0.3, 0.4); gl_Position = vec4(a_Position, 1.0); }";
        let fs = "varying vec4 v_Size.xy;\nvoid main() { gl_FragColor = vec4(v_Size.xyz, 1.0); }";
        let program = build(&lines(vs), &lines(fs)).unwrap();
        assert_eq!(program.attributes[0].name, "a_Position");
        assert_eq!(program.attributes[0].ty, "vec3");
        assert_eq!(uniform_names(&program), ["g_Offset"]);
        assert_eq!(uniform(&program, "g_Offset").ty, "vec2");
        assert_eq!(program.varyings.len(), 1);
        assert_eq!(
            (
                program.varyings[0].name.as_str(),
                program.varyings[0].ty.as_str()
            ),
            ("v_Size", "vec4")
        );
        assert!(program
            .fragment_glsl
            .contains("layout(location = 0) in vec4 v_Size;"));
        // 反例：带初始值、分量后还有别的内容的照旧报错
        for decl in [
            "uniform float g_X = 1.0;",
            "varying vec4 v_Size.xy[2];",
            "varying vec4 v_Size.;",
        ] {
            let vs = format!("{decl}\nvoid main() {{}}");
            let error = build(&lines(&vs), &lines("void main() {}")).unwrap_err();
            assert!(
                error.message.contains("全局声明"),
                "{decl}: {}",
                error.message
            );
        }
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
