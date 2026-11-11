//! `main` 之前看到的打包数组（P7b 步骤 3）。
//!
//! WPE 把 `float` / `vec2` / `int` / `uint` 数组 uniform（accessArray，只看类型）在常量缓冲里声明成打包类型
//! `float4` / `int4` / `uint4`、长度 `ceil(n/4)`；`main` 开头再拆包成 `float accessArray<名>[n]`，并且只把 `main` 签名
//! **之后**的文本里的名字换成拆包后的数组。`main` 之前的文本（全局辅助函数、文件顶部的 `#define`）看到的仍是打包形态：
//! `X[e]` 是第 `e` 行（4 个分量），`X[i/4][i%4]` 才是第 `i` 个元素（rea-p7-shader「accessArray 的适用条件（补查）」、
//! 「P7b 补查」第 4 条）。
//!
//! 这里只处理 `float` / `int` / `uint` 数组在 `main` 签名之前的下标访问：`X[e]` 改成 `kb_pack_X(e)`，返回第 `e` 行
//! （`vec4` / `ivec4` / `uvec4`，第 k 行是原数组 4k…4k+3 号元素，不足的补 0）。`main` 里照旧是 `kb_load_X()` 还原的
//! `float[n]`。`vec2` 数组 WPE 也打包成 `float4[ceil(n/4)]`（装不下 2n 个分量），语料里没有实例，不做。
//!
//! **越界**照 D3D11 实测（p7-REPORT「P7b 规则的实测」`kbpack`）：行号超出本数组时读同一个常量缓冲里按本阶段声明顺序
//! 排在后面（或前面）的成员，出了整个常量缓冲才是 0。所以要按 HLSL cbuffer 的打包规则复刻本阶段的
//! `g_bufStatic` / `g_bufDynamic` 布局（[`layout`]），每一行由哪些成员的哪些分量组成，生成一串常量下标的分支。
//! WGSL 对数组越界会钳位到范围内，不显式判界就和 WPE 不同。

use std::collections::BTreeMap;

use crate::preprocess::split_ident;

