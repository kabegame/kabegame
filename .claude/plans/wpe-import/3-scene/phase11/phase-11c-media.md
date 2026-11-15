# P11c — 媒体（子计划）

> 上级：[phase-11-audio-media.md](phase-11-audio-media.md)「P11c — 媒体」。
> 调研在总计划的步骤 0 已做完，不再单开 0b：
> - 读码 [rea-p11-media.md](rea-p11-media.md)：SMTC 子进程、合并与刷新、场景队列、每帧派发与补发、事件对象；
> - 读码 [rea-p11-textures.md](rea-p11-textures.md) 第 3、4 节：封面纹理、配色算法；
> - 实测 [p11-REPORT.md](p11-REPORT.md)「媒体回调与封面」。工具是 SMTC 夹具 `ignore/p11/smtc/`、工程 `ignore/p11/defs/p11c.py` 的 `p11-media`，WPE 日志在 `ignore/p11/out/p11-media-log.txt`。
>
> 现状行号按 HEAD `896e7f1c`，宿主代码工作区与 HEAD 相同。语料按 HEAD 重扫：`ignore/p11/c/corpus-head.json`（192 个工程，能渲染 130 张），统计用 `ignore/p11/c/p11c_keys.py`。

## 总体设计思路

WPE 的媒体集成是一条三段的管线，P11c 照着分三段做，每段放在和 WPE 对应的位置。

**第一段：取数据。** WPE 在子进程 `winrtutil64.exe` 里监视系统的当前媒体会话，有变化才往主进程发。我们已有同样位置的东西，就是 Phase 8 给网页壁纸做的 `WpeMediaHub` 与它的监视线程（`media.rs`）。但它为网页壁纸改过几处：
- 时间轴每秒外推；
- `contentType` 缺省填 `music`；
- 封面缩到长边 512；
- 配色用自己的量化直方图。

场景脚本是照 WPE 的数据写的，这几处都会改变脚本看到的东西。所以一个监视线程读一次系统数据，交给两个投影：
- **网页投影**：就是现在的行为，网页壁纸的垫片不受影响；
- **场景投影**：照 `winrtutil` 逐条做：
  - 字段的取值与超长清空；
  - 时间轴是整秒、不外推；
  - 封面原尺寸；
  - 没有会话时复位；
  - 每类和上次发出的值比较，相同不发。

配色按总计划的决定 2 改成 WPE 的算法：360 格色相直方图加 WCAG 对比度，在原尺寸、Spotify 预处理之后的像素上算。两个投影共用这一份，网页壁纸拿到的颜色因此也换成 WPE 的。订阅归属哪种投影由命令按调用方定：场景宿主的入口文档走场景投影，页面不能自己选。

**第二段：合并。** WPE 主进程按 `windowupdaterate`（钳到 50–5000 ms，本机 1000）定时取数据：两次刷新之间同类只留最后一条，一次刷新给每个场景至多两个事件，先是状态 / 播放 / 属性 / 时间轴合成的一个，再是封面一个。这一段放在场景宿主里（新模块 `src/media/`）：
- 订阅收到的消息先并进「待发」；
- 一个按 `windowupdaterate` 走的计时器把待发切成事件，推进场景队列。间隔从 WPE 的 `config.json` 读，宿主本来就能读这个文件。

封面在收到时就解码，解完才算进待发。这样派发那一刻图已经在手，换纹理和 WPE 一样同帧完成，不会像 P11b 的属性图那样晚几帧。

**第三段：派发。** 场景每帧在脚本阶段最开头把队列取空，逐条按 WPE 的固定顺序处理：
1. 有封面就先当一次属性增量：`$mediaThumbnail` 换成新名字 `mediaThumbnail_<N>.system`，有上一张时 `$mediaPreviousThumbnail` 是上一个名字。它走现有的属性管线，所以：
   - 绑定这两个名字的纹理槽经 P11b 的来源表换图，图由媒体模块直接提供，不读文件；
   - 导出了 `applyUserProperties` 的脚本收到 `{}`（增量没有 `type`）。
2. 再按 状态 → 播放 → 属性 → 封面 → 时间轴 调五个媒体回调，发给导出了该回调的全部已 `init` 的脚本，按登记顺序；
3. 事件对象是普通对象，颜色是 `Vec3`。`MediaPlaybackEvent` 已经在 WPE 的 `baseclasses.js` 里，我们的 realm 加载的就是它。

`init` 之后、首次 `applyUserProperties` 之前，按场景媒体状态补发一轮。这个状态新建时 `enabled` 为真，所以通常是一次 `{enabled: true}`。

**关键决策：**
- **两个投影，不改网页壁纸的行为**（见「待定」1）。网页壁纸的外推和缩图是 Phase 8 有意做的，场景照 WPE 是因为脚本依赖它。只有配色两边一起换，这是总计划已定的。
- **合并放宿主、不放 Rust**。它是每个场景自己的队列语义，放在 TS 里可以单测，Rust 只管「读系统、按 WPE 去重」。代价是隐藏的 iframe 里计时器会被 Chromium 节流，那时场景本身也暂停，只是合并得更粗，记为已知差异。
- **封面纹理复用 P11b 的来源表**。系统来源和属性来源只差图从哪来：来源表多一个「按值提供图片」的入口，裁切、纹理名、GPU 侧全部不变。WPE 本来也是同一个 setter、同一个建纹理函数。
- **不按平台照报**。非 Windows 或订阅被拒时，宿主照 WPE「媒体集成不可用」走：脚本收到 `{enabled: false}`，封面槽是缺省纹理。能力键全部平台一起去掉，非 Windows 标 `TODO:[WPE_SCENE]`。

