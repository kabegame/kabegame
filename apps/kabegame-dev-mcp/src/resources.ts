/**
 * kabegame-dev MCP 的资源：
 * - `kabegame-dev://health`：两层探活结果（同 `status` 工具，vite 不在也能读）；
 * - `kabegame-dev://targets`：CDP 目标列表；
 * - `kabegame-dev://jobs`、`kabegame-dev://jobs/{id}`：vite 任务表；
 * - `kabegame-dev://app-log/{date}`：某天（UTC）应用日志的最后 2000 行，直接读文件，不需要 vite。
 *
 * 需要 vite 的资源在 vite / CDP 不在时读取失败，错误文本同工具，以 `[层]` 开头。
 */
import { ResourceTemplate } from "./sdk.ts";
import type { McpServer, ReadResourceResult } from "./sdk.ts";
import { assertDate, listLogDates, logFileFor, readTailLines } from "./appLog.ts";
import { probeStatus } from "./status.ts";
import { describeError } from "./tools.ts";
import type { DevMcpDeps } from "./tools.ts";

export const APP_LOG_TAIL_LINES = 2000;

const JSON_TYPE = "application/json";

const jsonContents = (uri: URL, value: unknown): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: JSON_TYPE, text: JSON.stringify(value, null, 2) }],
});

const single = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? "";

/** 读失败时抛带层级的错误（SDK 转成 JSON-RPC 错误）。 */
async function layered<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new Error(describeError(error));
  }
}

export function registerResources(server: McpServer, deps: DevMcpDeps): void {
  const { client } = deps;
  const viteUrl = client.baseUrl.replace(/\/__kabegame_dev$/, "");

  server.registerResource(
    "health",
    "kabegame-dev://health",
    {
      title: "两层探活",
      description: "vite 在不在；经 vite 问 CDP 在不在。同 status 工具。",
      mimeType: JSON_TYPE,
    },
    async (uri) => jsonContents(uri, await probeStatus(client, viteUrl)),
  );

  server.registerResource(
    "targets",
    "kabegame-dev://targets",
    { title: "CDP 目标", description: "page 与 iframe 目标（URL、类型、父目标、角色）。", mimeType: JSON_TYPE },
    async (uri) => jsonContents(uri, await layered(() => client.targets())),
  );

  server.registerResource(
    "jobs",
    "kabegame-dev://jobs",
    { title: "长任务", description: "vite 任务表（最近结束的留 20 个）。", mimeType: JSON_TYPE },
    async (uri) => jsonContents(uri, await layered(() => client.jobs())),
  );

  server.registerResource(
    "job",
    new ResourceTemplate("kabegame-dev://jobs/{id}", {
      list: async () => {
        try {
          const jobs = await client.jobs();
          return {
            resources: jobs.map((job) => ({
              uri: `kabegame-dev://jobs/${job.id}`,
              name: `${job.kind} ${job.id}（${job.status}）`,
              mimeType: JSON_TYPE,
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: "某个长任务", description: "状态、进度、结果。", mimeType: JSON_TYPE },
    async (uri, variables) => jsonContents(uri, await layered(() => client.job(single(variables.id)))),
  );

  server.registerResource(
    "app-log",
    new ResourceTemplate("kabegame-dev://app-log/{date}", {
      list: () => ({
        resources: listLogDates(deps.logDir)
          .reverse()
          .map((date) => ({ uri: `kabegame-dev://app-log/${date}`, name: `应用日志 ${date}`, mimeType: "text/plain" })),
      }),
    }),
    {
      title: "应用日志",
      description: `某天（文件名的 UTC 日期，YYYY-MM-DD）应用日志的最后 ${APP_LOG_TAIL_LINES} 行；行首是本地时间。不需要 vite。`,
      mimeType: "text/plain",
    },
    (uri, variables) => {
      const date = assertDate(single(variables.date));
      const file = logFileFor(deps.logDir, date);
      const lines = readTailLines(file, APP_LOG_TAIL_LINES);
      if (!lines.length && !listLogDates(deps.logDir).includes(date)) throw new Error(`没有这天的日志：${file}`);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") }] };
    },
  );
}
