//! 单个阶段的 naga 编译：GLSL 450 解析 → 按 WebGPU 基线校验 → 输出 WGSL，并读出 uniform 块的 std140 布局
//! 与入口可达的代码读到了哪些块成员。

use std::collections::{BTreeMap, BTreeSet};

use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::{AddressSpace, ArraySize, Expression, Handle, Module, ScalarKind, Type, TypeInner};

use crate::{Diagnostic, Stage};

pub struct Compiled {
    pub wgsl: String,
    pub entry_point: String,
    /// group 0 / binding 0 的 uniform 块成员：名字 → 布局。
    pub block: BTreeMap<String, MemberLayout>,
    pub block_size: Option<u32>,
    /// 本阶段入口可达的代码读到的块成员名（见 [`read_members`]）。
    pub read: BTreeSet<String>,
    /// 本阶段入口可达的代码读到的私有全局变量名（顶点阶段的输入属性在其中，见 [`inputs_read`]）。
    pub inputs_read: BTreeSet<String>,
}

#[derive(Debug, Clone)]
pub struct MemberLayout {
    pub offset: u32,
    pub size: u32,
    pub ty: String,
    /// 数组的元素步长（std140 下标量数组也是 16）。
    pub stride: Option<u32>,
}

pub struct Failure {
    pub phase: &'static str,
    pub errors: Vec<Diagnostic>,
}

/// 我们代替 HLSL 内置函数补的包装：在 naga 里是用户函数，HLSL 模式的重载第二遍要按内置函数的规则选
/// （实参截到最窄的维度、标量铺满），不能按用户函数「多个能匹配就报二义」（`water_caustics` 的 `pow(float, vec3)`
/// 有 6 个能匹配的 `kb_pow`）。`kb_pow` / `kb_max` / `kb_min` 是 `rewrite::broadcast_helpers` 的标量扩展重载，
/// `kb_gs_normalize` 是几何着色器展开给 `normalize` 换的版本（`geometry.rs`）。
const INTRINSIC_WRAPPERS: &[&str] = &["kb_pow", "kb_max", "kb_min", "kb_gs_normalize"];

pub fn compile(
    stage: Stage,
    source: &str,
    defines: &BTreeMap<String, String>,
) -> Result<Compiled, Failure> {
    let naga_stage = match stage {
        // 几何段拼进顶点段后按顶点着色器编译，不会单独到这里
        Stage::Vertex | Stage::Geometry => naga::ShaderStage::Vertex,
        Stage::Fragment => naga::ShaderStage::Fragment,
    };
    let mut options = naga::front::glsl::Options::from(naga_stage);
    // 作者的代码按 HLSL 的隐式转换编译（WPE 交给 fxc），见 naga/KABEGAME.md「行为补丁」
    options.hlsl_implicit = true;
    options.hlsl_intrinsics.extend(INTRINSIC_WRAPPERS.iter().map(|name| name.to_string()));
    options.defines.extend(
        defines
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );

    let mut module = naga::front::glsl::Frontend::default()
        .parse(&options, source)
        .map_err(|errors| Failure {
            phase: "parse",
            errors: errors
                .errors
                .iter()
                .map(|error| {
                    Diagnostic::at(error.kind.to_string(), span_location(error.meta, source))
                })
                .collect(),
        })?;

    // WebGPU 基线：不开任何扩展能力，产物要能被浏览器的 WGSL 校验接受
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|error| Failure {
            phase: "validate",
            errors: vec![Diagnostic::at(
                error_chain(error.as_inner()),
                error.location(source),
            )],
        })?;

    let wgsl =
        naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
            .map_err(|error| Failure {
                phase: "write",
                errors: vec![Diagnostic::at(error.to_string(), None)],
            })?;

    let entry_point = module
        .entry_points
        .iter()
        .find(|entry| entry.stage == naga_stage)
        .map(|entry| entry.name.clone())
        .unwrap_or_else(|| "main".to_string());
    let (block, block_size) = uniform_block(&module);
    // 布局与 WGSL 都取完了才做：compact 会删掉没用到的函数、表达式与全局变量。块成员与输入两种「读」共用这一次
    naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
    let read = read_members(&module);
    let inputs_read = inputs_read(&module);
    Ok(Compiled {
        wgsl,
        entry_point,
        block,
        block_size,
        read,
        inputs_read,
    })
}

