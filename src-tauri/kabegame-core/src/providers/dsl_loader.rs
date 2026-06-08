//! DSL 加载: 用 [`include_dir!`] 把 `core/src/providers/dsl/**/*.json5` 编进二进制,
//! 启动期递归扫描嵌入目录, 依次喂给 pathql-rs 的 runtime 动态注册接口。
//!
//! 启用 `validate` feature 时, 注册完后跑一次 [`pathql_rs::validate::validate`]
//! 做交叉引用 / SQL 形态体检, 失败直接 panic — DSL 是源码资产, 启动期就该挂。

use include_dir::{include_dir, Dir, DirEntry, File};
use pathql_rs::{validate::ValidateConfig, LoaderType, ProviderRuntime, Source};
use std::path::Path;

/// Provider DSL files supported inside plugin `providers/` directories.
pub const PROVIDER_FILE_EXTENSIONS: &[&str] = &["json", "json5"];

pub fn is_provider_file_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with("providers/")
        && PROVIDER_FILE_EXTENSIONS.iter().any(|ext| {
            normalized
                .rsplit_once('.')
                .map(|(_, got)| got.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
}

/// 编译期嵌入的 DSL 资产根。布局必须与 `core/src/providers/dsl/` 同构。
pub static DSL_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/src/providers/dsl");

pub const EXCLUDED_DSL_FILES: &[&str] = &[
    "schema.json5",
    // Legacy shim kept on disk for compatibility notes; shared/query_page_provider.json5
    // is the canonical provider definition and has the same provider name.
    "gallery/all_router/x_page_x/gallery_page_router.json5",
];

fn is_excluded_embedded_dsl_file(path: &str) -> bool {
    EXCLUDED_DSL_FILES
        .iter()
        .any(|excluded| path.eq_ignore_ascii_case(excluded))
}

fn is_embedded_dsl_file(path: &Path) -> bool {
    let Some(path) = path.to_str() else {
        return false;
    };
    !is_excluded_embedded_dsl_file(path)
        && PROVIDER_FILE_EXTENSIONS.iter().any(|ext| {
            path.rsplit_once('.')
                .map(|(_, got)| got.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
}

fn collect_embedded_dsl_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<&'a File<'a>>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::Dir(child) => collect_embedded_dsl_files(child, out),
            DirEntry::File(file) if is_embedded_dsl_file(file.path()) => out.push(file),
            DirEntry::File(_) => {}
        }
    }
}

fn embedded_dsl_files() -> Vec<&'static File<'static>> {
    let mut files = Vec::new();
    collect_embedded_dsl_files(&DSL_DIR, &mut files);
    files
}

/// 把所有内置 DSL 文件动态注册进 runtime。
pub fn register_embedded_dsl(runtime: &ProviderRuntime) {
    for file in embedded_dsl_files() {
        let rel = file.path().display();
        let bytes = file.contents();
        runtime
            .register_provider_dsl(LoaderType::JSON5, Source::Bytes(bytes))
            .unwrap_or_else(|e| panic!("register DSL `{}` failed: {}", rel, e));
    }
}

/// 启动期 sanity: 跑一次完整 validate。失败直接 panic, 让构建立刻挂。
/// Phase 7c 后 core 内置 provider 已全量 DSL 化; 这里仍沿用默认配置, 只检查
/// reserved / SQL shape 等本地约束。跨引用严格模式留给后续第三方 DSL namespace
/// 装载策略一起开启。
pub fn validate_dsl(runtime: &ProviderRuntime) {
    let cfg = ValidateConfig::with_default_reserved();
    if let Err(errs) = runtime.validate(&cfg) {
        for e in &errs {
            eprintln!("[DSL validate] {}", e);
        }
        panic!("DSL validation failed ({} errors)", errs.len());
    }
}
