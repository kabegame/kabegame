import { describe, expect, it } from "vitest";
import { normalizeDiffKeys, parsePluginRecommendedPreset, parseRunConfigRaw, runConfigToPresetJson } from "./crawler";

describe("normalizeDiffKeys", () => {
  it("保留 maxConcurrentDownloads 的显式 null", () => {
    expect(normalizeDiffKeys({ maxConcurrentDownloads: null })).toEqual({
      maxConcurrentDownloads: null,
    });
  });
});

describe("dry-run 配置解析", () => {
  it("推荐配置读取 isDryRun，缺省为 false", () => {
    const baseUrls = new Map([["p", "https://example.test"]]);
    expect(
      parsePluginRecommendedPreset({ pluginId: "p", filename: "dry.json", isDryRun: true }, baseUrls)?.isDryRun,
    ).toBe(true);
    expect(parsePluginRecommendedPreset({ pluginId: "p", filename: "normal.json" }, baseUrls)?.isDryRun).toBe(false);
  });

  it("RunConfig 兼容 snake_case 并只在 true 时导出推荐配置字段", () => {
    const cfg = parseRunConfigRaw({
      id: "c",
      plugin_id: "p",
      name: "C",
      is_dry_run: true,
      created_at: 1,
    });
    expect(cfg?.isDryRun).toBe(true);
    expect(JSON.parse(runConfigToPresetJson(cfg!))).toMatchObject({ isDryRun: true });
    expect(JSON.parse(runConfigToPresetJson({ ...cfg!, isDryRun: false }))).not.toHaveProperty("isDryRun");
  });
});