/// compact 之后剩下的函数：被 `Call` 到的普通函数与入口点。
fn reachable_functions(module: &Module) -> impl Iterator<Item = &naga::Function> {
    module
        .functions
        .iter()
        .map(|(_, function)| function)
        .chain(module.entry_points.iter().map(|entry| &entry.function))
}

/// 本阶段入口可达的代码读到的 uniform 块成员（按成员名，即 `rewrite::block_member_name`），`module` 必须已通过校验、
/// 已做过 compact（`compile` 里做，见下）。
///
/// 判据是 naga IR 里的语法引用：从入口函数出发、沿 `Statement::Call` 可达的函数里，有语句（或被语句用到的表达式）
/// 用到 `AccessIndex { base: GlobalVariable(块), index }`。所以：
/// - 只在关掉的 `#if` 里读：预处理已经删掉，不算；
/// - 只在没被调用的函数里读（包括两阶段都会生成的补齐数组还原函数 `kb_load_*`，只在用到时才被调用）：不算；
/// - `return` 之后的死代码：前端补丁不生成语句（naga/KABEGAME.md「行为补丁」），不算；
/// - 结果没被用到的读（`float x = u_a;` 之后再不用 `x`、`u_a * 0.0`）：仍算。fxc 会删掉这些，WPE 的反射里就没有它们，
///   这是两种判据的差别（p7-REPORT「P7d 的实测」，phase-7d-fluid 风险 2）；
/// - `kb_pack_*`（`main` 之前的打包形态，pack.rs）越界读到的其它成员：函数被调用时算被读（保守）。
///
/// 不能直接扫各函数的表达式表：GLSL 前端在每个函数开头都预先放好全部全局变量与块成员的表达式（`Context::new` →
/// `add_global`），它们只出现在 `Emit` 里。所以先做 naga 的 compact（`KeepUnused::No`）：入口点照留，被 `Call` 到的函数
/// 才留（没被调用的删掉），每个函数里从语句出发反向标记用到的表达式（`Emit` 不算使用，前端不产生具名表达式），其余删掉；
/// 之后剩下的块成员 `AccessIndex` 就是被读的。一个成员也没读时整个块变量会被删掉，结果为空。
///
/// 匿名块（`uniform KbUniforms { … };`）没有实例名，GLSL 里只能按成员名引用，前端一律生成 `AccessIndex`
/// （`GlobalLookupKind::BlockSelect`）；整块 `Load` 或把块指针传给函数的写法不会出现。
fn read_members(module: &Module) -> BTreeSet<String> {
    let mut read = BTreeSet::new();
    let Some((block, members)) = module.global_variables.iter().find_map(|(handle, var)| {
        let is_block = var.space == AddressSpace::Uniform
            && var.binding.as_ref().is_some_and(|slot| {
                slot.group == 0 && slot.binding == crate::rewrite::UNIFORM_BINDING
            });
        match &module.types[var.ty].inner {
            TypeInner::Struct { members, .. } if is_block => Some((handle, members)),
            _ => None,
        }
    }) else {
        return read;
    };
    for function in reachable_functions(module) {
        for (_, expression) in function.expressions.iter() {
            let Expression::AccessIndex { base, index } = *expression else {
                continue;
            };
            if !matches!(function.expressions[base], Expression::GlobalVariable(global) if global == block)
            {
                continue;
            }
            if let Some(name) = members
                .get(index as usize)
                .and_then(|member| member.name.clone())
            {
                read.insert(name);
            }
        }
    }
    read
}

