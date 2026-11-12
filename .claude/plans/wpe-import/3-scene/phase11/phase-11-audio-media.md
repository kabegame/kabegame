# P11 — 音频、媒体与用户资源（总计划）

> 上级：[PLAN.md](../PLAN.md)「P11 — 音频、媒体与用户资源」。前置：步骤 0 只读码、只实测，可以和 P4–P10 并行（2026-11-13 用户：「其他地方在做 phase4、phase5，phase6，phase8，phase9，phse10；phase7 已完成 你趁这个时间开始 P11」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `5c8ec0cb` 的语料扫描 `ignore/p11/out/corpus-head.json`（173 个工程，能渲染 49 张；源码快照 `ignore/p11/head`）。覆盖数：`ignore/p11/ana_p11.py`、分节 `ignore/p11/ana_sub.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`）。逐场景清单：`ignore/p11/scan_p11.py` → `ignore/p11/out/scan.json`；脚本记号：`ignore/p11/media_tokens.py`；`usertextures` 原文：`ignore/p11/show_ut.py`。
> 现状行号按 HEAD `5c8ec0cb`。

## 总体设计思路

P11 的三类数据都来自场景外面：系统的音频与媒体会话、用户在属性面板里选的文件和程序。宿主只是接收方。它们在渲染器里落到三条通路上，其中两条已经有了：

- **每帧的引擎数据：音频频谱。** P4e 已经建好 `SceneSpectrum`（`audio/spectrum.ts`）。它照 WPE 的帧函数每帧归一化一次，粒子和脚本的 `registerAudioBuffers` 都读它；它的 64 / 32 / 16 三块就是 WPE 常量缓冲里 `g_AudioSpectrum{16,32,64}{Left,Right}` 的数据源（rea-p4e-audio 3.4：六个 uniform 都是把 `4n` 字节连续拷进常量缓冲）。P7 查明 WPE 把 `float` 数组 uniform 打包成 `float4[ceil(n/4)]`，翻译器已照做（wpesl2wgsl README「uniform 打包」）。所以 P11a 只是接线：
  - 每帧把三块的左右声道写进 uniform；
  - 「场景用音频」的判定从「声明了开关且有音频粒子」扩成「声明了开关，且有音频粒子或有程序读这六个 uniform」，宿主照此订阅 `WpeMediaHub`。
- **运行时换掉的纹理槽：`usertextures`。** 材质 pass 的每个纹理槽除了静态纹理，还可以绑一个来源：
  - 用户属性：`scenetexture` 属性，值是用户选的文件；
  - 系统伪属性：`$mediaThumbnail` / `$mediaPreviousThumbnail`，当前与上一首的封面；
  - 快捷方式：`usershortcut` 属性，取它所指程序的图标。

  P3 报告查到，WPE 给这三种来源走的是同一条路：
  - `usertextures` 的每一项登记成一个类型 5 的描述符，setter 在名字变了时把材质记进待刷新集合，之后换掉该槽的纹理；
  - 封面变化时，每帧脚本函数把 `$mediaThumbnail` 当一次单键增量，走同一个 setter。

  P11 也照这个形状做：编译期记下每个槽的来源与缺省纹理；主线程一个「纹理来源」模块持有每个来源当前的 GPU 纹理；来源变了，就地换掉绑定这些槽的 bind group，不重编译。三种来源只是数据从哪来不同：
  - 属性文件经 `file:` 读进来，再由宿主解码；
  - 封面来自 `WpeMediaHub` 已有的 PNG；
  - 图标由后端从程序里取出。
- **脚本事件：媒体回调。** `WpeMediaHub` 从网页壁纸 Phase 8 起就有系统媒体会话（SMTC）的数据，场景宿主再订阅一份 `kind: "media"` 即可。消息进宿主的队列，在帧里步骤 0 定下的位置交给脚本运行时，调用导出的五个 `media*Changed`。事件对象照 `lib.sceneScript.d.ts`：颜色是归一化的 `Vec3`；`MediaPlaybackEvent` 带 `PLAYBACK_*` 常量，语料里光 `PLAYBACK_STOPPED` 就有 18 张直接引用。

