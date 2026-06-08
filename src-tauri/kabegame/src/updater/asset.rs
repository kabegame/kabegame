//! 按 平台 + 模式 + 架构 匹配 release 资产。
//!
//! 命名约定（见 README / 实测）：
//!   Windows: `Kabegame-<mode>_<ver>_x64-setup.exe`
//!   macOS:   `Kabegame-<mode>_<ver>_aarch64.dmg`
//!   Linux:   `Kabegame-<mode>_<ver>_amd64.deb`（Linux 不走下载，仅诊断用）

use super::github::RawAsset;

/// 在资产列表中找到匹配当前平台/模式/架构的包，返回 `(name, url)`；无则 `None`。
pub fn match_asset(
    assets: &[RawAsset],
    platform: &str,
    mode: &str,
    arch: &str,
) -> Option<(String, String)> {
    let mode_token = if mode == "light" {
        "-light_"
    } else {
        "-standard_"
    };

    for a in assets {
        let name = &a.name;
        if !name.contains(mode_token) {
            continue;
        }
        let ok = match platform {
            "windows" => name.ends_with("-setup.exe") && name.contains(arch),
            "macos" => name.ends_with(".dmg") && name.contains(arch),
            "linux" => name.ends_with(".deb") && name.contains("amd64"),
            _ => false,
        };
        if ok {
            return Some((name.clone(), a.browser_download_url.clone()));
        }
    }
    None
}
