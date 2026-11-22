//! 插件模式（Linux / KDE Plasma 6）的 Plasma 壁纸插件：随应用分发、切到插件模式时按修订号装进用户目录。
//!
//! - **内置包**：`<resource_dir>/plasma-wallpaper/org.kabegame.wallpaper`（`deno task build:plasma-plugin` 产出、构建时拷进
//!   resources，源码在 `src-plasma-wallpaper-plugin/`）。`metadata.json` 带 `X-Kabegame-StreamProtocol`（约定版本）、
//!   `X-Kabegame-PluginRevision`（修订号）与 `X-Kabegame-Entry`（这个修订的内容文件）。
//! - **找已装的**：照 Plasma 的查找顺序，用户目录（`XDG_DATA_HOME`）优先，其次 `XDG_DATA_DIRS`；第一个找到的就是 plasmashell
//!   会加载的。旧的 C++ / IPC 版插件没有这些键，视为约定版本 0、修订 0。
//! - **装**：约定版本不同、或修订号比内置的旧（含没有装）时，把内置包拷进用户目录（先拷到旁边的临时目录再换上）；系统目录里
//!   别的包装的旧版不碰，用户目录的会盖过它。不用 `kpackagetool6`：它做的也只是拷目录，少一个外部依赖。
//! - **升级不重启 plasmashell**：插件的 `main.qml` 是永不改的壳，按配置项 `General/Entry` 加载内容文件；每个修订的内容文件、
//!   QML 模块 URI 与 `.so` 名都带修订号。装好后由调用方（`plasma_plugin`）经 `evaluateScript` 把 `Entry` 写成新修订的内容文件。
//! - **卸载**：deb 的 `postrm`（`src-tauri/kabegame/deb/postrm.sh`）把各用户的桌面换回 `org.kde.image`、删掉用户目录里带
//!   `X-Kabegame-StreamProtocol` 的这份插件。

use std::path::{Path, PathBuf};

use kabegame_core::app_paths::AppPaths;

use super::qdbus::KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID as PLUGIN_ID;

/// 内置包在 resources 下的目录名，与 `scripts/plugins/plasma-wallpaper-plugin.ts` 一致。
const BUNDLED_DIR_NAME: &str = "plasma-wallpaper";

/// 插件包 `metadata.json` 里与 Kabegame 的约定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginPackage {
    /// 约定版本（节点属性 `kabegame.wallpaper.protocol`、输入消息的 version）；旧版插件没有，为 0
    pub protocol: u32,
    /// 修订号；旧版插件没有，为 0
    pub revision: u32,
    /// 这个修订的内容文件（相对 `contents/ui`），切换时写进配置项 `General/Entry`；旧版插件没有，为空
    pub entry: String,
}

impl PluginPackage {
    /// 读 `dir/metadata.json`；读不到或不是 JSON 时 `None`（不算一个包）。
    pub fn read(dir: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(dir.join("metadata.json")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        let number = |key: &str| json.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        Some(Self {
            protocol: number("X-Kabegame-StreamProtocol"),
            revision: number("X-Kabegame-PluginRevision"),
            entry: json
                .get("X-Kabegame-Entry")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        })
    }

    /// 装着的这份能不能代替 `bundled`：约定版本相同、修订号不比它旧。
    fn satisfies(&self, bundled: &PluginPackage) -> bool {
        self.protocol == bundled.protocol && self.revision >= bundled.revision
    }
}

/// 当前会话是不是 KDE Plasma 6（插件按 Plasma 6 的接口写）。
pub fn is_plasma6_session() -> bool {
    crate::linux_desktop::linux_desktop() == crate::linux_desktop::LinuxDesktop::Plasma
        && std::env::var("KDE_SESSION_VERSION").is_ok_and(|v| v.trim() == "6")
}

/// 内置包的目录与内容；没有（dev 没跑 `build:plasma-plugin`）时 `None`。
fn bundled() -> Option<(PathBuf, PluginPackage)> {
    let dir = AppPaths::global()
        .resource_dir
        .join(BUNDLED_DIR_NAME)
        .join(PLUGIN_ID);
    let package = PluginPackage::read(&dir)?;
    Some((dir, package))
}

/// 用户目录里的插件位置：`$XDG_DATA_HOME/plasma/wallpapers/org.kabegame.wallpaper`。
fn user_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("plasma/wallpapers").join(PLUGIN_ID))
}

