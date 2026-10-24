// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { reactive, ref, toRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar.vue";
import { gridTotalKey } from "@/components/imageGrid/gridTotal";
import type { GalleryQuery } from "@/utils/galleryPath";

const pathqlAll = vi.hoisted(() => vi.fn());
const routeStore = reactive({
  query: [] as GalleryQuery,
  hide: true,
  effectiveNoAlbum: false,
  navigate: vi.fn(async () => true),
  contextPathFor: vi.fn(() => "hide/"),
});

vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));
vi.mock("@/api", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/services/albums", () => ({ FAVORITE_ALBUM_ID: "favorite" }));
vi.mock("pinia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pinia")>()),
  storeToRefs: (store: typeof routeStore) => ({ hide: toRef(store, "hide") }),
}));
vi.mock("@/stores/galleryRoute", () => ({
  useGalleryRouteStore: () => routeStore,
  galleryStickySearchModes: ref([]),
  rememberGallerySearchModes: vi.fn(),
}));
vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ isCompact: false }) }));
vi.mock("@/stores/plugins", () => ({ usePluginStore: () => ({ pluginLabel: (id: string) => id }) }));
vi.mock("@/stores/failedImages", () => ({ useFailedImagesStore: () => ({ allFailed: [] }) }));
vi.mock("@/stores/header", () => ({
  HeaderFeatureId: {
    Collect: "collect",
    TaskDrawer: "task-drawer",
    Refresh: "refresh",
    FailedImages: "failed-images",
    GalleryFilter: "gallery-filter",
    GallerySort: "gallery-sort",
    GalleryPageSize: "gallery-page-size",
  },
  // PageHeader 渲染 show/fold 项时会查热区定义与 fold 文案覆盖；mock 必须与 store 接口同形。
  useHeaderStore: () => ({
    get: vi.fn(() => undefined),
    getFoldLabel: vi.fn(() => undefined),
    setFoldLabel: vi.fn(),
  }),
}));
vi.mock("@/stores/pageBridge", () => ({
  usePageBridgeStore: () => ({
    setRefresh: vi.fn(),
    setToggleShowHidden: vi.fn(),
    setToggleShowAlbumImages: vi.fn(),
  }),
}));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({
    locale: ref("zh-CN"),
    t: (key: string, args?: Record<string, number>) =>
      key === "gallery.totalImagesFiltered"
        ? `${args?.count} / ${args?.total}`
        : key === "gallery.totalImages"
          ? String(args?.count)
          : key,
  }),
}));

const wrappers: ReturnType<typeof shallowMount>[] = [];

function render() {
  const wrapper = shallowMount(GalleryToolbar, {
    global: {
      provide: { [gridTotalKey as symbol]: { total: gridTotal, unfilteredTotal } },
      mocks: { $t: (key: string) => key },
      stubs: {
        PageHeader: { template: '<div class="subtitle"><slot name="subtitle" /></div>' },
        GalleryQueryBar: true,
        ElIcon: true,
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

const gridTotal = ref(7);
const unfilteredTotal = ref<number | null>(null);

beforeEach(() => {
  pathqlAll.mockReset();
  gridTotal.value = 7;
  unfilteredTotal.value = null;
  routeStore.query = [];
  routeStore.hide = true;
  routeStore.effectiveNoAlbum = false;
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("GalleryToolbar 计数快照", () => {
  it.each([
    [7, null, "7"],
    [7, 10, "7 / 10"],
    [7, 7, "7"],
    [7, 6, "7"],
    [0, 10, "gallery.noImages"],
  ])("分子 %s、分母 %s 的文案为 %s，工具栏不请求 pathql", async (count, total, text) => {
    gridTotal.value = count as number;
    unfilteredTotal.value = total as number | null;
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe(text);
    expect(pathqlAll).not.toHaveBeenCalled();
  });

  it("同一回调更新注入的分子分母后整体更新文案", async () => {
    unfilteredTotal.value = 10;
    const wrapper = render();
    gridTotal.value = 8;
    unfilteredTotal.value = 11;
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8 / 11");
    expect(pathqlAll).not.toHaveBeenCalled();
  });
});
