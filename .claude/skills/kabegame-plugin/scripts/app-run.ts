/**
 * 在正在运行的 dev app 里跑插件任务（WebView 插件唯一的验证途径；V8 插件也可用）。
 *
 *   deno run -A .claude/skills/kabegame-plugin/scripts/app-run.ts <plugin-id> '<userConfig JSON>' [--secs N] [--out DIR]
 *
 * 经 kabegame-dev 的 REST（`apps/kabegame-dev-mcp/src/client.ts` 的 `invoke`，背后是 vite 持有的 CDP 连接）调 Tauri 命令：
 * refresh_plugins → start_task → 每 3 秒轮询 get_task → 超时 cancel_task → get_task / get_task_logs 出摘要。
 * 需要用户自己先跑 `deno task dev -c kabegame`。任务运行期间可以用 kabegame-dev MCP 的 `targets` 找到 crawler-<taskId>
 * 窗口，再 `screenshot` / `eval`（target 写 `url:crawler`）看 WebView 页面当下的真实 DOM。
 *
 * 参数与输出格式同原来的 bash 版：一行 `▶ task …`，结束后一行 `── 摘要 …`，再是两格缩进的 JSON 摘要。
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createClient } from "../../../../apps/kabegame-dev-mcp/src/client.ts";
import type { KabegameDevClient } from "../../../../apps/kabegame-dev-mcp/src/client.ts";

const USAGE = "用法: app-run.ts <plugin-id> '<userConfig JSON>' [--secs N] [--out DIR]";
const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled"]);
const POLL_SECS = 3;

export interface AppRunArgs {
  id: string;
  config: Record<string, unknown>;
  secs: number;
  out: string;
}

export class UsageError extends Error {}

/** 参数同原来的 bash 版：插件 id 必填，userConfig 缺省 `{}`，`--secs` 缺省 90，`--out` 缺省 `$TMPDIR/kb-plugin-test/<id>-app`。 */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): AppRunArgs {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("--")) throw new UsageError(USAGE);
  let configText = "{}";
  if (rest.length && !rest[0].startsWith("--")) configText = rest.shift()!;
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    throw new UsageError(`userConfig 不是合法 JSON：${(error as Error).message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new UsageError("userConfig 要是 JSON 对象");
  let secs = 90;
  let out = path.join(env.TMPDIR || os.tmpdir(), "kb-plugin-test", `${id}-app`);
  while (rest.length) {
    const flag = rest.shift()!;
    if (flag === "--secs" || flag === "--out") {
      const value = rest.shift();
      if (value === undefined) throw new UsageError(`${flag} 要带值`);
      if (flag === "--secs") {
        secs = Number(value);
        if (!Number.isFinite(secs) || secs <= 0) throw new UsageError(`--secs 要是正数，收到 ${value}`);
      } else {
        out = path.resolve(value);
      }
    } else {
      throw new UsageError(`未知参数 ${flag}`);
    }
  }
  return { id, config: config as Record<string, unknown>, secs, out };
}

interface TaskRow {
  status?: string;
  successCount?: number;
  dedupCount?: number;
  failedCount?: number;
  progress?: unknown;
  error?: string | null;
}

interface LogRow {
  level?: string;
  content?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 摘要，字段与顺序同原来的 bash 版。 */
export function summarize(task: TaskRow, raw: unknown) {
  const logs: LogRow[] = Array.isArray(raw) ? raw : ((raw as { logs?: LogRow[] })?.logs ?? []);
  const key = (content: string) => {
    const match = content.match(/"k":"([A-Za-z]+)"/);
    return match ? `i18n:${match[1]}` : content.slice(0, 90);
  };
  const problems: Record<string, number> = {};
  for (const log of logs.filter((l) => l.level === "warn" || l.level === "error")) {
    const k = `${log.level} ${key(String(log.content ?? ""))}`;
    problems[k] = (problems[k] ?? 0) + 1;
  }
  return {
    status: task.status,
    新下载: task.successCount,
    去重跳过: task.dedupCount,
    失败: task.failedCount,
    进度: task.progress,
    错误: task.error || null,
    问题分类: problems,
    最后日志: logs
      .filter((l) => l.level === "print" || l.level === "info")
      .slice(-6)
      .map((l) => String(l.content ?? "").slice(0, 160)),
  };
}

export async function run(args: AppRunArgs, dev: KabegameDevClient = createClient()): Promise<number> {
  try {
    const health = await dev.health();
    if ("error" in health.cdp) throw new Error(`CDP 不在：${health.cdp.error}`);
  } catch (error) {
    console.error("✗ 没连上 dev app。请用户先跑：deno task dev -c kabegame");
    console.error(`  （${reason(error)}）`);
    return 1;
  }
  mkdirSync(args.out, { recursive: true });

  let task: string;
  try {
    await dev.invoke("refresh_plugins");
    const started = await dev.invoke<unknown>("start_task", {
      task: { pluginId: args.id, outputDir: args.out, userConfig: args.config },
    });
    task = typeof started === "string" ? started : String((started as { id?: unknown })?.id ?? "");
    if (!task || task === "null") throw new Error(`start_task 回了 ${JSON.stringify(started)}`);
  } catch (error) {
    console.error("✗ start_task 失败（插件未投放？userConfig 非法 JSON？）");
    console.error(`  （${reason(error)}）`);
    return 1;
  }
  console.log(`▶ task ${task}（限时 ${args.secs}s，输出 ${args.out}）`);

  let status = "running";
  for (let t = 0; t < args.secs; t += POLL_SECS) {
    await sleep(POLL_SECS * 1000);
    // 轮询失败（vite 热重载等）就下一轮再试，同原脚本
    const row = await dev.invoke<TaskRow | null>("get_task", { taskId: task }).catch(() => null);
    if (row?.status) status = row.status;
    if (TERMINAL.has(status)) break;
  }
  let stopped = "自行结束";
  if (!TERMINAL.has(status)) {
    stopped = `限时 ${args.secs}s 到，已取消`;
    await dev
      .invoke("cancel_task", { taskId: task })
      .catch((error) => console.error(`  cancel_task 失败：${reason(error)}`));
    await sleep(2000);
  }

  console.log(`── 摘要 (${args.id}, app) ── 运行：${stopped}`);
  try {
    const row = await dev.invoke<TaskRow | null>("get_task", { taskId: task });
    if (!row) throw new Error(`get_task 查不到 ${task}`);
    const logs = await dev.invoke<unknown>("get_task_logs", { taskId: task });
    console.log(JSON.stringify(summarize(row, logs), null, 2));
  } catch (error) {
    console.error(`✗ 取摘要失败：${reason(error)}`);
    return 1;
  }
  return 0;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  let args: AppRunArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exit(2);
  }
  process.exit(await run(args!));
}
