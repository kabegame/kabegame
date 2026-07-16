# 精简 WallpaperManager + supported 列表后端化 + 去 system

> 决策已由用户逐条确认(见文末「决策记录」)。本文件供 codex 执行,Claude 负责 git 与独立验收。

## 目标
1. `WallpaperManager` trait 删 getter 与死代码,只保留 setter/生命周期。
2. 新增 per-backend「supported 列表」能力(styles/transitions,label/desc 为 **i18n map 对象**,同 plugin `name`),modes 在 controller;一个聚合命令 `get_wallpaper_capabilities` 暴露给前端。
3. 前端三个壁纸设置组件改为从后端读列表,删掉写死的平台/DE 分支。
4. 彻底去掉 `"system"` 样式值;列表按平台「提供全」。
5. 新增 **settings 版本化迁移框架**(同构 `storage::migrations`:`schemaVersion` + `MIGRATIONS[]` + `run_pending`/`mark_as_latest`),去 system 作为其首个迁移 `v001`。

## 能力矩阵(权威,后端据此实现)
| 后端 | styles(value) | transitions(value) |
|---|---|---|
| native·Windows | fill/fit/stretch/center/tile | none, fade |
| native·Linux-Plasma | fill/fit/center/tile | none |
| native·Linux-GNOME/Unknown | fill/fit/stretch/center/tile | none |
| native·macOS | **fill(唯一项)** | none |
| native·Android | fill | none |
| window(Win/macOS) | fill/fit/stretch/center/tile | none, fade, slide, zoom |
| plasma-plugin | fill/fit/stretch/center/tile | none, fade, slide, zoom |

- native 后端在运行时用 `linux_desktop()` 区分 Plasma/GNOME。
- transitions 的 `none` label 按 mode 区分:native 用 `transitionFollowSystem`(跟随系统),window/plasma-plugin 用 `transitionNone`(无)。
- 只有 styles 有 desc;transitions/modes 无 desc。

---

## 现状锚点

**a. trait**(`src-tauri/kabegame/src/wallpaper/manager/mod.rs:137`)
```rust
async fn get_style(&self) -> Result<String, String>;        // #[allow(dead_code)]
async fn get_transition(&self) -> Result<String, String>;   // #[allow(dead_code)]
async fn set_style(&self, style: &str) -> ...;              // 保留
async fn set_transition(&self, transition: &str) -> ...;    // 保留
async fn set_wallpaper_path(&self, file_path: &str) -> ...; // 保留
async fn set_wallpaper(...) { set_style; set_transition; set_wallpaper_path } // 默认实现,保留
fn cleanup(&self) -> ...;      // 保留
fn refresh_desktop(&self) -> ...;  // #[allow(dead_code)] 全仓无调用者
fn init(&self) -> ...;         // 保留
```

**b. getter 唯一调用点在 rotator,两条路径不一致**
```rust
// rotator.rs:579 spawn_task —— 用 manager getter(要改)
let style = manager.get_style().await?;
let transition = manager.get_transition().await?;
// rotator.rs:880 rotate —— 已直接读 settings(目标形态)
let style = settings.get_wallpaper_rotation_style();
let transition = settings.get_wallpaper_rotation_transition();
```

**c. native.rs 读系统样式代码(删)**:`get_wallpaper_plasma_fill_mode`、`get_wallpaper_gnome_picture_options`、`plasma_fill_mode_to_style`、各平台 `get_style` impl、`get_transition` impl、`refresh_desktop` impl。
> 保留 `style_to_plasma_fill_mode` / `style_to_gnome_picture_options`(set 路径用)、`current_wallpaper_transition_from_ipc`(Windows set_wallpaper_path 用)。

**d. system 硬编码三处**:`settings.rs:339 default_wallpaper_rotation_style="system"`、`settings.rs:434 macOS get_system_wallpaper_settings=("system","none")`、`set_wallpaper_style`(1451)按 mode 写 `WallpaperStyleByMode` map。

