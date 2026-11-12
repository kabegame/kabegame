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
}

/** 图层字段（`apps/wpe-scene/src/compile/bindings.ts` 的 `LayerField`）。 */
export type SceneLayerField =
  "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible" | "parallaxDepth";

/**
 * 脚本值（第 6 批，`apps/wpe-scene/src/dev/scriptValues.ts` 的 `ScriptValue`）：某个对象某个字段上的字段脚本在读回那一帧会返回的值。
 * 探针不跑场景脚本，按它找到 bundle 里挂在这个字段上的字段脚本，用绑定目标写进状态（同宿主的脚本写回）。
 */
export interface ScriptValue {
  /** `objects` 下标（非负整数），或对象名（非空，重名时探针报错）。 */
  object: number | string;
  field: SceneLayerField;
  /** 1–4 个有限数（同宿主脚本写回铺满后的分量），或布尔。 */
  value: number[] | boolean;
  /** 找不到对象、或这个字段没挂字段脚本时跳过（结果里 `applied: false`），不报错。 */
  optional?: boolean;
}

/** 探针每一项脚本值的结果，顺序同请求。 */
export interface ScriptValueResult {
  /** 解析出的 `objects` 下标；按名字没找到时为 null。 */
  object: number | null;
  /** 解析出的对象名；按下标没找到时为 null。 */
  name: string | null;
  field: SceneLayerField;
  value: number[] | boolean;
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
   * 帧号块（MCP 按读回帧号算颜色，带 `optional: true`）。结果的 `meta.scriptValues` 逐项写明写没写。
   */
  scriptValues?: ScriptValue[];
  /**
   * 视频纹理的时刻（P9a 步骤 3，秒）：数字对全部视频纹理生效，`{ <纹理 path>: 秒 }` 分别给（没给的取 0，键不是视频纹理时探针报错、
   * 回 422）；缺省 0。超过时长按循环取模。屏外宿主不跑帧循环、视频用自己的时钟，这是确定性回放视频的唯一办法。结果的 `meta.videos`
   * 给出每段实际取的时刻。
   */
  videoTime?: VideoTime;
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
  /** 每段视频纹理实际取的时刻（P9a 步骤 3；没有视频纹理时空数组，之前的宿主产物没有这一项）。 */
  videos?: RenderVideo[];
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
