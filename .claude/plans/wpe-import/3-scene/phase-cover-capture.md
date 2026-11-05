# 壁纸封面截取：用当前画面替换作者预览图

> 前置：[phase-3c-runtime-graph.md](phase-3c-runtime-graph.md) 点 0b（面板控制卡片与暂停）。用户先暂停到想要的那一帧，再设为封面。
> 范围：`x-wpe/web` 与 `x-wpe/scene`。`x-wpe/video` 没有属性面板，不在本阶段。

## 总体设计思路

WPE 壁纸的缩略图现在直接引用作者目录里的 `preview.*`，分辨率低，很多还是小 GIF。场景的退回画面（壁纸目标的 `previewPath`）用的也是它。本阶段加一个能力：把壁纸当前的画面截下来，存成应用自己的封面，换掉 `thumbnail_path`。作者的文件不动，可以恢复。

截取放在浏览器层，用 CEF 的 `ExecuteDevToolsMethod` 调 `Page.captureScreenshot`。这样网页和场景走同一条路，宿主和垫片都不用改。网页壁纸也只能这样：`file:` iframe 跨源，应用页读不到它的像素；iframe 里的页面内容是作者的，也不能指望它配合。合成器的输出里 WebGPU 画布和 iframe 都已经画好了。实测主窗口整窗约 100 ms（JPEG）。

入口只有预览：详情栏的属性面板里设为封面，截的是预览这一份，也包括暂停时停住的那一帧。设置页的属性弹窗没有封面按钮（见「已定」）。

截图不带 `clip`，截整窗后在 Rust 里裁出画布。`clip` 靠临时改视口实现，这次改动就画在屏幕正在显示的表面上，整个窗口会跳变（见「修正」）。所以封面分辨率等于画布的屏幕像素：当前窗口约 1071 宽，最大化约 1800 宽（估算）。封面主要显示在网格卡片里，够用（2026-11-05 用户）。

按钮只在画面确定实时渲染时显示：场景看 `WallpaperStage` 的 `sceneLive`（出了首帧才为真，退回预览图时为假），网页壁纸看 `ready`。这个状态由预览弹窗传给面板，后端不记任何东西，也不再校验。开着应用背景时主窗口还有一个同图的宿主，但 `sceneLive` 属于预览自己的 Stage，不会混淆。

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
/// 截 `webview_label` 的整个内容区，返回图片字节。走 CEF 的 ExecuteDevToolsMethod，不依赖远程调试端口。
/// 故意不提供 `clip`，要局部就截完自己裁。
pub async fn capture_screenshot(webview_label: &str) -> Result<Vec<u8>, String>;
```
  - 在 CEF UI 线程上挂 `DevToolsMessageObserver`，调 `execute_dev_tools_method`，参数 `{ format: "jpeg", quality: 95, optimizeForSpeed: true }`；
  - `on_dev_tools_method_result` 按 `message_id` 匹配，解析 JSON 取 `data`，base64 解码，经 oneshot 回传；
  - 10 s 超时；observer 的 registration 用完释放。

## 点 2 — 生成封面（`kabegame-core/src/crawler/downloader/compress.rs`）

- **新增**
```rust
/// 壁纸封面最长边：封面同时是场景的退回画面，会全屏显示，比普通缩略图大。
pub const WALLPAPER_COVER_MAX_DIM: u32 = 1920;
const WALLPAPER_COVER_JPEG_QUALITY: u8 = 85;

