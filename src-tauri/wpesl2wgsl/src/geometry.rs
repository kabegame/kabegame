//! 几何着色器展开：WebGPU 没有几何着色器，把 WPE 的「顶点着色器 GS 分支 + 几何着色器」拼成一个顶点着色器。
//!
//! 每次几何着色器调用（输入一个点）是一个实例，`gl_VertexIndex` 是第几个输出顶点。每个输出顶点都把顶点段与
//! 几何着色器的函数体照跑一遍，第 `gl_VertexIndex` 次 `OUT.Append` 的顶点就是本次的输出。管线用三角形带，
//! 实例之间本来就断开，与 GS 每次调用输出一条带等价。只支持点输入（`IN[0]`）与单条带（没有 `OUT.RestartStrip()`）。
//!
//! 拼好的行交给 [`crate::rewrite::build`]，与普通顶点着色器一样改写；规则逐条见 [`merge`] 与 README「几何着色器展开」。

use std::collections::{BTreeMap, BTreeSet};

use crate::preprocess::{split_ident, Line, Preprocessor};
use crate::rewrite::RewriteError;
use crate::Stage;

/// 生成的行记在这个文件名下（不会产生诊断）。
const GENERATED_FILE: &str = "<geometry>";

/// D3D11 的 `maxvertexcount` 上限。
const MAX_VERTEX_COUNT: i64 = 1024;

