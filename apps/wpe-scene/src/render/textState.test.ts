/**
 * P6b 1e-1：`SceneState` 的文本字段（计划「1e」点 2）。
 * - `textFields` 起始值是编译期 `SceneText.fields` 的拷贝；
 * - 文本目标的写入按来源规整（属性侧 `textFieldFromJson`、带条件先换布尔），和现值逐项比较，变了才标 `dirtyTexts`；
 * - `takeDirty` 取走 `texts`；`needsRecompile` 对文本目标为假，文本分支不落到兜底的泛光写入；
 * - `setText` 换排版、写对齐偏移，偏移变了本层与子孙一起标脏。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults, type BindingTarget, type SceneBinding } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass } from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import type { SceneText } from "../compile/texts";
import { TEXT_DEFAULTS, textFieldFromScript, type TextFields } from "../text/fields";
import type { TextLayout } from "../text/layout";
import { SceneState } from "./state";

const pass = (key: string): ScenePass => ({ key, program: null, uniforms: {} }) as unknown as ScenePass;

function text(object: number, fields: Partial<TextFields> = {}): SceneText {
  return {
    fields: { ...TEXT_DEFAULTS, padding: [32, 32], spacing: [0, 0], text: "abc", ...fields },
    font: { path: "fonts/a.ttf", location: null, size: null },
    glyphPass: pass(`objects/${object}/text/glyphs`),
    colorPass: pass(`objects/${object}/text/color`),
    backgroundPass: null,
    clearAlphaPass: null,
    background: { key: `objects/${object}/text/background`, color: [0, 0, 0] },
  };
}

function layer(object: number, parent: number | null, sceneText: SceneText | null): SceneLayer {
  return {
    id: object + 10,
    object,
    parent,
    name: `l${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1, 1],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    passes: [],
    effects: [],
    colorBlendMode: 0,
    passthrough: null,
    groupUpload: null,
    particle: null,
    text: sceneText,
  } as unknown as SceneLayer;
}

/** 0：文本层（子对象 1 是图像层、2 是 1 的子对象）；3：另一个文本层；4：图像层。 */
function bundle(): SceneBundle {
  return {
    general: {
      width: 100,
      height: 100,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: 1,
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 2,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 1,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    layers: [
      layer(0, null, text(0, { text: "Song Title", pointsize: 40 })),
      layer(1, 0, null),
      layer(2, 1, null),
      layer(3, null, text(3)),
      layer(4, null, null),
    ],
    programs: [],
    textures: [],
    bloom: { hdr: false, passes: {} },
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const bind = (target: BindingTarget, condition?: string): SceneBinding => ({
  property: "p",
  target,
  ...(condition === undefined ? {} : { condition }),
});
const textTarget = (field: Extract<BindingTarget, { kind: "text" }>["field"], object = 0): BindingTarget => ({
  kind: "text",
  object,
  field,
});
const layoutAt = (offset: [number, number]): TextLayout => ({
  missingFonts: [],
  mesh: null,
  padding: [0, 0],
  size: [2, 2],
  compositeSize: [1, 1],
  offset,
});

describe("SceneState：文本字段（P6b 1e）", () => {
  it("fromBundle：每个文本层一份编译期字段的拷贝，不与 bundle 共用；非文本层没有", () => {
    const source = bundle();
    const state = SceneState.fromBundle(source);
    expect([...state.textFields.keys()]).toEqual([0, 3]);
    const fields = state.textFields.get(0)!;
    expect(fields).toEqual(source.layers[0].text!.fields);
    expect(fields).not.toBe(source.layers[0].text!.fields);
    expect(fields.padding).not.toBe(source.layers[0].text!.fields.padding);
    expect(state.takeDirty().texts).toEqual(new Set());
  });

  it("属性写入：按 JSON 侧规整、变了才标脏；takeDirty 取走 texts 后清空", () => {
    const state = SceneState.fromBundle(bundle());
    expect(state.write(bind(textTarget("text")), "Hello")).toBe("applied");
    expect(state.textFields.get(0)!.text).toBe("Hello");
    const dirty = state.takeDirty();
    expect(dirty.texts).toEqual(new Set([0]));
    // 只标文本：图层、pass、泛光都不脏
    expect(dirty).toMatchObject({ layers: new Set(), passes: new Set(), bloom: false, structures: new Set() });
    expect(state.takeDirty().texts).toEqual(new Set());
  });

  it("值没变不标脏（同 WPE 的逐项比较）：字符串、数字、向量", () => {
    const state = SceneState.fromBundle(bundle());
    state.write(bind(textTarget("text")), "Song Title");
    state.write(bind(textTarget("pointsize")), "40");
    state.write(bind(textTarget("padding")), "32 32");
    state.write(bind(textTarget("padding")), 32);
    expect(state.takeDirty().texts).toEqual(new Set());
    state.write(bind(textTarget("padding")), "10 32");
    expect(state.textFields.get(0)!.padding).toEqual([10, 32]);
    expect(state.takeDirty().texts).toEqual(new Set([0]));
  });

  it("属性侧 text 只收字符串：数字、布尔不写、不标脏", () => {
    const state = SceneState.fromBundle(bundle());
    for (const raw of [12, true, false] as SceneScalar[]) state.write(bind(textTarget("text")), raw);
    expect(state.textFields.get(0)!.text).toBe("Song Title");
    expect(state.takeDirty().texts).toEqual(new Set());
  });

  it("各字段的规整：maxrows 截断、枚举回退表里第一项、向量铺满、不合法的数字不写、条件先换布尔", () => {
    const state = SceneState.fromBundle(bundle());
    state.write(bind(textTarget("maxrows")), "2.9");
    state.write(bind(textTarget("horizontalalign")), "foo");
    state.write(bind(textTarget("verticalalign")), "foo");
    state.write(bind(textTarget("spacing")), 5);
    state.write(bind(textTarget("maxwidth")), "abc");
    state.write(bind(textTarget("limitwidth")), true);
    // 带条件：值换成 `String(raw) === condition` 的布尔，float 键按 1 / 0（同编译期 `resolveValue`）
    state.write(bind(textTarget("pointsize"), "2"), 2);
    expect(state.textFields.get(0)).toMatchObject({
      maxrows: 2,
      horizontalalign: "left",
      verticalalign: "center",
      spacing: [5, 5],
      maxwidth: TEXT_DEFAULTS.maxwidth,
      limitwidth: true,
      pointsize: 1,
    });
  });

  it("writeText：undefined 不写；按对象分开；不是文本层不做事；向量存拷贝", () => {
    const state = SceneState.fromBundle(bundle());
    state.writeText(0, "text", undefined);
    expect(state.takeDirty().texts).toEqual(new Set());
    const padding: [number, number] = [1, 2];
    state.writeText(3, "padding", padding);
    padding[0] = 99;
    expect(state.textFields.get(3)!.padding).toEqual([1, 2]);
    expect(state.textFields.get(0)!.padding).toEqual([32, 32]);
    state.writeText(4, "text", "x");
    state.writeText(9, "text", "x");
    expect(state.textFields.has(4)).toBe(false);
    expect(state.takeDirty().texts).toEqual(new Set([3]));
  });

  it("脚本侧值（宿主先 textFieldFromScript）：数字 ToString 后写，null 不写", () => {
    const state = SceneState.fromBundle(bundle());
    state.writeText(0, "text", textFieldFromScript("text", 12));
    expect(state.textFields.get(0)!.text).toBe("12");
    state.takeDirty();
    state.writeText(0, "text", textFieldFromScript("text", null));
    state.writeText(0, "text", textFieldFromScript("text", "12"));
    expect(state.textFields.get(0)!.text).toBe("12");
    expect(state.takeDirty().texts).toEqual(new Set());
  });

  it("文本目标不整场重编译、不落到兜底的泛光写入", () => {
    const state = SceneState.fromBundle(bundle());
    const bloom = structuredClone(state.bloom);
    for (const field of ["text", "pointsize", "maxwidth", "padding"] as const) {
      expect(state.needsRecompile(bind(textTarget(field)), "5")).toBe(false);
      expect(state.write(bind(textTarget(field)), "5")).toBe("applied");
    }
    expect(state.bloom).toEqual(bloom);
    expect(state.takeDirty().bloom).toBe(false);
  });

  it("setText：换排版、写偏移，偏移变了本层与子孙标脏；偏移不变不标；不是文本层不做事", () => {
    const state = SceneState.fromBundle(bundle());
    state.setTexts(new Map([[0, layoutAt([5, 6])]]));
    expect(state.takeDirty().layers).toEqual(new Set());
    const next = layoutAt([7, 6]);
    state.setText(0, next);
    expect(state.texts.get(0)).toBe(next);
    expect(state.layers.get(0)!.offset).toEqual([7, 6]);
    expect(state.takeDirty().layers).toEqual(new Set([0, 1, 2]));
    const same = layoutAt([7, 6]);
    state.setText(0, same);
    expect(state.texts.get(0)).toBe(same);
    expect(state.takeDirty().layers).toEqual(new Set());
    // 第一次排版（加载时没有偏移）也算变了
    state.setText(3, layoutAt([0, 0]));
    expect(state.takeDirty().layers).toEqual(new Set([3]));
    state.setText(4, layoutAt([1, 1]));
    expect(state.texts.has(4)).toBe(false);
    expect(state.layers.get(4)!.offset).toBeUndefined();
    expect(state.takeDirty().layers).toEqual(new Set());
  });
});
