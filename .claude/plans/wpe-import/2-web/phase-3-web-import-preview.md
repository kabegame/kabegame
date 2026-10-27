# Phase 3 — Web 导入 + 预览内嵌

> 状态：方案（2026-10-26）。上级：[PLAN.md](PLAN.md)。前置：Phase 2 已完成（[phase-2-wallpaper-vue.md](phase-2-wallpaper-vue.md)），
> `WallpaperStage` 已是 props 驱动的纯组件，支持 `paused` / `interactive`，可在任意容器里铺满父元素。
>
> 范围：`x-wpe/web` 入库；`/wpe` 目录服务补网页 MIME；CSP 放行页面源；`WallpaperStage` 加跨源 iframe 分支；
> 图库侧按 phase-2 文档「留给 Phase 3 的接入点」3-a / 3-b / 3-c 接入（非视频 WPE 行的原图形态与预览「桌面画布」）；
> 分流护栏对 `x-wpe/web` 的审计。**不做**：垫片注入与 `postMessage` 协议（Phase 5）、暂停冻结与 FPS（Phase 6）、
> 用户属性与 `file` / `directory`（Phase 7）、音频 / 媒体（Phase 8）。

## 总体设计思路

Phase 3 让一个 WPE 网页壁纸第一次在 Kabegame 里「跑起来」，但只跑到「无属性」状态：页面按原目录加载、相对资源全部可达、
在预览和桌面里都能看到并能点击，作者脚本自己能做的事都能做；它收不到任何 WPE 接口回调，这是 Phase 5 的事。
这一刀切在这里，是因为目录服务、MIME、CSP、iframe 隔离、预览画布这几件事都与接口无关，而且 Phase 1 实测里有两项
正是卡在这里没法验证（`.html` 被当成 `application/octet-stream`，库里没有 web 行）。

入库沿用第一阶段的目录模型：一个壁纸目录一行，`local_path` 是目录，`type` 是 `x-wpe/web`，`thumbnail_path` 直接引用
作者的 `preview.*`。与视频行的唯一差别是 Web 行没有可播放媒体，`compatible_path` 留空；`hash` 与 `size` 取入口 html，
宽高留空（页面没有固有尺寸）。导入分派只是在 `run_builtin_wpe_import` 的 `match` 里多一支，`import_wpe_web` 与
`import_wpe_video` 共享 `join_album` / `apply_wpe_tags` / metadata 写入这些已有步骤。扫描计数把「可导入」口径从
「video」改成「Kabegame 已支持的类型」，对话框文案跟着从「视频壁纸」改成「壁纸」。

页面资源经第一阶段已有的 `/wpe/<id>/<rel>` 服务读取。它今天的 MIME 来自媒体格式表派生的 `mime_by_ext`，网页类型
（html / js / css / json / svg / 字体 / wasm）一概没有，所以入口页根本渲染不出来。网页类型不进 `MEDIA_FORMATS`，
因为那张表是「可入库的媒体格式」的唯一事实来源，塞网页类型会污染 `supported_media_extensions` 一类派生；改为给
`/wpe` 单独一张静态表 `WPE_WEB_MIME`，查不到再回落 `mime_from_path`，仍然查不到才是 `application/octet-stream`。
`.html` 响应的产出点单独抽成一个函数，Phase 5 在那里插入垫片 `<script>`，本 Phase 只是原样返回。

页面在壁纸层里以**跨源 iframe** 承载：`WallpaperStage` 对 `type === "x-wpe/web"` 的目标渲染一个 iframe，`src` 指向
本地 HTTP 服务的 `/wpe/<id>/`（跟随 307 到入口），源是 `http://127.0.0.1:<port>`，与应用前端不同源，Phase 1 已实测
页面拿不到 Tauri 全局、伪造 IPC 被调用密钥挡住。iframe 不参与 base / top 双层过渡：双层过渡的本质是「两份可同时渲染
的静态媒体」交叉淡入淡出，而两个同时存活的 iframe 意味着两个渲染进程、两份作者脚本同时跑，切换期间还会让旧页面
继续吃 CPU。所以 Web 分支是独立的第三层：进入时把当前媒体层（img / video / tile）按现有过渡淡出、iframe 淡入；
离开时反过来，并在过渡结束后**销毁** iframe 元素（置 `src` 为 `about:blank` 再移除），让渲染进程回收。这保证了
「切走即销毁」，也避开了 Phase 2 刻意保留的 base / top 元素交换逻辑。

图库侧接入点不是 `ImageContent` 的替代，而是它的一个新 mode：`ImageContent` 保留缩略图 → 原图的降级链条，只在
非视频 WPE 行（web，以及未来的 scene）要以原图形态显示时切到 `WpeWallpaperContent` → `WallpaperStage`。
`x-wpe/video` 不走这里，继续 `<video>` 链，预览保留 `VideoControls` 与 seek（总纲决策 8）。预览弹窗再把它放进
`WallpaperDesktopCanvas`：按主显示器逻辑分辨率给一块固定尺寸的画布，整体 `scale` 进弹窗可用区域，用户看到的是设到
桌面上的样子，并且能交互。应用背景层用的是同一个 `ImageContent prefer="original"`，所以 Web 行会自动落到 wallpaper
mode——背景层里跑一个第三方页面是否可接受，留作关键决策，默认按「退回缩略图」实现，理由见决策节。

目标获取经新命令 `get_wallpaper_target_for_image(imageId)`，复用 Phase 2 抽出的 `build_wallpaper_target`，所以预览与
桌面拿到的是同一份目标结构。本 Phase 不引入新的设置 key，不改 settings 架构。

页面源的稳定性（端口随机 → `localStorage` 不持久）、`file` / `directory` 属性、IPC 纵深防御这几件事都会影响 Phase 5
以后的形态，但都不阻塞「无属性」页面跑起来，所以本 Phase 按默认路线实现并在文末列为关键决策，由用户拍板后在对应
Phase 落地。

## 现状锚点

**a. 导入分派只有 Video 一支**（`src-tauri/kabegame-core/src/crawler/wpe_import.rs:342`）
```rust
        match &project_result {
            Ok(project) if project.kind == WpeKind::Video => {          // 现状：只有 Video
                if run.params.is_dry_run { /* 记 dry-run 跳过 */ } else {
                    match import_wpe_video(&task_id, project, run.params.output_album_id.as_deref()).await { /* … */ }
                }
            }
            Ok(project) => {
                skipped += 1;                                           // 现状：web 落到这里
                emit_log(&task_id, "info", "taskLogWpeSkip",
                    json!({ "path": project.dir_string(), "reason": format!("暂不支持的壁纸类型：{}", project.kind.as_str()) }));
            }
            Err(skip) => { /* NoProject 不记噪音，其它记 skipped */ }
        }
```

