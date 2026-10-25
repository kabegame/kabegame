# WPE 壁纸兼容 · 第一阶段：Video

> 状态：已实现，初步真机测试完成（2026-10-25）
>
> 上级总纲：[../PLAN.md](../PLAN.md)。总体设计、现状锚点 a–l 与跨阶段决策都在总纲里，本文件只放第一阶段的点级方案。

## 点 1 — 类型键 `x-wpe/*` 进格式表（`media/image_type.rs`）
- **新增**
  - `MEDIA_FORMATS` 增加 `x-wpe/video`、`x-wpe/web`、`x-wpe/scene` 三项，`extensions` 为空（不可按扩展名摄入，只能经
    `project.json` 入库）。
    > 说明：保持「格式表是唯一事实来源」，`media_format("x-wpe/video")` 能解析；`mime` 只是占位，
    > 目录型条目永远不经 `mime_from_format` 出边界（媒体服务按入口文件扩展名定 MIME）。
    > 前缀用 `x-wpe/`：沿用 MIME 的 `x-` 私有类型惯例，与 `image/`、`video/` 等标准顶级类型明确区分，
    > 不会被任何按标准 MIME 前缀判断的代码误认。
  - `is_wpe_format(key)` / `wpe_kind(key)` 辅助函数；`MediaFormat::is_wpe()`。
  - `is_video_like_type(type)`：`video/*` 或 `x-wpe/video`，供轮播与前端以外的后端判定统一使用。
```rust
    MediaFormat {
        key: "x-wpe/video",               // 新增：WPE 视频壁纸目录
        mime: "application/x-wpe-project",
        extensions: &[],                // 新增：不按扩展名摄入
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    // 新增：x-wpe/web、x-wpe/scene 同形，第一阶段不入库，只占位

impl MediaFormat {
    /// 新增：目录型 WPE 壁纸（local_path 是目录）。
    pub fn is_wpe(&self) -> bool {
        self.key.starts_with("x-wpe/")
    }
}

/// 新增：按 images.type 判断是否「播放为视频」。
pub fn is_video_like_type(media_type: Option<&str>) -> bool {
    matches!(media_type, Some(t) if t.starts_with("video/") || t == "x-wpe/video")
}
```
- **修改**
  - `get_supported_image_types` 返回值不变（仍只列可摄入扩展名），前端另用类型前缀判断 `x-wpe/`。

## 点 2 — WPE 发现与 `project.json` 解析（新增 `kabegame-core/src/wpe/`）
- **新增**
  - `wpe/discover.rs`：`discover_wpe_roots() -> Vec<WpeRoot>`。
    - Windows：读 `HKCU\Software\Valve\Steam\SteamPath`；Linux：`~/.steam/steam`、`~/.local/share/Steam`
      （WPE 经 Proton 运行时创意工坊目录同样存在，video 型可跨平台导入）；macOS / Android / Web：返回空。
    - 解析 `steamapps/libraryfolders.vdf`（只取 `path` 与 `apps` 键，手写最小 VDF 解析，不引新依赖）。
    - 每个含 `431960` 的库产出三类根：`Workshop(<库>/steamapps/workshop/content/431960)`、
      `DefaultProjects(<库>/steamapps/common/wallpaper_engine/projects/defaultprojects)`、
      `MyProjects(<库>/steamapps/common/wallpaper_engine/projects/myprojects)`。
  - `wpe/recognize.rs`：`recognize_dir(path) -> Recognized`，把用户随手选的文件夹识别成壁纸目录集合：
    - 含 `project.json` → 单个壁纸目录；
    - 名为 `431960` 或子目录多为纯数字且各含 `project.json` → 创意工坊根；
    - 含 `wallpaper64.exe` / `projects/` → WPE 安装目录（展开 defaultprojects + myprojects）；
    - 含 `steamapps/` → Steam 库根（按上面规则展开）；
    - 其它 → 向下递归最多 2 层找 `project.json`，都没有则返回「未识别」。
  - `wpe_scan` 命令（只读，不入库）：返回各根下壁纸数按 `kind` 分组、已入库数，供入口对话框预览。
  - `wpe/project.rs`：`WpeProject { dir, kind, file, preview, title, description, tags, workshop_id,
    content_rating, raw }`，`read_project(dir) -> Result<WpeProject, WpeSkip>`。
    - `type` 小写归一；`file` / `preview` 必须是目录内相对路径（拒绝绝对路径与 `..` 越界）。
    - `WpeSkip::{NoProject, Unsupported(kind), MissingEntry, Invalid(String)}`，供任务日志统计。
