use std::path::{Path, PathBuf};

use pathql_rs::{Json5Loader, Loader, ProviderDef, ProviderRegistry, Source};

pub const PROVIDER_FILE_EXTENSIONS: &[&str] = &["json", "json5"];

// Keep this list aligned with kabegame-core's embedded DSL loader. These files
// live under the DSL root but are not provider definitions.
pub const EXCLUDED_DSL_FILES: &[&str] = &[
    "schema.json5",
    "gallery/all_router/x_page_x/gallery_page_router.json5",
];

pub fn providers_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("kabegame-core")
        .join("src")
        .join("providers")
        .join("dsl")
}

pub fn relative_provider_path(path: &Path) -> String {
    let root = providers_dir();
    let rel = path.strip_prefix(&root).unwrap_or(path);
    rel.components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn provider_file_paths() -> Vec<PathBuf> {
    let root = providers_dir();
    let mut paths = Vec::new();
    collect_provider_files(&root, &root, &mut paths);
    paths.sort_by_key(|path| relative_provider_path(path));
    paths
}

pub fn build_real_registry() -> ProviderRegistry {
    let mut registry = ProviderRegistry::new();

    for path in provider_file_paths() {
        let rel = relative_provider_path(&path);
        let def = load_provider_for_phase1(&path).unwrap_or_else(|e| panic!("load {}: {}", rel, e));
        registry
            .register(def)
            .unwrap_or_else(|e| panic!("register {}: {}", rel, e));
    }

    registry
}

pub fn load_provider_for_phase1(path: &Path) -> Result<ProviderDef, pathql_rs::LoadError> {
    let raw = std::fs::read_to_string(path).map_err(|source| pathql_rs::LoadError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Json5Loader.load(Source::Str(&strip_legacy_from_fields(&raw)))
}

pub fn strip_legacy_from_fields(raw: &str) -> String {
    raw.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("\"from\"") && trimmed.contains(':'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_provider_files(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read DSL dir {}: {}", dir.display(), e));
    for entry in entries {
        let entry = entry.unwrap_or_else(|e| panic!("read DSL dir entry: {}", e));
        let path = entry.path();
        if path.is_dir() {
            collect_provider_files(&path, root, out);
        } else if is_provider_file(&path, root) {
            out.push(path);
        }
    }
}

fn is_provider_file(path: &Path, root: &Path) -> bool {
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    !EXCLUDED_DSL_FILES
        .iter()
        .any(|excluded| rel.eq_ignore_ascii_case(excluded))
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|got| {
                PROVIDER_FILE_EXTENSIONS
                    .iter()
                    .any(|ext| got.eq_ignore_ascii_case(ext))
            })
            .unwrap_or(false)
}
