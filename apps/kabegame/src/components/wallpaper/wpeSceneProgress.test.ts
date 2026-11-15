import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WPE_SCENE_PROGRESS,
  WPE_SCENE_PROGRESS_STAGES,
  WPE_SCENE_PROGRESS_WEIGHTS,
  creepProgress,
  isWpeSceneProgressMessage,
  overallProgress,
  stageRange,
} from "./wpeSceneProgress";

describe("wpeSceneProgress", () => {
  it("宿主的字面量与阶段名与这里一致（宿主没有 page）", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/progress.ts"), "utf8");
    expect(source).toContain(`SCENE_PROGRESS_MESSAGE = "${WPE_SCENE_PROGRESS}"`);
    const stages = WPE_SCENE_PROGRESS_STAGES.filter((stage) => stage !== "page")
      .map((stage) => `"${stage}"`)
      .join(" | ");
    expect(source).toContain(`SceneProgressStage = ${stages};`);
  });

  it("权重和为 100，阶段区间首尾相接、按加载顺序", () => {
    expect(Object.values(WPE_SCENE_PROGRESS_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100);
    expect(stageRange("page")).toEqual([0, 0.05]);
    expect(stageRange("compile")[0]).toBeCloseTo(0.05);
    expect(stageRange("frame")[1]).toBeCloseTo(1);
    let previous = 0;
    for (const stage of WPE_SCENE_PROGRESS_STAGES) {
      const [start, end] = stageRange(stage);
      expect(start).toBeCloseTo(previous);
      expect(end).toBeGreaterThan(start);
      previous = end;
    }
  });

  it("总进度 = 阶段起点 + 宽度 × done / total；total 为 0 当这一阶段完成，越界夹住", () => {
    expect(overallProgress({ stage: "compile", done: 0, total: 10 })).toBeCloseTo(0.05);
    expect(overallProgress({ stage: "compile", done: 5, total: 10 })).toBeCloseTo(0.3);
    expect(overallProgress({ stage: "decode", done: 0, total: 0 })).toBeCloseTo(0.65);
    expect(overallProgress({ stage: "gpu", done: 9, total: 3 })).toBeCloseTo(0.95);
    expect(overallProgress({ stage: "frame", done: 1, total: 1 })).toBeCloseTo(1);
  });

  it("没有新消息时在阶段区间里逼近上沿的 90%，到不了上沿；已越过目标的原样返回", () => {
    const [start, end] = stageRange("gpu");
    const target = start + (end - start) * 0.9;
    expect(creepProgress(start, "gpu", 0)).toBe(start);
    const a = creepProgress(start, "gpu", 1_000);
    const b = creepProgress(start, "gpu", 10_000);
    expect(a).toBeGreaterThan(start);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(target);
    expect(creepProgress(start, "gpu", 1e9)).toBeCloseTo(target);
    expect(creepProgress(target + 0.01, "gpu", 5_000)).toBe(target + 0.01);
  });

  it("消息识别：类型、阶段与数字都要对", () => {
    expect(isWpeSceneProgressMessage({ type: WPE_SCENE_PROGRESS, stage: "gpu", done: 1, total: 2 })).toBe(true);
    expect(isWpeSceneProgressMessage({ type: WPE_SCENE_PROGRESS, stage: "page", done: 1, total: 2 })).toBe(false);
    expect(isWpeSceneProgressMessage({ type: WPE_SCENE_PROGRESS, stage: "gpu", done: Number.NaN, total: 2 })).toBe(
      false,
    );
    expect(isWpeSceneProgressMessage({ type: "other", stage: "gpu", done: 1, total: 2 })).toBe(false);
    expect(isWpeSceneProgressMessage(null)).toBe(false);
  });
});