```rust
pub struct WpeProject {
    pub dir: PathBuf,              // 绝对、规范化、无 \\?\ 前缀、无尾斜杠 → 即 local_path
    pub kind: WpeKind,             // Video / Web / Scene / Application / Other(String)
    pub file: Option<String>,      // 入口文件（目录内相对路径）
    pub preview: Option<String>,   // 预览图（目录内相对路径）
    pub title: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub workshop_id: Option<String>,
    pub raw: serde_json::Value,    // 原样保留，写入 metadata
}
```

## 点 3 — 「壁纸」入口与内建任务 `wpe-import`（前端入口、`plugin/builtin.rs`、新增 `crawler/wpe_import.rs`）
- **新增**（前端入口）
  - `CollectSourcePicker.vue` 增加第四项 `wallpaper`（「壁纸」，桌面端可见，Web / Android 隐藏），
    `GalleryToolbar.vue` 分发到新对话框 `WallpaperImportDialog.vue`。
  - 对话框打开即调 `wpe_scan`：列出自动识别到的三类来源（创意工坊 / 官方默认 / 我的项目），每类一个勾选项与
    「共 N 个，可导入 M 个（视频），已导入 K 个」；另有「添加文件夹」按钮，选中后经 `recognize_dir` 展开并追加
    到列表。默认三类全选。确认后提交 `wpe-import` 任务，输出画册沿用其它来源的「目标画册」选项。
```ts
type CollectSource = "local" | "remote" | "webpage" | "wallpaper"; // 修改：新增「壁纸」
// ...
  ...(!IS_WEB && !IS_ANDROID
    ? [{ id: "wallpaper", title: t("gallery.wallpaper"), desc: t("gallery.wallpaperDesc"), icon: Picture }]
    : []), // 新增
```
- **新增**（后端）
  - 内建插件定义（与 `local-import` 同形），变量：
    - `sources`：多选 `workshop` / `defaultprojects` / `myprojects`，默认全选。
    - `extraDirs`：路径列表（对话框里「添加文件夹」识别出的目录），任务内再走一次 `recognize_dir`。
  - `run_builtin_wpe_import(task)`：发现 → 逐目录 `read_project` → 按类型分派。第一阶段只处理 `Video`，
    其它类型 `skip` 并按类型计数写任务日志；进度按目录数推进，支持取消。
  - `import_wpe_video(project, album_id)`：
    - `local_path` 已存在 → 幂等跳过（仅补画册成员），与 `import_local_file` 同语义。
    - `thumbnail_path` = `<dir>/<preview>` 的绝对路径（gif / jpg / png 原样，不生成任何缩略图）；预览缺失则留空。
    - 宽高、时长、大小来自入口视频探测；`hash` 对入口视频求哈希（与普通视频口径一致）。
    - `compatible_path`：始终写入。浏览器可播 → 入口视频绝对路径；不可播 → `generate_compatible_video`
      （产物在 `compatibles_dir`），生成失败回落入口视频。已入库行重跑导入时补齐空 / 失效的值并发字段补丁。
    - `display_name` = `title`；`description` = `description`；`url` = 创意工坊页面地址（有 `workshop_id` 时）。
    - `metadata`：`project.json` 原文（`plugin_id = "wpe-import"`），供详情面板展示；`tags` → 标签画册
      （`WPE/<tag>`，复用插件 `labels` 挂载链路）。
    - 写库后照常发 `images-added` / 成员事件。
```rust
// crawler/wpe_import.rs（新增）
let image = ImageInfo {
    local_path: project.dir.to_string_lossy().into_owned(), // 目录本身
    plugin_id: Some(WPE_IMPORT_PLUGIN_ID.to_string()),
    media_type: Some("x-wpe/video".to_string()),
    thumbnail_path: preview_abs.unwrap_or_default(),        // WPE 自带 preview，原样引用
    compatible_path,                                         // 始终有值：入口视频本身或兼容副本
    display_name: project.title.clone(),
    width, height, size: entry_size, hash: entry_hash,
    // ...
};
```
- **修改**
  - `crawler/mod.rs` / `task_scheduler`：`plugin_id == "wpe-import"` 分派到新 runner。
  - 内建插件照常过滤出前端插件管理列表（与 `local-import` / `webpage` 同）。

