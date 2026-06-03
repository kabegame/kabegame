# Phase 1 — 后端：GitHub Release 查询接口

> 根计划：[desktop-auto-update.md](./desktop-auto-update.md)
> 本 Phase 只做**后端查询接口**（`check_for_updates`）：拉取 GitHub releases、计算错过版本（≤5）、按 平台+模式+架构 匹配下载 asset。**不做**下载、安装、UI、调度。
> **不写 Rust 测试用例**；改为提供两个 Python 脚本（见 §6）直接调 GitHub 接口，作为开发期的"参考实现 / 对照 oracle"。

---

## 1. 编译门禁

- 整套更新逻辑仅桌面 Tauri 栈、**非 Android**：`#[cfg(all(not(feature = "web"), not(target_os = "android")))]`。
- `commands/` 模块本身已是 `#[cfg(not(feature = "web"))]`（见 `lib.rs:14-15`），故命令模块再叠加 `#[cfg(not(target_os = "android"))]` 即可。

## 2. 新建文件

```
src-tauri/kabegame/src/updater/
  mod.rs        // 数据结构 + 公开入口 check_updates()
  github.rs     // fetch_releases() + compute_missed()
  asset.rs      // match_asset()
src-tauri/kabegame/src/commands/updater.rs  // #[tauri::command] check_for_updates
```

## 3. 数据结构（`updater/mod.rs`，serde camelCase）

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub tag: String,           // tag_name
    pub name: String,          // name（为空时回退 tag）
    pub body: String,          // changelog markdown 原文
    pub html_url: String,      // 该 release 的 GitHub 页面
    pub published_at: String,  // ISO8601 原样透传
    pub asset_url: Option<String>,  // 匹配到的下载直链（无则 None）
    pub asset_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,   // env!("CARGO_PKG_VERSION")
    pub platform: String,          // "windows" | "macos" | "linux"
    pub mode: String,              // "standard" | "light"
    pub arch: String,              // "x64" | "aarch64" | 原始 target_arch
    pub has_update: bool,          // releases 非空（即 latest.tag != current）
    pub downloadable: bool,        // releases[0] 是否匹配到 asset（latest 可下）
    pub releases: Vec<ReleaseInfo>,// 错过版本，最新在前，≤5
}
```

- `has_update`：等价于 `!releases.is_empty()`。版本判定**只比较 tag 字符串相等**，不做 semver 比较。
- `downloadable`：最新一版（`releases[0]`）是否匹配到当前平台/模式/架构的 asset。Linux 不参与下载（前端 Phase 3 走跳转），但接口仍照常返回匹配结果（便于诊断）。

## 4. 运行期环境判定（编译期 cfg，后端权威）

```rust
fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")] { "windows" }
    #[cfg(target_os = "macos")]   { "macos" }
    #[cfg(target_os = "linux")]   { "linux" }
}
fn current_mode() -> &'static str {
    #[cfg(feature = "light")] { "light" }
    #[cfg(not(feature = "light"))] { "standard" }
}
fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        other => other,
    }
}
```

## 5. 逻辑

### 5.1 `github.rs::fetch_releases`
- `GET https://api.github.com/repos/kabegame/kabegame/releases?per_page=30`
- 必带 header：
  - `User-Agent: kabegame-updater`（GitHub 强制要求，缺失会 403）
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
- `reqwest::Client`（GUI crate 已有 reqwest 依赖）；超时 10s。
- 解析为内部 `RawRelease { tag_name, name, body, html_url, published_at, draft, prerelease, assets: Vec<RawAsset{name, browser_download_url}> }`（`#[derive(Deserialize)]`，多余字段忽略）。
- 错误统一 `Err(String)`，由命令层吞掉/上报。

### 5.2 `github.rs::compute_missed`
```
compute_missed(current, raw_list) -> Vec<ReleaseInfo>:
  cur = norm_tag(current)       # 见下方 v 前缀归一化
  out = []
  for r in raw_list:            # GitHub 默认按发布时间倒序，最新在前
    if r.draft: continue        # 跳过草稿
    if norm_tag(r.tag_name) == cur: break  # 遇到当前版本即停（之后都是更旧的）
    out.push(to_release_info(r, asset_match))
    if out.len() == 5: break    # 最多 5 个
  return out
```

> **⚠️ v 前缀归一化（已用 `fetch_releases.py` 实测确认）**：GitHub tag 形如 **`v4.1.1`**，而 `env!("CARGO_PKG_VERSION")` 是 **`4.1.1`**（无 `v`）。直接字符串比较永远不相等 → 会把当前版本也算成"更新"。比较前两边都剥掉前导 `v`：
> ```rust
> fn norm_tag(t: &str) -> &str { t.strip_prefix('v').unwrap_or(t) }
> ```
> `ReleaseInfo.tag` **保留原始带 `v` 的 tag**（下载 URL 路径 `releases/download/v4.1.1/...` 与展示都用它），仅在**比较**时归一化。
- **prerelease**：第一版**保留**（README 的正式发布都不是 prerelease；如需排除，留 `// TODO 可加开关`）。
- 若列表里**找不到** current tag（用户装的是更旧/本地版本）：自然取最新 5 个。