/// 本阶段入口可达的代码读到的私有全局变量（按名字），`module` 必须已做过 compact（同 [`read_members`]）。
///
/// GLSL 前端把每个 `in` 声明做成同名的私有全局变量，入口包装函数（`front/glsl/functions.rs` 的 `add_entry_point`）先把入口参数
/// `Store` 进去、再调用户的 `main`。所以顶点属性被读，就是有 `Load` 的指针沿 `AccessIndex` / `Access` 链回到这个全局变量：
/// 读整个变量与 `.x` / `.xy` 这类分量是直接 `Load` 全局变量再取；下标写法（常量下标 `a[2]`、动态下标 `a[i]`、属性数组的元素）
/// 是在全局变量的指针上建 `AccessIndex` / `Access` 链再 `Load`（单测 `inputs_read_follow_pointer_chains`）。包装函数对输入只有
/// `Store`，不算。包装函数对输出（`gl_Position`、varying）的 `Load` 也会进结果，调用方只按属性名查。
///
/// 判据同 [`read_members`]：只在没被调用的函数里读、只在关掉的 `#if` 里读不算；结果没被用到的读仍算。WPE 的 fxc 会把这种读连同
/// 输入一起从签名里删掉，我们多算被读，宿主只会多报（p5-REPORT「P5c 语义的实测核对」的缺属性一行）。
fn inputs_read(module: &Module) -> BTreeSet<String> {
    let mut read = BTreeSet::new();
    for function in reachable_functions(module) {
        for (_, expression) in function.expressions.iter() {
            let Expression::Load { mut pointer } = *expression else {
                continue;
            };
            let global = loop {
                match function.expressions[pointer] {
                    Expression::AccessIndex { base, .. } | Expression::Access { base, .. } => {
                        pointer = base
                    }
                    Expression::GlobalVariable(global) => break Some(global),
                    _ => break None,
                }
            };
            let Some(var) = global.map(|global| &module.global_variables[global]) else {
                continue;
            };
            if var.space == AddressSpace::Private {
                if let Some(name) = &var.name {
                    read.insert(name.clone());
                }
            }
        }
    }
    read
}

/// 空 span（未定义位置）或越界时不给行列号。
fn span_location(span: naga::Span, source: &str) -> Option<naga::SourceLocation> {
    let range = span.to_range()?;
    if range.is_empty() || range.end > source.len() {
        return None;
    }
    Some(span.location(source))
}

/// 校验错误常把具体原因放在 `source()` 链里，拼成一行。
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut cause = error.source();
    while let Some(inner) = cause {
        message.push_str(": ");
        message.push_str(&inner.to_string());
        cause = inner.source();
    }
    message
}

fn uniform_block(module: &Module) -> (BTreeMap<String, MemberLayout>, Option<u32>) {
    let gctx = module.to_ctx();
    for (_, var) in module.global_variables.iter() {
        let is_block = var.space == AddressSpace::Uniform
            && var.binding.as_ref().is_some_and(|slot| {
                slot.group == 0 && slot.binding == crate::rewrite::UNIFORM_BINDING
            });
        if !is_block {
            continue;
        }
        let inner = &module.types[var.ty].inner;
        let TypeInner::Struct { members, .. } = inner else {
            continue;
        };
        let layout = members
            .iter()
            .map(|member| {
                let member_inner = &module.types[member.ty].inner;
                let stride = match member_inner {
                    TypeInner::Array { stride, .. } => Some(*stride),
                    _ => None,
                };
                (
                    member.name.clone().unwrap_or_default(),
                    MemberLayout {
                        offset: member.offset,
                        size: member_inner.size(gctx),
                        ty: type_name(module, member.ty),
                        stride,
                    },
                )
            })
            .collect();
        return (layout, Some(inner.size(gctx)));
    }
    (BTreeMap::new(), None)
}