**b. `import_wpe_video` 的行组装**（同文件 `:198`–`:288`）
```rust
async fn import_wpe_video(task_id: &str, project: &WpeProject, album_id: Option<&str>) -> Result<ImportOutcome, String> {
    let dir_string = project.dir_string();
    let entry = project.entry_path().ok_or_else(|| "缺少入口文件".to_string())?;
    if let Some(existing) = Storage::find_image_by_path(&dir_string).map_err(|e| e.to_string())? {
        backfill_compatible_path(task_id, &existing, &entry, &dir_string).await;   // 现状：视频专属补齐
        join_album(task_id, album_id, &existing.id)?;
        return Ok(ImportOutcome::Existing);
    }
    let hash = compute_file_hash(&entry).await?;
    let probe = crate::media::dimensions::probe_media_sync(&entry);                 // 现状：视频探测
    // …
    let image = ImageInfo {
        local_path: dir_string.clone(),
        plugin_id: Some(WPE_IMPORT_PLUGIN_ID.to_string()),
        thumbnail_path,                                                             // 作者 preview.*
        hash, width, height,
        display_name: project.title.clone(),
        media_type: Some("x-wpe/video".to_string()),                                // 现状：写死 video
        compatible_path,                                                            // 现状：始终有值
        url: workshop_url.clone(), post_url: workshop_url, metadata_id: Some(metadata_id),
        // …
    };
    let inserted = Storage::global().add_image(image)?;
    GlobalEmitter::global().emit_images_added(std::slice::from_ref(&inserted));
    join_album(task_id, album_id, &image_id)?;
    apply_wpe_tags(task_id, project, &image_id);
```

**c. 扫描计数只认 Video**（`src-tauri/kabegame-core/src/wpe/scan.rs:18`、`:84`）
```rust
pub struct WpeSourceInfo {
    pub kind: String, pub recognized: Option<String>, pub paths: Vec<String>,
    pub total: usize,
    /// 可导入数量（第一阶段只统计 `video`，且入口文件存在）。
    pub video: usize,                 // 现状：没有 web 计数
    pub pending: usize,               // 现状：= video 且未入库
    pub imported: usize,
}
// count_dirs：
        if matches!(read_project(&normalized), Ok(project) if project.kind == WpeKind::Video) {
            counts.video += 1;
            if !already { counts.pending += 1; }
        }
```
对话框（`WallpaperImportDialog.vue:260`）chip 为「N 个壁纸 / N 个可导入 / N 个已导入」，汇总文案 `gallery.wpeSummary`
= 「将导入 {n} 个视频壁纸…」，`wpeNothingNew` = 「本机的视频壁纸都已导入…」，`wpeScanHint` 末尾「目前只导入视频壁纸」。

**d. `/wpe` 文件 MIME 来自媒体格式表**（`src-tauri/kabegame/src/http_server.rs:64`、`:398`）
```rust
fn mime_from_path(path: &str) -> Option<String> {
    if let Some(m) = kabegame_core::media::image_type::mime_type_from_path(Path::new(path)) { /* 格式表 */ }
    // …
    kabegame_core::media::image_type::mime_by_ext().get(&ext).cloned()   // 现状：只有图片 / 视频扩展名
}
// handle_wpe_file：
    let target = target.to_string_lossy().into_owned();
    let mime = mime_from_path(&target);                                  // 现状：.html/.js/.css/.json → None
    serve_file_with_mime(&target, mime, range).await                     // None → application/octet-stream（Phase 1 实测）
```

**e. CSP 的 `frame-src` 不含本地 HTTP 源**（`src-tauri/kabegame/tauri.conf.json:16`）
```json
"csp": "default-src 'self' ipc: cef-ipc: http://ipc.localhost; … connect-src 'self' ipc: cef-ipc: http://ipc.localhost ws: wss: http://127.0.0.1:*; … frame-src 'self' blob: data: about:;"
```
dev 下 Tauri 不注入 CSP，Phase 1 的 iframe 实测因此没撞上；prod 会拦。

**f. `WallpaperStage` 只有图片 / 视频 / tile 三组元素**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue:20`、`:1131`）
```ts
type MediaType = "image" | "video";                 // 现状：没有 web
interface Props {
  target: WallpaperTarget | null; styleMode: Mode; transition: Transition;
  volume: number; playbackRate: number; paused?: boolean; interactive?: boolean;
}
```
```vue
      <img ref="baseImgRef" class="wallpaper-img base" /> <img ref="topImgRef" class="wallpaper-img top" />
      <video ref="baseVideoRef" class="wallpaper-img base" … /> <video ref="topVideoRef" class="wallpaper-img top" … />
      <div ref="baseTileRef" class="wallpaper-tile base" /> <div ref="topTileRef" class="wallpaper-tile top" />
      <!-- 现状：没有 iframe；setTarget 按 isVideoTarget 二分 -->
```
`isVideoTarget` 对 `x-wpe/web` 返回 false（`type` 非空且不是视频），会落到「图片」分支，用 `fileToUrl(目录)` 加载 → 404。

**g. `ImageContent` 的 mode 只认 WPE 视频**（`apps/kabegame/src/components/image/ImageContent.vue:274`）
```ts
const mode = computed<"image" | "gif" | "video">(() => {
  if (isWpeVideo.value) {                                               // 现状：只有视频一支
    return props.prefer === "thumbnail" && hasWpePreview.value ? "image" : "video";
  }
  if (!isVideo.value) return "image";                                   // 现状：x-wpe/web 落到 image，原图链用 fileToUrl(目录)
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});
// …
defineExpose({ videoEl, failedSources, isLost });
```

**h. 预览弹窗按「视频 / 非视频」二分**（`apps/kabegame/src/components/common/ImagePreviewDialog.vue:506`、`:1120`）
```ts
const isPreviewVideo = computed(() => isVideoPlaybackType(previewImage.value?.type)); // 现状：x-wpe/web → false → 走 Panzoom 图片分支
// handlePreviewReady / handlePreviewWheel / 双击 / 滚轮：if (isPreviewVideo.value) return;
```

**i. 目标组装已抽出，但没有按 id 的命令**（`src-tauri/kabegame/src/commands/wallpaper.rs:62`）
```rust
async fn build_wallpaper_target(info: ImageInfo) -> WallpaperTarget {
    let wpe_video = if is_wpe_video_type(info.media_type.as_deref()) { /* read_project → resolve_video_props */ } else { None };
    WallpaperTarget { id: info.id, path: info.local_path, media_type: info.media_type, compatible_path: info.compatible_path, wpe_video }
}
// 现状：只有 get_current_wallpaper_target 调用它；permissions/main.toml 没有按 id 取目标的命令
```

**j. 轮播与设壁纸守卫已按前缀分流**（`wallpaper/rotator.rs:121`、`:283`，`commands/wallpaper.rs:100`）
```rust
    if kabegame_core::media::image_type::is_wpe_type(ty) {
        return wallpaper_mode == "window";      // 现状：x-wpe/* 全部只允许窗口模式，web 已覆盖
    }