## 范围与语料

HEAD 重扫（192 个工程）：用到 P11c 键的 32 张。按键数：

| 键 | 场景数 |
|---|---|
| `script:callback:mediaPropertiesChanged` | 27 |
| `script:callback:mediaThumbnailChanged` | 25 |
| `script:callback:mediaPlaybackChanged` | 20 |
| `usertextures:system` | 19 |
| `script:callback:mediaTimelineChanged` | 9 |

`mediaStatusChanged` 0 张导出。

- **只差 P11c 的 9 张**：2932157836、2974757317、3219908811、3355291946、3470764447、3487328036、3823859141、3823864170、3837699827。做完能渲染 130 → 139。
- **除 P11c 外只差一两个键的 7 张**：2833017810、3243449890、3276911872、3308867900、3351163962、3554161528、3837478759。它们差的是 `tex:animation`、`getParent`、`getAnimationLayer`、`text:anchor:left`、puppet 物理等，不在本节。
- 其余 16 张还差别的节，主要是 `combo:SPRITESHEET`、`tex:animation`、图层层级类脚本 API、puppet、`openUserShortcut`（P11d）。

不做：
- WPE 的 `mediablocklist`。我们用 Kabegame 自己的「媒体集成」开关，不读 WPE 的这两个设置。
- 快捷方式图标的通道（P11d）。

## 现状锚点

**a. 五个媒体回调在缺失表里**（`apps/wpe-scene/src/compile/scriptApi.ts:507`；`script/runtime.ts:29`）
```ts
export const MISSING_SCRIPT_CALLBACKS: readonly string[] = [
  // …
  // 系统媒体集成 → P11
  "mediaStatusChanged",
  "mediaPlaybackChanged",
  "mediaPropertiesChanged",
  "mediaThumbnailChanged",
  "mediaTimelineChanged", // 现状：导出了就报 script:callback:media*，整张退回
];
// script/runtime.ts
export const RUNTIME_CALLBACKS = [
  "init", "update", "applyUserProperties", "destroy", "animationEvent",
  "cursorHitTest", "cursorEnter", "cursorLeave", "cursorMove", "cursorClick", "cursorDown", "cursorUp",
] as const; // 现状：没有媒体回调
```

**b. 封面来源照报、不登记绑定**（`compile/usertextures.ts:196`）
```ts
    if (item.kind === "system") issues.add("usertextures:system"); // 现状：$mediaThumbnail / $mediaPreviousThumbnail 的槽整张退回
    if (item.kind === "usershortcut") issues.add("usertextures:usershortcut");
```

**c. 宿主只订阅音频**（`host.ts:603`）
```ts
  private subscribeAudio(): void {
    // …
    invoke("wpe_web_media_subscribe", { kind: "audio", channel, imageId }).catch((error: unknown) => {
      this.audioError = String(error);
      this.renderer?.disableAudio(); // 现状：从不订阅 media
```

**d. 脚本阶段的入口**（`render/renderer.ts:784`、`host.ts:1063`）
```ts
    if (live) this.stepCursor(scene, state, cursor);      // 光标派发（P6c）
    if (live) this.options.stepObjects?.(frametime);       // 声音
    if (live) this.options.beforeFrame?.(frametime, this.spectrum); // 现状：宿主的脚本阶段从动画开始
// host.ts
      beforeFrame: (dt, spectrum) => {
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) {
          // … sceneAnimations.frame（动画与 animationEvent）
          this.runtime?.frame(dt); // 现状：计时器与 update；没有媒体段
```

**e. 网页壁纸的投影就是唯一的投影**（`src-tauri/kabegame/src/wpe_media/media.rs:27`、`:369`、`:421`）
```rust
const THUMBNAIL_MAX_SIDE: u32 = 512; // 现状：封面缩到长边 512（WPE 不缩）
// …
    /// 每秒：播放中按读数时间外推位置并推送。
    fn tick(&mut self) { if self.last_playback == Some(1) { self.push_timeline(); } } // 现状：时间轴外推（WPE 不外推，只认应用的事件、截断成整秒）
// refresh_properties
                let content_type = match props.PlaybackType().and_then(|t| t.Value()) {
                    Ok(MediaPlaybackType::Video) => "video",
                    Ok(MediaPlaybackType::Image) => "image",
                    _ => "music", // 现状：WPE 是 Music → music，其余空串
                };
// encode_thumbnail：缩图后再缩到 64×64 算颜色
    let sample = image::imageops::resize(&image.to_rgba8(), COLOR_SAMPLE_SIDE, COLOR_SAMPLE_SIDE, FilterType::Triangle);
```

**f. 配色是自己的量化直方图**（`src-tauri/kabegame/src/wpe_media/colors.rs:77`）
```rust
/// 从（已缩小的）封面算五个颜色；全透明的图退回 [`default_colors`]。
pub fn thumbnail_colors(image: &RgbaImage) -> ThumbnailColors { /* 现状：16 级量化直方图、对比度门槛 4.5、没有封面时深灰底白字 */ }
```

