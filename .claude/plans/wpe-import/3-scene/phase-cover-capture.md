# 壁纸封面截取：用当前画面替换作者预览图

> 前置：[phase-3c-runtime-graph.md](phase-3c-runtime-graph.md) 点 0b（面板控制卡片与暂停）。用户先暂停到想要的那一帧，再设为封面。
> 范围：`x-wpe/web` 与 `x-wpe/scene`。`x-wpe/video` 没有属性面板，不在本阶段。

## 总体设计思路

WPE 壁纸的缩略图现在直接引用作者目录里的 `preview.*`，分辨率低，很多还是小 GIF。场景的退回画面（壁纸目标的 `previewPath`）用的也是它。本阶段加一个能力：把壁纸当前的画面截下来，存成应用自己的封面，换掉 `thumbnail_path`。作者的文件不动，可以恢复。

截取放在浏览器层，用 CEF 的 `ExecuteDevToolsMethod` 调 `Page.captureScreenshot`。这样网页和场景走同一条路，宿主和垫片都不用改。网页壁纸也只能这样：`file:` iframe 跨源，应用页读不到它的像素；iframe 里的页面内容是作者的，也不能指望它配合。合成器的输出里 WebGPU 画布和 iframe 都已经画好了。实测（`ignore/p3c/cover/`）：壁纸窗口整窗 3840×2160，约 0.6 s（PNG）；主窗口画布区域加 `clip.scale`，3840×2157，187 ms（JPEG）。

截取来源由父组件决定，和暂停的接线一样：设置页截壁纸窗口（桌面上那一份），预览截主窗口里的画布（预览这一份）。用户看到什么就截到什么，也包括暂停时停住的那一帧。

主窗口按区域截图有一个代价：盖在画布上的 UI 会一起截进去，实测有看板娘。所以截图前隐藏它，截完恢复。这段时间很短，闪一下可以接受。（「桌面预览」角标已删除，2026-11-05 用户。）

封面存进 `thumbnails_dir`，走现成的 `replace_image_thumbnail_path`，再发 `thumbnailPath` 字段补丁。这条路径的保护都是现成的：删除只删 `thumbnails_dir` 里的文件，所以替换和删图不会碰作者的 `preview.*`，自定义封面在换新封面、删图时会被清掉；整理流程不处理 WPE 行；重新导入时已有行直接跳过，不会冲掉封面；`thumbnailPath` 的补丁不触发列表刷新。

关键决策：
- **封面不走现成的 `generate_thumbnail_from_bytes`。** 它最长边 512，小文件还直接返回 `None`。封面同时是退回画面，会全屏显示，所以单独生成，最长边 1920，JPEG 质量 85。WPE 行就几十张，磁盘开销可以忽略。
- **只做手动。** 面板里一个按钮，由用户选帧，不做自动截取（见「已定」）。

## 现状锚点

**a. 缩略图取自作者文件**（`kabegame-core/src/crawler/wpe_import.rs:223`）
```rust
    let thumbnail_path = project
        .preview_path()                       // 现状：作者目录里的 preview.*，不复制
        .map(|path| path.to_string_lossy().trim_start_matches("\\\\?\\").to_string())
        .unwrap_or_default();
```

**b. 替换缩略图已有，旧文件按归属删除**（`kabegame-core/src/storage/images.rs:1316`、`:178`）
```rust
    pub fn replace_image_thumbnail_path(&self, image_id: &str, thumbnail_path: &str) -> Result<(), String> {
        // UPDATE images SET thumbnail_path …，路径变了再 remove_thumbnail_file_if_needed(旧路径)
    }
fn remove_thumbnail_file_if_needed(local_path: Option<&str>, thumbnail_path: Option<&str>) {
    // 只删除 Kabegame 自己生成、位于 `thumbnails_dir` 内的缩略图 —— 现状：作者的 preview.* 不会被删
}
```

