/**
 * kabegame-dev REST 的请求与响应形状。vite 侧与 `apps/kabegame-dev-mcp/src/client.ts` 共用这一份：只有类型和一个判别函数，
 * 不 import 任何东西，客户端引用它不会带进 vite 侧的依赖。
 */

/** 目标写法：`main` / `wallpaper` / `url:<URL 子串>` / `host:<宿主句柄或 kbInstance>`。 */
export type TargetSpec = string;

/** 找到的 CDP 端点。 */
export interface Endpoint {
  kind: "desktop" | "android";
  port: number;
  webSocketUrl: string;
  /** `/json/version` 的 `Browser`。 */
  browser?: string;
  /** 桌面：登记里的 app 进程号；安卓：设备上 app 的 pid。 */
  pid?: number | null;
  /** 安卓：adb 设备序列号。 */
  serial?: string;
  /** 安卓：设备上的调试 socket 名（不带 `@`）。 */
  socket?: string;
}

/** 找端点失败：哪一层、为什么、下一步。 */
export interface EndpointError {
  error: string;
  layer: "registration" | "cdp" | "adb" | "device" | "app" | "socket" | "forward";
  hint?: string;
  port?: number;
  pid?: number | null;
  serial?: string;
}

export type EndpointResult = Endpoint | EndpointError;

export function isEndpointError(value: EndpointResult): value is EndpointError {
  return "error" in value;
}

/** 出错时的响应体。 */
export interface ErrorBody {
  error: string;
  /**
   * 出错的层：`rest`（路由 / 参数）、`access`（来源校验）、`cdp`（连不上 CDP，带 `endpoint`）、`target`（找不到目标）、
   * `page`（页面里抛错 / 找不到元素）、`app`（应用命令拒绝）、`host`（场景宿主）、`guard`（测试工程护栏）、
   * `platform`（平台不支持）、`handle`（句柄 / 任务 / 控制台流不存在，多半是 vite 重启过）、`png`（要 `resize` 但 PNG 格式
   * 不支持缩小）、`vite`（插件内部错误）。参数错的 400 带 `field`（哪一项，例如 `particles.dts[3]`）。
   */
  layer: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  connected: boolean;
  /** 每建立一条新的 CDP 连接加一；句柄带着它，连接换过就失效。 */
  generation: number;
  endpoint: Endpoint | null;
  hosts: string[];
  consoles: string[];
  jobs: { running: number; total: number };
}

export interface HealthInfo {
  vite: true;
  android: boolean;
  /** 本次请求时现探的结论。 */
  cdp: EndpointResult;
  session: SessionSummary;
}

export type TargetRole = "main" | "wallpaper" | "scene-host";

export interface TargetSummary {
  targetId: string;
  type: string;
  url: string;
  title: string;
  parentId: string | null;
  role: TargetRole | null;
  /** 场景宿主：`kbScene`、`kbInstance`，以及 vite 开的句柄。 */
  scene?: string | null;
  instance?: string | null;
  handle?: string | null;
}

export interface EvalRequest {
  target: TargetSpec;
  expression: string;
  timeoutMs?: number;
}

export interface EvalResponse {
  /** `returnByValue` 的值；`undefined` 记为 null，看 `type` 区分。 */
  value: unknown;
  type: string;
}

/** CSS 像素、相对目标页面视口的矩形。 */
export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export interface ScreenshotRequest {
  target: TargetSpec;
  selector?: string;
  clip?: ClipRect;
  fullPage?: boolean;
}

/**
 * 回到调用方的图片尺寸约束：等比、不放大，几项同时给时取最严的；一项都没给时按长边 1568。
 * REST 的截图、渲染、安卓整屏可选带它；不带时回原图。实现在 `png.ts`（只支持 8 位、不隔行的 RGB / RGBA）。
 */