**g. 订阅不分投影**（`src-tauri/kabegame/src/commands/wpe_web.rs:488`、`wpe_media/mod.rs:55`）
```rust
    WpeMediaHub::global().subscribe(webview.label(), frame, kind, Box::new(channel)); // 现状：场景宿主与网页壁纸收同一份消息
// mod.rs
    Thumbnail {
        /// `data:image/png;base64,…`，无封面时为空串
        thumbnail: String,
        primary_color: String, // 现状：CSS `rgb()` 字符串，场景要 0–255 的整数（再除以 255 成 Vec3）
        // …
    },
```

## 步骤 1 — 后端：场景投影与 WPE 配色（Rust）

- **修改** `wpe_media/colors.rs`：整个换成 WPE 的算法（rea-p11-textures 4.1、4.2，名字对应按 p11-REPORT 的更正）：
  - 三色：alpha ≥ 16 的像素进 360 格色相直方图（权重 `(int)(M·s·100)`），主色取权重最大的格，次色、第三色按格距加权；浮点与取整照读码，float / double 的位置照反编译；
  - `highContrastColor` = 主色对黑的对比度 < 2.5 时白、否则黑；`textColor` = 次色（对比度 ≥ 2.5 且大于第三色）/ 第三色（≥ 2.5）/ 否则同 `highContrastColor`；
  - 没选中任何格时是黑（0），没有封面时五色全 0。网页壁纸原来的「深灰底白字」随之没有了，照 WPE。
  - 输出 `[[u8; 3]; 5]`，网页投影再格式化成 `rgb()`。
- **新增** Spotify 预处理（rea-p11-textures 3.1 第 3 步）：来源 App ID 小写后以 `spotify` 开头时，裁掉透明边或把角标区改灰。两个投影共用，在算颜色、编码之前。
- **修改** `wpe_media/media.rs`：
  - 监视线程每次读完系统数据，交给两个投影。读数结构 `RawMedia` 的字段有：七个字符串、`PlaybackType` 原值、封面原始字节与 App ID、播放状态、时间轴的 `Position` / `StartTime` / `EndTime` / `LastUpdatedTime`。
  - 网页投影 = 现在的逻辑原样搬过去：外推、512 缩图、`music` 缺省。它的去重状态自己持有。
  - **新增** 场景投影（照 `winrtutil`，rea-p11-media 1.2–1.4）：
    - 属性：`contentType` 只有 1 / 2 / 3 → `music` / `video` / `image`，其余空串；`genres` 用 `,` 连接；超长整段清空（`title` / `artist` / `genres` > 1024 字节，另外三个 > 256 字节）；七个串全同不发。
    - 封面：在处理属性时比较解码后重新编码的 PNG 字节，不同才发（含有 → 无）。消息带原尺寸 PNG（base64）与五色。
    - 播放：`Playing` → 1、`Paused` → 2、其余 0，同值不发。
    - 时间轴：`position = Position`、`duration = EndTime`（不减 `StartTime`），各自截断到整秒，两个值完全相同不发；不外推，播放状态变化时也不重推。
    - 没有会话：属性全空、封面清空、状态 0、时间轴 0 / 0，各自和上次不同才发。
  - 会话：另外订阅 `SessionsChanged`（WPE 两个事件都只是重取当前会话），两个投影都受益。
- **修改** `wpe_media/mod.rs`：
  - `WpeMediaMessage` **新增** `SceneThumbnail { png: String, colors: [[u8; 3]; 5] }`。场景投影的属性、播放、时间轴、状态沿用现有变体，值按 WPE 取。
  - 订阅 **新增** `flavor: Web | Scene`；每种投影各一份最近状态（新订阅补发用），广播按 flavor 路由。
  - 场景订阅的补发照 WPE 的 `AddMediaListener`：先 `Status`，监视在跑时再补非空的属性 / 封面 / 播放 / 时间轴。
- **修改** `commands/wpe_web.rs`：调用方是场景宿主入口文档时，订阅记成 `Scene`，否则 `Web`。命令参数不变。
- **测试**（Rust）：
  - 配色：p11-REPORT 的 m1 / m2 / m3 / m4 / m6 五张 PNG 和 WPE 逐值相同。图拷进测试夹具，期望值取 WPE 日志，不取我们的复算。m5（JPEG）不进断言。
  - 场景投影喂假的读数：超长清空、`contentType`、整秒截断、不外推、没有会话的复位、各类去重。
  - 网页投影原有用例不变：外推、缩图、`music`。颜色的期望值按新算法改。
  - Hub：两种 flavor 各自补发、广播不串。

## 步骤 2 — 宿主：合并、派发、封面纹理（TS）

- **修改** 编译期：
  - `compile/usertextures.ts`：system 来源不再报，和属性来源一样登记槽；`BindingCollector.bindUserTexture` 对 `$mediaThumbnail` / `$mediaPreviousThumbnail` 同样登记 `user-texture` 目标。
  - `compile/scriptApi.ts` / `script/runtime.ts`：五个回调从 `MISSING_SCRIPT_CALLBACKS` 移到 `RUNTIME_CALLBACKS`。
  - `SceneBundle` **新增** `media: boolean`：有脚本导出五个回调之一，或有 system 来源的槽（rea-p11-media 2.1）。
