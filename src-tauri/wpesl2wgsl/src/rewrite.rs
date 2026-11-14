//! 把预处理后的 WPESL 改写成 naga 能接的 Vulkan GLSL 450：
//! - 全局声明：普通 uniform 并成一个 std140 uniform 块（顶点 / 片元两阶段同一份、同一顺序，共用一块缓冲）；
//!   两阶段同名、取值来源不同的 uniform 拆成两格，一侧改名（[`merge_uniforms`]）；
//!   `sampler*` 拆成纹理 + 采样器，按 `g_Texture<n>` 的 n 固定绑定号；`attribute` / `varying` 加 `layout(location)`，
//!   varying 的 location 在两阶段之间统一分配，数组长度照 WPE（[`wpe_varying_array`]），超过 WebGPU 上限时装进 vec4（[`pack_varyings`]）。
//! - 正文：`texSample2D` 系列改成 `texture(sampler2D(t, s), …)`；`gl_FragColor` 等内建换成 Vulkan GLSL 写法；
//!   与 GLSL 450 保留字冲突的标识符改名；精度限定符去掉；其余 HLSL 风格内建由 [`MACRO_HEADER`] 的宏补上
//!   （照 WPE 自己翻 HLSL 时的宏头一一对应）。

use std::collections::{BTreeMap, BTreeSet, HashMap};

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
    /// 两阶段之间实际的接口：不打包时是作者声明的 varying（数组长度照 WPE 换算），
    /// 打包时是 `kb_varying_<i>`（vec4）加没打包的整数 varying（[`pack_varyings`]）。
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
    // 顶点阶段声明过的 varying：片元按它们的类型声明（见下）
    let mut vertex_varyings: BTreeSet<String> = BTreeSet::new();

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
                // 片元自己的 varying 声明作废、用顶点那份：WPE 两阶段只有一份 `VS_OUTPUT`（rea-p7-shader §2.6），
                // p7-sem 的 `kbwidth` 实测片元声明 vec2 也能读顶点写的 `.zw`。所以类型不同时不论哪边宽，片元都按顶点的类型
                // 声明（`render` 用共享表里的类型），正文里的截断交给 naga 的 HLSL 模式；片元读了顶点没有的分量时 naga 照常
                // 报错，与 fxc 一致。类型相同时与原来一样，输出不变。作废的声明连数组长度也不看（WPE 的片元列表被共享列表覆盖）
                Storage::Varying
                    if stage == Stage::Fragment && vertex_varyings.contains(&decl.name) => {}
                Storage::Varying => {
                    // 数组长度换成 WPE `VS_OUTPUT` 里的长度（见 [`wpe_varying_array`]），两阶段按换算后的比较
                    let array = match decl.array {
                        Some(n) => wpe_varying_array(&decl.name, &decl.ty, n).map_err(fail)?,
                        None => None,
                    };
                    match varyings.iter().find(|v| v.name == decl.name) {
                        Some(existing) if existing.ty != decl.ty || existing.array != array => {
                            return Err(fail(format!(
                                "varying {} 在两个阶段的类型不同",
                                decl.name
                            )));
                        }
                        Some(_) => {}
                        // 只在片元阶段声明的 varying（如 fade.frag 的 v_TexCoord）也分配 location：
                        // 顶点阶段渲染全部 varying，没写的输出是零（WGSL 私有变量零初始化），对应 D3D 下的未定义值；
                        // 否则 WebGPU 建管线会因片元输入没有对应的顶点输出而失败。
                        None => {
                            if stage == Stage::Vertex {
                                vertex_varyings.insert(decl.name.clone());
                            }
                            varyings.push(InterfaceDecl {
                                name: decl.name.clone(),
                                ty: decl.ty.clone(),
                                array,
                                location: next_varying,
                            });
                            next_varying += location_slots(&decl.ty, array);
                        }
                    }
                }
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
    // 超过 WebGPU 阶段间变量上限时把浮点 varying 装进 vec4（P7e 步骤 2）。几何展开拼成的顶点段不打包：它的 `main` 是生成的，
    // 绳着色器的 varying 很少；真超过时同样在这里报错，不留到建管线
    let interface_error = |message: String| RewriteError {
        stage: Stage::Vertex,
        message,
        file: None,
        line: None,
    };
    let packing = if vs.merged_geometry {
        if next_varying > MAX_INTER_STAGE {
            return Err(interface_error(format!(
                "几何着色器展开的程序 varying 占 {next_varying} 个 location，超过 WebGPU 的 {MAX_INTER_STAGE} 个（这类程序不打包）"
            )));
        }
        None
    } else {
        pack_varyings(&varyings).map_err(interface_error)?
    };
    let vertex_glsl = render(
        Stage::Vertex,
        &vs,
        &uniforms,
        &renames[stage_index(Stage::Vertex)],
        &textures,
        &attributes,
        &varyings,
        packing.as_ref(),
    )?;
    let fragment_glsl = render(
        Stage::Fragment,
        &fs,
        &uniforms,
        &renames[stage_index(Stage::Fragment)],
        &textures,
        &attributes,
        &varyings,
        packing.as_ref(),
    )?;
    // 反射给实际的 WGSL 接口：打包时是 `kb_varying_<i>` 加没打包的整数 varying
    let varyings = match packing {
        Some(packing) => packing.interface,
        None => varyings,
    };
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

/// varying 数组在 WPE 的 `VS_OUTPUT` 里的长度（rea-p7e-varying 第 1 条，`FUN_1400f52e0` `0x1400f53f0`–`0x1400f5434`）。
///
/// WPE 对每个成员只有一条公式：带 `[n]` 且 `n·(t+1) > 4`（`t` 是它类型表的下标，`t+1` 被当成分量数）时写 `[ceil(n/d)]`
/// （vec2 的 `d` 是 2，其余是 4），否则不写方括号。accessArray 与否只换类型名，长度走同一段，所以：
/// - `float` / `vec2`（accessArray）：WPE 声明成 `float4[ceil(n/4)]` / `float4[ceil(n/2)]`、容量刚好够，进出各有一段整体拷贝，
///   值与 GLSL 数组相同。这里保持原长度；超过上限时由 [`pack_varyings`] 照 fxc 装进 vec4。
/// - `vec3` / `vec4`：只剩 `ceil(n/4)` 个元素。这是 WPE 的 bug，但工坊示波器（`vec4 audioValue[32]`，只写、只读前 8 个）照着它写，
///   确定性工程 `p-va` 的 10 种情况与签名一致。`n·分量数 ≤ 4`（`n = 1`）时没有方括号、退化成普通向量，正文的 `a[0]` 成了取分量，
///   读写的截断交给 naga 的 HLSL 模式（fxc 的 X3206）。常量下标越过缩短后的长度时 naga 照常报越界（fxc 是 X3504、顶点回退）。
/// - `ivec4` / `uvec4`：`t+1` 是 13 / 15，`n = 1` 也有方括号（`int4 X[1]`），其余同上。
/// - `int` / `uint` 数组（WPE 当 `float4` 插值再数值转换回整数）与矩阵数组（WPE 每个元素只推进 1 个语义号，推断与下一个成员重叠）：
///   语料 0 处，照报不支持（P7e 已定）。
///
/// 不在 WPE 类型表里的类型（`ivec2`、`bool` 等）WPE 解析不了这条声明，这里保持原长度。
fn wpe_varying_array(name: &str, ty: &str, n: u32) -> Result<Option<u32>, String> {
    let weight = match ty {
        "vec3" => 3,
        "vec4" => 4,
        "ivec4" => 13,
        "uvec4" => 15,
        "int" | "uint" => {
            return Err(format!(
                "varying {name} 是 {ty} 数组：WPE 按 float4 插值传递，没有实现（语料 0 处）"
            ))
        }
        _ if ty.starts_with("mat") => {
            return Err(format!(
                "varying {name} 是 {ty} 数组：WPE 的语义编号会重叠，没有实现（语料 0 处）"
            ))
        }
        _ => return Ok(Some(n)),
    };
    Ok((n.saturating_mul(weight) > 4).then(|| n.div_ceil(4)))
}

