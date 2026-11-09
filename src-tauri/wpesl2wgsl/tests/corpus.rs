//! 本机 WPE 语料测试：`KABEGAME_WPE_ROOT` 指向 WPE 安装目录（如
//! `D:\Applications\Steam\steamapps\common\wallpaper_engine`）时才跑，没有就跳过；只读，不写任何 WPE 文件。
//!
//! 1. 门槛：P1 样本（eagleflag / deep_space / beach）用到的着色器对按其材质的 COMBO 与纹理必须翻译通过；
//! 2. 基线：`assets/shaders`、`assets/effects`、`projects/defaultprojects` 下全部着色器对在默认 COMBO
//!    （只绑定 g_Texture0）下的通过率，按失败阶段与首条错误汇总，完整报告写到 `CARGO_TARGET_TMPDIR`。
//!
//! 看汇总：`cargo test -p wpesl2wgsl --test corpus -- --nocapture`

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use wpesl2wgsl::{translate, BoundTexture, TranslateRequest, TranslateResult};

struct Program {
    /// 报告里的名字（相对 WPE 安装目录）。
    name: String,
    vertex: PathBuf,
    fragment: PathBuf,
    /// `#include` 的查找根，依次尝试。
    include_roots: Vec<PathBuf>,
}

fn wpe_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("KABEGAME_WPE_ROOT")?);
    root.join("assets").is_dir().then_some(root)
}

fn read(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()));
    String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

/// `WPESL2WGSL_DUMP_DIR` 设了时，每次成功的翻译把生成的 GLSL / WGSL 写到这个目录（供人工审阅、前后逐字节比较）。
fn dump_dir() -> Option<PathBuf> {
    std::env::var_os("WPESL2WGSL_DUMP_DIR").map(PathBuf::from)
}

/// 把一次成功翻译的输出写进 [`dump_dir`]：`<键>.vert.glsl` / `.vert.wgsl` / `.frag.glsl` / `.frag.wgsl`。
fn dump(key: &str, result: &TranslateResult) {
    let (Some(dir), true) = (dump_dir(), result.ok) else {
        return;
    };
    fs::create_dir_all(&dir).expect("建 dump 目录");
    let key: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.=".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    for (stage, output) in [("vert", &result.vertex), ("frag", &result.fragment)] {
        let Some(output) = output else { continue };
        for (ext, text) in [("glsl", &output.glsl), ("wgsl", &output.wgsl)] {
            if let Some(text) = text {
                fs::write(dir.join(format!("{key}.{stage}.{ext}")), text).expect("写 dump");
            }
        }
    }
}

/// 模拟前端的协议：先不带头文件请求，按 `missing` 补齐后重试。
fn run(program: &Program, combos: &[(&str, i64)], textures: &[(u32, u32)]) -> TranslateResult {
    run_lit(program, combos, textures, &[])
}

/// `lit` 是 `lit_defines`：只在 `LIGHTING` 非 0 时生效的宏。
fn run_lit(
    program: &Program,
    combos: &[(&str, i64)],
    textures: &[(u32, u32)],
    lit: &[(&str, &str)],
) -> TranslateResult {
    run_full(program, false, combos, textures, &[], lit)
}

/// `geometry` 为真时带上与 `.vert` 同名的 `.geom`（几何着色器展开）；`defines` 是请求的额外宏。
fn run_full(
    program: &Program,
    geometry: bool,
    combos: &[(&str, i64)],
    textures: &[(u32, u32)],
    defines: &[(&str, &str)],
    lit: &[(&str, &str)],
) -> TranslateResult {
    let mut request = TranslateRequest {
        vertex: read(&program.vertex),
        fragment: read(&program.fragment),
        geometry: geometry.then(|| read(&program.vertex.with_extension("geom"))),
        defines: defines
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        combos: combos
            .iter()
            .map(|(k, v)| (k.to_string(), (*v).into()))
            .collect(),
        textures: textures
            .iter()
            .map(|(slot, format)| BoundTexture {
                slot: *slot,
                format: Some(*format),
            })
            .collect(),
        lit_defines: lit
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        debug: dump_dir().is_some(),
        ..TranslateRequest::default()
    };
    for _ in 0..16 {
        let result = translate(&request);
        if result.phase != Some("include") {
            return result;
        }
        for name in &result.missing {
            let found = program
                .include_roots
                .iter()
                .map(|root| root.join(name))
                .find(|path| path.is_file());
            let Some(path) = found else { return result };
            request.includes.insert(name.clone(), read(&path));
        }
    }
    translate(&request)
}

/// 目录下（递归）所有带同名 `.frag` 的 `.vert`。
fn pairs(dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            pairs(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "vert") {
            let fragment = path.with_extension("frag");
            if fragment.is_file() {
                out.push((path, fragment));
            }
        }
    }
}