/// 把预处理后的顶点段与几何段拼成一段顶点着色器，返回拼好的行与 `[maxvertexcount(…)]` 求出的输出顶点数。
///
/// `pp` 是预处理几何段的预处理器（最终宏表，`maxvertexcount` 按它求值）。
///
/// 1. 顶点段：`varying T x;` 改成私有全局 `T kb_gsin_x;`，正文里的 `x` 改成 `kb_gsin_x`；`gl_Position` 改成
///    `kb_gsin_gl_Position`；`main` 改成 `kb_vs_main`。
/// 2. 几何段：`in T x;` 删掉（顶点段必须有同名、同类型的 varying，`gl_Position` 除外）；`out T x;` 改成真正的
///    `varying T x;`（与片元按名字配对），`out vec4 gl_Position;` 删掉；`IN[0].x` 改成 `kb_gsin_x`；`PS_INPUT` 是生成的
///    结构体（每个 `out` 一个字段加 `vec4 kb_Position`），`.gl_Position` 字段访问改成 `.kb_Position`；`OUT.Append(e)`
///    改成 `kb_gs_append(e)`；`main` 改成 `kb_gs_main`；`normalize(` 改成 `kb_gs_normalize(`。
/// 3. for 头里声明的变量在循环体顶层被同名变量遮蔽时（HLSL 允许，GLSL 450 是重复声明），for 头里的改名为 `kb_<名>`。
/// 4. HLSL 的隐式截断（`vec3 x = <vec4>`、给 `PS_INPUT` 字段整体赋更宽的向量）：浮点标量 / 向量的局部声明初始值与
///    `PS_INPUT` 字段的整体赋值包一层 `kb_gs_as_<类型>(…)`，按实参类型重载（同类型原样、更宽的取前几个分量、标量铺满）。
/// 5. 拼接顺序：私有全局 → `struct PS_INPUT` 与选中的顶点 → 辅助函数 → 顶点段 → 几何段 → 新的 `main`。
/// 6. `kb_gs_normalize` 遇到零向量时置 `kb_gs_degenerate`，整个图元放到裁剪体外：WPE 下 `normalize(0)` 得 NaN，
///    D3D 丢弃含 NaN 顶点的三角形；WGSL 允许实现假定没有 NaN，不能靠检测 NaN。
pub fn merge(
    vertex: &[Line],
    geometry: &[Line],
    pp: &Preprocessor,
) -> Result<(Vec<Line>, u32), RewriteError> {
    // ---- 顶点段 ----
    let mut vs_varyings: Vec<Var> = Vec::new();
    let mut vs_body: Vec<&Line> = Vec::new();
    for (line, top_level) in vertex.iter().zip(top_level_flags(vertex)) {
        if top_level && split_ident(line.code.trim()).0 == "varying" {
            let vars = parse_vars(&line.code).map_err(|m| error(Stage::Vertex, m, line))?;
            // `varying uint gl_ViewportIndex;` 这类内建声明照旧留给改写层忽略
            if vars.iter().all(|v| v.name.starts_with("gl_")) {
                vs_body.push(line);
                continue;
            }
            vs_varyings.extend(vars.into_iter().filter(|v| !v.name.starts_with("gl_")));
            continue;
        }
        vs_body.push(line);
    }
    let vs_names: BTreeSet<&str> = vs_varyings.iter().map(|v| v.name.as_str()).collect();
    let mut vs_tokens = tokenize(&vs_body);
    let mut vs_main = false;
    for i in 0..vs_tokens.len() {
        if vs_tokens[i].kind != Kind::Ident || after_dot(&vs_tokens, i) {
            continue;
        }
        let renamed = match vs_tokens[i].text.as_str() {
            "gl_Position" => "kb_gsin_gl_Position".to_string(),
            "main" => {
                vs_main = true;
                "kb_vs_main".to_string()
            }
            name if vs_names.contains(name) => format!("kb_gsin_{name}"),
            _ => continue,
        };
        vs_tokens[i].text = renamed;
    }
    if !vs_main {
        return Err(RewriteError {
            stage: Stage::Vertex,
            message: "顶点着色器没有 main".into(),
            file: None,
            line: None,
        });
    }

    // ---- 几何段：接口声明与 maxvertexcount ----
    let mut inputs: BTreeMap<String, Var> = BTreeMap::new();
    let mut outputs: Vec<Var> = Vec::new();
    let mut max_vertices: Option<(u32, &Line)> = None;
    // 每行的去向：正文（可能删掉了 maxvertexcount）、改写成 varying 的 out 声明，或整行删掉
    let mut roles: Vec<Role> = Vec::with_capacity(geometry.len());
    let mut gs_body: Vec<Line> = Vec::new();
    for (line, top_level) in geometry.iter().zip(top_level_flags(geometry)) {
        let fail = |message: String| error(Stage::Geometry, message, line);
        let mut code = line.code.clone();
        if let Some((expr, rest)) = take_max_vertex_count(&code).map_err(fail)? {
            if let Some((_, first)) = max_vertices {
                return Err(fail(format!(
                    "[maxvertexcount] 出现了不止一次（第一次在 {}:{}）",
                    first.file, first.line
                )));
            }
            let count = pp
                .eval(&expr)
                .map_err(|m| fail(format!("[maxvertexcount({expr})] 求值失败：{m}")))?;
            if !(1..=MAX_VERTEX_COUNT).contains(&count) {
                return Err(fail(format!(
                    "[maxvertexcount({expr})] = {count}，不在 1..={MAX_VERTEX_COUNT}"
                )));
            }
            max_vertices = Some((count as u32, line));
            code = rest;
        }
        let keyword = split_ident(code.trim()).0;
        if top_level && matches!(keyword, "in" | "out") {
            let vars = parse_vars(&code).map_err(fail)?;
            if keyword == "in" {
                for var in vars.into_iter().filter(|v| v.name != "gl_Position") {
                    match vs_varyings.iter().find(|v| v.name == var.name) {
                        Some(found) if *found == var => {}
                        Some(found) => {
                            return Err(fail(format!(
                                "几何着色器输入 {} 是 {}，顶点着色器的 varying 是 {}",
                                var.name,
                                var.decl(&var.name),
                                found.decl(&found.name)
                            )));
                        }
                        None => {
                            return Err(fail(format!(
                                "几何着色器输入 {} 在顶点着色器里没有同名的 varying",
                                var.name
                            )));
                        }
                    }
                    inputs.insert(var.name.clone(), var);
                }
                roles.push(Role::Removed);
            } else {
                let vars: Vec<Var> = vars
                    .into_iter()
                    .filter(|v| v.name != "gl_Position")
                    .collect();
                if vars.is_empty() {
                    roles.push(Role::Removed);
                } else {
                    outputs.extend(vars.iter().cloned());
                    roles.push(Role::Varying(vars));
                }
            }
            continue;
        }
        if top_level && matches!(keyword, "attribute" | "varying") {
            return Err(fail(format!(
                "几何着色器里出现 {keyword}：接口变量只支持 in / out 声明"
            )));
        }
        roles.push(Role::Body);
        gs_body.push(Line {
            code,
            ..line.clone()
        });
    }
    let Some((max_vertices, _)) = max_vertices else {
        return Err(RewriteError {
            stage: Stage::Geometry,
            message: "几何着色器缺少 [maxvertexcount(…)]".into(),
            file: None,
            line: None,
        });
    };

    // ---- 几何段：正文改写 ----
    let gs_refs: Vec<&Line> = gs_body.iter().collect();
    let mut tokens = tokenize(&gs_refs);
    let directives = directive_lines(&gs_refs);
    let fail_at = |tokens: &[Tok], i: usize, message: String| {
        error(Stage::Geometry, message, gs_refs[tokens[i].line])
    };
    let mut gs_main = false;
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i].kind != Kind::Ident || after_dot(&tokens, i) {
            i += 1;
            continue;
        }
        match tokens[i].text.as_str() {
            // IN[0].x → kb_gsin_x
            "IN" => {
                let shape = (|| {
                    let open = next_sig(&tokens, i).filter(|&j| tokens[j].is_punct('['))?;
                    let index = next_sig(&tokens, open)?;
                    let close = next_sig(&tokens, index).filter(|&j| tokens[j].is_punct(']'))?;
                    let dot = next_sig(&tokens, close).filter(|&j| tokens[j].is_punct('.'))?;
                    let name = next_sig(&tokens, dot).filter(|&j| tokens[j].kind == Kind::Ident)?;
                    Some((index, name))
                })();
                let Some((index, name)) = shape else {
                    return Err(fail_at(&tokens, i, "IN 只支持 IN[0].<输入> 的写法".into()));
                };
                if tokens[index].text != "0" {
                    return Err(fail_at(
                        &tokens,
                        i,
                        format!("只支持点输入：IN[{}]", tokens[index].text),
                    ));
                }
                let field = tokens[name].text.clone();
                if field != "gl_Position" && !inputs.contains_key(&field) {
                    return Err(fail_at(
                        &tokens,
                        i,
                        format!("IN[0].{field} 不是几何着色器声明的输入"),
                    ));
                }
                tokens[i].text = format!("kb_gsin_{field}");
                clear(&mut tokens, i + 1, name + 1);
                i = name + 1;
                continue;
            }
            // OUT.Append(e) → kb_gs_append(e)
            "OUT" => {
                let member = next_sig(&tokens, i)
                    .filter(|&j| tokens[j].is_punct('.'))
                    .and_then(|dot| next_sig(&tokens, dot))
                    .filter(|&j| tokens[j].kind == Kind::Ident);
                match member.map(|j| (j, tokens[j].text.as_str())) {
                    Some((j, "Append")) => {
                        tokens[i].text = "kb_gs_append".into();
                        clear(&mut tokens, i + 1, j + 1);
                        i = j + 1;
                        continue;
                    }
                    Some((_, "RestartStrip")) => {
                        return Err(fail_at(
                            &tokens,
                            i,
                            "不支持 OUT.RestartStrip()：只支持每次调用输出一条三角形带".into(),
                        ));
                    }
                    _ => {
                        return Err(fail_at(
                            &tokens,
                            i,
                            "OUT 只支持 OUT.Append(<PS_INPUT>)".into(),
                        ));
                    }
                }
            }
            "gl_Position" => {
                return Err(fail_at(
                    &tokens,
                    i,
                    "几何着色器正文直接使用 gl_Position：只支持经 PS_INPUT 的字段输出".into(),
                ));
            }
            "main" => {
                tokens[i].text = "kb_gs_main".into();
                gs_main = true;
            }
            "normalize" if next_sig(&tokens, i).is_some_and(|j| tokens[j].is_punct('(')) => {
                tokens[i].text = "kb_gs_normalize".into();
            }
            _ => {}
        }
        i += 1;
    }
    // 结构体字段 `.gl_Position` → `.kb_Position`（字段名不能以 gl_ 开头）
    for i in 0..tokens.len() {
        if tokens[i].kind == Kind::Ident && tokens[i].text == "gl_Position" && after_dot(&tokens, i)
        {
            tokens[i].text = "kb_Position".into();
        }
    }
    if !gs_main {
        return Err(RewriteError {
            stage: Stage::Geometry,
            message: "几何着色器没有 main".into(),
            file: None,
            line: None,
        });
    }
    let mut taken: BTreeSet<String> = vs_tokens
        .iter()
        .chain(&tokens)
        .filter(|t| t.kind == Kind::Ident)
        .map(|t| t.text.clone())
        .collect();
    rename_shadowed_loop_vars(&mut tokens, &mut taken);
    let mut fields: BTreeMap<String, String> = outputs
        .iter()
        .filter(|v| v.array.is_none())
        .map(|v| (v.name.clone(), v.ty.clone()))
        .collect();
    fields.insert("kb_Position".into(), "vec4".into());
    let casts = wrap_truncations(&mut tokens, &directives, &fields);

    // ---- 拼接 ----
    let mut out: Vec<Line> = Vec::new();
    let mut emit = |code: String| out.push(generated(code));
    // 1. 私有全局
    for var in &vs_varyings {
        emit(format!("{};", var.decl(&format!("kb_gsin_{}", var.name))));
    }
    emit("vec4 kb_gsin_gl_Position;".into());
    emit("int kb_gs_target;".into());
    emit("int kb_gs_count;".into());
    emit("bool kb_gs_hit;".into());
    emit("bool kb_gs_degenerate;".into());
    // 2. PS_INPUT 与选中的输出顶点（要在结构体之后声明）
    emit("struct PS_INPUT {".into());
    for var in &outputs {
        emit(format!("    {};", var.decl(&var.name)));
    }
    emit("    vec4 kb_Position;".into());
    emit("};".into());
    emit("PS_INPUT kb_gs_selected;".into());
    // 3. 辅助函数
    emit("void kb_gs_append(PS_INPUT v) { if (kb_gs_count == kb_gs_target) { kb_gs_selected = v; kb_gs_hit = true; } kb_gs_count++; }".into());
    emit("float kb_gs_normalize(float v) { if (v * v == 0.0) { kb_gs_degenerate = true; return v; } return v * inversesqrt(v * v); }".into());
    for ty in ["vec2", "vec3", "vec4"] {
        emit(format!("{ty} kb_gs_normalize({ty} v) {{ float d = dot(v, v); if (d == 0.0) {{ kb_gs_degenerate = true; return v; }} return v * inversesqrt(d); }}"));
    }
    for (ty, sources) in CASTS {
        if !casts.contains(ty) {
            continue;
        }
        for (from, expr) in *sources {
            emit(format!("{ty} kb_gs_as_{ty}({from} v) {{ return {expr}; }}"));
        }
    }
    // 4. 顶点段正文
    for (line, code) in vs_body.iter().zip(detokenize(&vs_tokens, vs_body.len())) {
        out.push(Line {
            code,
            ..(*line).clone()
        });
    }
    // 5. 几何段：正文行与改写成 varying 的 out 声明按原顺序
    let mut body = gs_body.iter().zip(detokenize(&tokens, gs_body.len()));
    for (line, role) in geometry.iter().zip(&roles) {
        match role {
            Role::Removed => {}
            Role::Varying(vars) => {
                for var in vars {
                    out.push(Line {
                        code: format!("varying {};", var.decl(&var.name)),
                        ..line.clone()
                    });
                }
            }
            Role::Body => {
                let (original, code) = body.next().expect("正文行数与角色一致");
                out.push(Line {
                    code,
                    ..original.clone()
                });
            }
        }
    }
    // 6. 新的 main
    let mut emit = |code: String| out.push(generated(code));
    emit("void main() {".into());
    emit("    kb_vs_main();".into());
    emit("    kb_gs_target = int(gl_VertexIndex);".into());
    emit("    kb_gs_count = 0;".into());
    emit("    kb_gs_hit = false;".into());
    emit("    kb_gs_degenerate = false;".into());
    emit("    kb_gs_main();".into());
    emit("    if (kb_gs_hit && !kb_gs_degenerate) {".into());
    emit("        gl_Position = kb_gs_selected.kb_Position;".into());
    for var in &outputs {
        emit(format!("        {0} = kb_gs_selected.{0};", var.name));
    }
    // 没选中（画的顶点数多于 Append 次数）或零向量 normalize：放到裁剪体外。退化时整个实例的每个顶点都走这一支，
    // 整个图元不画；生成的 GLSL 只用 ASCII，说明写在这里
    emit("    } else {".into());
    emit("        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);".into());
    emit("    }".into());
    emit("}".into());
    Ok((out, max_vertices))
}