`engine.openUserShortcut` 是唯一一个让场景在系统里产生动作的 API，边界单独定：
- 页面只交属性名，启动哪个程序由后端从这张图片的 metadata（`userProperties`）里读，用户没在面板里配过的一律不放行；
- 宿主只在光标回调执行期间放行，每次点击至多一次（WPE 的规则，步骤 0 复核）；
- 场景宿主改不了 `userProperties`，写 metadata 的命令不在它的 capability 里。

**平台。** 音频与媒体数据只有 Windows 有（`WpeMediaHub`）。其它平台按「WPE 关掉媒体集成、没有声音」的行为走：频谱全 0，`mediaStatusChanged` 报 `enabled: false`，封面槽用缺省纹理。行为都有定义，所以能力键在全部平台一起去掉，不按平台照报。非 Windows 的音频是待做项，不是定论：代码里在订阅命令的平台门（`commands/wpe_web.rs`）和宿主处理订阅被拒的地方（`host.ts`）标了 `TODO:[WPE_SCENE]`（2026-11-13 用户）。

关键决策沿用前几节：
- WPE 语义以读码加实测为准。
- 能力表是唯一事实来源，没实现的照报。
- 验收和 WPE 比，不和作者的预览图比。

P11 另有三条：
- **三种纹理来源一个机制。** WPE 本来就是同一条路，而且都是「换掉一个槽」。分开做会有三套换纹理、三套脏标记。
- **数据通路只复用、不新建。** 音频与媒体都走 `WpeMediaHub` 的 Channel 订阅（frame 销毁时 Phase 8 的 `SubframeDestroyed` 释放）；属性文件的放行照网页壁纸 `file` 属性的做法（按当前 metadata 覆盖），只是放行的对象换成场景宿主。
- **新代码放进独立模块。** 媒体放 `apps/wpe-scene/src/media/`，纹理来源放 `src/usertex/`，仿 `audio/`、`video/`、`animation/`；共享文件只加接线。

## 范围与覆盖

语料（`ignore/p11/out/scan.json`）：
- **规模**：75 张用到 P11 的键。按子类（一张可能占几类）：音频 uniform 68 张，媒体（回调或封面纹理）32 张，属性纹理 22 张，快捷方式 3 张。
- **音频 uniform**：
  - 报 `uniform:g_AudioSpectrum32Left/Right` 的 39 张、`64` 的 34 张、`16Left` 21 张（`16Right` 20 张）；
  - 68 张的 `project.json` 全都声明了 `supportsaudioprocessing: true`；
  - 着色器多来自工坊 effect `Simple_Audio_Bars` 的几个版本（49 张的工程里有这个文件），其次是工程里带的 `shake`（31 张）、`pulse`（19）、`hue_shift`（9）等 effect；
  - 只读左右声道，WPE 也没有平均声道的 uniform（rea-p4e-audio 3.4）。
- **媒体回调**（31 张导出）：
  - 导出数：`mediaPropertiesChanged` 27、`mediaThumbnailChanged` 25、`mediaPlaybackChanged` 20、`mediaTimelineChanged` 9、`mediaStatusChanged` 0；
  - 脚本里的记号（33 张提到回调名）：`MediaPlaybackEvent.PLAYBACK_STOPPED` 18 张、`PLAYING` 16、`PAUSED` 12，`primaryColor` 12、`hasThumbnail` 12、`textColor` 10、`tertiaryColor` 6、`secondaryColor` 5、`highContrastColor` 4，`albumArtist` 7、`albumTitle` 5；`subTitle`、`genres`、`contentType` 0；
  - 回调里常做的事：`getAnimation().play()`（26 张，P10b）、改文本 `.text =`（10 张，P6b）。
- **`usertextures`**（34 张）：
  - 落点：材质 pass 与对象 `instance` 报 `material:usertextures` 30 张；effect pass 报 `effect:<名>:pass:usertextures`：`blendgradient` 12、`blend` 5、`clipping_mask` 3、`xray` 1；
  - 取值（全部工程 JSON 里的项）：属性名字符串 95 个、`{name, type: "system"}` 98 个（`$mediaThumbnail` 58、`$mediaPreviousThumbnail` 40）、`{name, type: "usershortcut"}` 65 个、`null` 139 个（空槽）；对象项只有 `name`、`type` 两个键，没有 `keepaspect`；
  - 按场景：只有属性纹理 11 张、只有封面 11 张、封面 + 属性 9 张、三种都有 2 张、只有快捷方式 1 张；
  - 绑定的槽都另有缺省纹理（`textures` 同一位置），例如 `3509243656` 的 `textures: ["CUbg"]` + `usertextures: ["custombg"]`；粒子材质上也有（`3812473896` 的 `genericparticle`）。