- **新增** `src/media/`：
  - `pending.ts`：`MediaPending` 收场景消息，照 `A.pending` 合并：
    - 同类只留最后一条，flags 按位或；
    - 封面解码完才并入，取代未发出的旧封面时关掉旧位图。
    - `flush()` 按 `0x1d` 合成一个事件、封面单独一个，清 flags，值留作缓存。
  - `scene.ts`：`SceneMedia`，场景的媒体状态（WPE 的 `M`）：
    - 字段：`enabled` 初值真、封面计数从 1 起、当前 / 上一张封面的名字与位图、七个串、状态、时间轴、事件队列；
    - `drain(handlers)`：每帧取空队列，一条事件按 WPE 顺序处理：封面先变成属性增量、计数加一，再依次调五个回调；
    - `replayAfterInit(handlers)`：init 之后的补发，规则见 rea-p11-media 2.5。
  - `events.ts`：在 realm 里建事件对象。键的插入顺序照 dll；颜色是 `Vec3`，分量 `Math.fround(c / 255)`；`position` / `duration` 是 float32。
  - 计时器间隔：宿主读 WPE `config.json` 的 `windowupdaterate`（`postprocess.ts` 的 `wpeUserValueOf`），钳到 50–5000。读不到时用 1000（本机值），记一条 debug。
- **修改** `usertex/sources.ts`：**新增** `provide(value, image | null)`，系统来源的值按它取图、不读文件；只留当前与上一张，再旧的释放。裁切、纹理名、GPU 侧不变。
- **修改** `script/runtime.ts`：**新增** `mediaEvent(callback, makeEvent)`，发给全部 `inited`、导出了该回调的脚本，按记录顺序；不写回返回值，出错按现有规则只禁用这个回调。
- **修改** `host.ts`：
  - `bundle.media` 时订阅 `kind: "media"`：消息进 `MediaPending`，计时器把切好的事件推进 `SceneMedia`。
  - 订阅被拒（非 Windows 等）时自己并一个 `{enabled: false}`。非 Windows 的分支标 `TODO:[WPE_SCENE]`。
  - `beforeFrame` 最开头（光标派发之后、动画之前）`drain`：
    - 封面增量经 `applyChanges` 那条属性路径，键没有 `type`，所以 `applyUserProperties` 收到 `{}`；
    - 同时 `provide` 两张图，来源表命中就当场换，`sync` 在脚本之后，同帧画出。
  - 脚本加载完、首次 `applyUserProperties` 之前 `replayAfterInit`。
  - `SceneMedia` 跨重编译保留（realm 也保留、不重新 `init`），换场景时新建。
- **修改** dev 探针：
  - `host.media()`：订阅状态、收到的消息（带时间戳，最近若干条）、待发、队列长度、`SceneMedia` 的当前值；
  - `renderFrame` **新增** `media`：`[{ frame, messages }]`。确定性回放时在第 `frame` 帧之前把这些消息切成事件推进队列（不走计时器），配合 `scripts: true` 与 `consoleGrep` 拿回调日志。vite `/render` 与 MCP `render_scene` 一起转发，同 `gifDts`。
- **测试**：
  - `pending`：合并、两个事件的切法、封面取代；
  - `scene`：一条事件的处理顺序、名字与计数、previous 的轮换、无封面时同样换名、补发的条件；
  - 事件对象的键顺序与类型，`Vec3` 原型；
  - 来源表的 `provide`；
  - 宿主假订阅：从消息到回调的全链路，`applyUserProperties({})` 的时机，同帧换纹理，被拒时的 `{enabled: false}`；
  - 语料：`kbp corpus scan` 前后比，只去掉六个键，130 → 139。

## 步骤 3 — 走查（按 `FINAL_CHECK.md`）

媒体实测要在用户电脑上发布测试会话（总计划决定 4），动手前先请用户暂停自己的播放器。

- **回调序列对 WPE**：
  - WPE 测试窗口与 Kabegame 的屏外宿主同时开 `p11-media`，SMTC 夹具按同一串步骤驱动；
  - 步骤补上步骤 0 没测到的四项：超长标题、停止、清空封面、会话消失；
  - Kabegame 一侧：
    - 读 `host.media()` 收到的消息，核对每类的值和 WPE 日志里回调收到的相同；
    - 再把这串消息按 WPE 日志的帧号喂给 `renderFrame` 的 `media`、`scripts: true`，比 `[p11m]` 行的顺序与内容。
- **封面纹理对 WPE**：`p11-media` 的 `TH-CUR`（1:1）/ `TH-PREV`（1:4），用 PNG 封面 m1、m2 各抓 WPE 一帧，`render_scene` 按同样的消息回放，两块区域逐像素比。
- **真实壁纸**：从只差 P11c 的 9 张里选三张做复制工程（`kbp content isolate --instrument`），夹具给已知的标题与封面，两边比整帧：
  - `3487328036`：只有封面纹理；
  - `3823859141`：三个回调改文本或动画；
  - `2932157836`：回调加封面纹理。
- **真机冒烟**：预览一张媒体场景，用户自己的播放器放歌、切歌、暂停，标题与封面跟着变；「媒体集成」关掉后回调收到 `{enabled: false}`。
- **语料**：`kbp regress --corpus` 两份源码，只去掉六个键。

## 收尾

