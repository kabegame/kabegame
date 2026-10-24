import { describe, expect, it } from "vitest";
import { normalizeTaskEvent, normalizeTaskRow, taskSearchPath } from "./tasks";

function rawTask(id: string, overrides: Record<string, unknown> = {}) {
  return { id, plugin_id: "plugin/a", status: "running", progress: 10, start_time: 100, ...overrides };
}

describe("任务 PathQL 服务", () => {
  it("为插件精确命中与文本搜索生成编码后的 ~any 路径", () => {
    expect(taskSearchPath("作者 / 标签", ["plugin/a", "plugin/a", "空 格"])).toBe(
      "~any/plugin/plugin\\/a/~or/plugin/空 格/~or/plugin_search/作者 \\/ 标签/~end/",
    );
    expect(taskSearchPath("  ", ["plugin/a"])).toBe("");
  });

  it("把 PathQL 的 JSON 字符串列与 SQLite 0/1 规范化为任务行", () => {
    expect(
      normalizeTaskRow(
        rawTask("task-1", {
          user_config: '{"page":2}',
          http_headers: '{"authorization":"token"}',
          is_dry_run: 1,
          max_concurrent_downloads: null,
          run_config_name: "每日抓取",
        }),
      ),
    ).toMatchObject({
      id: "task-1",
      pluginId: "plugin/a",
      userConfig: { page: 2 },
      httpHeaders: { authorization: "token" },
      isDryRun: true,
      maxConcurrentDownloads: null,
      runConfigName: "每日抓取",
    });
  });

  it.each([null, undefined, {}, { id: "missing-plugin" }])("空行或无效行 %j 返回 null", (row) => {
    expect(normalizeTaskRow(row)).toBeNull();
  });

  it("统一任务事件的 id 与 diff 字段，供观察方过滤器和补丁共用", () => {
    expect(normalizeTaskEvent({ type: "TaskAdded", task: { id: "t" } })).toEqual({
      type: "TaskAdded",
      task: { id: "t" },
    });
    expect(normalizeTaskEvent({ type: "TaskDeleted", task_id: "t" })).toEqual({
      type: "TaskDeleted",
      taskId: "t",
    });
    expect(
      normalizeTaskEvent({
        type: "TaskChanged",
        task_id: "t",
        diff: { start_time: 0, end_time: 20, success_count: 3, failed_count: 1, status: "completed", progress: 100 },
      }),
    ).toEqual({
      type: "TaskChanged",
      taskId: "t",
      diff: { startTime: 0, endTime: 20, successCount: 3, failedCount: 1, status: "completed", progress: 100 },
    });
  });

  it.each([null, {}, { type: "TaskChanged" }, { type: "other", taskId: "t" }])("忽略无效事件 %j", (payload) => {
    expect(normalizeTaskEvent(payload)).toBeNull();
  });
});
