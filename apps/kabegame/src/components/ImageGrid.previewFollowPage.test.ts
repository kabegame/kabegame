// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { computed, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageGrid from "./ImageGrid.vue";
import type { GridAdapter } from "@/components/imageGrid/types";
import type { ViewSnapshot } from "@/services/liveQuery";

const locateImageRowIndex = vi.hoisted(() => vi.fn<(view: string, id: string) => Promise<number | null>>());
const jumpToPage = vi.hoisted(() => vi.fn<(page: number) => Promise<void>>());
const refetch = vi.hoisted(() => vi.fn<() => Promise<void>>());
const previewImageId = ref("");
const queryLoading = ref(false);
const pendingPreviewBoundary = ref<{ targetPage: number; direction: "next" | "prev" } | null>(null);
const routeStore = reactive({
  computedPath: "hide/sort/by-time/desc/x2x/1",
  page: 1,
  pageSize: 2,
  navigate: vi.fn(async ({ page }: { page: number }) => {
    routeStore.page = page;
    routeStore.computedPath = `hide/sort/by-time/desc/x2x/${page}`;
  }),
  syncFromUrl: vi.fn(),
});
let applySnapshot: ((snapshot: ViewSnapshot) => Promise<void>) | null = null;
const settings = reactive({ values: { previewFollowPage: true, currentWallpaperImageId: null } });

