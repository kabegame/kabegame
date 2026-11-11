// Kabegame 新增，见 KABEGAME.md
//! HLSL 隐式转换模式（`Options::hlsl_implicit`）的单测：每条规则一个正例（开关打开时能编过、WGSL 里是预期的写法）
//! 和一个反例（开关关闭时照旧报错，或者开关打开时 fxc 也报错的写法照旧报错）。规则与 fxc 依据见 `KABEGAME.md`「行为补丁」。

use alloc::{format, string::String};

use super::{Frontend, Options};
use crate::{
    back::wgsl::{write_string, WriterFlags},
    valid::{Capabilities, ValidationFlags, Validator},
    ShaderStage,
};

/// 片元着色器外壳：一块 uniform（不让常量折叠吃掉要看的运算）和一个输出。
const PRELUDE: &str = "#version 450
layout(set = 0, binding = 0, std140) uniform U { vec4 v4; vec3 v3; vec2 v2; float f; int n; };
layout(location = 0) out vec4 o;
";

/// 解析、校验、写 WGSL；任一步失败返回错误文本。
fn compile(hlsl: bool, body: &str) -> Result<String, String> {
    compile_with(hlsl, &[], body)
}

/// 同 [`compile`]，另把 `intrinsics` 列进 `Options::hlsl_intrinsics`。
fn compile_with(hlsl: bool, intrinsics: &[&str], body: &str) -> Result<String, String> {
    let source = format!("{PRELUDE}{body}\n");
    let mut options = Options::from(ShaderStage::Fragment);
    options.hlsl_implicit = hlsl;
    options
        .hlsl_intrinsics
        .extend(intrinsics.iter().map(|name| String::from(*name)));
    let module = Frontend::default()
        .parse(&options, &source)
        .map_err(|e| format!("parse: {e:?}"))?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|e| format!("validate: {e:?}"))?;
    write_string(&module, &info, WriterFlags::empty()).map_err(|e| format!("write: {e:?}"))
}

/// 正例：开关打开能编过，WGSL 里含有全部 `expected` 片段；开关关闭时报错（这条规则只在 GLSL 报错的地方生效）。
#[track_caller]
fn hlsl_only(body: &str, expected: &[&str]) {
    let wgsl = compile(true, body).unwrap_or_else(|e| panic!("HLSL 模式编不过：{body}\n{e}"));
    for piece in expected {
        assert!(wgsl.contains(piece), "缺 `{piece}`：{body}\n{wgsl}");
    }
    assert!(
        compile(false, body).is_err(),
        "开关关闭时本应报错：{body}"
    );
}

/// 反例：开关打开也照旧报错（fxc 也报错，或者不在规则内）。
#[track_caller]
fn still_fails(body: &str) {
    if let Ok(wgsl) = compile(true, body) {
        panic!("HLSL 模式下本应报错：{body}\n{wgsl}");
    }
}

/// GLSL 本来就接受的写法：开关开、关输出逐字节相同。
#[track_caller]
fn unchanged(body: &str) {
    let off = compile(false, body).unwrap_or_else(|e| panic!("GLSL 编不过：{body}\n{e}"));
    let on = compile(true, body).unwrap_or_else(|e| panic!("HLSL 模式编不过：{body}\n{e}"));
    assert_eq!(off, on, "开关打开后输出变了：{body}");
}