- **属性类型**：`scenetexture` 26 张，104 个属性的作者缺省值全是空串；`usershortcut` 3 张。属性名里有 `imagevideoimport`（`3643916956`），WPE 是否收视频由步骤 0 查。
- **`engine.openUserShortcut`**：3 张（`3577990983`、`3643916956`、`3660962877`），80 处调用全在导出的 `cursorClick` 里，参数是属性名。

| 节 | 内容 | 只做 P11 时累计能渲染 | P4–P10 先做完时累计 |
|---|---|---|---|
| P11a 音频 uniform | 六个 `g_AudioSpectrum*` 每帧写入、订阅判定扩大、确定性注入 | 49 | 85 → 104 |
| P11b 用户纹理 | `usertextures` 槽的来源机制、`scenetexture` 属性（面板、放行、解码、就地换纹理） | 49 | 110 |
| P11c 媒体 | 五个媒体回调、`$mediaThumbnail` / `$mediaPreviousThumbnail`、封面配色、非 Windows 与关掉媒体集成时的行为 | 49 | 124 |
| P11d 快捷方式 | `usershortcut` 属性、图标纹理、`engine.openUserShortcut` | 49 | 126 |

口径：
- **只做 P11**：75 张都还差别的节，0 张解锁。
- **P4–P10 先做完**：
  - P4–P6 的键沿用 `ana_phases.py`，另把进行中的 P4f（`script:api:particle.*`）、P5c（`model:pending`）、P6b（`text:script*`、`text:anchor:*`）算作做完，能渲染 61 张；P8 之后 69、P9 之后 83、P10 之后 85（同 P10 总计划的算法，HEAD 变了，数字跟着变）。
  - 之后只差 P11 的 41 张。按需要的子类：只要音频 19 张，音频 + 媒体 9，只要属性纹理 4，音频 + 属性纹理 2，媒体 2，音频 + 属性纹理 + 媒体 2，四类都要 2，属性纹理 + 媒体 1。
  - 表里按 a → b → c → d 的顺序累计；先做媒体（a → c → b → d）是 104 → 115 → 124 → 126，终点相同。
- **P11 场景还差别的节**（P4–P10 做完之后）：41 张只差 P11；23 张还差 P12，3 张还差 P13，2 张差 P12 + P13；另有 6 张还差没归属的键（`model:passthrough:children:framebuffer`、`uniform:g_Texture3MipMapInfo`、`text:msdf:*`、遗留灯的 uniform），不归 P11。
- 媒体场景很依赖别的节：26 张在回调里调 `getAnimation`（P10b），10 张改文本（P6b），快捷方式要光标回调（P6c）。上面的累计都假设它们先做完。
- PLAN 的表是 165 张口径（用到 53、只差它 2、累计 122），这里按 173 张重算，累计的假设也不同。

**P11 不做，继续报不支持：**
- **属性纹理是视频**：如果步骤 0 查明 WPE 的 `scenetexture` 收视频（`imagevideoimport` 这个名字暗示可能），视频走 P9 的视频纹理；P9 没合入时报细分键 `usertextures:video`。
- **麦克风输入**：P4e 已定只开回环，`audioinputdevice` 等 WPE 设置不跟。
- **`mediablocklist`**：WPE 设置里的媒体黑名单，Kabegame 不做；Phase 8 已定不过滤会话。

## 现状锚点

**a. 音频 uniform 不是引擎 uniform，翻译结果里读到就报**（`apps/wpe-scene/src/compile/features.ts:1026`）
```ts
export function checkProgramFeatures(
  result: TranslateResult,
  unsupported: Set<string>,
  extra: ReadonlySet<string> = new Set(),
): void {
  for (const uniform of result.uniforms ?? [])
    if (
      !uniform.unused &&
      typeof uniform.meta?.material !== "string" &&
      !isEngineUniform(uniform.name) && // 现状：ENGINE_UNIFORMS 里没有 g_AudioSpectrum*
      !extra.has(uniform.name)
    )
      unsupported.add(`uniform:${uniform.name}`); // 现状：报 uniform:g_AudioSpectrum16Left 等，整张退回
```