/// WebGPU 缺省的 `maxInterStageShaderVariables`，每台设备都保证；设备不申请更高的上限（P7e 已定，结果不随显卡变）。
/// 校验按 location 比（`location < 16`），所以是 location 的个数。
pub const MAX_INTER_STAGE: u32 = 16;

/// 一个 varying（数组的一个元素、矩阵的一列）装进第 `slot` 个 vec4 的 `offset` 起的 `components` 个分量。
#[derive(Debug, Clone, PartialEq, Eq)]
struct PackedPiece {
    name: String,
    element: Option<u32>,
    column: Option<u32>,
    components: u32,
    slot: u32,
    offset: u32,
}

/// [`pack_varyings`] 的结果。
#[derive(Debug, Clone)]
struct Packing {
    /// 浮点 varying 的全部片段，按 (slot, offset) 排序。
    pieces: Vec<PackedPiece>,
    /// vec4 的个数，`kb_varying_0` … `kb_varying_<slots-1>` 占 location 0 … slots-1。
    slots: u32,
    /// 实际的 WGSL 接口：`kb_varying_<i>`（vec4）在前，没打包的整数 varying 在后、按声明顺序接着分配 location。
    interface: Vec<InterfaceDecl>,
}

impl Packing {
    fn pieces_in(&self, slot: u32) -> impl Iterator<Item = &PackedPiece> + '_ {
        self.pieces.iter().filter(move |piece| piece.slot == slot)
    }
}

/// 能装进 vec4 的浮点 varying 的形状（列数, 每列的分量数）；整数等别的类型返回 None、不打包。
fn float_shape(ty: &str) -> Option<(u32, u32)> {
    Some(match ty {
        "float" => (1, 1),
        "vec2" => (1, 2),
        "vec3" => (1, 3),
        "vec4" => (1, 4),
        "mat2" | "mat2x2" => (2, 2),
        "mat2x3" => (2, 3),
        "mat2x4" => (2, 4),
        "mat3x2" => (3, 2),
        "mat3" | "mat3x3" => (3, 3),
        "mat3x4" => (3, 4),
        "mat4x2" => (4, 2),
        "mat4x3" => (4, 3),
        "mat4" | "mat4x4" => (4, 4),
        _ => return None,
    })
}

/// 换算长度（[`wpe_varying_array`]）之后 varying 仍超过 [`MAX_INTER_STAGE`] 个 location 时，把浮点 varying 装进 vec4。
///
/// 依据：fxc 编签名时把标量、`vec2` 等装进同一个寄存器（rea-p7e-varying「和 WebGPU 阶段间变量上限的关系」：`auto_sway`
/// 的 31 个 varying 在 WPE 的编译缓存里是 11 个寄存器加位置）。打包只改两阶段之间的接口，插值逐分量进行，值不变。
/// 规则：按分量数从大到小（同大小按声明顺序，数组按元素、矩阵按列）放进第一个放得下的 vec4，不拆开一个元素或一列；
/// 整数 varying 不打包（要 `flat`），各占自己的 location。具体放在哪个分量与 fxc 不必相同，两个阶段都是我们生成的。
///
/// 不超过上限时返回 None，输出与原来逐字节相同（P7e 已定：不照 WPE 总把 `float` / `vec2` 数组打包，免得 36 张 `blur_gaussian`
/// 等场景的输出都变）。打包后仍超过时报错，场景在编译期报不支持、退回预览图，而不是到运行时建管线才失败。
fn pack_varyings(varyings: &[InterfaceDecl]) -> Result<Option<Packing>, String> {
    let total: u64 = varyings
        .iter()
        .map(|v| u64::from(location_slots(&v.ty, v.array)))
        .sum();
    if total <= u64::from(MAX_INTER_STAGE) {
        return Ok(None);
    }
    let too_many = |needed: u64| {
        format!(
            "varying 装进 vec4 之后仍要 {needed} 个 location（不打包是 {total} 个），超过 WebGPU 的 {MAX_INTER_STAGE} 个"
        )
    };
    // 先按下界判断，免得给特别长的数组逐元素建片段
    let float_components: u64 = varyings
        .iter()
        .filter_map(|v| {
            let (columns, rows) = float_shape(&v.ty)?;
            Some(u64::from(columns * rows) * u64::from(v.array.unwrap_or(1)))
        })
        .sum();
    let integer_slots: u64 = varyings
        .iter()
        .filter(|v| float_shape(&v.ty).is_none())
        .map(|v| u64::from(location_slots(&v.ty, v.array)))
        .sum();
    let lower_bound = float_components.div_ceil(4) + integer_slots;
    if lower_bound > u64::from(MAX_INTER_STAGE) {
        return Err(too_many(lower_bound));
    }

    let mut pieces = Vec::new();
    for varying in varyings {
        let Some((columns, rows)) = float_shape(&varying.ty) else {
            continue;
        };
        let elements: Vec<Option<u32>> = match varying.array {
            Some(n) => (0..n).map(Some).collect(),
            None => vec![None],
        };
        for element in elements {
            for column in 0..columns {
                pieces.push(PackedPiece {
                    name: varying.name.clone(),
                    element,
                    column: (columns > 1).then_some(column),
                    components: rows,
                    slot: 0,
                    offset: 0,
                });
            }
        }
    }
    // `sort_by` 是稳定排序：同样大小的保持声明顺序
    pieces.sort_by(|a, b| b.components.cmp(&a.components));
    let mut fill: Vec<u32> = Vec::new();
    for piece in &mut pieces {
        let slot = match fill.iter().position(|used| used + piece.components <= 4) {
            Some(slot) => slot,
            None => {
                fill.push(0);
                fill.len() - 1
            }
        };
        piece.slot = slot as u32;
        piece.offset = fill[slot];
        fill[slot] += piece.components;
    }
    pieces.sort_by_key(|piece| (piece.slot, piece.offset));

    let slots = fill.len() as u32;
    let mut interface: Vec<InterfaceDecl> = (0..slots)
        .map(|slot| InterfaceDecl {
            name: packed_name(slot),
            ty: "vec4".to_string(),
            array: None,
            location: slot,
        })
        .collect();
    let mut next = slots;
    for varying in varyings.iter().filter(|v| float_shape(&v.ty).is_none()) {
        interface.push(InterfaceDecl {
            location: next,
            ..varying.clone()
        });
        next += location_slots(&varying.ty, varying.array);
    }
    if next > MAX_INTER_STAGE {
        return Err(too_many(u64::from(next)));
    }
    Ok(Some(Packing {
        pieces,
        slots,
        interface,
    }))
}

/// 打包后第 `slot` 个 vec4 的名字。`kb_` 前缀是翻译器保留的，作者代码里出现 `kb_varying_*` 时打包报错（[`render`]）。
fn packed_name(slot: u32) -> String {
    format!("kb_varying_{slot}")
}

/// 片段在 GLSL 里的写法：`名[元素][列]`。
fn piece_expr(piece: &PackedPiece) -> String {
    let mut out = piece.name.clone();
    if let Some(element) = piece.element {
        out.push_str(&format!("[{element}]"));
    }
    if let Some(column) = piece.column {
        out.push_str(&format!("[{column}]"));
    }
    out
}

