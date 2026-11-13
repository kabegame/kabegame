/**
 * kabegame-dev MCP 的工具，分三类：
 * - 探活 `status`：两层，vite 在不在；经 vite 问 CDP 在不在；
 * - vite 能力的一对一工具：`targets`、`eval`、`screenshot`……（只经 `client.ts` 调 REST，不另发请求）；
 * - 封装好的工具：`render_scene`、`particle_track`、`particle_corners`、`hash_baseline`、`projects_import`（几次 REST 拼成
 *   一步，长任务等完成并报 MCP 进度），以及不需要 vite 的 `hash_compare`、`app_log`。
 * - 粒子回放（第 4 批）：WPE 的一次抓帧（日志 + RenderDoc 轨迹）在 MCP 里经 `timeline.ts` 组成探针要的 `dts` / `times` /
 *   逐帧光标，工具只收文件路径与回放到的帧号。
 * - 读回画布（第 5 批）：`render_scene` / `host_render` 的 `canvas` 原样交给探针，探针按 `fill` 上屏到这么大的画布再读回；和时间线
 *   交给探针的窗口不同时在 MCP 里报 `[local]`，结果里写明读回的是什么。
 * - 视频时刻（P9a 步骤 3）：`render_scene` / `host_render` 的 `videoTime` 原样交给探针（每段视频 seek 到这个时刻再渲染），结果里写一行
 *   每段实际取的时刻（`meta.videos`）。
 * - 逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）：`render_scene` / `host_render` 的 `trace: { save, readback?, maxVertices? }`，
 *   `readback` / `maxVertices` 交给 REST，轨迹 JSON 与读回图写进 `save` 目录（`writeTrace`），结果里只写一行摘要。
 *
 * 工具表是静态的：vite 不在时照常列出，调用时回 `isError` 并写明是哪一层不在（文本以 `[层]` 开头）。
 * 参数里的相对路径一律按仓库根解析。图片类工具的落盘与缩小见 `imageOutput.ts`。
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  CallToolResult,
  McpServer,
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "./sdk.ts";
import { KabegameDevError } from "./client.ts";
import type {
  ConsoleBatch,
  HashBaselineResult,
  JobKind,
  JobRecord,
  KabegameDevClient,
  OpenImagePreviewResult,
  ParticleCornersLayer,
  ParticleReplay,
  ParticleTrackRequest,
  ParticleTrackResult,
  PreviewInfo,
  ProjectManifest,
  RenderMeta,
  RenderResponse,
  RenderTraceRequest,
  ScriptValue,
  ShowWindowResult,
  WindowFrontState,
} from "./client.ts";
import { DEFAULT_MAX_EDGE, TEMP_SAVE, imageOutput } from "./imageOutput.ts";
import type { ImageOutputOptions } from "./imageOutput.ts";
import { LEVELS, formatMark, markNow, parseMark, readSince, readTail } from "./appLog.ts";
import { compareBaselines, formatCompare, loadBaseline } from "./hashCompare.ts";
import { formatStatus, probeStatus } from "./status.ts";
import { TimelineError, buildTimeline, describeTimeline, frColor, frameRanges } from "./timeline.ts";
import type { Timeline, TimelineSource } from "./timeline.ts";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface DevMcpDeps {
  client: KabegameDevClient;
  /** 仓库根：参数里的相对路径按它解析。 */
  root: string;
  /** 应用日志目录（`<dev 数据目录>/logs`）。 */
  logDir: string;
  /** 写 stderr 的日志；stdout 只给协议。 */
  log: (message: string) => void;
}

