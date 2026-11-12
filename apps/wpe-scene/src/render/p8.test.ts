/**
 * P8 步骤 1 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 1」）：合成 RT 的采样
 * （`compositeSampling`）。期望值是 p8-REPORT「合成 RT 与基础纹理的采样」的表（`p8-clamp`、`p8-clamp2`，RenderDoc 管线状态里槽 0 的
 * 采样器）：寻址只看对象的 `clampuvs`（缺省钳制），和基础纹理 `.tex` 的 ClampUVs 无关；过滤在对象 `nointerpolation` 或基础纹理
 * NoInterpolation 时 Point，否则 Linear（rea-p8-layer §3.2 `FUN_1401ea500`）。
 * 对象 JSON 到图层两个字段的取值由 `compile/p8.test.ts` 核对，这里的 `fields` 照同一规则写。
 */
import { describe, expect, it } from "vitest";
import type { SceneLayer, SceneTexture } from "../compile/bundle";
import { TEX_FLAGS } from "../compile/tex";
import { compositeSampling } from "./graph";

type ObjectFlags = { clampuvs?: boolean; nointerpolation?: boolean };

/** 对象 JSON → 图层字段（同 `compile/bundle.ts`：clampuvs 只有 false 才关，nointerpolation 只认 true）。 */
const fields = (object: ObjectFlags): Pick<SceneLayer, "clampUVs" | "noInterpolation"> => ({
  clampUVs: object.clampuvs !== false,
  noInterpolation: object.nointerpolation === true,
});
/** `.tex` 标志 → 纹理的两个字段（同 `compile/bundle.ts`）。ClampUVs 也带上，核对它不影响合成 RT 的寻址。 */
const texture = (flags: number): Pick<SceneTexture, "clampUVs" | "noInterpolation"> => ({
  clampUVs: !!(flags & TEX_FLAGS.clampUVs),
  noInterpolation: !!(flags & TEX_FLAGS.noInterpolation),
});

const CLAMP_LINEAR = { clamp: true, nearest: false };
const CLAMP_POINT = { clamp: true, nearest: true };
const WRAP_LINEAR = { clamp: false, nearest: false };
const WRAP_POINT = { clamp: false, nearest: true };

describe("compositeSampling：p8-REPORT 的表（p8-clamp、p8-clamp2）", () => {
  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_LINEAR],
    ["clampuvs: true（和不写同一张池化 RT）", { clampuvs: true }, CLAMP_LINEAR],
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["两者 true", { clampuvs: true, nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false", { clampuvs: false }, WRAP_LINEAR],
    ["nointerpolation: false", { nointerpolation: false }, CLAMP_LINEAR],
    ["两者 false", { clampuvs: false, nointerpolation: false }, WRAP_LINEAR],
  ])("纹理标志 0，对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), texture(0))).toEqual(expected);
  });

  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_POINT],
    ["clampuvs: true", { clampuvs: true }, CLAMP_POINT],
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["两者 true", { clampuvs: true, nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false（纹理的 ClampUVs 不管合成 RT）", { clampuvs: false }, WRAP_POINT],
    ["nointerpolation: false（纹理的 NoInterpolation 照样 Point）", { nointerpolation: false }, CLAMP_POINT],
    ["两者 false", { clampuvs: false, nointerpolation: false }, WRAP_POINT],
  ])("纹理标志 3（NoInterpolation | ClampUVs），对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), texture(TEX_FLAGS.noInterpolation | TEX_FLAGS.clampUVs))).toEqual(
      expected,
    );
  });

  it("纹理只带一位：NoInterpolation 决定过滤，ClampUVs 不起作用", () => {
    expect(compositeSampling(fields({}), texture(TEX_FLAGS.noInterpolation))).toEqual(CLAMP_POINT);
    expect(compositeSampling(fields({}), texture(TEX_FLAGS.clampUVs))).toEqual(CLAMP_LINEAR);
    expect(compositeSampling(fields({ clampuvs: false }), texture(TEX_FLAGS.clampUVs))).toEqual(WRAP_LINEAR);
  });

  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_LINEAR],
    ["clampuvs: true", { clampuvs: true }, CLAMP_LINEAR],
    ["clampuvs: false", { clampuvs: false }, WRAP_LINEAR],
    // 下面两行没有实测：rea-p8-layer §3.3 读码（文本、形状的虚表 +0x128 给 0，点采样 ⇔ 对象 nointerpolation）
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false + nointerpolation: true", { clampuvs: false, nointerpolation: true }, WRAP_POINT],
  ])("没有基础纹理（组合层），对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), undefined)).toEqual(expected);
  });
});