/// 2a：赋值、初始化、`return` 的截断与铺满，向量给标量取 `.x`，`float → int` 向零截断。
#[test]
fn assign_init_return() {
    // 初始化：宽向量截断、标量铺满、向量取 .x、float → int
    hlsl_only("void main() { vec2 a = v4; o = vec4(a, 0.0, 1.0); }", &[".xy"]);
    hlsl_only("void main() { vec3 s = f; o = vec4(s, 1.0); }", &["vec3(_e"]);
    hlsl_only("void main() { float x = v4; o = vec4(x); }", &[".x"]);
    hlsl_only("void main() { int i = f * 3.0; o = vec4(float(i)); }", &["i32("]);
    // 常量初始化也能折叠（局部 const）
    hlsl_only("void main() { const vec3 c = 0.5; o = vec4(c, f); }", &["var c: vec3<f32> = vec3(0.5f);"]);
    // 赋值、复合赋值（`acc += v4` 先按 GLSL 铺满成 vec4 再相加，再截成 .x，与 fxc 的「截成 .x 再加」相同）
    hlsl_only("void main() { vec2 a; a = v4; o = vec4(a, 0.0, 1.0); }", &[".xy"]);
    hlsl_only("void main() { float acc = 0.0; acc += v4; o = vec4(acc); }", &[".x"]);
    hlsl_only("void main() { int i = 0; i = f; o = vec4(float(i)); }", &["i32("]);
    // 标量赋给 swizzle：先铺满再逐分量存（color_grading__extension 的 `albedo.rgb = greyscale(…)`）
    hlsl_only("void main() { vec4 c = v4; c.rgb = f; o = c; }", &["vec3(_e"]);
    // 宽向量赋给单个分量
    hlsl_only("void main() { vec4 c = v4; c.x = v3; o = c; }", &[".x"]);
    // return：截断、int → float（上游 return 不做任何转换）
    hlsl_only("vec2 g() { return v4; }\nvoid main() { o = vec4(g(), 0.0, 1.0); }", &[".xy"]);
    hlsl_only("float h() { return 1; }\nvoid main() { o = vec4(h()); }", &["return 1f;"]);
    hlsl_only("int k() { return f; }\nvoid main() { o = vec4(float(k())); }", &["i32("]);

    // GLSL 本来合法的写法输出不变：swizzle 存宽向量（逐分量取，本来就是截断）、同类型赋值、int → float 提升
    unchanged("void main() { vec4 c = v4; c.xy = v4; c.z = f; o = c; }");
    unchanged("void main() { vec3 a = v3; float x = 1; a = v4.xyz; o = vec4(a, x); }");

    // 窄向量给宽向量：fxc 报错，照旧报错；矩阵截断不做
    still_fails("void main() { vec4 w = v2; o = w; }");
    still_fails("void main() { vec4 w; w = v3; o = w; }");
    still_fails("void main() { mat3 m = mat4(1.0); o = vec4(m[0], 1.0); }");
}

/// 2b：不同宽度的向量混算，宽的一边截到窄的。
#[test]
fn mixed_width_binary() {
    hlsl_only("void main() { vec3 m = v4 * v3; o = vec4(m, 1.0); }", &[".xyz * "]);
    hlsl_only("void main() { vec2 d = v3 - v2; o = vec4(d, 0.0, 1.0); }", &[".xy - "]);
    // 复合赋值经二元那一步：`vec3 += vec4`
    hlsl_only("void main() { vec3 a = v3; a += v4; o = vec4(a, 1.0); }", &[".xyz)"]);
    // 结果按窄的宽度：赋给 vec4 时窄赋宽照旧报错
    still_fails("void main() { vec4 m = v4 * v3; o = m; }");
    // 比较运算不截（HLSL 的向量比较得 bvec，与 GLSL 的 all() 不同）
    still_fails("void main() { o = (v4 == v3) ? v4 : vec4(0.0); }");
    unchanged("void main() { vec3 m = v4.xyz * v3 + f; o = vec4(m * 2.0, 1.0); }");
}

/// 2c：非布尔的标量条件按 `!= 0`：`if` / `while` / `do` / `for` / `?:` / `!` / `&&` / `||`。
#[test]
fn scalar_conditions() {
    hlsl_only("void main() { o = v4; if (f) { o = v4 * 2.0; } }", &["if (_e", " != 0f)"]);
    hlsl_only("void main() { o = v4; if (n) { o = v4 * 2.0; } }", &[" != 0i)"]);
    hlsl_only(
        "void main() { float x = f; while (x) { x -= 1.0; } o = vec4(x); }",
        &[" != 0f"],
    );
    hlsl_only(
        "void main() { float x = f; do { x -= 1.0; } while (x); o = vec4(x); }",
        &[" != 0f"],
    );
    hlsl_only(
        "void main() { float x = f; for (int i = 0; x; i++) { x -= 1.0; } o = vec4(x); }",
        &[" != 0f"],
    );
    hlsl_only("void main() { o = vec4(f ? 0.25 : 0.5); }", &[" != 0f"]);
    hlsl_only("void main() { o = vec4(!f ? 0.25 : 0.5); }", &["!((_e", " != 0f))"]);
    hlsl_only("void main() { o = vec4((f && n) ? 0.25 : 0.5); }", &[" != 0f) && (", " != 0i)"]);
    hlsl_only("void main() { o = vec4((f || v4.y) ? 0.25 : 0.5); }", &[" != 0f) || ("]);

    // 向量条件：fxc 的 `if (float2)` 报 X3019；向量当 `?:` 条件（fxc 逐分量选）不做；都照旧报错
    still_fails("void main() { o = v4; if (v2) { o = v4 * 2.0; } }");
    still_fails("void main() { o = v2 ? v4 : vec4(0.0); }");
    unchanged("void main() { o = v4; if (f > 0.0 && !(n == 1)) { o = (f < 1.0) ? v4 : vec4(0.0); } }");
}