/** MCP 进程内的错误（参数、读写文件、任务没成功结束）。 */
export class ToolError extends Error {
  constructor(
    readonly layer: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const LAYER_TITLES: Record<string, string> = {
  vite: "第 1 层：vite 不在（或没有 kabegame-dev 插件）",
  cdp: "第 2 层：vite 在，CDP 不在",
  timeout: "超时",
  handle: "句柄 / 任务 / 控制台流不存在：vite 重启过或 CDP 连接断开过，请重开",
  rest: "参数或接口错误",
  access: "来源校验拒绝",
  target: "找不到目标",
  page: "页面里出错",
  app: "应用命令出错",
  host: "场景宿主出错",
  guard: "测试工程护栏拒绝，库没有改动",
  platform: "当前平台不支持",
  png: "PNG 格式不支持缩小",
  job: "任务没有成功结束",
  timeline: "时间线（WPE 日志 / RenderDoc 轨迹）",
  local: "MCP 本地（参数 / 文件）",
};

/** 错误转成给人看的文本，第一行 `[层] 说明`。 */
export function describeError(error: unknown): string {
  if (error instanceof KabegameDevError) {
    const lines = [`[${error.layer}] ${LAYER_TITLES[error.layer] ?? "出错"}`, error.message];
    if (error.endpoint?.hint) lines.push(`提示：${error.endpoint.hint}`);
    if (error.layer === "vite" || error.layer === "cdp") lines.push("调 status 看两层探活的结论。");
    const extra = Object.fromEntries(
      Object.entries(error.body ?? {}).filter(([key]) => !["error", "layer", "endpoint"].includes(key)),
    );
    if (Object.keys(extra).length) lines.push(JSON.stringify(extra, null, 2));
    return lines.join("\n");
  }
  if (error instanceof ToolError) return `[${error.layer}] ${LAYER_TITLES[error.layer] ?? "出错"}\n${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  return `[local] ${LAYER_TITLES.local}\n${message}`;
}

export const errorResult = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: describeError(error) }],
});

const textResult = (...parts: string[]): CallToolResult => ({
  content: [{ type: "text", text: parts.filter(Boolean).join("\n") }],
});

const pretty = (value: unknown): string => {
  if (value === undefined) return "undefined";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

const resolvePath = (root: string, file: string) => path.resolve(root, file);

function writeOut(root: string, file: string, data: string | Uint8Array, overwrite = true): string {
  const abs = resolvePath(root, file);
  if (!overwrite && existsSync(abs)) {
    throw new ToolError("local", `${abs} 已存在：换个路径，或传 overwrite: true`);
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

/** 图片结果：落盘原图、缩小回传的那份（见 `imageOutput.ts`）。缩小失败时报 `[local]`，带已保存的路径。 */
function imageContent(png: Uint8Array, options: ImageOutputOptions): CallToolResult {
  try {
    return { content: imageOutput(png, options).content };
  } catch (error) {
    throw new ToolError("local", error instanceof Error ? error.message : String(error));
  }
}

const frontText = (state: WindowFrontState) =>
  `visibilityState ${state.visibilityState}，hasFocus ${state.hasFocus}` +
  (state.minimized ? "，最小化" : "") +
  (state.visible === false ? "，不可见" : "");

function showWindowLines(result: ShowWindowResult): string[] {
  return [
    `主窗口${result.front ? "已到前台" : "没到前台"}（路径 ${result.path === "focus" ? "focus：unminimize / show / set_focus" : "always-on-top：又临时置顶、set_focus、取消置顶"}）`,
    `之前：${frontText(result.before)}`,
    `之后：${frontText(result.after)}`,
    ...(result.front
      ? []
      : ["没到前台：Windows 前台限制（后台进程拿不到前台），或窗口在别的虚拟桌面；请用户自己切过去"]),
    `步骤：${result.steps.join("；")}`,
  ];
}

const previewText = (preview: PreviewInfo) =>
  !preview.open
    ? "没开"
    : `开着 ${preview.imageId}（${
        preview.mode === "in-view"
          ? `在当前视图里，第 ${preview.page ?? "?"} 页`
          : preview.mode === "single"
            ? "不在当前视图里，降级成单图预览"
            : "网格还在跳页"
      }${preview.resolved ? "" : "，还没取到图"}）`;

/** MCP 进度通知：值必须单调增，同一个值不重复发。 */
function progressReporter(extra: Extra) {
  const token = extra._meta?.progressToken;
  let last = -1;
  return (done: number, total: number | undefined, message: string) => {
    if (token === undefined) return;
    let progress = done > last ? done : Math.round((last + 0.01) * 1000) / 1000;
    if (total !== undefined && progress > total) progress = total;
    if (progress <= last) return;
    last = progress;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), message },
      })
      .catch(() => {});
  };
}

interface ProgressView {
  done: number;
  total?: number;
  message: string;
}

/** 等任务结束，期间报 MCP 进度；MCP 请求被取消时顺手取消 vite 里的任务。 */
async function waitJobWithProgress(
  client: KabegameDevClient,
  id: string,
  extra: Extra,
  view: (progress: unknown) => ProgressView,
): Promise<JobRecord> {
  const report = progressReporter(extra);
  const onAbort = () => void client.jobCancel(id).catch(() => {});
  extra.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await client.waitJob(id, {
      signal: extra.signal,
      onProgress: (progress) => {
        const v = view(progress);
        report(v.done, v.total, v.message);
      },
    });
  } finally {
    extra.signal.removeEventListener("abort", onAbort);
  }
}

function requireDone(record: JobRecord): unknown {
  if (record.status !== "done") {
    throw new ToolError(
      "job",
      `任务 ${record.id}（${record.kind}）${record.status}：${record.error ?? "没有错误信息"}`,
    );
  }
  return record.result;
}

const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

// ---------------------------------------------------------------- 参数

const TARGET = z
  .string()
  .default("main")
  .describe("目标：main（主窗口）/ wallpaper（壁纸窗口）/ url:<URL 子串> / host:<宿主句柄或 kbInstance>，缺省 main");
const SAVE = z
  .string()
  .min(1)
  .optional()
  .describe(
    `PNG 落盘路径（相对路径按仓库根），或 "${TEMP_SAVE}"：系统临时目录下的 kabegame-dev/，自动命名（工具名 + 时间），结果里给完整路径。落盘的总是原尺寸；不给就只回图`,
  );
const INLINE = z.boolean().default(true).describe("是否把图片放进结果；只想落盘时传 false（要同时给 save）");
const SIZE = z
  .object({
    scale: z.number().positive().optional().describe("相对原尺寸的倍数（大于 1 按 1 算）"),
    maxWidth: z.number().int().positive().optional(),
    maxHeight: z.number().int().positive().optional(),
  })
  .strict()
  .optional()
  .describe(
    `回到会话里的图片尺寸：等比、不放大，几项同时给时取最严。不给时长边缩到 ${DEFAULT_MAX_EDGE}（原图不超过就原样回）；要原图传 { scale: 1 }。只影响回传，不影响落盘`,
  );
const CLIP = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    scale: z.number().positive().optional(),
  })
  .describe("矩形，CSS 像素、相对目标页面视口；scale 放大倍数（相对设备像素比）");
const POSTPROCESS = z.enum(["disabled", "enabled", "ultra", "follow"]);
const IMAGE_ID = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform(String)
  .describe("图片 id");
const POINT = z.tuple([z.number(), z.number()]);
const WINDOW = z.tuple([z.number().positive(), z.number().positive()]).describe("抓帧窗口尺寸 [宽, 高]（像素）");
const PASSES = z.union([z.literal(1), z.literal(2)]);
const SEED = z.number().int().describe("随机种子，第 i 个粒子层用 seed + i；缺省 1");
const RANDOM = z
  .record(z.string().regex(/^\d+$/), z.array(z.number().min(0).lt(1)))
  .describe(
    "{ <objects 下标>: [R, …] }：按出生顺序顶替这个系统抽到的 R（[0, 1)），用完退回种子随机数。randomframe 系统和 WPE 比像素时填轨迹里的 frame",
  );
const TIMELINE = z
  .object({
    log: z
      .string()
      .min(1)
      .describe(
        "WPE 日志（ignore/p4/out/<标签>-log.txt，相对路径按仓库根），只读 [kbp] 条目：「帧号,帧时间,累计时间」，或 cursor=True 工程的五列「…,屏幕x,屏幕y」",
      ),
    track: z
      .string()
      .min(1)
      .optional()
      .describe(
        "RenderDoc 轨迹（ignore/p4/tracks/rd-<标签>.json）：抓到的帧的 dt、g_Time、pointer 取它的 float32 原值",
      ),
    frame: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("回放到这一帧（WPE 脚本帧号，从 1 起），即读回的那一帧；缺省为轨迹里最后一帧"),
    gap: z
      .enum(["error", "split"])
      .optional()
      .describe(
        '日志与轨迹都没有的帧（fps 低时日志每 50 帧才刷一次，尾巴会缺）：缺省报错并列出；"split" 按后一个已知帧的 g_Time 平分，结果里写明哪些帧是平分的',
      ),
    cursors: z
      .union([z.literal("log"), z.literal("track"), z.array(POINT)])
      .optional()
      .describe(
        "逐帧光标，单位是 g_PointerPosition（抓帧窗口归一化，原点左上、y 朝下、不钳制），探针按 window 用 fill 换到场景上，不要自己换算：" +
          '"log" 每帧取日志的屏幕光标 ÷ 窗口尺寸（float32；要 cursor=True 生成的工程，日志缺的帧沿用相邻帧，抓到的帧上和轨迹 pointer 核对）；' +
          '"track" 抓到的帧取轨迹的 pointer、其余取 cursor；或直接给整串（长度 = frame）。三个回放工具都收',
      ),
    cursor: POINT.optional().describe(
      'cursors 为 "track" 时其余帧的光标（g_PointerPosition），缺省 [0.5, 0.5]；不给 cursors 时每帧都用它；和 "log" 不同给',
    ),
    window: WINDOW.optional().describe(
      '抓帧窗口尺寸 [宽, 高]（像素）：缺省从轨迹 tag、再从日志文件名末尾的 -<宽>x<高> 读；"log" 推不出就报错。和场景不同尺寸时探针按 fill 把光标换到场景上',
    ),
    audio: z
      .string()
      .min(1)
      .optional()
      .describe(
        "频谱的录制（相对路径按仓库根）：kbp rdc consts 的输出（真实壁纸解包的工程用 --no-clock），或带 frames[].audio 的 kbp rdc track 轨迹。" +
          "录到的帧取这一帧读到的 g_AudioSpectrum*（同一帧各绘制要相同），没读到的段按 WPE 的取法往下推（32 = 64 两两取大，16 = 32 两两取大），" +
          "推不出的写 0；没录到的帧沿用前一帧。读回那一帧必须录到。粒子读 16 段，读回帧的六个音频 uniform 取这一帧的值",
      ),
  })
  .strict()
  .describe(
    "按 WPE 日志与 RenderDoc 轨迹组时间线：第 f 帧 dt = 日志累计时间第 f 项减第 f − 1 项（6 位小数），g_Time 取日志累计时间；抓到的帧换成轨迹的 dt 与 g_Time",
  );
const TIMELINE_REPLAY = z.object({
  timeline: TIMELINE,
  seed: SEED.optional(),
  passes: PASSES.optional().describe("operator 遍数；缺省按标签里的 fps<N> 推（1–20 两遍，否则一遍），推不出就 1"),
  random: RANDOM.optional(),
});
const PARTICLES_REPLAY = z.object({
  particles: z
    .object({
      dts: z.array(z.number().positive()).min(1).describe("每帧 g_Frametime，dts[0] 是第 1 帧，最后一帧是读回的那一帧"),
      times: z.array(z.number()).optional().describe("每帧 g_Time，和 dts 等长；不给时按 dts 累加"),
      seed: SEED.optional(),
      passes: PASSES.optional().describe("缺省 1"),
      random: RANDOM.optional(),
    })
    .strict(),
});
const REPLAY_TEXT =
  "确定性粒子回放：{ timeline, seed?, passes?, random? }（按 WPE 的一次抓帧组时间线，常用），或 { particles: { dts, times?, seed?, passes?, random? } }（直接给探针）。" +
  "给了就不收 time：读回那一帧的 g_Time 取时间线（或 times）的末项";
/** `particle_corners` 的回放：不渲染，没有 `fr`。 */
const REPLAY = z.union([TIMELINE_REPLAY.strict(), PARTICLES_REPLAY.strict()]).describe(REPLAY_TEXT);
/** FR 帧号块（第 6 批）：只有渲染的两种回放写法收。 */
const FR = z
  .boolean()
  .optional()
  .describe(
    "把 kbp 测试工程的 FR 帧号块涂成读回那一帧（第 N 帧，N = 回放的帧数）的颜色 ((N % 256) / 255, (⌊N / 256⌋ % 256) / 255, 1)，" +
      "同 WPE 里它的颜色脚本（探针不跑脚本，否则 FR 停在初值 0 0 1）；缺省 true。场景里没有挂颜色脚本的 FR 时跳过、不报错，结果里写一行涂了没有",
  );
/** `render_scene` / `host_render` 的回放：另收 `fr`。 */
const RENDER_REPLAY = z
  .union([TIMELINE_REPLAY.extend({ fr: FR }).strict(), PARTICLES_REPLAY.extend({ fr: FR }).strict()])
  .describe(
    `${REPLAY_TEXT}。fr（缺省 true）把 kbp 测试工程的 FR 帧号块涂成读回那一帧的颜色，和 WPE 抓帧比时不用再屏蔽它`,
  );
/** 读回画布的边长上限，同 vite 的 `MAX_CANVAS`。 */
const MAX_CANVAS = 16384;
const CANVAS_SIDE = z.number().int().positive().max(MAX_CANVAS);
const CANVAS = z
  .tuple([CANVAS_SIDE, CANVAS_SIDE])
  .describe(
    `读回画布 [宽, 高]（像素，正整数，各不超过 ${MAX_CANVAS}）：把读回那一帧用产品上屏的同一份着色器与线性采样器，按 fill（居中盖满裁切，` +
      "同 WPE 测试窗口）铺进这么大的画布，读回画布，PNG 就是这个尺寸；不给时读回场景目标（场景分辨率，和以前逐字节相同）。" +
      "画布就是模拟的壁纸窗口，光标按它换算，所以要和时间线交给探针的窗口（逐帧光标的 timeline.window）相同，不同时报 [local]。" +
      "和 WPE 抓帧比时传抓帧窗口的尺寸，比较前不用再缩放。只改读回、不改渲染：g_Screen 等内置 uniform 仍按场景目标算（同产品）；" +
      "WPE 场景比窗口大时按窗口分辨率直接画，我们先按场景分辨率画再缩，细节会有差",
  );
/** 视频时刻（P9a 步骤 3）：秒，非负有限数；对象的项数上限（64）由 vite 的 `checkVideoTime` 查。 */
const VIDEO_SECONDS = z.number().finite().nonnegative();
const VIDEO_TIME = z
  .union([VIDEO_SECONDS, z.record(z.string().min(1), VIDEO_SECONDS)])
  .describe(
    "视频纹理的时刻（秒），缺省 0：数字对全部视频纹理生效；{ <纹理 path>: 秒 } 分别给（键是 bundle 纹理的 path，如 materials/xxx.tex，" +
      "没给的取 0，不是这个场景的视频纹理时报错）。超过时长按循环取模（WPE 视频纹理缺省循环）。屏外宿主不跑帧循环、视频用自己的时钟" +
      "（不跟 g_Time），这是确定性回放视频的唯一办法；实际取的时刻见结果里的「视频纹理」行与 meta.videos。读不到或解码失败的视频保持透明（同产品）",
  );
/** 逐 draw 轨迹：`readback` 的项数上限同 vite 的 `MAX_TRACE_READBACKS`，`maxVertices` 同 `MAX_TRACE_VERTICES`。 */
const TRACE = z
  .object({
    save: z
      .string()
      .min(1)
      .describe("轨迹写到这个目录（相对路径按仓库根）：trace.json 与读回图 pass-<下标>.png / .f32，同名文件覆盖"),
    readback: z
      .array(z.union([z.number().int().nonnegative(), z.string().min(1)]))
      .max(64)
      .optional()
      .describe(
        "选哪些 pass 在结束后读回颜色附件：pass 下标（轨迹里的 index，编码顺序），或 pass 标签 / 目标纹理标签的子串" +
          '（如 "layer 179 VHS Time and Date text glyphs"、"_rt_FullFrameBuffer"）；8 位目标存 PNG（RGBA 原值，alpha 不改），' +
          "浮点目标存 .f32（RGBA 单精度小端）。缺省不读回",
      ),
    maxVertices: z
      .number()
      .int()
      .min(1)
      .max(4096)
      .optional()
      .describe("每个 draw 解码多少个被引用的顶点（同 RenderDoc vs_in 按行列，带索引时按索引顺序），缺省 64"),
  })
  .strict()
  .describe(
    "逐 draw 轨迹：探针把设备包一层记录用的代理，读回那一帧记下每个 render pass（目标、load / store、清屏值）与每个 draw 的" +
      "管线（混合、顶点布局、深度、着色器）、视口、裁剪、绑定（缓冲偏移、纹理 mip / 层、采样器）、uniform（按反射解码成名字 → 值，" +
      "取提交那一刻的值）、索引与顶点，用来和 WPE 的 RenderDoc 抓帧逐 draw 对照。轨迹不进会话，写到 save 目录，结果里写一行摘要",
  );
const RENDER_FIELDS = {
  time: z.number().optional().describe("g_Time（秒），缺省 1.5（同画面哈希基线）；给了 replay 时不收"),
  postprocess: POSTPROCESS.optional().describe("场景后处理档位，缺省 disabled"),
  userProperties: z.record(z.unknown()).optional().describe("用户属性；缺省取库里这张图当前的用户属性"),
  pointer: POINT.optional().describe(
    "固定的 g_PointerPosition（窗口归一化坐标），也推出控制点跟随指针的光标，预热、回放的每一帧和读回那一帧都用它；缺省 [0.5, 0.5]。" +
      "抓帧期间光标在动时改用 replay.timeline 的 cursors（不能同给）",
  ),
  replay: RENDER_REPLAY.optional(),
  canvas: CANVAS.optional(),
  videoTime: VIDEO_TIME.optional(),
  trace: TRACE.optional(),
};
const OUT = z.string().describe("结果写到这个文件（相对路径按仓库根）");
const OVERWRITE = z.boolean().default(false).describe("out 已存在时是否覆盖，缺省拒绝");

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

// ---------------------------------------------------------------- 粒子回放（第 4 批）

type ReplayArg = z.infer<typeof REPLAY>;
type RenderReplayArg = z.infer<typeof RENDER_REPLAY>;
type TimelineArg = z.infer<typeof TIMELINE>;

/** 时间线：读文件、组 dts / times / 光标；出错报 `[timeline]`。 */
export function timelineFor(root: string, source: TimelineArg): Timeline {
  try {
    return buildTimeline(source as TimelineSource, { root });
  } catch (error) {
    if (error instanceof TimelineError) throw new ToolError("timeline", error.message);
    throw error;
  }
}

/** operator 遍数：参数给的优先，其次标签里的 fps<N>，都没有就 1。回遍数与说明。 */
export function passesFor(given: 1 | 2 | undefined, timeline: Timeline | null): { passes: 1 | 2; line: string } {
  if (given !== undefined) return { passes: given, line: `passes ${given}（参数给的）` };
  if (timeline?.passes) {
    const { passes, tag, fps } = timeline.passes;
    return { passes, line: `passes ${passes}（标签 ${tag} 的 fps${fps}：1–20 两遍，否则一遍）` };
  }
  return {
    passes: 1,
    line: `passes 1（标签 ${timeline?.tag ?? "无"} 里推不出 fps，按 1 遍；fps 1–20 的抓帧要传 passes: 2）`,
  };
}

/**
 * 交给探针的光标（P5a 收尾）：时间线的逐帧光标（`g_PointerPosition`）连同窗口尺寸（推不出时不交，探针当作和场景同尺寸）。
 * 窗口只跟着逐帧光标走：没给光标时不交（推出来的窗口不改老调用），显式给了 `timeline.window` 却没给光标报 `[local]`。
 */
export function cursorsFor(
  timeline: Timeline,
  source: TimelineArg,
): { cursors?: [number, number][]; window?: [number, number] } {
  if (!timeline.cursors) {
    if (source.window) {
      throw new ToolError("local", "timeline.window 要和逐帧光标（cursors 或 cursor）一起给：它只用来把光标换到场景上");
    }
    return {};
  }
  return {
    cursors: timeline.cursors,
    ...(timeline.window ? { window: [timeline.window[0], timeline.window[1]] as [number, number] } : {}),
  };
}

/**
 * 渲染与四角的回放参数 → 探针的 `particles`，以及时间线的逐帧光标（探针的 `pointers`）与窗口尺寸。
 */
export function resolveReplay(
  root: string,
  replay: ReplayArg,
): {
  particles: ParticleReplay;
  timeline: Timeline | null;
  pointers?: [number, number][];
  window?: [number, number];
  lines: string[];
} {
  if ("particles" in replay) {
    const p = replay.particles;
    return {
      particles: p,
      timeline: null,
      lines: [
        `回放：直接给的 ${p.dts.length} 帧 dt${p.times ? "（带 times）" : "（g_Time 按 dt 累加）"}；seed ${p.seed ?? 1}；passes ${p.passes ?? 1}` +
          (p.random ? `；random 顶替 ${Object.keys(p.random).join("、")} 号对象的 R` : ""),
      ],
    };
  }
  const source = replay.timeline;
  const timeline = timelineFor(root, source);
  const passes = passesFor(replay.passes, timeline);
  const particles: ParticleReplay = {
    dts: timeline.dts,
    times: timeline.times,
    passes: passes.passes,
    ...(replay.seed !== undefined ? { seed: replay.seed } : {}),
    ...(replay.random ? { random: replay.random } : {}),
    // 逐帧频谱（P11a）：录制按帧号对齐好的
    ...(timeline.audio ? { audio: timeline.audio.frames } : {}),
  };
  const { cursors, window } = cursorsFor(timeline, source);
  return {
    particles,
    timeline,
    ...(cursors ? { pointers: cursors } : {}),
    ...(window ? { window } : {}),
    lines: [
      describeTimeline(timeline),
      `${passes.line}；seed ${replay.seed ?? 1}${replay.random ? `；random 顶替 ${Object.keys(replay.random).join("、")} 号对象的 R` : ""}`,
    ],
  };
}

/**
 * 摘要里的数字（保留 3 位小数）。探针结果经 JSON 传回，NaN / ±Infinity 在 JSON 里成了 null（四角：朝向是 NaN、拖尾退化时，
 * P4c 步骤 5），这里按 NaN 显示，不能当数字格式化。
 */
const num = (value: number | null) =>
  typeof value !== "number" ? "NaN" : Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);

/** 一帧里每个系统的粒子数与位置范围。 */
function systemLines(systems: ParticleTrackResult["frames"][number]["systems"]): string[] {
  return Object.entries(systems).map(([name, particles]) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of particles) {
      for (let axis = 0; axis < 3; axis++) {
        const v = p.pos?.[axis];
        if (typeof v !== "number") continue;
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
    const range = ["x", "y", "z"]
      .map((axis, i) => (min[i] === max[i] ? `${axis} ${num(min[i])}` : `${axis} [${num(min[i])}, ${num(max[i])}]`))
      .join(" ");
    return `  ${name}：${particles.length} 个，${particles.length ? range : "（空）"}`;
  });
}

/** 轨迹摘要：每帧每系统的粒子数与位置范围；帧多时只列头尾各 4 帧。 */
export function summarizeTrack(result: ParticleTrackResult, maxFrames = 8): string[] {
  const frames = result.frames;
  const shown =
    frames.length <= maxFrames ? frames : [...frames.slice(0, maxFrames / 2), ...frames.slice(-maxFrames / 2)];
  const lines: string[] = [];
  shown.forEach((frame, i) => {
    if (frames.length > maxFrames && i === maxFrames / 2) lines.push(`…（省略 ${frames.length - maxFrames} 帧）`);
    const names = Object.keys(frame.systems);
    const total = names.reduce((n, name) => n + frame.systems[name].length, 0);
    lines.push(`第 ${frame.frame} 帧（dt ${frame.dt}）：${names.length} 个系统有粒子，共 ${total} 个`);
    lines.push(...systemLines(frame.systems));
  });
  const skipped = Object.entries(result.skipped ?? {});
  lines.push(
    skipped.length
      ? `模拟器跳过的模块（表外）：${skipped.map(([name, modules]) => `${name}: ${modules.join(", ")}`).join("；")}`
      : "模拟器没有跳过的模块",
  );
  return lines;
}

/** 四角摘要：每层画不画、写进顶点的粒子数，前 3 个粒子的四个像素角。 */
export function summarizeCorners(layers: ParticleCornersLayer[]): string[] {
  const lines: string[] = [];
  for (const layer of layers) {
    // drawn 为 false：朝向是 NaN，渲染时整次绘制跳过，四角照算（同 WPE 的 gs_out），P4c 步骤 5
    const hidden = layer.drawn === false ? "；这一层渲染时不画（朝向是 NaN），四角照算" : "";
    lines.push(
      `层 ${layer.object} ${layer.name}（${layer.perspective ? "透视" : "正交"}）：写进顶点 ${layer.count} 个，取了 ${layer.corners.length} 个${hidden}`,
    );
    layer.pixels.slice(0, 3).forEach((quad, i) => {
      lines.push(`  #${i} 像素角 ${quad.map(([x, y]) => `(${num(x)}, ${num(y)})`).join(" ")}`);
    });
  }
  if (!layers.length) lines.push("没有粒子层（或 layer 没匹配上）");
  if (layers[0])
    lines.push(`角的顺序（uv）：${layers[0].uv.map(([u, v]) => `(${u},${v})`).join(" ")}；像素坐标原点左上、y 向下`);
  return lines;
}