**d2. settings 持久化现状**:单个 `settings.json`(`AppPaths::settings_json()`),扁平 JSON 对象、camelCase key,**无版本字段**。`load_settings_map`(514)读 JSON→`HashMap<SettingKey, ArcSwap<SettingValue>>`(未知 key 忽略、缺 key 落默认);`serialize_to_json`(731)/`write_settings_file_now`(749)cells→JSON 原子写。`init_global`(240)末尾已有 `normalize_setting_value_now(Language)` 这种「初始化期归一化并落盘」的先例。**没有任何版本化迁移机制**。

**d3. SQLite 迁移框架(照抄对象)**:`storage/migrations/{mod.rs,init.rs,vNNN_*.rs}` —— `PRAGMA user_version` 存版本;`MIGRATIONS: &[Migration{version,name,up:fn(&Connection)->Result}]` 递增数组;`LATEST_VERSION`;`run_pending`(增量跑 `version>current` 并逐个 bump)、`mark_as_latest`(新库直达)、`init::create_all_tables`(新库一次性建全量 schema)。每迁移一个 `vNNN_*.rs` 带 `pub fn up`。

**e. 前端写死列表**:`WallpaperStyleSetting.vue:44-81`、`WallpaperTransitionSetting.vue:50-93`、`WallpaperModeSetting.vue:4-6`。

**f. i18n 双源**:label key 只在前端 `packages/kabegame-i18n/src/locales/*/settings.json`;Rust `src-tauri/kabegame-i18n/locales/*.yml` 是独立小资源(`window.*`/`vd.*`),**没有** style/transition/mode label,需移植。

**g. 命令范式**:`get_supported_image_types` = core fn?(此处不进 core,因依赖平台/DE)→ `commands/wallpaper.rs` Tauri command + `web/dispatch.rs` + `permissions/main.toml` + `lib.rs` invoke_handler。后端已有 `get_linux_desktop_env`、`is_plasma_wallpaper_plugin_installed`。

---

## 实施方案

### 点 1 — trait 精简 + 能力方法(`manager/mod.rs`)
- **删**:`get_style`、`get_transition`、`refresh_desktop`(trait 定义)。
- **新增**:
```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperOption {
    pub value: String,
    pub label: serde_json::Value,  // i18n map {default,en,zh,ja,ko,zhtw},同 plugin manifest name_to_value
    pub desc: serde_json::Value,   // i18n map;transitions/modes 传 {} 空对象
}

// trait 内(同步)
fn supported_styles(&self) -> Vec<WallpaperOption>;
fn supported_transitions(&self) -> Vec<WallpaperOption>;
```
- **label/desc 用 i18n map 对象**(照搬 plugin `name` 的形态,见 `plugin/mod.rs:2780 manifest_i18n_to_frontend_value`):不返回「当前语言单串」,而返回 `{default,en,zh,ja,ko,zhtw}`,前端用现成的 `resolveManifestText(map, locale)` 解析。好处:map 含全语言,前端切语言**无需重新 invoke**。
```rust
// manager/mod.rs 辅助:按受支持 locale 构 i18n map。default = en(与 kabegame_i18n fallback 一致)
fn i18n_map(key: &str) -> serde_json::Value {
    use serde_json::{Map, Value};
    let mut m = Map::new();
    m.insert("default".into(), Value::from(kabegame_i18n::translate_for_locale(key, "en")));
    for loc in kabegame_i18n::SUPPORTED_LOCALES {   // ["en","zh","ja","ko","zhtw"]
        m.insert((*loc).into(), Value::from(kabegame_i18n::translate_for_locale(key, loc)));
    }
    Value::Object(m)
}
// 无 desc 的选项:desc = serde_json::json!({})
```
> **关键**:不能在 `kabegame` app crate 里直接用 `rust_i18n::t!(key, locale=L)`——`rust_i18n` 的翻译资源由 `kabegame-i18n` crate 的 `i18n!("locales")` 加载,`rust_i18n::t!` 只在**同 crate**内解析,跨 crate 调拿不到。且 `kabegame_i18n::t!` 宏(re-export)只支持当前全局 locale、**不支持 locale 参数**。故必须在 `kabegame-i18n` 里**新增**按指定 locale 翻译的公开函数(见点 8b),app crate 调它。locale key 用 en/zh/ja/ko/zhtw,与前端 `locale.value`、YAML 文件名一致。
- **新增** `WallpaperController`:
```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    pub styles: HashMap<String, Vec<WallpaperOption>>,       // key=mode
    pub transitions: HashMap<String, Vec<WallpaperOption>>,  // key=mode
}
pub fn capabilities(&self) -> WallpaperCapabilities; // 见点6
```