- `cocs/wpe/WPE_SCENE.md` 加「媒体（P11c）」一节；P11b 一节的能力表与照报键同步（`usertextures:system` 去掉）。
- `cocs/wpe/WPE_IMPORT.md`「音频与媒体集成」：两个投影、WPE 配色、网页壁纸没有封面时的颜色变化。
- `cocs/README.md` 同步。回归文档与 changelog（网页壁纸的配色变化单列一条）。
- 和别的会话的交界：
  - 宿主共享文件：`host.ts`、`render/renderer.ts`、`script/runtime.ts`、`compile/scriptApi.ts`、`compile/usertextures.ts`、`compile/bundle.ts`。新代码放 `src/media/`，共享文件只加接线，在 HEAD 快照里做、三方合并。
  - Rust 的 `wpe_media/` 只有网页壁纸 Phase 8 用，改动要保住垫片的行为；在独立工作树里做（同 P11b 步骤 3，dev 监视主工作区，改 Rust 会重编重启）。

## 待定

1. **网页壁纸跟不跟着改成 WPE 的数据**。推荐只改配色，其余保持 Phase 8：
   - 外推是为了让进度条在只在跳转时更新时间轴的播放器上也走，缩图是为了页面开销，都是有意的。
   - 按读码，WPE 交给网页壁纸的也是原尺寸、不外推的数据（CEF 那边是否再缩没读到）；我们给网页壁纸的这两处本来就和 WPE 不同。
   - 另一种是网页壁纸也换成场景投影（一份投影，代码更少）。代价是网页壁纸的进度条在这类播放器上不走，大封面的 data URL 变大。
2. **合并照不照 WPE**。推荐照做：按 `windowupdaterate` 合并，一次刷新至多两个事件。
   - 不照做时每条变化立即派发、不合并：脚本收到的回调更多，顺序也可能和 WPE 不同。比如属性和时间轴分两次到，WPE 是同一次刷新里的固定顺序。
   - 本机实测「同一间隔里改两次标题只收到最后一次」，脚本可能依赖这种合并。
3. **分工**。推荐步骤 1（Rust）与步骤 2（TS）同时交给两个 Sonnet 代理：
   - 开工前我写约定：场景消息的形状、`SceneThumbnail`、flavor 规则；
   - 步骤 1 在独立工作树里做，步骤 2 在 HEAD 快照里做。
   - 同 P11b。

## 风险

1. **测试会话会被抢走**：WPE 和我们都取系统的当前会话，用户的播放器或 Kabegame 自己的预览会话（Phase 8 的 `usePreviewMediaSession`）会成为当前会话。走查时请用户暂停播放器，Kabegame 一侧用屏外宿主、不开预览。
2. **重设同一张封面**：WPE 实测会再发封面消息，而读码说字节相同不发，机制没查清。场景投影照读码比 PNG 字节，走查时用夹具的同一步核对；对不上就记为已知差异，或改成「属性事件里应用重设了封面就发」。
3. **JPEG 封面的配色**：解码库不同（WPE 用 FreeImage，我们用 `image`），平滑渐变的封面主色可能落到别的格。PNG 逐值相同，JPEG 记为已知差异。
4. **大封面经 Channel**：原尺寸 PNG 的 base64 可能几 MB，Tauri 的大消息走 frame 内 `fetch`。只在封面变化时发一次，走查时量一次最大的。
5. **共享文件**：宿主侧同 P11b，在快照里实现再三方合并；P12a、P13b2 的会话在各自的工作树里改 `host.ts` / `renderer.ts`，合并前看一次 HEAD。

## 实施记录

### 决定（2026-11-14，用户「同意」）

待定 1–3 都按推荐：网页壁纸只换配色；合并照 WPE；步骤 1、2 交两个 Sonnet 代理同时做。

### 约定（步骤 1 与步骤 2 之间，开工前写定）

基线 `da553ea1`。步骤 1 在独立工作树 `ignore/p11/c/wt`，步骤 2 在快照 `ignore/p11/c/ov`（对照 `ignore/p11/c/head`）。

**订阅**：宿主照音频的写法调 `invoke("wpe_web_media_subscribe", { kind: "media", channel, imageId })`，命令与参数都不变。后端按调用方文档分 flavor：
- 场景宿主的入口文档（`wpe_scene_host::is_host_document`）→ `Scene`；
- 网页壁纸目录里的文档 → `Web`；
- 一个订阅只收自己 flavor 的消息，网页壁纸的垫片不改。

**场景消息**（Channel 上的 JSON，`type` 区分）：

| `type` | 字段 | 取值 |
|---|---|---|
| `status` | `enabled: boolean` | 同现状 |
| `properties` | `title`、`artist`、`subTitle`、`albumTitle`、`albumArtist`、`genres`、`contentType` | 照 `winrtutil`：`contentType` 只有 `music` / `video` / `image` / `""`；`genres` 用 `,` 连接；超长整段清空 |
| `sceneThumbnail` | `png: string`、`colors: [[r, g, b] × 5]` | `png` 是原尺寸 PNG 的 base64（不带 `data:` 前缀），Spotify 预处理之后；`""` 表示没有封面。`colors` 依次是 primary、secondary、tertiary、text、highContrast，0–255 整数，没有封面时全 0 |
| `playback` | `state: 0 / 1 / 2` | Playing 1、Paused 2、其余 0 |
| `timeline` | `position`、`duration` | `Position`、`EndTime` 各自向零截断到整秒；不外推 |