export interface ResizeRequest {
  /** 相对原尺寸的倍数（大于 1 按 1 算）。 */
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ImageDims {
  width: number;
  height: number;
}

/** 原图与回传图的尺寸。 */
export interface ImageSizeInfo {
  original: ImageDims;
  returned: ImageDims;
  resized: boolean;
}

/** REST `POST /screenshot` 的请求体：截图参数加可选的 `resize`。 */
export interface ScreenshotBody extends ScreenshotRequest {
  resize?: ResizeRequest;
}

export interface SelectorRequest {
  target: TargetSpec;
  selector: string;
}

export interface ClickResponse {
  clicked: true;
  /** 主窗口（或目标页面）视口里的点击坐标。 */
  x: number;
  y: number;
  tag: string;
}

export interface TextResponse {
  text: string;
}

export interface InvokeRequest {
  command: string;
  args?: Record<string, unknown>;
}

export interface InvokeResponse {
  value: unknown;
}

export interface ConsoleStartResponse {
  id: string;
  target: TargetSpec;
  targetId: string;
  startedAt: string;
}

export interface ConsoleEntry {
  seq: number;
  /** 页面里的时间戳（毫秒，epoch）。 */
  ts: number;
  /** `log` / `warn` / `error` / … ；未捕获异常是 `exception`。 */
  type: string;
  text: string;
  url?: string;
  line?: number;
}

export interface ConsoleBatch {
  id: string;
  entries: ConsoleEntry[];
  /** 下一次 `since` 传这个。 */
  next: number;
  /** 流结束的原因（目标销毁、连接断开），还在收集时为 null。 */
  ended: string | null;
  /** 缓冲满被丢掉的条数。 */
  dropped: number;
}

export interface ConsoleStopResponse {
  id: string;
  stopped: true;
  total: number;
}

export interface MainState {
  vis: string;
  route: string;
  /** 有图片预览弹窗开着（按弹窗本身的可见状态判断，图片、视频、网页、场景都算）。 */
  preview: boolean;
  /** 开着的预览弹窗是哪张图；没开为 null。 */
  previewImageId: string | null;
  grid: string;
}

/** 主窗口里的图片预览弹窗（依赖 Vue 内部：`ImagePreviewDialog` 的 `previewVisible` 与 `image` prop）。 */
export interface PreviewInfo {
  open: boolean;
  /** 弹窗的目标图片 id（没开为 null）。 */
  imageId: string | null;
  /** 弹窗画的确实是这张（单图路线要等按 id 取回）。 */
  resolved: boolean;
  /**
   * `in-view`：图在当前视图里，网格已跳到它所在的页；`single`：不在视图里（或关了「预览自动跟随视图翻页」），
   * 降级成单图预览；`locating`：还拿着旧对象、网格在跳页。
   */
  mode: "in-view" | "single" | "locating" | null;
  /** 网格当前持有的行里有没有这张。 */
  inView: boolean;
  /** 网格当前页码（1 起）与每页条数。 */
  page: number | null;
  pageSize: number | null;
}

/** 主窗口在不在前台。 */
export interface WindowFrontState {
  /** 主窗口页面的 `document.visibilityState`（被别的窗口完全挡住、最小化时是 hidden）。 */
  visibilityState: string;
  /** 主窗口页面的 `document.hasFocus()`。 */
  hasFocus: boolean;
  /** `plugin:window|is_minimized` / `is_visible`，读不到为 null。 */
  minimized: boolean | null;
  visible: boolean | null;
}

export interface ShowWindowResult {
  /** 到前台了：页面可见且有焦点。 */
  front: boolean;
  /**
   * `focus`：unminimize（最小化时）→ show（不可见时）→ set_focus 就到了前台；
   * `always-on-top`：没到前台（Windows 前台限制），又临时置顶、set_focus、取消置顶一次。
   */
  path: "focus" | "always-on-top";
  before: WindowFrontState;
  after: WindowFrontState;
  /** 每一步调的应用命令与结果。 */
  steps: string[];
}

export interface OpenImagePreviewRequest {
  imageId: string;
  /** 等预览打开的上限（毫秒），缺省 45 s。 */
  timeoutMs?: number;
  /** 打开后把主窗口带到前台，缺省 true。 */
  show?: boolean;
}

export interface OpenImagePreviewResult {
  imageId: string;
  /** 重载前的主窗口：路由（pathname + search）与预览。 */
  before: { route: string; preview: PreviewInfo };
  /** 重载后、预览打开时的路由。 */
  route: string;
  preview: PreviewInfo;
  /** `show: false` 时为 null。 */
  window: ShowWindowResult | null;
  ms: number;
}

export interface AppState {
  currentWallpaper: unknown;
  mode: unknown;
  paused: unknown;
  /** 壁纸是否启用（`get_wallpaper_enabled`）。 */
  enabled: unknown;
  postprocess: unknown;
  /** 显示器模式（`get_wallpaper_display_mode`）：multiple / span / single。 */
  displayMode: unknown;
  /** 壁纸目标配置（`get_wallpaper_targets`）：目标 id → 轮播路径与位置、样式、过渡、当前壁纸。 */
  targets: unknown;
  rotationEnabled: unknown;
  route: string;
  /** 现有场景宿主的 [所在窗口, kbScene]，用来核对没有残留宿主。 */
  sceneHosts: Array<[string, string]>;
}

export interface HostSummary {
  targetId: string;
  url: string;
  scene: string;
  instance: string;
  where: "main" | "wallpaper" | "?";
  /** vite 开的宿主才有句柄。 */
  handle: string | null;
  hidden: boolean | null;
}

export interface HostOpenRequest {
  /** 缺省 true：主窗口里挂屏外 iframe，不碰用户的预览。false 时开主窗口预览（主窗口已有预览就拒绝）。 */
  hidden?: boolean;
  /** 宿主的 `kbScene`；缺省取库里第一张 `x-wpe/scene`。 */
  scene?: string;
}

/** 宿主自检，格式同旧 `hash-*.json` 的 `hostBuild`。 */
export interface HostBuild {
  entry: string;
  frameVisibility: string;
  corpusHead: string;
}

export interface OpenedHost {
  handle: string;
  instance: string;
  scene: string;
  entry: string;
  hidden: boolean;
  targetId: string;
  build: HostBuild;
}

export interface HostCloseResult {
  handle: string;
  before: MainState;
  after: MainState;
  previewHostsLeft: number;
}

export interface HostEvalRequest {
  expression: string;
  timeoutMs?: number;
}

export type ScenePostprocess = "disabled" | "enabled" | "ultra" | "follow";

/**
 * dev 探针的确定性粒子回放（`apps/wpe-scene/src/dev/particleCorners.ts` 的 `ParticleReplay`，`renderFrame` /
 * `particleCorners` 的 `particles`）：建场景（含预热）后按 `dts` 步进，最后一帧就是读回的那一帧。
 */
export interface ParticleReplay {
  /** 每帧的 `g_Frametime`（秒，有限正数），`dts[0]` 是第 1 帧（对齐 WPE 脚本帧号）。 */
  dts: number[];
  /** 每帧的 `g_Time`，和 `dts` 等长；不给时按 `dts` 累加。 */
  times?: number[];
  /** 随机种子（整数），第 i 个粒子层用 `seed + i`；缺省 1。 */
  seed?: number;
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍；缺省 1。 */
  passes?: 1 | 2;
  /** `{ <objects 下标>: [R, …] }`，按出生顺序顶替该系统抽到的 `R`（[0, 1)），用完退回种子随机数。 */
  random?: Record<string, number[]>;
  /**
   * 逐帧频谱（P4e 步骤 4 的探针参数，P11a 起 REST 也收）：和 `dts` 等长，第 i 项在第 i + 1 帧步进之前写进粒子频谱，null 沿用前一帧；
   * 读回那一帧的六个 `g_AudioSpectrum*` uniform 取截至这一帧最后一个非 null 项，没给的段为 0。不给时全程全 0。
   */
  audio?: (SpectrumFrame | null)[];
}

/** 一帧频谱（P11a，探针 `ParticleAudioFrame`）：WPE 抓帧里读到的 `g_AudioSpectrum16/32/64Left/Right`，原值。 */
export interface SpectrumFrame {
  left: number[];
  right: number[];
  left32?: number[];
  right32?: number[];
  left64?: number[];
  right64?: number[];
}

/** 图层字段（`apps/wpe-scene/src/compile/bindings.ts` 的 `LayerField`）。 */
export type SceneLayerField =
  "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible" | "parallaxDepth";

/** 文本层的运行中字段（P6b 1e-3，宿主 `compile/bindings.ts` 的 `TextRuntimeField`；`replay.ts` 的 `TEXT_FIELDS` 是取值表）。 */
export type SceneTextField =
  | "text"
  | "pointsize"
  | "padding"
  | "spacing"
  | "maxwidth"
  | "maxrows"
  | "limitwidth"
  | "limitrows"
  | "limituseellipsis"
  | "blockalign"
  | "horizontalalign"
  | "verticalalign";

/**
 * 脚本值（第 6 批，`apps/wpe-scene/src/dev/scriptValues.ts` 的 `ScriptValue`）：某个对象某个字段上的字段脚本在读回那一帧会返回的值。
 * 探针不跑场景脚本，按它找到 bundle 里挂在这个字段上的字段脚本，用绑定目标写进状态（同宿主的脚本写回）。
 */
export interface ScriptValue {
  /** `objects` 下标（非负整数），或对象名（非空，重名时探针报错）。 */
  object: number | string;
  /** 图层字段，或文本层的运行中字段（P6b 1e-3）。和 `constant` 二选一。 */
  field?: SceneLayerField | SceneTextField;
  /**
   * 材质常量的键（P11a，`constantshadervalues` 里的名字）：探针找这个图层上挂在它上面的字段脚本，经 `constant` 绑定目标写，同宿主的
   * 脚本写回。和 `field` 二选一。
   */
  constant?: string;
  /** 材质常量所在的 effect（`effects[]` 的 JSON 下标）：同一个图层几个 effect 都有这个键时必给，否则探针报歧义。只跟着 `constant`。 */
  effect?: number;
  /**
   * 1–4 个有限数（同宿主脚本写回铺满后的分量），或布尔。文本字段（P6b 1e-3）另收字符串（最长 4096 个 UTF-16 单元，例如时钟画的
   * 「12:34」），探针按宿主同一条写回规整（`text` 收数时转字符串、`pointsize` 收数），回放前结清重排（缺字体时等读完）。
   */
  value: number[] | boolean | string;
  /** 找不到对象、或这个字段没挂字段脚本时跳过（结果里 `applied: false`），不报错。 */
  optional?: boolean;
}

/** 探针每一项脚本值的结果，顺序同请求。 */
export interface ScriptValueResult {
  /** 解析出的 `objects` 下标；按名字没找到时为 null。 */
  object: number | null;
  /** 解析出的对象名；按下标没找到时为 null。 */
  name: string | null;
  /** 请求的字段；材质常量（P11a）没有。 */
  field?: SceneLayerField | SceneTextField;
  /** 请求的材质常量键（P11a）。 */
  constant?: string;
  /** 材质常量写进的 pass（`objects/<下标>/effects/<下标>/passes/<下标>`，P11a）。 */
  pass?: string;
  value: number[] | boolean | string;
  /** 写进了状态；`optional` 跳过时为 false，`reason` 写明原因。 */
  applied: boolean;
  reason?: string;
}

/**
 * 视频纹理的时刻（P9a 步骤 3，`apps/wpe-scene/src/dev/videoProbe.ts` 的 `VideoTimeOption`）：秒，非负有限数。数字对全部视频纹理生效；
 * `{ <bundle 纹理的 path>: 秒 }` 分别给，没给的取 0。
 */
export type VideoTime = number | Record<string, number>;

/** 探针每段视频纹理实际取的时刻（`videoProbe.ts` 的 `ProbeVideoResult`），顺序同 bundle 纹理。 */
export interface RenderVideo {
  /** bundle 纹理的 path（`videoTime` 对象的键）。 */
  path: string;
  /** seek 完读回的 `currentTime`（秒）；失败时是请求的时刻。 */
  time: number;
  /** 时长（秒）；失败或未知时 null。 */
  duration: number | null;
  width: number;
  height: number;
  /** 读不到或解码出错：这段视频保持透明（同产品），原因在 `error`。 */
  failed: boolean;
  error?: string;
}

/** 探针回的一个用户纹理来源（`UserTextureProbe` 的子集，视频播放器状态不展开）。 */
export interface RenderUserTexture {
  name: string;
  value: string;
  kind: "image" | "gif" | "video";
  status: string;
  width?: number;
  height?: number;
  keys: string[];
  /** 视频：每个纹理名的播放器状态（`currentTime` 等）。 */
  videos?: { key: string; player: { currentTime?: number; [key: string]: unknown } }[];
  /** GIF：每个纹理名换过几次帧与最近一次推进时的帧号。 */
  gifs?: { key: string; frames: number; lastFrame: number }[];
}

export interface RenderRequest {
  imageId: string;
  /** `g_Time`（秒），缺省 1.5（同画面哈希基线）。给了 `particles` 时不收（读回那一帧的 `g_Time` 取 `times` 末项或 dt 累计）。 */
  time?: number;
  /** 场景后处理档位，缺省 `disabled`（同探针）。 */
  postprocess?: ScenePostprocess;
  /** 缺省取库里这张图当前的用户属性（同画面哈希基线的取法）。 */
  userProperties?: Record<string, unknown>;
  /**
   * `g_PointerPosition`（抓帧窗口归一化），也推出控制点跟随指针的光标（预热、回放的每一帧和读回那一帧都用它）；缺省 `[0.5, 0.5]`。
   * 不和 `pointers` 同给。
   */
  pointer?: [number, number];
  /** 确定性粒子回放，原样交给探针 `renderFrame`；不给时画的是预热后的状态（不步进）。 */
  particles?: ParticleReplay;
  /**
   * 逐帧的 `g_PointerPosition`（P5a 收尾），和 `particles.dts` 等长：第 i 帧步进与视差点用第 i 项，预热用第 0 项，读回那一帧的
   * `g_PointerPositionLast` 是倒数第二项。要有 `particles`。
   */
  pointers?: [number, number][];
  /**
   * 抓帧窗口尺寸 `[宽, 高]`：和场景不同尺寸时探针按壁纸样式 `fill` 把光标换到场景上；缺省或同尺寸时原样。没给时探针用 `canvas`；
   * 两个都给时要相同。
   */
  window?: [number, number];
  /**
   * 读回画布尺寸 `[宽, 高]`（第 5 批，两个正整数，各不超过 16384）：探针在读回那一帧编码完场景之后，用产品上屏的同一份着色器与
   * 线性采样器按 `fill`（居中盖满裁切）把场景目标铺进这么大的 `rgba8unorm` 纹理，读回它；不给时读回场景目标（逐字节同以前）。
   * 光标按它换算（`window ?? canvas`）。只改读回、不改渲染：`g_Screen` 等内置 uniform 仍按场景目标算。
   */
  canvas?: [number, number];
  /**
   * 脚本值（第 6 批，最多 64 项）：原样交给探针，探针在建好场景之后、回放之前经字段脚本的绑定目标写进状态。用途：kbp 测试工程的 FR
   * 帧号块（MCP 按读回帧号算颜色，带 `optional: true`）。结果的 `meta.scriptValues` 逐项写明写没写。P6b 1e-3 起也收文本层的运行中
   * 字段与字符串值（按 WPE 抓帧里画的文字渲染一帧，`meta.textSyncs` 是结清重排的次数）；MCP 只发 FR，按字符串渲染走 REST。
   */
  scriptValues?: ScriptValue[];
  /**
   * 跑场景脚本（第 7 批，`apps/wpe-scene/src/dev/probeScripts.ts`）：`true`，或 `{ clock?: 起点时刻（毫秒时间戳）, seed?: Math.random 的种子 }`，
   * 原样交给探针。探针照宿主搭脚本环境，建好场景之后跑 `init`，回放的每一帧（含读回帧）设好相机之后跑一帧；`Date` / `timeOfDay` 是
   * `clock` 加回放时间（读回帧的 `g_Daytime` 跟着它），`Math.random` 按 `seed`，`screenResolution` 是 `canvas ?? window ?? [1920, 1080]`，
   * `localStorage` 只在内存。不和 `scriptValues` 同给（400）。结果的 `meta.scripts` 给各段诊断、做不了的重编译写入、没接的 API；宿主产物
   * 不认识这一项（没回 `meta.scripts`）时 409。
   */
  scripts?: RenderScriptsRequest;
  /**
   * 视频纹理的时刻（P9a 步骤 3，秒）：数字对全部视频纹理生效，`{ <纹理 path>: 秒 }` 分别给（没给的取 0，键不是视频纹理时探针报错、
   * 回 422）；缺省 0。也作用于用户纹理里的视频，对象的键可以是用户视频的值（属性里的绝对路径）。超过时长按循环取模。屏外宿主不跑帧循环、视频用自己的时钟，这是确定性回放视频的唯一办法。结果的 `meta.videos`
   * 给出每段实际取的时刻。
   */
  videoTime?: VideoTime;
  /**
   * 用户纹理里 GIF 的逐帧 g_Frametime（秒，每项有限非负，最多 `MAX_GIF_DTS` 项）：探针在读回之前逐项推进 GIF（相当于每帧都被画到）；
   * 不给时 GIF 停在第 0 帧。空数组也原样转给探针。结果的 `meta.userTextures` 不是数组或项里没有 `kind` 时（宿主产物不认识）409。
   */
  gifDts?: number[];
  /**
   * 逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）：`true`，或 `{ readback?, maxVertices? }`，原样交给探针。探针把设备换成
   * 记录器包过的那个，读回那一帧记下每个 pass、每个 draw 的管线、绑定、uniform、顶点；`readback` 选中的 pass 结束后读回它的颜色
   * 附件。响应多 `trace`（轨迹 JSON）与 `traceImages`（读回图）；合计超过 64 MB 回 413，宿主产物不认识 `trace` 时回 409。
   */
  trace?: RenderTraceRequest;
}

/** 逐 draw 轨迹的请求：`readback` 是 pass 下标或 pass / 目标纹理标签的子串（最多 64 项），`maxVertices` 是 1–4096 的整数。 */
export type RenderTraceRequest = true | { readback?: (number | string)[]; maxVertices?: number };

/**
 * 跑场景脚本的请求（第 7 批）：`clock` 是起点时刻（毫秒时间戳，有限数、绝对值不超过 8.64e15，缺省 2026-01-01T00:00:00Z），`seed` 是
 * `Math.random` 的种子（0–2³²−1 的整数，缺省 1）。
 */
export type RenderScriptsRequest = true | { clock?: number; seed?: number };

/** 探针跑场景脚本的结果（`apps/wpe-scene/src/dev/probeScripts.ts` 的 `ProbeScriptsResult`）。 */
export interface RenderScripts {
  /** 实际用的起点时刻（毫秒时间戳）；`clockDefault` 为真时是缺省值。 */
  clock: number;
  clockDefault: boolean;
  /** 实际用的 `Math.random` 种子；`seedDefault` 为真时是缺省值。 */
  seed: number;
  seedDefault: boolean;
  /** 脚本看到的 `engine.screenResolution`。 */
  screenResolution: [number, number];
  /** `init` 之后跑了几帧（回放帧加读回帧）。 */
  frames: number;
  /**
   * 每段脚本的诊断（同宿主 `host.scripts()`）：`id`、`state`（`inited` / `failed` …）、`exports`、`disabled`（出错停用的回调）、
   * `errors`、`calls`（各回调的次数与最长用时）、`targetKind`、`recompileWrites`。
   */
  diagnostics: {
    id: string;
    state: string;
    exports?: string[];
    disabled?: string[];
    errors?: string[];
    calls?: Record<string, { count: number; maxMs: number }>;
    targetKind?: string;
    recompileWrites?: number;
  }[];
  /** 要整场重编译、探针做不了的写入（值真的变了的）：有就说明读回那一帧和宿主不同，不可信。`firstFrame` 0 是 `init`。 */
  recompile: { path: string; count: number; firstFrame: number; value: number[] | boolean | string }[];
  /** 没接的脚本 API 被问到的次数：声音层、视频纹理、粒子层的方法（空操作）。 */
  unconnected: { sound: number; video: number; particles: number };
  /** 脚本注册过的音频缓冲分辨率（缓冲一直全 0）。 */
  audioResolutions: number[];
  /** 运行时的告警与错误，最多 100 条。 */
  messages: string[];
  /** 脚本 `console` 输出的条数与最后 50 条。 */
  console: { count: number; tail: string[] };
}

/** 探针结果里的轨迹摘要（`apps/wpe-scene/src/dev/drawTrace.ts` 的 `RenderFrameTrace`）：存放区的键与大小，vite 按它取回。 */
export interface RenderTraceMeta {
  /** 轨迹 JSON 的存放键（`<key>.trace.json`）。 */
  key: string;
  bytes: number;
  passes: number;
  draws: number;
  /** 记录器自己出的错与读回帧的 WebGPU 校验错误条数（详见轨迹的 `errors`）。 */
  errors: number;
  readbacks: { pass: number; key: string; width: number; height: number; format: string; bytes: number }[];
  /** 选中了却没读回的 pass 与原因。 */
  readbackErrors: { pass: number; error: string }[];
}

/**
 * 逐 draw 轨迹（探针 `render/trace.ts` 的 `DrawTrace`，这里只写 vite / MCP 用到的字段）。ID 在一次渲染里按创建顺序编号，NaN 成了 null。
 */
export interface RenderDrawTrace {
  version: number;
  resources: Record<string, Record<string, unknown>>;
  passes: Array<{
    index: number;
    label: string;
    draws: unknown[];
    readback?: string;
    readbackError?: string;
    [key: string]: unknown;
  }>;
  copies: unknown[];
  errors?: string[];
}

/** 一张读回图：8 位目标是 PNG（RGBA 原值），浮点目标是 RGBA 单精度小端（`f32`）。 */
export interface RenderTraceImage {
  pass: number;
  /** 目标纹理的格式（`rgba8unorm`、`rgba16float` ……）。 */
  format: string;
  kind: "png" | "f32";
  width: number;
  height: number;
  bytes: number;
  /** base64。 */
  data: string;
}

/** REST `POST /hosts/:h/particle-track` 的请求体：交给探针 `particleTrack`（场景目录按图片 id 取）。 */
export interface ParticleTrackRequest {
  imageId: string;
  /** 每帧的 `g_Frametime`，`dts[0]` 是第 1 帧。 */
  dts: number[];
  /** 每帧的 `g_Time`，和 `dts` 等长；不给时按 `dts` 累加。 */
  times?: number[];
  /** 要输出的帧号（从 1 起，不超过 `dts.length`）。 */
  frames: number[];
  passes: 1 | 2;
  seed?: number;
  random?: Record<string, number[]>;
  /** 逐帧频谱（P11a 起 REST 也收，同 `ParticleReplay.audio`）：粒子读其中的 16 段。 */
  audio?: (SpectrumFrame | null)[];
  /**
   * 每帧的 `g_PointerPosition`（抓帧窗口归一化，P5a 收尾起不再由调用方换到场景上），和 `dts` 等长；不给时跟随点是场景中心。
   */
  cursors?: [number, number][];
  /** 抓帧窗口尺寸 `[宽, 高]`：和场景不同尺寸时探针按壁纸样式 `fill` 把 `cursors` 换到场景上；要和 `cursors` 一起给。 */
  window?: [number, number];
  /** 写进结果的 `tag`。 */
  tag?: string;
}

/** 轨迹里的一个粒子（写进顶点的值，同 RenderDoc 轨迹）。 */
export interface ParticleTrackParticle {
  pos: number[];
  size: number;
  color: number[];
  alpha: number;
  rot: number[];
  /** 帧表系统与拖尾（renderer 是 `spritetrail`，P4c 步骤 5）才有：`[vx, vy, vz, frame 原值]`。 */
  thick?: number[];
}

export interface ParticleTrackFrame {
  frame: number;
  dt: number;
  /** 系统名 → 存活粒子（按槽序）；没有存活粒子的系统不出现。 */
  systems: Record<string, ParticleTrackParticle[]>;
}

/** 探针 `particleTrack` 的结果，格式同 `ignore/p4/tracks/rd-*.json`（`source: "sim"`）。 */
export interface ParticleTrackResult {
  source: "sim";
  project: string;
  tag: string;
  frames: ParticleTrackFrame[];
  /** 每个系统里模拟器跳过的模块（表外模块）。 */
  skipped: Record<string, string[]>;
}

/** REST `POST /hosts/:h/particle-corners` 的请求体：交给探针 `particleCorners`。 */
export interface ParticleCornersRequest {
  imageId: string;
  particles?: ParticleReplay;
  /** 逐帧的 `g_PointerPosition`，规则同 `RenderRequest.pointers`；不给时光标固定在场景中心。 */
  pointers?: [number, number][];
  /** 抓帧窗口尺寸 `[宽, 高]`，同 `RenderRequest.window`。 */
  window?: [number, number];
  /** 粒子层：`objects` 下标或对象名；缺省全部粒子层。 */
  layer?: number | string;
  /** 每层只取前这么多个粒子（按槽序）；缺省全部。 */
  limit?: number;
  /** 缺省 `disabled`。 */
  postprocess?: ScenePostprocess;
  /** 缺省取库里这张图当前的用户属性。 */
  userProperties?: Record<string, unknown>;
  /** 结果里带上改写后的 WGSL（排查用）。 */
  wgsl?: boolean;
}

/** 探针 `particleCorners` 的一层结果。 */
export interface ParticleCornersLayer {
  object: number;
  name: string;
  perspective: boolean;
  /**
   * 渲染时画不画这一层（P4c 步骤 5）：朝向是 NaN（`upright` 的轴平行于视线）时整次绘制跳过，为 false；四角照算（uniform 里是 NaN，
   * 同 WPE 的 `gs_out`）。
   */
  drawn: boolean;
  /** 写进顶点的粒子数（不受 `limit` 影响）：存活粒子，拖尾系统去掉退化的（速度为 0 或平行于视线，P4c 步骤 5）。 */
  count: number;
  /** 每个角的 UV：`(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`。 */
  uv: [number, number][];
  /** 每粒子 4 个角的裁剪坐标 `[x, y, z, w]`。 */
  corners: number[][][];
  /** 同一角的场景像素坐标 `[x, y]`（原点左上、y 向下）。 */
  pixels: number[][][];
  /** 写进顶点的粒子输入，按槽序，与 `corners` 一一对应（拖尾系统同样去掉退化的）。 */
  particles: ParticleTrackParticle[];
  wgsl?: string;
}

/** 探针 `renderFrame` 的结果（`sha256` 是 8 位 RGBA 的摘要，不是 PNG 文件的）。 */
export interface RenderMeta {
  /** 读回图片的尺寸：给了 `canvas` 时是画布，否则是场景目标。 */
  width: number;
  height: number;
  /** 读回的画布 `[宽, 高]`，没给 `canvas` 时为 null（第 5 批；之前的宿主产物没有这一项）。 */
  canvas?: [number, number] | null;
  /** 场景目标（离屏渲染目标）的尺寸（第 5 批；之前的宿主产物没有这一项）。 */
  sceneTarget?: [number, number];
  /** 场景目标的格式（`rgba16float` 是 HDR 场景）；读回的画布总是 `rgba8unorm`。 */
  format: string;
  unsupported: string[];
  postprocess: unknown;
  sha256: string;
  mean: [number, number, number];
  compileMs: number;
  targetBytes: number;
  bloomLevels: number | null;
  time: number;
  frametime: number;
  /** 每一项脚本值写没写进状态（第 6 批；没给时空数组，之前的宿主产物没有这一项）。 */
  scriptValues?: ScriptValueResult[];
  /**
   * 回放前结清文本重排调了几次 `sync`（P6b 1e-3）：只在有文本字段的脚本值写进了状态时有，1 是一次排成、多出的每次是等了一轮字体。跑脚本时
   * （第 7 批）是读回帧之后结清的次数，只在场景有文本层时有。
   */
  textSyncs?: number;
  /** 跑场景脚本的结果（第 7 批）：只在请求带 `scripts` 时有（之前的宿主产物没有这一项）。 */
  scripts?: RenderScripts;
  /** 每段视频纹理实际取的时刻（P9a 步骤 3；没有视频纹理时空数组，之前的宿主产物没有这一项）。 */
  videos?: RenderVideo[];
  /** 用户纹理来源的状态（`usertex/sources.ts` 的 `UserTextureProbe`；之前的宿主产物没有这一项）。 */
  userTextures?: RenderUserTexture[];
  /** 逐 draw 轨迹的摘要：只在请求带 `trace` 时有（之前的宿主产物没有这一项）。 */
  trace?: RenderTraceMeta;
  key: string;
  [key: string]: unknown;
}

export interface RenderResponse {
  meta: RenderMeta;
  /** PNG 的 base64。请求带 `resize` 时是缩小后的那份。 */
  png: string;
  /** 原图 PNG 文件本身的 sha256（不随 `resize` 变）。 */
  pngSha256: string;
  /** 原图 PNG 的字节数（不随 `resize` 变）。 */
  pngBytes: number;
  /** 原图与 `png` 的尺寸（REST 填）。 */
  size?: ImageSizeInfo;
  /** 逐 draw 轨迹（解析后的 JSON）：只在请求带 `trace` 时有。 */
  trace?: RenderDrawTrace;
  /** 读回图，顺序同 `meta.trace.readbacks`：只在请求带 `trace` 时有。 */
  traceImages?: RenderTraceImage[];
}

/** REST `POST /hosts/:h/render` 的请求体：渲染参数加可选的 `resize`。 */
export interface RenderBody extends RenderRequest {
  resize?: ResizeRequest;
}

/** 测试工程清单：目录 → 库里的行与导入任务。 */
export type ProjectManifest = Record<string, { image: string; task: string | null; preexisting?: boolean }>;

export interface ProjectsRemoveRequest {
  manifest: ProjectManifest;
  /** 只移除这个目录之下的行；缺省 `<仓库>/ignore`，必须在它之内。 */
  allowPrefix?: string;
}

export interface ProjectsRemoveResult {
  allowPrefix: string;
  removed: string[];
  tasks: string[];
  /** 移除后再查：行与任务都不在了。 */
  verified: { imagesGone: boolean; tasksGone: boolean };
}

export type JobKind = "host-task" | "hash-baseline" | "projects-import";
export type JobStatus = "running" | "done" | "failed" | "canceled";

export interface JobRecord {
  id: string;
  kind: JobKind;
  params: unknown;
  status: JobStatus;
  progress: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  endedAt: string | null;
}

export interface HostTaskParams {
  host: string;
  /** 返回 Promise 的表达式，在宿主里跑。 */
  expression: string;
  limitMs?: number;
}

export interface HostTaskResult {
  status: "done" | "rejected";
  ms: number;
  result?: unknown;
  error?: string;
}

export interface HashBaselineParams {
  ids?: string[];
  /** 旧基线文件：按 `input.path` 找库里现在的图片 id。 */
  from?: string;
  time?: number;
  levels?: ScenePostprocess[];
  /** 用已开的宿主；缺省自己开一个屏外宿主、结束时关掉。 */
  host?: string;
}

export interface HashLevelRecord {
  stable: boolean;
  sha256: string;
  sha256b?: string;
  postprocess: unknown;
  bloomLevels: number | null;
  targetBytes: number;
  unsupported: string[];
  width: number;
  height: number;
  format: string;
  mean: [number, number, number];
}

export interface HashSceneRecord {
  input: {
    path: string;
    sceneAssets: string[];
    metadataId: unknown;
    userProperties: Record<string, unknown>;
    projectFiles: Record<string, string>;
  };
  levels: Record<string, HashLevelRecord>;
}

/** 格式同旧 `hash-*.json`（`ignore/p3c/step3/baseline.mjs`）。 */
export interface HashBaseline {
  recordedAt: string;
  time: number;
  levels: string[];
  hostBuild: HostBuild;
  scenes: Record<string, HashSceneRecord>;
  closed: Omit<HostCloseResult, "handle"> | null;
}

export interface HashBaselineResult {
  ok: boolean;
  /** 某档两次哈希不同就停下，记在这里。 */
  unstable: { id: string; postprocess: string } | null;
  baseline: HashBaseline;
}

export interface ProjectsImportParams {
  /** 测试工程目录（相对路径按仓库根解析），必须在 `<仓库>/ignore` 之下。 */
  dirs: string[];
}