/// `wallpaper64.exe` 2.8.42 的内置 uniform 名表，按 ID 顺序（0x00–0x8b，共 140 项）。
///
/// 来源：rea-p7-shader「P7b 补查」第 5 条。名表由 `FUN_140002860` 建（`0x1400042fd` 处条目数 0x8c），名字 → ID 用脚本
/// 模拟建表指令提取。WPE 生成 HLSL 时按名字查这张表决定 uniform 进哪个常量缓冲（`0x1400f6d6d`–`0x1400f709f`）：
/// 不在表里的（所有材质 uniform）进 `g_bufStatic`；表里的见 [`cbuffer_of`]。
const ENGINE_UNIFORMS: [&str; 140] = [
    "g_Alpha",                                   // 0x00
    "g_Color",                                   // 0x01
    "g_Color4",                                  // 0x02
    "g_Time",                                    // 0x03
    "g_Frametime",                               // 0x04
    "g_Daytime",                                 // 0x05
    "g_TexelSizeHalf",                           // 0x06
    "g_TexelSize",                               // 0x07
    "g_Screen",                                  // 0x08
    "g_ModelMatrix",                             // 0x09
    "g_ModelMatrixInverse",                      // 0x0a
    "g_ViewProjectionMatrix",                    // 0x0b
    "g_ModelViewProjectionMatrixInverse",        // 0x0c
    "g_ModelViewProjectionMatrix",               // 0x0d
    "g_NormalModelMatrix",                       // 0x0e
    "g_AltModelMatrix",                          // 0x0f
    "g_AltNormalModelMatrix",                    // 0x10
    "g_AltViewProjectionMatrix",                 // 0x11
    "g_ViewportViewProjectionMatrices",          // 0x12
    "g_EffectModelMatrix",                       // 0x13
    "g_EffectModelViewProjectionMatrix",         // 0x14
    "g_EffectModelViewProjectionMatrixInverse",  // 0x15
    "g_EffectTextureProjectionMatrix",           // 0x16
    "g_EffectTextureProjectionMatrixInverse",    // 0x17
    "g_LayerModelMatrix",                        // 0x18
    "g_EyePosition",                             // 0x19
    "g_ViewForward",                             // 0x1a
    "g_ViewRight",                               // 0x1b
    "g_ViewUp",                                  // 0x1c
    "g_OrientationForward",                      // 0x1d
    "g_OrientationRight",                        // 0x1e
    "g_OrientationUp",                           // 0x1f
    "g_Texture0",                                // 0x20
    "g_Texture1",                                // 0x21
    "g_Texture2",                                // 0x22
    "g_Texture3",                                // 0x23
    "g_Texture4",                                // 0x24
    "g_Texture5",                                // 0x25
    "g_Texture6",                                // 0x26
    "g_Texture7",                                // 0x27
    "g_Texture8",                                // 0x28
    "g_Texture9",                                // 0x29
    "g_Texture0Rotation",                        // 0x2a
    "g_Texture1Rotation",                        // 0x2b
    "g_Texture2Rotation",                        // 0x2c
    "g_Texture3Rotation",                        // 0x2d
    "g_Texture4Rotation",                        // 0x2e
    "g_Texture5Rotation",                        // 0x2f
    "g_Texture6Rotation",                        // 0x30
    "g_Texture7Rotation",                        // 0x31
    "g_Texture8Rotation",                        // 0x32
    "g_Texture9Rotation",                        // 0x33
    "g_Texture0Translation",                     // 0x34
    "g_Texture1Translation",                     // 0x35
    "g_Texture2Translation",                     // 0x36
    "g_Texture3Translation",                     // 0x37
    "g_Texture4Translation",                     // 0x38
    "g_Texture5Translation",                     // 0x39
    "g_Texture6Translation",                     // 0x3a
    "g_Texture7Translation",                     // 0x3b
    "g_Texture8Translation",                     // 0x3c
    "g_Texture9Translation",                     // 0x3d
    "g_Texture0Resolution",                      // 0x3e
    "g_Texture1Resolution",                      // 0x3f
    "g_Texture2Resolution",                      // 0x40
    "g_Texture3Resolution",                      // 0x41
    "g_Texture4Resolution",                      // 0x42
    "g_Texture5Resolution",                      // 0x43
    "g_Texture6Resolution",                      // 0x44
    "g_Texture7Resolution",                      // 0x45
    "g_Texture8Resolution",                      // 0x46
    "g_Texture9Resolution",                      // 0x47
    "g_Texture0Texel",                           // 0x48
    "g_Texture1Texel",                           // 0x49
    "g_Texture2Texel",                           // 0x4a
    "g_Texture3Texel",                           // 0x4b
    "g_Texture4Texel",                           // 0x4c
    "g_Texture5Texel",                           // 0x4d
    "g_Texture6Texel",                           // 0x4e
    "g_Texture7Texel",                           // 0x4f
    "g_Texture8Texel",                           // 0x50
    "g_Texture9Texel",                           // 0x51
    "g_Texture0MipMapInfo",                      // 0x52
    "g_Texture1MipMapInfo",                      // 0x53
    "g_Texture2MipMapInfo",                      // 0x54
    "g_Texture3MipMapInfo",                      // 0x55
    "g_Texture4MipMapInfo",                      // 0x56
    "g_Texture5MipMapInfo",                      // 0x57
    "g_Texture6MipMapInfo",                      // 0x58
    "g_Texture7MipMapInfo",                      // 0x59
    "g_Texture8MipMapInfo",                      // 0x5a
    "g_Texture9MipMapInfo",                      // 0x5b
    "g_TextureReductionScale",                   // 0x5c
    "g_LightsColorRadius",                       // 0x5d
    "g_LightsColorPremultiplied",                // 0x5e
    "g_LightsPosition",                          // 0x5f
    "g_LightAmbientColor",                       // 0x60
    "g_LightSkylightColor",                      // 0x61
    "g_AudioSpectrum16Left",                     // 0x62
    "g_AudioSpectrum16Right",                    // 0x63
    "g_AudioSpectrum32Left",                     // 0x64
    "g_AudioSpectrum32Right",                    // 0x65
    "g_AudioSpectrum64Left",                     // 0x66
    "g_AudioSpectrum64Right",                    // 0x67
    "g_PointerPositionLast",                     // 0x68
    "g_PointerPosition",                         // 0x69
    "g_PointerState",                            // 0x6a
    "g_ParallaxPosition",                        // 0x6b
    "g_RenderVar0",                              // 0x6c
    "g_RenderVar1",                              // 0x6d
    "g_RenderVar2",                              // 0x6e
    "g_RenderVar3",                              // 0x6f
    "g_RenderVar4",                              // 0x70
    "g_Bones",                                   // 0x71
    "g_BonesAlpha",                              // 0x72
    "g_BlendMap",                                // 0x73
    "g_MorphOffsets",                            // 0x74
    "g_MorphWeights",                            // 0x75
    "g_MorphBoneTransform",                      // 0x76
    "g_MorphBoneRules",                          // 0x77
    "g_LPoint_Color",                            // 0x78
    "g_LPoint_Origin",                           // 0x79
    "g_LSpot_Color",                             // 0x7a
    "g_LSpot_Origin",                            // 0x7b
    "g_LSpot_Direction",                         // 0x7c
    "g_LSpot_Exponent",                          // 0x7d
    "g_LTube_Color",                             // 0x7e
    "g_LTube_OriginA",                           // 0x7f
    "g_LTube_OriginB",                           // 0x80
    "g_LDirectional_Color",                      // 0x81
    "g_LDirectional_Direction",                  // 0x82
    "g_LFeature_ShadowProjection",               // 0x83
    "g_LFeature_ShadowProjectionTransform",      // 0x84
    "g_LFeature_ShadowPointProjection",          // 0x85
    "g_LFeature_ShadowPointProjectionTransform", // 0x86
    "g_FogDistanceColor",                        // 0x87
    "g_FogDistanceParams",                       // 0x88
    "g_FogHeightColor",                          // 0x89
    "g_FogHeightParams",                         // 0x8a
    "g_HDRParams",                               // 0x8b
];