```

**k. 应用背景层**（`apps/kabegame/src/App.vue:17`、`:450`）
```vue
        <ImageContent :image="bgImage" prefer="original" :video-playing="bgVisible && bgMediaType === 'video'" video-muted video-loop … />
```
```ts
      const mediaType = isVideoBackground(image) ? "video" : "image";   // 现状：x-wpe/web → "image"
```

**l. 本机 Web 样例**：创意工坊 `796697921`（Slideshow，`type: "Web"`，`file: index.html`，`preview.jpg/png/svg`）；
`defaultprojects` 里 2 个 web 型（Phase 1 已核对，`API.md` 第四节）。

---

## 点 1 — 导入 `x-wpe/web`（`crawler/wpe_import.rs`、`wpe/scan.rs`、`WallpaperImportDialog.vue`、i18n）
- **新增**（`wpe_import.rs`）
  - `import_wpe_web(task_id, project, album_id) -> Result<ImportOutcome, String>`：
    - `entry = project.entry_path()`，必须存在且是文件，否则 `Err("缺少入口文件")`（与 video 同语义，进 skipped）。
    - 已入库（`find_image_by_path(dir)` 命中）→ 只 `join_album`，返回 `Existing`；没有 `compatible_path` 补齐。
    - `hash = compute_file_hash(&entry)`、`size = metadata(entry).len()`；`width` / `height` 为 `None`；`compatible_path` 为 `None`。
    - `thumbnail_path`、`metadata_id`、`url` / `post_url`、`display_name`、`crawled_at` 与 video 完全同源；
      为避免两份拷贝，把这段组装抽成 `base_image_info(project, task_id, metadata_id, hash, size) -> ImageInfo`，两个 import 各自覆盖
      `media_type` / `width` / `height` / `compatible_path`。
    - 写库、`emit_images_added`、`join_album`、`apply_wpe_tags`、`taskLogWpeImported` 日志与 video 一致。
```rust
/// 新增：导入一个网页壁纸目录（幂等：已入库只补画册成员）。页面没有可播放媒体，compatible_path 留空。
async fn import_wpe_web(task_id: &str, project: &WpeProject, album_id: Option<&str>) -> Result<ImportOutcome, String> {
    let dir_string = project.dir_string();
    let entry = project.entry_path().filter(|p| p.is_file()).ok_or_else(|| "缺少入口文件".to_string())?;
    if let Some(existing) = Storage::find_image_by_path(&dir_string).map_err(|e| e.to_string())? {
        join_album(task_id, album_id, &existing.id)?;
        return Ok(ImportOutcome::Existing);
    }
    let hash = compute_file_hash(&entry).await?;
    let size = std::fs::metadata(&entry).ok().map(|meta| meta.len());
    let metadata_id = Storage::global().insert_metadata_row(&project.raw, WPE_IMPORT_PLUGIN_ID, 0, None)
        .map_err(|e| format!("写入 metadata 失败：{e}"))?;
    let image = ImageInfo {
        media_type: Some("x-wpe/web".to_string()),   // 新增
        width: None, height: None,                    // 页面没有固有尺寸
        compatible_path: None,                        // 没有可播放媒体
        ..base_image_info(project, task_id, metadata_id, hash, size)   // 新增：与 video 共用的行组装
    };
    let inserted = Storage::global().add_image(image)?;
    // … emit_images_added / join_album / apply_wpe_tags / taskLogWpeImported 与 video 相同
    Ok(ImportOutcome::Imported)
}
```
- **修改**（`run_builtin_wpe_import`）
  - `match` 增加 `Ok(project) if project.kind == WpeKind::Web` 一支，dry-run 与错误处理与 Video 支完全一致；两支共用一个
    `import_outcome` 闭包或把「dry-run 分流 + 结果计数」抽成 `handle_supported(project, importer)`，避免复制 30 行。
```rust
            Ok(project) if project.kind == WpeKind::Video => handle_supported(&project, import_wpe_video).await,
            Ok(project) if project.kind == WpeKind::Web => handle_supported(&project, import_wpe_web).await,   // 新增
            Ok(project) => { /* scene / application / 其它仍计 skipped */ }
```
  - 模块文档首段「第一阶段只入库 video」改为「入库 video 与 web」。
- **修改**（`wpe/scan.rs`）
  - `WpeSourceInfo` / `DirCounts` 增加 `pub web: usize`；`pending` 口径改为「`WpeKind::is_supported()` 且未入库」。
  - `WpeKind` 增加 `pub fn is_supported(&self) -> bool { matches!(self, Video | Web) }`（放 `wpe/project.rs`）；Phase 3 以后
    scene 只需在这里加一项。
  - `add_counts` 同步累加 `web`；测试用例补「web 目录计入 web 与 pending」。
```rust
        if let Ok(project) = read_project(&normalized) {
            match project.kind {
                WpeKind::Video => counts.video += 1,
                WpeKind::Web => counts.web += 1,                   // 新增
                _ => {}
            }
            if project.kind.is_supported() && !already {          // 修改：口径 = 已支持类型
                counts.pending += 1;
            }
        }