## 点 4 — 目录服务 `/wpe/<imageId>/<rel>`（`kabegame/src/http_server.rs`）
- **新增**
  - 路由 `/wpe/{id}/{*rel}` 与 `/wpe/{id}/`：
    - 授权：`find_image_by_id(id)` 且 `type` 以 `x-wpe/` 开头，否则 404。
    - `rel` 为空 → 读 `project.json` 的 `file`，302 到 `/wpe/<id>/<file>`。
    - 否则 `local_path.join(rel)` canonicalize 后必须 `starts_with(canonicalize(local_path))`；MIME 按扩展名；
      复用 `serve_file_with_mime`（Range、缓存头与现有媒体一致）。
  - 只挂在本地媒体路由（`file_routes` / `file_routes_media`），Web 发布版不挂。
```rust
        .route("/file/{*path}", get(handle_file_path))
        .route("/thumbnail/{*path}", get(handle_thumbnail_path))
        .route("/compatible/{*path}", get(handle_compatible_path))
        .route("/wpe/{id}/", get(handle_wpe_entry))          // 新增：302 到入口
        .route("/wpe/{id}/{*rel}", get(handle_wpe_file))     // 新增：目录内文件，越界拒绝
```
- **修改**
  - `/file/{*path}` 对 `x-wpe/*` 行返回 404（目录不可当文件读），避免误把目录交给 `serve_file_with_mime`。

## 点 5 — 删除与清理护栏（`storage/images.rs`、`storage/image_events.rs`）
- **修改**
  - `remove_thumbnail_file_if_needed` 改为只删除位于 `thumbnails_dir` 内的文件（与 `remove_compatible_file_if_owned`
    同样 canonicalize + `starts_with`），从根上杜绝删掉 WPE 的 `preview.*`。
  - 删除流程中 `x-wpe/*` 行的 `local_path` 不进入 `local_paths_to_purge`：从 Kabegame 删除只删记录，不动用户的
    WPE 目录（取消订阅属于 Steam 的事）。前端「同时删除源文件」对 WPE 行置灰并提示。
```rust
fn remove_thumbnail_file_if_needed(local_path: Option<&str>, thumbnail_path: Option<&str>) {
    // ...
    // 修改：只删 Kabegame 自己生成、位于 thumbnails_dir 内的缩略图
    let Ok(root) = AppPaths::global().thumbnails_dir().canonicalize() else { return };
    let Ok(target) = Path::new(thumb).canonicalize() else { return };
    if !target.starts_with(&root) {
        return;
    }
    let _ = fs::remove_file(&target);
}
```

## 点 6 — `local_path` 当文件用的调用点逐项分流（审计项）
- **修改**（第一阶段必须逐个确认并加 `x-wpe/*` 分支，不能靠目录在 `fs::read` 时失败兜底）
  - Organize / 重建缩略图与兼容副本 / 重算哈希：`x-wpe/*` 跳过缩略图重建，兼容副本与哈希针对入口文件。
  - 原生元数据（`image_metadata`，EXIF/PNG chunk）：`x-wpe/*` 不解析。
  - 虚拟盘（Dokan / FUSE）：`x-wpe/*` 第一阶段隐藏（VD 的 provider 路径加 `type NOT LIKE 'x-wpe/%'` 过滤，
    计数口径同步）。
  - 原生壁纸 `wallpaper_compat::ensure_native_wallpaper_path`、Plasma 插件：拒绝 `x-wpe/*`。
  - 拖出真实文件、复制文件、分享、「在文件夹中显示」：拖出 / 复制禁用；「在文件夹中显示」打开该目录。
  - 本地文件夹同步扫描：不会扫到 WPE 目录，但 `find_image_by_path` 命中目录时不得当作文件比对。
  - MCP / JSON-RPC 媒体字段：`type` 原样透出，视频媒体 URL 用 `compatible_path`。

## 点 7 — 轮播与壁纸窗口按类型分流
- **修改**（`kabegame/src/wallpaper/rotator.rs`）
  - `is_wallpaper_suitable` / `media_allowed_in_mode` 改为按行的 `type` 判断：`x-wpe/*` 只在 `window` 模式可用；
    `video/*` 维持 window / plasma-plugin 可用。`media_allowed_in_mode` 的入参从路径改为 `ImageLite`（带 type）。