/// `in` / `out` / `varying` 声明里的一个变量。
#[derive(Debug, Clone, PartialEq)]
struct Var {
    ty: String,
    name: String,
    array: Option<u32>,
}

impl Var {
    /// `<类型> <名字>[N]`（不带分号）。
    fn decl(&self, name: &str) -> String {
        let array = self.array.map(|n| format!("[{n}]")).unwrap_or_default();
        format!("{} {name}{array}", self.ty)
    }
}

/// 几何段一行的去向。
enum Role {
    Body,
    /// `out` 声明改写成的 varying（`gl_Position` 已去掉）。
    Varying(Vec<Var>),
    Removed,
}

/// 隐式截断辅助函数：目标类型 → （实参类型, 返回表达式）。HLSL 允许把更宽的向量赋给较窄的、把标量铺满成向量。
const CASTS: &[(&str, &[(&str, &str)])] = &[
    (
        "float",
        &[
            ("float", "v"),
            ("vec2", "v.x"),
            ("vec3", "v.x"),
            ("vec4", "v.x"),
        ],
    ),
    (
        "vec2",
        &[
            ("vec2", "v"),
            ("vec3", "v.xy"),
            ("vec4", "v.xy"),
            ("float", "vec2(v)"),
        ],
    ),
    (
        "vec3",
        &[("vec3", "v"), ("vec4", "v.xyz"), ("float", "vec3(v)")],
    ),
    ("vec4", &[("vec4", "v"), ("float", "vec4(v)")]),
];