fn collect(root: &Path) -> Vec<Program> {
    let assets_shaders = root.join("assets").join("shaders");
    let mut programs = Vec::new();
    // 内置着色器只取 shaders/ 顶层（HLSL/ 是 DX11 回退，不是方言；base/ 只有头文件）
    let mut builtin = Vec::new();
    for entry in fs::read_dir(&assets_shaders)
        .into_iter()
        .flatten()
        .flatten()
    {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "vert")
            && path.with_extension("frag").is_file()
        {
            builtin.push((path.clone(), path.with_extension("frag")));
        }
    }
    builtin.sort();
    add(&mut programs, root, builtin, &[assets_shaders.clone()]);
    for effect in sorted_dirs(&root.join("assets").join("effects")) {
        let mut found = Vec::new();
        pairs(&effect.join("shaders"), &mut found);
        add(
            &mut programs,
            root,
            found,
            &[effect.join("shaders"), assets_shaders.clone()],
        );
    }
    for project in sorted_dirs(&root.join("projects").join("defaultprojects")) {
        let mut found = Vec::new();
        pairs(&project.join("shaders"), &mut found);
        add(
            &mut programs,
            root,
            found,
            &[project.join("shaders"), assets_shaders.clone()],
        );
    }
    programs
}

fn add(
    programs: &mut Vec<Program>,
    root: &Path,
    found: Vec<(PathBuf, PathBuf)>,
    include_roots: &[PathBuf],
) {
    for (vertex, fragment) in found {
        let name = vertex
            .strip_prefix(root)
            .unwrap_or(&vertex)
            .with_extension("")
            .display()
            .to_string();
        programs.push(Program {
            name,
            vertex,
            fragment,
            include_roots: include_roots.to_vec(),
        });
    }
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

fn summary(result: &TranslateResult) -> String {
    let phase = result.phase.unwrap_or("?");
    let stage = result
        .stage
        .map(|s| format!("{s:?}").to_lowercase())
        .unwrap_or_default();
    let detail = if !result.missing.is_empty() {
        format!("missing {:?}", result.missing)
    } else if !result.requires.is_empty() {
        format!("requires {:?}", result.requires)
    } else {
        result
            .errors
            .first()
            .map(|e| e.message.clone())
            .unwrap_or_default()
    };
    format!("{phase} {stage}: {detail}")
}

fn program<'a>(programs: &'a [Program], name: &str) -> &'a Program {
    let name = name.replace('/', std::path::MAIN_SEPARATOR_STR);
    programs
        .iter()
        .find(|p| p.name == name)
        .unwrap_or_else(|| panic!("语料里没有 {name}"))
}