/// 名表里进 `g_bufStatic` 的 5 项（ID 6、7、8、0x5c、0x8b，跳转表 `0x1400f8494` 目标 0）。
const STATIC_ENGINE_UNIFORMS: [&str; 5] = [
    "g_TexelSizeHalf",
    "g_TexelSize",
    "g_Screen",
    "g_TextureReductionScale",
    "g_HDRParams",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CBuffer {
    /// `g_bufStatic`（b0）
    Static,
    /// `g_bufDynamic`（b1）
    Dynamic,
}

/// uniform 进哪个常量缓冲（rea-p7-shader §2.8 与「P7b 补查」第 5 条）。返回 None 的不在这两个缓冲里：
/// 纹理 `g_Texture0`–`9`（t / s 寄存器），`g_Bones`（`g_bufAnimation`，固定模板）、`g_L*` 灯光（ID 0x78–0x86，
/// `g_bufLights`，固定模板）——后两类不按作者的声明输出，也就不占 static / dynamic 的位置。
fn cbuffer_of(name: &str) -> Option<CBuffer> {
    let Some(id) = ENGINE_UNIFORMS.iter().position(|n| *n == name) else {
        return Some(CBuffer::Static);
    };
    match id {
        0x20..=0x29 | 0x71 | 0x78..=0x86 => None,
        _ if STATIC_ENGINE_UNIFORMS.contains(&name) => Some(CBuffer::Static),
        _ => Some(CBuffer::Dynamic),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scalar {
    Float,
    Int,
    Uint,
}

impl Scalar {
    fn vec4(self) -> &'static str {
        match self {
            Self::Float => "vec4",
            Self::Int => "ivec4",
            Self::Uint => "uvec4",
        }
    }

    fn zero(self) -> &'static str {
        match self {
            Self::Float => "0.0",
            Self::Int => "0",
            Self::Uint => "0u",
        }
    }

    /// 把 `from` 类型的表达式按位重解释成本类型：常量缓冲没有类型，D3D 按着色器里的声明读同一组字节。
    fn reinterpret(self, from: Self, expr: &str) -> String {
        match (from, self) {
            (a, b) if a == b => expr.to_string(),
            (Self::Int, Self::Float) => format!("intBitsToFloat({expr})"),
            (Self::Uint, Self::Float) => format!("uintBitsToFloat({expr})"),
            (Self::Float, Self::Int) => format!("floatBitsToInt({expr})"),
            (Self::Float, Self::Uint) => format!("floatBitsToUint({expr})"),
            // GLSL 的 int ↔ uint 转换保留位模式
            (Self::Uint, Self::Int) => format!("int({expr})"),
            _ => format!("uint({expr})"),
        }
    }
}

/// HLSL 里的形状。只列 WPE 声明正则认得的类型（表 `0x140482eb0` 去掉采样器：`float vec2 vec3 vec4 mat3 mat4x3 mat4
/// int ivec4 uint uvec4`）；别的类型（`mat2`、`ivec2`、`bool`……）WPE 解析失败、整行丢掉，不进常量缓冲。
#[derive(Debug, Clone, Copy)]
enum Shape {
    /// 标量 / 向量：分量类型与分量数。
    Vector(Scalar, u32),
    /// 矩阵：WPE 的 `mat<A>x<B>` 是 HLSL `float<A>x<B>`，默认 column_major，占 B 个寄存器、每个 A 个分量；
    /// 寄存器 j 的分量 c 是 HLSL 的 (c, j) 元素。HLSL 写 `mul(v, M)`、GLSL 写 `M * v`，两边的矩阵互为转置，
    /// 所以它在 GLSL 里是 `M[c][j]`。
    Matrix(u32, u32),
}

fn shape(ty: &str) -> Option<Shape> {
    Some(match ty {
        "float" => Shape::Vector(Scalar::Float, 1),
        "vec2" => Shape::Vector(Scalar::Float, 2),
        "vec3" => Shape::Vector(Scalar::Float, 3),
        "vec4" => Shape::Vector(Scalar::Float, 4),
        "int" => Shape::Vector(Scalar::Int, 1),
        "ivec4" => Shape::Vector(Scalar::Int, 4),
        "uint" => Shape::Vector(Scalar::Uint, 1),
        "uvec4" => Shape::Vector(Scalar::Uint, 4),
        "mat3" => Shape::Matrix(3, 3),
        "mat4" => Shape::Matrix(4, 4),
        "mat4x3" => Shape::Matrix(4, 3),
        _ => return None,
    })
}

const XYZW: [&str; 4] = ["x", "y", "z", "w"];

/// 本阶段声明的一个 uniform（声明顺序）。
pub struct Declared<'a> {
    /// WPE 里的名字（决定常量缓冲）：拆分改名之前的原名。
    pub wpe_name: &'a str,
    /// 本阶段 GLSL 里的名字（拆分改名之后），也是 uniform 块里的成员名（补齐的数组另加 `kb_u_` 前缀）。
    pub glsl_name: &'a str,
    pub ty: &'a str,
    pub array: Option<u32>,
    /// 块里是补齐过的数组（`kb_u_<名字>`，见 `rewrite::padded_array`）。
    pub padded: bool,
}

