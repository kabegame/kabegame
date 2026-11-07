# P3-0a — 场景宿主与应用之间的通路

> 上级：[phase-3-0-scene-host.md](phase-3-0-scene-host.md)。下一步：[phase-3-0b-renderer-move.md](phase-3-0b-renderer-move.md)。

## 总体设计思路

场景宿主当成一张特殊的网页壁纸。这一步只打通它和应用之间的通路，不搬渲染器：MVP 宿主（一块清屏画布）按下面的协议跑通，3-0b 再把渲染器装进去。

宿主 iframe 的地址带两个参数：`kbScene=<图片 id>`、`kbInstance=<实例号>`。IPC 来源去掉了 query，后端认不出宿主渲染的是哪张、是哪个实例，所以都由宿主显式带上。同一窗口可能同时有预览与应用背景两个宿主，实例号用来区分它们。

三条通路：
- **用户属性**：沿用网页壁纸垫片 `wpe_shim.js`。宿主是顶层的直接子 `file:` iframe，垫片本来就在里面运行。
  - 垫片拉取时把 `kbScene` 作为 `imageId` 带上；`wpe_web_pull_state` 多认一种调用方：宿主文档 + 库里的场景壁纸 id，返回与网页壁纸同形的状态。
  - 其余照旧：`applyUserProperties` 首次全量、之后只给变了的键；按本张 `metadataId` 补丁重拉；在壁纸窗口应答 ping。
- **暂停与音量（父页面 → 宿主）**：沿用网页壁纸现有的音量消息（`postMessage`，垫片启动时请求、父页面回复、变化时再推），消息多带一个 `paused`，垫片在值变化时调页面的 `wallpaperPropertyListener.setPaused(paused)`。
  - `setPaused` 是 WPE 网页 API 本来就有的回调，网页壁纸一并得到它。
  - 父页面一侧（3-0b 的 `WpeSceneView`）回应自己那个宿主 iframe 的请求，与 `WallpaperStage` 回应 web 层 iframe 同一套协议。
- **状态与日志（宿主 → 应用）**：宿主调 `wpe_scene_report`。
  - `ready` / `fallback(reasons)`：后端以 `wpe-scene-status` 事件 `emit_to` 调用方所在窗口，应用页按实例号认领；
  - `log`：写进应用日志。

另外两项：场景目录与 `sceneAssets` 由宿主命令 `wpe_scene_target` 按 id 取；桌面鼠标转发对场景壁纸也打开。

关键决策：暂停与音量走现有的音量消息（用户定，2026-11-02）。这是宿主与应用之间唯一一处 `postMessage`，用的是网页壁纸已有的协议，不新开通道；宿主里的垫片因此也拿得到音量，P6 场景出声时不会被压成 0。

## 现状锚点

**a. 拉状态只按文档目录认网页壁纸**（`src-tauri/kabegame/src/commands/wpe_web.rs`）
```rust
pub async fn wpe_web_pull_state(caller: tauri::ipc::CallerOrigin) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    // 现状：宿主文档不在网页壁纸目录里 → 报 not inside a web wallpaper
    let id = index.image_id_of(&doc).ok_or("not inside a web wallpaper")?;
    let (state, raw) = build_wpe_web_state_with_raw(&id).await?.ok_or_else(|| "web wallpaper row missing".to_string())?;
    index.replace_grants(&id, user_file_grants(&raw));
    Ok(state)
}
// 现状：build_wpe_web_state 对不是 x-wpe/web 的行返回 None
```

**b. 垫片已在宿主里启用，但拉取不带参数、音量消息只有音量**（`src-tauri/kabegame/src/webview_js/wpe_shim.js`）
```js
var direct = window !== window.top && window.parent === window.top && location.protocol === "file:";
if (!direct || !internals || window.__kbWpeShim) return;   // 现状：宿主满足条件，垫片照常启用
// …
pull: function () {
  return internals.invoke("wpe_web_pull_state");             // 现状：宿主里拉取失败
},
// …
if (!data || typeof data !== "object" || data.type !== VOLUME_MESSAGE || typeof data.volume !== "number") return;
hostVolume = clamp01(data.volume);                           // 现状：只取音量，没有 setPaused
```

