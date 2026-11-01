//! 单个阶段的 naga 编译：GLSL 450 解析 → 按 WebGPU 基线校验 → 输出 WGSL，并读出 uniform 块的 std140 布局。

use std::collections::BTreeMap;

use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::{AddressSpace, ArraySize, Handle, Module, ScalarKind, Type, TypeInner};

use crate::{Diagnostic, Stage};

pub struct Compiled {
    pub wgsl: String,
    pub entry_point: String,
    /// group 0 / binding 0 的 uniform 块成员：名字 → 布局。
    pub block: BTreeMap<String, MemberLayout>,
    pub block_size: Option<u32>,
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

pub fn compile(
    stage: Stage,
    source: &str,
    defines: &BTreeMap<String, String>,
) -> Result<Compiled, Failure> {
    let naga_stage = match stage {
        Stage::Vertex => naga::ShaderStage::Vertex,
        Stage::Fragment => naga::ShaderStage::Fragment,
    };
    let mut options = naga::front::glsl::Options::from(naga_stage);
    options.defines.extend(
        defines
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );

    let module = naga::front::glsl::Frontend::default()
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
    Ok(Compiled {
        wgsl,
        entry_point,
        block,
        block_size,
    })
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