```rust
pub(crate) fn is_wallpaper_suitable(img: &ImageInfo, wallpaper_mode: &str) -> bool {
    if !Path::new(&img.local_path).exists() {
        return false;
    }
    let ty = img.media_type.as_deref();
    if is_wpe_type(ty) {
        return wallpaper_mode == "window";            // 新增：WPE 第一阶段只走窗口模式
    }
    if wallpaper_mode == "window" || wallpaper_mode == "plasma-plugin" {
        return true;
    }
    !is_video_like_type(ty)                          // 修改：按 type，不再按扩展名
}
```
  - `set_wallpaper_by_image_id` 在非窗口模式下对 `x-wpe/*` 返回明确错误（「此壁纸需窗口模式」）。
- **新增**（`kabegame/src/commands/wallpaper.rs`）
  - `get_current_wallpaper_target -> Option<{ id, path, type }>`；`get_current_wallpaper_path` 保留给旧调用方。
- **修改**（`apps/kabegame/src/wallpaper.ts`）
  - 初始化与 `setting-change` 改用 `get_current_wallpaper_target`；`setImagePath(path)` 改为
    `setTarget({ id, path, type })`：`x-wpe/video` → `videoUrl = compatibleToUrl(compatiblePath)`，复用现有视频播放 / 过渡 / 音量 /
    倍速逻辑；其余类型维持按扩展名的旧逻辑。去重键从 `path` 改为 `id + path`。

## 点 7b — WPE 视频播放属性在壁纸窗口复现（不生成壁纸副本）
- **新增**（后端）
  - `wpe/properties.rs`：`resolve_video_props(project) -> WpeVideoProps`，只取**作者默认值**：
    WPE 标准默认值（`alignment = 0` 等）→ `project.json` 的 `general.properties[*].value`。
    **不读** WPE 的 `config.json` / `wproperties`（用户在 WPE 里改过的属性不带入）。
  - `get_current_wallpaper_target` 对 `x-wpe/video` 额外返回 `wpeVideo: WpeVideoProps`（作者默认值层）。
  - **合并规则：作者默认值 + Kabegame 覆盖**。Kabegame 已有的壁纸设置覆盖作者值的对应字段，Kabegame
    没有对应设置的字段沿用作者值：

    | 字段 | 来源 | 说明 |
    |---|---|---|
    | 对齐 `alignment` | Kabegame 壁纸样式覆盖 | `fill`→Cover、`fit`→Fill、`stretch`→Stretch、`center`→Center；`tile` 对视频无意义，按 Cover |
    | 速率 `rate` | Kabegame 视频倍速覆盖 | `get_wallpaper_video_playback_rate` |
    | 音量 `volume` | Kabegame 壁纸音量覆盖 | `get_wallpaper_volume` |
    | `position` / `offset` / `zoom` | 作者值 | Kabegame 无对应设置；仅当覆盖后的对齐为 Cover/Fill（position）或 Center/Free（offset/zoom）时生效 |
    | `flip_h` / `background` / `color` | 作者值 | Kabegame 无对应设置 |

    > 说明：Kabegame 的样式 / 音量 / 倍速是全局设置、始终有值，所以这三项实际总以 Kabegame 为准，作者值只在
    > 详情面板展示；以后若要「逐壁纸覆盖」，在这一层之上再加一层，不改合并方向。覆盖在壁纸窗口前端完成
    > （它本来就监听这些设置的 `setting-change`），后端只给作者值。