**b. 频谱已经有三块，只是没写进 uniform**（`audio/spectrum.ts:40`、`render/uniforms.ts:605`）
```ts
export class SceneSpectrum {
  /** `ctx+0x2c0` 块（rea 3.1）：`[L64 | R64 | A64]`。原始频谱拷进前 128 个值，在原地归一化。 */
  readonly spec64 = new Float32Array(BANDS * 3);
  readonly spec32 = new Float32Array(32 * 3);
  /** `ctx+0x2d0` 块：`[L16 | R16 | A16]`，粒子与 `g_AudioSpectrum16*` 读的就是它。 */
  readonly spec16 = new Float32Array(16 * 3); // 现状：粒子与脚本缓冲读这三块
// render/uniforms.ts
export function frameBuiltins(frame: FrameInput): Record<string, number[]> {
  return {
    g_Time: [frame.time],
    // … g_Frametime、g_Daytime、g_PointerPosition、g_PointerPositionLast、g_PointerState、g_ParallaxPosition
  }; // 现状：没有 g_AudioSpectrum*
}
```

**c. 「场景用音频」只看粒子，宿主据此订阅音频**（`compile/bundle.ts:1720`、`host.ts:452`）
```ts
  bundle.audio =
    project.general?.supportsaudioprocessing === true &&
    bundle.layers.some((layer) => layer.particle !== null && particleUsesAudio(layer.particle)); // 现状：读 uniform 的着色器不算
// host.ts
  private subscribeAudio(): void {
    // … 另一个触发点是脚本第一次 registerAudioBuffers
    invoke("wpe_web_media_subscribe", { kind: "audio", channel, imageId }).catch((error: unknown) => {
      this.renderer?.disableAudio(); // 现状：只订阅 audio，从不订阅 media
```

**d. `usertextures` 有效就报，三种来源不分**（`compile/features.ts:750`、`:1006`、`:1062`、`:1085`）
```ts
    } else if (key === "usertextures") {
      if (active(value)) unsupported.add("material:usertextures"); // 现状：instanced 对象的 instance 覆盖
// checkPassFeatures：材质 pass
  for (const key of ["keepaspect", "usertextures", "usertexturereference"])
    if (active(pass[key])) unsupported.add(`material:${key}`); // 现状：属性纹理、封面、快捷方式图标同一个键
// effect pass（实例覆盖与 effect 自己的 pass）
      if (!SUPPORTED_EFFECT_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`); // 现状：effect:blendgradient:pass:usertextures 等
```

**e. 媒体回调与快捷方式在缺失表里**（`compile/scriptApi.ts:108`、`:536`；`script/runtime.ts:21`）
```ts
  engine: methods("root", ["registerAsset", "openUserShortcut", "requestFeatures"]), // 现状：用到就报 script:api:engine.openUserShortcut
// …
export const MISSING_SCRIPT_CALLBACKS: readonly string[] = [
  // …
  // 系统媒体集成 → P11
  "mediaStatusChanged",
  "mediaPlaybackChanged",
  "mediaPropertiesChanged",
  "mediaThumbnailChanged",
  "mediaTimelineChanged", // 现状：导出了就报 script:callback:media*
];
// script/runtime.ts
export const RUNTIME_CALLBACKS = ["init", "update", "applyUserProperties", "destroy"] as const; // 现状：运行时只调这四个
```

**f. `WpeMediaHub` 的封面消息是给网页壁纸的形状**（`src-tauri/kabegame/src/wpe_media/mod.rs:55`）
```rust
    Thumbnail {
        /// `data:image/png;base64,…`，无封面时为空串
        thumbnail: String,
        primary_color: String, // 现状：CSS `rgb()` 字符串，场景要归一化的 Vec3
        secondary_color: String,
        tertiary_color: String,
        text_color: String,
        high_contrast_color: String, // 现状：三主色是自己的量化直方图（colors.rs），不是 WPE 的算法
    },