/// 截图里要留下的区域：都是占整张截图宽高的比例。
pub struct CoverCrop { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

/// 按 `crop` 裁剪（None 表示整张），缩到最长边不超过上限，写进 thumbnails_dir，返回路径。
pub async fn generate_wallpaper_cover(bytes: &[u8], crop: Option<CoverCrop>) -> Result<PathBuf, String>;
```
  - 复用 `encode_jpeg_rgb`、`write_thumbnail_bytes`；解码、裁剪与缩放放 blocking 线程。
  - 裁剪边界向内取整，不把画布外的像素带进封面；区域落在截图外时报错。

## 点 3 — 命令（`kabegame/src/commands/wpe_web.rs`）

- **新增** 两个命令，只给应用页用，注册进 `generate_handler!`，门控 `#[cfg(feature = "wpe")]`（`40219e03` 起 WPE 在三个桌面平台都开启）。
```rust
/// 校验是网页或场景壁纸 → 截主窗口 → 按 `region` 裁出画布、生成封面 → 替换 thumbnail_path → 发 thumbnailPath 补丁。返回新路径。
#[tauri::command]
pub async fn capture_wallpaper_cover(image_id: String, region: CoverCrop) -> Result<String, String>;

/// 恢复作者预览图：读 project.json 的 preview_path（同导入，去掉 `\\?\`），没有时用 local_path（同 add_image 的兜底）。
#[tauri::command]
pub async fn restore_wallpaper_cover(image_id: String) -> Result<String, String>;
```
- **修改** `WpeWebPropertiesView` 加 `custom_cover: bool`：`thumbnail_path` 在 `thumbnails_dir` 里时为 true，面板据此显示「恢复默认封面」。

## 点 4 — 面板与接线（前端）

- **修改** `WpeWebPropertiesPanel.vue` 的控制卡片（点 0b）：加「设为封面」和「恢复默认封面」。
```ts
/** 新增：包住一次截取，点击时才量画布区域，命令在回调里发出；undefined 时不显示封面按钮。设置页不传 */
coverSource?: CoverRegionScope;
/** 新增：画面确定在实时渲染。为假时只能恢复、不能设为封面 */
coverReady?: boolean;
```
  - 只在网页、场景上显示；进行中按钮 loading；成功 toast；失败 toast 带错误。
  - 成功后 `customCover` 改为 true，恢复后改为 false。
  - i18n 加到五个语言的 `gallery.json`。
- **新增** `WallpaperStage.vue` 发 `sceneLive` 事件，`WpeWallpaperContent.vue`、`ImageContent.vue` 转发。
- **修改** `WallpaperDesktopCanvas.vue`：暴露截图区域。
```ts
defineExpose({
  /** 隐藏看板娘、等两帧、量画布矩形并换算成占窗口的比例，回调结束后恢复。窗口不可见或量成 0 时报错，不调回调 */
  withCaptureRegion<T>(run: (region: CoverRegion) => Promise<T>): Promise<T>,
});
```
  - 看板娘：`document.documentElement` 上加 `data-kb-cover-capture`，在看板娘组件的样式里按这个属性 `visibility: hidden`。`finally` 里移除，出错也要恢复。
- **修改** `ImagePreviewDialog.vue`：有实时实例时传 `coverSource`；`coverReady` 场景取 `sceneLive`，网页取 `ready`，切图和关闭时复位。

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
1. `generate_wallpaper_cover`：4K 输入缩到最长边 1920、比例不变；小图不放大；坏数据报错；文件在 `thumbnails_dir`；先裁后缩，只留区域内的像素，边界向内取整，区域在截图外时报错。
2. 恢复路径：有 preview 时取 preview，没有时取 `local_path`；`\\?\` 前缀去掉。
3. `custom_cover`：路径在 `thumbnails_dir` 里为 true，作者文件为 false。
4. 面板：`coverSource` 为 undefined 时不显示；`coverReady` 为假时不显示设为封面、恢复按钮还在；只在网页、场景上显示；`customCover` 决定恢复按钮；失败时有提示。`withCaptureRegion`：回调抛错时也恢复隐藏项。
5. `WallpaperStage`：`sceneLive` 出首帧后才为真，退回时不发。

**真机**（Windows dev）
- **预览 · 场景**：设为封面。网格缩略图立即换成新图、不整页刷新；封面是画布的屏幕像素，没有看板娘和留白，与画面一致。
- **预览 · 网页**：一张网页壁纸同上，确认跨源 iframe 的内容截到了。
- **暂停取帧**：暂停后设为封面，封面就是停住的那一帧；恢复后接着动。
- **设置页**：属性弹窗没有封面按钮，暂停与清空存储还在。
- **退回画面**：不能实时渲染的场景没有「设为封面」；能渲染的场景在加载超时或退回时显示新封面。
- **恢复**：恢复默认封面后回到作者的 `preview.*`，作者文件还在，自定义封面文件已删除。
- **重复与清理**：连续设两次封面，旧文件被删除；删除图片记录时封面文件被删除、作者文件还在。
- **重新导入**：重新收集壁纸后封面保留。
- **截取过程**：屏幕采帧上窗口不跳变（只看 `stats` 发现不了，宿主收不到尺寸事件）；宿主不重新加载（`stats().recompiled` 不变）；看板娘恢复显示。
- **没有调试端口**：`KABEGAME_CEF_DEBUG_PORT=0` 跑 dev，截取照常工作，确认不依赖远程调试。

## 风险

1. **UI 盖在画布上**：只隐藏已知的看板娘。截图瞬间冒出的 toast 等仍可能进封面；点击是在面板上，切换箭头不会被触发。
2. **封面清晰度跟窗口大小走**：封面是画布的屏幕像素，窗口开得小，封面也小。要最清楚就最大化再截。
3. **窗口不可见**：主窗口被完全遮挡时矩形可能量成 0，也可能量得出来但截到残缺的画面（都实测过）。按钮是用户在这个窗口里点的，正常走不到；`document.visibilityState` 不是 `visible` 或量到 0 时报错提示，不截。
4. **release 行为**：`ExecuteDevToolsMethod` 按 CEF 文档不依赖远程调试端口，用 `KABEGAME_CEF_DEBUG_PORT=0` 验证。

## 已定（2026-11-05 用户）

1. **只做手动**：不做自动截取。刚加载的画面往往不是最好的一帧，而且只有实时渲染过的壁纸才截得到，图库里会新旧混杂。
2. 预览里的「桌面预览」角标已删除，不再需要在截图时隐藏。
3. **不用 `clip`，截整窗后自己裁**：缩略图不需要那么高精度，不闪优先。
4. **只在渲染确定成功时显示按钮**，不为这个在后端加状态。
5. **设置页不做封面**：设置页的宿主在壁纸窗口，要知道它的状态就得加后端状态，不值得。设置页截整窗本身验证过可行（C4，已删）。

## 后续

- `x-wpe/video` 也有低清 `preview.gif`。它们能直接从视频抽帧，不需要本功能；要做时走现有的视频缩略图路径。
- 不能实时渲染的场景截不到真实画面，要等渲染能力解锁。
- 想要预览也截到全分辨率时有两条路，都没做：场景宿主自己读回 WebGPU 画面（只对场景有效，网页壁纸仍走裁剪，变成两条路径）；或给 CEF 打补丁放开子 frame 截图（见「修正」）。

## 修正（2026-11-05，真机验收之后）

下面「实施记录 / 真机」的 C12、C15、C16 未通过，改法：

1. **C12 整窗跳变**：跳变来自 `clip` 本身，不是 `scale`。Chromium 的 `PageHandler::CaptureScreenshot` 只要有 `clip` 就改 `viewport_offset` / `viewport_scale`，并把 view `SetSize` 成裁剪框大小，这些都发生在屏幕正在显示的表面上。没有 `clip` 也没有设备模拟时不改任何参数。所以运行时去掉 `clip`，预览截整窗后在 `generate_wallpaper_cover` 里裁。
2. **C15 遮挡**：`withCaptureRegion` 判 `document.visibilityState`。
3. **C16 第二次预览**：删掉后端的实时场景表，按钮改由预览自己的 `sceneLive` 决定（点 4）。一度改成按 `(窗口, frame)` 记并接 `SubframeDestroyed`，用户否决：为这个加一张表太复杂。复测时又发现 `sceneLive` 变真后图层还要淡入 800 ms，这时截到黑底，所以 `withCaptureRegion` 量矩形前先等画布里的 `CSSTransition` 结束。
4. **没走的路 · 直接截 iframe target**：实测不行。两个窗口的场景宿主 iframe 都能 attach，但 `Page.captureScreenshot` 返回 `Command can only be executed on top-level targets`，由 `AssureTopLevelActiveFrame` 拦下。子 frame 的 view 实现了 `CopyFromSurface`，打 CEF 补丁放开后走无 `clip` 分支理论上可行，还能省掉看板娘隐藏和画布测量；代价是多一个补丁、重编 CEF、运行时要处理 DevTools session。预览的 iframe 在 CSS `scale` 下，网页内容的光栅化很可能跟屏幕显示一样糊（推断，未实测）。对缩略图不值得。

## 实施记录

### 真机（2026-11-05）

Windows dev，dev 进程 21:44 启动。脚本、日志和截图在 `ignore/p3c/cover-test/`。结果与数字的完整表格在 `versions/latest/regression.md`「壁纸封面截取」C1–C18。

**通过**：预览场景与网页（C1、C2）、暂停取帧（C3）、设置页（C4）、退回场景没有按钮且命令被拒（C5）、当前壁纸校验（C6）、恢复（C7）、重复与清理（C8）、删除记录（C9）、重新导入（C10）、宿主不重载（C11）、合并回归（C14）。

**未通过，等决定**：

1. **`clip` 让整个窗口闪一下**（C12，风险 2）。默认 `clip.scale` 时，屏幕采帧看到整个窗口换成放大的画布约 180 ms，宿主和页面都没收到尺寸事件，所以只看 `stats().recompiled` 发现不了。`scale: 1` 同样闪：`clip` 的偏移本身就走模拟。CDP 不带 `clip` 截整窗 106 ms，屏幕上没有对应的变化，壁纸窗口的整窗截取同样不闪。计划的退路（退回 `scale: 1`）不成立。可选方向：截整窗再按矩形裁剪，分辨率是画布的屏幕像素（当前窗口 1071 宽），代价是封面比现在小，也要决定够不够用。
2. **遮挡时截到垃圾图**（C15，风险 3）。文档写的「量到 0 时报错」只覆盖第一次打开。之后画布矩形正常，`withCaptureRegion` 放行。复现：主窗口完全被遮挡（`document.visibilityState === "hidden"`），打开过一次预览后再打开，点「设为封面」。
3. **实时场景表不随宿主销毁清理**（C16）。`live_scenes` 只在 `fallback` 时移除，预览第二次打开时 `wpe_scene_is_live` 直接返回 true，按钮在宿主创建之前就出现。复现：预览 12889 并关闭，再打开，80 ms 内点按钮。封面是放大的画廊加半透明遮罩。

**部分验证**：

- C13：壁纸窗口前后数字一致；主窗口的截取前基线丢了（测 C15 时以为会在前端报错，结果真的截了），只有截取后的数字。
- C17：`previewPath` 跟随封面，没有触发能渲染的场景实际走退回。

**未测**：C18，`KABEGAME_CEF_DEBUG_PORT=0`。这轮不重启进程，要在打包版上手动确认。

**环境记录**：

- 主窗口多数时间被 VS Code 完全遮挡（`hidden`，rAF 0），21:46–22:12、22:15–22:43 都在等。后来窗口被移到 x = −475，大半被遮，`scale: 1` 的屏幕对比只能看露出的窄条。
- 预览开着、完全不截取时，屏幕采帧也偶尔有单帧（约 20 ms 内）整窗变白或露出画廊，5 s 内 1–2 次。和本功能无关，没有查原因。
- 12888 开测前已有一张 21:25 的自定义封面（不是这轮生成的）。按要求恢复默认，文件已删除，备份在 `ignore/p3c/cover-test/backup/12888-pre-existing-cover.jpg`。

### 复测（2026-11-05，改完「修正」之后）

脚本 `ignore/p3c/cover-test/t14.mjs`、`t15.mjs`、`t16.mjs`，跳变检测见 scratchpad 的 `flash_outliers.py`（已用旧采帧校验：`clip` 约 120，空闲最高 7.1）。C12、C15、C16 通过，C1、C2、C3、C5、C11、C19 重测通过，数字在回归表。C7–C10、C14、C17 的写入路径没变，没有重测。C18 仍待打包版手动确认。
