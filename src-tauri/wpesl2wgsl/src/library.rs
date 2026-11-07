//! `#require <库>` 的展开。
//!
//! `#require` 在 WPE 里不是查文件：预处理器遇到它时调引擎，由引擎按当前宏表**现场生成**一段源码，原地插进着色器
//! （2.8.42 `FUN_14016b0e0` → `FUN_140169140`）。只有 `LightingV1` 一个库：宏 `LIGHTING` 已定义且不为 0 时才生成，否则什么
//! 都不插，也不引入别的宏、uniform 或 varying。所以 `genericimage4.frag` 顶层那条无条件的 `#require`，在 `LIGHTING=0` 时
//! 等于空行。其它名字 WPE 同样静默生成空串，这里照报 `phase: "require"`：我们宁可挡住，也不让着色器在后面报未定义函数。
//!
//! 库的内容是几组灯光 uniform 与函数 `PerformLighting_V1`，灯数来自宏 `LIGHTS_*`（`general.lightconfig`，见宿主
//! `compile/lights.ts`）。逐灯的 PBR 计算在公开头文件 `common_pbr_2.h` 里，这里只负责遍历灯并取 uniform。
//! 这段生成代码是按公式另写的（循环形式、变量名都是自己的），没有搬运 WPE 二进制里的字符串。
//!
//! 阴影与 cookie 需要 `_rt_shadowAtlas` / `_alias_lightCookie`，渲染器没有。这些宏非 0 时报 `LightingV1/shadow`，不生成半截结果。

use std::fmt::Write;

/// `#require` 的展开结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Expansion {
    /// 什么都不插（与 WPE 一致）。
    Nothing,
    /// 插入这段源码。
    Source(String),
    /// 现在做不到，报给调用方（`requires` 里的名字）。
    Unsupported(String),
}

/// 需要阴影图集或 cookie 纹理的宏。
const SHADOW_MACROS: [&str; 5] = [
    "LIGHTS_POINT_SHADOW",
    "LIGHTS_SPOT_SHADOW",
    "LIGHTS_SPOT_COOKIE",
    "LIGHTS_SPOT_SHADOW_COOKIE",
    "LIGHTS_DIRECTIONAL_SHADOW",
];

/// `value` 取宏的整数值，未定义按 0。
pub fn expand(
    name: &str,
    value: impl Fn(&str) -> Result<i64, String>,
) -> Result<Expansion, String> {
    if name != "LightingV1" {
        return Ok(Expansion::Unsupported(name.to_string()));
    }
    if value("LIGHTING")? == 0 {
        return Ok(Expansion::Nothing);
    }
    for shadow in SHADOW_MACROS {
        if value(shadow)? != 0 {
            return Ok(Expansion::Unsupported("LightingV1/shadow".to_string()));
        }
    }
    Ok(Expansion::Source(lighting_v1(
        value("LIGHTS_POINT")?,
        value("LIGHTS_SPOT")?,
        value("LIGHTS_TUBE")?,
        value("LIGHTS_DIRECTIONAL")?,
    )))
}

/// 一组 `uniform vec4 名字[数量];`。数量为 0 时不声明：长度 0 的数组不合法。
fn declare(out: &mut String, count: i64, names: &[&str]) {
    if count > 0 {
        for name in names {
            let _ = writeln!(out, "uniform vec4 {name}[{count}];");
        }
    }
}