#[test]
fn corpus() {
    let Some(root) = wpe_root() else {
        eprintln!("跳过：未设置 KABEGAME_WPE_ROOT（WPE 安装目录）");
        return;
    };
    let programs = collect(&root);

    // 1. 门槛：P1 样本按材质实际的 COMBO 与纹理（格式取样本里的 DXT5 / RGBA8888）
    let gates: &[(&str, &[(&str, i64)], &[(u32, u32)])] = &[
        (
            "assets/shaders/flag",
            &[("TINT", 1)],
            &[(0, 4), (1, 4), (2, 4)],
        ),
        ("assets/shaders/genericimage", &[], &[(0, 4)]),
        (
            "projects/defaultprojects/deep_space/shaders/flowimage",
            &[],
            &[(0, 0), (1, 4), (2, 4), (3, 4)],
        ),
        (
            "projects/defaultprojects/beach/shaders/flowimage",
            &[],
            &[(0, 4), (1, 0)],
        ),
        (
            "projects/defaultprojects/beach/shaders/swayimage",
            &[],
            &[(0, 4), (1, 0)],
        ),
    ];
    let mut gate_failures = Vec::new();
    for (name, combos, textures) in gates {
        let result = run(program(&programs, name), combos, textures);
        dump(&format!("gate__{name}"), &result);
        if !result.ok {
            let glsl = result
                .fragment
                .as_ref()
                .or(result.vertex.as_ref())
                .and_then(|o| o.glsl.clone())
                .unwrap_or_default();
            gate_failures.push(format!("{name}: {}\n{glsl}", summary(&result)));
        }
    }

    // 1b. 门槛：`#require LightingV1` 带四种灯，走真实的 common_pbr_2.h（默认 COMBO 下灯数为 0，覆盖不到循环）
    let lit: &[(&str, &str)] = &[
        ("LIGHTS_POINT", "2"),
        ("LIGHTS_SPOT", "2"),
        ("LIGHTS_TUBE", "1"),
        ("LIGHTS_DIRECTIONAL", "2"),
    ];
    let mut lit_failures = Vec::new();
    for name in [
        "assets/shaders/genericimage4",
        "assets/shaders/genericparticle",
        "assets/shaders/genericropeparticle",
        "assets/shaders/generic4",
        "assets/shaders/foliage4",
        "assets/shaders/chroma4",
        "assets/shaders/fur4",
    ] {
        let hdr: &[(&str, &str)] = &[("HDR", "1")];
        for extra in [&[][..], hdr] {
            let defines: Vec<_> = lit.iter().chain(extra).copied().collect();
            let result = run_lit(
                program(&programs, name),
                &[("LIGHTING", 1)],
                // fur4 的毛发图在槽 8，头文件里按 TEX8FORMAT 分支
                &[(0, 0), (8, 0)],
                &defines,
            );
            dump(&format!("lit__{name}__hdr{}", extra.len()), &result);
            let wgsl = result
                .fragment
                .as_ref()
                .and_then(|o| o.wgsl.as_deref())
                .unwrap_or_default();
            if !result.ok || reparse_wgsl(wgsl).is_err() || !wgsl.contains("g_LSpot_Direction") {
                lit_failures.push(format!("{name}: {}", summary(&result)));
            }
        }
    }
    assert!(lit_failures.is_empty(), "{lit_failures:#?}");

    // 1c. 门槛：几何着色器展开。genericropeparticle 带 .geom（GS_ENABLED 分支 + 几何着色器拼成一个顶点着色器），
    //     翻译通过、两段 WGSL 回读通过、maxVertices = 4 + 2·TRAILSUBDIVISION。宏照宿主的写法经 defines 传。
    let geometry_failures = geometry_gates(&programs);
    assert!(geometry_failures.is_empty(), "{geometry_failures:#?}");

    // 2. 基线：全部着色器对、默认 COMBO
    let mut ok = 0;
    let mut reparse_failures = Vec::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_error: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut report = String::new();
    for program in &programs {
        let result = run(program, &[], &[(0, 0)]);
        dump(&format!("base__{}", program.name), &result);
        if result.ok {
            ok += 1;
            report.push_str(&format!("ok   {}\n", program.name));
            for (stage, output) in [("vertex", &result.vertex), ("fragment", &result.fragment)] {
                let wgsl = output
                    .as_ref()
                    .and_then(|o| o.wgsl.as_deref())
                    .unwrap_or_default();
                if let Err(error) = reparse_wgsl(wgsl) {
                    reparse_failures.push(format!("{} {stage}: {error}", program.name));
                }
            }
            continue;
        }
        let line = summary(&result);
        *by_phase
            .entry(result.phase.unwrap_or("?").to_string())
            .or_default() += 1;
        let key: String = line.chars().take(110).collect();
        by_error.entry(key).or_default().push(program.name.clone());
        report.push_str(&format!("FAIL {} — {line}\n", program.name));
    }
    let total = programs.len();
    let mut out = format!(
        "wpesl2wgsl 语料：{ok}/{total} 通过（{:.1}%）\n按阶段：{by_phase:?}\n首条错误（次数 / 示例）：\n",
        ok as f64 * 100.0 / total.max(1) as f64
    );
    out.push_str(&format!(
        "WGSL 回读（naga wgsl-in 重新解析 + 校验）失败：{}\n",
        reparse_failures.len()
    ));
    for failure in reparse_failures.iter().take(10) {
        out.push_str(&format!("  {failure}\n"));
    }
    let mut errors: Vec<_> = by_error.into_iter().collect();
    errors.sort_by_key(|(_, names)| std::cmp::Reverse(names.len()));
    for (error, names) in errors.iter().take(25) {
        out.push_str(&format!(
            "  {:>3}  {error}  例：{}\n",
            names.len(),
            names[0]
        ));
    }
    let report_path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("wpesl2wgsl-corpus.txt");
    fs::write(&report_path, format!("{out}\n{report}")).expect("写报告");
    println!("{out}完整报告：{}", report_path.display());

    assert!(
        gate_failures.is_empty(),
        "P1 门槛未通过：\n{}",
        gate_failures.join("\n\n")
    );
    assert!(
        reparse_failures.is_empty(),
        "输出的 WGSL 回读失败：\n{}",
        reparse_failures.join("\n")
    );
}