**c. 字段补丁**（`kabegame-core/src/storage/organize.rs:745`、`emitter.rs:244`）
```rust
    changed_image_patches.push(ImageFieldPatch {
        id: id.to_string(),
        fields: serde_json::json!({ "thumbnailPath": thumb_str }).as_object().unwrap().clone(),
    });
    // 经 GlobalEmitter 的 emit_image_patches 发出；前端 imageViewRelevance 里 thumbnailPath 恒为 false，只打补丁不刷新
```

**d. 现成的缩略图生成不适合封面**（`crawler/downloader/compress.rs:563`、`:626`、`:613`）
```rust
pub const IMAGE_THUMBNAIL_MAX_DIM: u32 = 512;          // 现状：最长边 512
pub async fn generate_thumbnail_from_bytes(bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    if !browser_unsafe && !image_needs_independent_thumbnail(bytes.len() as u64) { return Ok(None); }   // 现状：小文件返回 None
}
async fn write_thumbnail_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> { /* thumbnails_dir/<uuid>.jpg */ }
```

**e. 退回画面也用缩略图**（`kabegame/src/commands/wallpaper.rs:108`）
```rust
fn scene_preview_of(info: &ImageInfo) -> Option<String> {
    // 现状：场景的 previewPath 取 thumbnail_path，换了封面这里自动跟着变
}
```

**f. 运行时给应用层暴露能力的写法**（`tauri-runtime-kbcef/src/lib.rs:61`、`kabegame/src/startup.rs:90`）
```rust
/// Start a native CEF download from the webview identified by `webview_label`.
pub fn start_download(webview_label: &str, url: &str) -> Result<(), String> {
    webview::start_download(webview_label, url)          // 现状：按 label 的自由函数；没有截图能力
}
```
`third/cef-rs` 的绑定已有 `execute_dev_tools_method` 与 `add_dev_tools_message_observer`，不用打补丁。

**g. 桌面画布**（`components/wallpaper/WallpaperDesktopCanvas.vue`）：按桌面逻辑尺寸排版，再 `scale` 进可用区域；实际画布是 wrapper 里的 `absolute origin-top-left overflow-hidden` 元素，`offsetWidth` 为桌面宽度。外层 wrapper 带留白，不能拿它的矩形截。

## 点 1 — 运行时：截图（`tauri-runtime-kbcef`）

- **新增**
```rust
/// `Page.captureScreenshot` 的裁剪区域，单位是页面 CSS 像素；`scale` 为放大倍数。
pub struct CaptureClip { pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub scale: f64 }

/// 截 `webview_label` 的窗口内容，返回图片字节。走 CEF 的 ExecuteDevToolsMethod，不依赖远程调试端口。
pub async fn capture_screenshot(webview_label: &str, clip: Option<CaptureClip>) -> Result<Vec<u8>, String>;
```
  - 在 CEF UI 线程上挂 `DevToolsMessageObserver`，调 `execute_dev_tools_method`，参数 `{ format: "jpeg", quality: 95, optimizeForSpeed: true, clip? }`；
  - `on_dev_tools_method_result` 按 `message_id` 匹配，解析 JSON 取 `data`，base64 解码，经 oneshot 回传；
  - 10 s 超时；observer 的 registration 用完释放。

## 点 2 — 生成封面（`kabegame-core/src/crawler/downloader/compress.rs`）

- **新增**
```rust
/// 壁纸封面最长边：封面同时是场景的退回画面，会全屏显示，比普通缩略图大。
pub const WALLPAPER_COVER_MAX_DIM: u32 = 1920;
const WALLPAPER_COVER_JPEG_QUALITY: u8 = 85;

/// 把截图缩到最长边不超过上限，写进 thumbnails_dir，返回路径。
pub async fn generate_wallpaper_cover(bytes: &[u8]) -> Result<PathBuf, String>;
```
  - 复用 `encode_jpeg_rgb`、`write_thumbnail_bytes`；解码与缩放放 blocking 线程。