- 场景订阅收不到 `thumbnail`（网页的）；网页订阅收不到 `sceneThumbnail`。
- 去重照 `winrtutil`：每类和本次监视里上次发出的值比，相同不发。初值是缺省值（空串、无封面、0、0 / 0），所以缺省值一开始不发。
- 处理一次属性读取时，先比属性、再比封面（封面比 PNG 字节）。
- 没有会话：每类回到缺省值，和上次不同才发。
- 改了 `PlaybackStatus` 不重推时间轴；只在会话切换与 `TimelinePropertiesChanged` 时读时间轴。

**场景订阅的补发**（照 `AddMediaListener`）：
- 先发 `Status { enabled: 媒体集成开关 }`。
- 开关打开且监视在跑时，再按场景缓存补：`title` 非空才补属性，有封面才补封面，状态非 0 才补播放，`duration` 非 0 才补时间轴。

**「媒体集成」开关**：
- 关：场景订阅先收 `Status { enabled: false }`，再收缓存里不是缺省值的那几类的复位消息，然后清空场景缓存。
- 开：先收 `Status { enabled: true }`，新起的监视按全新的去重状态发非缺省值。
- 读码推断 WPE 关掉时可能什么都不发、要等重新打开才一起到（rea-p11-media 1.6，未实测）。这里选当场发，记为已知差异。

**网页消息**：形状不变，`thumbnail` 仍是 data URL 与 `rgb()` 串，外推、缩图到 512、`contentType` 缺省 `music` 都保持。只有五个颜色换成 WPE 的算法：在 Spotify 预处理之后的原尺寸像素上算，没有封面时是全 `rgb(0, 0, 0)`。

**宿主内部**：
- 全部场景消息先进 `MediaPending`，由 `windowupdaterate` 计时器切成事件，补发的消息也一样，不另开快路径。
- 补发：WPE 对「已有别的监听者」的场景是同步补发，到下一帧就派发；我们等下一次刷新，最多晚一个间隔。记为已知差异。
- 订阅被拒：当场把 `{flags: 0x10, enabled: false}` 推进场景队列，不经合并。
- vite `/render` 与 MCP `render_scene` 转发 `media` 选项的接线不在步骤 2 里（那几个文件在快照之外，别的会话也在改），走查时我自己接。

### 步骤 1、2（2026-11-14，两个 Sonnet 代理并行）

**步骤 1（Rust，工作树 `ignore/p11/c/wt`）：**
- `wpe_media/colors.rs` 换成 WPE 算法：输出 `[[u8; 3]; 5]`，顺序按脚本字段名；没有封面时五色全 0。
  - 有封面字节但没选中任何格（全透明、全灰）时三色黑、`textColor` / `highContrastColor` 白，同 m4。
- 新文件 `wpe_media/projection.rs`，纯逻辑、不碰 WinRT：
  - `Projections` 包含网页投影、场景投影和共用的封面解码缓存；
  - Spotify 预处理也在这里。读码标【推】的两处：判定行取 `(int)(0.4h)`；「否则若」按外层 if 的 else 读。
- `wpe_media/media.rs`：监视线程每次读一次系统数据（`RawProperties` / `RawTimeline`），交给两个投影；另订阅 `SessionsChanged`。
- `wpe_media/mod.rs`：
  - 新增 `SceneThumbnail` 与 `WpeMediaFlavor`；
  - 每个 flavor 各一份缓存，广播按 flavor 路由；
  - 场景补发与关闭开关时的复位按约定。
- `commands/wpe_web.rs`：按调用方文档定 flavor。
- 代理没跑成测试：工作树缺 `tauri.conf.json`、`capabilities/main.json`，这两个文件由 dev 生成、被 git 忽略。我补上这两个，再加上 `gen/schemas`、`resources` 的联接，然后自己跑。以后的 Rust 工作树一开始就补这四样。
- 验证：
  - `kabegame` 的 `wpe_` 过滤 84 个全过；
  - 补了两个测试：一个用 WPE 日志里 `textColor` ≠ `highContrastColor` 的两例（m5、预览会话封面），另一个查五色的排列；
  - 变异检查：交换 text / highContrast、广播不看 flavor，两处都被抓到；
  - rustfmt 通过。唯一的 warning（`build_wpe_web_state` 未使用）HEAD 就有。

**步骤 2（宿主，快照 `ignore/p11/c/ov`）：**
- 编译期：
  - `usertextures:system` 不再报，system 来源同属性来源登记 `user-texture` 绑定；
  - `isDynamicSource` 用在 `graph.ts`、`scene.ts` 三处；
  - 五个回调移进 `RUNTIME_CALLBACKS`，`MISSING_SCRIPT_CALLBACKS` 里删掉，新增 `exportsMediaCallback`；
  - 新增 `SceneBundle.media`。
- 新目录 `src/media/`：
  - `pending.ts`：合并、封面先解码、序号定输赢；
  - `scene.ts`：`drain`、`replayAfterInit`、`discard`；
  - `events.ts`：事件对象与 `scriptMediaCallbacks`；
  - `interval.ts`：刷新间隔；
  - `types.ts`。
