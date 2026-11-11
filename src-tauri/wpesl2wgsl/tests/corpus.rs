//! 本机 WPE 语料测试：`KABEGAME_WPE_ROOT` 指向 WPE 安装目录（如
//! `D:\Applications\Steam\steamapps\common\wallpaper_engine`）时才跑 1、2，没有就跳过；只读，不写任何 WPE 文件。
//!
//! 1. 门槛：P1 样本（eagleflag / deep_space / beach）用到的着色器对按其材质的 COMBO 与纹理必须翻译通过；
//! 2. 基线：`assets/shaders`、`assets/effects`、`projects/defaultprojects` 下全部着色器对在默认 COMBO
//!    （只绑定 g_Texture0）下的通过率，按失败阶段与首条错误汇总，完整报告写到 `CARGO_TARGET_TMPDIR`。
//! 3. 请求夹具（P7a）：`WPESL2WGSL_REQUESTS` 指向 `kbp corpus scan --extra requests:<目录>` 录下的夹具目录时，逐个重放
//!    编译管线真实发出的请求；`ok` 必须和夹具里记录的（前端 wasm 的结果）一致。没设就跳过。
//!    例外：夹具记录失败、重放通过，且键（`<名字>-<sha1 前 8 位>`）在 `WPESL2WGSL_BASELINE_ALLOW` 里的，只列出不算失败
//!    （夹具是改动前录的，本步预期新通过的请求）；反过来记录通过、重放失败的，要列在单独的
//!    `WPESL2WGSL_BASELINE_ALLOW_REGRESS` 里才不算失败（预期的退步，必须刻意列出）。
//!
//! 逐字节基线：`WPESL2WGSL_BASELINE_DIR` 指向一份旧的导出目录（`WPESL2WGSL_DUMP_DIR` 导出的）时，本次导出逐文件和它比较，
//! 「变了」「新失败」非空时失败，`WPESL2WGSL_BASELINE_ALLOW`（逗号分隔的键前缀）列出的除外。
//! 环境变量里的相对路径按仓库根解析（cargo test 的工作目录是本 crate）。
//!
//! 看汇总：`cargo test -p wpesl2wgsl --test corpus -- --nocapture`

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
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

/// 环境变量里的路径；相对路径按仓库根（工作区根）解析，因为 cargo test 的工作目录是本 crate 而不是调用处。
fn env_path(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name).filter(|v| !v.is_empty())?);
    if path.is_absolute() {
        return Some(path);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("仓库根");
    Some(root.join(path))
}

/// 导出目录：`WPESL2WGSL_DUMP_DIR` 设了时，每次成功的翻译把生成的 GLSL / WGSL 写到这个目录（供人工审阅、前后逐字节比较）。
/// 没设而设了 `WPESL2WGSL_BASELINE_DIR` 时导出到 `CARGO_TARGET_TMPDIR` 下的临时目录（先清空）：基线比较要用本次导出。
fn dump_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if let Some(dir) = env_path("WPESL2WGSL_DUMP_DIR") {
            return Some(dir);
        }
        env_path("WPESL2WGSL_BASELINE_DIR")?;
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("wpesl2wgsl-dump");
        let _ = fs::remove_dir_all(&dir);
        Some(dir)
    })
    .as_deref()
}

/// 本次导出写过的文件名与写的次数。基线比较只看本次写过的文件（导出目录里残留的旧文件不算）；写了不止一次说明两个键
/// 规整后撞名，报告里列出来。
fn dumped() -> &'static Mutex<BTreeMap<String, usize>> {
    static WRITTEN: OnceLock<Mutex<BTreeMap<String, usize>>> = OnceLock::new();
    WRITTEN.get_or_init(Default::default)
}