/// 2d：实参的第二遍。GLSL 规则选不出重载时才走；用户函数只有一个重载能匹配才选，多个报二义（fxc X3067）；
/// 内置函数与 `hlsl_intrinsics` 里的包装按代价取截到最窄的。
#[test]
fn overload_second_pass() {
    // 用户函数，唯一能匹配：实参截断（shimmer 的 `rotateVec2(vec4, float)`）、float → int（video 的 `kb_pack_*(float)`）
    hlsl_only(
        "vec2 rot(vec2 v, float a) { return v * a; }\nvoid main() { o = vec4(rot(v4, f), 0.0, 1.0); }",
        &["rot(_e", ".xy, "],
    );
    hlsl_only(
        "vec4 row(int k) { return vec4(float(k)); }\nvoid main() { o = row(f / 4.0); }",
        &["row(i32("],
    );
    // 用户函数，向量给标量形参取 .x（sine_wave 的 `ApplyBlending(…, vec2 → float)`）
    hlsl_only(
        "float g(float x) { return x * 2.0; }\nvoid main() { o = vec4(g(v2)); }",
        &["g(_e", ".x)"],
    );
    // 用户函数多个重载都能匹配：fxc X3067，报二义（实测 `g(float2)` / `g(float3)`、`h(float2)` / `h(float)` 传 float4）
    let ambiguous = [
        "float g(vec2 v) { return v.x; }\nfloat g(vec3 v) { return v.y; }\nvoid main() { o = vec4(g(v4)); }",
        "float h(vec2 v) { return v.x; }\nfloat h(float v) { return v; }\nvoid main() { o = vec4(h(v4)); }",
    ];
    for body in ambiguous {
        let error = compile(true, body).expect_err(body);
        assert!(error.contains("X3067"), "{error}");
    }
    // 同一组重载按内置函数的规则（列进 hlsl_intrinsics）：取截掉分量最少的 vec3（g_1 是第二个重载）
    let wgsl = compile_with(true, &["g"], ambiguous[0]).unwrap();
    assert!(wgsl.contains("g_1(_e") && wgsl.contains(".xyz)"), "{wgsl}");

    // 内置函数：mix(vec4, vec3, float) 取三维；mix(float, vec3, float) 标量铺满到三维；texture 的坐标 vec4 截成 vec2
    hlsl_only("void main() { o = vec4(mix(v4, v3, f), 1.0); }", &["mix(_e", ".xyz, "]);
    hlsl_only("void main() { o = vec4(mix(f, v3, 0.5), 1.0); }", &["mix(vec3(_e"]);
    hlsl_only(
        "layout(set = 0, binding = 1) uniform texture2D t;\nlayout(set = 0, binding = 2) uniform sampler s;\nvoid main() { o = texture(sampler2D(t, s), v4); }",
        &["textureSample(t, s, _e", ".xy)"],
    );
    // 我们的包装（kb_pow 这类标量扩展）：5 个重载都能匹配 kp(float, vec3)，按内置规则取 (vec3, vec3)；
    // 不列进 hlsl_intrinsics 时就是用户函数的二义
    let wrappers = "float kp(float a, float b) { return pow(a, b); }\nvec2 kp(vec2 a, vec2 b) { return pow(a, b); }\nvec3 kp(vec3 a, vec3 b) { return pow(a, b); }\nvec2 kp(vec2 a, float b) { return pow(a, vec2(b)); }\nvec3 kp(vec3 a, float b) { return pow(a, vec3(b)); }\nvoid main() { o = vec4(kp(f, v3), 1.0); }";
    let wgsl = compile_with(true, &["kp"], wrappers).unwrap();
    assert!(wgsl.contains("kp_2(vec3(_e"), "{wgsl}");
    assert!(compile(true, wrappers).unwrap_err().contains("X3067"));
    assert!(compile_with(false, &["kp"], wrappers).is_err());

    // GLSL 第一遍能选出的调用不变（`max(vec2, 1)`：int → float 提升，第二遍不会走）
    unchanged("vec2 rot(vec2 v, float a) { return v * a; }\nvoid main() { o = vec4(rot(v2, 1), max(v3.xy, 1)); }");
    // 窄向量给宽形参、out 实参截断：照旧报错
    still_fails("float g(vec4 v) { return v.x; }\nvoid main() { o = vec4(g(v2)); }");
    still_fails("void g(out vec2 r) { r = vec2(1.0); }\nvoid main() { vec4 w = v4; g(w); o = w; }");
}