- `usertex/sources.ts` 的 `provide`：`.system` 值不读文件；只留最近两张与仍被引用的封面。
- `script/runtime.ts`：
  - 新增 `mediaEvent`；
  - `load(scripts, afterInit)` 在全部 `init` 之后、首次 `applyUserProperties` 之前调 `afterInit`。宿主在这里 `replayAfterInit`。
- `host.ts`：
  - `loadMedia` 在脚本之前建，订阅只订一次；
  - `drainMedia` 在 `beforeFrame` 脚本阶段最开头，没有脚本也跑；
  - 封面增量走 `mergeProperties` + `applyChanges`；
  - 订阅被拒时推 `{enabled: false}`；
  - 新增 `host.media()`。
- dev 探针：
  - `renderFrame` 的 `media: [{ frame, messages }]`，`frame` 从 1 起，建回放前按帧序 flush；
  - `dev/probeMedia.ts`；
  - `particleCorners.ts` 两条回放路径都加了媒体一步。
- 已知小差异：
  - 重编译与封面事件撞在一起时，脚本可能多收一次 `applyUserProperties({})`；
  - 退回预览图期间媒体事件丢掉，之后能渲染时等下一次变化才跟上。
- 验证：
  - 快照 tsc 0 error，相关单测 474 个全过。
  - 全量：3963 个，3919 过、43 跳过、1 失败。失败的是 `pipeline.test.ts` 的读取字节上限（`3543014965` 读 104 MB），HEAD 快照单独跑同样失败，不是本节引入。
  - 变异检查 5 处全部检出（`mutate_ts.py`）：
    - drain 的封面顺序；
    - 封面并进主事件；
    - 封面值当文件读；
    - 无脚本不 drain；
    - title 空也补属性。
  - 语料（新基线 219 个工程）：能渲染 147 → 157。只去掉六个键，没有新增键，没有场景掉出。多出的 `3482471820` 只差 `mediaThumbnailChanged`。

**合并进主工作区：**
- 宿主（`merge_wt_c.py`）：以 `da553ea1` 为祖先三方合并 27 个文件，工作区里别的会话未提交的改动全部保留。两处冲突：
  - `host.ts` 的 import 两边都留；
  - `particleCorners.ts`：工作区已把 `enterFrame` 挪到光标派发之前，只加媒体一步。
- 合并时还改了一处：`replayReadback` 里媒体排到 `enterFrame` 之后，同渲染器。
- 合并结果（`ignore/p11/c/wtm`，工作区快照叠上合并文件）tsc 0 error，相关 40 个文件 646 个单测全过，Prettier 通过。
- Rust 补丁 `ignore/p11/c/p11c-rust.patch`（5 个文件）经用户同意（2026-11-14：「可以」）打进主工作区，dev 重编重启。

### 步骤 3 走查（2026-11-14 至 11-15）

**准备：**
- dev 工具接 `media`：
  - `scripts/kabegame-dev/` 的 `checkMedia`（`replay.ts`）、`RenderMediaStep`（`types.ts`）、转发（`scene.ts`），加了单测；
  - MCP `render_scene` 的 `media` 字段（`tools.ts`）。
  - vite 插件与 MCP 都要重启才生效，这次走查直接在宿主里调探针 `renderFrame`（`render_thumb.py`、`replay_callbacks.py`）。
- 代理漏了探针上的 `host.media()`，补在 `dev/install.ts`。
- 探针回放媒体但不跑脚本时，读回帧的封面写入没有 `sync` 进场景。`particleCorners.ts` 三处 `sync` 的条件加上 `options.media`。
- 夹具加了可选的 `type` 键（`ignore/p11/smtc/fixture.ps1`）。`DisplayUpdater.Type` 设不了 Unknown，所以 `contentType` 的空串只在会话刚建、还没数据时出现。

**真机链路**（用户的 Chrome 会话，只读）：场景宿主订阅成功，收到场景格式的消息；1 s 计时器把它们合成两个事件。

**对 WPE 的回调序列**（用户暂停了播放器，四轮夹具，`ignore/p11/c/steps-c*.json`）：
- WPE 测试窗口开 `p11-media`。Kabegame 的屏外宿主记下收到的全部消息（`drive_c.py` → `smtc/kb-messages*.json`），再按到达时间分批，每批一帧，用探针回放、取 `[p11m]` 行。
- 逐行相同的项：
  - 换封面；
  - 超长清空：标题 1025 字节清空、1024 保留，专辑名 257 字节清空；
  - 停止 0；播放 + 时间轴整秒；视频 / 图片；
  - 会话切到另一个会话；新会话还没给数据时的复位（`contentType` ""）；
  - 清空显示信息：属性空、`contentType` music、无封面；
  - 颜色逐值相同，含 IRIS OUT 封面的 `textColor` = 第三色、`highContrastColor` = 黑。
- 首个会话：WPE 是「播放、时间轴」与「属性、封面」分两次刷新到，因为它的子进程等封面解码完才送属性。我们同一次刷新到。是先后时机的差别，同一次刷新里的顺序照 WPE。
- **风险 2 查清**：
  - 只重设同一张封面：两边都不发；
  - 重设封面并改标题：系统先报一次没有封面、隔 5 ms 再报原图，WPE 因此再发一次封面。我们的 Rust 也收到这两条，宿主合并后同样只剩一次封面事件。
