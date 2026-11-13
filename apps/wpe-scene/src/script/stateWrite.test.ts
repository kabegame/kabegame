/**
 * 宿主与 dev 探针共用的脚本写回（kabegame-chromium 第 7 批，`stateWrite.ts`）：三种结果、文本字段走 `writeText`、值的换算同
 * `scriptWriteValue`，读取对每一种目标的形状（有值 / 没值），以及重编译类写入「值变了才算」。宿主一侧的行为由 `host.script.test.ts` 锁住。
 */
import { describe, expect, it, vi } from "vitest";
import { FLT_MAX } from "../compile/particles";
import type { SceneState } from "../render/state";
import type { ScriptTarget } from "./runtime";
import { compiledRecompileValue, readScriptState, recordRecompileWrite, writeScriptState } from "./stateWrite";

describe("writeScriptState", () => {
  it("写不进的目标返回 unsupported、重编译目标返回 recompile，都不碰状态", () => {
    const state = { write: vi.fn(), writeText: vi.fn() };
    const targets: [ScriptTarget, string][] = [
      [{ kind: "unsupported", path: "objects/0/foo" }, "unsupported"],
      [{ kind: "script-property", script: "s", key: "k" }, "unsupported"],
      [{ kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" }, "recompile"],
    ];
    for (const [target, expected] of targets) expect(writeScriptState(state, target, true)).toBe(expected);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.writeText).not.toHaveBeenCalled();
  });

  it("文本字段按脚本侧规则规整后 writeText（数 ToString），其余经 write，值按 scriptWriteValue 换算，结果原样返回", () => {
    const state = {
      write: vi.fn((): "applied" | "recompile" => "applied"),
      writeText: vi.fn(),
    };
    expect(writeScriptState(state, { kind: "text", object: 3, field: "text" }, [12])).toBe("applied");
    expect(state.writeText).toHaveBeenCalledWith(3, "text", "12");
    writeScriptState(state, { kind: "layer", object: 0, field: "color" }, [0.25, 0.5, 1]);
    writeScriptState(state, { kind: "layer", object: 0, field: "alpha" }, [0.75]);
    expect(state.write.mock.calls).toEqual([
      [{ property: "", target: { kind: "layer", object: 0, field: "color" } }, "0.25 0.5 1"],
      [{ property: "", target: { kind: "layer", object: 0, field: "alpha" } }, 0.75],
    ]);
    state.write.mockReturnValueOnce("recompile");
    expect(writeScriptState(state, { kind: "effect", object: 0, effect: 1 }, true)).toBe("recompile");
  });
});

describe("readScriptState", () => {
  /**
   * 只有 `readScriptState` 读到的那几项的假状态：objects 0 图层、3 声音、4 相机、5 文本、6 / 7 粒子层（6 没设过 colorn 与控制点角度，
   * 7 设过 colorn 与第 1 个控制点角度），effect 只有 0/2 开着。
   */
  function fakeState(): SceneState {
    return {
      layers: new Map([[0, { origin: [1, 2, 3], alpha: 0.5, visible: false }]]),
      effectEnabled: (object: number, effect: number) => object === 0 && effect === 2,
      constants: new Map([["objects/0/passes/0", { u_amount: [0.25], u_offset: [1, 2] }]]),
      bloom: { strength: 2, tint: [1, 0.5, 0.25] },
      bloomEnabled: true,
      general: { fov: 60, clearcolor: [0.1, 0.2, 0.3], camerashake: true },
      sounds: new Map([[3, { volume: 0.75 }]]),
      cameras: new Map([[4, { fov: 30, zoom: 2 }]]),
      textFields: new Map([[5, { text: "12:34", pointsize: 48, padding: [1, 2], limitwidth: true }]]),
      particleInstances: new Map([
        [6, { alpha: 0.5, rate: 3, colorn: null, controlpoints: [[1, 2, 3]], controlpointAngles: [] }],
        [
          7,
          {
            alpha: 1,
            rate: 1,
            colorn: [0.1, 0.2, 0.3],
            controlpoints: [],
            controlpointAngles: [undefined, [0.5, 0, 0]],
          },
        ],
      ]),
    } as unknown as SceneState;
  }
  const constant = (pass: string, uniform: string): ScriptTarget => ({
    kind: "constant",
    pass,
    material: "amount",
    uniforms: [uniform],
    type: "float",
  });

  it("图层字段：数字铺成一项、向量原样、布尔原样；对象或字段没有时为 null", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "layer", object: 0, field: "origin" })).toEqual([1, 2, 3]);
    expect(readScriptState(state, { kind: "layer", object: 0, field: "alpha" })).toEqual([0.5]);
    expect(readScriptState(state, { kind: "layer", object: 0, field: "visible" })).toBe(false);
    expect(readScriptState(state, { kind: "layer", object: 0, field: "brightness" })).toBeNull();
    expect(readScriptState(state, { kind: "layer", object: 9, field: "origin" })).toBeNull();
  });

  it("effect 开关按 scene.json 坐标读；材质常量取第一格的值，pass 或格没有时为 null", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "effect", object: 0, effect: 2 })).toBe(true);
    expect(readScriptState(state, { kind: "effect", object: 0, effect: 1 })).toBe(false);
    expect(readScriptState(state, constant("objects/0/passes/0", "u_amount"))).toEqual([0.25]);
    expect(readScriptState(state, constant("objects/0/passes/0", "u_offset"))).toEqual([1, 2]);
    expect(readScriptState(state, constant("objects/0/passes/0", "u_missing"))).toBeNull();
    expect(readScriptState(state, constant("objects/9/passes/0", "u_amount"))).toBeNull();
  });

  it("泛光参数（数字铺成一项、tint 原样）、泛光开关、general 字段（数字铺成一项、向量与布尔原样）", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "bloom", field: "strength" })).toEqual([2]);
    expect(readScriptState(state, { kind: "bloom", field: "tint" })).toEqual([1, 0.5, 0.25]);
    expect(readScriptState(state, { kind: "bloom-enabled" })).toBe(true);
    expect(readScriptState(state, { kind: "general", key: "fov" })).toEqual([60]);
    expect(readScriptState(state, { kind: "general", key: "clearcolor" })).toEqual([0.1, 0.2, 0.3]);
    expect(readScriptState(state, { kind: "general", key: "camerashake" })).toBe(true);
  });

  it("声音的 volume 与相机对象的 fov / zoom：有值铺成一项，对象没有时为 null", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "sound", object: 3, field: "volume" })).toEqual([0.75]);
    expect(readScriptState(state, { kind: "sound", object: 9, field: "volume" })).toBeNull();
    expect(readScriptState(state, { kind: "camera", object: 4, field: "fov" })).toEqual([30]);
    expect(readScriptState(state, { kind: "camera", object: 4, field: "zoom" })).toEqual([2]);
    expect(readScriptState(state, { kind: "camera", object: 9, field: "fov" })).toBeNull();
  });

  it("文本字段：字符串与布尔原样、数字铺成一项、向量拷一份；对象没有时为 null", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "text", object: 5, field: "text" })).toBe("12:34");
    expect(readScriptState(state, { kind: "text", object: 5, field: "pointsize" })).toEqual([48]);
    expect(readScriptState(state, { kind: "text", object: 5, field: "limitwidth" })).toBe(true);
    const padding = readScriptState(state, { kind: "text", object: 5, field: "padding" });
    expect(padding).toEqual([1, 2]);
    expect(padding).not.toBe(state.textFields.get(5)!.padding);
    expect(readScriptState(state, { kind: "text", object: 9, field: "text" })).toBeNull();
  });

  it("粒子实例覆盖：系数铺成一项；colorn 没设过为 (−1, −1, −1)、设过拷一份；控制点没设过为 (FLT_MAX, 0, 0)；对象没有时为 null", () => {
    const state = fakeState();
    const instance = (object: number, field: string): ScriptTarget =>
      ({ kind: "particle-instance", object, field }) as ScriptTarget;
    expect(readScriptState(state, instance(6, "alpha"))).toEqual([0.5]);
    expect(readScriptState(state, instance(6, "rate"))).toEqual([3]);
    expect(readScriptState(state, instance(6, "colorn"))).toEqual([-1, -1, -1]);
    const colorn = readScriptState(state, instance(7, "colorn"));
    expect(colorn).toEqual([0.1, 0.2, 0.3]);
    expect(colorn).not.toBe(state.particleInstances.get(7)!.colorn);
    expect(readScriptState(state, instance(6, "controlpoint0"))).toEqual([1, 2, 3]);
    expect(readScriptState(state, instance(6, "controlpoint1"))).toEqual([FLT_MAX, 0, 0]);
    expect(readScriptState(state, instance(7, "controlpointangle1"))).toEqual([0.5, 0, 0]);
    expect(readScriptState(state, instance(7, "controlpointangle0"))).toEqual([FLT_MAX, 0, 0]);
    expect(readScriptState(state, instance(9, "alpha"))).toBeNull();
  });

  it("读不了的目标（unsupported、script-property、recompile）为 null", () => {
    const state = fakeState();
    expect(readScriptState(state, { kind: "unsupported", path: "objects/0/foo" })).toBeNull();
    expect(readScriptState(state, { kind: "script-property", script: "s", key: "k" })).toBeNull();
    expect(readScriptState(state, { kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" })).toBeNull();
  });
});

describe("recordRecompileWrite", () => {
  const general = { postprocess: { hdrFlag: false } } as never;

  it("第一次写成编译期的值、或同上一次写的值时不算；变了才记进覆盖表", () => {
    const overrides = new Map();
    expect(compiledRecompileValue(general, "general/hdr")).toBe(false);
    expect(compiledRecompileValue(general, "objects/0/effects/1/visible")).toBeUndefined();
    expect(recordRecompileWrite(overrides, general, "general/hdr", false)).toBe(false);
    expect(overrides.size).toBe(0);
    expect(recordRecompileWrite(overrides, general, "general/hdr", true)).toBe(true);
    expect(recordRecompileWrite(overrides, general, "general/hdr", true)).toBe(false);
    expect(recordRecompileWrite(overrides, general, "general/hdr", false)).toBe(true);
    expect(overrides.get("general/hdr")).toBe(false);
    // 没有编译期值的路径：第一次写就算
    expect(recordRecompileWrite(overrides, general, "objects/0/effects/1/visible", false)).toBe(true);
  });
});
