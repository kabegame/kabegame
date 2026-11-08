/**
 * kabegame-dev MCP 的工具，分三类：
 * - 探活 `status`：两层，vite 在不在；经 vite 问 CDP 在不在；
 * - vite 能力的一对一工具：`targets`、`eval`、`screenshot`……（只经 `client.ts` 调 REST，不另发请求）；
 * - 封装好的工具：`render_scene`、`hash_baseline`、`projects_import`（几次 REST 拼成一步，长任务等完成并报 MCP 进度），
 *   以及不需要 vite 的 `hash_compare`、`app_log`。
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
  PreviewInfo,
  ProjectManifest,
  RenderResponse,
  ShowWindowResult,
  WindowFrontState,
} from "./client.ts";
import { DEFAULT_MAX_EDGE, TEMP_SAVE, imageOutput } from "./imageOutput.ts";
import type { ImageOutputOptions } from "./imageOutput.ts";
import { LEVELS, formatMark, markNow, parseMark, readSince, readTail } from "./appLog.ts";
import { compareBaselines, formatCompare, loadBaseline } from "./hashCompare.ts";
import { formatStatus, probeStatus } from "./status.ts";

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
const RENDER_FIELDS = {
  time: z.number().optional().describe("g_Time（秒），缺省 1.5（同画面哈希基线）"),
  postprocess: POSTPROCESS.optional().describe("场景后处理档位，缺省 disabled"),
  userProperties: z.record(z.unknown()).optional().describe("用户属性；缺省取库里这张图当前的用户属性"),
  pointer: z.tuple([z.number(), z.number()]).optional().describe("指针位置（场景坐标）"),
};
const OUT = z.string().describe("结果写到这个文件（相对路径按仓库根）");
const OVERWRITE = z.boolean().default(false).describe("out 已存在时是否覆盖，缺省拒绝");

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

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
        "当前壁纸、模式、暂停、启用、场景后处理、过渡、样式、轮播、路由、现有场景宿主。验收前后各取一次核对不留痕迹。",
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
    options: { tool: string; imageId: string; save?: string; size?: z.infer<typeof SIZE>; inline?: boolean },
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
      lead: [...lead, `像素摘要（RGBA）${response.meta.sha256}，原图 PNG 文件 sha256 ${response.pngSha256}`],
      tail: [JSON.stringify(response.meta, null, 2)],
    });

  tool(
    "host_render",
    {
      title: "宿主里渲染一帧",
      description:
        "桌面：在已开的宿主里渲染某张场景一帧（dev 探针 renderFrame），回图片与元数据（meta.sha256 是 RGBA 像素摘要）。只想渲染一张用 render_scene。",
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
      const response = await client.hostRender(handle, { imageId, ...render });
      return renderResult(response, { tool: "host_render", imageId, save, size, inline });
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
        "屏外宿主不跑帧循环：画的是固定时刻的一帧，粒子是预热后的状态、不步进（starttime 为 0 的系统是空的）；看实时行为用 open_image_preview。",
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
      const started = Date.now();
      const opened = host ? null : await client.hostOpen({ hidden: true, scene: imageId });
      const handle = host ?? opened!.handle;
      let response: RenderResponse;
      let closed: string;
      try {
        response = await client.hostRender(handle, { imageId, ...render });
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
      return renderResult(response, { tool: "render_scene", imageId, save, size, inline }, [
        `宿主产物 ${opened?.entry ?? "（已开的宿主）"}；${closed!}；用时 ${seconds(started)}`,
      ]);
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
