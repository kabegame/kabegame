# WPE 壁纸导入与兼容 — 总纲

> 状态：总纲（各阶段细化见下方子目录）
>
> 目标：自动发现用户本机的 Wallpaper Engine（WPE）壁纸，把 Kabegame 能支持的类型**原地引用**入库，
> 在图库里尽量贴近 WPE 的浏览体验，并能设为壁纸。分阶段推进：Video → Web → Scene → Scene 特效。
>
> 内建任务 ID（拟）：`wpe-import`；图片类型键（拟）：`x-wpe/video`、`x-wpe/web`、`x-wpe/scene`。

## 总体设计思路

一个 WPE 壁纸不是一个文件，而是一个**目录**：`project.json` 描述类型（`video` / `web` / `scene` /
`application`）、入口文件（`file`）、预览（`preview`）、标题、标签和用户属性，入口文件和其它资源与它
放在一起。因此 Kabegame 把「一个 WPE 壁纸目录」作为一行 `images` 记录：`local_path` 直接存该目录的
绝对路径（不复制、不转码、不在用户目录里写任何东西），`type` 存 `x-wpe/<kind>`。`local_path` 的唯一约束
天然保证同一壁纸只入库一次；壁纸更新、取消订阅都只影响磁盘上那一个目录，Kabegame 不持有副本。

`type` 以 `x-wpe/` 开头即表示「这是一个目录型壁纸，`local_path` 不是可直接读取的媒体文件」。凡是
把 `local_path` 当文件用的地方（哈希、元数据解析、媒体服务、拖出、虚拟盘、原生壁纸、删除源文件）都要
按类型分流，而不是按扩展名猜。图库展示尽量用 WPE 自带资源：每个壁纸目录里都有 `preview.jpg` /
`preview.gif`（少数还有 png / svg），**直接作为 `thumbnail_path`**——gif 就用 `<img>` 播 gif，不转成预览
视频，与 WPE 浏览器里的观感一致。壁纸的渲染只有一份 Vue 组件 `WallpaperStage`：壁纸窗口（与主窗口同一个 `index.html`）用它播桌面壁纸；图库对没有
单文件媒体形态的类型（Web、Scene）经 `ImageContent` 切到它，预览大图再按桌面分辨率布局并等比缩放，用户看到的就是
设到桌面上的样子，并且可以直接交互（桌面窗口挂在 WorkerW 下收不到鼠标，预览里可以）。WPE 视频在图库里仍按普通
视频对待（预览可 seek），只有桌面窗口用 `WallpaperStage` 播它。视频行的 `compatible_path` **始终有值**：浏览器能播时就是入口视频本身的绝对路径，
播不了时才在 Kabegame 自己的 `compatibles_dir` 里生成兼容副本（与现有视频兼容机制相同，不碰用户目录）；
预览大图、应用背景、壁纸窗口全部经 `/compatible` 播它，不走任何跳转。

为让目录内的入口与相对资源可被前端和壁纸窗口访问，新增一个**按图片 id 寻址的目录服务**
`/wpe/<imageId>/<相对路径>`：授权只认 `type` 为 `x-wpe/*` 的行，解析结果必须仍位于该行的 `local_path`
之内；`/wpe/<imageId>/` 不带相对路径时 302 到 `project.json` 的入口文件。Video 阶段**不用它播放**
（CEF `<video>` 跟随这次跳转后报 Format error，真机已证），Web 阶段复用（`index.html` 的相对 js/css 自然落在同一前缀下），Scene 阶段用它读 `scene.json` 与资源。
这样前端不必知道入口文件名，也不需要把入口写进新列。

壁纸窗口目前通过 `get_current_wallpaper_path` 拿到 `local_path`，再按扩展名决定播图还是播视频。
引入 WPE 后改成「拿到当前壁纸的 `{ id, path, type }`，按类型分流」：普通图片 / 视频行为不变，
`x-wpe/video` 播 `compatiblePath`。轮播与可用性判定同样从「按路径扩展名」改为「按行的 type」，
`x-wpe/*` 第一阶段只允许窗口模式，原生模式与 Plasma 插件模式过滤掉。

