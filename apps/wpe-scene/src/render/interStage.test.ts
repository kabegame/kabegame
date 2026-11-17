import { describe, expect, it } from "vitest";
import type { TranslateResult } from "../wpesl2wgsl";
import { SceneRenderError } from "./errors";
import { createProgram } from "./programs";

/** 只够 `createProgram` 走完的假设备：模块没有编译消息，布局对象原样返回。 */
function fakeDevice(maxInterStageShaderVariables?: number): GPUDevice {
  return {
    limits: maxInterStageShaderVariables === undefined ? {} : { maxInterStageShaderVariables },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (descriptor: unknown) => descriptor,
    createPipelineLayout: (descriptor: unknown) => descriptor,
  } as unknown as GPUDevice;
}

function result(interStageLocations?: number): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: "@vertex fn main() {}", entryPoint: "main" },
    fragment: { wgsl: "@fragment fn main() {}", entryPoint: "main" },
    ...(interStageLocations === undefined ? {} : { interStageLocations }),
  } as TranslateResult;
}

describe("阶段间变量的设备上限（P7 补漏）", () => {
  it("超过设备申请到的上限时报 render:program:<下标>:inter-stage:<个数>", async () => {
    const error = await createProgram(fakeDevice(16), result(18), 3, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SceneRenderError);
    expect((error as SceneRenderError).reasons).toEqual(["render:program:3:inter-stage:18"]);
  });

  it("设备上限够、刚好等于、没有 varying 时照常建", async () => {
    await expect(createProgram(fakeDevice(28), result(18), 0, [])).resolves.toBeTruthy();
    await expect(createProgram(fakeDevice(16), result(16), 0, [])).resolves.toBeTruthy();
    await expect(createProgram(fakeDevice(16), result(), 0, [])).resolves.toBeTruthy();
  });

  it("设备没报这个上限时按 WebGPU 缺省的 16 判断", async () => {
    await expect(createProgram(fakeDevice(), result(17), 0, [])).rejects.toBeInstanceOf(SceneRenderError);
    await expect(createProgram(fakeDevice(), result(16), 0, [])).resolves.toBeTruthy();
  });
});