**c. 音量协议的消息类型**（`apps/kabegame/src/components/wallpaper/wpeWebVolume.ts`）
```ts
export interface WpeVolumeMessage {
  type: typeof WPE_VOLUME_MESSAGE;
  /** 0…1：页面的生效音量 = 页面自己设的音量 × 这个值。 */
  volume: number;                 // 现状：没有 paused
}
```

**d. 宿主命令只有一条**（`src-tauri/kabegame/permissions/wpe-scene-host.toml`）
```toml
commands.allow = ["get_wpe_scene_postprocess"]
```

**e. 桌面鼠标转发只开给网页壁纸**（`src-tauri/kabegame/src/wallpaper/manager/window.rs`）
```rust
let is_web = web_entry(Path::new(file_path))?.is_some();
// …
wp.set_mouse_forwarding(is_web);   // 现状：场景壁纸在桌面收不到指针
```

**f. MVP 宿主只清屏**（`apps/wpe-scene/src/main.ts`）：不读 query、不调 IPC。

## 点 1 — 拉取认场景宿主（`commands/wpe_web.rs`、`wallpaper/wpe_scene_host.rs`、`wallpaper/wpe_web_dir_index.rs`）
- **修改** `wpe_web_pull_state` 加可选参数 `image_id`：
```rust
#[tauri::command]
pub async fn wpe_web_pull_state(
    caller: tauri::ipc::CallerOrigin,
    image_id: Option<String>, // 新增：场景宿主带上自己渲染的图片 id；网页壁纸不传，传了也不看
) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    if let Some(id) = index.image_id_of(&doc) {
        // 原逻辑不变
    }
    // 新增：宿主文档按参数认，参数必须是库里的场景壁纸；场景没有 file / directory 放行，不写 grants
    if wpe_scene_host::is_host_document(&doc) {
        let id = image_id.ok_or("the scene host must pass imageId")?;
        if !index.is_scene(&id) {
            return Err("not a scene wallpaper in the library".into());
        }
        return build_wpe_web_state(&id).await?.ok_or_else(|| "scene wallpaper row missing".into());
    }
    Err("not inside a web wallpaper".into())
}
```
- **修改** `build_wpe_web_state(_with_raw)` 接受 `x-wpe/scene` 行，`directories` 为空。
- **新增** `wpe_scene_host::is_host_document(&Path)`：与宿主入口按 `file_path_key` 比较。
- **新增** `WpeWebDirIndex::is_scene(&str)`。
- 单测：场景状态的 `user[key].value` 与 `get_wpe_web_properties` 的 `items[].value` 同形（3-0b 的编译管线靠它拿到与迁移前相同的值）。

## 点 2 — 宿主命令（`commands/wpe_scene.rs`、`permissions/wpe-scene-host.toml`、`lib.rs`）
- **新增** 两条命令，写进 `wpe-scene-host.toml` 的 `commands.allow` 与 `generate_handler!`：
```rust
/// 场景目录与 WPE assets 目录（同 build_wallpaper_target 的 sceneAssets）；不是库里的场景壁纸报错。
#[tauri::command]
pub async fn wpe_scene_target(image_id: String) -> Result<WpeSceneTarget, String>;

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WpeSceneReport {
    Ready { instance: String },
    Fallback { instance: String, reasons: Vec<String> },
    Log { level: String, message: String },
}
/// 状态：emit_to(调用方 webview label, "wpe-scene-status", { instance, kind, reasons? })，只送回宿主所在窗口。
/// 日志：按 level 写 tracing（target `kabegame::wpe_scene_host`，消息带窗口 label；不带 `kabegame` 前缀的 target 按依赖只放行 warn）。
#[tauri::command]
pub fn wpe_scene_report<R: tauri::Runtime>(webview: tauri::Webview<R>, report: WpeSceneReport) -> Result<(), String>;
```