const sizeText = (size: readonly number[]) => `${size[0]}×${size[1]}`;

/**
 * 读回画布与时间线交给探针的窗口（第 5 批）：探针的光标换算窗口是 `window ?? canvas`，两个都有而不同时光标和读回的画面对不上，
 * 在发请求（开宿主）之前报 `[local]`。窗口只跟着逐帧光标交给探针（`cursorsFor`），没给逐帧光标时没有冲突。
 */
export function checkCanvasWindow(
  canvas: readonly [number, number] | undefined,
  window: readonly [number, number] | undefined,
): void {
  if (!canvas || !window || (canvas[0] === window[0] && canvas[1] === window[1])) return;
  throw new ToolError(
    "local",
    `canvas ${sizeText(canvas)} 和时间线交给探针的窗口 ${sizeText(window)} 不同：读回画布就是模拟的壁纸窗口，光标按它换算，两者要相同。` +
      `要和这次 WPE 抓帧比就传 canvas: [${window[0]}, ${window[1]}]`,
  );
}

/**
 * 结果里说明读回的是什么（第 5 批）：给了 canvas 时「画布 W×H，场景目标 SW×SH 按 fill 铺进去」，否则「场景目标 SW×SH」。
 * 没给 canvas、时间线推得出窗口而读回尺寸和它不同时，再提示一行该传的 canvas。之前的宿主产物没有 `canvas` / `sceneTarget`，
 * 按读回尺寸就是场景目标处理。
 */
