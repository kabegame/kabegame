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
   * `platform`（平台不支持）、`handle`（句柄 / 任务 / 控制台流不存在，多半是 vite 重启过）、`vite`（插件内部错误）。
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
  preview: boolean;
  grid: string;
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

export interface RenderRequest {
  imageId: string;
  /** `g_Time`（秒），缺省 1.5（同画面哈希基线）。 */
  time?: number;
  /** 场景后处理档位，缺省 `disabled`（同探针）。 */
  postprocess?: ScenePostprocess;
  /** 缺省取库里这张图当前的用户属性（同画面哈希基线的取法）。 */
  userProperties?: Record<string, unknown>;
  pointer?: [number, number];
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
  /** PNG 的 base64。 */
  png: string;
  /** PNG 文件本身的 sha256。 */
  pngSha256: string;
  pngBytes: number;
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
