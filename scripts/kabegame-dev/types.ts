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
  transition: unknown;
  transitionByMode: unknown;
  styleByMode: unknown;
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

export interface RenderRequest {
  imageId: string;
  /** `g_Time`（秒），缺省 1.5（同画面哈希基线）。给了 `particles` 时不收（读回那一帧的 `g_Time` 取 `times` 末项或 dt 累计）。 */
  time?: number;
  /** 场景后处理档位，缺省 `disabled`（同探针）。 */
  postprocess?: ScenePostprocess;
  /** 缺省取库里这张图当前的用户属性（同画面哈希基线的取法）。 */
  userProperties?: Record<string, unknown>;
  /** `g_PointerPosition`，也作控制点跟随指针的光标（预热、回放的每一帧和读回那一帧都用它）；缺省 `[0.5, 0.5]`。 */
  pointer?: [number, number];
  /** 确定性粒子回放，原样交给探针 `renderFrame`；不给时画的是预热后的状态（不步进）。 */
  particles?: ParticleReplay;
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
  /** 每帧光标下的场景纹理坐标，和 `dts` 等长；不给时是场景中心。 */
  cursors?: [number, number][];
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
  /** 帧表系统才有：`[vx, vy, vz, frame 原值]`。 */
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
  /** 存活粒子数（不受 `limit` 影响）。 */
  count: number;
  /** 每个角的 UV：`(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`。 */
  uv: [number, number][];
  /** 每粒子 4 个角的裁剪坐标 `[x, y, z, w]`。 */
  corners: number[][][];
  /** 同一角的场景像素坐标 `[x, y]`（原点左上、y 向下）。 */
  pixels: number[][][];
  particles: ParticleTrackParticle[];
  wgsl?: string;
}

/** 探针 `renderFrame` 的结果（`sha256` 是 8 位 RGBA 的摘要，不是 PNG 文件的）。 */
export interface RenderMeta {
  width: number;
  height: number;
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
