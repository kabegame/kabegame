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
//! 阴影（P13d，rea-p13-shadows R1）：带阴影的点光与平行光各占本类数组的前 `LIGHTS_POINT_SHADOW` /
//! `LIGHTS_DIRECTIONAL_SHADOW` 个槽，WPE 的生成器给它们逐盏生成一个块（投到 `_rt_shadowAtlas` 取 `shadowFactor`），普通灯
//! 接在后面。段的先后决定 `sum +=` 的累加顺序，照 WPE：点光阴影 → 点光 → 聚光四段 → 管光 → 平行光阴影 → 平行光。
//! 平行光三级的下标照抄 WPE 的 `B0 + k + c`（`B0 = SSC + SC + SS`，聚光占的投影数；CPU 每盏写 3 个连续槽，两盏以上时第 2 盏起
//! 读错级联，P13d 待定 4 定为照抄）。
//! 聚光分四段（P13i、P13k，rea-p13-shadows R1 1.3）：「阴影 + cookie」`LIGHTS_SPOT_SHADOW_COOKIE` 个、「cookie」`LIGHTS_SPOT_COOKIE` 个、
//! 「阴影」`LIGHTS_SPOT_SHADOW` 个，其余普通，各段依次占聚光数组的槽；前三段每盏一个块，投影与本灯同下标（`CalculateProjectedCoords`）。
//! 阴影段在锥角衰减之后 `PerformShadowMapping`；两段 cookie（P13k，phase-13k R4）**不乘锥角**，颜色乘
//! `texSample2D(COOKIE_SAMPLER, 投影坐标.xy).rgb`（着色器在 `LIGHTS_COOKIE` 下把它定义成缺省 `_alias_lightCookie` 的槽），「阴影 + cookie」
//! 再传阴影因子。

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

/// 灯数：每类的总数（含带阴影的）与带阴影的个数。
#[derive(Debug, Clone, Copy, Default)]
struct Counts {
    point: i64,
    spot: i64,
    tube: i64,
    directional: i64,
    point_shadow: i64,
    spot_shadow: i64,
    spot_cookie: i64,
    spot_shadow_cookie: i64,
    directional_shadow: i64,
}

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
    Ok(Expansion::Source(lighting_v1(Counts {
        point: value("LIGHTS_POINT")?,
        spot: value("LIGHTS_SPOT")?,
        tube: value("LIGHTS_TUBE")?,
        directional: value("LIGHTS_DIRECTIONAL")?,
        point_shadow: value("LIGHTS_POINT_SHADOW")?,
        spot_shadow: value("LIGHTS_SPOT_SHADOW")?,
        spot_cookie: value("LIGHTS_SPOT_COOKIE")?,
        spot_shadow_cookie: value("LIGHTS_SPOT_SHADOW_COOKIE")?,
        directional_shadow: value("LIGHTS_DIRECTIONAL_SHADOW")?,
    })))
}

/// 一组 `uniform vec4 名字[数量];`。数量为 0 时不声明：长度 0 的数组不合法。
fn declare(out: &mut String, count: i64, names: &[&str]) {
    if count > 0 {
        for name in names {
            let _ = writeln!(out, "uniform vec4 {name}[{count}];");
        }
    }
}