/// 常量缓冲里一个分量的来源。
#[derive(Debug, Clone)]
struct Component {
    expr: String,
    scalar: Scalar,
}

/// 一个常量缓冲的寄存器表：每个寄存器 4 个分量，没有成员的分量是 None（读到 0）。
#[derive(Debug, Default)]
struct Registers {
    rows: Vec<[Option<Component>; 4]>,
    /// 已用到的字节数。
    end: u32,
}

impl Registers {
    fn put(&mut self, byte: u32, component: Component) {
        let row = (byte / 16) as usize;
        if self.rows.len() <= row {
            self.rows.resize_with(row + 1, Default::default);
        }
        self.rows[row][((byte % 16) / 4) as usize] = Some(component);
    }

    fn align(&mut self) -> u32 {
        self.end = self.end.div_ceil(16) * 16;
        self.end
    }
}

/// 打包数组在常量缓冲里的位置。
struct Packed {
    cbuffer: CBuffer,
    /// 起始寄存器。
    base: u32,
    scalar: Scalar,
}

/// 按 HLSL cbuffer 的默认打包规则（没有 `packoffset`、矩阵 column_major）排本阶段的 `g_bufStatic` / `g_bufDynamic`：
/// 成员按声明顺序；标量 / 向量不跨 16 字节边界，放不下就从下一个寄存器开始；数组与矩阵从寄存器边界开始，数组元素
/// 步长 16，最后一个元素只占自身大小（后面的标量可以填进同一个寄存器的剩余分量）。accessArray 数组按打包类型
/// `float4[ceil(n/4)]` 排（rea-p7-shader「P7b 补查」第 4、5 条）。同名的重复声明只算第一个。
///
/// 返回两个缓冲的寄存器表，以及每个 `float` / `int` / `uint` 数组的位置。
fn layout(declared: &[Declared]) -> ([Registers; 2], BTreeMap<String, Packed>) {
    let mut buffers: [Registers; 2] = Default::default();
    let mut packed = BTreeMap::new();
    let mut seen: Vec<&str> = Vec::new();
    for uniform in declared {
        if seen.contains(&uniform.glsl_name) {
            continue;
        }
        seen.push(uniform.glsl_name);
        let (Some(cbuffer), Some(shape)) = (cbuffer_of(uniform.wpe_name), shape(uniform.ty)) else {
            continue;
        };
        let regs = &mut buffers[cbuffer as usize];
        let name = uniform.glsl_name;
        let member = if uniform.padded {
            format!("kb_u_{name}")
        } else {
            name.to_string()
        };
        match (shape, uniform.array) {
            (Shape::Vector(scalar, count), None) => {
                let size = count * 4;
                if regs.end % 16 + size > 16 {
                    regs.align();
                }
                for k in 0..count {
                    let expr = if count == 1 {
                        member.clone()
                    } else {
                        format!("{member}.{}", XYZW[k as usize])
                    };
                    regs.put(regs.end + 4 * k, Component { expr, scalar });
                }
                regs.end += size;
            }
            // accessArray（float / vec2 / int / uint 数组）：打包成 ceil(n/4) 个四分量行，第 s 个标量在第 s/4 行的 s%4 分量
            (Shape::Vector(scalar, count @ (1 | 2)), Some(n))
                if scalar == Scalar::Float || count == 1 =>
            {
                let base = regs.align();
                let rows = n.div_ceil(4);
                for s in 0..rows * 4 {
                    // vec2 数组 WPE 也只给 4·ceil(n/4) 个分量（装不下 2n 个），这里按标量顺序摆，语料里没有实例
                    let (element, component) = if count == 1 {
                        (s, "x")
                    } else {
                        (s / 2, XYZW[(s % 2) as usize])
                    };
                    if element < n {
                        let expr = format!("{member}[{element}].{component}");
                        regs.put(base + 4 * s, Component { expr, scalar });
                    }
                }
                regs.end = base + rows * 16;
                if count == 1 {
                    packed.insert(
                        name.to_string(),
                        Packed {
                            cbuffer,
                            base: base / 16,
                            scalar,
                        },
                    );
                }
            }
            (Shape::Vector(scalar, count), Some(n)) => {
                let base = regs.align();
                for element in 0..n {
                    for k in 0..count {
                        let expr = format!("{member}[{element}].{}", XYZW[k as usize]);
                        regs.put(base + 16 * element + 4 * k, Component { expr, scalar });
                    }
                }
                regs.end = base + 16 * (n.max(1) - 1) + 4 * count;
            }
            (Shape::Matrix(a, b), array) => {
                let base = regs.align();
                let count = array.unwrap_or(1);
                for element in 0..count {
                    let index = array.map(|_| format!("[{element}]")).unwrap_or_default();
                    for j in 0..b {
                        for c in 0..a {
                            let expr = format!("{member}{index}[{c}][{j}]");
                            regs.put(
                                base + 16 * (b * element + j) + 4 * c,
                                Component {
                                    expr,
                                    scalar: Scalar::Float,
                                },
                            );
                        }
                    }
                }
                regs.end = base + 16 * (b * (count.max(1) - 1) + b - 1) + 4 * a;
            }
        }
    }
    (buffers, packed)
}