视频壁纸不能只当「一个 mp4」处理。逆向确认 WPE **不生成任何视频副本**：没有转码、没有缩放后的
壁纸副本（不存在 `wallpaper_compatible_path` 的等价物），`wallpaper64.exe` 只动态加载 Media Foundation 的解码
入口（Source Reader），没有编码器；用户可选三种解码后端（`mfEngine` = Media Engine Dx11、`mf`、
`dshow.lav.vmr9`）并带静音回退链。缩放、对齐、翻转、背景色、播放速率、音量与亮度 / 对比度 / 饱和度 /
色相调整全部是**播放时在 GPU 上做的逐壁纸属性**，来源是 `project.json` 的 `general.properties`
（作者默认值）加 WPE 注入的一组标准视频属性（`alignment` 默认 `cover`）。因此 Kabegame 对
`x-wpe/video` 同样**只播原文件**：壁纸窗口用 `<video>` + CSS（`object-fit` / `object-position` / `transform` /
`filter` / 背景色）在渲染时复现这些属性，不生成壁纸兼容副本；只有当 WPE 能解（MF 可借系统解码器播 HEVC 等）
而 CEF 解不了的编码，才走现有的浏览器兼容副本（`compatible_path`，在 `compatibles_dir`）。

导入有一个**独立入口「壁纸」**，在「开始收集」里与「本地 / 网络 / 网页」平行。「自动」指**自动智能识别
壁纸目录**：打开入口即自动发现 Steam 库（注册表 / `libraryfolders.vdf`），列出创意工坊
`workshop/content/431960/*`、WPE 安装目录下 `projects/defaultprojects/*` 与 `projects/myprojects/*` 三类来源
及各自按类型的数量；用户也可以随手选任意文件夹（单个壁纸目录、`431960` 根、WPE 安装目录或 Steam 库根），
识别器按目录结构判断它是哪一种并展开成壁纸目录集合。确认后提交内建任务 `wpe-import`（与 `local-import` /
`webpage` 同为 builtin），复用任务列表、进度、取消与日志，不另建同步服务。任务逐目录读 `project.json`
分类；第一阶段只入库 `type = video`，其它类型计入「跳过」并写任务日志，为后续阶段留下统计依据。
`project.json` 的 `tags` 挂到 `WPE/<tag>` 标签画册，不自动建收纳画册。

后续阶段的渲染路线已定：Web 型在壁纸本体里以跨源 iframe 加载并注入 `wallpaperPropertyListener` 等 API；
Scene 型走 **WebGPU**，在壁纸本体里用 canvas 渲染，不做原生 wgpu 渲染器；届时用 REA 对 `wallpaper64.exe`
补齐 `.pkg` / `.tex` / shader 方言（翻译到 WGSL）的格式细节。

## 现状锚点

**a. 格式表只描述单文件格式**（`src-tauri/kabegame-core/src/media/image_type.rs:48`）
```rust
pub const MEDIA_FORMATS: &[MediaFormat] = &[
    // ... image/jpg、image/png、image/gif ...
    MediaFormat {
        key: "image/tiff",
        mime: "image/tiff",
        extensions: &[],          // 现状：空扩展名 = 能识别但不可按扩展名摄入
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "video/mp4",
        mime: "video/mp4",
        extensions: &["mp4", "m4v", "3gp", "3g2"],
        // ...
    },
    // 现状：没有任何目录型条目，种类只由 image/ video/ 前缀编码
];
```

**b. 本地导入：local_path 即文件，缩略图 / 兼容副本都由文件生成**（`src-tauri/kabegame-core/src/local_folder/import.rs:56`）
```rust
    let hash = compute_file_hash(path).await?;              // 现状：对 local_path 文件求哈希
    let is_video = is_video_by_path(path);                  // 现状：按扩展名判断视频
    let thumbnail_path = build_thumbnail_path(path, is_video).await; // 视频 → 生成预览视频
    let (width, height) = resolve_media_dimensions_sync(&path.to_string_lossy())
        .map(|(w, h)| (Some(w), Some(h)))
        .unwrap_or((None, None));
    // ...
    let compatible_path = build_compatible_path(path, is_video, &media_type, width, height).await;
```