fn generated(code: String) -> Line {
    Line {
        code,
        comment: None,
        file: GENERATED_FILE.into(),
        line: 0,
    }
}

fn error(stage: Stage, message: String, line: &Line) -> RewriteError {
    RewriteError {
        stage,
        message,
        file: Some(line.file.clone()),
        line: Some(line.line),
    }
}

/// 每行开头是否在全局作用域（花括号、圆括号都已闭合）。预处理指令行不计括号。
fn top_level_flags(lines: &[Line]) -> Vec<bool> {
    let (mut braces, mut parens) = (0i32, 0i32);
    lines
        .iter()
        .map(|line| {
            let top = braces <= 0 && parens <= 0;
            if !line.code.trim_start().starts_with('#') {
                for c in line.code.chars() {
                    match c {
                        '{' => braces += 1,
                        '}' => braces -= 1,
                        '(' => parens += 1,
                        ')' => parens -= 1,
                        _ => {}
                    }
                }
            }
            top
        })
        .collect()
}

/// 解析一行 `in` / `out` / `varying` 声明：`<关键字> [精度] <类型> a, b[4];`。
fn parse_vars(code: &str) -> Result<Vec<Var>, String> {
    let text = code.trim();
    let Some(body) = text.strip_suffix(';') else {
        return Err(format!("接口声明没有在本行结束：{text}"));
    };
    let mut rest = split_ident(body).1.trim_start();
    let ty = loop {
        let (word, after) = split_ident(rest);
        if word.is_empty() {
            return Err(format!("接口声明缺少类型：{text}"));
        }
        rest = after.trim_start();
        if !matches!(word, "lowp" | "mediump" | "highp") {
            break word;
        }
    };
    let mut vars = Vec::new();
    for part in rest.split(',') {
        let (name, after) = split_ident(part.trim());
        if name.is_empty() {
            return Err(format!("接口声明缺少名字：{text}"));
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
            return Err(format!("不支持的接口声明（带初始值或限定符）：{text}"));
        };
        vars.push(Var {
            ty: ty.to_string(),
            name: name.to_string(),
            array,
        });
    }
    Ok(vars)
}

/// 取出一行里的 `[maxvertexcount(<表达式>)]`：返回（表达式, 去掉它之后的行）；没有返回 None。
fn take_max_vertex_count(code: &str) -> Result<Option<(String, String)>, String> {
    let mut search = 0;
    while let Some(at) = code[search..].find('[') {
        let open = search + at;
        let after = code[open + 1..].trim_start();
        let (word, rest) = split_ident(after);
        if word != "maxvertexcount" {
            search = open + 1;
            continue;
        }
        let rest = rest.trim_start();
        let Some(args) = rest.strip_prefix('(') else {
            return Err(format!("无法解析的 [maxvertexcount]：{}", code.trim()));
        };
        let mut depth = 1usize;
        let mut end = None;
        for (i, c) in args.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            return Err(format!("[maxvertexcount] 的括号没有闭合：{}", code.trim()));
        };
        let Some(tail) = args[end + 1..].trim_start().strip_prefix(']') else {
            return Err(format!("[maxvertexcount] 缺少 ]：{}", code.trim()));
        };
        let expr = args[..end].trim().to_string();
        let remaining = format!("{}{}", &code[..open], tail);
        return Ok(Some((expr, remaining)));
    }
    Ok(None)
}

// ---- 记号 ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ident,
    Number,
    Punct,
    Space,
}

/// 一个记号；`line` 是它（起始处）所在的行号（段内下标）。
#[derive(Debug, Clone)]
struct Tok {
    kind: Kind,
    text: String,
    line: usize,
}

