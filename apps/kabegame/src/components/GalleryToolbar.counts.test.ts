// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { reactive, ref, toRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar.vue";
import type { GalleryQuery } from "@/utils/galleryPath";

type CountSnapshot = { total: number; seq: number };

const pathqlCount = vi.hoisted(() => vi.fn<(path: string) => Promise<CountSnapshot>>());
const refreshCapture = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
const routeStore = reactive({
  query: [] as GalleryQuery,
  hide: true,
  effectiveNoAlbum: false,
  navigate: vi.fn(async () => true),
  contextPathFor: vi.fn(() => "hide/"),
});

vi.mock("@/services/pathql", () => ({ pathqlCount }));
vi.mock("@/composables/useImagesChangeRefresh", () => ({
  useImagesChangeRefresh: (params: { onRefresh: () => void | Promise<void> }) => {
    refreshCapture.run = async () => void (await params.onRefresh());
  },
}));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const wrappers: ReturnType<typeof shallowMount>[] = [];

function render(filter: GalleryQuery) {
  const wrapper = shallowMount(GalleryToolbar, {
    props: { filter, totalCount: 7 },
    global: {
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

beforeEach(() => {
  pathqlCount.mockReset();
  refreshCapture.run = null;
  routeStore.query = [];
  routeStore.hide = true;
  routeStore.effectiveNoAlbum = false;
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("GalleryToolbar 计数快照", () => {
  it("等待过滤后数量与总数都返回，再同时更新副标题", async () => {
    const firstFiltered = deferred<CountSnapshot>();
    const firstTotal = deferred<CountSnapshot>();
    const nextFiltered = deferred<CountSnapshot>();
    const nextTotal = deferred<CountSnapshot>();
    pathqlCount
      .mockImplementationOnce(() => firstFiltered.promise)
      .mockImplementationOnce(() => firstTotal.promise)
      .mockImplementationOnce(() => nextFiltered.promise)
      .mockImplementationOnce(() => nextTotal.promise);

    const filter: GalleryQuery = [{ is: { plugin: { pluginId: "pixiv" } } }];
    const wrapper = render(filter);
    expect(pathqlCount).toHaveBeenNthCalledWith(1, "gallery/hide/plugin/pixiv");
    expect(pathqlCount).toHaveBeenNthCalledWith(2, "gallery/hide");
    expect(wrapper.get(".subtitle").text()).toBe("7");

    firstFiltered.resolve({ total: 8, seq: 1 });
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("7");
    firstTotal.resolve({ total: 10, seq: 1 });
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8 / 10");

    const refresh = refreshCapture.run;
    expect(refresh).not.toBeNull();
    const refreshing = refresh!();
    nextTotal.resolve({ total: 11, seq: 2 });
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8 / 10");
    nextFiltered.resolve({ total: 9, seq: 2 });
    await refreshing;
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("9 / 11");
  });
});
