// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, reactive, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { usePagedGallery } from "./usePagedGallery";
import type { ImageInfo } from "@/types/image";

vi.mock("@/utils/kameMessage", () => ({ kameMessage: { info: vi.fn() } }));

function setupPager() {
  const routeStore = reactive({
    page: 1,
    pageSize: 2,
    computedPath: "sort/by-time/desc/x2x/1",
    navigate: async ({ page }: { page: number }) => {
      routeStore.page = page;
      routeStore.computedPath = `sort/by-time/desc/x2x/${page}`;
    },
  });
  const images = ref<ImageInfo[]>([{ id: "old" } as ImageInfo]);
  const loadedKey = ref(routeStore.computedPath);
  const openPreviewById = vi.fn();
  let pager!: ReturnType<typeof usePagedGallery>;
  const wrapper = mount(
    defineComponent({
      setup() {
        pager = usePagedGallery({
          routeStore,
          totalImagesCount: ref(6),
          images,
          loadedKey,
          viewRef: ref({ openPreviewById }),
          loading: { startLoading: vi.fn(), finishLoading: vi.fn() },
          load: vi.fn(async () => {}),
          computeCountPath: () => "gallery/all",
          isActive: () => true,
        });
        return () => null;
      },
    }),
  );
  return { routeStore, images, loadedKey, openPreviewById, pager, wrapper };
}

describe("预览边界翻页目标交接", () => {
  it("新 id 确认前保留边界状态，避免跟页协调定位旧 id", async () => {
    const state = setupPager();
    try {
      await state.pager.handlePreviewPageBoundary({ direction: "next", image: state.images.value[0]! });
      state.openPreviewById.mockImplementation(() => {
        expect(state.pager.pendingPreviewBoundary.value).toMatchObject({ targetPage: 2 });
      });
      state.images.value = [{ id: "next" } as ImageInfo];
      state.loadedKey.value = state.routeStore.computedPath;
      await flushPromises();
      expect(state.openPreviewById).toHaveBeenCalledWith("next");
      expect(state.pager.pendingPreviewBoundary.value).toBeNull();
    } finally {
      state.wrapper.unmount();
    }
  });

  it("等待渲染期间视图再次变化，不交出旧目标页的图片", async () => {
    const state = setupPager();
    try {
      await state.pager.handlePreviewPageBoundary({ direction: "next", image: state.images.value[0]! });
      state.images.value = [{ id: "next" } as ImageInfo];
      state.loadedKey.value = state.routeStore.computedPath;
      await nextTick();
      await state.routeStore.navigate({ page: 3 });
      await flushPromises();
      expect(state.openPreviewById).not.toHaveBeenCalled();
      expect(state.pager.pendingPreviewBoundary.value).toBeNull();
    } finally {
      state.wrapper.unmount();
    }
  });
});