impl Tok {
    fn is_punct(&self, c: char) -> bool {
        self.kind == Kind::Punct && self.text.len() == c.len_utf8() && self.text.starts_with(c)
    }
}

/// 把若干行按 `\n` 连起来切成记号。改写只替换记号文字，删掉的记号保留其中的换行，[`detokenize`] 能按原行数切回。
fn tokenize(lines: &[&Line]) -> Vec<Tok> {
    let source = lines
        .iter()
        .map(|line| line.code.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut tokens = Vec::new();
    let mut rest = source.as_str();
    let mut line = 0;
    while let Some(c) = rest.chars().next() {
        let (kind, len) = if c.is_ascii_alphabetic() || c == '_' {
            (Kind::Ident, split_ident(rest).0.len())
        } else if c.is_ascii_digit() {
            let len = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            (Kind::Number, len)
        } else if c.is_whitespace() {
            let len = rest
                .char_indices()
                .find(|(_, c)| !c.is_whitespace())
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            (Kind::Space, len)
        } else {
            (Kind::Punct, c.len_utf8())
        };
        let text = &rest[..len];
        tokens.push(Tok {
            kind,
            text: text.to_string(),
            line,
        });
        line += text.matches('\n').count();
        rest = &rest[len..];
    }
    tokens
}

fn detokenize(tokens: &[Tok], lines: usize) -> Vec<String> {
    let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
    let out: Vec<String> = text.split('\n').map(str::to_string).collect();
    // 空段 join 之后是一个空串，切回来也是一行
    debug_assert!(lines == 0 || out.len() == lines, "改写改变了行数");
    if lines == 0 {
        Vec::new()
    } else {
        out
    }
}

/// 预处理指令行（`#define` 等）的段内下标。
fn directive_lines(lines: &[&Line]) -> BTreeSet<usize> {
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.code.trim_start().starts_with('#'))
        .map(|(i, _)| i)
        .collect()
}

/// 清掉 `[from, to)` 的记号文字，只留其中的换行（行数不变）。
fn clear(tokens: &mut [Tok], from: usize, to: usize) {
    for token in &mut tokens[from..to] {
        token.text = "\n".repeat(token.text.matches('\n').count());
    }
}

fn next_sig(tokens: &[Tok], i: usize) -> Option<usize> {
    (i + 1..tokens.len()).find(|&j| tokens[j].kind != Kind::Space && !tokens[j].text.is_empty())
}

fn prev_sig(tokens: &[Tok], i: usize) -> Option<usize> {
    (0..i)
        .rev()
        .find(|&j| tokens[j].kind != Kind::Space && !tokens[j].text.is_empty())
}

/// 是否是成员访问（前一个有效记号是 `.`）。
fn after_dot(tokens: &[Tok], i: usize) -> bool {
    prev_sig(tokens, i).is_some_and(|j| tokens[j].is_punct('.'))
}

/// 与 `open`（`(`、`[` 或 `{`）配对的闭括号下标。
fn matching(tokens: &[Tok], open: usize) -> Option<usize> {
    let (o, c) = match tokens[open].text.as_str() {
        "(" => ('(', ')'),
        "[" => ('[', ']'),
        "{" => ('{', '}'),
        _ => return None,
    };
    let mut depth = 0usize;
    for (j, token) in tokens.iter().enumerate().skip(open) {
        if token.is_punct(o) {
            depth += 1;
        } else if token.is_punct(c) {
            depth -= 1;
            if depth == 0 {
                return Some(j);
            }
        }
    }
    None
}