## 点 3 — 命令（`kabegame/src/commands/wpe_web.rs`）

- **新增** 两个命令，只给应用页用，注册进 `generate_handler!`，门控 `#[cfg(feature = "wpe")]`（`40219e03` 起 WPE 在三个桌面平台都开启）。
```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CoverSource {
    /// 截壁纸窗口整窗（设置页）
    Wallpaper,
    /// 截主窗口的画布区域（预览）
    Main { x: f64, y: f64, width: f64, height: f64, scale: f64 },
}

/// 校验是网页或场景壁纸 → 截图 → 生成封面 → 替换 thumbnail_path → 发 thumbnailPath 补丁。返回新路径。
#[tauri::command]
pub async fn capture_wallpaper_cover(image_id: String, source: CoverSource) -> Result<String, String>;

/// 恢复作者预览图：读 project.json 的 preview_path（同导入，去掉 `\\?\`），没有时用 local_path（同 add_image 的兜底）。
#[tauri::command]
pub async fn restore_wallpaper_cover(image_id: String) -> Result<String, String>;
```
- **修改** `WpeWebPropertiesView` 加 `custom_cover: bool`：`thumbnail_path` 在 `thumbnails_dir` 里时为 true，面板据此显示「恢复默认封面」。

## 点 4 — 面板与接线（前端）

- **修改** `WpeWebPropertiesPanel.vue` 的控制卡片（点 0b）：加「设为封面」和「恢复默认封面」。
```ts
/** 新增：截取来源；undefined 表示没有实时实例，不显示。预览传函数，点击时才量画布区域；函数可返回 null 表示现在量不到 */
coverSource?: "wallpaper" | (() => Promise<CoverRegion | null>);
```
  - 只在网页、场景上显示；进行中按钮 loading；成功 toast；失败 toast 带错误。
  - 成功后 `customCover` 改为 true，恢复后改为 false。
  - i18n 加到五个语言的 `gallery.json`。
- **修改** `WpeWebPropertiesDialog.vue`：透传 `coverSource`。
- **修改** `Settings.vue`：窗口模式时传 `"wallpaper"`。
- **修改** `WallpaperDesktopCanvas.vue`：暴露截图区域。
```ts
defineExpose({
  /** 隐藏看板娘、等两帧、量画布矩形，回调结束后恢复。clip.scale = 画布 offsetWidth / 显示宽度 */
  withCaptureRegion<T>(run: (region: CoverRegion) => Promise<T>): Promise<T>,
});
```
  - 看板娘：`document.documentElement` 上加 `data-kb-cover-capture`，在看板娘组件的样式里按这个属性 `visibility: hidden`。`finally` 里移除，出错也要恢复。
- **修改** `ImagePreviewDialog.vue`：实时渲染时把 `coverSource` 传给面板。

> 说明：`withCaptureRegion` 是「区域 + 恢复」一体的，所以面板调的是传入的函数，由它包住 `invoke`。实现时按这个形状调整 `coverSource` 的签名即可，不要让隐藏和恢复分散在两处。

## 点 5 — 文档、回归与 changelog

- `cocs/wpe/WPE_IMPORT.md`：入库模型里说明封面可替换、作者文件不动、恢复方式。
- `src-tauri/tauri-runtime-kbcef/README.md`：`capture_screenshot`。
- `cocs/README.md` 的 WPE_IMPORT 条目摘要同步。
- `versions/latest/regression.md` 新增「壁纸封面截取」小节，用例见验收。
- `versions/latest/changelog.md` 用户侧 Added：「网页与场景壁纸可在属性面板把当前画面设为封面，替换作者的低清预览图，也可恢复默认封面」。

## 实施步骤

