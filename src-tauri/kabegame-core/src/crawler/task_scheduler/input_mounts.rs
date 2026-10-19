//! 任务冻结时把路径类插件变量解析成 VFS 的只读 `input` 挂载。
//!
//! 插件脚本只能拿到虚拟路径，宿主真实路径不会进入 JS。数据库里的 `user_config`
//! 保持原值，因此「再次执行」和定时任务每次冻结都会按当时的路径重新解析。

use std::collections::HashMap;
#[cfg(not(target_os = "android"))]
use std::path::Path;

use serde_json::Value;

use crate::plugin::vfs::{InputKind, InputMount};
use crate::plugin::{Plugin, VarDefinition};

/// 路径类变量类型；其余类型原样透传给脚本。
pub fn is_path_var_type(var_type: &str) -> bool {
    matches!(var_type, "path" | "file" | "folder" | "file_or_folder")
}

#[cfg(not(target_os = "android"))]
fn allows_file(var_type: &str) -> bool {
    matches!(var_type, "path" | "file" | "file_or_folder")
}

#[cfg(not(target_os = "android"))]
fn allows_dir(var_type: &str) -> bool {
    matches!(var_type, "path" | "folder" | "file_or_folder")
}

/// 变量 key 会直接作为虚拟路径段，不能带分隔符或 `.` / `..`。
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key == "." || key == ".." || key.contains('/') || key.contains('\\') {
        return Err(format!("插件变量名不能作为输入挂载点：{key:?}"));
    }
    Ok(())
}

/// 文件名会作为虚拟路径段；不可用时退回 `file`，不影响读取（宿主路径单独保存）。
fn sanitize_input_name(name: &str) -> String {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        "file".to_string()
    } else {
        name.to_string()
    }
}

/// 解析本次任务的所有路径类变量。内建插件在 Rust 侧直接消费宿主路径，不参与挂载。
pub async fn resolve_input_mounts(
    plugin: &Plugin,
    config: &HashMap<String, Value>,
) -> Result<Vec<InputMount>, String> {
    resolve_input_mounts_inner(&plugin.var_defs, plugin.script.is_builtin(), config).await
}

async fn resolve_input_mounts_inner(
    var_defs: &[VarDefinition],
    is_builtin: bool,
    config: &HashMap<String, Value>,
) -> Result<Vec<InputMount>, String> {
    if is_builtin {
        return Ok(Vec::new());
    }

    let mut mounts = Vec::new();
    for def in var_defs {
        if !is_path_var_type(&def.var_type) {
            continue;
        }
        let Some(value) = config.get(&def.key).and_then(Value::as_str) else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        validate_key(&def.key)?;
        mounts.push(resolve_mount(&def.key, &def.var_type, value).await?);
    }
    Ok(mounts)
}

#[cfg(not(target_os = "android"))]
async fn resolve_mount(key: &str, var_type: &str, value: &str) -> Result<InputMount, String> {
    resolve_host_mount(key, var_type, value)
}

#[cfg(target_os = "android")]
async fn resolve_mount(key: &str, var_type: &str, value: &str) -> Result<InputMount, String> {
    if value.starts_with("content://") {
        return resolve_content_mount(key, var_type, value).await;
    }
    Err(format!(
        "变量 {key}：Android 只支持系统选择器返回的文件，不支持宿主绝对路径"
    ))
}

#[cfg(not(target_os = "android"))]
fn resolve_host_mount(key: &str, var_type: &str, value: &str) -> Result<InputMount, String> {
    let typed = Path::new(value);
    if !typed.is_absolute() {
        return Err(format!("变量 {key} 必须是绝对路径"));
    }
    // 冻结时 canonicalize 一次：之后 input 子树内只要出现软链接就拒绝，
    // 插件无法经软链接访问用户授权范围之外的文件。
    let host = std::fs::canonicalize(typed)
        .map_err(|error| format!("变量 {key} 的路径无法访问：{error}"))?;
    let metadata =
        std::fs::metadata(&host).map_err(|error| format!("变量 {key} 的路径无法访问：{error}"))?;

    if metadata.is_dir() {
        if !allows_dir(var_type) {
            return Err(format!("变量 {key} 需要文件，但选中的是文件夹"));
        }
        return Ok(InputMount {
            key: key.to_string(),
            kind: InputKind::Dir { host },
        });
    }
    if metadata.is_file() {
        if !allows_file(var_type) {
            return Err(format!("变量 {key} 需要文件夹，但选中的是文件"));
        }
        let name = host
            .file_name()
            .and_then(|name| name.to_str())
            .map(sanitize_input_name)
            .unwrap_or_else(|| "file".to_string());
        return Ok(InputMount {
            key: key.to_string(),
            kind: InputKind::File { host, name },
        });
    }
    Err(format!("变量 {key} 的路径既不是文件也不是文件夹"))
}

