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

// 面板外壳换成只渲染默认插槽的桩
const stubs = {
  CollapsibleDrawerPanel: { template: "<section><slot name='title' /><slot /></section>" },
};

function mountPanel(palette: string | null | undefined) {
  return mount(ImageBasicInfoPanel, {
    props: { image: { id: "1", localPath: "/tmp/a.png", type: "image/png", palette } },
    global: { stubs },
  });
}

const strip = '[aria-label="gallery.imageDetailPalette"]';

describe("基本信息里的代表色", () => {
  it("按色盘画出色段，点一段发出按该颜色排序的事件", async () => {
    // 黑色是 000000：补零后的六位小写十六进制原样发出
    const wrapper = mountPanel("[[16711680,62],[0,30]]");
    const segments = wrapper.findAll(`${strip} button`);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.attributes("title")).toContain("#ff0000");
    expect(segments[0]!.attributes("title")).toContain("62%");

    await segments[1]!.trigger("click");
    await segments[0]!.trigger("click");
    expect(wrapper.emitted("open-color-sort")).toEqual([["000000"], ["ff0000"]]);
    // 点色段不是过滤跳转
    expect(wrapper.emitted("open-gallery-filter")).toBeUndefined();
  });

  it("没有色盘或色盘不合法时不渲染色带", () => {
    expect(mountPanel(null).find(strip).exists()).toBe(false);
    expect(mountPanel(undefined).find(strip).exists()).toBe(false);
    expect(mountPanel("not json").find(strip).exists()).toBe(false);
  });
});