```rust
pub struct WpeVideoProps {
    pub alignment: WpeAlignment,          // Cover / Fill / Stretch / Center / Free
    pub position: f32,                    // alignmentposition × 0.01
    pub offset: (f32, f32),               // alignmentx / alignmenty × 0.01
    pub zoom: f32,                        // alignmentz × 0.01
    pub flip_h: bool,                     // alignmentfliph
    pub background: Option<[u8; 3]>,      // schemecolor
    pub rate: Option<f32>,                // rate / 100
    pub volume: Option<f32>,              // volume / 100
    pub color: Option<WpeColorAdjust>,    // wec_e 开启时：brs / con / sa / hue，各 −1…1
}
```
- **修改**（`apps/kabegame/src/wallpaper.ts`）
  - `x-wpe/video` 先按上表把 Kabegame 设置覆盖到 `wpeVideo`，再计算视频元素样式：
    - `alignment` → `object-fit`：Cover→`cover`、Fill→`contain`（待真机确认）、Stretch→`fill`、Center→`none`、
      Free→`none` + `transform: translate(x, y) scale(zoom)`；`position` / `offset` → `object-position`。
    - `flip_h` → `transform: scaleX(-1)`；`background` → 容器背景色（留边颜色）。
    - `color` → CSS `filter: brightness() contrast() saturate() hue-rotate()`（WPE 的 −1…1 换算到 CSS 量纲，
      以真机对比校准）。
    - `rate` / `volume`：直接用 Kabegame 设置（覆盖作者值），沿用现有的 `applyVideoLoopToElement` / 音量逻辑。
  - `wcc_v` 图像滤镜预设第一阶段不实现，忽略并在详情里提示。
- **不做**
  - 不为 `x-wpe/video` 生成 `wallpaper_compatible_path` 或任何按屏幕分辨率缩放的副本（WPE 也不做）。
  - 不复刻 WPE 的解码后端选择与 `frommemory` 读入模式；CEF 的 `<video>` 直接按 Range 读 `/compatible/<入口视频>`。

## 点 8 — 图库前端：预览图原样 + 入口视频（`apps/kabegame/src/`）
- **新增**
  - `utils/mediaMime.ts`：`isWpeMediaType(t)`、`wpeKind(t)`；播放源统一取 `compatiblePath`（不新增 `/wpe` URL 工具）。
- **修改**
  - `ImageContent.vue`：`x-wpe/video` 时
    - `prefer === "thumbnail"`：模式为 `image`，源链 `thumb`（`preview.gif` 以 `<img>` 原生播放，jpg 静态）；
    - 预览 / 原图：模式为 `video`，源链 `comp → wpe 入口`（`sourceOf(localPath)` 对 WPE 行改为 `wpeEntryUrl`）。
  - `ImageItem.vue`：网格悬停不再自动播放视频（WPE 的 gif 预览本身就是动图，贴近 WPE 浏览器体验）；角标显示
    「WPE · 视频」。
  - `ImagePreviewDialog.vue` / `PswpSlideContent.vue` / `App.vue` 背景：`isPreviewVideo` 改用
    「`isVideoMediaType || wpeKind === 'video'`」。
  - `ImageBasicInfoPanel.vue`：类型显示「Wallpaper Engine · 视频」，展示标题、标签、创意工坊链接（来自 metadata）。
  - `useImageOperations.ts`：WPE 行禁用「复制文件」「拖出」「删除源文件」，「打开所在位置」打开目录。
```ts
const isWpeVideo = computed(() => wpeKind(props.image.type) === "video");
const mode = computed<"image" | "gif" | "video">(() => {
  if (isWpeVideo.value) return props.prefer === "thumbnail" ? "image" : "video"; // 新增
  if (!isVideo.value) return "image";
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});
```

## 点 9 — 文档与回归
- **新增**
  - `cocs/wpe/WPE_IMPORT.md`：目录型壁纸模型、`x-wpe/*` 类型、发现规则、目录服务、删除护栏、阶段路线；`cocs/README.md`
    补索引；`AGENTS.md`「文件类型的唯一事实来源」补一句目录型条目。
  - `versions/latest/regression.md` 与 `changelog.md` 各补一节。
- **回归要点**：发现多 Steam 库；重复运行幂等；gif / jpg 预览在网格中原样显示；预览大图播放 276MB 入口视频
  （Range 拖动）；窗口模式设为壁纸并参与轮播；原生模式过滤 WPE；删除记录后 WPE 目录与 `preview.*` 完好；
  创意工坊取消订阅后行显示为缺失；`/wpe/<id>/../` 越界请求被拒。

## 待真机验证

- `alignment = fill(1)` 的几何是否等同 `object-fit: contain`；`center(3)` 出现的条件（属性面板构造的 `param_2` 第 2 位）。
- `wec_*` 的 −1…1 与 CSS filter 量纲的对应（同一帧截图对比）。
- CEF 对创意工坊常见编码（H.264 / HEVC / VP9 / AV1）的实际可播性，决定兼容副本触发率。
