// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, ref, shallowRef } from "vue";
import GalleryQueryBar from "./GalleryQueryBar.vue";
import { COLOR_BUCKET_LAYER_CLASS } from "./colorBucketLayer";
import type { ColorBucket } from "@/services/colorBuckets";
import type { GallerySort, GallerySortField } from "@/utils/galleryPath";
import { composeQueryFilters, GALLERY_SEARCH_MODES, splitQueryFilters, type GalleryQuery } from "@/utils/galleryQuery";

const ui = vi.hoisted(() => ({ isCompact: false }));
vi.mock("@/stores/ui", () => ({ useUiStore: () => ui }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ values: {}, set: vi.fn(), save: vi.fn() }),
}));
vi.mock("@/stores/plugins", () => ({
  usePluginStore: () => ({ plugins: [], pluginLabel: (id: string) => id }),
}));
vi.mock("@/services/pathql", () => ({
  pathqlEntry: vi.fn(async () => ({ total: 0 })),
  pathqlList: vi.fn(async () => []),
}));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
}));
// 色桶列表由用例直接给：`colorBuckets.state` 在每个用例前重建，`enabled` 记下组件传进来的开关。
const colorBuckets = vi.hoisted(() => ({
  state: null as unknown,
  enabled: null as (() => boolean) | null,
}));
vi.mock("@/composables/useColorBuckets", () => ({
  useColorBuckets: (enabled: () => boolean) => {
    colorBuckets.enabled = enabled;
    return colorBuckets.state;
  },
}));