/// `vec4 kb_pack_<名>(int k)`：返回打包形态的第 k 行。超出本数组的行读同一常量缓冲里的其它成员，出了缓冲是 0。
fn pack_function(name: &str, packed: &Packed, registers: &Registers) -> String {
    let scalar = packed.scalar;
    let ty = scalar.vec4();
    let mut out = format!("{ty} kb_pack_{name}(int k) {{\n");
    for (row, components) in registers.rows.iter().enumerate() {
        if components.iter().all(Option::is_none) {
            continue;
        }
        let parts: Vec<String> = components
            .iter()
            .map(|component| match component {
                Some(c) => scalar.reinterpret(c.scalar, &c.expr),
                None => scalar.zero().to_string(),
            })
            .collect();
        out.push_str(&format!(
            "    if (k == {}) return {ty}({});\n",
            row as i64 - i64::from(packed.base),
            parts.join(", ")
        ));
    }
    out.push_str(&format!("    return {ty}({});\n}}\n", scalar.zero()));
    out
}

/// WPE 认 `main` 签名的正则 `\bvoid[\s]+main[\s]*\([\s]*\)[\s\r\n]*\{`（`0x140487cd0`，rea-p7-shader §2.9 第 2 条）：
/// 返回第一处匹配的起点。认不出（`main(void)` 等）时 WPE 整篇都当成签名之后，这里返回 None、不做打包。
fn main_signature(body: &str) -> Option<usize> {
    let bytes = body.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let skip_ws = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let mut from = 0;
    while let Some(at) = body[from..].find("void") {
        let start = from + at;
        from = start + 4;
        if start > 0 && word(bytes[start - 1]) {
            continue;
        }
        let i = skip_ws(start + 4);
        if i == start + 4 || !body[i..].starts_with("main") {
            continue;
        }
        let i = skip_ws(i + 4);
        if bytes.get(i) != Some(&b'(') {
            continue;
        }
        let i = skip_ws(i + 1);
        if bytes.get(i) != Some(&b')') {
            continue;
        }
        let i = skip_ws(i + 1);
        if bytes.get(i) == Some(&b'{') {
            return Some(start);
        }
    }
    None
}