export function readbackLines(
  meta: Pick<RenderMeta, "width" | "height" | "canvas" | "sceneTarget">,
  canvas: readonly [number, number] | undefined,
  timelineWindow: readonly [number, number] | null | undefined,
): string[] {
  const target = meta.sceneTarget ?? [meta.width, meta.height];
  const lines = [
    meta.canvas
      ? `读回：画布 ${sizeText(meta.canvas)}，场景目标 ${sizeText(target)} 按 fill（居中盖满裁切）铺进去，同产品上屏`
      : `读回：场景目标 ${sizeText(target)}（没给 canvas，不经过上屏）`,
  ];
  if (!canvas && timelineWindow && (timelineWindow[0] !== meta.width || timelineWindow[1] !== meta.height)) {
    lines.push(
      `提示：时间线的窗口是 ${sizeText(timelineWindow)}，读回的是 ${meta.width}×${meta.height}；` +
        `要和这次 WPE 抓帧逐像素比、不用再缩放，传 canvas: [${timelineWindow[0]}, ${timelineWindow[1]}]`,
    );
  }
  return lines;
}

/** FR 帧号块的处理（第 6 批）：回放到第 `frame` 帧时涂成那一帧的颜色；`false` 是 `replay.fr: false`；没有回放时为 null（不发、不写行）。 */
export type FrPlan = { frame: number } | false | null;

/**
 * 交给探针的 FR 脚本值（第 6 批）：回放到第 N 帧（N = `dts.length`）时 `{ object: "FR", field: "color", value: frColor(N), optional: true }`。
 * `optional`：不是 kbp 测试工程（没有叫 FR 的图层，或 FR 的颜色没挂脚本）时探针跳过，不影响别的场景。`fr: false` 时 null。
 */
export function frScriptValue(fr: boolean | undefined, frame: number): ScriptValue | null {
  if (fr === false) return null;
  return { object: "FR", field: "color", value: frColor(frame), optional: true };
}

/** 结果里写一行 FR 涂了没有；探针逐项结果的第 0 项就是 FR（MCP 只发这一项）。 */
export function frLine(fr: FrPlan, meta: Pick<RenderMeta, "scriptValues">): string | null {
  if (fr === null) return null;
  if (fr === false) return "FR：没涂（replay.fr: false）";
  const item = meta.scriptValues?.[0];
  if (!item) return "FR：宿主没回 scriptValues，涂没涂不知道（宿主产物要重建）";
  if (!item.applied) return `FR：场景里没有挂颜色脚本的 FR，没涂（${item.reason ?? "探针跳过"}）`;
  const n = fr.frame;
  return `FR 涂成第 ${n} 帧的颜色 (${n % 256}, ${Math.floor(n / 256) % 256}, 255) / 255（objects[${item.object}]）`;
}

/** 视频纹理（P9a 步骤 3）：每段实际取的时刻，失败的写原因。没有视频纹理（或宿主产物没回 `videos`）时不写。 */
export function videoLine(meta: Pick<RenderMeta, "videos">): string | null {
  const videos = meta.videos;
  if (!Array.isArray(videos) || !videos.length) return null;
  const parts = videos.map((video) =>
    video.failed
      ? `${video.path} 读 / 解码失败、保持透明（${video.error ?? "?"}）`
      : `${video.path} 取 ${video.time} s（时长 ${video.duration ?? "?"} s，${video.width}×${video.height}）`,
  );
  return `视频纹理：${parts.join("；")}`;
}

type TraceArg = z.infer<typeof TRACE>;

/** MCP 的 `trace` → REST 的 `trace`：只给了 `save` 时是 `true`，否则带上 `readback` / `maxVertices`（`save` 不发给 REST）。 */
export function traceRequestOf(trace: TraceArg): RenderTraceRequest {
  const { save: _save, ...rest } = trace;
  return Object.keys(rest).length ? rest : true;
}

/**
 * 逐 draw 轨迹落盘：`save` 目录下写 `trace.json`（紧凑 JSON）与读回图 `pass-<下标>.png` / `.f32`（同名覆盖），轨迹内容不进会话，
 * 返回结果里的一行摘要（pass 数、draw 数、读回了哪些、没读回的原因、目录与文件）。REST 没回轨迹（vite 插件是旧的）报 `[local]`。
 */
export function writeTrace(root: string, save: string, response: RenderResponse): string {
  const { trace, traceImages } = response;
  if (!trace || !Array.isArray(trace.passes) || !Array.isArray(traceImages)) {
    throw new ToolError(
      "local",
      "REST 没回 trace / traceImages：vite 的 kabegame-dev 插件是旧的，重启 dev（vite）后再试；画面已渲染，没写轨迹",
    );
  }
  const dir = resolvePath(root, save);
  const files = ["trace.json"];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "trace.json"), JSON.stringify(trace));
    for (const image of traceImages) {
      const name = `pass-${image.pass}.${image.kind}`;
      writeFileSync(path.join(dir, name), Buffer.from(image.data, "base64"));
      files.push(name);
    }
  } catch (error) {
    throw new ToolError("local", `轨迹写不进 ${dir}：${(error as Error).message}`);
  }
  const draws = trace.passes.reduce((n, pass) => n + (Array.isArray(pass.draws) ? pass.draws.length : 0), 0);
  const read = traceImages.length
    ? `读回 ${traceImages.map((image) => `pass ${image.pass}（${image.width}×${image.height} ${image.format}）`).join("、")}`
    : "没读回";
  const failed = trace.passes.filter((pass) => pass.readbackError);
  const parts = [
    `逐 draw 轨迹：${trace.passes.length} 个 pass、${draws} 个 draw，${read}`,
    ...(failed.length
      ? [`选中了没读回：${failed.map((pass) => `pass ${pass.index}（${pass.readbackError}）`).join("；")}`]
      : []),
    ...(trace.errors?.length ? [`记录器 / 校验出错 ${trace.errors.length} 条（见 trace.json 的 errors）`] : []),
    `写到 ${dir}（${files.join("、")}）`,
  ];
  return parts.join("；");
}

/** 渲染元数据里的粒子数（探针 `particleStats`）。 */
function particleStatsLine(meta: RenderMeta): string | null {
  const stats = meta.particles as Array<{ name?: string; alive?: number }> | undefined;
  if (!Array.isArray(stats) || !stats.length) return null;
  return `粒子层存活数：${stats.map((s) => `${s.name ?? "?"} ${s.alive ?? "?"}`).join("，")}`;
}

type Shape = z.ZodRawShape;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