/// 打包时生成的入口：作者的 `main` 已改名 `kb_main`。
/// - 顶点：先调 `kb_main`，再把私有全局装进 vec4（作者在 `main` 里提前 `return` 也照样装箱）；没填满的分量补 0。
/// - 片元：只拆本阶段声明的 varying，拆完再调 `kb_main`（作者可以照常改写它们）。
fn packed_entry(stage: Stage, packing: &Packing, declared: &[&str]) -> String {
    let mut out = String::from("void main() {\n");
    if stage == Stage::Fragment {
        for piece in packing
            .pieces
            .iter()
            .filter(|piece| declared.contains(&piece.name.as_str()))
        {
            let source = packed_name(piece.slot);
            let source = if piece.components == 4 {
                source
            } else {
                let at = piece.offset as usize;
                format!("{source}.{}", &"xyzw"[at..at + piece.components as usize])
            };
            out.push_str(&format!("    {} = {source};\n", piece_expr(piece)));
        }
        out.push_str("    kb_main();\n");
    } else {
        out.push_str("    kb_main();\n");
        for slot in 0..packing.slots {
            let mut parts: Vec<String> = packing.pieces_in(slot).map(piece_expr).collect();
            let used: u32 = packing.pieces_in(slot).map(|piece| piece.components).sum();
            parts.extend((used..4).map(|_| "0.0".to_string()));
            out.push_str(&format!(
                "    {} = vec4({});\n",
                packed_name(slot),
                parts.join(", ")
            ));
        }
    }
    out.push_str("}\n");
    out
}

/// 打包时把作者的 `void main() {` 改名为 `kb_main`。必须在 [`pack::rewrite_head`]、[`hoist_runtime_consts`] 之后做：
/// 它们按原来的 `main` 签名切分正文。认不出签名（`main(void)` 等）时返回 None。
fn rename_main(body: &str) -> Option<String> {
    let start = pack::main_signature(body)?;
    // 签名是 `void` 空白 `main`：`void` 之后的第一个 `main` 就是它
    let at = start + 4 + body[start + 4..].find("main")?;
    Some(format!("{}kb_main{}", &body[..at], &body[at + 4..]))
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
/// `varyings` 是作者声明的 varying（长度已换算）；`packing` 不为空时按它把浮点 varying 装进 vec4（[`pack_varyings`]）。
#[allow(clippy::too_many_arguments)]
fn render(
    stage: Stage,
    parts: &StageParts,
    uniforms: &[UniformDecl],
    renames: &BTreeMap<String, String>,
    textures: &[TextureDecl],
    attributes: &[InterfaceDecl],
    varyings: &[InterfaceDecl],
    packing: Option<&Packing>,
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
    // 上界是字面量 0 的 smoothstep 照 fxc 的化简算（[`rewrite_zero_edge_smoothstep`]）
    let body = rewrite_zero_edge_smoothstep(&body);
    // 全局 const 的初始值引用 uniform 等运行期值：改成私有全局、在 main 开头赋值（P7c 2h）
    let runtime: BTreeSet<&str> = parts
        .decls
        .iter()
        .map(|(decl, _)| renames.get(&decl.name).unwrap_or(&decl.name).as_str())
        .collect();
    let body = hoist_runtime_consts(&body, &runtime);
    // 打包时作者的 `main` 改名 `kb_main`，入口由 `packed_entry` 生成。改名放在上面两步之后：它们按原来的 `main` 切分正文
    let body = match packing {
        None => body,
        Some(_) => {
            let fail = |message: String| RewriteError {
                stage,
                message,
                file: None,
                line: None,
            };
            if let Some(name) = identifiers(&body)
                .into_iter()
                .find(|name| name == "kb_main" || name.starts_with("kb_varying_"))
            {
                return Err(fail(format!(
                    "varying 要打包，但正文里已有标识符 {name}（kb_ 前缀是翻译器保留的）"
                )));
            }
            rename_main(&body).ok_or_else(|| {
                fail("varying 要打包，但认不出 main 的签名（要写成 `void main() {`）".to_string())
            })?
        }
    };

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
    let interface_line = |varying: &InterfaceDecl| {
        let flat = if is_integer_type(&varying.ty) {
            "flat "
        } else {
            ""
        };
        format!(
            "layout(location = {}) {flat}{direction} {} {}{};\n",
            varying.location,
            varying.ty,
            varying.name,
            array_suffix(varying.array)
        )
    };
    let used = |name: &str| stage == Stage::Vertex || declared.contains(&name);
    match packing {
        None => {
            for varying in varyings.iter().filter(|v| used(&v.name)) {
                out.push_str(&interface_line(varying));
            }
        }
        Some(packing) => {
            // 接口：片元只声明装着自己的 varying 的 vec4，以及自己声明的整数 varying
            let slots: BTreeSet<u32> = packing
                .pieces
                .iter()
                .filter(|piece| used(&piece.name))
                .map(|piece| piece.slot)
                .collect();
            for (index, decl) in packing.interface.iter().enumerate() {
                let keep = if (index as u32) < packing.slots {
                    slots.contains(&decl.location)
                } else {
                    used(&decl.name)
                };
                if keep {
                    out.push_str(&interface_line(decl));
                }
            }
            // 原来的浮点 varying 改成私有全局，正文照常读写（片元改写 varying、只在片元声明的都不受影响）
            for varying in varyings
                .iter()
                .filter(|v| float_shape(&v.ty).is_some() && used(&v.name))
            {
                out.push_str(&format!(
                    "{} {}{};\n",
                    varying.ty,
                    varying.name,
                    array_suffix(varying.array)
                ));
            }
        }
    }

    if calls(&body, "kb_smoothstep0") {
        out.push_str(SMOOTHSTEP0_HELPERS);
    }
    out.push_str(&broadcast_helpers(&body));
    out.push_str(&body);
    out.push('\n');
    if let Some(packing) = packing {
        out.push_str(&packed_entry(stage, packing, &declared));
    }
    Ok(out)
}

/// 全局 `const` 的初始值不是常量（引用 uniform、varying、attribute、`gl_*` 内建，或引用了已改写的这类 const）时，
/// 改成私有全局，在 `main` 开头按声明顺序赋值。
///
/// WPE 给每个以 `const` 开头的行前面插 `static `（rea-p7-shader §2.x 第 5 条），fxc 接受初始值不是常量的 `static const`，
/// 每次调用现算（`ignore/p7/fxc/c4.hlsl` 实测）；naga 要求全局 `const` 的初始值是常量表达式，报 `Unexpected runtime-expression`
/// （工坊 `radial_blur`：`const float strength = -u_strength * 0.1 / u_samples;`）。私有全局在 `main` 开头赋值后，`main` 与它调用的
/// 辅助函数读到的都是这次调用现算的值，与 fxc 相同。
///
/// 只改这种 const（这类着色器本来就编不过），其余原样返回、逐字节不变。只认一个声明符的 `const T 名[数组]? = 初始值;`；
/// 找不到 `main` 签名（WPE 的写法 `void main() {`）、或 const 写在 `main` 之后的，不改。行数不变：声明处保留原有换行，
/// 赋值插在 `main` 的 `{` 之后同一行。
fn hoist_runtime_consts(body: &str, runtime: &BTreeSet<&str>) -> String {
    let Some(main_at) = pack::main_signature(body) else {
        return body.to_string();
    };
    let bytes = body.as_bytes();
    // （起点, `;` 的位置, 换成的声明, main 里的赋值）
    let mut hoisted: Vec<(usize, usize, String, String)> = Vec::new();
    let mut names: BTreeSet<String> = BTreeSet::new();
    let (mut i, mut depth, mut at_start, mut line_start) = (0, 0usize, true, true);
    while i < main_at {
        let c = bytes[i];
        // 预处理行（`#define` 等）整行跳过，不打断「语句开头」，里面的括号也不计
        if line_start {
            let indent = body[i..]
                .find(|ch: char| ch != ' ' && ch != '\t')
                .map_or(body.len(), |at| i + at);
            if bytes.get(indent) == Some(&b'#') {
                i = body[indent..]
                    .find('\n')
                    .map_or(body.len(), |at| indent + at);
                continue;
            }
        }
        match c {
            b'\n' => {
                line_start = true;
                i += 1;
                continue;
            }
            b' ' | b'\t' | b'\r' => {
                i += 1;
                continue;
            }
            _ => line_start = false,
        }
        if depth == 0 && at_start && (c.is_ascii_alphabetic() || c == b'_') {
            let (word, _) = split_ident(&body[i..]);
            if word == "const" {
                if let Some((end, decl, assign, name)) = runtime_const(body, i, runtime, &names) {
                    names.insert(name);
                    hoisted.push((i, end, decl, assign));
                    i = end + 1;
                    at_start = true;
                    continue;
                }
            }
            at_start = false;
            i += word.len();
            continue;
        }
        match c {
            b'{' => {
                depth += 1;
                at_start = false;
            }
            b'}' => {
                depth = depth.saturating_sub(1);
                at_start = depth == 0;
            }
            b';' if depth == 0 => at_start = true,
            _ => at_start = false,
        }
        i += 1;
    }
    if hoisted.is_empty() {
        return body.to_string();
    }
    let mut out = String::with_capacity(body.len() + 64);
    let mut from = 0;
    for (start, end, decl, _) in &hoisted {
        out.push_str(&body[from..*start]);
        out.push_str(decl);
        from = end + 1;
    }
    // 被改写的 const 都在 main 之前；赋值插在 main 的 `{` 之后
    let brace = main_at + body[main_at..].find('{').expect("main 签名以 `{` 结尾");
    out.push_str(&body[from..=brace]);
    for (_, _, _, assign) in &hoisted {
        out.push(' ');
        out.push_str(assign);
    }
    out.push_str(&body[brace + 1..]);
    out
}

/// [`hoist_runtime_consts`] 的一条：`body[start..]` 以 `const` 开头，初始值用到运行期值时返回
/// （`;` 的位置, 换成的声明（保留原有换行）, `main` 里的赋值, 名字）。
fn runtime_const(
    body: &str,
    start: usize,
    runtime: &BTreeSet<&str>,
    hoisted: &BTreeSet<String>,
) -> Option<(usize, String, String, String)> {
    // 语句到顶层的 `;` 为止（初始值里可能有括号、花括号）
    let mut depth = 0usize;
    let end = start
        + body[start..].find(|c: char| {
            match c {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth = depth.saturating_sub(1),
                ';' if depth == 0 => return true,
                _ => {}
            }
            false
        })?;
    let statement = &body[start..end];
    let rest = split_ident(statement).1.trim_start();
    let (ty, rest) = split_ident(rest);
    let (name, rest) = split_ident(rest.trim_start());
    if ty.is_empty() || name.is_empty() {
        return None;
    }
    let rest = rest.trim_start();
    let (array, rest) = match rest.strip_prefix('[') {
        Some(after) => {
            let close = after.find(']')?;
            (&rest[..close + 2], after[close + 1..].trim_start())
        }
        None => ("", rest),
    };
    let init = rest.strip_prefix('=')?.trim();
    // 多个声明符（顶层逗号）不改
    let mut depth = 0usize;
    for c in init.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => return None,
            _ => {}
        }
    }
    if !uses_runtime_value(init, runtime, hoisted) {
        return None;
    }
    let newlines = "\n".repeat(statement.matches('\n').count());
    let decl = format!("{ty} {name}{array};{newlines}");
    let assign = format!(
        "{name} = {};",
        init.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    Some((end, decl, assign, name.to_string()))
}