### 点 2 — native.rs
- **删**:trait `get_style`/`get_transition`/`refresh_desktop` 各 cfg impl;私有 `get_wallpaper_plasma_fill_mode`/`get_wallpaper_gnome_picture_options`/`plasma_fill_mode_to_style`。
- **修改**:`set_style` 删 `if style=="system" {return Ok(())}`;Linux `set_wallpaper_path` 的 `effective = if style=="system"{ get_style() }` → 直接用 settings style(不再解析 system);Android `set_wallpaper_path` 里 `if style=="system"` 兜底可删(迁移后无 system)。
- **新增** `supported_styles`(按 cfg + 运行时 DE 返回上表 native 行);`supported_transitions`(Windows [none,fade];其余 [none])。label/desc 用 `i18n_map(key)`(见点1)。

### 点 3 — window.rs / 点 4 — plasma_plugin.rs
- **删**:`get_style`/`get_transition`/`refresh_desktop`。
- **新增**:`supported_styles` 全5;`supported_transitions` [none,fade,slide,zoom]。

### 点 5 — rotator.rs
- **修改** `spawn_task`(579):`manager.get_style()/get_transition()` → `settings.get_wallpaper_rotation_style()/get_wallpaper_rotation_transition()`,与 880 `rotate` 一致。

### 点 6 — 聚合命令(`commands/wallpaper.rs` + 接线)
- **新增** `WallpaperController::capabilities()`:
  - modes = `native` 恒有 + (win/mac→`window`) + (linux 且 `is_plasma_wallpaper_plugin_installed`→`plasma-plugin`),label 用 `i18n_map("settings.modeNative"/"modeWindow"/"modePlugin")`,desc = `{}`。
  - 对每个 available mode 调 `manager_for_mode(mode).supported_styles()/supported_transitions()` 填 map。
- **新增** Tauri command `get_wallpaper_capabilities() -> Result<WallpaperCapabilities, String>`。
- **接线**:`lib.rs` invoke_handler 注册;`web/dispatch.rs` 注册;`permissions/main.toml` 加 `get_wallpaper_capabilities`。

### 点 7 — settings 版本化迁移框架(仿 `storage::migrations`)+ 去 system

**7a. 模块布局(文件移动,路径不变)**
- `settings.rs` → `settings/mod.rs`(`git mv`;Rust `mod settings` 对 `settings.rs` 与 `settings/mod.rs` 等价,`crate::settings::*` 引用零改动)。
- 新增 `settings/migrations/mod.rs` + `settings/migrations/v001_wallpaper_drop_system.rs`。
- `settings/mod.rs` 顶部加 `mod migrations;`。

**7b. 版本载体**:settings.json 顶层保留 meta 键 `schemaVersion`(number,类比 `PRAGMA user_version`)。它**不是** `SettingKey`——只在**文件 I/O 边界**读写,不进 cells、不进前端快照。

**7c. 框架(`settings/migrations/mod.rs`,同构 SQLite 版)**
```rust
use serde_json::Value;
mod v001_wallpaper_drop_system;
type MigrationFn = fn(&mut Value) -> Result<(), String>;   // 对整个 settings JSON 做结构变换
struct Migration { version: u32, name: &'static str, up: MigrationFn }
const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "wallpaper_drop_system", up: v001_wallpaper_drop_system::up },
];
pub const LATEST_VERSION: u32 = 1;
pub const VERSION_KEY: &str = "schemaVersion";
fn current_version(json: &Value) -> u32 { json.get(VERSION_KEY).and_then(|v| v.as_u64()).unwrap_or(0) as u32 }
/// 增量迁移;返回是否发生变更(需回写)。缺 schemaVersion 视为 0。
pub fn run_pending(json: &mut Value) -> Result<bool, String> {
    let mut current = current_version(json);
    if current >= LATEST_VERSION { return Ok(false); }
    for m in MIGRATIONS { if m.version > current {
        println!("[settings-migration] v{:03}: {}", m.version, m.name);
        (m.up)(json)?; current = m.version;
    }}
    mark_as_latest(json);
    Ok(true)
}
/// 新建设置/初始化:直接标记最新(类比 mark_as_latest / create_all_tables 的版本戳)。
pub fn mark_as_latest(json: &mut Value) {
    if let Value::Object(m) = json { m.insert(VERSION_KEY.into(), Value::from(LATEST_VERSION)); }
}
```