const simple = { plugin: { pluginId: "pixiv" } };
const extra: GalleryQuery = [
  {
    any: [
      [{ is: { search: { modes: ["native-metadata"], query: "sakura" } } }],
      [{ is: { mediaType: { kind: "image" } } }],
    ],
  },
];
// 色桶列表默认是「还没读到」的空表，颜色排序的用例自己填。
const bucketList = shallowRef<ColorBucket[]>([]);
const bucketsLoaded = ref(false);
beforeEach(() => {
  bucketList.value = [];
  bucketsLoaded.value = false;
  colorBuckets.state = {
    buckets: bucketList,
    bucketHexes: computed(() => new Set(bucketList.value.map((b) => b.hex))),
    loaded: bucketsLoaded,
    loading: ref(false),
  };
});
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
        ElScrollbar: { template: "<div><slot /></div>" },
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
    expect(dialog.props("contextPrefix")).toBe("images://gallery/hide/plugin/pixiv/_kb_fc/");
    expect(wrapper.emitted("navigate")).toBeUndefined();
    const next: GalleryQuery = [{ is: { size: { range: "1MB-2MB" } } }];
    dialog.vm.$emit("apply", next);
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({ simple, advanced: next });
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

  it("全部取消勾选即移除搜索条件，重新勾选用输入框内容恢复", () => {
    const query = composeQueryFilters({ ...simple, search: { modes: ["url", "metadata"], query: "春" } }, extra);
    const wrapper = render(query);
    const dropdown = wrapper.findComponent({ name: "GallerySearchDropdown" });

    dropdown.vm.$emit("update:selected-modes", [], "春");
    expect(wrapper.emitted("searchModesChange")!.at(-1)).toEqual([[]]);
    let patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({ simple, advanced: extra });

    dropdown.vm.$emit("update:selected-modes", ["label"], "春");
    patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query).simple).toEqual({ ...simple, search: { modes: ["label"], query: "春" } });
  });

  it("搜索更新保留高级条件，清除全部则同时移除两部分", async () => {
    const wrapper = render();
    wrapper.findComponent({ name: "GallerySearchDropdown" }).vm.$emit("update:query", "春");
    const patch = wrapper.emitted("navigate")!.at(-1)![0] as { query: GalleryQuery };
    expect(splitQueryFilters(patch.query)).toEqual({
      simple: { ...simple, search: { modes: [...GALLERY_SEARCH_MODES], query: "春" } },
      advanced: extra,
    });
    await wrapper.get(".query-clear-filter").trigger("click");
    expect(wrapper.emitted("navigate")!.at(-1)![0]).toEqual({ query: [] });
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

describe("按颜色排序", () => {
  const bucket = (rgb: number, key: string | null, position: number): ColorBucket => ({
    rgb,
    hex: rgb.toString(16).padStart(6, "0"),
    key,
    position,
  });
  const red = bucket(0xff0000, "red", 0);
  const saved = bucket(0x32fe98, null, 12);
  const list = bucketList;
  const loaded = bucketsLoaded;
  beforeEach(() => {
    list.value = [red, saved];
    loaded.value = true;
  });

  const features: GallerySortField[] = ["by-time", "by-color", "random"];
  /** 弹层内容也渲染出来：排序下拉的选项与展开区才够得着。 */
  function renderSort(sort: GallerySort, sortFeatures: GallerySortField[] = features) {
    const wrapper = shallowMount(GalleryQueryBar, {
      props: { query: [], sort, sortFeatures },
      global: {
        plugins: [createPinia()],
        mocks: { $t: (key: string) => key },
        directives: { "hscroll-fade": {} },
        renderStubDefaultSlot: true,
        stubs: {
          ElScrollbar: { template: "<div><slot /></div>" },
          ElIcon: true,
          VanPicker: true,
          VanPopup: true,
          KbFilterDropdown: false,
          ElTooltip: {
            name: "ElTooltip",
            emits: ["update:visible"],
            template: '<div><slot /><div class="popper"><slot name="content" /></div></div>',
          },
        },
      },
    });
    wrappers.push(wrapper);
    return wrapper;
  }
  const sortDropdown = (wrapper: ReturnType<typeof renderSort>) => wrapper.findComponent({ name: "KbFilterDropdown" });
  const navigations = (wrapper: ReturnType<typeof renderSort>) => wrapper.emitted("navigate") ?? [];

  describe("校正排序段", () => {
    it("by-color 的颜色不在色桶里 → 换成 by-any-color（replace，不压历史）", () => {
      const wrapper = renderSort({ field: "by-color", desc: true, color: "123456" });
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-any-color", desc: true, color: "123456" } }, { push: false }],
      ]);
    });

    it("by-any-color 的颜色在色桶里 → 换成 by-color", () => {
      const wrapper = renderSort({ field: "by-any-color", desc: false, color: "32fe98" });
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-color", desc: false, color: "32fe98" } }, { push: false }],
      ]);
    });

    it("段与色桶列表对得上时不动", () => {
      expect(navigations(renderSort({ field: "by-color", desc: false, color: "ff0000" }))).toEqual([]);
      expect(navigations(renderSort({ field: "by-any-color", desc: false, color: "123456" }))).toEqual([]);
    });

    it("色桶未加载完成时不动，加载完成后才校正", async () => {
      loaded.value = false;
      list.value = [];
      const wrapper = renderSort({ field: "by-color", desc: false, color: "ff0000" });
      expect(navigations(wrapper)).toEqual([]);

      // 列表到了：ff0000 是色桶，不用换
      list.value = [red];
      loaded.value = true;
      await wrapper.vm.$nextTick();
      expect(navigations(wrapper)).toEqual([]);

      loaded.value = false;
      const stale = renderSort({ field: "by-color", desc: false, color: "123456" });
      expect(navigations(stale)).toEqual([]);
      loaded.value = true;
      await stale.vm.$nextTick();
      expect(navigations(stale)).toEqual([
        [{ sort: { field: "by-any-color", desc: false, color: "123456" } }, { push: false }],
      ]);
    });

    it("不是颜色排序时不动", async () => {
      const wrapper = renderSort({ field: "by-time", desc: false });
      list.value = [];
      await wrapper.vm.$nextTick();
      expect(navigations(wrapper)).toEqual([]);
      expect(navigations(renderSort({ field: "random", desc: false, seed: "7" }))).toEqual([]);
    });

    it("正按用户色桶排序时色桶被删 → 换成现算段；现算的颜色被存成色桶 → 换成色桶段", async () => {
      const wrapper = renderSort({ field: "by-color", desc: false, color: "32fe98" });
      expect(navigations(wrapper)).toEqual([]);
      list.value = [red];
      await wrapper.vm.$nextTick();
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-any-color", desc: false, color: "32fe98" } }, { push: false }],
      ]);

      const computedSort = renderSort({ field: "by-any-color", desc: true, color: "abcdef" });
      list.value = [red, bucket(0xabcdef, null, 13)];
      await computedSort.vm.$nextTick();
      expect(navigations(computedSort)).toEqual([
        [{ sort: { field: "by-color", desc: true, color: "abcdef" } }, { push: false }],
      ]);
    });

    it("排序换成另一个过期的段时再校正一次", async () => {
      const wrapper = renderSort({ field: "by-time", desc: false });
      await wrapper.setProps({ sort: { field: "by-color", desc: false, color: "123456" } });
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-any-color", desc: false, color: "123456" } }, { push: false }],
      ]);
    });
  });

  describe("排序下拉接线", () => {
    it("「颜色」一行可展开；两个颜色字段都点亮它，tooltip 带颜色名", () => {
      const byBucket = sortDropdown(renderSort({ field: "by-color", desc: false, color: "ff0000" }));
      expect(byBucket.props("options")).toEqual([
        { label: "gallery.sortByTime", value: "by-time" },
        { label: "gallery.sortByColor", value: "by-color", expandable: true },
        { label: "gallery.sortByRandom", value: "random" },
      ]);
      expect(byBucket.props("modelValue")).toBe("by-color");
      expect(byBucket.props("title")).toBe("gallery.sort · gallery.sortByColor · gallery.colorBucket.red");
      expect(byBucket.props("clickOutsideIgnore")).toEqual([`.${COLOR_BUCKET_LAYER_CLASS}`]);

      const computedSort = sortDropdown(renderSort({ field: "by-any-color", desc: false, color: "123456" }));
      expect(computedSort.props("modelValue")).toBe("by-color");
      expect(computedSort.props("title")).toBe("gallery.sort · gallery.sortByColor · #123456");

      const other = sortDropdown(renderSort({ field: "by-time", desc: false }));
      expect(other.props("modelValue")).toBe("by-time");
      expect(other.props("title")).toBe("gallery.sort · gallery.sortByTime");
    });

    it("只在本页开放颜色排序或当前就是颜色排序时读色桶表", () => {
      renderSort({ field: "by-time", desc: false }, ["by-time", "random"]);
      expect(colorBuckets.enabled?.()).toBe(false);
      renderSort({ field: "by-time", desc: false });
      expect(colorBuckets.enabled?.()).toBe(true);
      // 清单里没有，但带着颜色排序的路径进来：仍要读，才能校正
      renderSort({ field: "by-any-color", desc: false, color: "123456" }, ["by-time", "random"]);
      expect(colorBuckets.enabled?.()).toBe(true);
    });

    it("点「颜色」只展开面板不导航；面板选色后按色桶 / 现算给段并关闭下拉", async () => {
      const wrapper = renderSort({ field: "by-time", desc: true });
      const dropdown = sortDropdown(wrapper);
      expect(wrapper.findComponent({ name: "ColorBucketPanel" }).exists()).toBe(false);
      dropdown.findComponent({ name: "ElTooltip" }).vm.$emit("update:visible", true);
      await wrapper.vm.$nextTick();
      await dropdown.get(".is-expandable").trigger("click");
      expect(navigations(wrapper)).toEqual([]);
      expect(dropdown.emitted("close")).toBeUndefined();

      const panel = wrapper.findComponent({ name: "ColorBucketPanel" });
      expect(panel.props("buckets")).toEqual([red, saved]);
      expect(panel.props("selected")).toBeUndefined();

      // 从时间倒序切过来：不沿用倒序，一律「最接近的在前」
      panel.vm.$emit("select", "ff0000");
      expect(dropdown.emitted("close")).toHaveLength(1);
      panel.vm.$emit("select", "123456");
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-color", desc: false, color: "ff0000" } }, undefined],
        [{ sort: { field: "by-any-color", desc: false, color: "123456" } }, undefined],
      ]);
    });

    it("已经在按颜色排序时换颜色保留方向", async () => {
      const wrapper = renderSort({ field: "by-color", desc: true, color: "ff0000" });
      await sortDropdown(wrapper).get(".is-expandable").trigger("click");
      wrapper.findComponent({ name: "ColorBucketPanel" }).vm.$emit("select", "123456");
      expect(navigations(wrapper)).toEqual([
        [{ sort: { field: "by-any-color", desc: true, color: "123456" } }, undefined],
      ]);
    });

    it("面板拿到当前排序的颜色", async () => {
      const wrapper = renderSort({ field: "by-any-color", desc: false, color: "123456" });
      await sortDropdown(wrapper).get(".is-expandable").trigger("click");
      expect(wrapper.findComponent({ name: "ColorBucketPanel" }).props("selected")).toBe("123456");
    });

    it("普通排序项照常导航", async () => {
      const wrapper = renderSort({ field: "by-color", desc: true, color: "ff0000" });
      await sortDropdown(wrapper).get('[data-kb-filter-index="0"]').trigger("click");
      expect(navigations(wrapper)).toEqual([[{ sort: { field: "by-time", desc: true } }, undefined]]);
    });
  });
});
