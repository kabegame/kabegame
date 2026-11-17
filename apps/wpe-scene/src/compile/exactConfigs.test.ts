/**
 * 活的场景图 L5 点 2：会话的 `exactConfigs`（原文经规整无损的对象下标）。有 / 无 8 位舍入的对象各一个；脚本覆盖、删掉的对象不算；
 * `opened` 消息带回同一份，bundle 里没有这一项（编译产物摘要不变）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, losslessConfig, openCompileSession } from "./bundle";
import { createWorkerHandler } from "./workerHandler";
import type { OpenRequest, WorkerResponse } from "./protocol";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const OBJECTS: Record<string, unknown>[] = [
  // 0：数都是整数或 8 位以内，无损
  { id: 10, name: "exact", image: "models/a.json", origin: "1 2 0", alpha: 0.5 },
  // 1：0.123456789123 规整后是 0.12345679，有损
  { id: 11, name: "lossy", image: "models/a.json", origin: "1 2 0", alpha: 0.123456789123 },
  // 2：无损，但下面的用例给它脚本覆盖
  { id: 12, name: "overridden", image: "models/a.json", origin: "3 4 0" },
  // 3：无损，但下面的用例删掉它
  { id: 13, name: "destroyed", image: "models/a.json", origin: "5 6 0" },
];

const files: Record<string, unknown> = {
  "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
  "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: OBJECTS },
  "P:/p/models/a.json": { material: "materials/a.json", width: 4, height: 4 },
  "P:/p/materials/a.json": { passes: [{ shader: "base" }] },
  "P:/p/shaders/base.vert": "// base",
  "P:/p/shaders/base.frag": "// base",
};

function bytesOf(path: string): Uint8Array {
  const value = files[path.replace(/\\/g, "/")];
  if (value === undefined) throw new TypeError("Failed to fetch");
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}
const reader = {
  readWhole: async (path: string) => bytesOf(path),
  readRange: async (path: string, start: number, end: number) => bytesOf(path).slice(start, end),
};
const translator = {
  memoryBytes: 1,
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] };
  },
} as unknown as Wpesl2wgsl;

const base = {
  projectDir: "P:/p",
  sceneAssets: [],
  reader,
  translator,
  postprocess: "disabled" as const,
  reflection: "disabled" as const,
  force: true,
  exhaustive: true,
};

async function exactOf(extra: Partial<Parameters<typeof openCompileSession>[0]> = {}): Promise<number[]> {
  const session = await openCompileSession({ ...base, ...extra });
  for (let index = 0; index < session.objectCount; index++) await session.compileObject(index);
  await session.finalize();
  return session.exactConfigs();
}

describe("losslessConfig", () => {
  it("整数、非有限数、8 位以内的非整数无损；多于 8 位有效数字的有损；数组与嵌套对象逐项看", () => {
    expect(losslessConfig({ a: 1, b: 0.5, c: "0.123456789123", d: [1, 2.25], e: { f: 123456789012 } })).toBe(true);
    expect(losslessConfig({ a: 0.123456789123 })).toBe(false);
    expect(losslessConfig([{ a: [0.1, 1 / 3] }])).toBe(false);
    expect(losslessConfig({ a: 1e21, b: null, c: true })).toBe(true);
  });
});

describe("SceneCompileSession.exactConfigs（L5）", () => {
  it("有 8 位舍入的对象不算，没有的算", async () => {
    expect(await exactOf()).toEqual([0, 2, 3]);
  });

  it("脚本覆盖落在某个对象上、对象被删：不算", async () => {
    expect(
      await exactOf({
        scriptOverrides: { "objects/2/size": [8, 8] },
        structure: { destroyed: [3], parents: [], created: [] },
      }),
    ).toEqual([0]);
  });

  it("运行中新建的对象（structure.created）按它的配置原文判", async () => {
    const created = [
      { object: 4, config: JSON.stringify({ id: 20, image: "models/a.json", alpha: 0.25 }) },
      { object: 5, config: JSON.stringify({ id: 21, image: "models/a.json", alpha: 0.987654321987 }) },
    ];
    expect(await exactOf({ structure: { destroyed: [], parents: [], created } })).toEqual([0, 2, 3, 4]);
  });

  it("opened 消息带回 exactConfigs，bundle 里没有这一项、和 compileScene 的产物相同", async () => {
    const events: WorkerResponse[] = [];
    const handler = createWorkerHandler(
      (message) => {
        events.push(message);
        if (message.type === "file")
          setTimeout(() => {
            const all = bytesOf(message.path);
            void handler({
              type: "file-result",
              id: message.id,
              bytes: message.operation === "whole" ? all : all.slice(message.start, message.end),
            });
          }, 0);
      },
      { loadTranslator: async () => translator },
    );
    const open: OpenRequest = {
      projectDir: "P:/p",
      sceneAssets: [],
      userProperties: {},
      scriptOverrides: {},
      structure: { destroyed: [], parents: [], created: [] },
      postprocess: "disabled",
      reflection: "disabled",
      shadows: "follow",
      volumetrics: "follow",
      force: true,
      exhaustive: true,
      module: null,
    };
    await handler({ type: "open", ...open });
    const opened = events.find((event) => event.type === "opened") as Extract<WorkerResponse, { type: "opened" }>;
    expect(opened.exactConfigs).toEqual([0, 2, 3]);
    expect("exactConfigs" in opened.bundle).toBe(false);
    const whole = await compileScene({ ...base, shadows: "follow", volumetrics: "follow" });
    expect(JSON.stringify(Object.keys(opened.bundle).sort())).toBe(JSON.stringify(Object.keys(whole).sort()));
  });
});