```
- **修改**（`WallpaperImportDialog.vue`）
  - `WpeSourceInfo` 前端类型加 `web: number`。
  - `statChips`：总数 chip 不变；「可导入」chip 文案改用 `gallery.wpeStatImportable`（{n} 个可导入）；当 `video + web > 0` 时
    追加一枚 plain chip `gallery.wpeStatKinds`（「视频 {v} · 网页 {w}」，为 0 的项省略）；「已导入」不变。
  - `footerText`：`wpeSummary` 改为「将导入 {n} 个壁纸，已导入的会自动跳过」；`wpeNothingNew` 改为「本机可导入的壁纸都已导入…」；
    `wpeScanHint` 去掉「目前只导入视频壁纸」，改为「目前支持视频与网页壁纸」。
- **修改**（i18n，`packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/gallery.json`）
  - 新增 `wpeStatImportable`、`wpeStatKinds`；改写 `wpeSummary`、`wpeNothingNew`、`wpeScanHint`；删除 `wpeStatVideo`（无其它引用则删）。
  - `wpeKindWeb` 已存在（`ImageBasicInfoPanel` 用），不动。
- **说明**
  - `WpeProject.kind` 已小写归一（`"Web"` → `Web`），不需要再处理大小写。
  - 内建插件 `wpe-import` 的变量定义（`plugin/builtin.rs:74`）只有 `sources` / `extraDirs`，不需要新增「类型」变量；是否要「只导入视频 / 只导入网页」
    的筛选项不在本 Phase。

## 点 2 — `/wpe` 目录服务补网页 MIME，并给 Phase 5 留 HTML 产出点（`kabegame/src/http_server.rs`）
- **新增**
  - 静态表 `WPE_WEB_MIME: &[(&str, &str)]`，只服务 `/wpe`，不进 `MEDIA_FORMATS`：
    `html htm → text/html; charset=utf-8`、`js mjs → text/javascript`、`css → text/css`、`json → application/json`、
    `svg → image/svg+xml`、`xml → application/xml`、`txt → text/plain; charset=utf-8`、`wasm → application/wasm`、
    `woff → font/woff`、`woff2 → font/woff2`、`ttf → font/ttf`、`otf → font/otf`、`webm → video/webm`、`ogg ogv → video/ogg`、
    `oga → audio/ogg`、`mp3 → audio/mpeg`、`wav → audio/wav`、`map → application/json`。
  - `wpe_mime_from_path(path) -> Option<String>`：先查 `WPE_WEB_MIME`，再回落 `mime_from_path`（图片 / 视频仍走格式表），
    都没有返回 `None`（保持 `application/octet-stream`）。
  - `serve_wpe_html(target, headers) -> Response`：`text/html` 的专用产出点。本 Phase 只是读整文件、设 `Content-Type: text/html; charset=utf-8`、
    `Cache-Control: no-store` 后返回；忽略 `Range`（HTML 不需要分段）。**Phase 5 在这里把垫片 `<script>` 插进 `<head>` 最前面**，
    并对 `zcompat` 补丁做内存替换；本 Phase 不动文件内容。
- **修改**（`handle_wpe_file`）
```rust
    let target = target.to_string_lossy().into_owned();
    let mime = wpe_mime_from_path(&target);                              // 修改：先查网页表
    if mime.as_deref().is_some_and(|m| m.starts_with("text/html")) {
        return serve_wpe_html(&target).await;                            // 新增：HTML 走专用产出点（Phase 5 在此注入垫片）
    }
    let range = headers.get(RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    serve_file_with_mime(&target, mime, range).await                      // 其它文件照旧流式 + Range
```
- **说明**
  - `handle_wpe_entry` 的 307 不变；Phase 1 实测 iframe 文档加载跟随 307 正常。
  - 不引入 `mime_guess` 依赖（仓库现无此 crate），静态表足够覆盖 WPE 网页壁纸的资源类型；遇到表外扩展名由作者页面自行承担
    （与 WPE 的 `file://` 行为一致：Chromium 对未知类型按嗅探处理，我们这里是 octet-stream，差异记入已知边界）。

## 点 3 — CSP：`frame-src` 放行页面源（`kabegame/tauri.conf.json`）
- **修改**
  - `frame-src` 增加 `http://127.0.0.1:*`，写法与 `connect-src` 已有项一致。
```json
"csp": "… connect-src 'self' ipc: cef-ipc: http://ipc.localhost ws: wss: http://127.0.0.1:*; … frame-src 'self' blob: data: about: http://127.0.0.1:*;"
```
- **说明**
  - 本 Phase 页面源固定为本地 HTTP 服务；若关键决策选固定端口或自定义协议，这一项随之改成具体端口或 `http://kb-wpe.localhost`（Windows）
    / `kb-wpe:`（macOS / Linux），放在对应 Phase 落地。
  - `script-src` 等其它指令只作用于应用自身文档，iframe 内页面有自己的 CSP（`/wpe` 不下发 CSP 头，与 WPE 一致）。

## 点 4 — `WallpaperStage` 的 Web 分支（`components/wallpaper/WallpaperStage.vue`、`types.ts`）
- **修改**（`types.ts`）
  - `WallpaperStageDebugState.media` 类型加 `"web"`。
- **新增**（`WallpaperStage.vue`）
  - 模板增加独立的 web 层（不是 base / top 的成员）：
```vue
      <!-- Web 层：独立于 base / top 双层，一次只存在一个 iframe；切走时过渡结束后销毁（见 commitWeb / teardownWeb） -->
      <div ref="webLayerRef" class="wallpaper-web-layer" style="display: none">
        <iframe
          v-if="webSrc"
          ref="webFrameRef"
          class="wallpaper-web-frame"
          :src="webSrc"
          :sandbox="WEB_SANDBOX"
          allow="autoplay; fullscreen"
          referrerpolicy="no-referrer"
          @load="handleWebLoad"
        ></iframe>
      </div>
```
  - 常量 `WEB_SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（取舍见关键决策 5；`allow-same-origin`
    必须有，否则页面变成 opaque origin，`localStorage` 抛错且相对资源的 Cookie 语义变化；不给 `allow-top-navigation` /
    `allow-popups` / `allow-modals`，WPE 页面不需要导航父窗口和弹窗，`alert` 在壁纸里也不该出现）。
  - 状态：`webSrc: Ref<string>`（空串表示无 iframe）、`webToken` 去重；`isWebTarget(target) = wpeKind(type) === "web"`。
  - `getWebUrl(target)`：`await initHttpServerBaseUrl()`，返回 `${base}/wpe/${encodeURIComponent(target.id)}/`。
    （在 `utils/fileUrl.ts` 新增 `wpeEntryUrl(imageId)`，第一阶段删掉的同名函数按「按 id 不按路径」重新定义。）
  - `setTarget` 新增分支（在 `isVideoTarget` 判断之前）：
```ts
    if (isWebTarget(next)) {
      const url = await getWebUrl(next);
      currentMediaType = "web";
      // 当前媒体层淡出：复用 transition（none 直接隐藏），img / video / tile 的 src 清空由 commit 完成
      await fadeOutMediaLayers();
      webSrc.value = url;                       // v-if 创建 iframe
      showWebLayer();                           // 过渡淡入：transition === "none" 直接 opacity 1
      // ready 在 iframe load 事件发出（handleWebLoad），不等页面内资源
      return;
    }
    // 从 web 切到图片 / 视频：先按原逻辑把新媒体放到 base（首帧直设分支），再淡出 web 层，过渡结束后 teardownWeb()
    if (currentMediaType === "web") { pendingWebTeardown = true; }
```
  - `teardownWeb()`：`webFrameRef.src = "about:blank"`（让渲染进程立刻卸载页面）→ `webSrc.value = ""`（v-if 移除）→ `display: none`。
    在 `commitTopToBase` 末尾与 `onBeforeUnmount`、`target` 变为 null 时调用。
  - `paused`：本 Phase 对 web 层只做 `visibility: hidden`（省掉合成但不冻结脚本，Phase 6 的垫片冻结再接手）；`paused` 变化时同步。
  - `interactive`：`.wallpaper-stage-interactive .wallpaper-web-frame { pointer-events: auto }`，默认 `pointer-events: none`
    （桌面窗口不交互，与媒体层一致）。
  - `styleMode` / `volume` / `playbackRate` 对 web 层无意义，忽略；`applyWpeStageStyles` 对 web 目标不写 transform / filter / 背景色
    （`wpeVideo` 为 null 自然跳过）。
  - 样式（scoped `<style>`，与过渡组合类放一起）：
```css
.wallpaper-web-layer { position: absolute; inset: 0; opacity: 0; transition: opacity var(--wp-transition-ms, 600ms) ease; }
.wallpaper-web-layer.enter { opacity: 1; }
.wallpaper-web-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; pointer-events: none; }
.wallpaper-stage-interactive .wallpaper-web-frame { pointer-events: auto; }
```
  - `debugState().media` 返回 `"web"`；`ready` 在 `handleWebLoad` 发；`error` 在 iframe 的 `load` 事件 8s 内未到（`setTimeout` 看门狗）时发
    `"wpe web entry load timeout"`（iframe 没有 error 事件，404 也会触发 load，所以只能靠超时兜底）。
- **说明**
  - 为什么不让 iframe 参与双层：见总体设计思路；决策留在文末第 4 条，若用户选「参与双层」，实现改为 base / top 各一个 iframe 槽并在
    commit 时销毁旧槽，成本约为本方案两倍且切换期间两个渲染进程并存。
  - 跨源 iframe 里的页面拿不到父页面 DOM 与 Tauri 全局（Phase 1 实测）；`cef-ipc` 伪造请求目前只靠调用密钥挡住，纵深防御见决策 6。

## 点 5 — 预览内嵌（按 phase-2 文档 3-a / 3-b / 3-c 落地）
### 5-a — Rust：按 id 取壁纸目标（`commands/wallpaper.rs`、`lib.rs`、`permissions/main.toml`）
- **新增**
```rust
/// 新增：图库预览 / 应用背景按 id 取壁纸目标，与当前壁纸共用 build_wallpaper_target。
#[tauri::command]
pub async fn get_wallpaper_target_for_image(image_id: String) -> Result<Option<WallpaperTarget>, String> {
    let Some(info) = Storage::find_image_by_id(&image_id).map_err(|e| format!("Storage error: {}", e))? else {
        return Ok(None);
    };
    Ok(Some(build_wallpaper_target(info).await))
}
```
  - `lib.rs` 的 `generate_handler!` 注册；`permissions/main.toml` 的 `commands.allow` 加 `"get_wallpaper_target_for_image"`（紧跟
    `"get_current_wallpaper_target"`）。
- **说明**
  - `build_wallpaper_target` 对 `x-wpe/web` 行 `wpe_video` 为 `None`，`compatible_path` 为 `None`，`type` 为 `x-wpe/web`，前端据此走 web 层。

### 5-b — `ImageContent` 新增 `wallpaper` mode（新增 `components/wallpaper/WpeWallpaperContent.vue`，修改 `image/ImageContent.vue`、`utils/mediaMime.ts`）
- **新增**（`mediaMime.ts`）
  - `isWpeWallpaperContentType(t)`：`isWpeMediaType(t) && !isWpeVideoType(t)`，即「交给壁纸组件渲染的 WPE 类型」（web / scene / 其它）。
- **新增**（`WpeWallpaperContent.vue`）
  - props `{ image: ImageInfo; playing?: boolean; muted?: boolean; interactive?: boolean }`，emits `ready` / `error`。
  - 目标：`invoke<WallpaperTarget | null>("get_wallpaper_target_for_image", { imageId: image.id })`；`image.id` 变化重取；
    返回 null 或抛错 → emit `error`，内部渲染空（调用方按既有 `error` 流程显示丢失态）。
  - 设置：`const settings = useSettingsStore()`，`styleMode = settings.values.wallpaperStyle ?? "fill"`、
    `transition = settings.values.wallpaperRotationTransition ?? "none"`、`volume = muted ? 0 : (settings.values.wallpaperVolume ?? 1)`、
    `playbackRate = settings.values.wallpaperVideoPlaybackRate ?? 1`，均为 computed；不调用 `loadAll`（主窗口已加载）。
  - 渲染 `<WallpaperStage class="w-full h-full" :target :style-mode :transition :volume :playback-rate :paused="playing === false" :interactive @ready @error />`。
```vue
<template>
  <WallpaperStage
    class="w-full h-full"
    :target="target"
    :style-mode="styleMode"
    :transition="transition"
    :volume="volume"
    :playback-rate="playbackRate"
    :paused="props.playing === false"
    :interactive="props.interactive"
    @ready="emit('ready')"
    @error="(m) => emit('error', m)"
  />