/// `main` 签名之前的正文里，把 `X[e]`（X 是本阶段的 `float` / `int` / `uint` 数组 uniform）改成 `kb_pack_X(e)`，
/// 返回（改写后的正文, 要插在 uniform 块之后的 `kb_pack_*` 函数）。没有用到的着色器原样返回、函数为空串。
///
/// 只认紧跟下标的写法；`main` 之前不带下标地用到（整体传参、`#define SPEC X`）的照旧是还原后的数组，与 WPE 不同，
/// 语料里没有。成员访问 `.X` 不算。
pub fn rewrite_head(declared: &[Declared], body: &str) -> (String, String) {
    let Some(split) = main_signature(body) else {
        return (body.to_string(), String::new());
    };
    let (registers, packed) = layout(declared);
    if packed.is_empty() {
        return (body.to_string(), String::new());
    }
    let mut used: Vec<String> = Vec::new();
    let head = rewrite_subscripts(&body[..split], &packed, &mut used);
    if used.is_empty() {
        return (body.to_string(), String::new());
    }
    let functions = used
        .iter()
        .map(|name| {
            let info = &packed[name];
            pack_function(name, info, &registers[info.cbuffer as usize])
        })
        .collect();
    (format!("{head}{}", &body[split..]), functions)
}

/// 逐个标识符扫描，`X [ e ]` → `kb_pack_X(e)`（`e` 里嵌套的同样改写）。`used` 按首次出现的顺序记下用到的数组。
fn rewrite_subscripts(
    text: &str,
    packed: &BTreeMap<String, Packed>,
    used: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev_sig: Option<char> = None;
    while let Some(c) = rest.chars().next() {
        if c.is_ascii_alphabetic() || c == '_' {
            let (ident, after) = split_ident(rest);
            let open = after.trim_start();
            if prev_sig != Some('.') && packed.contains_key(ident) && open.starts_with('[') {
                if let Some(close) = matching_bracket(open) {
                    let inner = rewrite_subscripts(&open[1..close], packed, used);
                    if !used.iter().any(|u| u == ident) {
                        used.push(ident.to_string());
                    }
                    out.push_str(&format!("kb_pack_{ident}({inner})"));
                    rest = &open[close + 1..];
                    prev_sig = Some(')');
                    continue;
                }
            }
            out.push_str(ident);
            rest = after;
            prev_sig = ident.chars().last();
        } else if c.is_ascii_digit() {
            // 数字字面量整体拷贝，避免把 `1e10` 的 `e10` 当成标识符
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            out.push_str(&rest[..end]);
            rest = &rest[end..];
            prev_sig = Some('0');
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            if !c.is_whitespace() {
                prev_sig = Some(c);
            }
        }
    }
    out
}