/// WGSL 写法的类型名，给前端打包 uniform 用。
pub fn type_name(module: &Module, ty: Handle<Type>) -> String {
    let ty = &module.types[ty];
    match &ty.inner {
        TypeInner::Scalar(scalar) => scalar_name(*scalar),
        TypeInner::Vector { size, scalar } => {
            format!("vec{}<{}>", *size as u8, scalar_name(*scalar))
        }
        TypeInner::Matrix {
            columns,
            rows,
            scalar,
        } => {
            format!(
                "mat{}x{}<{}>",
                *columns as u8,
                *rows as u8,
                scalar_name(*scalar)
            )
        }
        TypeInner::Array { base, size, .. } => match size {
            ArraySize::Constant(count) => format!("array<{}, {}>", type_name(module, *base), count),
            _ => format!("array<{}>", type_name(module, *base)),
        },
        TypeInner::Struct { .. } => ty.name.clone().unwrap_or_else(|| "struct".to_string()),
        other => format!("{other:?}"),
    }
}

fn scalar_name(scalar: naga::Scalar) -> String {
    match (scalar.kind, scalar.width) {
        (ScalarKind::Float, 4) => "f32".to_string(),
        (ScalarKind::Float, 2) => "f16".to_string(),
        (ScalarKind::Sint, 4) => "i32".to_string(),
        (ScalarKind::Uint, 4) => "u32".to_string(),
        (ScalarKind::Bool, _) => "bool".to_string(),
        (kind, width) => format!("{kind:?}{}", u32::from(width) * 8),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERTEX: &str = "#version 450
layout(set = 0, binding = 0, std140) uniform KbUniforms {
    mat4 g_ModelViewProjectionMatrix;
    float g_Time;
    vec4 g_Color4;
    vec4 g_Weights[3];
};
layout(location = 0) in vec3 a_Position;
void main() {
    gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0) * g_Color4.x * g_Weights[1].x * g_Time;
}
";

    #[test]
    fn std140_offsets_are_reported() {
        let compiled = compile(Stage::Vertex, VERTEX, &BTreeMap::new())
            .ok()
            .expect("compiles");
        assert!(compiled.wgsl.contains("@vertex"), "{}", compiled.wgsl);
        let offset = |name: &str| compiled.block[name].offset;
        assert_eq!(offset("g_ModelViewProjectionMatrix"), 0);
        assert_eq!(offset("g_Time"), 64);
        assert_eq!(offset("g_Color4"), 80);
        assert_eq!(offset("g_Weights"), 96);
        assert_eq!(compiled.block["g_Weights"].stride, Some(16));
        assert_eq!(compiled.block_size, Some(144));
        assert_eq!(
            compiled.block["g_ModelViewProjectionMatrix"].ty,
            "mat4x4<f32>"
        );
    }

    /// GLSL 450 允许 int → float 的隐式转换；WPE 方言大量依赖（`vec2(1, 0.3)`、`pow(x, 5)`、`a = 1;`）。
    #[test]
    fn implicit_int_to_float_is_accepted() {
        let source = "#version 450\nlayout(location = 0) out vec4 o;\nvoid main() { float x = 1; o = vec4(x * 2, pow(x, 5), 1 - x, 0); o.a = 1; }\n";
        let result = compile(Stage::Fragment, source, &BTreeMap::new());
        assert!(result.is_ok(), "{:?}", result.err().map(|f| f.errors));
    }

    /// 每个函数开头都有前端预先放的全部块成员表达式；只有入口可达、被语句用到的才算读。
    #[test]
    fn read_members_follow_reachable_uses() {
        let source = "#version 450
layout(set = 0, binding = 0, std140) uniform KbUniforms {
    float u_a;
    float u_b;
    float u_c;
    vec4 u_d;
};
layout(location = 0) out vec4 o;
float helper() { return u_b; }
float orphan() { return u_c; }
void main() { o = vec4(u_a + helper(), u_d.y, 0.0, 1.0); }
";
        let compiled = compile(Stage::Fragment, source, &BTreeMap::new())
            .ok()
            .expect("compiles");
        assert_eq!(
            compiled.read.iter().map(String::as_str).collect::<Vec<_>>(),
            ["u_a", "u_b", "u_d"]
        );
        // 没被调用的函数照样写进 WGSL：只改反射
        assert!(compiled.wgsl.contains("fn orphan"), "{}", compiled.wgsl);
        assert_eq!(compiled.block.len(), 4);
    }

    /// 输入属性：直接读、只读分量、在被 `main` 调用的函数里读都算；只声明、只在没被调用的函数里读不算。包装函数的 `Store` 不算读。
    #[test]
    fn inputs_read_follow_reachable_loads() {
        let source = "#version 450
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec2 a_TexCoord;
layout(location = 2) in vec3 a_Normal;
layout(location = 3) in vec4 a_Color;
layout(location = 4) in vec4 a_Tangent4;
layout(location = 5) in vec4 a_BlendWeights;
float helper() { return a_Normal.y; }
float orphan() { return a_Tangent4.x; }
void main() { gl_Position = vec4(a_Position, 1.0) * a_TexCoord.x * helper(); }
";
        let compiled = compile(Stage::Vertex, source, &BTreeMap::new())
            .ok()
            .expect("compiles");
        assert!(compiled.inputs_read.contains("a_Position"));
        assert!(compiled.inputs_read.contains("a_TexCoord"));
        assert!(compiled.inputs_read.contains("a_Normal"));
        for name in ["a_Color", "a_Tangent4", "a_BlendWeights"] {
            assert!(!compiled.inputs_read.contains(name), "{name}");
        }
        // 没读的输入照样是入口参数：只改反射
        assert!(
            compiled.wgsl.contains("@location(3) a_Color"),
            "{}",
            compiled.wgsl
        );
    }

    /// 在指针上取下标再 `Load` 的写法：GLSL 前端对 `.x`、`.xy` 这类分量是先整体 `Load` 再取（上一个用例），对下标写法则在全局变量的
    /// 指针上建 `AccessIndex` / `Access` 链再 `Load`：常量下标取分量 `a_Const[2]`（`AccessIndex { base: GlobalVariable }`）、动态下标
    /// `a_Dyn[i]`（`Access { base: GlobalVariable, index }`）、属性数组的元素再取分量 `a_Arr[1][2]`（两层 `AccessIndex`）。每个属性都只在
    /// 这种写法里读，回溯链断了就会被漏掉。矩阵属性在 WebGPU 里不能做入口输入（naga 校验报错），属性表里也没有，不在这里。
    #[test]
    fn inputs_read_follow_pointer_chains() {
        let source = "#version 450
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Const;
layout(location = 2) in vec4 a_Dyn;
layout(location = 3) in vec4 a_Arr[2];
layout(location = 5) in vec4 a_Unread;
void main() {
    gl_Position = vec4(a_Position, a_Const[2] + a_Dyn[gl_VertexIndex & 3] + a_Arr[1][2]);
}
";
        let compiled = compile(Stage::Vertex, source, &BTreeMap::new())
            .ok()
            .expect("compiles");
        for name in ["a_Position", "a_Const", "a_Dyn", "a_Arr"] {
            assert!(compiled.inputs_read.contains(name), "{name}");
        }
        assert!(!compiled.inputs_read.contains("a_Unread"));
    }

    #[test]
    fn nothing_read_gives_empty_set() {
        let source = "#version 450
layout(set = 0, binding = 0, std140) uniform KbUniforms { float u_a; };
layout(location = 0) out vec4 o;
void main() { o = vec4(1.0); }
";
        let compiled = compile(Stage::Fragment, source, &BTreeMap::new())
            .ok()
            .expect("compiles");
        assert!(compiled.read.is_empty());
        assert_eq!(compiled.block.len(), 1);
    }

    #[test]
    fn parse_error_carries_line() {
        let source = "#version 450\nvoid main() {\n  undefined_call();\n}\n";
        let failure = compile(Stage::Fragment, source, &BTreeMap::new())
            .err()
            .expect("fails");
        assert_eq!(failure.phase, "parse");
        assert_eq!(failure.errors[0].line, Some(3), "{:?}", failure.errors);
    }
}