/// Plasma 查插件的目录（按顺序）：用户目录，再是 `XDG_DATA_DIRS`（缺省 `/usr/local/share:/usr/share`）。
fn search_dirs() -> Vec<PathBuf> {
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    user_dir()
        .into_iter()
        .chain(
            data_dirs
                .split(':')
                .filter(|dir| !dir.is_empty())
                .map(|dir| Path::new(dir).join("plasma/wallpapers").join(PLUGIN_ID)),
        )
        .collect()
}

/// plasmashell 会加载的那份（查找顺序里第一个有 `metadata.json` 的）。
fn installed() -> Option<(PathBuf, PluginPackage)> {
    search_dirs()
        .into_iter()
        .find_map(|dir| PluginPackage::read(&dir).map(|package| (dir, package)))
}

/// 插件模式能不能用：Plasma 6 会话，且有内置包或已经装着能用的插件。
pub fn available() -> bool {
    is_plasma6_session()
        && (bundled().is_some()
            || installed().is_some_and(|(_, package)| package.protocol == current_protocol()))
}

/// 本应用讲的约定版本（节点属性 `kabegame.wallpaper.protocol`）。
fn current_protocol() -> u32 {
    super::pipewire::PROTOCOL_VERSION
}

/// 确保 plasmashell 会加载的插件能和本应用对上：没有、约定版本不同或修订号比内置的旧时，把内置包装进用户目录。返回之后
/// 生效的那份（内容文件名给调用方写进 `Entry`）。没有内置包时只能用已经装着的、约定版本相同的那份。
pub fn ensure_installed() -> Result<PluginPackage, String> {
    let installed = installed();
    let Some((bundled_dir, bundled)) = bundled() else {
        return match installed {
            Some((path, package)) if package.protocol == current_protocol() => {
                tracing::warn!(
                    "没有内置的 Plasma 壁纸插件（dev 没跑 deno task build:plasma-plugin？），用已经装着的 {}（修订 {}）",
                    path.display(),
                    package.revision
                );
                Ok(package)
            }
            _ => Err("没有内置的 Plasma 壁纸插件，也没有装着能用的版本".to_string()),
        };
    };
    if bundled.protocol != current_protocol() {
        tracing::warn!(
            "内置的 Plasma 壁纸插件约定版本 {} 与应用的 {} 不一致",
            bundled.protocol,
            current_protocol()
        );
    }
    if let Some((path, package)) = &installed {
        if package.satisfies(&bundled) {
            return Ok(package.clone());
        }
        tracing::info!(
            "Plasma 壁纸插件 {}（约定版本 {}、修订 {}）比内置的（约定版本 {}、修订 {}）旧，装内置的",
            path.display(),
            package.protocol,
            package.revision,
            bundled.protocol,
            bundled.revision
        );
    }
    let target = user_dir().ok_or("找不到用户数据目录")?;
    install_dir(&bundled_dir, &target)?;
    tracing::info!(
        "Plasma 壁纸插件修订 {} 装到 {}",
        bundled.revision,
        target.display()
    );
    Ok(bundled)
}

