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

/// 模拟前端的协议：先不带头文件请求，按 `missing` 补齐后重试。
fn run(program: &Program, combos: &[(&str, i64)], textures: &[(u32, u32)]) -> TranslateResult {
    let mut request = TranslateRequest {
        vertex: read(&program.vertex),
        fragment: read(&program.fragment),
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

    // 2. 基线：全部着色器对、默认 COMBO
    let mut ok = 0;
    let mut reparse_failures = Vec::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_error: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut report = String::new();
    for program in &programs {
        let result = run(program, &[], &[(0, 0)]);
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