**c. 删除图片时无条件删缩略图文件**（`src-tauri/kabegame-core/src/storage/images.rs:177`）
```rust
fn remove_thumbnail_file_if_needed(local_path: Option<&str>, thumbnail_path: Option<&str>) {
    let Some(thumb) = thumbnail_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    if let Some(local) = local_path.map(str::trim).filter(|p| !p.is_empty()) {
        if local == thumb {
            return;
        }
    }
    let _ = fs::remove_file(thumb); // 现状：只要缩略图 ≠ 原图就删，不校验是否在 thumbnails_dir 内
}
```
对比同文件的兼容副本删除已有归属校验（`images.rs:194`，canonicalize 后 `starts_with(compatibles_dir)`）。
若把 `thumbnail_path` 指向 WPE 目录里的 `preview.gif`，现状会在删除图片时把用户的 `preview.gif` 删掉。

**d. 源文件清除对目录已有护栏**（`src-tauri/kabegame-core/src/storage/safe_delete.rs:119`）
```rust
fn path_is_normal_local(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if !meta.is_file() {   // 现状：目录不会进回收站，但这是间接保护，语义上没有表达「WPE 不清源」
        // ...
```

**e. 媒体服务按 local_path 精确授权**（`src-tauri/kabegame/src/http_server.rs:108`）
```rust
async fn authorize_local_path(path: &str) -> Result<kabegame_core::storage::ImageInfo, Response> {
    // ...
    match kabegame_core::storage::Storage::find_image_by_path(path) { // 现状：路径必须等于某行 local_path
        Ok(Some(info)) => Ok(info),
        _ => Err((StatusCode::NOT_FOUND, "file not found").into_response()),
    }
}
// 路由：/file/{*path}、/thumbnail/{*path}（按 thumbnail_path 授权）、/compatible/{*path}
```
目录内的入口视频不是任何行的 `local_path`，现状无法经 `/file` 访问；`/thumbnail` 按
`thumbnail_path` 授权，指向 `preview.gif` 时可以直接访问。

**f. 壁纸窗口拿路径、按扩展名分流**（`apps/kabegame/src/wallpaper.ts:85`、`:460`）
```ts
function isVideoPath(path: string): boolean {
  const ext = getPathExt(path);
  return ["mp4", "mov", "wmv", "webm", "mkv"].includes(ext); // 现状：目录路径会被当成图片
}
// ...
    const isVideoMedia = isVideoPath(normalizedPath);
    if (isVideoMedia) {
      const videoUrl = await getVideoUrl(normalizedPath);    // 现状：fileToUrl(local_path)
```
路径来源（`src-tauri/kabegame/src/commands/wallpaper.rs:24`）：
```rust
    if let Some(id) = Settings::global().get_current_wallpaper_image_id() {
        let img = Storage::find_image_by_id(&id).map_err(|e| format!("Storage error: {}", e))?;
        if let Some(info) = img {
            Ok(Some(info.local_path))   // 现状：只回 local_path，不带 type / id
```

**g. 轮播可用性按路径扩展名判断**（`src-tauri/kabegame/src/wallpaper/rotator.rs:115`）
```rust
pub(crate) fn is_wallpaper_suitable(img: &ImageInfo, wallpaper_mode: &str) -> bool {
    if !Path::new(&img.local_path).exists() {
        return false;
    }
    if wallpaper_mode == "window" || wallpaper_mode == "plasma-plugin" {
        return true;
    }
    !kabegame_core::media::image_type::is_video_by_path(Path::new(&img.local_path))
    // 现状：目录不是视频扩展名 → 原生模式会误判为可用
}
```