/// 2e：浮点下标向零截断成 `u32`（fxc 的 `ftou`）；`bool` 参与算术按 0 / 1。
#[test]
fn float_index_and_bool_arithmetic() {
    // 局部数组、向量、赋值目标的浮点下标（simple_gradient_audio_bar 的 `left[i]`，i 是 float）
    hlsl_only(
        "void main() { float a[4] = float[4](1.0, 2.0, 3.0, 4.0); o = vec4(a[f]); }",
        &["[u32(_e"],
    );
    hlsl_only("void main() { o = vec4(v4[f * 2.0]); }", &["[u32((_e"]);
    hlsl_only(
        "void main() { float a[4] = float[4](1.0, 2.0, 3.0, 4.0); a[f] = 0.0; o = vec4(a[1]); }",
        &["[u32(_e"],
    );
    // bool 参与算术（Simple_Audio_Bars、gaussian 的写法）：转成另一边的分量类型
    hlsl_only("void main() { float x = f; x += f - 1.0 < 0.0; o = vec4(x); }", &["f32(("]);
    hlsl_only("void main() { o = vec4((f < 0.6) * 6.0); }", &["f32(("]);
    hlsl_only(
        "void main() { bool b = f > 0.5; float y = f; y *= b; o = vec4(y); }",
        &["f32(_e"],
    );
    hlsl_only("void main() { int i = n + (f > 0.0); o = vec4(float(i)); }", &["i32(("]);

    // GLSL 本来合法的：整数下标、显式转换
    unchanged("void main() { bool b = f > 0.5; o = vec4(v4[n] + float(b) * 2.0); }");
    // 对标量取下标 fxc 报 X3121；两边都是 bool 的算术不做；照旧报错
    still_fails("void main() { o = vec4(f[0]); }");
    still_fails("void main() { o = vec4(float((f > 0.0) + (f < 1.0))); }");
}

/// 2f：标量的分量访问 `f.x` / `f.xx`（fxc 合法；p7-sem 的 `kbconv4` 用 `f.xx`）。
#[test]
fn scalar_swizzle() {
    // 右值：一个分量是标量自己，多个铺满；uniform 成员、局部变量、表达式结果都行
    hlsl_only("void main() { o = vec4(f.xx, f.r, 1.0); }", &["vec2(_e"]);
    hlsl_only("void main() { float g = f * 2.0; o = g.xxxx; }", &["vec4(_e"]);
    hlsl_only("void main() { o = vec4((f + 1.0).rrr, 1.0); }", &["vec3(("]);
    // 左值：单个分量就是这个变量
    hlsl_only("void main() { float g = 0.0; g.x = f; o = vec4(g); }", &["g = _e"]);

    // 标量只有一个分量：别的分量名、超过 4 个、左值重复分量照旧报错
    still_fails("void main() { o = vec4(f.y); }");
    still_fails("void main() { o = vec4(f.xxxxx); }");
    still_fails("void main() { float g = 0.0; g.xx = v2; o = vec4(g); }");
    unchanged("void main() { o = vec4(v4.xx, v2.y, f); }");
}

/// 步骤 3：输入可写（HLSL 的 PS 输入是可改写的参数；WPE 片元改写 varying 实测编过）。uniform 仍不可写。
#[test]
fn writable_inputs() {
    hlsl_only(
        "layout(location = 0) in vec2 uv;\nvoid main() { uv.y += 1.0; uv = uv * f; o = vec4(uv, 0.0, 1.0); }",
        &["uv_1 = "],
    );
    still_fails("void main() { f = 1.0; o = v4; }");
    unchanged("layout(location = 0) in vec2 uv;\nvoid main() { vec2 t = uv; t.y += 1.0; o = vec4(t, f, 1.0); }");
}