fn lighting_v1(point: i64, spot: i64, tube: i64, directional: i64) -> String {
    let mut out = String::new();
    declare(&mut out, point, &["g_LPoint_Color", "g_LPoint_Origin"]);
    declare(
        &mut out,
        spot,
        &[
            "g_LSpot_Color",
            "g_LSpot_Origin",
            "g_LSpot_Direction",
            "g_LSpot_Exponent",
        ],
    );
    declare(
        &mut out,
        tube,
        &["g_LTube_Color", "g_LTube_OriginA", "g_LTube_OriginB"],
    );
    declare(
        &mut out,
        directional,
        &["g_LDirectional_Color", "g_LDirectional_Direction"],
    );
    // 第 6 个参数是基础反射率 f0（各着色器都传它），WPE 的函数原型里写的 `ambient` 名不副实
    out.push_str(
        "vec3 PerformLighting_V1(vec3 pos, vec3 albedo, vec3 n, vec3 v, vec3 tint, vec3 f0, float rough, float metal)\n{\n\tvec3 sum = CAST3(0.0);\n",
    );
    // 距离衰减由 ComputePBRLightShadow 算：半径在 Color.w，指数在各灯自己的字段里
    let lit = |light: &str, color: &str, exponent: &str| {
        format!(
            "\t\tsum += ComputePBRLightShadow(n, {light}, v, albedo, {color}, {exponent}, tint, f0, rough, metal, 1.0);\n"
        )
    };
    if point > 0 {
        let _ = write!(
            out,
            "\tfor (int k = 0; k < {point}; ++k)\n\t{{\n{}\t}}\n",
            lit(
                "g_LPoint_Origin[k].xyz - pos",
                "g_LPoint_Color[k].rgb, g_LPoint_Color[k].w",
                "g_LPoint_Origin[k].w"
            )
        );
    }
    if spot > 0 {
        // Origin.w / Direction.w 是内外锥角的余弦；方向指向照射方向，所以用「灯到着色点」点乘
        let _ = write!(
            out,
            "\tfor (int k = 0; k < {spot}; ++k)\n\t{{\n\t\tvec3 toLight = g_LSpot_Origin[k].xyz - pos;\n\t\tfloat cone = smoothstep(g_LSpot_Direction[k].w, g_LSpot_Origin[k].w, dot(normalize(-toLight), g_LSpot_Direction[k].xyz));\n{}\t}}\n",
            lit(
                "toLight",
                "g_LSpot_Color[k].rgb * cone, g_LSpot_Color[k].w",
                "g_LSpot_Exponent[k].x"
            )
        );
    }
    if tube > 0 {
        let _ = write!(
            out,
            "\tfor (int k = 0; k < {tube}; ++k)\n\t{{\n{}\t}}\n",
            lit(
                "PointSegmentDelta(pos, g_LTube_OriginA[k].xyz, g_LTube_OriginB[k].xyz)",
                "g_LTube_Color[k].rgb, g_LTube_Color[k].w",
                "g_LTube_OriginA[k].w"
            )
        );
    }
    if directional > 0 {
        let _ = write!(
            out,
            "\tfor (int k = 0; k < {directional}; ++k)\n\t{{\n\t\tsum += ComputePBRLightShadowInfinite(n, g_LDirectional_Direction[k].xyz, v, albedo, g_LDirectional_Color[k].rgb, tint, f0, rough, metal, 1.0);\n\t}}\n"
        );
    }
    out.push_str("\treturn sum;\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn run(name: &str, macros: &[(&str, i64)]) -> Expansion {
        let table: BTreeMap<&str, i64> = macros.iter().copied().collect();
        expand(name, |key| Ok(table.get(key).copied().unwrap_or(0))).unwrap()
    }

    #[test]
    fn lighting_off_inserts_nothing() {
        assert_eq!(run("LightingV1", &[]), Expansion::Nothing);
        assert_eq!(
            run("LightingV1", &[("LIGHTING", 0), ("LIGHTS_POINT", 3)]),
            Expansion::Nothing
        );
    }

    #[test]
    fn unknown_library_is_reported() {
        assert_eq!(
            run("LightingV2", &[("LIGHTING", 1)]),
            Expansion::Unsupported("LightingV2".into())
        );
    }

    #[test]
    fn shadows_are_reported_instead_of_half_generated() {
        for name in SHADOW_MACROS {
            assert_eq!(
                run(
                    "LightingV1",
                    &[("LIGHTING", 1), ("LIGHTS_POINT", 1), (name, 1)]
                ),
                Expansion::Unsupported("LightingV1/shadow".into())
            );
        }
    }

    #[test]
    fn no_lights_still_defines_the_function() {
        let Expansion::Source(source) = run("LightingV1", &[("LIGHTING", 1)]) else {
            panic!("应当生成");
        };
        assert!(source.contains("vec3 PerformLighting_V1("));
        assert!(!source.contains("uniform"));
        assert!(!source.contains("for ("));
    }

    #[test]
    fn counts_drive_declarations_and_loops() {
        let Expansion::Source(source) = run(
            "LightingV1",
            &[
                ("LIGHTING", 1),
                ("LIGHTS_POINT", 2),
                ("LIGHTS_SPOT", 1),
                ("LIGHTS_TUBE", 3),
                ("LIGHTS_DIRECTIONAL", 4),
            ],
        ) else {
            panic!("应当生成");
        };
        for line in [
            "uniform vec4 g_LPoint_Color[2];",
            "uniform vec4 g_LPoint_Origin[2];",
            "uniform vec4 g_LSpot_Exponent[1];",
            "uniform vec4 g_LTube_OriginB[3];",
            "uniform vec4 g_LDirectional_Direction[4];",
            "k < 2;",
            "k < 1;",
            "k < 3;",
            "k < 4;",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
    }
}