/// `[` 开头的文本里与它配对的 `]` 的字节位置（圆括号、方括号都计深度）。
fn matching_bracket(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (at, c) in text.char_indices() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' => {
                depth -= 1;
                if depth == 0 {
                    return (c == ']').then_some(at);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl<'a>(name: &'a str, ty: &'a str, array: Option<u32>) -> Declared<'a> {
        Declared {
            wpe_name: name,
            glsl_name: name,
            ty,
            array,
            padded: array.is_some() && matches!(ty, "float" | "vec2" | "vec3" | "int" | "uint"),
        }
    }

    #[test]
    fn engine_table_is_complete_and_split_by_name() {
        assert_eq!(ENGINE_UNIFORMS[0x66], "g_AudioSpectrum64Left");
        assert_eq!(ENGINE_UNIFORMS[0x8b], "g_HDRParams");
        assert_eq!(cbuffer_of("g_AudioSpectrum64Left"), Some(CBuffer::Dynamic));
        assert_eq!(cbuffer_of("g_Time"), Some(CBuffer::Dynamic));
        assert_eq!(cbuffer_of("g_TexelSize"), Some(CBuffer::Static));
        assert_eq!(cbuffer_of("g_TextureReductionScale"), Some(CBuffer::Static));
        assert_eq!(cbuffer_of("u_Brightness"), Some(CBuffer::Static));
        assert_eq!(cbuffer_of("g_Texture3"), None);
        assert_eq!(cbuffer_of("g_Bones"), None);
        assert_eq!(
            cbuffer_of("g_LFeature_ShadowPointProjectionTransform"),
            None
        );
        assert_eq!(cbuffer_of("g_FogHeightParams"), Some(CBuffer::Dynamic));
    }

    /// p7-sem 的 `kbpack`：`g_AudioSpectrum16Left[16]` 后面紧跟 `g_Time`，第 4 行越界读到 `g_Time`（x 分量），再往后出了缓冲是 0；
    /// 材质 uniform 与 `g_TexelSize` 在另一个缓冲里，不参与。
    #[test]
    fn layout_follows_hlsl_packing() {
        let declared = [
            decl("u_Scale", "float", None),
            decl("g_PointerPosition", "vec2", None),
            decl("g_AudioSpectrum16Left", "float", Some(16)),
            decl("g_Time", "float", None),
            decl("g_TexelSize", "vec2", None),
            decl("g_Color", "vec3", None),
            decl("g_ModelMatrix", "mat4", None),
        ];
        let (buffers, packed) = layout(&declared);
        let left = &packed["g_AudioSpectrum16Left"];
        assert_eq!((left.cbuffer, left.base), (CBuffer::Dynamic, 1));
        let dynamic = &buffers[CBuffer::Dynamic as usize];
        let exprs = |row: usize| -> Vec<String> {
            dynamic.rows[row]
                .iter()
                .map(|c| c.as_ref().map(|c| c.expr.clone()).unwrap_or_default())
                .collect()
        };
        assert_eq!(
            exprs(0),
            ["g_PointerPosition.x", "g_PointerPosition.y", "", ""]
        );
        assert_eq!(
            exprs(1),
            [
                "kb_u_g_AudioSpectrum16Left[0].x",
                "kb_u_g_AudioSpectrum16Left[1].x",
                "kb_u_g_AudioSpectrum16Left[2].x",
                "kb_u_g_AudioSpectrum16Left[3].x"
            ]
        );
        // g_Time 之后 vec3 正好放得进同一行剩下的 12 字节
        assert_eq!(exprs(5), ["g_Time", "g_Color.x", "g_Color.y", "g_Color.z"]);
        // mat4 从下一行开始；寄存器 j 的分量 c 是 GLSL 的 M[c][j]
        assert_eq!(exprs(6)[1], "g_ModelMatrix[1][0]");
        assert_eq!(exprs(9)[3], "g_ModelMatrix[3][3]");
        assert_eq!(dynamic.rows.len(), 10);
        let stat = &buffers[CBuffer::Static as usize];
        assert_eq!(stat.rows.len(), 1);
        assert_eq!(stat.rows[0][1].as_ref().unwrap().expr, "g_TexelSize.x");
    }

    #[test]
    fn short_arrays_pad_and_following_scalars_fill_the_last_register() {
        let declared = [
            decl("u_A", "float", Some(6)),
            decl("u_B", "vec3", Some(2)),
            decl("u_C", "float", None),
            decl("u_D", "int", None),
        ];
        let (buffers, packed) = layout(&declared);
        let stat = &buffers[CBuffer::Static as usize];
        // float[6] 占 2 行，第 2 行后两个分量是补的 0
        assert!(stat.rows[1][2].is_none() && stat.rows[1][3].is_none());
        assert_eq!(packed["u_A"].base, 0);
        // vec3[2] 从第 2 行开始，最后一个元素后面的 .w 由 u_C 填上；u_D 另起一行
        assert_eq!(stat.rows[3][3].as_ref().unwrap().expr, "u_C");
        assert_eq!(stat.rows[4][0].as_ref().unwrap().expr, "u_D");
        // 生成的函数：本数组两行、越界读到 vec3 数组与后面的标量，int 按位重解释成 float
        let function = pack_function("u_A", &packed["u_A"], stat);
        assert!(
            function.starts_with("vec4 kb_pack_u_A(int k) {\n"),
            "{function}"
        );
        assert!(function
            .contains("    if (k == 1) return vec4(kb_u_u_A[4].x, kb_u_u_A[5].x, 0.0, 0.0);\n"));
        assert!(function.contains(
            "    if (k == 3) return vec4(kb_u_u_B[1].x, kb_u_u_B[1].y, kb_u_u_B[1].z, u_C);\n"
        ));
        assert!(
            function.contains("    if (k == 4) return vec4(intBitsToFloat(u_D), 0.0, 0.0, 0.0);\n")
        );
        assert!(function.ends_with("    return vec4(0.0);\n}\n"));
    }

    /// 两级下标 `[i/4][i%4]`、取整行 `[i]`、`e` 里嵌套、成员访问与 `main` 之后的不动。
    #[test]
    fn subscripts_before_main_become_pack_calls() {
        let declared = [
            decl("g_AudioSpectrum64Left", "float", Some(64)),
            decl("g_AudioSpectrum64Right", "float", Some(64)),
            decl("u_Bars", "vec4", Some(4)),
        ];
        let body = "float bar(int i) { return g_AudioSpectrum64Left[i / 4][i % 4]; }\nvec4 row(int i) { return g_AudioSpectrum64Right [ g_AudioSpectrum64Left[i].x > 0.5 ? i : 0 ] + u_Bars[i] + s.g_AudioSpectrum64Left[i]; }\nvoid main()\n{ float x = g_AudioSpectrum64Left[3]; }";
        let (out, functions) = rewrite_head(&declared, body);
        assert_eq!(
            out,
            "float bar(int i) { return kb_pack_g_AudioSpectrum64Left(i / 4)[i % 4]; }\nvec4 row(int i) { return kb_pack_g_AudioSpectrum64Right( kb_pack_g_AudioSpectrum64Left(i).x > 0.5 ? i : 0 ) + u_Bars[i] + s.g_AudioSpectrum64Left[i]; }\nvoid main()\n{ float x = g_AudioSpectrum64Left[3]; }"
        );
        // Left 越界（第 16 行起）读到同一缓冲里的 Right；出了缓冲是 0
        assert!(functions.starts_with("vec4 kb_pack_g_AudioSpectrum64Left(int k) {\n"));
        assert!(
            functions.contains("    if (k == 16) return vec4(kb_u_g_AudioSpectrum64Right[0].x,")
        );
        assert!(functions.contains("vec4 kb_pack_g_AudioSpectrum64Right(int k) {\n    if (k == -16) return vec4(kb_u_g_AudioSpectrum64Left[0].x,"));
        assert!(!functions.contains("k == 32"));
    }

    /// 反例：只在 `main` 里用、或认不出 `main` 签名（`main(void)`），一律原样、不生成函数。
    #[test]
    fn untouched_without_subscripts_before_main() {
        let declared = [
            decl("g_AudioSpectrum16Left", "float", Some(16)),
            decl("u_V", "vec4", Some(2)),
        ];
        for body in [
            "float f(float a) { return a; }\nvoid main() { float x = g_AudioSpectrum16Left[1]; }",
            "float f() { return g_AudioSpectrum16Left[1].x; }\nvoid main(void) { }",
            "float f() { return u_V[1].x; }\nvoid main() { }",
        ] {
            assert_eq!(
                rewrite_head(&declared, body),
                (body.to_string(), String::new())
            );
        }
    }

    #[test]
    fn int_and_uint_arrays_return_integer_rows() {
        let declared = [
            decl("u_Ids", "uint", Some(5)),
            decl("u_F", "float", None),
            decl("u_N", "int", Some(2)),
        ];
        let (_, functions) = rewrite_head(
            &declared,
            "uint f(int i) { return u_Ids[i].y + uint(u_N[0].x); }\nvoid main() {}",
        );
        assert!(functions.contains(
            "uvec4 kb_pack_u_Ids(int k) {\n    if (k == 0) return uvec4(kb_u_u_Ids[0].x,"
        ));
        assert!(
            functions.contains("    if (k == 2) return uvec4(floatBitsToUint(u_F), 0u, 0u, 0u);\n")
        );
        assert!(functions.contains(
            "ivec4 kb_pack_u_N(int k) {\n    if (k == -3) return ivec4(int(kb_u_u_Ids[0].x),"
        ));
        assert!(functions.ends_with("    return ivec4(0);\n}\n"));
    }
}