/// 把 `source` 整个目录换到 `target`：先拷到旁边的临时目录，再把旧的挪开、新的改名过去、删旧的。临时目录不放在
/// `wallpapers/` 里（plasmashell 会把那里的子目录都当插件包列出来）。
fn install_dir(source: &Path, target: &Path) -> Result<(), String> {
    let wallpapers = target.parent().ok_or("插件目录没有上级目录")?;
    let scratch = wallpapers
        .parent()
        .ok_or("插件目录没有上上级目录")?
        .join(format!(".kabegame-wallpaper-install-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("建 {} 失败: {e}", scratch.display()))?;
    let result = (|| {
        let fresh = scratch.join("new");
        copy_dir(source, &fresh)?;
        std::fs::create_dir_all(wallpapers)
            .map_err(|e| format!("建 {} 失败: {e}", wallpapers.display()))?;
        let old = scratch.join("old");
        if target.exists() {
            std::fs::rename(target, &old)
                .map_err(|e| format!("挪开旧的 {} 失败: {e}", target.display()))?;
        }
        if let Err(e) = std::fs::rename(&fresh, target) {
            // 换不上就把旧的挪回去
            if old.exists() {
                let _ = std::fs::rename(&old, target);
            }
            return Err(format!("换上新的 {} 失败: {e}", target.display()));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("建 {} 失败: {e}", to.display()))?;
    let entries = std::fs::read_dir(from).map_err(|e| format!("读 {} 失败: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读 {} 失败: {e}", from.display()))?;
        let path = entry.path();
        let dest = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("读 {} 失败: {e}", path.display()))?;
        if kind.is_dir() {
            copy_dir(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)
                .map_err(|e| format!("拷 {} 失败: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kabegame-plasma-install-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_package(dir: &Path, metadata: &str, files: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("metadata.json"), metadata).unwrap();
        for (path, text) in files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
    }

    #[test]
    fn reads_the_contract_keys_and_treats_old_plugins_as_zero() {
        let dir = temp_dir("read");
        write_package(
            &dir,
            r#"{"KPlugin":{"Id":"org.kabegame.wallpaper"},"X-Kabegame-StreamProtocol":1,"X-Kabegame-PluginRevision":3,"X-Kabegame-Entry":"KabegameWallpaperR3.qml"}"#,
            &[],
        );
        assert_eq!(
            PluginPackage::read(&dir),
            Some(PluginPackage {
                protocol: 1,
                revision: 3,
                entry: "KabegameWallpaperR3.qml".into()
            })
        );
        // 旧的 C++ / IPC 版：没有这些键
        write_package(&dir, r#"{"KPlugin":{"Id":"org.kabegame.wallpaper","Version":"1.2.0"}}"#, &[]);
        assert_eq!(
            PluginPackage::read(&dir),
            Some(PluginPackage {
                protocol: 0,
                revision: 0,
                entry: String::new()
            })
        );
        std::fs::remove_file(dir.join("metadata.json")).unwrap();
        assert_eq!(PluginPackage::read(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installed_satisfies_only_with_the_same_protocol_and_a_revision_not_older() {
        let package = |protocol, revision| PluginPackage {
            protocol,
            revision,
            entry: String::new(),
        };
        let bundled = package(1, 2);
        assert!(package(1, 2).satisfies(&bundled));
        assert!(package(1, 3).satisfies(&bundled), "新的不降级（dev 与已安装版轮流跑时不来回装）");
        assert!(!package(1, 1).satisfies(&bundled));
        assert!(!package(0, 0).satisfies(&bundled), "旧的 C++ / IPC 版");
        assert!(!package(2, 9).satisfies(&bundled), "约定版本不同就换成应用自己的");
    }

    #[test]
    fn install_replaces_the_whole_directory() {
        let root = temp_dir("replace");
        let source = root.join("bundled");
        write_package(
            &source,
            r#"{"X-Kabegame-StreamProtocol":1,"X-Kabegame-PluginRevision":2}"#,
            &[("contents/ui/main.qml", "shell"), ("contents/ui/KabegameWallpaperR2.qml", "r2")],
        );
        let target = root.join("data/plasma/wallpapers").join(PLUGIN_ID);
        // 旧版留下的文件要一起消失
        write_package(&target, "{}", &[("contents/ui/old.qml", "old")]);
        install_dir(&source, &target).unwrap();
        assert_eq!(PluginPackage::read(&target).unwrap().revision, 2);
        assert!(target.join("contents/ui/KabegameWallpaperR2.qml").exists());
        assert!(!target.join("contents/ui/old.qml").exists());
        // 临时目录收拾干净，wallpapers 里只有插件本身
        let siblings: Vec<_> = std::fs::read_dir(root.join("data/plasma")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(siblings, vec![std::ffi::OsString::from("wallpapers")]);
        // 没有旧的也能装
        std::fs::remove_dir_all(&target).unwrap();
        install_dir(&source, &target).unwrap();
        assert!(target.join("contents/ui/main.qml").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plugin_source_protocol_matches_the_app() {
        // 插件源码的约定版本（src-plasma-wallpaper-plugin/PROTOCOL）与节点属性用的同一个数
        let text = include_str!("../../../../../../src-plasma-wallpaper-plugin/PROTOCOL");
        assert_eq!(text.trim().parse::<u32>().unwrap(), current_protocol());
    }
}
