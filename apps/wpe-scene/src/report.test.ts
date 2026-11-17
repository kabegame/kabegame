import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn((_command: string, _args: unknown) => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createReporter } from "./report";

/** 发给 `wpe_scene_report` 的 unsupported 上报 */
function unsupportedReports() {
  return invoke.mock.calls
    .map(([, args]) => (args as { report: { kind: string } }).report)
    .filter((report) => report.kind === "unsupported");
}

describe("createReporter().unsupported", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    invoke.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("location", { search: "?kbScene=img-42&kbInstance=7" });
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it("同一个实例里同一个键只报一次；新键照报，一次调用里的重复键只算一次", () => {
    const report = createReporter("7");
    report.unsupported?.(["particle:renderers", "text:engine"]);
    report.unsupported?.(["particle:renderers"]);
    report.unsupported?.(["text:engine", "fog:group", "fog:group"]);
    expect(unsupportedReports()).toEqual([
      { kind: "unsupported", instance: "7", image: "img-42", keys: ["particle:renderers", "text:engine"] },
      { kind: "unsupported", instance: "7", image: "img-42", keys: ["fog:group"] },
    ]);
    // 只经 unsupported 上报，不另发一条 log（Rust 自己记 warn）
    expect(invoke.mock.calls.every(([command]) => command === "wpe_scene_report")).toBe(true);
    expect(invoke.mock.calls).toHaveLength(2);
  });

  it("warn 日志列出本次要报的全部键；全部报过时不记也不发", () => {
    const report = createReporter("7");
    report.unsupported?.(["a:1", "b:2", "c:3"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    for (const key of ["a:1", "b:2", "c:3"]) expect(line).toContain(key);
    report.unsupported?.(["c:3", "a:1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(unsupportedReports()).toHaveLength(1);
  });

  it("不同实例各自去重", () => {
    createReporter("1").unsupported?.(["k"]);
    createReporter("2").unsupported?.(["k"]);
    expect(unsupportedReports().map((report) => (report as { instance?: string }).instance)).toEqual(["1", "2"]);
  });

  it("image 取宿主地址的 kbScene，取不到给空串", () => {
    vi.stubGlobal("location", { search: "?kbInstance=3" });
    createReporter("3").unsupported?.(["k"]);
    vi.unstubAllGlobals();
    // node 环境本来没有 location
    createReporter("4").unsupported?.(["k"]);
    expect(unsupportedReports().map((report) => (report as { image?: string }).image)).toEqual(["", ""]);
  });
});