/// 初始值里有没有运行期的值：本阶段声明的 uniform / attribute / varying（含纹理）、`gl_*` 内建、`main` 之前打包数组的
/// 访问函数 `kb_pack_*`（读 uniform），或已经改成私有全局的 const。成员访问（`.x`）与数字字面量不算。
fn uses_runtime_value(init: &str, runtime: &BTreeSet<&str>, hoisted: &BTreeSet<String>) -> bool {
    let mut rest = init;
    let mut after_dot = false;
    while let Some(c) = rest.chars().next() {
        if c.is_ascii_digit() {
            let end = rest
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.'))
                .unwrap_or(rest.len());
            rest = &rest[end..];
            after_dot = false;
        } else if c.is_ascii_alphabetic() || c == '_' {
            let (ident, after) = split_ident(rest);
            if !after_dot
                && (runtime.contains(ident)
                    || hoisted.contains(ident)
                    || ident.starts_with("gl_")
                    || ident.starts_with("kb_pack_"))
            {
                return true;
            }
            rest = after;
            after_dot = false;
        } else {
            after_dot = c == '.';
            rest = &rest[c.len_utf8()..];
        }
    }
    false
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
///
/// 第一个参数可以是 `#define 别名 g_TextureN` 这样的对象宏（P13a）：WPE 先预处理再编译，别名本来就成立；
/// 预处理器把 `#define` 行留给 naga，这一步在 naga 之前，所以按正文顺序自己记别名（`#undef` 删掉，最多追 8 层）。
/// 第一个参数本来就是纹理的调用输出与没有别名表时逐字节相同。
fn rewrite_texture_calls(body: &str, textures: &[TextureDecl]) -> Result<String, String> {
    rewrite_texture_calls_with(body, textures, &mut HashMap::new())
}

/// 行首（前面只有空白）的 `#define` / `#undef` 指令：返回整条指令（含续行）的长度，并更新别名表。
fn scan_alias_directive(rest: &str, aliases: &mut HashMap<String, String>) -> usize {
    // 续行（行尾 `\`）并入同一条指令
    let mut end = 0;
    loop {
        let line_end = rest[end..]
            .find('\n')
            .map(|i| end + i)
            .unwrap_or(rest.len());
        let line = rest[end..line_end].trim_end_matches('\r');
        if line.ends_with('\\') && line_end < rest.len() {
            end = line_end + 1;
        } else {
            end = line_end;
            break;
        }
    }
    let directive = rest[1..end].trim_start();
    let (word, tail) = split_ident(directive);
    match word {
        "define" => {
            let tail = tail.trim_start();
            let (name, after) = split_ident(tail);
            // 函数宏 `NAME(` 不记；名字后要有空白才是对象宏
            let is_object = !name.is_empty() && after.starts_with(|c: char| c == ' ' || c == '\t');
            let value = after.split("//").next().unwrap_or("").trim();
            let (ident, remaining) = split_ident(value);
            if is_object
                && !ident.is_empty()
                && remaining.is_empty()
                && ident.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            {
                aliases.insert(name.to_string(), ident.to_string());
            } else {
                aliases.remove(name);
            }
        }
        "undef" => {
            let (name, _) = split_ident(tail.trim_start());
            aliases.remove(name);
        }
        _ => {}
    }
    end
}

fn rewrite_texture_calls_with(
    body: &str,
    textures: &[TextureDecl],
    aliases: &mut HashMap<String, String>,
) -> Result<String, String> {
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
        if c == '#' && out.rsplit('\n').next().is_some_and(|l| l.trim().is_empty()) {
            // 行首的 #define / #undef：先记别名；这一行照旧逐字符输出（宏体里的纹理调用仍按原样改写，输出与改动前逐字节相同）
            scan_alias_directive(rest, aliases);
        }
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
            .map(|arg| rewrite_texture_calls_with(arg, textures, &mut aliases.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let texture_name = args.first().map(|a| a.trim()).unwrap_or_default();
        // 不是已声明的纹理时沿别名表追，最多 8 层
        let mut resolved = texture_name;
        for _ in 0..8 {
            if textures.iter().any(|t| t.name == resolved) {
                break;
            }
            match aliases.get(resolved) {
                Some(next) => resolved = next.as_str(),
                None => break,
            }
        }
        let Some(texture) = textures.iter().find(|t| t.name == resolved) else {
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

/// 上界是字面量 0 的 `smoothstep(lo, 0.0, x)` → `kb_smoothstep0(lo, x)`（[`SMOOTHSTEP0_HELPERS`]）；参数里嵌套的调用一并改写。
///
/// fxc 把内建 `smoothstep` 展开成 `saturate((x - lo) * (1 / (hi - lo)))`，上界是常量 0 时把 `0.0 - lo` 化简成 `-lo`：
/// `lo` 为 +0 时分母是 -0、倒数 -inf，结果是 0；照 IEEE 算 `0.0 - (+0)` 是 +0、倒数 +inf，结果是 1。工坊示波器
/// （`audio_responsive_oscilloscope`，`AUDIOTHICKNESS`）没有声音时线宽为 0，就是 `smoothstep(+0, 0.0, dist)`：WPE 什么都不画，
/// 用内建函数整张提亮约 39%（WPE 像素着色器反汇编第 78–79 行，`ignore/p7e/iso-REPORT.md`）。
/// 下界是数字字面量时分母不会是 ±0，结果和内建函数相同，不改写（输出逐字节不变）。上界经宏传进来的（`#define` 的形参）认不出，语料 0 处。
fn rewrite_zero_edge_smoothstep(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        let c = rest.chars().next().expect("non-empty");
        if c.is_ascii_digit() {
            // 数字字面量整体拷贝（同 `rewrite_identifiers`）
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            out.push_str(&rest[..end]);
            rest = &rest[end..];
            continue;
        }
        if !(c.is_ascii_alphabetic() || c == '_') {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let (ident, after) = split_ident(rest);
        let open = after.trim_start();
        let parsed = (ident == "smoothstep" && open.starts_with('('))
            .then(|| split_call_args(&open[1..]))
            .flatten();
        let Some((args, remaining)) = parsed else {
            out.push_str(ident);
            rest = after;
            continue;
        };
        let args: Vec<String> = args
            .iter()
            .map(|arg| rewrite_zero_edge_smoothstep(arg))
            .collect();
        if args.len() == 3 && is_zero_literal(&args[1]) && !is_number_literal(&args[0]) {
            out.push_str(&format!(
                "kb_smoothstep0({}, {})",
                args[0].trim(),
                args[2].trim()
            ));
        } else {
            // 不改写的原样拼回（函数名与括号之间的空白也留着），参数里嵌套的改写照常生效
            let gap = &after[..after.len() - open.len()];
            out.push_str(&format!("smoothstep{gap}({})", args.join(",")));
        }
        rest = remaining;
    }
    out
}

/// 去掉外层括号与空白后的数字字面量（可带正负号与 `f` 后缀）：`0`、`0.0`、`.5`、`(1e-3)`、`-2.0f`。
fn is_number_literal(text: &str) -> bool {
    number_literal(text).is_some()
}

/// 去掉外层括号与空白后是值为 +0 的字面量：`0`、`0.0`、`0.`、`.0`、`0.0f`、`(0)`。`-0.0` 不算：`-0.0 - lo` 照 IEEE 算本来就等于 `-lo`。
fn is_zero_literal(text: &str) -> bool {
    number_literal(text).is_some_and(|(negative, value)| !negative && value == 0.0)
}

/// 解析数字字面量，返回（是否带负号, 绝对值）。
fn number_literal(text: &str) -> Option<(bool, f64)> {
    let mut text = text.trim();
    while let Some(inner) = text.strip_prefix('(').and_then(|t| t.strip_suffix(')')) {
        text = inner.trim();
    }
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest.trim_start()),
        None => (false, text.strip_prefix('+').unwrap_or(text).trim_start()),
    };
    let digits = digits
        .strip_suffix('f')
        .or_else(|| digits.strip_suffix('F'))
        .unwrap_or(digits);
    let valid = !digits.is_empty()
        && digits
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit() || c == '.')
        && digits
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !valid {
        return None;
    }
    digits.parse::<f64>().ok().map(|value| (negative, value))
}

/// [`rewrite_zero_edge_smoothstep`] 换上的函数：照 fxc 的 `saturate((x - lo) * (1 / -lo))`，分母为 ±0 时不靠无穷大，按符号直接取值
/// （lo 为 +0：倒数 -inf，x < lo 得 1、否则 0；lo 为 -0：倒数 +inf，x > lo 得 1、否则 0；x == lo 时 0 · inf 是 NaN，saturate 成 0）。
/// 向量逐分量；重载由 naga 的 HLSL 内置规则选（`naga_stage::INTRINSIC_WRAPPERS`），标量与向量混用时铺满。
const SMOOTHSTEP0_HELPERS: &str = "\
float kb_smoothstep0(float lo, float x) {
    float t;
    if (lo == 0.0) {
        float d = x - lo;
        t = (floatBitsToUint(lo) >> 31) == 0u ? (d < 0.0 ? 1.0 : 0.0) : (d > 0.0 ? 1.0 : 0.0);
    } else {
        t = clamp((x - lo) * (1.0 / -lo), 0.0, 1.0);
    }
    return t * t * (3.0 - 2.0 * t);
}
vec2 kb_smoothstep0(vec2 lo, vec2 x) { return vec2(kb_smoothstep0(lo.x, x.x), kb_smoothstep0(lo.y, x.y)); }
vec3 kb_smoothstep0(vec3 lo, vec3 x) { return vec3(kb_smoothstep0(lo.x, x.x), kb_smoothstep0(lo.y, x.y), kb_smoothstep0(lo.z, x.z)); }
vec4 kb_smoothstep0(vec4 lo, vec4 x) { return vec4(kb_smoothstep0(lo.x, x.x), kb_smoothstep0(lo.y, x.y), kb_smoothstep0(lo.z, x.z), kb_smoothstep0(lo.w, x.w)); }
";

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
pub(crate) mod tests {
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

    fn alias_textures() -> [TextureDecl; 2] {
        [
            TextureDecl {
                slot: 1,
                name: "g_Texture1".into(),
                kind: TextureKind::D2,
                meta: None,
            },
            TextureDecl {
                slot: 2,
                name: "g_Texture2".into(),
                kind: TextureKind::D2,
                meta: None,
            },
        ]
    }

    #[test]
    fn texture_call_follows_object_macro_alias() {
        let textures = alias_textures();
        let src =
            "#define g_NormalMapSampler g_Texture1\nvec4 n = texSample2D(g_NormalMapSampler, uv);";
        let out = rewrite_texture_calls(src, &textures).unwrap();
        // #define 行原样保留，调用按 g_Texture1 改写
        assert_eq!(
            out,
            "#define g_NormalMapSampler g_Texture1\nvec4 n = texture(sampler2D(g_Texture1, kb_sampler_g_Texture1), uv);"
        );
    }

    #[test]
    fn texture_alias_chains_and_undef_and_errors() {
        let textures = alias_textures();
        // 两层别名
        let chained = "  #define A B\n#define B g_Texture2\ntexSample2D(A, uv)";
        let out = rewrite_texture_calls(chained, &textures).unwrap();
        assert!(
            out.ends_with("texture(sampler2D(g_Texture2, kb_sampler_g_Texture2), uv)"),
            "{out}"
        );
        // #undef 之后再用，报原来的错误
        let undef = "#define A g_Texture1\n#undef A\ntexSample2D(A, uv)";
        let err = rewrite_texture_calls(undef, &textures).unwrap_err();
        assert!(err.contains("不是已声明的纹理：A"), "{err}");
        // 别名指向未声明名
        let missing = "#define A nope\ntexSample2D(A, uv)";
        assert!(rewrite_texture_calls(missing, &textures).is_err());
        // 函数宏不当别名
        let function_macro = "#define A(x) g_Texture1\ntexSample2D(A, uv)";
        assert!(rewrite_texture_calls(function_macro, &textures).is_err());
        // 环不会死循环
        let cycle = "#define A B\n#define B A\ntexSample2D(A, uv)";
        assert!(rewrite_texture_calls(cycle, &textures).is_err());
    }

    #[test]
    fn texture_call_without_alias_is_unchanged_by_other_directives() {
        let textures = alias_textures();
        let src = "#if X\n#define V 1\n#endif\ntexSample2D(g_Texture1, uv)";
        let out = rewrite_texture_calls(src, &textures).unwrap();
        assert_eq!(
            out,
            "#if X\n#define V 1\n#endif\ntexture(sampler2D(g_Texture1, kb_sampler_g_Texture1), uv)"
        );
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

    /// P7c 2h：全局 const 的初始值引用运行期值（uniform、已改写的 const）时改成私有全局、在 main 开头按声明顺序赋值；
    /// 常量初始值的 const、函数里的局部 const 不动，行数不变。
    #[test]
    fn runtime_global_consts_are_hoisted_into_main() {
        let runtime: BTreeSet<&str> = ["u_strength", "u_samples", "g_Texture0Resolution"]
            .into_iter()
            .collect();
        let body = "#define KB_K 2.0\nconst float k = KB_K;\nconst float strength = -u_strength * 0.1 /\n    u_samples;\nconst vec2 type = vec2(g_Texture0Resolution.x / g_Texture0Resolution.y, strength);\nfloat helper() { const float local = u_strength; return strength * k + type.x; }\nvoid main()\n{\n\tgl_FragColor = vec4(helper());\n}";
        let out = hoist_runtime_consts(body, &runtime);
        assert_eq!(
            out,
            "#define KB_K 2.0\nconst float k = KB_K;\nfloat strength;\n\nvec2 type;\nfloat helper() { const float local = u_strength; return strength * k + type.x; }\nvoid main()\n{ strength = -u_strength * 0.1 / u_samples; type = vec2(g_Texture0Resolution.x / g_Texture0Resolution.y, strength);\n\tgl_FragColor = vec4(helper());\n}"
        );
        assert_eq!(out.lines().count(), body.lines().count());

        // 不改的：常量初始值；认不出 main 签名；const 写在 main 之后；多个声明符；成员名恰好同名
        for unchanged in [
            "const float k = 2.0 * 3.0;\nvoid main() { gl_FragColor = vec4(k); }",
            "const float s = u_strength;\nvoid main(void) { gl_FragColor = vec4(s); }",
            "void main() { gl_FragColor = vec4(1.0); }\nconst float s = u_strength;",
            "const float a = u_strength, b = 1.0;\nvoid main() { gl_FragColor = vec4(a); }",
            "const vec2 v = vec2(1.0).u_samples;\nvoid main() { gl_FragColor = vec4(v.x); }",
        ] {
            assert_eq!(hoist_runtime_consts(unchanged, &runtime), unchanged);
        }
    }

    // ---- P7e：varying 的布局 ----

    /// rea-p7e-varying 第 1 条的表：vec3 / vec4 只剩 ceil(n/4) 个、n = 1 退化成普通向量；ivec4 / uvec4 的 `t+1` 是 13 / 15，
    /// n = 1 仍是数组；float / vec2 与 WPE 类型表之外的保持原长度；int / uint / 矩阵数组照报。
    #[test]
    fn varying_array_lengths_follow_wpe() {
        let lengths = |ty: &str| -> Vec<Option<u32>> {
            [1, 2, 4, 5, 32]
                .iter()
                .map(|n| wpe_varying_array("v", ty, *n).unwrap())
                .collect()
        };
        let shortened = [Some(1), Some(1), Some(2), Some(8)];
        for ty in ["vec3", "vec4"] {
            let mut expected = vec![None];
            expected.extend(shortened);
            assert_eq!(lengths(ty), expected, "{ty}");
        }
        for ty in ["ivec4", "uvec4"] {
            let mut expected = vec![Some(1)];
            expected.extend(shortened);
            assert_eq!(lengths(ty), expected, "{ty}");
        }
        for ty in ["float", "vec2", "ivec2", "uvec3"] {
            assert_eq!(
                lengths(ty),
                [Some(1), Some(2), Some(4), Some(5), Some(32)],
                "{ty}"
            );
        }
        for ty in ["int", "uint", "mat3", "mat4", "mat4x3", "mat2"] {
            let error = wpe_varying_array("v_M", ty, 2).unwrap_err();
            assert!(
                error.starts_with(&format!("varying v_M 是 {ty} 数组")),
                "{error}"
            );
        }
    }

    /// 两阶段按换算后的长度比较；被顶点声明覆盖的片元声明连长度也不看（整数数组也不报）。
    #[test]
    fn varying_arrays_are_declared_with_wpe_lengths() {
        let program = build(
            &lines("varying vec4 a[32];\nvarying vec3 b[5];\nvarying vec4 c[1];\nvarying vec2 d[3];\nvarying vec2 e;\nvoid main() {}"),
            &lines("varying vec4 a[30];\nvarying int b[5];\nvarying vec4 c[1];\nvarying vec2 e;\nvoid main() {}"),
        )
        .unwrap();
        let layout: Vec<_> = program
            .varyings
            .iter()
            .map(|v| (v.name.as_str(), v.ty.as_str(), v.array, v.location))
            .collect();
        assert_eq!(
            layout,
            [
                ("a", "vec4", Some(8), 0),
                ("b", "vec3", Some(2), 8),
                ("c", "vec4", None, 10),
                ("d", "vec2", Some(3), 11),
                ("e", "vec2", None, 14),
            ]
        );
        // 15 个不超过上限：没有打包，一个 varying 一行，与原来同形；片元也按顶点的长度声明
        let declarations = "layout(location = 0) out vec4 a[8];\nlayout(location = 8) out vec3 b[2];\nlayout(location = 10) out vec4 c;\nlayout(location = 11) out vec2 d[3];\nlayout(location = 14) out vec2 e;\n";
        assert!(
            program.vertex_glsl.contains(declarations),
            "{}",
            program.vertex_glsl
        );
        assert!(program.fragment_glsl.contains(
            "layout(location = 0) in vec4 a[8];\nlayout(location = 8) in vec3 b[2];\nlayout(location = 10) in vec4 c;\nlayout(location = 14) in vec2 e;\n"
        ));
        assert!(!program.vertex_glsl.contains("kb_main"));

        // 片元自己的声明长度换算后与顶点相同才算同一个（只在片元声明、重复两次的那种）
        let error = build(
            &lines("void main() {}"),
            &lines("varying vec4 f[4];\nvarying vec4 f[5];\nvoid main() {}"),
        )
        .unwrap_err();
        assert_eq!(error.message, "varying f 在两个阶段的类型不同");
        assert!(build(
            &lines("void main() {}"),
            &lines("varying vec4 f[4];\nvarying vec4 f[3];\nvoid main() {}"),
        )
        .is_ok());
        // 整数、矩阵数组照报
        let error = build(
            &lines("varying int v_I[4];\nvoid main() {}"),
            &lines("void main() {}"),
        )
        .unwrap_err();
        assert_eq!(
            (error.stage, error.message.as_str()),
            (
                Stage::Vertex,
                "varying v_I 是 int 数组：WPE 按 float4 插值传递，没有实现（语料 0 处）"
            )
        );
    }

    /// 工坊 `auto_sway`（`NODE_COUNT` 5，`AA_VERSION` 2）的 varying：一个 vec4、两个 float，再每个节点 7 个（5 个 float、2 个 vec2），
    /// 4 个节点共 31 个、42 个分量（3243449890 等的程序，WPE 编译缓存里是 11 个寄存器加位置）。
    pub(crate) fn sway_varyings() -> String {
        let mut out = String::from(
            "varying vec4 v_TexCoord;\nvarying float v_aspect;\nvarying float v_reciprocalAspect;\n",
        );
        for i in 1..=4 {
            out.push_str(&format!(
                "varying float v_Len{i};\nvarying vec2 v_Direction{i};\nvarying float v_EndpointLen{i};\nvarying vec2 v_EndpointDirection{i};\nvarying float v_PosX{i};\nvarying float v_EndpointPosX{i};\nvarying float v_MotionRadian{i};\n"
            ));
        }
        out
    }

    /// 31 个超过 16：按分量数从大到小、同大小按声明顺序放进第一个放得下的 vec4，11 个；顶点先调 kb_main 再装箱，
    /// 片元先拆包再调 kb_main。逐个 vec4 断言（打包不排序、拆包错位一个分量都会被检出）。
    #[test]
    fn auto_sway_varyings_pack_into_eleven_vec4() {
        let vs = format!(
            "{}attribute vec3 a_Position;\nvoid main() {{ gl_Position = vec4(a_Position, 1.0); if (a_Position.x > 0.0) {{ return; }} v_aspect = 2.0; }}",
            sway_varyings()
        );
        let fs = format!(
            "{}void main() {{ gl_FragColor = v_TexCoord * v_MotionRadian4; }}",
            sway_varyings()
        );
        let program = build(&lines(&vs), &lines(&fs)).unwrap();
        let vertex = &program.vertex_glsl;
        let expected_slots = [
            "v_TexCoord",
            "v_Direction1, v_EndpointDirection1",
            "v_Direction2, v_EndpointDirection2",
            "v_Direction3, v_EndpointDirection3",
            "v_Direction4, v_EndpointDirection4",
            "v_aspect, v_reciprocalAspect, v_Len1, v_EndpointLen1",
            "v_PosX1, v_EndpointPosX1, v_MotionRadian1, v_Len2",
            "v_EndpointLen2, v_PosX2, v_EndpointPosX2, v_MotionRadian2",
            "v_Len3, v_EndpointLen3, v_PosX3, v_EndpointPosX3",
            "v_MotionRadian3, v_Len4, v_EndpointLen4, v_PosX4",
            "v_EndpointPosX4, v_MotionRadian4, 0.0, 0.0",
        ];
        let mut entry = String::from("void main() {\n    kb_main();\n");
        for (slot, parts) in expected_slots.iter().enumerate() {
            assert!(
                vertex.contains(&format!(
                    "layout(location = {slot}) out vec4 kb_varying_{slot};\n"
                )),
                "{vertex}"
            );
            entry.push_str(&format!("    kb_varying_{slot} = vec4({parts});\n"));
        }
        entry.push_str("}\n");
        assert!(vertex.ends_with(&entry), "{vertex}");
        assert!(!vertex.contains("location = 11"), "{vertex}");
        // 原来的 varying 改成私有全局、按声明顺序；作者的 main 改名，提前 return 照旧在 kb_main 里
        assert!(vertex.contains("\nvec4 v_TexCoord;\nfloat v_aspect;\nfloat v_reciprocalAspect;\nfloat v_Len1;\nvec2 v_Direction1;\n"), "{vertex}");
        assert!(vertex.contains("void kb_main() { gl_Position = vec4(a_Position, 1.0); if (a_Position.x > 0.0) { return; } v_aspect = 2.0; }"), "{vertex}");
        assert!(
            !vertex.contains(" out float") && !vertex.contains(" out vec2"),
            "{vertex}"
        );

        // 片元：每个分量拆回原名，vec4 整体赋值
        let fragment = &program.fragment_glsl;
        for (name, source) in [
            ("v_TexCoord", "kb_varying_0"),
            ("v_Direction1", "kb_varying_1.xy"),
            ("v_EndpointDirection1", "kb_varying_1.zw"),
            ("v_EndpointDirection4", "kb_varying_4.zw"),
            ("v_aspect", "kb_varying_5.x"),
            ("v_EndpointLen1", "kb_varying_5.w"),
            ("v_PosX1", "kb_varying_6.x"),
            ("v_MotionRadian3", "kb_varying_9.x"),
            ("v_EndpointPosX4", "kb_varying_10.x"),
            ("v_MotionRadian4", "kb_varying_10.y"),
        ] {
            assert!(
                fragment.contains(&format!("    {name} = {source};\n")),
                "{name}: {fragment}"
            );
        }
        assert!(
            fragment.ends_with("    v_MotionRadian4 = kb_varying_10.y;\n    kb_main();\n}\n"),
            "{fragment}"
        );
        assert_eq!(fragment.matches(" in vec4 kb_varying_").count(), 11);

        // 反射是实际的接口
        let interface: Vec<_> = program
            .varyings
            .iter()
            .map(|v| (v.name.clone(), v.ty.as_str(), v.array, v.location))
            .collect();
        let expected: Vec<_> = (0..11)
            .map(|i| (format!("kb_varying_{i}"), "vec4", None, i))
            .collect();
        assert_eq!(interface, expected);
    }

    /// 片元只声明装着自己 varying 的 vec4；只在片元声明的 varying 照样有一个片段（顶点那边是零）；片元可以改写 varying。
    #[test]
    fn packed_fragment_declares_only_its_own_slots() {
        let vs = format!("{}void main() {{ v_aspect = 2.0; }}", sway_varyings());
        let fs = "varying vec2 v_FragOnly;\nvarying float v_MotionRadian4;\nvoid main() { v_MotionRadian4 *= 2.0; gl_FragColor = vec4(v_FragOnly, v_MotionRadian4, 1.0); }";
        let program = build(&lines(&vs), &lines(fs)).unwrap();
        // 9 个 vec2：v_FragOnly 排在顶点的 8 个之后，进第 5 个 vec4 的 xy；之后的标量顺延
        let fragment = &program.fragment_glsl;
        // 私有全局按共享表的顺序：顶点声明的在前，只在片元声明的接在后面
        assert!(fragment.contains("layout(location = 5) in vec4 kb_varying_5;\nlayout(location = 10) in vec4 kb_varying_10;\nfloat v_MotionRadian4;\nvec2 v_FragOnly;\n"), "{fragment}");
        assert_eq!(fragment.matches(" in vec4 ").count(), 2, "{fragment}");
        assert!(fragment.ends_with("void main() {\n    v_FragOnly = kb_varying_5.xy;\n    v_MotionRadian4 = kb_varying_10.w;\n    kb_main();\n}\n"), "{fragment}");
        assert!(fragment.contains("void kb_main() { v_MotionRadian4 *= 2.0;"));
        let vertex = &program.vertex_glsl;
        assert!(
            vertex.contains("    kb_varying_5 = vec4(v_FragOnly, v_aspect, v_reciprocalAspect);\n"),
            "{vertex}"
        );
        assert!(vertex.contains("\nvec2 v_FragOnly;\n"), "{vertex}");
        assert_eq!(program.varyings.len(), 11);
    }

    /// 阈值：16 个不打包、输出一个 varying 一行（与改前同形）；17 个打包。
    #[test]
    fn packing_starts_above_sixteen_locations() {
        let shader = |count: usize| {
            let decls: String = (0..count)
                .map(|i| format!("varying float v_{i};\n"))
                .collect();
            build(
                &lines(&format!("{decls}void main() {{ v_0 = 1.0; }}")),
                &lines(&format!(
                    "{decls}void main() {{ gl_FragColor = vec4(v_0); }}"
                )),
            )
            .unwrap()
        };
        let program = shader(16);
        for glsl in [&program.vertex_glsl, &program.fragment_glsl] {
            assert!(
                !glsl.contains("kb_varying") && !glsl.contains("kb_main"),
                "{glsl}"
            );
            assert!(glsl.contains("void main() {"), "{glsl}");
        }
        assert!(program
            .vertex_glsl
            .contains("layout(location = 15) out float v_15;\n"));
        assert_eq!(program.varyings.len(), 16);

        let program = shader(17);
        assert_eq!(
            program
                .varyings
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>(),
            [
                "kb_varying_0",
                "kb_varying_1",
                "kb_varying_2",
                "kb_varying_3",
                "kb_varying_4"
            ]
        );
        assert!(program
            .vertex_glsl
            .contains("    kb_varying_4 = vec4(v_16, 0.0, 0.0, 0.0);\n"));
        assert!(program
            .fragment_glsl
            .contains("void kb_main() { kb_FragColor = vec4(v_0); }"));
    }

    /// 整数 varying 不打包：接在 vec4 之后、各占自己的 location、带 flat；数组元素与矩阵列各是一个片段。
    #[test]
    fn integer_varyings_stay_unpacked() {
        // 不打包是 1 + 8 + 3 + 1 + 2 + 1 + 1 = 17 个（v_Arr 照 WPE 缩成 8 个、v_B 缩成 2 个）
        let decls = "varying uvec4 v_Bones;\nvarying vec4 v_Arr[32];\nvarying mat3 v_M;\nvarying float v_A;\nvarying vec3 v_B[5];\nvarying ivec2 v_I;\nvarying vec2 v_C;\n";
        let program = build(
            &lines(&format!("{decls}void main() {{}}")),
            &lines(
                "varying uvec4 v_Bones;\nvarying mat3 v_M;\nvarying vec3 v_B[5];\nvoid main() {}",
            ),
        )
        .unwrap();
        let interface: Vec<_> = program
            .varyings
            .iter()
            .map(|v| (v.name.as_str(), v.ty.as_str(), v.location))
            .collect();
        // 8 个 vec4；mat3 三列与 v_B 两个元素是 5 个 vec3（各空一个分量）；v_C 放不进空位、另起一个，v_A 填进第一个空位：
        // 共 14 个 vec4，整数 2 个
        assert_eq!(interface.len(), 16, "{interface:?}");
        assert_eq!(interface[14], ("v_Bones", "uvec4", 14));
        assert_eq!(interface[15], ("v_I", "ivec2", 15));
        let vertex = &program.vertex_glsl;
        assert!(vertex.contains("layout(location = 14) flat out uvec4 v_Bones;\nlayout(location = 15) flat out ivec2 v_I;\n"), "{vertex}");
        assert!(
            vertex.contains("\nvec4 v_Arr[8];\nmat3 v_M;\nfloat v_A;\nvec3 v_B[2];\nvec2 v_C;\n"),
            "{vertex}"
        );
        assert!(vertex.contains("    kb_varying_7 = vec4(v_Arr[7]);\n    kb_varying_8 = vec4(v_M[0], v_A);\n    kb_varying_9 = vec4(v_M[1], 0.0);\n"), "{vertex}");
        assert!(vertex.contains("    kb_varying_12 = vec4(v_B[1], 0.0);\n    kb_varying_13 = vec4(v_C, 0.0, 0.0);\n"), "{vertex}");
        let fragment = &program.fragment_glsl;
        assert!(
            fragment.contains("layout(location = 14) flat in uvec4 v_Bones;\n"),
            "{fragment}"
        );
        assert!(!fragment.contains("v_I"), "{fragment}");
        assert!(fragment.contains("    v_M[2] = kb_varying_10.xyz;\n    v_B[0] = kb_varying_11.xyz;\n    v_B[1] = kb_varying_12.xyz;\n"), "{fragment}");
    }

    /// 打包后仍超过 16 个、作者用了保留名、认不出 main、几何展开的程序超过上限：都在改写阶段报错。
    #[test]
    fn packing_failures_are_rewrite_errors() {
        // 17 个 vec4：装不下
        let decls: String = (0..17).map(|i| format!("varying vec4 v_{i};\n")).collect();
        let error = build(
            &lines(&format!("{decls}void main() {{}}")),
            &lines("void main() {}"),
        )
        .unwrap_err();
        assert_eq!(error.stage, Stage::Vertex);
        assert_eq!(
            error.message,
            "varying 装进 vec4 之后仍要 17 个 location（不打包是 17 个），超过 WebGPU 的 16 个"
        );
        // 12 个 vec4 + 5 个 uint：整数不打包
        let decls: String = (0..12)
            .map(|i| format!("varying vec4 v_{i};\n"))
            .chain((0..5).map(|i| format!("varying uint v_u{i};\n")))
            .collect();
        let error = build(
            &lines(&format!("{decls}void main() {{}}")),
            &lines("void main() {}"),
        )
        .unwrap_err();
        assert!(error.message.contains("仍要 17 个"), "{}", error.message);

        let decls: String = (0..17).map(|i| format!("varying float v_{i};\n")).collect();
        let error = build(
            &lines(&format!(
                "{decls}void kb_main() {{}}\nvoid main() {{ kb_main(); }}"
            )),
            &lines("void main() {}"),
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "varying 要打包，但正文里已有标识符 kb_main（kb_ 前缀是翻译器保留的）"
        );
        let error = build(
            &lines(&format!("{decls}void main() {{}}")),
            &lines("float kb_varying_3;\nvoid main() {}"),
        )
        .unwrap_err();
        assert_eq!(error.stage, Stage::Fragment);
        assert!(error.message.contains("kb_varying_3"), "{}", error.message);
        let error = build(
            &lines(&format!("{decls}void main(void) {{}}")),
            &lines("void main() {}"),
        )
        .unwrap_err();
        assert!(error.message.contains("认不出 main"), "{}", error.message);

        // 几何展开拼成的顶点段（行来自 `<geometry>`）：不打包，超过就报错
        let mut vertex = lines(&format!("{decls}void main() {{}}"));
        vertex.push(Line {
            code: String::new(),
            comment: None,
            file: crate::geometry::GENERATED_FILE.into(),
            line: 1,
        });
        let error = build(&vertex, &lines("void main() {}")).unwrap_err();
        assert!(
            error.message.starts_with("几何着色器展开的程序"),
            "{}",
            error.message
        );
    }

    // ---- 上界是字面量 0 的 smoothstep（P7e 收尾，示波器静音时提亮） ----

    /// 上界是字面量 0、下界不是数字字面量的换成 `kb_smoothstep0`；其余原样拼回（空白也不变），嵌套的照常改写。
    #[test]
    fn zero_edge_smoothstep_is_rewritten() {
        for (source, expected) in [
            (
                "float s = smoothstep(thickness * 0.015, 0.0, dist);",
                "float s = kb_smoothstep0(thickness * 0.015, dist);",
            ),
            ("smoothstep(feather, 0, d)", "kb_smoothstep0(feather, d)"),
            (
                "smoothstep( -feather , ( 0. ) , d )",
                "kb_smoothstep0(-feather, d)",
            ),
            (
                "smoothstep(size, .0f, length(delta))",
                "kb_smoothstep0(size, length(delta))",
            ),
            (
                "smoothstep(a, 0.0, smoothstep(b, 0, x))",
                "kb_smoothstep0(a, kb_smoothstep0(b, x))",
            ),
            (
                "smoothstep(0.2, 0.0, smoothstep(b, 0.0, x))",
                "smoothstep(0.2, 0.0, kb_smoothstep0(b, x))",
            ),
            (
                "f(smoothstep(a, 00.000, x)) + 1.5",
                "f(kb_smoothstep0(a, x)) + 1.5",
            ),
        ] {
            assert_eq!(rewrite_zero_edge_smoothstep(source), expected, "{source}");
        }
        for unchanged in [
            // 下界是数字字面量：分母不会是 ±0，结果和内建相同
            "smoothstep(0.2, 0.0, d)",
            "smoothstep(1, 0, length(v_TexCoord - 0.5))",
            "smoothstep(-0.3, 0.0, screenUV.x)",
            // 上界不是 +0 的字面量
            "smoothstep(a, -0.0, x)",
            "smoothstep(a, 0.5, x)",
            "smoothstep(a, 1e-3, x)",
            "smoothstep (a,  b,x)",
            "smoothstep(a, zero, x)",
            // 不是这个函数
            "mysmoothstep(a, 0.0, x)",
            "kb_smoothstep(a, 0.0, x)",
            "v_smoothstep2 = 0.0;",
        ] {
            assert_eq!(rewrite_zero_edge_smoothstep(unchanged), unchanged);
        }
    }

    #[test]
    fn number_literals_for_smoothstep_edges() {
        for zero in [
            "0",
            "0.0",
            "0.",
            ".0",
            "0.0f",
            "(0)",
            " ( 0.0 ) ",
            "00.000",
            "+0.0",
            "0e5",
        ] {
            assert!(is_zero_literal(zero), "{zero}");
        }
        for not_zero in [
            "-0.0",
            "-0",
            "0.5",
            "a",
            "0x0",
            "",
            ".",
            "0.0 * a",
            "(0.0) + b",
        ] {
            assert!(!is_zero_literal(not_zero), "{not_zero}");
        }
        for number in ["1e-3", "-2.0f", "(1.2)", ".5", "3"] {
            assert!(is_number_literal(number), "{number}");
        }
        for other in ["a", "-feather", "thickness * 0.015", "2.0 * a", "1.0.0"] {
            assert!(!is_number_literal(other), "{other}");
        }
    }
}