export function registerTools(server: McpServer, deps: DevMcpDeps): void {
  const { client, root } = deps;
  const viteUrl = client.baseUrl.replace(/\/__kabegame_dev$/, "");

  function tool<S extends Shape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; annotations?: ToolAnnotations },
    run: (args: Args<S>, extra: Extra) => Promise<CallToolResult>,
  ): void {
    const handler = async (args: unknown, extra: Extra): Promise<CallToolResult> => {
      try {
        return await run(args as Args<S>, extra);
      } catch (error) {
        deps.log(`${name} 失败：${error instanceof Error ? error.message : String(error)}`);
        return errorResult(error);
      }
    };
    // SDK 的 ShapeOutput 与 zod 3 的推断类型等价但写法不同，这里在边界上收窄
    server.registerTool(name, config as never, handler as never);
  }

  // ------------------------------------------------------------ 探活

  tool(
    "status",
    {
      title: "两层探活",
      description:
        "探活，分两层：第 1 层 vite（dev server，缺省 127.0.0.1:1420）在不在；第 2 层经 vite 问 CDP（桌面 CEF 或安卓 WebView）在不在。" +
        "不在时报可能原因与下一步。不代起 dev：dev 由用户在自己的终端启动（deno task dev -c kabegame，安卓加 --mode android）。",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const report = await probeStatus(client, viteUrl);
      return textResult(formatStatus(report), "", JSON.stringify(report, null, 2));
    },
  );

  // ------------------------------------------------------------ vite 能力的一对一工具

  tool(
    "targets",
    {
      title: "列出目标",
      description:
        "列出 CDP 的 page 与 iframe 目标（URL、类型、父目标、角色 main / wallpaper / scene-host，场景宿主带 kbScene / kbInstance / 句柄）。",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(pretty(await client.targets())),
  );

  tool(
    "eval",
    {
      title: "页面里求值",
      description:
        "在目标页面里求值，回 returnByValue 的值。表达式或语句块都行（语句块里可写 return，自动包成 async 函数），Promise 会等到结束。",
      inputSchema: {
        target: TARGET,
        expression: z.string().min(1).describe("JS 表达式或语句块"),
        timeoutMs: z.number().int().positive().optional().describe("求值超时（毫秒）"),
      },
    },
    async ({ target, expression, timeoutMs }) => {
      const result = await client.evaluate(target, expression, timeoutMs);
      return textResult(pretty(result.value), result.value === null ? `（type: ${result.type}）` : "");
    },
  );

  tool(
    "screenshot",
    {
      title: "截图",
      description:
        "截目标页面（只有 CEF / WebView 内容，不含系统层；安卓整屏用 android_screen）。selector / clip / fullPage 三选一，都不给就截视口。" +
        "目标是场景宿主时按 iframe 在主窗口里的位置换算后从主窗口截；屏外宿主截不到（改用 render_scene / host_render）。" +
        'Windows 上壁纸窗口挂到 WorkerW 后截不到图，用 eval 读 DOM。回 PNG 图片（缺省长边缩到 1568，size 调），save 落盘原图（路径或 "temp"）。',
      inputSchema: {
        target: TARGET,
        selector: z.string().optional().describe("只截这个元素"),
        clip: CLIP.optional(),
        fullPage: z.boolean().optional().describe("整页"),
        save: SAVE,
        size: SIZE,
        inline: INLINE,
      },
      annotations: READ_ONLY,
    },
    async ({ target, selector, clip, fullPage, save, size, inline }) => {
      if ([selector, clip, fullPage || undefined].filter((v) => v !== undefined).length > 1) {
        throw new ToolError("local", "selector / clip / fullPage 只能给一个");
      }
      if (inline === false && !save) throw new ToolError("local", "inline 为 false 时要给 save");
      const shot: { selector?: string; clip?: z.infer<typeof CLIP>; fullPage?: boolean } = {};
      if (selector !== undefined) shot.selector = selector;
      if (clip !== undefined) shot.clip = clip;
      if (fullPage) shot.fullPage = true;
      const png = await client.screenshot(target, shot);
      return imageContent(png, { root, tool: "screenshot", label: `截图 ${target}`, save, size, inline });
    },
  );

  tool(
    "click",
    {
      title: "点击",
      description:
        "取元素中心派发鼠标事件（不等可操作性，相当于强制点击；常驻浮层如吉祥物会盖住目标时也照点）。回点击坐标与元素标签。",
      inputSchema: { target: TARGET, selector: z.string().min(1).describe("CSS 选择器") },
    },
    async ({ target, selector }) => textResult(pretty(await client.click(target, selector))),
  );

  tool(
    "text",
    {
      title: "取文本",
      description: "取元素的 innerText。",
      inputSchema: { target: TARGET, selector: z.string().min(1).describe("CSS 选择器") },
      annotations: READ_ONLY,
    },
    async ({ target, selector }) => textResult(await client.text(target, selector)),
  );

  tool(
    "invoke",
    {
      title: "调应用命令",
      description:
        "在主窗口里调 Tauri 命令（__TAURI_INTERNALS__.invoke，不包装它），回命令的返回值；命令 reject 时报 [app]。" +
        "注意命令会真的改库：测试工程只用 projects_remove（batch_remove_images），绝不调 batch_delete_images（会连源文件一起删）。",
      inputSchema: {
        command: z.string().min(1).describe("命令名，例如 get_wallpaper_mode"),
        args: z.record(z.unknown()).optional().describe("命令参数（camelCase）"),
      },
    },
    async ({ command, args }) => textResult(pretty(await client.invoke(command, args ?? {}))),
  );

  tool(
    "console",
    {
      title: "控制台消息",
      description:
        "按目标收集 Runtime.consoleAPICalled 与未捕获异常。start 开始收集回流 id；read 取 since 之后的新消息（回 next，下次 since 传它）；stop 停止。" +
        "流在 vite 进程里，vite 重启会丢（报 [handle]）。",
      inputSchema: {
        action: z.enum(["start", "read", "stop"]),
        target: TARGET.describe("start 用：目标，缺省 main"),
        id: z.string().optional().describe("read / stop 用：流 id"),
        since: z.number().int().nonnegative().default(0).describe("read 用：从这个序号之后读"),
      },
    },
    async ({ action, target, id, since }) => {
      if (action === "start") {
        const started = await client.consoleStart(target);
        return textResult(`已开始收集 ${started.target}（流 ${started.id}）`, pretty(started));
      }
      if (!id) throw new ToolError("local", `${action} 要给 id（start 的返回值）`);
      if (action === "stop") return textResult(pretty(await client.consoleStop(id)));
      const batch: ConsoleBatch = await client.consoleRead(id, since);
      const lines = batch.entries.map(
        (e) =>
          `[${e.seq}] ${e.type} ${e.text}${e.url ? `（${e.url}${e.line !== undefined ? `:${e.line}` : ""}）` : ""}`,
      );
      return textResult(
        `流 ${batch.id}：${batch.entries.length} 条，next=${batch.next}` +
          (batch.ended ? `，已结束（${batch.ended}）` : "") +
          (batch.dropped ? `，缓冲满丢了 ${batch.dropped} 条` : ""),
        ...lines,
      );
    },
  );

  tool(
    "app_state",
    {
      title: "应用状态快照",
      description:
        "当前壁纸、模式、暂停、启用、场景后处理、显示器模式、壁纸目标（各目标的轮播路径 / 位置 / 样式 / 过渡 / 当前壁纸）、轮播、路由、现有场景宿主。验收前后各取一次核对不留痕迹。",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(pretty(await client.appState())),
  );

  tool(
    "show_window",
    {
      title: "显示主窗口",
      description:
        "桌面：把主窗口带到前台，让用户看得到在调试什么：最小化时 unminimize、不可见时 show，再 set_focus；没到前台（Windows 前台限制）时退一步临时置顶再取消。" +
        "回走了哪条路径，以及前后的 document.visibilityState / hasFocus（被别的窗口完全挡住时 visibilityState 是 hidden）。会抢走用户当前窗口的焦点。",
      inputSchema: {},
    },
    async () => {
      const result = await client.showWindow();
      return textResult(...showWindowLines(result), "", pretty(result));
    },
  );

  tool(
    "open_image_preview",
    {
      title: "打开图片预览",
      description:
        "在主窗口打开某张图的预览，并把主窗口带到前台（同 show_window）。做法：主窗口导航到 /gallery，保留当前 query，加 pvwimgid=<id>，重载；" +
        "等预览弹窗打开、确认是这张图。图在当前视图里时网格跳到它所在的页，不在时降级成单图预览；不改用户的筛选条件。" +
        "会改变用户正在看的界面（整页重载、关掉原来的预览）；主窗口里有 vite 开的场景宿主时拒绝（重载会销毁它们）。" +
        "场景 / 网页壁纸的预览是可见的实时宿主（跑帧循环，屏外宿主不跑）：之后可以截图，或用 eval target=host:<kbInstance> 在里面求值（kbInstance 见 hosts）。" +
        "一返回就截图会截到弹窗淡入的半透明画面、场景还没出首帧，等 1 s 左右再截。",
      inputSchema: {
        imageId: IMAGE_ID,
        timeoutMs: z.number().int().positive().optional().describe("等预览打开的上限（毫秒），缺省 45000"),
      },
    },
    async ({ imageId, timeoutMs }) => {
      const result: OpenImagePreviewResult = await client.openImagePreview(imageId, { timeoutMs });
      return textResult(
        `预览：${previewText(result.preview)}；路由 ${result.route}；用时 ${(result.ms / 1000).toFixed(1)} s`,
        `之前：路由 ${result.before.route}，预览${previewText(result.before.preview)}`,
        ...(result.window ? showWindowLines(result.window) : ["没有显示窗口"]),
        "",
        pretty(result),
      );
    },
  );

  tool(
    "android_screen",
    {
      title: "安卓整屏截图",
      description: "安卓：adb exec-out screencap 整屏（含系统栏、原生对话框）。桌面调用报 [platform]。",
      inputSchema: { save: SAVE, size: SIZE, inline: INLINE },
      annotations: READ_ONLY,
    },
    async ({ save, size, inline }) => {
      if (inline === false && !save) throw new ToolError("local", "inline 为 false 时要给 save");
      return imageContent(await client.androidScreen(), {
        root,
        tool: "android_screen",
        label: "安卓整屏",
        save,
        size,
        inline,
      });
    },
  );

  tool(
    "hosts",
    {
      title: "列出场景宿主",
      description: "桌面：列出现有场景宿主 iframe（所在窗口、kbScene、kbInstance；vite 开的带句柄）。",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(pretty(await client.hosts())),
  );

  tool(
    "host_open",
    {
      title: "开场景宿主",
      description:
        "桌面：开一个从磁盘新加载的场景宿主，回句柄。hidden（缺省 true）在主窗口挂屏外 iframe，不碰用户的预览；false 开主窗口预览（已有预览就拒绝）。" +
        "只信任入口脚本等于磁盘产物入口的新 frame，并要求 dev 探针在（宿主要用 --mode development 构建）。用完 host_close。",
      inputSchema: {
        hidden: z.boolean().optional(),
        scene: IMAGE_ID.optional().describe("宿主的 kbScene（图片 id），缺省库里第一张场景壁纸"),
      },
    },
    async ({ hidden, scene }) => textResult(pretty(await client.hostOpen({ hidden, scene }))),
  );

  tool(
    "host_close",
    {
      title: "关场景宿主",
      description: "桌面：关掉 vite 开的宿主（移除屏外 iframe 或关预览），回关前关后的主窗口状态与残留宿主数。",
      inputSchema: { handle: z.string().min(1).describe("host_open 回的句柄") },
    },
    async ({ handle }) => textResult(pretty(await client.hostClose(handle))),
  );

  tool(
    "host_eval",
    {
      title: "宿主里求值",
      description: "桌面：在场景宿主里求值（dev 探针是 window.__kabegameSceneProbe）。",
      inputSchema: {
        handle: z.string().min(1),
        expression: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ handle, expression, timeoutMs }) => {
      const result = await client.hostEval(handle, expression, timeoutMs);
      return textResult(pretty(result.value), result.value === null ? `（type: ${result.type}）` : "");
    },
  );

  const renderResult = (
    response: RenderResponse,
    options: {
      tool: string;
      imageId: string;
      save?: string;
      size?: z.infer<typeof SIZE>;
      inline?: boolean;
      /** 请求的读回画布（第 5 批）与时间线推出的窗口：结果里写明读回的是什么，没给 canvas 时按窗口提示。 */
      canvas?: [number, number];
      timelineWindow?: readonly [number, number] | null;
      /** FR 帧号块（第 6 批）：结果里写一行涂了没有。 */
      fr?: FrPlan;
      /** 逐 draw 轨迹：给了就把轨迹与读回图写进这个目录，结果里写一行摘要。 */
      trace?: TraceArg;
    },
    lead: string[] = [],
  ) =>
    imageContent(Buffer.from(response.png, "base64"), {
      root,
      tool: options.tool,
      extra: options.imageId,
      label: `渲染 ${options.imageId}`,
      save: options.save,
      size: options.size,
      inline: options.inline,
      lead: [
        ...lead,
        ...readbackLines(response.meta, options.canvas, options.timelineWindow),
        options.trace ? writeTrace(root, options.trace.save, response) : "",
        frLine(options.fr ?? null, response.meta) ?? "",
        videoLine(response.meta) ?? "",
        `像素摘要（RGBA）${response.meta.sha256}，原图 PNG 文件 sha256 ${response.pngSha256}`,
        `读回那一帧 g_Time ${response.meta.time}，g_Frametime ${response.meta.frametime}`,
        particleStatsLine(response.meta) ?? "",
      ].filter(Boolean),
      tail: [JSON.stringify(response.meta, null, 2)],
    });

  /**
   * 渲染参数：`replay` 与 `time` 互斥；`replay` 换成探针的 `particles`，时间线的逐帧光标换成探针的 `pointers`（连同 `window`，
   * 和固定的 `pointer` 互斥），并回时间线说明。读回画布 `canvas`（第 5 批）原样转，和交给探针的窗口不同时报 `[local]`；
   * `timelineWindow` 是时间线推出的窗口（不论交没交给探针），结果里按它提示 `canvas`。
   * FR 帧号块（第 6 批）：回放时缺省（`replay.fr` 不是 false）按读回帧号 N = `dts.length` 发一项 `scriptValues`（`frScriptValue`），
   * 两种回放写法都发；`fr` 是返回给结果说明用的。
   * 逐 draw 轨迹：`trace` 换成 REST 的写法（`traceRequestOf`，`save` 不发），回放与否都带。
   */
  const renderBody = (imageId: string, render: Args<typeof RENDER_FIELDS>) => {
    const { replay, trace, ...base } = render;
    const rest = { ...base, ...(trace ? { trace: traceRequestOf(trace) } : {}) };
    if (!replay) {
      return { body: { imageId, ...rest }, lines: [] as string[], timelineWindow: null, fr: null as FrPlan };
    }
    if (rest.time !== undefined) {
      throw new ToolError(
        "local",
        "replay 与 time 不能同时给：回放时读回那一帧的 g_Time 取时间线（或 particles.times）的末项，没给 times 时是 dt 累计值",
      );
    }
    const timelineCursors =
      "timeline" in replay && (replay.timeline.cursors !== undefined || replay.timeline.cursor !== undefined);
    if (timelineCursors && rest.pointer !== undefined) {
      throw new ToolError(
        "local",
        "pointer 与时间线的逐帧光标（replay.timeline 的 cursors / cursor）不能同时给：要固定光标就只给 pointer",
      );
    }
    const resolved = resolveReplay(root, replay);
    checkCanvasWindow(rest.canvas, resolved.window);
    const frame = resolved.particles.dts.length;
    const fr = frScriptValue((replay as RenderReplayArg).fr, frame);
    return {
      body: {
        imageId,
        ...rest,
        particles: resolved.particles,
        ...(resolved.pointers ? { pointers: resolved.pointers } : {}),
        ...(resolved.window ? { window: resolved.window } : {}),
        ...(fr ? { scriptValues: [fr] } : {}),
      },
      lines: resolved.lines,
      timelineWindow: resolved.timeline?.window ?? null,
      fr: (fr ? { frame } : false) as FrPlan,
    };
  };

  /** 给图片 id 开一个屏外宿主（kbScene 为这张图）跑 `run`、关掉；给了 `host` 时用已开的、不开也不关。 */
  async function withSceneHost<T>(
    imageId: string,
    host: string | undefined,
    run: (handle: string) => Promise<T>,
  ): Promise<{ value: T; hostLine: string }> {
    const started = Date.now();
    const opened = host ? null : await client.hostOpen({ hidden: true, scene: imageId });
    const handle = host ?? opened!.handle;
    let value: T;
    let closed: string;
    try {
      value = await run(handle);
    } finally {
      if (opened) {
        closed = await client.hostClose(handle).then(
          (r) => `已关宿主 ${handle}，残留宿主 ${r.previewHostsLeft}`,
          (error) => `关宿主 ${handle} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        closed = `用的是已开的宿主 ${handle}，没有关`;
      }
    }
    return {
      value: value!,
      hostLine: `宿主产物 ${opened?.entry ?? "（已开的宿主）"}；${closed!}；用时 ${seconds(started)}`,
    };
  }

  tool(
    "host_render",
    {
      title: "宿主里渲染一帧",
      description:
        "桌面：在已开的宿主里渲染某张场景一帧（dev 探针 renderFrame），回图片与元数据（meta.sha256 是 RGBA 像素摘要）。只想渲染一张用 render_scene。" +
        "replay、canvas、videoTime 同 render_scene：按 WPE 的 dt 序列确定性回放粒子后再读回（replay.fr 缺省 true，把 kbp 测试工程的 FR 帧号块涂成读回那一帧的颜色）；" +
        "给 canvas 时读回按 fill 上屏到这么大的画布；videoTime 定视频纹理的时刻；trace 同 render_scene，把这一帧的逐 draw 轨迹写进 trace.save 目录。",
      inputSchema: {
        handle: z.string().min(1),
        imageId: IMAGE_ID,
        ...RENDER_FIELDS,
        save: SAVE,
        size: SIZE,
        inline: INLINE,
      },
      annotations: READ_ONLY,
    },
    async ({ handle, imageId, save, size, inline, ...render }) => {
      const { body, lines, timelineWindow, fr } = renderBody(imageId, render);
      const response = await client.hostRender(handle, body);
      return renderResult(
        response,
        {
          tool: "host_render",
          imageId,
          save,
          size,
          inline,
          canvas: render.canvas,
          timelineWindow,
          fr,
          trace: render.trace,
        },
        lines,
      );
    },
  );

  tool(
    "projects_remove",
    {
      title: "移除测试工程",
      description:
        "桌面：按清单（projects_import 写的文件，或直接给对象）把测试工程从库里移除并删掉导入任务。只调 batch_remove_images，不删磁盘文件；" +
        "只动目录在仓库 ignore/ 之下（且在 allowPrefix 之下）的行，有一行不符就整批拒绝、库不变。",
      inputSchema: {
        manifest: z
          .record(
            z
              .object({ image: z.union([z.string(), z.number()]), task: z.string().nullable().optional() })
              .passthrough(),
          )
          .optional()
          .describe("清单 { <目录>: { image, task } }"),
        manifestFile: z.string().optional().describe("清单文件（相对路径按仓库根）"),
        allowPrefix: z.string().optional().describe("只移除这个目录之下的行，缺省 <仓库>/ignore，必须在它之内"),
      },
    },
    async ({ manifest, manifestFile, allowPrefix }) => {
      if (!!manifest === !!manifestFile) throw new ToolError("local", "manifest 与 manifestFile 给且只给一个");
      let data: unknown = manifest;
      if (manifestFile) {
        const file = resolvePath(root, manifestFile);
        try {
          data = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
          throw new ToolError("local", `读不了清单 ${file}：${(error as Error).message}`);
        }
      }
      return textResult(pretty(await client.projectsRemove(data as ProjectManifest, allowPrefix)));
    },
  );

  tool(
    "job",
    {
      title: "长任务",
      description:
        "vite 任务表：不给 id 列出全部；get 查状态 / 进度 / 结果；cancel 取消（协作式）；wait 等到结束（报 MCP 进度）；" +
        "start 起任务（kind: host-task / hash-baseline / projects-import，params 同 REST）。画面哈希与导入测试工程优先用 hash_baseline / projects_import。" +
        "任务在 vite 进程里，vite 重启会丢（报 [handle]）。",
      inputSchema: {
        action: z.enum(["list", "get", "cancel", "wait", "start"]).optional().describe("缺省：有 id 就 get，否则 list"),
        id: z.string().optional(),
        kind: z.enum(["host-task", "hash-baseline", "projects-import"]).optional().describe("start 用"),
        params: z.record(z.unknown()).optional().describe("start 用"),
      },
    },
    async ({ action, id, kind, params }, extra) => {
      const act = action ?? (id ? "get" : "list");
      if (act === "list") return textResult(pretty(await client.jobs()));
      if (act === "start") {
        if (!kind) throw new ToolError("local", "start 要给 kind");
        const record = await client.jobStart(kind as JobKind, (params ?? {}) as never);
        return textResult(`已起任务 ${record.id}（${record.kind}）`, pretty(record));
      }
      if (!id) throw new ToolError("local", `${act} 要给 id`);
      if (act === "get") return textResult(pretty(await client.job(id)));
      if (act === "cancel") return textResult(pretty(await client.jobCancel(id)));
      const record = await waitJobWithProgress(client, id, extra, (progress) => ({
        done: 0,
        message: JSON.stringify(progress),
      }));
      return textResult(pretty(record));
    },
  );

  // ------------------------------------------------------------ 封装好的工具

  tool(
    "render_scene",
    {
      title: "渲染场景一帧",
      description:
        "桌面：给图片 id，自己开一个屏外宿主（kbScene 为这张图）、渲染一帧、关掉宿主，回图片与元数据。不碰用户的预览。" +
        "给 host 时改用已开的宿主、不开也不关。宿主产物要用 --mode development 构建（要有 dev 探针）。" +
        "屏外宿主不跑帧循环：不给 replay 时画的是固定时刻的一帧，粒子是预热后的状态、不步进（starttime 为 0 的系统是空的）；看实时行为用 open_image_preview。" +
        "给 replay 时按 WPE 的 dt 序列确定性回放粒子（种子固定），再读回最后一帧，用来和 WPE 抓帧逐像素比；时间线用 { timeline: { log, track, frame } } 从 WPE 日志与 RenderDoc 轨迹组，" +
        'passes 缺省按标签里的 fps<N> 推。抓帧期间光标在动时给 timeline.cursors（"log" 按每一帧的光标复现，要 cursor=True 生成的工程），' +
        "探针第 i 帧用第 i 帧的光标、读回帧的 g_PointerPositionLast 是上一帧的，窗口和场景不同尺寸时按 fill 换到场景上；不给时光标固定为 pointer（不能同给）。" +
        "不给 canvas 时读回场景目标（场景分辨率）；给 canvas: [宽, 高] 时用产品上屏的同一份着色器按 fill 铺进这么大的画布再读回，" +
        "和 WPE 抓帧比时传抓帧窗口的尺寸（要和时间线交给探针的窗口相同），比较前不用再缩放；只改读回、不改渲染。" +
        "回放时探针不跑场景脚本，replay.fr（缺省 true）把 kbp 测试工程的 FR 帧号块涂成读回那一帧（第 N 帧，N = 回放的帧数）的颜色，" +
        "同 WPE 里它的颜色脚本，比较时不用再屏蔽 FR；不是 kbp 工程（没有挂颜色脚本的 FR）时跳过，结果里写一行涂了没有。" +
        "有视频纹理的场景用 videoTime 定视频的时刻（缺省 0，超过时长按循环取模），结果里写一行每段实际取的时刻。" +
        "给 trace: { save, readback?, maxVertices? } 时探针记下读回那一帧逐个 pass、逐个 draw 的管线、绑定、uniform（按名字解码）、顶点，" +
        "写到 save 目录的 trace.json，readback 选中的 pass 的目标另存 pass-<下标>.png / .f32，用来和 WPE 的 RenderDoc 抓帧逐 draw 对照；轨迹不进会话，结果里只有一行摘要。" +
        "工具不做比较，比较自己跑 ignore/p4 的脚本。",
      inputSchema: {
        imageId: IMAGE_ID,
        ...RENDER_FIELDS,
        host: z.string().optional().describe("用已开的宿主句柄"),
        save: SAVE,
        size: SIZE,
        inline: INLINE,
      },
      annotations: READ_ONLY,
    },
    async ({ imageId, host, save, size, inline, ...render }) => {
      const { body, lines, timelineWindow, fr } = renderBody(imageId, render);
      const { value: response, hostLine } = await withSceneHost(imageId, host, (handle) =>
        client.hostRender(handle, body),
      );
      return renderResult(
        response,
        {
          tool: "render_scene",
          imageId,
          save,
          size,
          inline,
          canvas: render.canvas,
          timelineWindow,
          fr,
          trace: render.trace,
        },
        [hostLine, ...lines],
      );
    },
  );

  tool(
    "particle_track",
    {
      title: "粒子轨迹",
      description:
        "桌面：按 WPE 的一次抓帧回放粒子模拟器（dev 探针 particleTrack：编译场景、不碰 GPU，种子固定），在 frames 输出和 RenderDoc 轨迹" +
        "（ignore/p4/tracks/rd-*.json）同格式的轨迹，写到 out（可直接交给 ignore/p4 的比较脚本，例如 cmp_track.py；工具不做比较）。" +
        "时间线从 WPE 日志与轨迹组（timeline: { log, track, frame?, gap?, cursors?, cursor?, window?, audio? }）；逐帧光标（g_PointerPosition）连同窗口尺寸、逐帧频谱（audio，P11a）交给探针，" +
        "探针按 fill 换到场景上；frames 缺省为轨迹里抓到的帧；passes 缺省按标签里的 fps<N> 推。" +
        "自己开屏外宿主、跑、关掉（同 render_scene），给 host 时用已开的。回到会话的只有摘要：每帧每系统的粒子数、位置范围，以及时间线信息。" +
        "场景的用户属性取工程缺省值（探针不收 userProperties）。结果超过 32 MB 报 413，减少 frames。",
      inputSchema: {
        imageId: IMAGE_ID,
        timeline: TIMELINE,
        frames: z
          .array(z.number().int().positive())
          .min(1)
          .optional()
          .describe("要输出的帧号（不超过 timeline 回放到的帧）；缺省为轨迹里抓到的帧，没有轨迹时是最后一帧"),
        passes: PASSES.optional().describe(
          "operator 遍数；缺省按标签里的 fps<N> 推（1–20 两遍，否则一遍），推不出就 1",
        ),
        seed: SEED.optional(),
        random: RANDOM.optional(),
        host: z.string().optional().describe("用已开的宿主句柄"),
        out: OUT,
        overwrite: OVERWRITE,
      },
    },
    async ({ imageId, timeline: source, frames, passes, seed, random, host, out, overwrite }) => {
      const abs = resolvePath(root, out);
      if (!overwrite && existsSync(abs)) throw new ToolError("local", `${abs} 已存在：换个路径，或传 overwrite: true`);
      const timeline = timelineFor(root, source);
      const wanted = frames ?? (timeline.captured.length ? timeline.captured : [timeline.frame]);
      const beyond = wanted.filter((f) => f > timeline.frame);
      if (beyond.length) {
        throw new ToolError(
          "local",
          `frames 里的第 ${frameRanges([...new Set(beyond)].sort((a, b) => a - b))} 帧超过时间线回放到的第 ${timeline.frame} 帧：把 timeline.frame 调大`,
        );
      }
      const resolvedPasses = passesFor(passes, timeline);
      const request: ParticleTrackRequest = {
        imageId,
        dts: timeline.dts,
        times: timeline.times,
        frames: wanted,
        passes: resolvedPasses.passes,
        ...(seed !== undefined ? { seed } : {}),
        ...(random ? { random } : {}),
        // 逐帧频谱（P11a）：粒子读其中的 16 段
        ...(timeline.audio ? { audio: timeline.audio.frames } : {}),
        // 逐帧光标与窗口尺寸（P5a 收尾）：探针按 fill 换到场景上
        ...cursorsFor(timeline, source),
        ...(timeline.tag ? { tag: timeline.tag } : {}),
      };
      const { value: result, hostLine } = await withSceneHost(imageId, host, (handle) =>
        client.hostParticleTrack(handle, request),
      );
      const text = `${JSON.stringify(result)}\n`;
      const file = writeOut(root, out, text, overwrite);
      const systems = new Set(result.frames.flatMap((f) => Object.keys(f.systems)));
      return textResult(
        `轨迹：${result.project}（图片 ${imageId}，标签 ${result.tag || "无"}），${result.frames.length} 帧（${frameRanges(result.frames.map((f) => f.frame))}）× ${systems.size} 个系统`,
        `已写入：${file}（${Buffer.byteLength(text)} 字节）`,
        describeTimeline(timeline),
        `${resolvedPasses.line}；seed ${seed ?? 1}${random ? `；random 顶替 ${Object.keys(random).join("、")} 号对象的 R` : ""}`,
        hostLine,
        "",
        ...summarizeTrack(result),
      );
    },
  );

  tool(
    "particle_corners",
    {
      title: "粒子四角",
      description:
        "桌面：读每个粒子四角的裁剪坐标与场景像素坐标（dev 探针 particleCorners：把粒子顶点着色器改成计算着色器、用这一帧的 uniform 跑一遍），" +
        "和 WPE 几何着色器的 gs_out 比。replay 同 render_scene（不给时是预热后的状态）；时间线带逐帧光标（cursors / cursor）时探针逐帧用，规则同 render_scene，" +
        "不带时光标固定在场景中心。结果（每层每粒子的 corners、pixels、particles）写到 out，" +
        "回到会话的是摘要：每层画不画（drawn 为 false：朝向是 NaN、渲染时不画，四角照算）、写进顶点的粒子数（拖尾去掉退化的）、前 3 个粒子的四个像素角。自己开屏外宿主、跑、关掉，给 host 时用已开的。结果超过 32 MB 报 413，用 limit 收小。",
      inputSchema: {
        imageId: IMAGE_ID,
        replay: REPLAY.optional(),
        layer: z
          .union([z.number().int().nonnegative(), z.string().min(1)])
          .optional()
          .describe("粒子层：objects 下标或对象名；缺省全部粒子层"),
        limit: z.number().int().nonnegative().optional().describe("每层只取前这么多个粒子（按槽序）；缺省全部"),
        postprocess: POSTPROCESS.optional().describe("场景后处理档位，缺省 disabled"),
        userProperties: z.record(z.unknown()).optional().describe("用户属性；缺省取库里这张图当前的用户属性"),
        wgsl: z.boolean().optional().describe("结果里带上改写后的计算着色器 WGSL（排查用）"),
        host: z.string().optional().describe("用已开的宿主句柄"),
        out: OUT,
        overwrite: OVERWRITE,
      },
    },
    async ({ imageId, replay, layer, limit, postprocess, userProperties, wgsl, host, out, overwrite }) => {
      const abs = resolvePath(root, out);
      if (!overwrite && existsSync(abs)) throw new ToolError("local", `${abs} 已存在：换个路径，或传 overwrite: true`);
      const resolved = replay ? resolveReplay(root, replay) : null;
      const request = {
        imageId,
        ...(resolved ? { particles: resolved.particles } : {}),
        ...(resolved?.pointers ? { pointers: resolved.pointers } : {}),
        ...(resolved?.window ? { window: resolved.window } : {}),
        ...(layer !== undefined ? { layer } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(postprocess ? { postprocess } : {}),
        ...(userProperties ? { userProperties } : {}),
        ...(wgsl ? { wgsl } : {}),
      };
      const { value: layers, hostLine } = await withSceneHost(imageId, host, (handle) =>
        client.hostParticleCorners(handle, request),
      );
      const text = `${JSON.stringify(layers, null, 1)}\n`;
      const file = writeOut(root, out, text, overwrite);
      return textResult(
        `四角：图片 ${imageId}，${layers.length} 个粒子层`,
        `已写入：${file}（${Buffer.byteLength(text)} 字节）`,
        ...(resolved ? resolved.lines : ["没有回放：预热后的状态（不步进）"]),
        hostLine,
        "",
        ...summarizeCorners(layers),
      );
    },
  );

  tool(
    "hash_baseline",
    {
      title: "画面哈希基线",
      description:
        "桌面：起画面哈希任务并等完成（期间报 MCP 进度），基线写到 out（格式同旧 hash-*.json）。每张场景按档位、固定时刻各渲染两次，两次不同就停。" +
        "场景用 ids 给，或用 from（旧基线文件，按 input.path 对应到库里现在的图片 id）。缺省自己开屏外宿主、结束时关掉。" +
        "10 张 × 3 档约 90 s。比两份基线用 hash_compare。",
      inputSchema: {
        ids: z.array(IMAGE_ID).min(1).optional().describe("图片 id"),
        from: z.string().optional().describe("旧基线文件（相对路径按仓库根）"),
        time: z.number().optional().describe("g_Time（秒），缺省 1.5"),
        levels: z.array(POSTPROCESS).min(1).optional().describe("档位，缺省 disabled / enabled / ultra"),
        host: z.string().optional().describe("用已开的宿主句柄"),
        out: OUT,
        overwrite: OVERWRITE,
      },
    },
    async ({ ids, from, time, levels, host, out, overwrite }, extra) => {
      if (!!ids === !!from) throw new ToolError("local", "ids 与 from 给且只给一个");
      const abs = resolvePath(root, out);
      if (!overwrite && existsSync(abs)) throw new ToolError("local", `${abs} 已存在：换个路径，或传 overwrite: true`);
      const started = Date.now();
      const params = { ids, from: from ? resolvePath(root, from) : undefined, time, levels, host };
      const record = await client.jobStart("hash-baseline", params);
      deps.log(`hash_baseline 任务 ${record.id}`);
      const done = await waitJobWithProgress(client, record.id, extra, (progress) => {
        const p = (progress ?? {}) as { done?: number; total?: number; current?: string | null };
        return {
          done: p.done ?? 0,
          total: p.total,
          message: `${p.done ?? 0}/${p.total ?? "?"}${p.current ? ` ${p.current}` : ""}`,
        };
      });
      const result = requireDone(done) as HashBaselineResult;
      const file = writeOut(root, out, `${JSON.stringify(result.baseline, null, 1)}\n`, overwrite);
      const scenes = Object.values(result.baseline.scenes);
      const cells = scenes.reduce((n, scene) => n + Object.keys(scene.levels).length, 0);
      const closed = result.baseline.closed;
      return textResult(
        result.ok
          ? `完成：${scenes.length} 张场景、${cells} 组（场景 × 档位），每组两次渲染都相同`
          : `不稳定：${result.unstable?.id} ${result.unstable?.postprocess} 两次渲染不同，已停（完成 ${cells} 组）`,
        `宿主产物 ${result.baseline.hostBuild.entry}；用时 ${seconds(started)}；任务 ${record.id}`,
        closed ? `宿主已关，残留宿主 ${closed.previewHostsLeft}` : "",
        `已写入：${file}`,
      );
    },
  );

  tool(
    "projects_import",
    {
      title: "导入测试工程",
      description:
        "桌面：把仓库 ignore/ 之下的测试工程目录导入库（wpe_recognize_dir + wpe-import 任务），等完成（期间报 MCP 进度），" +
        "清单 { <目录>: { image, task, preexisting } } 写到 out。用完用 projects_remove（manifestFile 传同一个文件）移除。",
      inputSchema: {
        dirs: z.array(z.string().min(1)).min(1).describe("测试工程目录（相对路径按仓库根），必须在 <仓库>/ignore 之下"),
        out: OUT,
        overwrite: OVERWRITE,
      },
    },
    async ({ dirs, out, overwrite }, extra) => {
      const abs = resolvePath(root, out);
      if (!overwrite && existsSync(abs)) throw new ToolError("local", `${abs} 已存在：换个路径，或传 overwrite: true`);
      const started = Date.now();
      const record = await client.jobStart("projects-import", { dirs: dirs.map((dir) => resolvePath(root, dir)) });
      deps.log(`projects_import 任务 ${record.id}`);
      const done = await waitJobWithProgress(client, record.id, extra, (progress) => {
        const p = (progress ?? {}) as { phase?: string; found?: number; total?: number; taskStatus?: string };
        return {
          done: p.found ?? 0,
          total: p.total,
          message: `${p.phase ?? ""} ${p.found ?? 0}/${p.total ?? "?"}${p.taskStatus ? ` 任务 ${p.taskStatus}` : ""}`,
        };
      });
      const manifest = requireDone(done) as ProjectManifest;
      const file = writeOut(root, out, `${JSON.stringify(manifest, null, 1)}\n`, overwrite);
      return textResult(
        `完成：导入 ${Object.keys(manifest).length} 个工程，用时 ${seconds(started)}`,
        `清单已写入：${file}`,
        pretty(manifest),
      );
    },
  );

  tool(
    "hash_compare",
    {
      title: "比两份画面哈希基线",
      description:
        "只读两个基线文件（不需要 vite），场景按 input.path 对应（重新导入后 id 会变）。算差异：每档 sha256、stable、postprocess、bloomLevels、尺寸、格式、" +
        "unsupported（按集合），输入的 sceneAssets / 用户属性 / 工程文件摘要，time。targetBytes、metadataId 变化单独列、不算差异。",
      inputSchema: {
        a: z.string().min(1).describe("基线 A（旧），相对路径按仓库根"),
        b: z.string().min(1).describe("基线 B（新），相对路径按仓库根"),
        maxDiffs: z.number().int().positive().default(100).describe("最多列多少条差异"),
      },
      annotations: READ_ONLY,
    },
    async ({ a, b, maxDiffs }) => {
      const result = compareBaselines(loadBaseline(resolvePath(root, a)), loadBaseline(resolvePath(root, b)));
      return textResult(
        formatCompare(result, maxDiffs),
        "",
        JSON.stringify({ same: result.same, cells: result.cells, pairs: result.pairs.length }),
      );
    },
  );

  tool(
    "app_log",
    {
      title: "应用日志",
      description:
        "直接读 dev 数据目录的应用日志（.kabegame/debug/data/logs/kabegame.<UTC 日期>.log，行首是本地时间），不需要 vite。" +
        "mark：记下当前位置，回标记（<UTC 日期>@<字节偏移>）；since：从标记读到最新，跨日期也能读，回下一次用的标记；" +
        "tail：某天（缺省今天 UTC）的最后若干行。grep（正则，不分大小写）与 level（最低级别）按整条日志（含续行）筛。",
      inputSchema: {
        action: z.enum(["mark", "since", "tail"]),
        mark: z.string().optional().describe("since 用：mark 回的标记"),
        grep: z.string().optional(),
        level: z.enum(LEVELS).optional(),
        maxEntries: z.number().int().positive().optional().describe("since 最多回多少条（取最后的），缺省 300"),
        date: z.string().optional().describe("tail 用：UTC 日期 YYYY-MM-DD"),
        lines: z.number().int().positive().default(200).describe("tail 用：最后多少行（带筛选时是最多多少条）"),
      },
      annotations: READ_ONLY,
    },
    async ({ action, mark, grep, level, maxEntries, date, lines }) => {
      if (action === "mark") {
        const now = markNow(deps.logDir);
        return textResult(
          `标记：${formatMark(now)}`,
          `文件 ${now.file}${now.offset ? `（当前 ${now.offset} 字节）` : "（还不存在，偏移 0）"}`,
        );
      }
      if (action === "since") {
        if (!mark) throw new ToolError("local", "since 要给 mark（app_log mark 的返回值）");
        let parsed;
        try {
          parsed = parseMark(mark);
        } catch (error) {
          throw new ToolError("local", (error as Error).message);
        }
        const read = readSince(deps.logDir, parsed, { grep, level, maxEntries });
        const files = read.files.map((f) => `${f.date} ${f.from}–${f.to}${f.reset ? "（文件变短，从头读）" : ""}`);
        return textResult(
          `从 ${mark} 读到 ${formatMark(read.next)}：${read.total} 条，匹配 ${read.matched} 条` +
            (read.dropped ? `，只回最后 ${read.entries.length} 条` : ""),
          `下一次 since 用：${formatMark(read.next)}`,
          files.length ? `文件：${files.join("；")}` : "（标记之后没有日志文件）",
          "",
          ...read.entries,
        );
      }
      const read = readTail(deps.logDir, { date, lines, grep, level, maxEntries });
      return textResult(
        `${read.file}：${grep || level ? `匹配 ${read.matched} 条，回最后 ${read.entries.length} 条` : `最后 ${read.entries.length} 条`}`,
        "",
        ...read.entries,
      );
    },
  );
}