/// 导出文件名里的键：字母数字与 `-_.=` 以外的字符换成 `_`。
fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.=".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 把一次成功翻译的输出写进 [`dump_dir`]：`<键>.vert.glsl` / `.vert.wgsl` / `.frag.glsl` / `.frag.wgsl`。
fn dump(key: &str, result: &TranslateResult) {
    let (Some(dir), true) = (dump_dir(), result.ok) else {
        return;
    };
    fs::create_dir_all(dir).expect("建 dump 目录");
    let key = sanitize(key);
    let mut written = dumped().lock().unwrap();
    for (stage, output) in [("vert", &result.vertex), ("frag", &result.fragment)] {
        let Some(output) = output else { continue };
        for (ext, text) in [("glsl", &output.glsl), ("wgsl", &output.wgsl)] {
            if let Some(text) = text {
                let file = format!("{key}.{stage}.{ext}");
                fs::write(dir.join(&file), text).expect("写 dump");
                *written.entry(file).or_default() += 1;
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
    // 各部分的失败先攒着，全部报告打完再一起断言（1b、1c 的门槛照旧当场断言）
    let mut failures: Vec<String> = Vec::new();
    match wpe_root() {
        Some(root) => installed(&root, &mut failures),
        None => eprintln!("跳过 1、2：未设置 KABEGAME_WPE_ROOT（WPE 安装目录）"),
    }
    match env_path("WPESL2WGSL_REQUESTS") {
        Some(dir) => requests(&dir, &mut failures),
        None => eprintln!(
            "跳过 3：未设置 WPESL2WGSL_REQUESTS（请求夹具目录，kbp corpus scan --extra requests:<目录>）"
        ),
    }
    if let Some(dir) = env_path("WPESL2WGSL_BASELINE_DIR") {
        baseline(&dir, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// 1、2：WPE 安装目录里的着色器对。
fn installed(root: &Path, failures: &mut Vec<String>) {
    let programs = collect(root);

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

    if !gate_failures.is_empty() {
        failures.push(format!("P1 门槛未通过：\n{}", gate_failures.join("\n\n")));
    }
    if !reparse_failures.is_empty() {
        failures.push(format!(
            "输出的 WGSL 回读失败：\n{}",
            reparse_failures.join("\n")
        ));
    }
}

/// 夹具文件 `<sha1>.json`（`kbp corpus scan --extra requests:<目录>` 写的）。
#[derive(Deserialize)]
struct Fixture {
    /// 着色器名（同产品 `shader:<名>:…`），反查不到是 `?`；同一请求出自几个名字时是 `names` 的第一个。
    name: String,
    /// 编译时用这个请求的全部着色器名（工坊包常把同一个 effect 拷到不同目录）。
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    scenes: Vec<String>,
    /// 前端 wasm 当时的结果。
    result: FixtureResult,
    request: TranslateRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureResult {
    ok: bool,
    phase: Option<String>,
    first_error: Option<String>,
}

/// 失败结果的全部信息：阶段、所在着色器、缺的头文件 / 库、全部诊断（带位置）。
fn full_errors(result: &TranslateResult) -> String {
    let mut out = format!(
        "{} {}",
        result.phase.unwrap_or("?"),
        result
            .stage
            .map(|s| format!("{s:?}").to_lowercase())
            .unwrap_or_default()
    );
    if !result.missing.is_empty() {
        out.push_str(&format!("\n    missing {:?}", result.missing));
    }
    if !result.requires.is_empty() {
        out.push_str(&format!("\n    requires {:?}", result.requires));
    }
    for error in &result.errors {
        let at = match (&error.file, error.line) {
            (file, Some(line)) => format!(
                "{}{line}:{} ",
                file.as_deref().map(|f| format!("{f}:")).unwrap_or_default(),
                error.column.unwrap_or(0)
            ),
            (Some(file), None) => format!("{file} "),
            _ => String::new(),
        };
        out.push_str(&format!(
            "\n    {at}{}",
            error.message.replace('\n', "\n      ")
        ));
    }
    out
}

/// 3：重放请求夹具。成功的回读校验并按 `<名字>-<sha1 前 8 位>` 导出；`ok` 与夹具记录的不一致算失败。
fn requests(dir: &Path, failures: &mut Vec<String>) {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("读夹具目录 {} 失败：{e}", dir.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    #[derive(Default)]
    struct Shader {
        ok: usize,
        failed: Vec<String>,
    }
    let mut by_name: BTreeMap<String, Shader> = BTreeMap::new();
    // 全部名字（含别名）与其中失败过的：和语料扫描 `shader:<名>:…` 键的名字集合对照
    let (mut all_names, mut failed_all) = (BTreeSet::new(), BTreeSet::new());
    let (mut mismatches, mut allowed_mismatches) = (Vec::new(), Vec::new());
    let mut reparse_failures = Vec::new();
    let mut ok = 0;
    for file in &files {
        let sha = file.file_stem().unwrap().to_string_lossy().to_string();
        let short = &sha[..sha.len().min(8)];
        let fixture: Fixture = serde_json::from_str(&read(file))
            .unwrap_or_else(|e| panic!("夹具 {} 解析失败：{e}", file.display()));
        let mut request = fixture.request;
        request.debug = dump_dir().is_some();
        let result = translate(&request);
        let shader = by_name.entry(fixture.name.clone()).or_default();
        let aliases: Vec<&String> = fixture
            .names
            .iter()
            .filter(|n| **n != fixture.name)
            .collect();
        all_names.extend(fixture.names.iter().cloned());
        all_names.insert(fixture.name.clone());
        if !result.ok {
            failed_all.extend(fixture.names.iter().cloned());
            failed_all.insert(fixture.name.clone());
        }
        if result.ok != fixture.result.ok {
            // 夹具录的是改动前的结果：本步预期新通过、且列在 ALLOW 里的请求只列出，不算失败；
            // 预期从通过变失败的（P7b 起，依赖后续步骤才能再通过）要单独列进 ALLOW_REGRESS
            let key = sanitize(&format!("{}-{short}", fixture.name));
            let expected = if result.ok {
                baseline_allowed(&key)
            } else {
                regress_allowed(&key)
            };
            let list = if expected {
                &mut allowed_mismatches
            } else {
                &mut mismatches
            };
            list.push(format!(
                "{} {short}：夹具 ok={}（{} {}），重放 ok={}（{}）",
                fixture.name,
                fixture.result.ok,
                fixture.result.phase.as_deref().unwrap_or("-"),
                fixture.result.first_error.as_deref().unwrap_or(""),
                result.ok,
                summary(&result)
            ));
        }
        if result.ok {
            ok += 1;
            shader.ok += 1;
            for (stage, output) in [("vertex", &result.vertex), ("fragment", &result.fragment)] {
                let wgsl = output
                    .as_ref()
                    .and_then(|o| o.wgsl.as_deref())
                    .unwrap_or_default();
                if let Err(error) = reparse_wgsl(wgsl) {
                    reparse_failures.push(format!("{} {short} {stage}: {error}", fixture.name));
                }
            }
            dump(&format!("{}-{short}", fixture.name), &result);
        } else {
            let aliases = if aliases.is_empty() {
                String::new()
            } else {
                format!("，也叫 {aliases:?}")
            };
            shader.failed.push(format!(
                "FAIL {short}（{} 个场景：{}{aliases}）{}",
                fixture.scenes.len(),
                fixture.scenes.join(","),
                full_errors(&result)
            ));
        }
    }
    let failed_names: Vec<_> = by_name
        .iter()
        .filter(|(_, s)| !s.failed.is_empty())
        .collect();
    let mut out = format!(
        "请求夹具：{} 个请求（{} 个着色器，含别名 {}），通过 {ok}、失败 {}；失败的着色器 {} 个（含别名 {}）；ok 与夹具不一致 {}（另有 ALLOW 内的预期变化 {}）；WGSL 回读失败 {}\n",
        files.len(),
        by_name.len(),
        all_names.len(),
        files.len() - ok,
        failed_names.len(),
        failed_all.len(),
        mismatches.len(),
        allowed_mismatches.len(),
        reparse_failures.len()
    );
    for (name, shader) in &failed_names {
        // 第一条失败的首条诊断（第 1 行是 FAIL 头，第 2 行起是错误）
        let first = shader.failed[0].lines().nth(1).unwrap_or("").trim();
        out.push_str(&format!(
            "  {name}  失败 {}/{}  {}\n",
            shader.failed.len(),
            shader.failed.len() + shader.ok,
            first.chars().take(110).collect::<String>()
        ));
    }
    for line in mismatches.iter().chain(&reparse_failures) {
        out.push_str(&format!("  {line}\n"));
    }
    for line in &allowed_mismatches {
        out.push_str(&format!("  {line}（允许）\n"));
    }
    let mut report = String::new();
    for (name, shader) in &by_name {
        report.push_str(&format!(
            "== {name}（通过 {} / 共 {}）\n",
            shader.ok,
            shader.ok + shader.failed.len()
        ));
        for failure in &shader.failed {
            report.push_str(&format!("  {failure}\n"));
        }
    }
    let report_path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("wpesl2wgsl-requests.txt");
    fs::write(&report_path, format!("{out}\n{report}")).expect("写报告");
    println!(
        "{out}完整报告（每条失败的全部错误）：{}",
        report_path.display()
    );

    if !mismatches.is_empty() {
        failures.push(format!(
            "请求夹具重放的 ok 与夹具记录的不一致：\n{}",
            mismatches.join("\n")
        ));
    }
    if !reparse_failures.is_empty() {
        failures.push(format!(
            "请求夹具输出的 WGSL 回读失败：\n{}",
            reparse_failures.join("\n")
        ));
    }
}

/// `WPESL2WGSL_BASELINE_ALLOW` 是否列出了这个键（导出文件名或 `<名字>-<sha1 前 8 位>`）。
/// 键前缀按导出文件名的规则规整，`effects/foo` 与 `effects_foo` 都能写。
fn baseline_allowed(key: &str) -> bool {
    static ALLOW: OnceLock<Vec<String>> = OnceLock::new();
    ALLOW
        .get_or_init(|| {
            std::env::var("WPESL2WGSL_BASELINE_ALLOW")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(sanitize)
                .collect()
        })
        .iter()
        .any(|p| key.starts_with(p.as_str()))
}

/// `WPESL2WGSL_BASELINE_ALLOW_REGRESS` 是否列出了这个键：夹具记录通过、重放失败的请求只有列在这里才不算失败。
/// 和 `WPESL2WGSL_BASELINE_ALLOW` 分开，退步必须单独、刻意地列出（P7b 起：照 WPE 改规则后，有的着色器要等后续步骤才能再通过）。
fn regress_allowed(key: &str) -> bool {
    static ALLOW: OnceLock<Vec<String>> = OnceLock::new();
    ALLOW
        .get_or_init(|| {
            std::env::var("WPESL2WGSL_BASELINE_ALLOW_REGRESS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(sanitize)
                .collect()
        })
        .iter()
        .any(|p| key.starts_with(p.as_str()))
}

/// 逐字节基线：本次导出（本次写过的文件）和旧导出目录逐文件比较。
fn baseline(dir: &Path, failures: &mut Vec<String>) {
    let current_dir = dump_dir().expect("设了 WPESL2WGSL_BASELINE_DIR 就有导出目录");
    let written = dumped().lock().unwrap().clone();
    let old: BTreeSet<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("读基线目录 {} 失败：{e}", dir.display()))
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    let allowed = baseline_allowed;
    let mut same = 0;
    let (mut changed, mut new_pass, mut new_fail) = (Vec::new(), Vec::new(), Vec::new());
    for file in written.keys() {
        if !old.contains(file) {
            new_pass.push(file.clone());
        } else if fs::read(current_dir.join(file)).ok() == fs::read(dir.join(file)).ok() {
            same += 1;
        } else {
            changed.push(file.clone());
        }
    }
    for file in &old {
        if !written.contains_key(file) {
            new_fail.push(file.clone());
        }
    }
    let duplicated: Vec<_> = written
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(f, n)| format!("{f}（{n} 次）"))
        .collect();
    let mark = |file: &String| {
        if allowed(file) {
            format!("{file}（允许）")
        } else {
            file.clone()
        }
    };
    let mut out = format!(
        "逐字节基线（{}）：相同 {same}、变了 {}、新通过 {}、新失败 {}（本次 {} 个文件，基线 {} 个）\n",
        dir.display(),
        changed.len(),
        new_pass.len(),
        new_fail.len(),
        written.len(),
        old.len()
    );
    let mut report = String::new();
    for (label, list) in [
        ("变了", &changed),
        ("新通过", &new_pass),
        ("新失败（基线有、本次没有）", &new_fail),
    ] {
        if list.is_empty() {
            continue;
        }
        out.push_str(&format!("{label}：\n"));
        report.push_str(&format!("{label}：\n"));
        for (i, file) in list.iter().enumerate() {
            if i < 50 {
                out.push_str(&format!("  {}\n", mark(file)));
            }
            report.push_str(&format!("  {}\n", mark(file)));
        }
        if list.len() > 50 {
            out.push_str(&format!("  ……共 {} 个\n", list.len()));
        }
    }
    if !duplicated.is_empty() {
        out.push_str(&format!(
            "本次导出撞名（同一文件写了不止一次）：{duplicated:?}\n"
        ));
    }
    let report_path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("wpesl2wgsl-baseline.txt");
    fs::write(&report_path, format!("{out}\n{report}")).expect("写报告");
    println!(
        "{out}完整清单：{}；本次导出：{}",
        report_path.display(),
        current_dir.display()
    );

    let blocking: Vec<_> = changed
        .iter()
        .filter(|f| !allowed(f))
        .map(|f| format!("变了 {f}"))
        .chain(
            new_fail
                .iter()
                .filter(|f| !allowed(f))
                .map(|f| format!("新失败 {f}")),
        )
        .collect();
    if !blocking.is_empty() {
        failures.push(format!(
            "逐字节基线不一致（WPESL2WGSL_BASELINE_ALLOW 以外）：\n{}",
            blocking.join("\n")
        ));
    }
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
