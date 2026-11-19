// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ImageBasicInfoPanel from "./ImageBasicInfoPanel.vue";

vi.mock("../../api", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("tauri-plugin-picker-api", () => ({ openImage: vi.fn() }));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("../../utils/openExternalLink", () => ({ openExternalLink: vi.fn() }));
vi.mock("../../stores/plugins", () => ({
  usePluginStore: () => ({ plugins: [], pluginLabel: (id: string) => id, pluginIconSrc: () => "" }),
}));
vi.mock("../../stores/surf", () => ({ useSurfStore: () => ({ records: [], recordById: () => null }) }));
vi.mock("../../composables/useAdvancedQueryFacets", () => ({
  facetValueLabel: (value: string) => value,
  mediaFormatLabel: (value: string) => value,
}));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  resolveManifestText: (value: unknown) => String(value ?? ""),
}));

const stubs = {
  CollapsibleDrawerPanel: { template: "<section><slot name='title' /><slot /></section>" },
};

function mountPanel(width?: number, height?: number) {
  return mount(ImageBasicInfoPanel, {
    props: { image: { id: "1", localPath: "/tmp/a.png", type: "image/png", width, height } },
    global: { stubs },
  });
}

const frame = '[title^="gallery.filterByAspect"]';

describe("基本信息里的宽高比框", () => {
  it("框里不写比值，悬停显示真实的宽 × 高；点了按宽高比筛选", async () => {
    const wrapper = mountPanel(1920, 1080);
    const button = wrapper.find(frame);
    expect(button.exists()).toBe(true);
    expect(button.attributes("title")).toBe("gallery.filterByAspect · 1920 × 1080");
    expect(button.text()).toBe("");
    // 框宽按比例：22 × 16/9 ≈ 39
    expect(button.find("span").attributes("style")).toContain("width: 39px");

    await button.trigger("click");
    expect(wrapper.emitted("open-gallery-filter")?.[0]?.[0]).toMatchObject({ type: "aspect" });
  });

  it("没有有效尺寸时不画框", () => {
    expect(mountPanel().find(frame).exists()).toBe(false);
    expect(mountPanel(0, 1080).find(frame).exists()).toBe(false);
  });
});