**h. 前端只认 image / video 两种形态**（`apps/kabegame/src/utils/mediaMime.ts:6`、`components/image/ImageContent.vue:269`）
```ts
export function isVideoMediaType(t: string | undefined): boolean {
  if (t == null) return false;
  const s = String(t).trim().toLowerCase();
  return s === "video" || s.startsWith("video/");  // 现状：x-wpe/video 会被当成图片
}
```
```ts
const mode = computed<"image" | "gif" | "video">(() => {
  if (!isVideo.value) return "image";
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});
// sourceOf(localPath) → fileToUrl(path)：现状把目录路径交给 /file
```

**i. WPE 侧可用资源（本机实测，WE 2.8.0.42）**
- 创意工坊：`<库>/steamapps/workshop/content/431960/<workshopid>/`；本机 2 个：
  `2725770343`（video：`Wallpaper-1.mp4` 276MB + `preview.gif` 736KB）、
  `796697921`（web：`index.html` + 一组 js/css + `preview.jpg/png/svg`）。
- 安装目录：`<库>/steamapps/common/wallpaper_engine/projects/{defaultprojects,myprojects}/*`；
  默认项目 19 个（14 scene、2 web、1 exe、2 其它），预览为 `preview.jpg` 或 `preview.gif`。
- `project.json`（video 样例）：
```json
{
  "file" : "Wallpaper-1.mp4",
  "preview" : "preview.gif",
  "title" : "Solitude by Visualdon",
  "type" : "video",
  "tags" : [ "Retro" ],
  "contentrating" : "Everyone",
  "general" : { "properties" : { "schemecolor" : { "type" : "color", "value" : "0.44 0.27 0.63" } } }
}
```
  web 样例还带 `workshopid`、`workshopurl`、`approved`、`ratingsex`、`ratingviolence`、`visibility`。
- **WPE 不提供预览视频**，只有单张预览图（gif 即动图）。
- Steam 库发现：`HKCU\Software\Valve\Steam\SteamPath` → `<SteamPath>/steamapps/libraryfolders.vdf`
  列出各库 `path` 与 `apps`（含 `431960` 表示 WPE 装在该库；创意工坊内容随 WPE 所在库）。

**j. WPE 视频播放链路（REA 静态，`wallpaper64.exe` SHA-256 `40e2ce02…`，WE 2.8.0.42）**

全局视频设置（`FUN_1400ff750`，读 `config.json` 的 `general.user.*`）：
```c
puVar8 = FUN_140086de0(param_2, "videoframework", "");   // 解码后端
if (框架 == "dshow.lav.vmr9") { 候选链 = ["dshow.lav.vmr9", "mfEngine", "mfEngine.muted", ..., "mf.muted"]; }
else if (框架 == "mf")        { 候选链 = [..., "mf.muted", "dshow.lav.vmr9", "mfEngine", "mfEngine.muted"]; }
else /* 默认 mfEngine */       { 候选链 = ["mfEngine", "mfEngine.muted", ..., "mf.muted", "dshow.lav.vmr9"]; }
// 现状：三种后端 + 静音回退，失败就换下一个；不存在「转码后再播」的分支
videoaudiooutput / videohardwareacceleration                // 开关
videoloopmode: "syncclock" → 1, "synctopo" → 2, 其它 → 0    // 循环同步方式
videoreadmode: "frommemory" → 1（整文件读入内存走 ByteStream），否则 0（从磁盘读 URL）
videomfstutterhack                                          // MF 卡顿补丁开关
```
`mfplat.dll` / `mfreadwrite.dll` 动态加载，只取 `MFCreateSourceReaderFromURL` / `…FromByteStream`；字符串
清单中无 SinkWriter / Transcode / FFmpeg（Ghidra 已定义字符串内的有限否定），`bin/` 下也无 FFmpeg 动态库。
本机 `config.json`：`videoframework = mfEngine`、`videoreadmode = fromdisk`、`videoloopmode = default`；
WPE 目录下除浏览器缩略图（`ui/thumbnails/ws_<id>_thumb.jpg`，仅 web 型有）外没有任何视频缓存。