fn lighting_v1(counts: Counts) -> String {
    let Counts {
        point,
        spot,
        tube,
        directional,
        point_shadow,
        spot_shadow,
        spot_cookie,
        spot_shadow_cookie,
        directional_shadow,
    } = counts;
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
    // 阴影投影：聚光前三段每盏一个、平行光每盏三级，点光每盏一个；先这一组后点光，同 WPE 的声明顺序（R1 1.2）。
    // `spot_projections` 是聚光占的投影数，也是平行光级联的基址 B0（R1 1.4），按宏原值算、不按 `LIGHTS_SPOT` 截
    let spot_projections = spot_shadow_cookie + spot_cookie + spot_shadow;
    let projections = spot_projections + 3 * directional_shadow;
    if projections > 0 {
        let _ = writeln!(
            out,
            "uniform mat4 g_LFeature_ShadowProjection[{projections}];"
        );
        declare(
            &mut out,
            projections,
            &["g_LFeature_ShadowProjectionTransform"],
        );
    }
    declare(
        &mut out,
        point_shadow,
        &[
            "g_LFeature_ShadowPointProjection",
            "g_LFeature_ShadowPointProjectionTransform",
        ],
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
    // 带阴影的点光：一盏一个块，投影与本灯同下标（R1 1.3）
    for i in 0..point_shadow.min(point) {
        let _ = write!(
            out,
            "\t{{\n\t\tvec4 shadowCoords = CalculateProjectedCoordsPoint(pos, g_LPoint_Origin[{i}].xyz, g_LFeature_ShadowPointProjection[{i}], g_LFeature_ShadowPointProjectionTransform[{i}]);\n\t\tfloat shadowFactor = PerformPointShadowMapping(shadowCoords);\n\t\tsum += ComputePBRLightShadow(n, g_LPoint_Origin[{i}].xyz - pos, v, albedo, g_LPoint_Color[{i}].rgb, g_LPoint_Color[{i}].w, g_LPoint_Origin[{i}].w, tint, f0, rough, metal, shadowFactor);\n\t}}\n"
        );
    }
    if point > point_shadow {
        let _ = write!(
            out,
            "\tfor (int k = {point_shadow}; k < {point}; ++k)\n\t{{\n{}\t}}\n",
            lit(
                "g_LPoint_Origin[k].xyz - pos",
                "g_LPoint_Color[k].rgb, g_LPoint_Color[k].w",
                "g_LPoint_Origin[k].w"
            )
        );
    }
    // 聚光的段：阴影 + cookie → cookie → 阴影 → 普通，依次占槽；生成块时按 `LIGHTS_SPOT` 截（数组只有这么长）
    let shadow_cookies = spot_shadow_cookie.clamp(0, spot.max(0));
    let cookies = shadow_cookies + spot_cookie.clamp(0, spot.max(0) - shadow_cookies);
    let spot_shadows = cookies + spot_shadow.clamp(0, spot.max(0) - cookies);
    // 两段 cookie（P13k，R4）：没有锥角衰减，颜色乘 cookie 的 rgb，投影与本灯同下标；「阴影 + cookie」传阴影因子，「cookie」传 1.0
    for i in 0..cookies {
        let shadow = i < shadow_cookies;
        let factor = if shadow {
            format!("\t\tfloat shadowFactor = PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[{i}]);\n")
        } else {
            String::new()
        };
        let _ = write!(
            out,
            "\t{{\n\t\tvec3 toLight = g_LSpot_Origin[{i}].xyz - pos;\n\t\tvec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[{i}]);\n{factor}\t\tvec3 cookieColor = texSample2D(COOKIE_SAMPLER, shadowCoords.xy).rgb;\n\t\tsum += ComputePBRLightShadow(n, toLight, v, albedo, g_LSpot_Color[{i}].rgb * cookieColor, g_LSpot_Color[{i}].w, g_LSpot_Exponent[{i}].x, tint, f0, rough, metal, {});\n\t}}\n",
            if shadow { "shadowFactor" } else { "1.0" },
        );
    }
    // 带阴影的聚光：一盏一个块，锥角衰减照普通聚光，投影与本灯同下标、没有越界判定（R1 1.3，`CalculateProjectedCoords`）
    for i in cookies..spot_shadows {
        let _ = write!(
            out,
            "\t{{\n\t\tvec3 toLight = g_LSpot_Origin[{i}].xyz - pos;\n\t\tfloat cone = smoothstep(g_LSpot_Direction[{i}].w, g_LSpot_Origin[{i}].w, dot(normalize(-toLight), g_LSpot_Direction[{i}].xyz));\n\t\tvec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[{i}]);\n\t\tfloat shadowFactor = PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[{i}]);\n\t\tsum += ComputePBRLightShadow(n, toLight, v, albedo, g_LSpot_Color[{i}].rgb * cone, g_LSpot_Color[{i}].w, g_LSpot_Exponent[{i}].x, tint, f0, rough, metal, shadowFactor);\n\t}}\n"
        );
    }
    if spot > spot_shadows {
        // Origin.w / Direction.w 是内外锥角的余弦；方向指向照射方向，所以用「灯到着色点」点乘
        let _ = write!(
            out,
            "\tfor (int k = {spot_shadows}; k < {spot}; ++k)\n\t{{\n\t\tvec3 toLight = g_LSpot_Origin[k].xyz - pos;\n\t\tfloat cone = smoothstep(g_LSpot_Direction[k].w, g_LSpot_Origin[k].w, dot(normalize(-toLight), g_LSpot_Direction[k].xyz));\n{}\t}}\n",
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
    // 带阴影的平行光：三级级联，下标照抄 WPE 的 B0 + k + c（B0 = 聚光占的投影数 SSC + SC + SS）。两次 mix 的系数只取 0 或 1，
    // 是「越出这一级就换下一级」的选择；第二次看的是第 1 级的越界位（R1 1.4）
    for k in 0..directional_shadow.min(directional) {
        let (p1, p2, p3) = (
            spot_projections + k,
            spot_projections + k + 1,
            spot_projections + k + 2,
        );
        let _ = write!(
            out,
            "\t{{\n\t\tvec4 cascade1 = CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[{p1}]);\n\t\tvec4 cascade2 = CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[{p2}]);\n\t\tvec4 cascade3 = CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[{p3}]);\n\t\tcascade1.xyz = mix(cascade1.xyz, cascade2.xyz, cascade1.w);\n\t\tcascade1.xyz = mix(cascade1.xyz, cascade3.xyz, cascade2.w);\n\t\tvec4 atlasTransform = mix(g_LFeature_ShadowProjectionTransform[{p1}], g_LFeature_ShadowProjectionTransform[{p2}], cascade1.w);\n\t\tatlasTransform = mix(atlasTransform, g_LFeature_ShadowProjectionTransform[{p3}], cascade2.w);\n\t\tfloat shadowFactor = max(cascade3.w, PerformShadowMapping(cascade1.xyz, atlasTransform));\n\t\tsum += ComputePBRLightShadowInfinite(n, g_LDirectional_Direction[{k}].xyz, v, albedo, g_LDirectional_Color[{k}].rgb, tint, f0, rough, metal, shadowFactor);\n\t}}\n"
        );
    }
    if directional > directional_shadow {
        let _ = write!(
            out,
            "\tfor (int k = {directional_shadow}; k < {directional}; ++k)\n\t{{\n\t\tsum += ComputePBRLightShadowInfinite(n, g_LDirectional_Direction[k].xyz, v, albedo, g_LDirectional_Color[k].rgb, tint, f0, rough, metal, 1.0);\n\t}}\n"
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
    fn spot_segments_follow_wpe_order() {
        // 四盏聚光，阴影 + cookie、cookie、阴影各一：槽 0 / 1 / 2 是三种块（投影同下标），普通循环从 3 开始（R1 1.3、phase-13k R4）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_SPOT", 4),
            ("LIGHTS_SPOT_SHADOW_COOKIE", 1),
            ("LIGHTS_SPOT_COOKIE", 1),
            ("LIGHTS_SPOT_SHADOW", 1),
        ]);
        for line in [
            "uniform mat4 g_LFeature_ShadowProjection[3];",
            "uniform vec4 g_LFeature_ShadowProjectionTransform[3];",
            "vec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[0]);\n\t\tfloat shadowFactor = PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[0]);\n\t\tvec3 cookieColor = texSample2D(COOKIE_SAMPLER, shadowCoords.xy).rgb;",
            "g_LSpot_Color[0].rgb * cookieColor, g_LSpot_Color[0].w, g_LSpot_Exponent[0].x, tint, f0, rough, metal, shadowFactor);",
            "vec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[1]);\n\t\tvec3 cookieColor = texSample2D(COOKIE_SAMPLER, shadowCoords.xy).rgb;",
            "g_LSpot_Color[1].rgb * cookieColor, g_LSpot_Color[1].w, g_LSpot_Exponent[1].x, tint, f0, rough, metal, 1.0);",
            "g_LSpot_Color[2].rgb * cone, g_LSpot_Color[2].w, g_LSpot_Exponent[2].x, tint, f0, rough, metal, shadowFactor);",
            "for (int k = 3; k < 4; ++k)",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        // cookie 段没有锥角衰减、不读 cookie 段以外的阴影变换
        assert_eq!(
            source.matches("float cone").count(),
            2,
            "只有阴影段与普通循环有锥角"
        );
        assert!(!source.contains(
            "PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[1])"
        ));
        // 累加顺序：阴影 + cookie → cookie → 阴影 → 普通
        let at = |s: &str| source.find(s).unwrap();
        assert!(
            at("g_LSpot_Color[0].rgb * cookieColor") < at("g_LSpot_Color[1].rgb * cookieColor")
        );
        assert!(at("g_LSpot_Color[1].rgb * cookieColor") < at("g_LSpot_Color[2].rgb * cone"));
        assert!(at("g_LSpot_Color[2].rgb * cone") < at("for (int k = 3"));
    }

    #[test]
    fn spot_cookies_shift_the_cascade_base() {
        // 两盏 cookie 聚光 + 一盏带阴影的平行光：投影 5 个，级联读 2、3、4（B0 = SSC + SC + SS）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_SPOT", 2),
            ("LIGHTS_SPOT_COOKIE", 2),
            ("LIGHTS_DIRECTIONAL", 1),
            ("LIGHTS_DIRECTIONAL_SHADOW", 1),
        ]);
        for line in [
            "uniform mat4 g_LFeature_ShadowProjection[5];",
            "CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[1])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[2])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[4])",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        // 只有 cookie 段：不调 PerformShadowMapping 的聚光块（平行光那一处除外）
        assert_eq!(source.matches("PerformShadowMapping(").count(), 1);
        assert!(!source.contains("for (int k = 2; k < 2"));
    }

    #[test]
    fn spot_segments_are_cut_at_the_array_length() {
        // 计数超过 LIGHTS_SPOT：块按数组长度截，投影数与级联基址仍按宏原值（同阴影段原来的规则）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_SPOT", 1),
            ("LIGHTS_SPOT_SHADOW_COOKIE", 1),
            ("LIGHTS_SPOT_COOKIE", 2),
        ]);
        assert!(source.contains("uniform mat4 g_LFeature_ShadowProjection[3];"));
        assert!(source.contains("g_LSpot_Color[0].rgb * cookieColor"));
        assert!(!source.contains("g_LSpot_Color[1].rgb"));
        assert!(!source.contains("for (int k"));
    }

    #[test]
    fn spot_shadows_take_the_first_slots() {
        // 两盏聚光、一盏带阴影：槽 0 是阴影块（投影 0），普通循环从 1 开始；阴影块在普通循环之前（R1 1.3）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_SPOT", 2),
            ("LIGHTS_SPOT_SHADOW", 1),
        ]);
        for line in [
            "uniform mat4 g_LFeature_ShadowProjection[1];",
            "uniform vec4 g_LFeature_ShadowProjectionTransform[1];",
            "float cone = smoothstep(g_LSpot_Direction[0].w, g_LSpot_Origin[0].w, dot(normalize(-toLight), g_LSpot_Direction[0].xyz));",
            "vec3 shadowCoords = CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[0]);",
            "PerformShadowMapping(shadowCoords, g_LFeature_ShadowProjectionTransform[0])",
            "g_LSpot_Color[0].rgb * cone, g_LSpot_Color[0].w, g_LSpot_Exponent[0].x, tint, f0, rough, metal, shadowFactor);",
            "for (int k = 1; k < 2; ++k)",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        assert!(source.find("shadowCoords").unwrap() < source.find("for (int k = 1").unwrap());
        assert!(!source.contains("ShadowPointProjection"));
    }

    #[test]
    fn spot_shadows_shift_the_cascade_base() {
        // 一盏带阴影的聚光 + 一盏带阴影的平行光：投影 4 个，聚光用 0，级联读 1、2、3（B0 = SS）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_SPOT", 1),
            ("LIGHTS_SPOT_SHADOW", 1),
            ("LIGHTS_DIRECTIONAL", 1),
            ("LIGHTS_DIRECTIONAL_SHADOW", 1),
        ]);
        for line in [
            "uniform mat4 g_LFeature_ShadowProjection[4];",
            "CalculateProjectedCoords(pos, g_LFeature_ShadowProjection[0])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[1])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[2])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[3])",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        // 段顺序：聚光阴影在平行光阴影之前
        assert!(
            source.find("CalculateProjectedCoords(").unwrap()
                < source.find("CalculateProjectedCoordsCascades").unwrap()
        );
    }

    fn source_of(macros: &[(&str, i64)]) -> String {
        let Expansion::Source(source) = run("LightingV1", macros) else {
            panic!("应当生成");
        };
        source
    }

    #[test]
    fn point_shadows_take_the_first_slots() {
        // 两盏点光、一盏带阴影：槽 0 是阴影块，普通循环从 1 开始；投影与本灯同下标（R1 1.3）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_POINT", 2),
            ("LIGHTS_POINT_SHADOW", 1),
        ]);
        for line in [
            "uniform vec4 g_LFeature_ShadowPointProjection[1];",
            "uniform vec4 g_LFeature_ShadowPointProjectionTransform[1];",
            "CalculateProjectedCoordsPoint(pos, g_LPoint_Origin[0].xyz, g_LFeature_ShadowPointProjection[0], g_LFeature_ShadowPointProjectionTransform[0])",
            "PerformPointShadowMapping(shadowCoords)",
            "for (int k = 1; k < 2; ++k)",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        assert!(!source.contains("g_LFeature_ShadowProjection["));
        // 阴影块在普通循环之前（累加顺序照 WPE）
        assert!(source.find("shadowCoords").unwrap() < source.find("for (int k = 1").unwrap());
    }

    #[test]
    fn directional_cascade_indices_copy_wpe() {
        // 两盏带阴影的平行光：投影数组 6 个，第 2 盏读 1、2、3（WPE 的 B0 + k + c，CPU 写的是 3、4、5），照抄
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_DIRECTIONAL", 3),
            ("LIGHTS_DIRECTIONAL_SHADOW", 2),
        ]);
        for line in [
            "uniform mat4 g_LFeature_ShadowProjection[6];",
            "uniform vec4 g_LFeature_ShadowProjectionTransform[6];",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[0])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[1])",
            "CalculateProjectedCoordsCascades(pos, g_LFeature_ShadowProjection[3])",
            "cascade1.xyz = mix(cascade1.xyz, cascade3.xyz, cascade2.w);",
            "max(cascade3.w, PerformShadowMapping(cascade1.xyz, atlasTransform))",
            "g_LDirectional_Direction[1].xyz",
            "for (int k = 2; k < 3; ++k)",
        ] {
            assert!(source.contains(line), "缺 {line}");
        }
        assert!(!source.contains("g_LFeature_ShadowProjection[4]"));
    }

    #[test]
    fn shadow_declarations_follow_wpe_order() {
        // 声明顺序：各类灯 → 平行光投影 → 点光投影（R1 1.2）
        let source = source_of(&[
            ("LIGHTING", 1),
            ("LIGHTS_POINT", 1),
            ("LIGHTS_POINT_SHADOW", 1),
            ("LIGHTS_DIRECTIONAL", 1),
            ("LIGHTS_DIRECTIONAL_SHADOW", 1),
        ]);
        let order = [
            "g_LPoint_Color[1]",
            "g_LDirectional_Direction[1]",
            "g_LFeature_ShadowProjection[3]",
            "g_LFeature_ShadowProjectionTransform[3]",
            "g_LFeature_ShadowPointProjection[1]",
            "g_LFeature_ShadowPointProjectionTransform[1]",
        ];
        let at: Vec<usize> = order.iter().map(|s| source.find(s).unwrap()).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{at:?}");
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