## 点 3 — 垫片（`webview_js/wpe_shim.js`、`wpeWebVolume.ts`）
- **修改** 拉取带上图片 id：
```js
var sceneImage = new URLSearchParams(location.search).get("kbScene");   // 新增：只有场景宿主的地址带它
pull: function () {
  return internals.invoke("wpe_web_pull_state", sceneImage ? { imageId: sceneImage } : {});   // 修改
},
```
- **修改** 音量消息带 `paused`。
  - 垫片记下最后的值，变化时 `call("setPaused", paused)`；
  - 页面 `load` 前收到的值，在首次全量交付后补调一次；
  - 缺 `paused` 的旧消息按 `false`。
```ts
export interface WpeVolumeMessage {
  type: typeof WPE_VOLUME_MESSAGE;
  volume: number;
  /** 新增：宿主是否暂停；垫片转成页面的 wallpaperPropertyListener.setPaused（WPE 网页 API） */
  paused: boolean;
}
```
- **修改** `WallpaperStage` 的 `postWebVolume` 带上 `props.paused`：网页壁纸也开始收到 `setPaused`。
- `wpeWebVolume.test.ts` 读垫片源码核对常量，随之更新。

## 点 4 — 桌面鼠标转发（`wallpaper/manager/window.rs`）
- **修改** 场景壁纸也开转发：
```rust
let is_web = web_entry(Path::new(file_path))?.is_some();
let is_scene = /* 新增：read_project 读到的类型为 WpeKind::Scene（只 Windows） */;
wp.set_mouse_forwarding(is_web || is_scene);   // 修改
```

## 点 5 — MVP 宿主接上通路（`apps/wpe-scene`）
- **修改** `package.json` 加 `@tauri-apps/api`（根 `node_modules` 已有，不装包；`deno.lock` 的 workspace 成员记录同步改）。
- **修改** `main.ts`：只为验证通路，3-0b 换成真正的渲染。
```ts
const params = new URLSearchParams(location.search);
const instance = params.get("kbInstance") ?? "";
let paused = false;   // 清屏循环暂停时不画
let ready = false;

// 垫片拉到状态后回调 applyUserProperties；首包到达即报 ready，日志记下收到的键
window.wallpaperPropertyListener = {
  applyUserProperties(changed) {
    void report({ kind: "log", level: "info", message: `applyUserProperties ${Object.keys(changed).join(",")}` });
    if (!ready) { ready = true; void report({ kind: "ready", instance }); }
  },
  setPaused(value) { paused = value; },
};
```

## 点 6 — 文档与回归
- `cocs/wpe/WPE_SCENE.md`「场景宿主」：地址参数、三条通路、命令与事件。
- `cocs/wpe/WPE_IMPORT.md`：垫片拉取的 `imageId`、音量消息的 `paused` 与 `setPaused`（网页壁纸也受影响）。
- ACL 文档的宿主命令清单、`cocs/README.md` 的摘要。
- 回归表（网页壁纸的预览暂停要补一条 `setPaused`）、changelog。

## 验收
dev、主窗口，CDP 由应用页建宿主 iframe（地址带 `kbScene` / `kbInstance`），并在应用页里临时代 3-0b 回应这个 iframe 的音量请求。
- **属性**：
  - 宿主里垫片拉取成功；首次 `applyUserProperties` 的值与应用页 `get_wpe_web_properties` 的值逐键相同；
  - 应用页改一项属性（`set_wpe_web_user_properties`，验完改回）后，宿主只收到变了的键。
- **拒绝**：
  - `kbScene` 为网页壁纸 id 或不存在的 id：报 `not a scene wallpaper in the library`；
  - 不带 `kbScene`：报 `the scene host must pass imageId`。
- **状态**：应用页收到本实例的 `ready`，另一实例的不收；宿主日志出现在应用日志里。
- **暂停**：
  - 给实例 a 推 `paused: true`，只有 a 停画（宿主计数器可见），再推 `false` 恢复；
  - 网页壁纸预览按暂停时，页面的 `setPaused` 被调用。
- **网页壁纸不受影响**：照常拉状态，传 `imageId` 也被忽略。
- **检查**：
  - 新增单测通过：拉取认场景宿主、`is_scene`、场景状态同形、report 反序列化、垫片的 `paused` 常量；
  - `check-kabegame` 0 error，宿主 `typecheck` 0 error。
- **桌面鼠标转发**：壁纸窗口为窗口模式时验证场景下转发打开；不是窗口模式就记为未测，不改用户的壁纸设置。