fn is_type(name: &str) -> bool {
    matches!(
        name,
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

/// 规则 3：`for (int s = …; …) { float s = …; … }`。GLSL 450 的循环体不开新作用域，这是重复声明；HLSL 允许遮蔽。
/// for 头里的变量改名为 `kb_<名>`（撞名再加 `_2`、`_3`……），循环体里遮蔽声明之前对它的引用一起改。
fn rename_shadowed_loop_vars(tokens: &mut [Tok], taken: &mut BTreeSet<String>) {
    for i in 0..tokens.len() {
        if !(tokens[i].kind == Kind::Ident && tokens[i].text == "for") || after_dot(tokens, i) {
            continue;
        }
        let Some(open) = next_sig(tokens, i).filter(|&j| tokens[j].is_punct('(')) else {
            continue;
        };
        let Some(close) = matching(tokens, open) else {
            continue;
        };
        // for 头里的声明：<类型> <名字>
        let Some(ty) = next_sig(tokens, open).filter(|&j| is_type(&tokens[j].text)) else {
            continue;
        };
        let Some(var) = next_sig(tokens, ty).filter(|&j| tokens[j].kind == Kind::Ident) else {
            continue;
        };
        let name = tokens[var].text.clone();
        let Some(body_open) = next_sig(tokens, close).filter(|&j| tokens[j].is_punct('{')) else {
            continue;
        };
        let Some(body_close) = matching(tokens, body_open) else {
            continue;
        };
        // 循环体顶层（不在嵌套的块或括号里）的同名声明
        let mut depth = 0i32;
        let mut shadow = None;
        for j in body_open + 1..body_close {
            let token = &tokens[j];
            if token.is_punct('{') || token.is_punct('(') {
                depth += 1;
            } else if token.is_punct('}') || token.is_punct(')') {
                depth -= 1;
            } else if depth == 0
                && token.kind == Kind::Ident
                && is_type(&token.text)
                && prev_sig(tokens, j).is_some_and(|p| {
                    tokens[p].is_punct('{') || tokens[p].is_punct(';') || tokens[p].is_punct('}')
                })
            {
                let declared = next_sig(tokens, j).filter(|&k| tokens[k].text == name);
                let follows = declared
                    .and_then(|k| next_sig(tokens, k))
                    .is_some_and(|k| ["=", ";", ",", "["].contains(&tokens[k].text.as_str()));
                if follows {
                    shadow = Some(j);
                    break;
                }
            }
        }
        let Some(shadow) = shadow else {
            continue;
        };
        let renamed = {
            let base = format!("kb_{name}");
            let mut candidate = base.clone();
            let mut n = 2;
            while taken.contains(&candidate) {
                candidate = format!("{base}_{n}");
                n += 1;
            }
            taken.insert(candidate.clone());
            candidate
        };
        for j in (open..=close).chain(body_open..shadow) {
            if tokens[j].kind == Kind::Ident && tokens[j].text == name && !after_dot(tokens, j) {
                tokens[j].text = renamed.clone();
            }
        }
    }
}

/// 规则 4：HLSL 的隐式截断。浮点标量 / 向量局部声明的初始值，以及 `PS_INPUT` 变量字段的整体赋值，右边包一层
/// `kb_gs_as_<类型>(…)`；返回用到的目标类型。只看语句开头（前一个有效记号是 `;`、`{`、`}` 或预处理指令行），
/// 不碰 `const`、for 头、多个声明符与预处理指令行里的写法。
fn wrap_truncations(
    tokens: &mut [Tok],
    directives: &BTreeSet<usize>,
    fields: &BTreeMap<String, String>,
) -> BTreeSet<&'static str> {
    let statement_start = |tokens: &[Tok], i: usize| {
        if directives.contains(&tokens[i].line) {
            return false;
        }
        match prev_sig(tokens, i) {
            None => true,
            Some(p) if tokens[p].line != tokens[i].line && directives.contains(&tokens[p].line) => {
                true
            }
            Some(p) => {
                tokens[p].is_punct(';') || tokens[p].is_punct('{') || tokens[p].is_punct('}')
            }
        }
    };
    // PS_INPUT 类型的变量（局部变量与参数）
    let structs: BTreeSet<String> = (0..tokens.len())
        .filter(|&i| tokens[i].kind == Kind::Ident && tokens[i].text == "PS_INPUT")
        .filter_map(|i| next_sig(tokens, i).filter(|&j| tokens[j].kind == Kind::Ident))
        .map(|j| tokens[j].text.clone())
        .collect();
    let mut used = BTreeSet::new();
    // （记号下标, 插在它前面的文字）：扫描完再统一插入，扫描时看到的都是原记号
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i].kind != Kind::Ident || !statement_start(tokens, i) {
            i += 1;
            continue;
        }
        // 赋值号的位置与目标类型
        let target = if let Some(&(ty, _)) = CASTS.iter().find(|(ty, _)| tokens[i].text == *ty) {
            next_sig(tokens, i)
                .filter(|&j| tokens[j].kind == Kind::Ident)
                .and_then(|j| next_sig(tokens, j))
                .map(|eq| (eq, ty))
        } else if structs.contains(&tokens[i].text) {
            next_sig(tokens, i)
                .filter(|&j| tokens[j].is_punct('.'))
                .and_then(|dot| next_sig(tokens, dot))
                .and_then(|field| {
                    let ty = fields.get(&tokens[field].text)?;
                    let ty = CASTS.iter().find(|(t, _)| t == ty)?.0;
                    Some((next_sig(tokens, field)?, ty))
                })
        } else {
            None
        };
        // `=` 而不是 `==`、`+=` 之类
        let Some((eq, ty)) = target.filter(|&(eq, _)| {
            tokens[eq].is_punct('=') && tokens.get(eq + 1).is_none_or(|t| !t.is_punct('='))
        }) else {
            i += 1;
            continue;
        };
        // 右边：到顶层的 `;` 为止，中间有顶层逗号（多个声明符）就不动
        let mut depth = 0i32;
        let mut end = None;
        for (j, token) in tokens.iter().enumerate().skip(eq + 1) {
            if token.is_punct('(') || token.is_punct('[') || token.is_punct('{') {
                depth += 1;
            } else if token.is_punct(')') || token.is_punct(']') || token.is_punct('}') {
                depth -= 1;
            } else if depth == 0 && (token.is_punct(';') || token.is_punct(',')) {
                end = token.is_punct(';').then_some(j);
                break;
            }
        }
        let (Some(end), Some(first)) = (end, next_sig(tokens, eq)) else {
            i = eq + 1;
            continue;
        };
        if first >= end {
            i = end + 1;
            continue;
        }
        inserts.push((first, format!("kb_gs_as_{ty}(")));
        inserts.push((end, ")".into()));
        used.insert(ty);
        i = end + 1;
    }
    for (at, text) in inserts {
        tokens[at].text.insert_str(0, &text);
    }
    used
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(file: &str, source: &str) -> Vec<Line> {
        source
            .lines()
            .enumerate()
            .map(|(i, raw)| {
                let (code, comment) = crate::preprocess::split_line_comment(raw);
                Line {
                    code,
                    comment,
                    file: file.into(),
                    line: i as u32 + 1,
                }
            })
            .collect()
    }

    fn pp_with(defines: &[(&str, &str)]) -> Preprocessor<'static> {
        let includes: &'static BTreeMap<String, String> = Box::leak(Box::default());
        let defines = defines
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Preprocessor::new(includes, &defines)
    }

    const VS: &str = "attribute vec4 a_PositionVec4;
