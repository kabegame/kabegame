// @vitest-environment happy-dom
import { effectScope, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useWpePreviewPlayback } from "./useWpePreviewPlayback";
import { WPE_SETTING_DEFAULTS } from "@/utils/wpeSettings";

const stored = vi.hoisted(() => ({ forceRender: false }));
vi.mock("./useWpePreviewSettings", async () => {
  const { computed } = await import("vue");
  return {
    useWpePreviewSettings: () => ({
      values: computed(() => ({ ...WPE_SETTING_DEFAULTS, forceRender: stored.forceRender })),
    }),
  };
});
vi.mock("./useWpeFollowAvailable", async () => {
  const { ref } = await import("vue");
  return { useWpeFollowAvailable: () => ref(false) };
});

function playback(options?: { forceRender?: boolean }) {
  const scope = effectScope();
  const result = scope.run(() => useWpePreviewPlayback(ref("1"), options))!;
  return result.value;
}

describe("useWpePreviewPlayback", () => {
  it("强制渲染取这张的预览设置；应用背景（forceRender 选项）一律打开", () => {
    stored.forceRender = false;
    expect(playback().sceneSettings?.forceRender).toBe(false);
    expect(playback({ forceRender: true }).sceneSettings?.forceRender).toBe(true);
    stored.forceRender = true;
    expect(playback().sceneSettings?.forceRender).toBe(true);
  });
});