逐壁纸属性应用（`FUN_1400ffcb0`，读壁纸的 `general.properties`，变更后交给 `FUN_140100720` 重新布局）：

| 属性 | 换算 | 含义 |
|---|---|---|
| `volume` | `value / 100` | 音量 |
| `rate` | `value / 100`，400ms 防抖定时器 | 播放速率 |
| `schemecolor` | `"r g b"`（0–1 浮点）→ ARGB | 背景 / 留边颜色 |
| `alignment` | 整数 | 0 cover（默认）· 1 fill · 2 stretch · 3 center（部分情况才出现）· 4 free |
| `alignmentposition` | `value × 0.01` | cover / fill 时沿溢出轴的位置（`alignment.value<2` 才显示） |
| `alignmentx` / `alignmenty` | `value × 0.01` | center / free 时的水平 / 垂直偏移（`==3‖==4` 才显示） |
| `alignmentz` | `value × 0.01` | free 时的缩放（`==4` 才显示） |
| `alignmentfliph` | 布尔 | 水平翻转 |
| `wec_e` | 布尔 | 「显示颜色选项」总开关 |
| `wec_brs` / `wec_con` / `wec_sa` / `wec_hue` | `value / 50 − 1`（−1…1） | 亮度 / 对比度 / 饱和度 / 色相 |
| `wcc_v` / `wcc_amt` | — | 图像滤镜预设 / 强度（`ui_browse_properties_image_filter`），实现未展开 |

属性面板定义（`FUN_140104b60`，16KB）把上表作为 WPE 注入的标准属性：`alignment` 为 combo，选项按
cover(0)、fill(1)、[center(3)]、stretch(2)、free(4) 排列，默认 0。`fill` 与 `cover` 的精确几何（是否 contain）
只有静态推断，需真机切换确认。用户对属性的改动存在 `config.json` 的 `<user>.wproperties`（本机为空，键结构未验证）。

**k. Kabegame 壁纸窗口的样式与 CSS 映射**（`apps/kabegame/src/wallpaper.ts:122`）
```ts
    case "fill":    base.objectFit = "cover";   base.objectPosition = "center"; break;
    case "fit":     base.objectFit = "contain"; base.objectPosition = "center"; break;
    case "stretch": base.objectFit = "fill";    base.objectPosition = "center"; break;
    case "center":  base.objectFit = "none";    base.objectPosition = "center"; break;
    // 现状：样式是全局设置（get_wallpaper_rotation_style），不随单张壁纸变化；无翻转 / 滤镜 / 背景色
```
音量与倍速同样是全局设置（`get_wallpaper_volume`、`get_wallpaper_video_playback_rate`）。

**l. 收集来源只有三项**（`apps/kabegame/src/components/CollectSourcePicker.vue:24`）
```ts
type CollectSource = "local" | "remote" | "webpage"; // 现状：本地 / 网络 / 网页

const sourceOptions = computed<OptionItem[]>(() => [
  ...(!IS_WEB ? [{ id: "local", title: t("gallery.local"), desc: t("gallery.localDesc"), icon: FolderOpened }] : []),
  { id: "remote", title: t("gallery.network"), desc: t("gallery.remoteDesc"), icon: Connection },
  ...(!IS_WEB ? [{ id: "webpage", title: t("gallery.webpage"), desc: t("gallery.webpageDesc"), icon: Link }] : []),
]);
```
`GalleryToolbar.vue:222` 按选中项分发（`webpage` → `showWebpageCollect` → `WebpageCollectDialog.vue`）。

---

## 阶段路线