- **不同：会话退出时多一条播放回调。** 夹具退出时，它的会话先报一次播放状态（0），约 17 ms 后系统才切到别的会话。
  - WPE 的子进程每 100 ms 取一次队列，并丢掉不是当前会话发来的事件，所以那条 0 不发；切过去后状态与上次相同，也不发。
  - 我们收到就处理，多发一条 0。宿主合并后场景收到一次 `playback {2}`，WPE 没有（第 2 轮）。
  - 第 3 轮退出前状态是 1，两边都收到 `playback {2}`。

**封面纹理对 WPE**（第 4 轮：m1 → 改标题换 m2，抓帧 `A:\p11\c-thumb`）：
- 探针按同样两批消息回放两帧。
- `TH-CUR`（1:1，m2）与 `TH-PREV`（1:4，m1）两块区域逐像素相同。
- 整帧只差 FR / CLK 两个帧号块。

**顺带发现（不属于 P11c）：** 首次 `applyUserProperties` 全集的键序。WPE 按字母序；我们工程声明的 `schemecolor` 排在内置属性之后。归 P3a 的内置属性。

**修：会话退出时多一条播放回调**（用户定「照 WPE 改」，2026-11-14）：
- `media.rs` 照 winrtutil 的主循环：收到第一个信号后把之后 100 ms 内到的攒成一批（`collect_batch`）。
- 会话上的三个事件带挂接代数（每次挂接加一），旧代数的信号丢掉，等于「丢掉不是当前会话发来的事件」。
- 一批里有会话切换就只重新挂接，其余丢掉（`plan_batch`）；停止不等。
- 单测 6 个，Rust `wpe_` 过滤 92 个全过。变异两处（播放信号不看代数、有会话切换时不清掉本批的读取）都被抓到。
- 补丁 `ignore/p11/c/p11c-rust-batch.patch` 经用户同意打进主工作区，dev 重编重启。
- 复测（第 5 轮，`steps-c5.json`）：播放中 → 暂停 → 夹具退出、切回已暂停的 Chrome 会话。Kabegame 只收到属性、封面、时间轴，没有播放消息，同 WPE 第 2 轮。m3 的五色与 WPE 逐值相同。

**三张真实壁纸的复制工程**（`kbp content isolate --instrument`，`ignore/p11/c/proj/`）：
- 夹具给标题「Kabegame P11c」、歌手、专辑、封面 m3、播放中。WPE 测试窗口 1920×1080 各抓一帧（`A:\p11\c-iso`）。
- 我们用宿主实测收到的同一批消息，在第 1 帧之前派发，跑脚本、回放 240 帧，读回整帧比（`render_iso.py`、`cmp_iso.py`）。

| 工程 | 结果 |
|---|---|
| `2932157836-iso-media`（回调改文字 + 封面纹理） | 只差挂 `spin` 的圆形封面（转角跟 `g_Time`，两边时刻不同），去掉这一块整帧逐像素相同，歌名、歌手专辑两行文字相同 |
| `3823859141-iso-media`（13 个对象：回调改文字、淡入、换色，封面槽当前 / 上一张） | 唱片与中心封面挂 `spin`，转角不同；其余只有「KBP ARTIST」阴影的模糊边缘差 ≤ 8（`blurprecise`，与媒体无关）；方形封面裁切、边框与唱片的次色、歌名歌手相同 |
| `3487328036-iso-cover`（只有封面槽） | 「音乐封面」对象两边都没画出来：缩放挂了随音频跳动的脚本，复制工程里两边一致。背景差 11 是因为 WPE 当前后处理档位是 ultra（备份是 disabled，不是本节改的），工程开着泛光；对齐成 ultra 后全帧差 ≤ 8 |

- 封面纹理本身以生成工程 `p11-media` 的逐像素结果为准。
- 走查结束：测试工程已从 dev 库移除（`projects_remove`），夹具已退出，WPE 测试窗口已关；WPE 的设置没有改。

### 收尾（2026-11-15）

文档：
- `cocs/wpe/WPE_SCENE.md`：新增「媒体（P11c）」一节；同步就地写表的 `usertextures` 行、脚本回调两处、P11b 的能力表与引言、instanced 照报行，P10b 留的「等 P11 接上回调后再走查」补了结论。
- `cocs/wpe/WPE_IMPORT.md`「音频与媒体集成」：两个投影、信号攒批、WPE 配色、没有封面时全黑。
- `cocs/README.md`：新增「媒体（P11c）」条目，同步 P11b、脚本 API 检查、Phase 8 音频与媒体条目，补了适用场景。
- `.claude/skills/kabegame-chromium/SKILL.md`：`render_scene` 与 `/hosts/:h/render` 的 `media`。

回归与 changelog：
- `versions/latest/regression.md`「场景壁纸系统媒体（P11c）」M0–M6 已勾。待手测：M7 真机预览、M8 网页壁纸配色、M9 非 Windows。
- `versions/latest/changelog.md`：用户侧一条新功能，Changed 单列网页壁纸配色的变化，开发侧一条。

其它：
- 首次 `applyUserProperties` 全集的键序差异，已按用户要求转给 P3 会话。
- 清理：测试工程已从 dev 库移除。工作树 `ignore/p11/c/wt` 里的改动与主工作区逐字节相同，等提交后按「先拆联接」清理。