</template>
```
- **修改**（`ImageContent.vue`）
  - 新增可选 prop `interactive?: boolean`（默认 false），只透传给 `WpeWallpaperContent`。
  - `mode` 增加 `"wallpaper"`；模板增加对应分支；`videoEl` 在该模式下保持 `null`。
```ts
const isWpeWallpaperContent = computed(() => isWpeWallpaperContentType(props.image.type));
const mode = computed<"image" | "gif" | "video" | "wallpaper">(() => {
  if (isWpeWallpaperContent.value) {
    // 新增：web / scene 的缩略位仍是作者 preview.*；原图形态交给壁纸组件
    return props.prefer === "thumbnail" ? "image" : "wallpaper";
  }
  if (isWpeVideo.value) return props.prefer === "thumbnail" && hasWpePreview.value ? "image" : "video"; // 不变
  if (!isVideo.value) return "image";
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});
```
```vue
      <WpeWallpaperContent
        v-else-if="mode === 'wallpaper'"
        :image="image"
        :playing="videoPlaying"
        :muted="videoMuted"
        :interactive="interactive"
        @ready="handleReady"
        @error="handleError"
      />
```
  - 缩略图链对 `wallpaper` mode 不参与（原图链在该模式下不构建，`buildChain` 对 WPE 行已跳过目录路径）。
  - `mode === "wallpaper"` 时丢失态判定：`image.localExists === false` 仍显示丢失态（目录消失），其它交给 `WpeWallpaperContent` 的 `error`。
- **说明**
  - `ImageItem.vue` 网格角标：`wpeKind === "web"` 显示「WPE · 网页」（`gallery.wpeKindWeb` 已有），与视频同一处判断，补一个映射即可。
  - 应用背景层（`App.vue`）用同一个 `ImageContent prefer="original"`，因此 Web 行默认会落到 `wallpaper` mode（iframe 在背景里跑）。
    按关键决策 3 的默认取向，`App.vue` 的 `hasAppBackgroundSource` 对 `isWpeWallpaperContentType` 返回 false 并退回 `thumbnailPath` 作为
    静态背景图（新增 `bgMediaType: "thumbnail"` 分支或直接让 `bgImage` 的 `prefer` 变为 `"thumbnail"`）；若用户选「iframe」，则不改 `App.vue`，
    并确认 `video-muted` 对 iframe 无效（页面音频无法从外部静音，这是选 iframe 的代价）。

### 5-c — 预览弹窗的「桌面画布」（新增 `components/wallpaper/WallpaperDesktopCanvas.vue`，修改 `ImagePreviewDialog.vue`，i18n）
- **新增**（`WallpaperDesktopCanvas.vue`）
  - 纯布局，默认插槽放内容。桌面尺寸：`primaryMonitor()`（`@tauri-apps/api/window`）的 `size / scaleFactor` 取逻辑像素；
    失败回退 `window.screen.width / height`；结果缓存在模块级（同一会话不重复问）。
  - 外层 `relative w-full h-full flex items-center justify-center`，用 `ResizeObserver` 量可用宽高，算 `k = min(W/dw, H/dh)`；
    内层 `position: absolute; width: dw px; height: dh px; transform: scale(k); transform-origin: 0 0`，并以 `left / top` 居中；
    插槽内容铺满内层；指针事件放行（画布本身不拦）。
  - 右下角角标 `gallery.wpeDesktopPreview`（「桌面预览 · {w}×{h}」），`pointer-events: none`，半透明小字，五语言。
- **修改**（`ImagePreviewDialog.vue`）
```ts
const isPreviewWallpaper = computed(() => isWpeWallpaperContentType(previewImage.value?.type)); // 新增：web / scene
const isPreviewVideo = computed(() => isVideoPlaybackType(previewImage.value?.type));           // 不变：WPE 视频仍是视频预览
const isPreviewStatic = computed(() => !isPreviewVideo.value && !isPreviewWallpaper.value);     // 新增：Panzoom 图片分支的条件
```
```vue
          <div v-if="previewImage && isPreviewWallpaper" class="preview-wallpaper-wrapper absolute inset-0">
            <WallpaperDesktopCanvas>
              <ImageContent
                ref="previewContentRef"
                :image="previewImage"
                prefer="original"
                video-playing
                interactive
                @ready="handlePreviewReady"
                @error="handlePreviewError"
              />
            </WallpaperDesktopCanvas>
          </div>
          <!-- 原 v-if="previewImage && !isPreviewVideo" 的两个图片 wrapper 改为 v-if="previewImage && isPreviewStatic" -->