#[cfg(target_os = "android")]
async fn resolve_content_mount(key: &str, var_type: &str, uri: &str) -> Result<InputMount, String> {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::path::PathBuf;

    use crate::crawler::content_io::get_content_io_provider;

    if var_type == "folder" {
        return Err(format!("变量 {key}：Android 暂不支持文件夹类型的插件变量"));
    }
    let provider = get_content_io_provider();
    if provider
        .is_directory(uri)
        .await
        .map_err(|error| format!("变量 {key} 的选中项无法访问：{error}"))?
    {
        return Err(format!("变量 {key}：Android 暂不支持文件夹类型的插件变量"));
    }
    let display_name = provider
        .get_display_name(uri)
        .await
        .map_err(|error| format!("变量 {key} 的文件名无法读取：{error}"))?;
    let fd = provider
        .open_fd(uri)
        .await
        .map_err(|error| format!("变量 {key} 的文件无法打开：{error}"))?;
    // OwnedFd 随 VFS 存活到任务结束；FFmpeg/读取方各自 open() 出自己的副本。
    let owned_fd = unsafe { OwnedFd::from_raw_fd(fd) };
    Ok(InputMount {
        key: key.to_string(),
        kind: InputKind::File {
            host: PathBuf::from(format!("/proc/self/fd/{fd}")),
            name: sanitize_input_name(&display_name),
        },
        owned_fd: Some(owned_fd),
    })
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    fn var_def(key: &str, var_type: &str) -> VarDefinition {
        serde_json::from_value(serde_json::json!({
            "key": key,
            "type": var_type,
            "name": key,
        }))
        .expect("valid var definition")
    }

    fn config(pairs: &[(&str, &str)]) -> HashMap<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
            .collect()
    }

    async fn resolve(
        defs: &[(&str, &str)],
        values: &[(&str, &str)],
    ) -> Result<Vec<InputMount>, String> {
        let defs = defs
            .iter()
            .map(|(key, var_type)| var_def(key, var_type))
            .collect::<Vec<_>>();
        resolve_input_mounts_inner(&defs, false, &config(values)).await
    }

    #[tokio::test]
    async fn builtin_plugins_and_blank_values_are_skipped() {
        let defs = vec![var_def("src", "file")];
        assert!(
            resolve_input_mounts_inner(&defs, true, &config(&[("src", "/tmp/x")]))
                .await
                .unwrap()
                .is_empty()
        );

        assert!(resolve(&[("src", "file")], &[]).await.unwrap().is_empty());
        assert!(resolve(&[("src", "file")], &[("src", "   ")])
            .await
            .unwrap()
            .is_empty());
        // 非路径类型不参与挂载。
        assert!(resolve(&[("tag", "string")], &[("tag", "/tmp")])
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn relative_and_missing_paths_are_rejected() {
        let error = resolve(&[("src", "file")], &[("src", "relative/a.png")])
            .await
            .unwrap_err();
        assert!(error.contains("绝对路径"), "{error}");

        let missing = std::env::temp_dir().join("kabegame-input-mounts-missing/none.png");
        let error = resolve(&[("src", "file")], &[("src", missing.to_str().unwrap())])
            .await
            .unwrap_err();
        assert!(error.contains("无法访问"), "{error}");
    }

    #[tokio::test]
    async fn declared_type_must_match_the_selected_entry() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.png");
        std::fs::write(&file, b"png").unwrap();
        let folder = folder.to_str().unwrap().to_string();
        let file = file.to_str().unwrap().to_string();

        let error = resolve(&[("src", "file")], &[("src", &folder)])
            .await
            .unwrap_err();
        assert!(error.contains("需要文件"), "{error}");
        let error = resolve(&[("src", "folder")], &[("src", &file)])
            .await
            .unwrap_err();
        assert!(error.contains("需要文件夹"), "{error}");

        // `path` / `file_or_folder` 两种都接受。
        for var_type in ["path", "file_or_folder"] {
            let mounts = resolve(&[("src", var_type)], &[("src", &file)])
                .await
                .unwrap();
            assert!(
                matches!(mounts[0].kind, InputKind::File { .. }),
                "{var_type}"
            );
            let mounts = resolve(&[("src", var_type)], &[("src", &folder)])
                .await
                .unwrap();
            assert!(
                matches!(mounts[0].kind, InputKind::Dir { .. }),
                "{var_type}"
            );
        }
    }

    #[tokio::test]
    async fn file_mount_keeps_original_name_and_dir_mount_host() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.png");
        std::fs::write(&file, b"png").unwrap();

        let mounts = resolve(&[("src", "file")], &[("src", file.to_str().unwrap())])
            .await
            .unwrap();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].key, "src");
        match &mounts[0].kind {
            InputKind::File { name, host } => {
                assert_eq!(name, "a.png");
                // 冻结时已 canonicalize。
                assert_eq!(*host, std::fs::canonicalize(&file).unwrap());
            }
            other => panic!("expected file mount, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_keys_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.png");
        std::fs::write(&file, b"png").unwrap();
        for key in ["a/b", "..", "."] {
            let error = resolve(&[(key, "file")], &[(key, file.to_str().unwrap())])
                .await
                .unwrap_err();
            assert!(error.contains("输入挂载点"), "{key}: {error}");
        }
    }

    #[test]
    fn unsafe_file_names_fall_back_to_file() {
        for name in ["", "  ", ".", "..", "a/b", "a\\b"] {
            assert_eq!(sanitize_input_name(name), "file", "{name:?}");
        }
        assert_eq!(sanitize_input_name("写真 01.png"), "写真 01.png");
    }
}
