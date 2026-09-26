// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import GalleryQueryBar from "./GalleryQueryBar.vue";
import {
  composeQueryFilters,
  splitQueryFilters,
  type GalleryQuery,
} from "@/utils/galleryQuery";

const ui = vi.hoisted(() => ({ isCompact: false }));
vi.mock("@kabegame/core/stores/ui", () => ({ useUiStore: () => ui }));
vi.mock("@kabegame/core/stores/settings", () => ({
  useSettingsStore: () => ({ values: {}, set: vi.fn() }),
}));
vi.mock("@/stores/plugins", () => ({
  usePluginStore: () => ({ plugins: [], pluginLabel: (id: string) => id }),
}));
vi.mock("@/services/pathql", () => ({
  pathqlEntry: vi.fn(async () => ({ total: 0 })),
  pathqlList: vi.fn(async () => []),
}));
vi.mock("@/composables/useImagesChangeRefresh", () => ({ useImagesChangeRefresh: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
}));

const simple = { plugin: { pluginId: "pixiv" } };
const extra: GalleryQuery = [{ any: [
  [{ is: { search: { mode: "native-metadata", query: "sakura" } } }],
  [{ is: { mediaType: { kind: "image" } } }],
] }];
const wrappers: ReturnType<typeof shallowMount>[] = [];
function render(query: GalleryQuery = composeQueryFilters(simple, extra)) {
  const wrapper = shallowMount(GalleryQueryBar, {
    props: { query, contextBase: "hide/", enableClearAll: true },
    global: {
      plugins: [createPinia()],
      mocks: { $t: (key: string) => key },
      directives: { "hscroll-fade": {} },
      renderStubDefaultSlot: true,
      stubs: {
        ElScrollbar: { template: '<div><slot /></div>' },
        ElIcon: true,
        ElSwitch: true,
        VanPicker: true,
        VanPopup: true,
        // 使用真实 chip，覆盖主体/清除按钮事件隔离与未激活文案。
        KbFilterDropdown: false,
        ElTooltip: { template: "<div><slot /></div>" },
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  ui.isCompact = false;
});
const advancedSelector = '[role="button"][aria-label="gallery.advancedQuery"]';

describe("查询条追加高级 chip", () => {
  it("简单 chip 始终可见，高级 chip 位于末尾，无模式开关或路径条", () => {
    const wrapper = render();
    expect(wrapper.findComponent({ name: "KbTab" }).exists()).toBe(false);
    expect(wrapper.findComponent({ name: "PathqlPathBar" }).exists()).toBe(false);
    const chips = wrapper.findAll('.filter-chip-row [role="button"]');
    expect(chips.at(-1)?.attributes("aria-label")).toBe("gallery.advancedQuery");
    expect(wrapper.text()).toContain("pixiv");
    expect(wrapper.findComponent({ name: "GallerySearchDropdown" }).exists()).toBe(true);
  });

  it("主体只打开弹窗，弹窗只收到高级条件，应用后保留简单条件", async () => {
    const wrapper = render();
    await wrapper.get(advancedSelector).trigger("click");
    const dialog = wrapper.findComponent({ name: "GalleryAdvancedQueryDialog" });
    expect(dialog.props("visible")).toBe(true);
    expect(dialog.props("query")).toEqual(extra);
    expect(dialog.props("contextPrefix")).toBe("images://gallery/hide/plugin/pixiv/filter_comb/");
    expect(wrapper.emitted("navigate")).toBeUndefined();
    const next: GalleryQuery = [{ is: { size: { range: "1MB-2MB" } } }];
    dialog.vm.$emit("apply", next);
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery; page: number };
    expect(splitQueryFilters(patch.query)).toEqual({ simple, advanced: next });
    expect(patch.page).toBe(1);
  });

  it.each([false, true])("清除只删除高级部分且不打开弹窗（compact=%s）", async (compact) => {
    ui.isCompact = compact;
    const wrapper = render();
    await wrapper.get(`${advancedSelector} button`).trigger("click");
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({ simple, advanced: [] });
    expect(wrapper.findComponent({ name: "GalleryAdvancedQueryDialog" }).props("visible")).toBe(false);
    await wrapper.setProps({ query: patch.query });
    expect(wrapper.get(advancedSelector).text()).toContain("gallery.advancedQueryShort");
    expect(wrapper.find(`${advancedSelector} button`).exists()).toBe(false);
    await wrapper.get(advancedSelector).trigger("click");
    expect(wrapper.findComponent({ name: "GalleryAdvancedQueryDialog" }).props("query")).toEqual([]);
  });

  it("搜索更新保留高级条件，清除全部则同时移除两部分", async () => {
    const wrapper = render();
    wrapper.findComponent({ name: "GallerySearchDropdown" }).vm.$emit("update:query", "春");
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({
      simple: { ...simple, search: { mode: "display-name", query: "春" } }, advanced: extra,
    });
    await wrapper.get(".query-clear-filter").trigger("click");
    expect(wrapper.emitted("navigate")!.at(-1)![0]).toEqual({ query: [], page: 1 });
  });

  it("清除简单插件保留高级部分，取消弹窗不导航", async () => {
    const wrapper = render();
    await wrapper.get('[role="button"][aria-label="gallery.advancedChipPlugin"] button').trigger("click");
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({ simple: {}, advanced: extra });
    await wrapper.setProps({ query: patch.query });
    await wrapper.get(advancedSelector).trigger("click");
    wrapper.findComponent({ name: "GalleryAdvancedQueryDialog" }).vm.$emit("update:visible", false);
    expect(wrapper.emitted("navigate")).toHaveLength(1);
  });
});