**步骤 1 — 运行时与后端**（子代理：点 1、点 2、点 3）。在 3c 步骤 0.6 通过审查之后做：都改面板与 `wpe_web.rs`。
- 验收：单测（验收第 1–3 条）；`check-kabegame` 0 error。

**步骤 2 — 前端**（子代理：点 4）
- 验收：单测（验收第 4 条）；`deno task test -c kabegame --skip cargo`、`check-kabegame` 全过。

**步骤 3 — 真机**（Claude 经 CDP 与截图；见验收「真机」）。

**步骤 4 — 文档**（子代理：点 5；Claude 填实测数值并核对）。

## 验收

**单测**
1. `generate_wallpaper_cover`：4K 输入缩到最长边 1920、比例不变；小图不放大；坏数据报错；文件在 `thumbnails_dir`。
2. 恢复路径：有 preview 时取 preview，没有时取 `local_path`；`\\?\` 前缀去掉。
3. `custom_cover`：路径在 `thumbnails_dir` 里为 true，作者文件为 false。
4. 面板：`coverSource` 为 undefined 时不显示；只在网页、场景上显示；`customCover` 决定恢复按钮；失败时有提示。`withCaptureRegion`：回调抛错时也恢复隐藏项。

**真机**（Windows dev；壁纸窗口为窗口模式时一并验）
- **预览 · 场景**：vortex 设为封面。网格缩略图立即换成新图、不整页刷新；封面 1920 宽，没有看板娘和留白，与画面一致。
- **预览 · 网页**：一张网页壁纸同上，确认跨源 iframe 的内容截到了。
- **暂停取帧**：暂停后设为封面，封面就是停住的那一帧；恢复后接着动。
- **设置页**：桌面是 bedroom 时从设置页设为封面，截到的是桌面这一份。dev 下壁纸窗口有调试面板，封面里会带上，release 没有，记进回归表。
- **退回画面**：不能实时渲染的场景不走本功能；能渲染的场景在加载超时或退回时显示新封面。
- **恢复**：恢复默认封面后回到作者的 `preview.*`，作者文件还在，自定义封面文件已删除。
- **重复与清理**：连续设两次封面，旧文件被删除；删除图片记录时封面文件被删除、作者文件还在。
- **重新导入**：重新收集壁纸后封面保留。
- **截取过程**：`clip.scale` 放大时，预览画面与宿主不闪烁、不重新加载（`stats().recompiled` 不变）；看板娘恢复显示。
- **没有调试端口**：`KABEGAME_CEF_DEBUG_PORT=0` 跑 dev，截取照常工作，确认不依赖远程调试。

## 风险

1. **UI 盖在画布上**：只隐藏已知的看板娘。截图瞬间冒出的 toast 等仍可能进封面；点击是在面板上，切换箭头不会被触发。
2. **`clip.scale` 的副作用**：Chromium 为此做一次临时模拟，可能引起一帧闪烁或 iframe 尺寸事件。目前只实测了结果正确，有问题就退回 `scale: 1`，封面约 1070 宽，仍比作者预览清楚。
3. **窗口不可见**：主窗口被完全遮挡时画布尺寸可能量成 0（实测过）。按钮是用户在这个窗口里点的，正常走不到；量到 0 时报错提示，不截。
4. **release 行为**：`ExecuteDevToolsMethod` 按 CEF 文档不依赖远程调试端口，用 `KABEGAME_CEF_DEBUG_PORT=0` 验证。

## 已定（2026-11-05 用户）

1. **只做手动**：不做自动截取。刚加载的画面往往不是最好的一帧，而且只有实时渲染过的壁纸才截得到，图库里会新旧混杂。
2. 预览里的「桌面预览」角标已删除，不再需要在截图时隐藏。

## 后续

- `x-wpe/video` 也有低清 `preview.gif`。它们能直接从视频抽帧，不需要本功能；要做时走现有的视频缩略图路径。
- 不能实时渲染的场景截不到真实画面，要等渲染能力解锁。