```
  - `handlePreviewReady` / `handlePreviewWheel` / 双击播放暂停 / 滚轮缩放 / Panzoom 对齐：原 `if (isPreviewVideo.value) return;` 改为
    `if (isPreviewVideo.value || isPreviewWallpaper.value) return;`（共 5 处，`:1111`、`:1122`、`:1175`、`:1181`、`:1294`）。
  - `desktopVideoActive`（音频保活）改为 `!uiStore.isCompact && previewVisible.value && (isPreviewVideo.value || isPreviewWallpaper.value)`。
  - 不渲染 `VideoControls`；`PreviewControlBar`（含全屏）照常；关闭预览时 `previewImage` 置空 → `ImageContent` 卸载 → `WallpaperStage`
    `onBeforeUnmount` → `teardownWeb()`。
  - `getOriginalPreviewUrl` 不动（WPE 视频仍由它取 `compatible_path`；web 行不经它取 URL，`previewImageUrl` 对 web 行为空串即可）。
- **说明**
  - 紧凑布局（Android / 窄窗）没有 WPE 行（Web / Android 不导入），但 `isPreviewWallpaper` 分支对 `uiStore.isCompact` 同样生效，不需要另写。

## 点 6 — 轮播与可用性（`wallpaper/rotator.rs`、`commands/wallpaper.rs`）
- **无需修改**：`is_wallpaper_suitable`、`media_allowed_in_mode`、`set_wallpaper_by_image_id` 的窗口模式守卫都按 `is_wpe_type` 前缀判断
  （锚点 j），`x-wpe/web` 已与 video 同口径。本 Phase 只在回归里补 case 复核。

## 点 7 — 分流护栏对 `x-wpe/web` 的审计
逐项 grep 结果（全部按 `is_wpe_type` / `is_wpe_row` / `isWpeMediaType` 前缀判断，对 web 行已覆盖，**无需修改**）：

| 护栏 | 位置 | 判断 | 覆盖 web |
|---|---|---|---|
| 删除不送源目录进回收站 | `storage/images.rs:1026` | `is_wpe_type` | 是 |
| 缩略图只删 `thumbnails_dir` 内文件 | `storage/images.rs:186` | 按目录归属，与类型无关 | 是 |
| 整理：跳过缩略图重建 / 兼容副本 / 哈希去重 / 无法识别清理 | `storage/organize.rs:426` `is_wpe_row` | `format_key` 前缀 | 是 |
| 虚拟盘隐藏 | `virtual_driver/semantics.rs:475` | `is_wpe_type` | 是 |
| 原生壁纸不转码目录 | `wallpaper_compat.rs:26` | `is_wpe_type` | 是 |
| `/file/<目录>` 404 | `http_server.rs:147` | `is_wpe_type` | 是 |
| `/wpe` 授权 | `http_server.rs:332` | `is_wpe_type && is_dir` | 是 |
| 轮播 / 设壁纸只允许窗口模式 | `rotator.rs:121/283`、`commands/wallpaper.rs:100` | `is_wpe_type` | 是 |
| 复制 / 分享 / 删源文件禁用，「在文件夹中显示」开目录 | `useImageOperations.ts:62`、`imageActions.ts:62` | `isWpeMediaType` | 是 |
| 原生拖出关闭 | `ImageContent.vue:273` `dragEnabled` | `isWpeMediaType` | 是 |
| 原生元数据（EXIF）不解析 | `wpe_import.rs` 写 `image_metadata_id: None`，下载后处理链不经过 wpe 导入 | 结构上不触达 | 是 |
| 详情类型文案 | `ImageBasicInfoPanel.vue:303` | `wpeKind === "web"` → `gallery.wpeKindWeb` | 是 |
| MCP / JSON-RPC | `type` 原样透出；媒体 URL 对 WPE 行取 `compatible_path`（web 为空 → 无媒体 URL） | — | 需在 `MCP_SERVER.md` 记一句：web 行没有媒体 URL |

- **修改**（唯一需要补的）
  - `safe_delete.rs:121` 的 `is_file()` 只是间接保护；`images.rs:1026` 已在上游把 WPE 行排除，不再补。无代码改动，只在 `WPE_IMPORT.md` 第七节
    把「第一阶段只导入 video」更新为「video 与 web」。

## 点 8 — 文档与回归
- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：第二节格式键表 `x-wpe/web` 标为「已入库」；第五节补 `WPE_WEB_MIME` 与 `serve_wpe_html` 产出点；第六节补
    `WallpaperStage` web 层（独立层、切走销毁、`paused` 只隐藏）与图库接入（`ImageContent` wallpaper mode、`WpeWallpaperContent`、
    `WallpaperDesktopCanvas`、`get_wallpaper_target_for_image`）；第七节已知边界加「页面收不到 WPE 接口（Phase 5）」「`file` / `directory`
    属性不支持」「背景层对 web 行退回缩略图」「`localStorage` 随端口变化不持久」「表外扩展名为 octet-stream」；第八节涉及文件补新文件。
  - `cocs/mcp/MCP_SERVER.md`：一句话说明 `x-wpe/web` 行无媒体 URL。
  - `AGENTS.md`「文件类型的唯一事实来源」段：`x-wpe/web` 行 `compatible_path` 为空、页面经 `/wpe/<id>/` 加载。
  - `cocs/README.md` 的 WPE 条目主题补「web 导入与预览内嵌」。
  - `versions/latest/regression.md`：新增「WPE 壁纸导入（第二阶段 Phase 3：Web 导入 + 预览内嵌）」一节，格式同第一阶段表。
  - `versions/latest/changelog.md` 补一行。

### 真机验收清单（Windows 11 dev，用 `kabegame-chromium`；Rust 改动后 dev 自行重建，不轮询）
| 状态 | 项目 | 操作 | 预期 |
|---|---|---|---|
| [ ] | 扫描计数 | 打开「壁纸」对话框 | 创意工坊卡片「2 个壁纸 / 1 个可导入 / 1 个已导入」，chip「视频 1 · 网页 1」；`defaultprojects` 可导入 = 2（网页） |
| [ ] | 导入 web | 提交任务 | 新增 3 行 `type=x-wpe/web`（796697921 + defaultprojects 2 个），缩略图为作者 `preview.*`，`compatible_path` 为空，标签进 `WPE/<tag>` |
| [ ] | dry-run | 勾选 dry-run 再提交 | 日志逐目录「dry-run 跳过」，`images` 行数不变 |
| [ ] | 幂等 | 再跑一次 | 不新增行，日志「已存在」 |
| [ ] | `/wpe` MIME | `curl -I /wpe/<id>/index.html`、`/main.css`、`/wallpaper.js`、`/project.json` | `text/html; charset=utf-8` / `text/css` / `text/javascript` / `application/json`；`/wpe/<id>/` 仍 307 |
| [ ] | 网格 | 画廊查看 | 显示作者 `preview.jpg`，角标「WPE · 网页」 |
| [ ] | 预览画布 | 双击 web 行 | 出现主屏比例画布，页面以「无属性」状态渲染（Slideshow 显示「select a directory」类提示属正常）；拖弹窗大小等比缩放；角标显示分辨率 |
| [ ] | 预览可交互 | 鼠标移到画布边缘 / 点击页面控件 | 页面收到 `mousemove` / `click`（Slideshow 边缘控制条出现） |
| [ ] | 预览无视频控件 | 同上 | 没有 `VideoControls`；全屏按钮可用 |
| [ ] | 预览关闭 | 关闭弹窗 | `targets` 里该 iframe 的 page 消失（渲染进程回收） |
| [ ] | 设为壁纸 | 窗口模式设为壁纸 | 桌面显示页面；`shot --url wallpaper` 不出帧时用 `eval` 查 `.wallpaper-web-frame` 存在且 `src` 正确 |
| [ ] | 切换壁纸 | 切到普通图片再切回 | 切走后 `.wallpaper-web-frame` 被移除；切回重新创建 |
| [ ] | 过渡 | fade / slide / zoom 下切入切出 web | web 层淡入淡出，媒体层不残留 |
| [ ] | 非窗口模式 | 原生模式设为壁纸 | 提示切换窗口模式 |
| [ ] | 轮播 | 轮播来源画册含 web 行 | 窗口模式选中；原生模式跳过 |
| [ ] | 背景层 | 把 web 行设为当前壁纸并开应用背景 | 按决策 3：默认显示作者 preview 静态图 |
| [ ] | 删除护栏 | 删除记录并勾选删源文件 | 记录消失，壁纸目录与 `preview.*` 完好 |
| [ ] | 整理 / 虚拟盘 | 整理覆盖该行；打开虚拟盘 | 行不被删除、缩略图不被覆盖；虚拟盘不出现 web 行 |
| [ ] | 隔离 | 预览里 `eval` 进 iframe 查 `window.__TAURI_INTERNALS__` | undefined；父页面访问 iframe DOM 被跨源拦截 |
| [ ] | prod CSP | `deno task b` 后装包验证（可延后） | iframe 不被 `frame-src` 拦截 |

## 验收
- `deno task check -c kabegame`（`check-kabegame` 技能）前端与 Rust 均 0 error；`deno task test`（`test-kabegame`）的 `scan.rs` 测试通过。
- 上表真机项逐一勾选；未能验证的写明原因。
- `git status` 不得出现本方案以外的改动；不提交。

---

## 关键决策（2026-10-26 用户已确认）

> 用户逐条同意下列 1–7 的推荐 / 默认项；scheme 名定为 **`kb-wpe`**。另新增第 8 条「用户属性即元数据」。
> 本节原文保留，供理解各选项的取舍。


1. **页面源（决定 `localStorage` 是否持久、Phase 5 以后的 CSP 与 URL 形态）**
   - A. 本地 HTTP 服务 `http://127.0.0.1:<随机端口>`（**本 Phase 默认**）：零改动；端口每次启动变化，`localStorage` / `indexedDB` 不持久；
     CSP 用 `http://127.0.0.1:*` 通配。
   - B. 固定端口 + 冲突回退随机：改 `http_server.rs` bind；绝大多数启动源稳定；被占用时退化成 A，页面存储丢一次；CSP 仍需通配。
   - C. 自定义 Tauri 协议 `kb-wpe`：源 `http://kb-wpe.localhost`（Windows）/ `kb-wpe://localhost`（macOS / Linux），与端口无关，
     跨重启稳定；处理函数把请求转给现有 axum `/wpe` Router（`tower::ServiceExt::oneshot`），一份实现两个入口；代价是 CEF 协议处理器
     整体缓冲 body（`protocol.rs:108`，无流式、Range 由我们实现），对网页壁纸的小资源无感，但 webm / 大 mp3 会整文件进内存；
     需在 `on_register_custom_schemes` 增加 scheme 并打 STANDARD | SECURE | CORS_ENABLED | FETCH_ENABLED；CSP 写具体源。
   - **推荐 C**，在 Phase 5 与垫片一起落地（垫片也要知道自己的源）。理由：WPE 的 `file://` 让所有网页壁纸共用一个稳定源，C 是语义最接近
     的等价物；B 的「偶尔丢一次」比「从不持久」更难解释。本 Phase 先按 A 跑通，不阻塞。