### 5.3 `asset.rs::match_asset`
```
match_asset(assets, platform, mode, arch) -> Option<(name, url)>:
  mode_token = match mode { "light" => "-light_", _ => "-standard_" }
  for a in assets:
    n = a.name
    if !n.contains(mode_token): continue
    let ok = match platform {
      "windows" => n.ends_with("-setup.exe") && n.contains(arch /* x64 */),
      "macos"   => n.ends_with(".dmg")        && n.contains(arch /* aarch64 */),
      "linux"   => n.ends_with(".deb")        && n.contains("amd64"),
      _ => false,
    };
    if ok { return Some((n, a.browser_download_url)) }
  None
```
- 命名依据见根计划 §「GitHub Release 资产命名」。匹配不到 → `asset_url = None`、该版本 `downloadable=false`。

### 5.4 `updater/mod.rs::check_updates`
- 组装 `current_version/platform/mode/arch` → `fetch_releases` → `compute_missed` → 填 `has_update`、`downloadable`（`releases.first().and_then(asset_url).is_some()`）→ 返回 `UpdateCheckResult`。

### 5.5 命令 `commands/updater.rs`
```rust
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_for_updates() -> Result<crate::updater::UpdateCheckResult, String> {
    crate::updater::check_updates().await
}
```

## 6. 接线（修改点）

1. `src-tauri/kabegame/src/lib.rs`：模块声明区加
   ```rust
   #[cfg(all(not(feature = "web"), not(target_os = "android")))]
   mod updater;
   ```
2. `src-tauri/kabegame/src/commands/mod.rs`：
   ```rust
   #[cfg(not(target_os = "android"))]
   pub mod updater;
   #[cfg(not(target_os = "android"))]
   pub use updater::*;
   ```
3. `src-tauri/kabegame/src/lib.rs` 的 `generate_handler!`（line 325 起）加（带 cfg）：
   ```rust
   #[cfg(not(target_os = "android"))]
   check_for_updates,
   ```

## 7. Python 脚本（替代测试用例，直接调 GitHub 接口）

放在 `test/auto-update/`（沿用仓库 `test/native-auto-import` 的原型脚本惯例）：

- **`fetch_releases.py`** — 调 `GET /repos/kabegame/kabegame/releases`，打印每个 release 的 tag/name/published_at/html_url 及 assets（name + size + 下载直链）。用途：核对 Rust `RawRelease`/`RawAsset` 字段名与真实 asset 命名是否一致。
  ```bash
  python3 test/auto-update/fetch_releases.py            # 表格视图
  python3 test/auto-update/fetch_releases.py --json     # 原始裁剪 JSON
  python3 test/auto-update/fetch_releases.py --token $GITHUB_TOKEN   # 提高速率限制
  ```
- **`check_update.py`** — 用 Python **完整复刻** §5 的 `compute_missed` + `match_asset`，输出与 Rust `UpdateCheckResult` 字段一致的 JSON。用途：作为 Rust 实现的对照 oracle（同参数下两边 JSON 应一致）。
  ```bash
  python3 test/auto-update/check_update.py --current 4.0.0 --platform macos --mode standard --arch aarch64
  python3 test/auto-update/check_update.py --current 4.1.1 --platform windows --mode light --arch x64
  ```
  - `--current` 必填；`--platform/--mode/--arch` 缺省时按运行机器探测；`--max` 默认 5。

## 8. 验收

- `cargo check -p kabegame`（standard 与 light 两套 feature）通过；`bun check -c kabegame --skip cargo` 不受影响。
- DevTools 控制台 `await window.__TAURI__.core.invoke('check_for_updates')`：
  - 装的是旧版本 → `hasUpdate=true`、`releases` 最新在前且 ≤5、macOS/Windows 下 `downloadable=true`。
  - 装的是最新版本 → `hasUpdate=false`、`releases=[]`。
- 同参数下 `check_update.py` 的输出与命令返回 JSON 对得上（字段、tag 顺序、asset 匹配一致）。

## 9. 风险 / 注意

- **GitHub 速率限制**：匿名 60 次/小时/IP。检查本就低频（启动 + 24h），可接受；脚本支持 `--token`。
- **UA 头必填**：缺失 GitHub 返回 403——`fetch_releases` 必须设置。
- **prerelease/draft**：当前策略 skip draft、保留 prerelease；如未来用 prerelease 做灰度，再加开关（留 TODO）。
- **不缓存**：本接口每次都实打实请求 GitHub，不加任何本地缓存（符合根计划"不缓存检查历史"）。
</content>