attribute vec4 a_Color;
varying vec4 v_Color;
varying vec3 v_End;
void main() {
\tgl_Position = vec4(a_PositionVec4.xyz, a_PositionVec4.w);
\tv_End = a_PositionVec4.xyz;
\tv_Color = a_Color;
}";

    const GS: &str = "in vec4 gl_Position;
in vec4 v_Color;
in vec3 v_End;
out vec2 v_TexCoord;
out vec4 v_Color;
out vec4 gl_Position;
[maxvertexcount(4 + SUB * 2)]
void main() {
\tvec3 start = IN[0].gl_Position.xyz;
\tvec3 dir = normalize(IN[0].v_End - start);
\tPS_INPUT v;
\tv.v_Color = IN[0].v_Color;
\tv.gl_Position = vec4(start - dir, 1.0);
\tv.v_TexCoord = vec2(0, 0);
\tOUT.Append(v);
\tv.gl_Position = vec4(start + dir, 1.0);
\tv.v_TexCoord = vec2(1, 0);
\tOUT.Append(v);
}";

    fn merged(gs: &str, defines: &[(&str, &str)]) -> Result<(String, u32), RewriteError> {
        let (out, count) = merge(
            &lines("<vertex>", VS),
            &lines("<geometry>", gs),
            &pp_with(defines),
        )?;
        let text = out
            .iter()
            .map(|l| l.code.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        Ok((text, count))
    }

    fn gs_body(text: &str) -> &str {
        let start = text.find("void kb_gs_main()").expect("kb_gs_main");
        &text[start..text.rfind("void main()").unwrap()]
    }

    #[test]
    fn inputs_become_private_globals() {
        let (text, _) = merged(GS, &[("SUB", "0")]).unwrap();
        // 顶点段：varying → 私有全局，正文引用随之改名
        assert!(
            text.contains("vec4 kb_gsin_v_Color;\nvec3 kb_gsin_v_End;\nvec4 kb_gsin_gl_Position;"),
            "{text}"
        );
        assert!(text.contains("void kb_vs_main() {"), "{text}");
        assert!(
            text.contains("kb_gsin_gl_Position = vec4(a_PositionVec4.xyz, a_PositionVec4.w);"),
            "{text}"
        );
        assert!(text.contains("kb_gsin_v_Color = a_Color;"), "{text}");
        // 顶点段的 varying 声明不再出现（几何段的 out 才是 varying）
        assert!(!text.contains("varying vec3 v_End"), "{text}");
        assert_eq!(text.matches("varying vec4 v_Color;").count(), 1, "{text}");
        // 几何段：IN[0].x → kb_gsin_x
        let body = gs_body(&text);
        assert!(!body.contains("IN["), "{body}");
        assert!(
            body.contains("vec3 start = kb_gs_as_vec3(kb_gsin_gl_Position.xyz);"),
            "{body}"
        );
        assert!(
            body.contains("kb_gs_normalize(kb_gsin_v_End - start)"),
            "{body}"
        );
        assert!(
            body.contains("v.v_Color = kb_gs_as_vec4(kb_gsin_v_Color);"),
            "{body}"
        );
    }

    #[test]
    fn outputs_become_varyings_and_struct_fields() {
        let (text, _) = merged(GS, &[("SUB", "0")]).unwrap();
        // out → varying（gl_Position 去掉），in 整行删掉
        assert!(
            text.contains("varying vec2 v_TexCoord;\nvarying vec4 v_Color;"),
            "{text}"
        );
        assert!(
            !text.contains("out vec4") && !text.contains("in vec"),
            "{text}"
        );
        assert!(
            text.contains("struct PS_INPUT {\n    vec2 v_TexCoord;\n    vec4 v_Color;\n    vec4 kb_Position;\n};\nPS_INPUT kb_gs_selected;"),
            "{text}"
        );
        let body = gs_body(&text);
        assert!(
            body.contains("v.kb_Position = kb_gs_as_vec4(vec4(start - dir, 1.0));"),
            "{body}"
        );
        assert!(!body.contains(".gl_Position"), "{body}");
        // 选中的顶点原样赋给同名 varying
        assert!(text.contains("        gl_Position = kb_gs_selected.kb_Position;\n        v_TexCoord = kb_gs_selected.v_TexCoord;\n        v_Color = kb_gs_selected.v_Color;"), "{text}");
    }

    /// 第 `gl_VertexIndex` 次 `Append` 的顶点是输出：计数从 0 起，先比较再加一；每次 `OUT.Append` 都换成一次调用。
    #[test]
    fn append_selects_the_nth_vertex() {
        let (text, _) = merged(GS, &[("SUB", "0")]).unwrap();
        assert!(text.contains("void kb_gs_append(PS_INPUT v) { if (kb_gs_count == kb_gs_target) { kb_gs_selected = v; kb_gs_hit = true; } kb_gs_count++; }"), "{text}");
        let main = &text[text.rfind("void main()").unwrap()..];
        let order: Vec<_> = [
            "kb_vs_main();",
            "kb_gs_target = int(gl_VertexIndex);",
            "kb_gs_count = 0;",
            "kb_gs_hit = false;",
            "kb_gs_degenerate = false;",
            "kb_gs_main();",
            "if (kb_gs_hit && !kb_gs_degenerate) {",
        ]
        .iter()
        .map(|s| main.find(s).unwrap_or_else(|| panic!("缺 {s}\n{main}")))
        .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{main}");
        let body = gs_body(&text);
        assert_eq!(body.matches("kb_gs_append(v);").count(), 2, "{body}");
        assert!(!body.contains("OUT"), "{body}");
    }

    /// 零向量 normalize：四个重载都置 `kb_gs_degenerate` 并原样返回，main 把整个图元放到裁剪体外；顶点段的 normalize 不动。
    #[test]
    fn zero_normalize_drops_the_primitive() {
        let vs = VS.replace(
            "v_End = a_PositionVec4.xyz;",
            "v_End = normalize(a_PositionVec4.xyz);",
        );
        let (out, _) = merge(
            &lines("<vertex>", &vs),
            &lines("<geometry>", GS),
            &pp_with(&[("SUB", "0")]),
        )
        .unwrap();
        let text = out
            .iter()
            .map(|l| l.code.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("float kb_gs_normalize(float v) { if (v * v == 0.0) { kb_gs_degenerate = true; return v; } return v * inversesqrt(v * v); }"));
        for ty in ["vec2", "vec3", "vec4"] {
            assert!(
                text.contains(&format!("{ty} kb_gs_normalize({ty} v) {{ float d = dot(v, v); if (d == 0.0) {{ kb_gs_degenerate = true; return v; }} return v * inversesqrt(d); }}")),
                "{ty}\n{text}"
            );
        }
        assert!(
            text.contains("kb_gsin_v_End = normalize(a_PositionVec4.xyz);"),
            "{text}"
        );
        let main = &text[text.rfind("void main()").unwrap()..];
        let otherwise = &main[main.find("} else {").unwrap()..];
        assert!(
            otherwise.contains("gl_Position = vec4(2.0, 2.0, 2.0, 1.0);"),
            "{main}"
        );
        assert!(!otherwise.contains("v_Color"), "{main}");
    }

    /// `.geom` 的 `for (int s…) { float s = smoothstep(…); … }`：for 头里的改名，循环体里遮蔽之后的不动。
    #[test]
    fn shadowed_loop_variable_is_renamed() {
        let gs = GS.replace(
            "\tOUT.Append(v);\n}",
            "\tOUT.Append(v);\n\tfor (int s = 0; s < SUB; ++s)\n\t{\n\t\tfloat t = float(s);\n\t\tfloat s = smoothstep(0, 1, t);\n\t\tv.v_TexCoord = vec2(s, s);\n\t\tOUT.Append(v);\n\t}\n\tfor (int k = 0; k < 2; ++k) { v.v_TexCoord = vec2(k); }\n}",
        );
        let (text, count) = merged(&gs, &[("SUB", "3")]).unwrap();
        assert_eq!(count, 10);
        let body = gs_body(&text);
        assert!(
            body.contains("for (int kb_s = 0; kb_s < SUB; ++kb_s)"),
            "{body}"
        );
        assert!(
            body.contains("float t = kb_gs_as_float(float(kb_s));"),
            "{body}"
        );
        assert!(
            body.contains("float s = kb_gs_as_float(smoothstep(0, 1, t));"),
            "{body}"
        );
        assert!(
            body.contains("v.v_TexCoord = kb_gs_as_vec2(vec2(s, s));"),
            "{body}"
        );
        // 没被遮蔽的循环变量不动
        assert!(body.contains("for (int k = 0; k < 2; ++k)"), "{body}");
    }

    #[test]
    fn max_vertex_count_uses_the_final_macros() {
        assert_eq!(merged(GS, &[("SUB", "0")]).unwrap().1, 4);
        assert_eq!(merged(GS, &[("SUB", "16")]).unwrap().1, 36);
        let missing = merged(&GS.replace("[maxvertexcount(4 + SUB * 2)]", ""), &[]).unwrap_err();
        assert_eq!(missing.stage, Stage::Geometry);
        assert!(
            missing.message.contains("maxvertexcount"),
            "{}",
            missing.message
        );
        let twice = merged(
            &GS.replace("void main() {", "[maxvertexcount(4)] void main() {"),
            &[],
        )
        .unwrap_err();
        assert!(twice.message.contains("不止一次"), "{}", twice.message);
        assert_eq!(
            (twice.file.as_deref(), twice.line),
            (Some("<geometry>"), Some(8))
        );
        // 和 main 写在同一行也认
        let inline = GS.replace(
            "[maxvertexcount(4 + SUB * 2)]\nvoid main() {",
            "[maxvertexcount(6)] void main() {",
        );
        let (text, count) = merged(&inline, &[]).unwrap();
        assert_eq!(count, 6);
        assert!(!text.contains("maxvertexcount"));
    }

    #[test]
    fn unsupported_inputs_and_strips_are_errors() {
        let second =
            merged(&GS.replace("IN[0].v_End", "IN[1].v_End"), &[("SUB", "0")]).unwrap_err();
        assert_eq!(second.stage, Stage::Geometry);
        assert!(second.message.contains("IN[1]"), "{}", second.message);
        assert_eq!(second.line, Some(10));
        let restart = merged(
            &GS.replace(
                "\tOUT.Append(v);\n}",
                "\tOUT.Append(v);\n\tOUT.RestartStrip();\n}",
            ),
            &[("SUB", "0")],
        )
        .unwrap_err();
        assert!(
            restart.message.contains("RestartStrip"),
            "{}",
            restart.message
        );
        // in 与顶点段的 varying 对不上
        let mismatch = merged(
            &GS.replace("in vec3 v_End;", "in vec4 v_End;"),
            &[("SUB", "0")],
        )
        .unwrap_err();
        assert!(mismatch.message.contains("v_End"), "{}", mismatch.message);
        let unknown = merged(
            &GS.replace("in vec3 v_End;", "in vec3 v_End;\nin vec2 v_Nope;"),
            &[("SUB", "0")],
        )
        .unwrap_err();
        assert!(unknown.message.contains("v_Nope"), "{}", unknown.message);
    }
}