2. **`file` / `directory` 属性**
   - Phase 3 按**不支持**上线：页面收不到这两类属性的值（Phase 5 推属性时直接不推），Slideshow 这类壁纸显示「未选择目录」状态。
   - Phase 7 前验证两条路：
     - 「本地 scheme」：把 `kb-wpe` 加 `CEF_SCHEME_OPTION_LOCAL`，Blink 对本地 scheme 的源打开「可加载本地资源」，页面内 `file:///` 请求能发出，
       再按 `file` scheme 注册处理器做白名单。**疑点**：CEF 文档说「普通页面不能链接或访问本地 URL」，可能意味着 tauri 源的父页面不能 iframe 它；
       以及 LOCAL 是否与 CORS_ENABLED / FETCH_ENABLED 冲突。要真机验证「普通源能否 iframe 本地 scheme」。
     - 「页面以 `file://` 加载」（WPE 的做法）：需要全局 file 访问开关 + 拦截器限目录。**疑点**：开关作用于同进程所有窗口（含畅游）；http 源父页面
       不能 iframe `file://`，只能用 CEF 浏览器侧导航（`CefFrame::LoadURL` 子 frame）绕过渲染侧检查，是否可行未验证；且无法在响应里注入垫片，
       只能用子 frame 初始化脚本。
   - 推荐：Phase 3 不支持；Phase 7 前先测「本地 scheme」，不通再测 `file://`，都不通维持不支持。