| 阶段 | 类型 | 图库展示 | 设为壁纸 | 主要工作 |
|---|---|---|---|---|
| 1 | `x-wpe/video` | 预览图（gif 原样）+ 入口视频 | 窗口模式播放入口视频 | 发现与导入、目录服务、类型分流、删除护栏 |
| 2 | `x-wpe/web` | 预览图 + 内嵌壁纸本体 | 壁纸本体内跨源 iframe 加载入口页 | WPE Web API 垫片（`wallpaperPropertyListener`、音频、媒体集成），用户属性 |
| 3 | `x-wpe/scene`（静态 / 简单图层） | 预览图 | 渲染器 | 资源定位与解包（`scene.pkg` / `.tex`）、场景图、图层合成；WebGPU 渲染（壁纸本体内 canvas） |
| 4 | `x-wpe/scene`（特效） | — | — | 着色器方言翻译到 WGSL、粒子、SceneScript；REA 对照 `wallpaper64.exe` |
| — | `application` | 不导入 | — | 外部 exe，不支持 |

每个阶段一个子目录，阶段内再按 Phase 推进；本文件只放总体设计、现状锚点、路线与跨阶段决策：

| 阶段 | 目录 | 状态 |
|---|---|---|
| 1 Video | [1-video/PLAN.md](1-video/PLAN.md) | 已实现，初步真机测试完成 |
| 2 Web | [2-web/PLAN.md](2-web/PLAN.md) | Phase 1 完成（[API.md](2-web/API.md)）；Phase 2 壁纸窗口 Vue 化方案已写，实施中 |
| 3 Scene | [3-scene/RESEARCH.md](3-scene/RESEARCH.md) | 前期调研完成（格式 / 方言 / WebGPU 可行性 / Phase 拆分 / 关键决策待确认） |
| 4 Scene 特效 | `4-scene-fx/`（未建） | — |

---

## 已确认决策（2026-10-25）

1. **入口**：新增「壁纸」入口，与本地 / 网络 / 网页平行；「自动」= 自动智能识别壁纸目录（Steam 库发现 +
   任意文件夹结构识别），不是定时任务。
2. **扫描范围**：创意工坊订阅、`defaultprojects`、`myprojects` 三类默认全选。
3. **组织**：`tags` → `WPE/<tag>` 标签画册；不自动建收纳画册。
4. **虚拟盘**：第一阶段隐藏 WPE 行。
5. **预览资源**：WPE 自带的 `preview.gif` / `preview.jpg` 原样作缩略图，gif 不转视频，尽量贴近 WPE 体验。
6. **视频播放属性**：暂时用「作者默认值 + Kabegame 覆盖」——作者值来自 `project.json`，Kabegame 已有的样式 /
   音量 / 倍速覆盖对应字段，其余字段沿用作者值；不读 WPE 里用户改过的属性（见 [1-video 点 7b](1-video/PLAN.md)）。
7. **视频播放源**：`compatible_path` 始终设置——入口视频本身或生成的兼容视频；预览、应用背景、壁纸窗口及后续
   播放端都只走它，不走 `/wpe/<id>/` 跳转。
8. **预览内嵌壁纸本体**（2026-10-25 调整，10-26 细化）：壁纸渲染只有一份 Vue 组件 `WallpaperStage`，壁纸窗口与主窗口
   同一个 `index.html`；`ImagePreviewDialog` 对非视频 WPE 行（web / scene）经 `ImageContent` 切到它，按桌面分辨率布局后
   缩放，可交互。WPE 视频在图库里仍按普通视频对待（保留 seek），只有桌面壁纸窗口用 `WallpaperStage` 播它。
9. **Scene 走 WebGPU**（2026-10-25）：Scene 在壁纸本体里用 WebGPU canvas 渲染，shader 翻译到 WGSL，不做原生 wgpu。

10. **用户属性即元数据**（2026-10-26）：WPE 壁纸的用户可调属性与 `project.json` 同存于图片 `metadata`，由 WPE 定制详情面板写入，
    走元数据不可变语义（新行 + 改指 + `image-changed { metadataId }`），不另建表、不进 settings；宿主收到补丁后模拟 WPE 的
    属性变化事件推给页面。
11. **Web 壁纸页面源**（2026-10-26）：最终用自定义 Tauri 协议 **`kb-wpe`**（Phase 4 落地），Phase 3 先用本地 HTTP 服务。

## 待定决策

（暂无跨阶段待定项；各阶段的待定决策见各自目录。）