vi.mock("@/services/imageLocate", () => ({
  locateImageRowIndex,
  pageOfRowIndex: (rowIndex: number, pageSize: number) => Math.floor((rowIndex - 1) / pageSize) + 1,
}));
vi.mock("@/services/liveQuery", () => ({
  GRID_REFRESH_WAIT_MS: 500,
  useLiveQuery: (opts: { onResult: (snapshot: ViewSnapshot) => Promise<void> }) => {
    applySnapshot = opts.onResult;
    return { loading: queryLoading, refetch, apply: opts.onResult, view: vi.fn(() => null) };
  },
}));
vi.mock("@/composables/usePagedGallery", () => ({
  usePagedGallery: () => ({
    currentPage: computed(() => routeStore.page),
    pageSize: computed(() => routeStore.pageSize),
    currentPath: computed(() => routeStore.computedPath),
    pendingPreviewBoundary,
    handleJumpToPage: jumpToPage,
    handlePreviewPageBoundary: vi.fn(),
    loadTotalImagesCount: vi.fn(),
    ensureValidPageAfterMassRemoval: vi.fn(async () => {}),
  }),
}));
vi.mock("@/composables/useSettingKeyState", () => ({
  useSettingKeyState: () => ({ settingValue: previewImageId, set: vi.fn(async () => {}) }),
}));
vi.mock("@/composables/useImageMetadataCache", () => ({
  useProvideImageMetadataCache: () => ({ clearCache: vi.fn() }),
}));
vi.mock("@/composables/useImageOperations", () => ({ useImageOperations: () => ({}) }));
vi.mock("@/services/dataChangeHub", () => ({ subscribeChanges: () => vi.fn() }));
vi.mock("@/stores/galleryRoute", () => ({ useGalleryRouteStore: () => routeStore }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => settings,
}));
vi.mock("@/stores/plugins", () => ({ usePluginStore: () => ({ plugins: [] }) }));
vi.mock("vue-router", () => ({
  useRoute: () => reactive({ path: "/gallery", query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useModal", () => ({
  useModal: () => ({ isOpen: ref(false), zIndex: ref(1), open: vi.fn(), close: vi.fn() }),
}));
vi.mock("@/utils/kameMessage", () => ({
  kameMessage: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const wrappers: ReturnType<typeof shallowMount>[] = [];

function snapshot(ids: string[], seq: number): ViewSnapshot {
  return {
    rows: ids.map((id) => ({ id, local_path: `/test/${id}.jpg`, display_name: id })),
    total: 6,
    seq,
  };
}

function mountGrid() {
  const adapter: GridAdapter = {
    id: "gallery",
    routeStore,
    isActive: () => true,
    computeCountPath: () => "hide",
    remove: { dialogText: () => ({ title: "remove", message: "remove" }) },
  };
  const wrapper = shallowMount(ImageGrid, { props: { adapter } });
  wrappers.push(wrapper);
  return wrapper;
}

async function render() {
  const wrapper = mountGrid();
  await applySnapshot!(snapshot(["target", "older"], 1));
  await nextTick();
  wrapper.getComponent({ name: "ImageGridCore" }).vm.$emit("preview-open", {
    image: { id: "target" },
  });
  await nextTick();
  expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toMatchObject({ id: "target" });
  return wrapper;
}

beforeEach(() => {
  previewImageId.value = "";
  queryLoading.value = false;
  settings.values.previewFollowPage = true;
  routeStore.page = 1;
  routeStore.computedPath = "hide/sort/by-time/desc/x2x/1";
  applySnapshot = null;
  pendingPreviewBoundary.value = null;
  refetch.mockReset();
  refetch.mockResolvedValue(undefined);
  locateImageRowIndex.mockReset();
  jumpToPage.mockReset();
  jumpToPage.mockImplementation(async (page) => {
    routeStore.page = page;
    routeStore.computedPath = `hide/sort/by-time/desc/x2x/${page}`;
  });
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("预览跟随后台新增图片", () => {
  it("同一路径刷新仍在途时，即使旧快照已加载也要等真实读取完成", async () => {
    const wrapper = await render();
    queryLoading.value = true;
    previewImageId.value = "new-target";
    locateImageRowIndex.mockImplementation(() => new Promise(() => {}));
    await nextTick();
    await applySnapshot!(snapshot(["first", "second"], 2));
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBeNull();
    queryLoading.value = false;
    await nextTick();
    expect(locateImageRowIndex).toHaveBeenCalledWith("hide/sort/by-time/desc", "new-target");
  });

  it("URL 只记录目标 id：先等当前页，再定位，目标页确认前不交给弹窗单图取数", async () => {
    previewImageId.value = "target";
    let resolveRank!: (rank: number) => void;
    locateImageRowIndex.mockImplementation(() => new Promise((resolve) => (resolveRank = resolve)));
    const wrapper = mountGrid();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    await nextTick();
    expect(core.props("previewImage")).toBeNull();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    await applySnapshot!(snapshot(["first", "second"], 1));
    await nextTick();
    expect(locateImageRowIndex).toHaveBeenCalledTimes(1);
    expect(core.props("previewImage")).toBeNull();
    resolveRank(3);
    await flushPromises();
    expect(jumpToPage).toHaveBeenCalledWith(2);
    expect(core.props("previewImage")).toBeNull();
    await applySnapshot!(snapshot(["target", "older"], 2));
    await nextTick();
    expect(core.props("previewImage")).toMatchObject({ id: "target" });
  });

  it("URL 目标就在当前页：等快照确认后显示，不查 rank", async () => {
    previewImageId.value = "target";
    const wrapper = mountGrid();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    await nextTick();
    expect(core.props("previewImage")).toBeNull();
    await applySnapshot!(snapshot(["target", "older"], 1));
    await nextTick();
    expect(core.props("previewImage")).toMatchObject({ id: "target" });
    expect(locateImageRowIndex).not.toHaveBeenCalled();
  });

  it("翻页加载期间 URL 换了 id：不丢掉新目标，也不拿旧页列表定位", async () => {
    const wrapper = await render();
    await routeStore.navigate({ page: 2 });
    previewImageId.value = "new-target";
    await nextTick();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    expect(core.props("previewImage")).toBeNull();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    // 真实弹窗因 null prop 收起旧预览时会回报 close，不得清掉等待中的 URL 目标。
    core.vm.$emit("preview-close", { image: null });
    await applySnapshot!(snapshot(["new-target", "older"], 2));
    await nextTick();
    expect(core.props("previewImage")).toMatchObject({ id: "new-target" });
    expect(locateImageRowIndex).not.toHaveBeenCalled();
  });

  it("手动翻页后仍以预览 id 为准：先等新页快照，再跟回图片所在页", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    locateImageRowIndex.mockResolvedValue(1);
    await routeStore.navigate({ page: 2 });
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    expect(core.props("previewImage")).toBe(originalImage);
    await applySnapshot!(snapshot(["second-page", "other"], 2));
    await flushPromises();
    expect(jumpToPage).toHaveBeenCalledWith(1);
    expect(core.props("previewImage")).toBe(originalImage);
  });

  it("切换过滤视图后等对应快照，并按新的过滤条件定位", async () => {
    const wrapper = await render();
    const originalImage = wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage");
    locateImageRowIndex.mockImplementation(() => new Promise(() => {}));
    routeStore.computedPath = "hide/plugin/test/sort/by-time/desc/x2x/1";
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    await applySnapshot!(snapshot(["filtered", "other"], 2));
    await nextTick();
    expect(locateImageRowIndex).toHaveBeenCalledWith("hide/plugin/test/sort/by-time/desc", "target");
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBe(originalImage);
  });

  it("重新开启跟页设置时，当前页已就绪则立即重新协调", async () => {
    const wrapper = await render();
    settings.values.previewFollowPage = false;
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await nextTick();
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBe("target");
    locateImageRowIndex.mockResolvedValue(3);
    settings.values.previewFollowPage = true;
    await flushPromises();
    expect(jumpToPage).toHaveBeenCalledWith(2);
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBeNull();
  });

  it("定位错误不等于不存在：保留旧图，下一个快照到达时允许重试", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      locateImageRowIndex.mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValueOnce(3);
      await applySnapshot!(snapshot(["new-2", "new-1"], 2));
      await flushPromises();
      expect(core.props("previewImage")).toBe(originalImage);
      expect(jumpToPage).not.toHaveBeenCalled();
      await applySnapshot!(snapshot(["new-3", "new-2"], 3));
      await flushPromises();
      expect(jumpToPage).toHaveBeenCalledWith(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("同一页同一 seq 的重复定位只防循环，不能当作不存在或重置预览", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    locateImageRowIndex.mockResolvedValue(1);
    refetch.mockImplementation(async () => applySnapshot!(snapshot(["new-2", "new-1"], 2)));
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await flushPromises();
    expect(locateImageRowIndex).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(core.props("previewImage")).toBe(originalImage);
  });

  it("预览下一张跨页时让分页器确认新目标，不跟回切换前的旧图", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    pendingPreviewBoundary.value = { targetPage: 2, direction: "next" };
    await routeStore.navigate({ page: 2 });
    await applySnapshot!(snapshot(["next-image", "other"], 2));
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    core.vm.$emit("preview-request", { id: "next-image" });
    pendingPreviewBoundary.value = null;
    await nextTick();
    expect(core.props("previewImage")).toMatchObject({ id: "next-image" });
    expect(locateImageRowIndex).not.toHaveBeenCalled();
  });

  it("当前图被新图片挤出本页后，按当前排序定位并翻到它所在页", async () => {
    await render();
    locateImageRowIndex.mockResolvedValue(3);

    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await nextTick();

    expect(locateImageRowIndex).toHaveBeenCalledWith("hide/sort/by-time/desc", "target");
    expect(jumpToPage).toHaveBeenCalledWith(2);
  });

  it("同一 id 跨页定位期间持续把图片对象交给预览，避免 Panzoom 卸载并重置缩放", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    let resolveRank!: (rank: number) => void;
    locateImageRowIndex.mockImplementation(() => new Promise((resolve) => (resolveRank = resolve)));

    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await nextTick();

    expect(core.props("previewImage")).toBe(originalImage);
    expect(jumpToPage).not.toHaveBeenCalled();
    resolveRank(3);
    await flushPromises();
    // 导航 promise 已结束，但目标快照尚未到达：仍传入原对象。
    expect(jumpToPage).toHaveBeenCalledWith(2);
    expect(core.props("previewImage")).toBe(originalImage);
    const targetSnapshot = snapshot(["target", "older"], 3);
    targetSnapshot.rows[0]!.display_name = "最新名称";
    await applySnapshot!(targetSnapshot);
    await nextTick();
    expect(core.props("previewImage")).not.toBe(originalImage);
    expect(core.props("previewImage")).toMatchObject({ id: "target", displayName: "最新名称" });
  });

  it("继续下载使同一张图再次跨页时，允许重新定位", async () => {
    await render();
    locateImageRowIndex.mockResolvedValueOnce(3).mockResolvedValueOnce(5);

    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await nextTick();
    await applySnapshot!(snapshot(["target", "older"], 3));
    await nextTick();
    await applySnapshot!(snapshot(["new-4", "new-3"], 4));
    await nextTick();

    expect(locateImageRowIndex).toHaveBeenCalledTimes(2);
    expect(jumpToPage).toHaveBeenNthCalledWith(1, 2);
    expect(jumpToPage).toHaveBeenNthCalledWith(2, 3);
  });

  it("rank 在途时继续到达下载快照，合并定位请求且保持原图片对象", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    locateImageRowIndex.mockImplementation(() => new Promise(() => {}));
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await applySnapshot!(snapshot(["new-3", "new-2"], 3));
    await nextTick();
    expect(locateImageRowIndex).toHaveBeenCalledTimes(1);
    expect(core.props("previewImage")).toBe(originalImage);
  });

  it("目标页加载期间又被挤出，保持对象并根据新快照再次定位", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    const originalImage = core.props("previewImage");
    locateImageRowIndex.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await flushPromises();
    await applySnapshot!(snapshot(["new-4", "new-3"], 3));
    await flushPromises();
    expect(jumpToPage).toHaveBeenNthCalledWith(2, 3);
    expect(core.props("previewImage")).toBe(originalImage);
    await applySnapshot!(snapshot(["target", "older"], 4));
    await nextTick();
    expect(core.props("previewImage")).toMatchObject({ id: "target" });
  });

  it("当前图确实不在视图中时，定位完成后转入单图模式", async () => {
    const wrapper = await render();
    locateImageRowIndex.mockResolvedValue(null);
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await flushPromises();
    expect(jumpToPage).not.toHaveBeenCalled();
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBe("target");
  });

  it("已确认视图外的单图遇到新快照重查，不先收起现有预览", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    locateImageRowIndex.mockResolvedValueOnce(null);
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await flushPromises();
    expect(core.props("previewImage")).toBe("target");
    locateImageRowIndex.mockImplementation(() => new Promise(() => {}));
    await applySnapshot!(snapshot(["new-3", "new-2"], 3));
    await nextTick();
    expect(core.props("previewImage")).toBe("target");
  });

  it("关掉跟页时不查询 rank、不自动翻页", async () => {
    const wrapper = await render();
    settings.values.previewFollowPage = false;
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    expect(jumpToPage).not.toHaveBeenCalled();
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toBe("target");
  });

  it("rank 返回前用户已切图，迟到结果不能触发翻页或覆盖新图", async () => {
    const wrapper = await render();
    const core = wrapper.getComponent({ name: "ImageGridCore" });
    let resolveRank!: (rank: number) => void;
    locateImageRowIndex.mockImplementation(() => new Promise((resolve) => (resolveRank = resolve)));
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    core.vm.$emit("preview-request", { id: "new-1" });
    await nextTick();
    resolveRank(3);
    await flushPromises();
    expect(jumpToPage).not.toHaveBeenCalled();
    expect(core.props("previewImage")).toMatchObject({ id: "new-1" });
  });

  it("rank 返回前用户已手动翻页，迟到结果不能搬回原视图", async () => {
    await render();
    let resolveRank!: (rank: number) => void;
    locateImageRowIndex.mockImplementation(() => new Promise((resolve) => (resolveRank = resolve)));
    await applySnapshot!(snapshot(["new-2", "new-1"], 2));
    await routeStore.navigate({ page: 3 });
    resolveRank(3);
    await flushPromises();
    expect(jumpToPage).not.toHaveBeenCalled();
    expect(routeStore.page).toBe(3);
  });

  it("主动删除/隐藏的锚点先结算为同下标图片，不定位旧图", async () => {
    const wrapper = await render();
    const instance = wrapper.vm.$ as unknown as { setupState: { capturePreviewAnchor: () => void } };
    instance.setupState.capturePreviewAnchor();
    await applySnapshot!(snapshot(["older", "oldest"], 2));
    await nextTick();
    expect(locateImageRowIndex).not.toHaveBeenCalled();
    expect(wrapper.getComponent({ name: "ImageGridCore" }).props("previewImage")).toMatchObject({ id: "older" });
  });
});