3. **应用背景层对 web 行**
   - A. **退回缩略图**（本方案默认）：背景显示作者 `preview.*` 静态图。理由：背景层应当静音、不交互、低开销，而 iframe 页面无法从外部静音、
     会持续跑脚本，且主界面上方有自己的交互层，页面的 `mousemove` 会被遮挡得时有时无。
   - B. iframe：与桌面一致的动态背景，接受上述代价。
4. **过渡**
   - A. **web 层独立、不参与 base / top 双层**（本方案默认）：一次只有一个 iframe，切走即销毁；切入切出用媒体层整体淡出 / 淡入。
   - B. iframe 参与双层：base / top 各一个 iframe 槽，切换期间两个渲染进程并存、旧页面继续跑；实现约两倍，且与 Phase 2 保留的元素交换逻辑纠缠。
5. **`sandbox` 属性**
   - A. **加**（本方案默认）：`allow-scripts allow-same-origin allow-pointer-lock allow-forms`；不给 top-navigation / popups / modals / downloads。
     代价：个别壁纸若依赖 `alert` 或弹窗会静默失败（WPE 里这类行为本来也不该出现）。
   - B. 不加：行为最接近 WPE 的裸 CEF，但页面可导航父窗口、弹窗、触发下载。
   - 另：是否加 `allow-downloads`？WPE 页面不下载文件，默认不加。
6. **IPC 纵深防御（API.md 第八节第 4 条）**
   - 现状：子 frame POST `cef-ipc://` 会被转交给 Tauri，只靠调用密钥挡住。
   - 选项：在 `tauri-runtime-cef/src/ipc.rs` 的 `post_message_request` 校验 Origin 为应用源（`http://tauri.localhost` / `http://localhost:1420` dev）或
     请求来自主 frame，否则 400。改动约 20 行，影响所有窗口（畅游注入脚本走的是同一通道，需确认其 Origin 是站点源 → 必须按「主 frame」而非「应用源」判）。
   - 推荐：**纳入 Phase 3**，按「主 frame 或白名单源」校验，因为 Phase 3 是第一次在应用里长期跑第三方页面；但这是运行时代码，范围由用户定。
7. **兼容补丁（zcompat）与「显示条件要 JS 求值」是否影响 Phase 3**
   - 不影响。zcompat 是对作者 js 的文本替换，只在 Phase 5 的 `serve_wpe_html` / js 响应产出点做内存替换，本 Phase 页面照原文跑，5 个受影响壁纸
     本机都没有订阅。显示条件只影响 Phase 7 的属性面板显隐，与页面加载无关。两者分别指向 Phase 5 / Phase 7。

8. **用户属性即元数据（新增，用户决策）**
   - WPE 壁纸的 `project.json` 本来就存在 `metadata`（导入时写入）。用户可调属性**不另建表、不进 settings**：用户值作为同一份
     元数据 JSON 里的一段（如 `userProperties: { <key>: value }`），与作者默认值放在一起。
   - 写入入口是**为 WPE 壁纸定制的详情面板**（预览弹窗的详情区，在 `ImagePluginDescriptionPanel` 之外新增一块 WPE 面板，
     按 `general.properties` 渲染表单）。保存时走元数据的不可变语义：`insert_metadata_text` 新建一行 → 图片行改指新的
     `metadata_id` → 发 `image-changed { id, metadataId }` 字段补丁（与 `metadata_migration.rs:253` 的补丁形态一致）。
   - 观察方不订阅新事件：壁纸窗口、预览画布、背景层在收到 `metadataId` 补丁时重新取目标（`get_wallpaper_target_for_image` /
     `get_current_wallpaper_target` 的组装读元数据并合并「作者默认值 + 用户值」），然后**模拟 WPE 的属性变化事件**：
     由 `WpeWebHost` 对比新旧属性，只把变化的键以 `applyUserProperties({ <key>: { value } })` 的形态推给页面，页面感知不到 Kabegame
     与 WPE 的区别。Kabegame 内部不新增任何事件类型，`image-changed { metadataId }` 就是唯一的触发源。
   - 对 Phase 3 的影响：`build_wallpaper_target` 从一开始就从元数据而不是重读 `project.json` 取属性来源，为 Phase 7 留好位置；
     详情面板本 Phase 只读展示（标题 / 标签 / 创意工坊链接），可编辑表单在 Phase 7。
   - 对 Phase 7 的影响：PLAN.md 待定决策 5「用户属性存储」就此关闭；`file` / `directory` 属性的值同样存在这段 JSON 里。
