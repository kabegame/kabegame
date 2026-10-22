// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { reactive, ref, toRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar.vue";
import { gridTotalKey } from "@/components/imageGrid/gridTotal";
import { pathqlRequest$ } from "@/services/kbEvents";
import type { GalleryQuery } from "@/utils/galleryPath";

type CountSnapshot = { total: number; seq: number };

const pathqlCount = vi.hoisted(() => vi.fn<(path: string) => Promise<CountSnapshot>>());
const routeStore = reactive({
  query: [] as GalleryQuery,
  hide: true,
  effectiveNoAlbum: false,
  navigate: vi.fn(async () => true),
  contextPathFor: vi.fn(() => "hide/"),
});

vi.mock("@/services/pathql", () => ({ pathqlCount, pathqlFetch: vi.fn() }));
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
    props: { filter },
    global: {
      provide: { [gridTotalKey as symbol]: { total: gridTotal, settled: gridSettled } },
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
const gridSettled = ref(false);

beforeEach(() => {
  pathqlCount.mockReset();
  gridTotal.value = 7;
  gridSettled.value = false;
  routeStore.query = [];
  routeStore.hide = true;
  routeStore.effectiveNoAlbum = false;
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("GalleryToolbar 计数快照", () => {
  it("分子取 ImageGrid 注入的总数，分母自己观察；两者都落定才同时更新副标题", async () => {
    const firstTotal = deferred<CountSnapshot>();
    const nextTotal = deferred<CountSnapshot>();
    pathqlCount.mockImplementationOnce(() => firstTotal.promise).mockImplementationOnce(() => nextTotal.promise);

    const filter: GalleryQuery = [{ is: { plugin: { pluginId: "pixiv" } } }];
    const wrapper = render(filter);
    // 只读分母，分子不再单独订阅
    expect(pathqlCount).toHaveBeenCalledTimes(1);
    expect(pathqlCount).toHaveBeenCalledWith("gallery/hide");
    expect(wrapper.get(".subtitle").text()).toBe("7");

    gridTotal.value = 8;
    gridSettled.value = true;
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8");
    firstTotal.resolve({ total: 10, seq: 1 });
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8 / 10");

    // 刷新：分子在途时分母先回来，不提交半份快照
    gridSettled.value = false;
    pathqlRequest$.next(["total", "gallery/hide"]);
    nextTotal.resolve({ total: 11, seq: 2 });
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("8 / 10");
    gridTotal.value = 9;
    gridSettled.value = true;
    await flushPromises();
    expect(wrapper.get(".subtitle").text()).toBe("9 / 11");
  });

  it("无过滤时不读分母，只显示分子", async () => {
    const wrapper = render([]);
    gridTotal.value = 12;
    gridSettled.value = true;
    await flushPromises();
    expect(pathqlCount).not.toHaveBeenCalled();
    expect(wrapper.get(".subtitle").text()).toBe("12");
  });
});