/// 几何着色器展开的门槛组合，返回失败项。
/// - rope：`THICKFORMAT 1`，`TRAILSUBDIVISION` 0 / 3 / 4 / 16 / 32 × `ORIENTATION` 0 / 1 / 2；
/// - ropetrail：`TRAILRENDERER 1`，`TRAILSUBDIVISION` 0 / 1 / 2，以及 `TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE` 全开；
/// - rope 与 ropetrail 再各加一组 `REFRACT`（绑法线图与 `_rt_FullFrameBuffer`）、`FOG_DIST`、`LIGHTING`（一盏点光）。
fn geometry_gates(programs: &[Program]) -> Vec<String> {
    let rope = program(programs, "assets/shaders/genericropeparticle");
    struct Gate {
        key: String,
        combos: Vec<(&'static str, i64)>,
        textures: Vec<(u32, u32)>,
        defines: Vec<(&'static str, String)>,
        lit: Vec<(&'static str, &'static str)>,
        subdivision: u32,
    }
    let gate = |key: String, defines: Vec<(&'static str, String)>, subdivision: u32| Gate {
        key,
        combos: Vec::new(),
        textures: vec![(0, 0)],
        defines,
        lit: Vec::new(),
        subdivision,
    };
    let mut gates = Vec::new();
    for subdivision in [0u32, 3, 4, 16, 32] {
        for orientation in 0..3 {
            gates.push(gate(
                format!("rope__sub{subdivision}__ori{orientation}"),
                vec![
                    ("THICKFORMAT", "1".into()),
                    ("TRAILSUBDIVISION", subdivision.to_string()),
                    ("ORIENTATION", orientation.to_string()),
                ],
                subdivision,
            ));
        }
    }
    for subdivision in [0u32, 1, 2] {
        gates.push(gate(
            format!("ropetrail__sub{subdivision}"),
            vec![
                ("TRAILRENDERER", "1".into()),
                ("TRAILSUBDIVISION", subdivision.to_string()),
            ],
            subdivision,
        ));
        gates.push(gate(
            format!("ropetrail__sub{subdivision}__scroll_fade"),
            vec![
                ("TRAILRENDERER", "1".into()),
                ("TRAILSUBDIVISION", subdivision.to_string()),
                ("TRAILSCROLLALPHA", "1".into()),
                ("TRAILFADEALPHA", "1".into()),
                ("TRAILFADESIZE", "1".into()),
            ],
            subdivision,
        ));
    }
    for (kind, base, subdivision) in [
        ("rope", ("THICKFORMAT", "1"), 3u32),
        ("ropetrail", ("TRAILRENDERER", "1"), 1),
    ] {
        let defines = |extra: Option<(&'static str, &str)>| {
            let mut defines = vec![
                (base.0, base.1.to_string()),
                ("TRAILSUBDIVISION", subdivision.to_string()),
            ];
            defines.extend(extra.map(|(k, v)| (k, v.to_string())));
            defines
        };
        let mut refract = gate(format!("{kind}__refract"), defines(None), subdivision);
        refract.combos = vec![("REFRACT", 1)];
        refract.textures = vec![(0, 0), (1, 0), (3, 0)];
        gates.push(refract);
        gates.push(gate(
            format!("{kind}__fog_dist"),
            defines(Some(("FOG_DIST", "1"))),
            subdivision,
        ));
        let mut lit = gate(format!("{kind}__lighting"), defines(None), subdivision);
        lit.combos = vec![("LIGHTING", 1)];
        lit.lit = vec![("LIGHTS_POINT", "1")];
        gates.push(lit);
    }

    let mut failures = Vec::new();
    for gate in &gates {
        let defines: Vec<(&str, &str)> =
            gate.defines.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let result = run_full(
            rope,
            true,
            &gate.combos,
            &gate.textures,
            &defines,
            &gate.lit,
        );
        dump(&format!("geom__{}", gate.key), &result);
        if !result.ok {
            let glsl = result
                .vertex
                .as_ref()
                .or(result.fragment.as_ref())
                .and_then(|o| o.glsl.clone())
                .unwrap_or_default();
            failures.push(format!("{}: {}\n{glsl}", gate.key, summary(&result)));
            continue;
        }
        let expected = 4 + 2 * gate.subdivision;
        let max_vertices = result.geometry.as_ref().map(|g| g.max_vertices);
        if max_vertices != Some(expected) {
            failures.push(format!(
                "{}: maxVertices {max_vertices:?}，应为 {expected}",
                gate.key
            ));
        }
        for (stage, output) in [("vertex", &result.vertex), ("fragment", &result.fragment)] {
            let wgsl = output
                .as_ref()
                .and_then(|o| o.wgsl.as_deref())
                .unwrap_or_default();
            if let Err(error) = reparse_wgsl(wgsl) {
                failures.push(format!("{} {stage} WGSL 回读：{error}", gate.key));
            }
            if stage == "vertex" && !wgsl.contains("@builtin(vertex_index)") {
                failures.push(format!("{} 顶点 WGSL 没有用 vertex_index", gate.key));
            }
        }
    }
    println!(
        "几何着色器展开门槛：{}/{} 通过",
        gates.len() - failures.len(),
        gates.len()
    );
    failures
}

/// 输出的 WGSL 能否被 naga 自己的 WGSL 前端重新接受（抓写出端的问题；浏览器 Tint 的校验要真机验证）。
fn reparse_wgsl(wgsl: &str) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(wgsl).map_err(|e| e.emit_to_string(wgsl))?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}