```

**g. 属性面板看不到 `scenetexture` / `usershortcut`，场景还去掉了 `file` / `directory`**（`src-tauri/kabegame-core/src/wpe/user_props.rs:71`、`apps/kabegame/src/components/wallpaper/WpeWebPropertiesPanel.vue:222`）
```rust
            let kind = match prop.get("type").and_then(Value::as_str) {
                // … color / slider / bool / combo / textinput
                Some("file") => WpePropKind::File,
                Some("directory") => WpePropKind::Directory,
                Some("group") => WpePropKind::Group,
                Some("text") | None if prop.get("text").is_some() => WpePropKind::Text,
                _ => return None, // 现状：scenetexture、usershortcut 在这里被跳过
            };
```
```ts
/** 这张壁纸用得上的条目：场景去掉 `file` / `directory`（见 props 注释） */
const usableItems = computed(() => {
  const items = view.value?.items ?? [];
  return isScene.value ? items.filter((item) => item.kind !== "file" && item.kind !== "directory") : items;
});
```

**h. 场景宿主的 `file:` 范围只有宿主、WPE 资源与库内场景目录**（`src-tauri/kabegame/src/wallpaper/wpe_scene_host.rs:467`）
```rust
fn host_scope_for(
    key: &str,
    host: &HostScope,
    scene_dirs: impl FnOnce() -> Vec<FileGrant>,
) -> Option<FileAccessScope> {
    // …
    let mut grants = host.engine_grants.clone(); // WPE assets/、config.json
    grants.extend(host.font_grants.iter().cloned()); // 系统字体（P6b）
    grants.extend(scene_dirs()); // 现状：库内全部场景目录；用户选的纹理文件不在范围里
```

## 与 PLAN.md 的差异

1. **语料**：PLAN 写「用到 53、只差它 2、累计 122」（165 张），现在 173 张：用到 75，只做 P11 解锁 0，P4–P10 做完后只差 P11 的 41 张，累计 85 → 126。多出来的主要是 P6 前置开始照报的 `script:callback:media*`。
2. **音频的数据通路已经建好**：PLAN 写「和 P4e 共用数据通路，谁先做谁建」，P4e 已建 `SceneSpectrum`；P7 查明并实现了数组打包。P11a 只剩接线。
3. **`usertextures`**：PLAN 写「30 张，除了媒体缩略图都是用户自选纹理」。实际 34 张，三种来源：属性纹理、封面、快捷方式图标（`usershortcut` 类型的项 65 个，PLAN 没提）。按 WPE 的实现并成一个机制。
4. **快捷方式**：PLAN 写 1 张，现在 3 张，图标也是纹理来源。
5. **分节**：PLAN 没分节，这里按「音频 → 属性纹理 → 媒体 → 快捷方式」分四节。

## 步骤 0 — 调研（整节一次）

**读码**（交给代理，REA 看 `wallpaper64.exe` 2.8.42；rea-p4e-audio、rea-p7-shader、P3 报告、rea-p5-modelflags 已读到的部分只复核）。本会话 REA MCP 没连上，开工前先确认能连：
- **音频 uniform**：
  - rea-p4e-audio 3.4 已读到六个 uniform 的编号与拷贝；复核每次绘制都填还是每帧一次，effect 中间 pass、粒子 pass 是否同样填；
  - 工程没声明 `supportsaudioprocessing` 时 uniform 是否全 0（4.3 说 `ctx` 三块保持 0，复核 uniform 读的就是它）；
  - 读这六个 uniform 会不会自己打开采集：4.3 说音频粒子不会，着色器呢。
- **`usertextures`**：
  - 材质解析（`FUN_140155785` 一带）：字符串项与对象项（`system` / `usershortcut`、`keepaspect`）、空槽，effect pass 与 `instance` 上的同名键；
  - setter `FUN_1401538d0` 与待刷新集合 `S+0x1678` 的消费点：在帧里什么时候换纹理；
  - 属性值为空串、文件不存在、读不出来时，槽里是缺省纹理还是别的；
  - 用户选的文件怎么读：收哪些格式（图片、GIF、视频）、是否先转成 `.tex` 放进缓存、尺寸上限、mip、sRGB、采样器；`usertexturereference` 和 `keepaspect` 怎么影响尺寸与 `g_Texture<n>Resolution`；
  - `usertextures` 的增量会不会进 `applyUserProperties` 的参数（P3 报告留的问题）。
- **封面**：
  - 每帧脚本函数 `FUN_140171440` 的封面路径：什么时候把 `$mediaThumbnail` 当增量写、`$mediaPreviousThumbnail` 是哪一张；
  - 还没有媒体、没有封面、关掉媒体集成时，两个槽里是什么；
  - 封面图的尺寸与格式（SMTC 给的流原样解码，还是缩放到固定尺寸）；
  - 三主色、文字色、高对比色的算法（是否和网页壁纸共用一份）。
- **媒体回调**：
  - 在帧里的位置：相对 `update`、计时器、`engine.Tick`，同一帧收到几种消息时的先后；
  - 场景加载后是否补发当前状态（属性、封面、播放、时间轴），`mediaStatusChanged` 什么时候发；
  - 事件对象的构造：字段、`Vec3`、`MediaPlaybackEvent` 的常量是不是全局可见；
  - 壁纸暂停、隐藏时回调还调不调，恢复后补不补；
  - WPE 设置 `mediaintegration` 关掉时的行为。
- **快捷方式**：
  - `usershortcut` 属性的值存什么（路径、参数、图标），WPE 的配置里怎么写；
  - 图标怎么取（尺寸、格式、取不到时）、绑在哪个槽；
  - `openUserShortcut` 的门禁：只在哪些光标回调里、每次点击至多一次、返回值；启动方式（`ShellExecute` 的动词、`.lnk` / `.url` / 目录）。

**实测（WPE + RenderDoc）：**
- **音频**：kbp gen 加一个读六个 uniform 的图层（P4e 的 CLK 已读 16、64 段，补 32），带一段已知的测试音循环（P4e 的 `p4e-audio` 自带一段）：
  - 从抓帧的常量缓冲读三档左右声道，核对 64 → 32 → 16 逐级取最大、左右声道与 P4e 的块一致；
  - 静音时、去掉 `supportsaudioprocessing` 时各抓一组。
- **属性纹理**：一个 `scenetexture` 属性，绑到图像层、粒子、effect pass 各一个槽：
  - `apply_properties` 设成已知图片（非 2 的幂、带 alpha 的 PNG，一张 JPG），抓帧读纹理的尺寸、格式、像素与 `g_Texture<n>Resolution`；
  - 空值与不存在的路径各一组；
  - 如果读码说收视频，加一段视频。
- **媒体**：要一个可控的系统媒体会话。做一个「SMTC 夹具」小程序：发布一个会话，标题、艺术家、封面、播放状态、时间轴都按脚本给，可以顺带放测试音：
  - 测试工程的脚本把收到的每个媒体事件打进 `[kbp]` 日志；材质把两个封面槽画出来；
  - 换封面、暂停、停止、切歌各抓一组，读封面纹理与日志；
  - 用几张已知图片做封面，拟合三主色与文字色的算法（读码给出公式时只核对）。
  - 测试时 WPE 取的是系统「当前」会话，用户自己在放音乐会抢走。到时先问，请用户暂停播放器。
- **快捷方式**：只读码，看面板和配置。实际点击会在用户电脑上启动程序，等用户同意再测，目标选无害的（打开一个文件夹）。

**产出：**
- `rea-p11-media.md`（读码）、`p11-REPORT.md`（实测）、本文件的步骤 0 实施记录；
- kbp-tools：生成读六个 uniform 的图层、`scenetexture` 属性、媒体事件日志脚本；SMTC 夹具（放 kbp-tools，在 SKILL 里登记）。

## P11a — 音频 uniform

**实现**（按步骤 0 的结论细化）：
- **能力表**：六个 `g_AudioSpectrum*` 进引擎 uniform 表，`p2a.test.ts` 的两边一致核对跟着补。
- **渲染器**：每帧从 `SceneSpectrum` 的三块取左右声道，按打包形态（连续的 `4n` 字节）写进常量缓冲；粒子 pass 与 effect pass 照步骤 0。
- **订阅判定**：`bundle.audio` 改成「声明了开关，且有音频粒子或有程序读这六个 uniform」；宿主照旧订阅、被拒时频谱全 0。
- **确定性注入**：dev 探针与 kbp 回放已能逐帧注入 16 段（P4e），扩成三档都能注入，回放 WPE 时填抓帧里读到的值。

**验收：**
- 测试工程注入抓帧里读到的频谱，我们的常量缓冲和 WPE 的逐值相同；
- 只差 P11a 的 19 张在 P4–P10 合入后和 WPE 比整帧（注入同一帧频谱）；
- 放音乐时频谱条跟着动（人眼）；
- 语料：去掉 `uniform:g_AudioSpectrum*` 后其余场景逐张不变。

## P11b — 用户纹理

**实现：**
- **编译期**：材质 pass、effect pass、对象 `instance` 的 `usertextures` 逐槽解析成来源（属性名 / 系统名 / 快捷方式名），和该槽的缺省纹理一起进 bundle；尺寸规则（`usertexturereference`、`keepaspect`）照步骤 0。
- **能力表**：属性来源的项不再报；封面与快捷方式的项在 P11c、P11d 之前照报细分键 `usertextures:system`、`usertextures:usershortcut`，替换 `material:usertextures` 与 `effect:*:pass:usertextures`。
- **主线程**：`src/usertex/` 的纹理来源表：每个来源一份当前纹理；来源变了就重建绑定这些槽的 bind group，不重编译。绑定表（P3a）加一种目标「纹理来源」，用户改属性走就地路径。
- **属性面板**：后端 `user_props.rs` 认 `scenetexture`（只在场景上），面板给文件选择（格式过滤照步骤 0），值照 `file` 属性存进 `userProperties`。
- **放行**：场景宿主的 `file:` 范围加上库内场景各自选中的纹理文件，按当前 metadata 覆盖。时机照网页壁纸 `file` 属性：`metadataId` 补丁到达时、宿主拉取状态返回之前各写一次。宿主是一份文档，放行对全部场景宿主实例生效；文件都是用户自己选的，可以接受。
- **解码**：宿主读文件、`createImageBitmap` 解码，按步骤 0 的格式、尺寸、mip 规则上传；读不出来时退回缺省纹理，不报错。

**验收：**
- 测试工程选同一张图，和 WPE 逐像素比（图像层、粒子、effect 各一个槽）；
- 空值时和 HEAD 逐字节相同；
- 面板里选图、换图、清空都就地生效，不重编译；
- 解锁 6 张（P4–P10 先做完时 104 → 110）。

## P11c — 媒体

**实现：**
- **订阅**：bundle 记下「场景用媒体」：导出了媒体回调，或有封面来源的槽。宿主据此订阅 `kind: "media"`；被拒、非 Windows、设置「媒体集成」关掉时照 WPE 关掉媒体集成的行为。
- **回调**：`src/media/` 收消息、排队，在步骤 0 定的位置交给脚本运行时；五个回调从 `MISSING_SCRIPT_CALLBACKS` 移到 `RUNTIME_CALLBACKS`；事件类与 `PLAYBACK_*` 常量进脚本 realm。
- **封面纹理**：`$mediaThumbnail` / `$mediaPreviousThumbnail` 是 P11b 纹理来源表里的两个系统来源，由消息里的 PNG 解码；没有封面时的取值照步骤 0。
- **配色**：`WpeMediaHub` 的封面消息另带数值颜色，或宿主解析 `rgb()`。算法是否改成 WPE 的，见「待定」2。

**验收：**
- 用 SMTC 夹具驱动同一串媒体变化，我们的回调序列与参数和 WPE 的日志一致；封面纹理和 WPE 抓帧逐像素比；
- 关掉「媒体集成」、非 Windows 时脚本收到 `enabled: false`，封面槽是缺省纹理；
- 解锁 14 张（124），多数还要 P10b、P6b 先做完。

## P11d — 快捷方式

**实现：**
- **属性面板**：后端认 `usershortcut`，面板让用户选程序或文件，值存进 `userProperties`。
- **图标**：后端取所选目标的图标转成 PNG，作为 P11b 的快捷方式来源；没配置时用缺省纹理。
- **`engine.openUserShortcut(name)`**：宿主检查是否在光标回调里、本次点击是否已经用过，再调新命令（只给场景宿主 capability）。后端按图片 id 从 metadata 读该属性的路径，属性类型必须是 `usershortcut`，再启动；返回值照 WPE。
- **平台**：见「待定」3。

**验收：**
- 面板里配好后，图标和 WPE 一样；点击启动所配的目标，每次点击一次；
- 反向用例：页面调没配过的属性名、在光标回调之外调、伪造路径，都不启动；
- 解锁 2 张（126），要 P6c 先做完。

## 和其它节的交界

- **共享文件**：P4–P10 的会话都在改 `compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`render/renderer.ts`、`render/uniforms.ts`、`host.ts`、`script/api.ts`、`script/runtime.ts`。
  - P11 的新代码放 `src/media/`、`src/usertex/`；
  - 共享文件只加接线，按块暂存；
  - 改帧循环、能力表前先看一次别的会话的状态，同 P6、P7、P9、P10 的约定。
- **P3a / P3b**：纹理来源是绑定表的新目标；媒体回调接进脚本运行时，返回值不写回（P3 报告：只有 `init`、`update`、`animationEvent` 的返回值写回）。
- **P4e**：频谱、订阅与注入工具都复用，粒子行为不变；P11a 改 `bundle.audio` 的判定要保住 P4e 的用例。
- **P5b**：instanced 纯色图层的 `instance.usertextures` 与 `usertexturereference`，P5b 照报，归 P11b。
- **P6**：媒体回调里改文本（P6b）；快捷方式只能在光标回调里调（P6c）。
- **P9**：属性纹理如果是视频，走 P9 的视频纹理；`$mediaThumbnail` 是静态图片，不走视频。
- **P10**：26 张媒体场景在回调里调 `getAnimation`（P10b）。
- **网页壁纸 Phase 8**：`WpeMediaHub` 的消息形状与配色算法两边共用，改动要保住网页壁纸的垫片（`wpe_shim.js`）。
- **工具**：kbp-tools 的新生成与 SMTC 夹具按它的协议加，在 SKILL 里登记。

## 决定（2026-11-13 用户：「好的」，五条按推荐；另加：非 Windows 的音频在代码里标 `TODO:[WPE_SCENE]`）

1. **分节与顺序**：推荐 P11a → P11b → P11c → P11d。先建纹理来源机制（属性文件是最简单的数据源），再接封面和图标。另一种是先做媒体（a → c → b → d），中途多解锁 5 张，终点相同。
2. **封面配色**：如果步骤 0 查明 WPE 的算法和我们的 `colors.rs`（量化直方图）不同，推荐照 WPE 改 `colors.rs`，网页壁纸与场景共用一份。脚本拿颜色给图层上色（12 张），差了画面就不一样；网页壁纸也会更接近 WPE。不改的话，场景要另写一份。
3. **快捷方式的平台**：推荐只做 Windows。WPE 只有 Windows；启动与取图标都是平台相关的代码。其它平台面板不显示这类属性，`openUserShortcut` 返回 `false`，图标槽用缺省纹理，能力键照样去掉。
4. **测试时的系统状态**：步骤 0 的媒体实测会在用户电脑上发布一个测试媒体会话、放测试音（声音可以调小），要请用户暂停自己的播放器。快捷方式的实际启动测试等用户同意再做。推荐步骤 0 先做读码和音频、属性纹理的实测，媒体实测前再问一次。
5. **顺序**：步骤 0 现在就做（只读码、只实测）。P11a 的实现要改帧循环、uniform 写入和能力表，和 P4–P10 的会话错开；各节的语料验收要等前面的节合入。

## 风险

1. **封面配色**：WPE 的算法没读出来时只能拟合，几张测试图对上不等于全部对上。
2. **媒体会话不可控**：WPE 和我们都取系统的「当前」会话，用户自己的播放器会抢走；验收依赖 SMTC 夹具能稳定成为当前会话。
3. **快捷方式的安全**：启动程序是唯一一个对系统有副作用的 API，门禁要有反向用例，放行范围不能扩到页面能控制的数据。
4. **共享文件**：和 P4–P10 的会话同时改帧循环、能力表、uniform 写入与脚本运行时。按块暂存，必要时在 HEAD 快照里实现再三方合并。
5. **验收样本**：41 张里大多还要 P8–P10 合入才能整帧比，在那之前靠确定性工程。

## 实施记录

（空）