**7d. 迁移步骤(`v001_wallpaper_drop_system.rs`)**
```rust
use serde_json::Value;
/// wallpaperStyle 及 wallpaperStyleByMode / wallpaper_style_by_mode(旧键)中所有 "system" → "fill"。幂等。
pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else { return Ok(()); };
    if map.get("wallpaperStyle").and_then(|v| v.as_str()) == Some("system") {
        map.insert("wallpaperStyle".into(), Value::from("fill"));
    }
    for k in ["wallpaperStyleByMode", "wallpaper_style_by_mode"] {
        if let Some(Value::Object(by_mode)) = map.get_mut(k) {
            for (_m, v) in by_mode.iter_mut() { if v.as_str() == Some("system") { *v = Value::from("fill"); } }
        }
    }
    Ok(())
}
```

**7e. 接线(`settings/mod.rs`)—— 启动处即初始化落盘,不懒初始化**
- `load_settings_map`:解析出 `json_value` 后、构建 cells 前,`let migrated = if let Some(ref mut j) = json_value { migrations::run_pending(j)? } else { false };`(cells 从迁移后的 JSON 构建)。返回值改为 `(cells, needs_write)`,其中 **`needs_write = !file.exists() || migrated`**(新装无文件也要写)。
- `init_global`(应用启动 `core_init::init_globals` 调用链内):`CELLS.set` 之后,`if needs_write { Self::write_settings_file_now(&settings_file)?; }`。
  - **新装**:文件不存在 → `needs_write=true` → **启动时立即**写出带 `schemaVersion=LATEST` 的完整 settings.json(即 `mark_as_latest` 的初始化语义,非懒创建)。
  - **老用户迁移**:`migrated=true` → 回写修正数据 + 版本戳。
  - **已最新**:文件在且 `run_pending` 返回 false → 不重复写。
- `write_settings_file_now`:序列化后、写盘前,把 `schemaVersion=LATEST_VERSION` 插进对象再写。`serialize_to_json`(前端快照用)**不含** schemaVersion。

**7f. 去 system 收尾(settings/mod.rs)**
- `default_wallpaper_rotation_style()` `"system"`→`"fill"`;macOS `get_system_wallpaper_settings()` `("system","none")`→`("fill","none")`;`get_wallpaper_rotation_style()` 读到 `"system"` 防御性归一化 `"fill"`(迁移兜底,双保险)。

### 点 8 — Rust i18n:移植文案 + 新增按 locale 翻译函数

**8a. YAML 移植**(`src-tauri/kabegame-i18n/locales/{en,zh,ja,ko,zhtw}.yml`,这 5 文件已有他人未提交改动,只**追加** `settings:` 下的 key,勿动其它)
- 从前端 `packages/kabegame-i18n/src/locales/<lang>/settings.json` 取现成译文,移植:
  - `settings.styleFill/styleFit/styleStretch/styleCenter/styleTile` + 各 `*Desc`
  - `settings.transitionNone/transitionFollowSystem/transitionFade/transitionSlide/transitionZoom`
  - `settings.modeNative/modeWindow/modePlugin`
> YAML 里写成嵌套 `settings:` 段,`kabegame_i18n::translate_for_locale("settings.styleFill", L)` 可取到。

**8b. 新增按 locale 翻译入口**(`src-tauri/kabegame-i18n/src/lib.rs`)
```rust
/// 受支持的 UI locale(与 locales/*.yml 文件名一致)。
pub const SUPPORTED_LOCALES: &[&str] = &["en", "zh", "ja", "ko", "zhtw"];

/// 按指定 locale 翻译任意 key(供构造 i18n map 对象;不改全局 locale)。
#[inline]
pub fn translate_for_locale(key: &str, locale: &str) -> String {
    let lang = resolve_supported_language(locale).unwrap_or(DEFAULT_LANGUAGE);
    rust_i18n::t!(key, locale = lang).to_string()   // 只能在本 crate 内调 rust_i18n::t!
}
```

### 点 9 — 前端 composable(`apps/kabegame/src/composables/useWallpaperCapabilities.ts`)
- **新增**:仿 `useImageTypes.ts`,`invoke("get_wallpaper_capabilities")` 缓存一次即可(label 是**全语言 i18n map**,**无需**随 locale 重新 invoke)。
- 返回的 `WallpaperOption.label/desc` 是 `Record<string,string>` i18n map。组件用 `@kabegame/i18n` 的 `resolveManifestText(map, locale.value)` 解析(与 `usePluginManifestI18n` 同一套),locale 变化时因 `locale.value` 响应式而自动重解析。
- 暴露 `modes`、`stylesFor(mode)`、`transitionsFor(mode)`(原始含 i18n map 的选项),解析交给组件。

### 点 10 — 前端三组件
- 三组件统一:`import { resolveManifestText, useI18n } from "@kabegame/i18n"`,`const { locale } = useI18n()`,渲染 label 用 `resolveManifestText(opt.label, locale.value)`。
- **`WallpaperStyleSetting.vue`**:删 `ALL_STYLES/nativeWallpaperStyles/styleOptions/systemOpt/isPlasma` 分支;`options = capabilities.stylesFor(mode)`;label=`resolveManifestText(opt.label,locale)`、desc=`resolveManifestText(opt.desc,locale)`。
- **`WallpaperTransitionSetting.vue`**:删硬编码 options;`options = capabilities.transitionsFor(mode)`;label 同上;`onMounted` 的 slide/zoom 硬名单纠正 → 改为「当前值不在 options 的 value 集则回落到 options[0]/none」的通用纠正。
- **`WallpaperModeSetting.vue`**:删硬编码 radio + `isPlasmaPluginAvailable`;`v-for` 渲染 `capabilities.modes`,label 同上;保留 native/plasma-plugin 切换确认弹窗。
- 前端 `settings.json` 里这批 key **不删**(可能他处引用),仅这三组件不再本地映射。

## 验证(Claude 独立执行,不采信 codex 自报)
- `deno task check -c kabegame`;android 另 `deno task check -c kabegame --mode android --skip vue`。
- 实机:切 native/window/plasma-plugin,核对样式/过渡列表与矩阵一致;老 `wallpaperStyle="system"` 启动后被迁移为 fill;轮播用对样式;macOS native 样式仅 fill。

## 决策记录
- 列表放置:trait 方法(styles/transitions)+ controller modes + 聚合命令。
- 返回粒度:`{value, label, desc}`,label/desc 为 **i18n map 对象**`{default,en,zh,ja,ko,zhtw}`(照搬 plugin `name` 形态),前端 `resolveManifestText` 解析、切语言免重取。
- settings 初始化:**启动处即落盘,不懒初始化**——新装在 `init_global` 就写出带 `schemaVersion` 的 settings.json。
- system:彻底去掉,列表提供全,删 native 读系统代码。
- 死代码:删 `refresh_desktop`;window 样式**全量**(此前「window 列空」判断有误已撤回,window 经 `wallpaper.ts` object-fit 支持全部样式)。
- macOS native 样式:仅 `fill`(macOS 实际填充模式)作唯一项。
- system 迁移:改为**版本化迁移框架**(仿 SQLite `storage::migrations`),`schemaVersion` 版本载体 + `v001_wallpaper_drop_system`(含 `WallpaperStyleByMode` map);`settings.rs`→`settings/mod.rs` + `settings/migrations/`。
- native·Windows 过渡:暴露 `[none, fade]`(已有 COM/SPIF 实现)。

## 验证补充(迁移)
- 造一个含 `"wallpaperStyle":"system"` 且无 `schemaVersion` 的旧 settings.json,启动后应被改写为 `"fill"` 且文件出现 `"schemaVersion":1`;二次启动 `run_pending` 直接返回(current≥LATEST)不再回写。
- 新装无文件:默认 `fill`,首次落盘带 `schemaVersion:1`。
