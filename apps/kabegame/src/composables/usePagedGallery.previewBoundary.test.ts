// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, reactive, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { usePagedGallery } from "./usePagedGallery";
import type { ImageInfo } from "@/types/image";

vi.mock("@/utils/kameMessage", () => ({ kameMessage: { info: vi.fn() } }));

function setupPager() {
  const routeStore = reactive({
    computedPath: "sort/by-time/_kb_desc",
  });
  const pageSize = ref(2);
  const images = ref<ImageInfo[]>([{ id: "old" } as ImageInfo]);
  const loadedKey = ref("sort/by-time/_kb_desc/_kb_x2x/1");
  const openPreviewById = vi.fn();
  let pager!: ReturnType<typeof usePagedGallery>;
  const wrapper = mount(
    defineComponent({
      setup() {
        pager = usePagedGallery({
          routeStore,
          pageSize,
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
  return { routeStore, pageSize, images, loadedKey, openPreviewById, pager, wrapper };
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
      state.loadedKey.value = state.pager.rowsPath.value;
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
      state.loadedKey.value = state.pager.rowsPath.value;
      await nextTick();
      await state.pager.handleJumpToPage(3);
      await flushPromises();
      expect(state.openPreviewById).not.toHaveBeenCalled();
      expect(state.pager.pendingPreviewBoundary.value).toBeNull();
    } finally {
      state.wrapper.unmount();
    }
  });

  it("改变页大小时保持旧页首张图的位置", async () => {
    const state = setupPager();
    try {
      await state.pager.handleJumpToPage(3);
      state.pageSize.value = 4;
      await nextTick();
      expect(state.pager.currentPage.value).toBe(2);
      expect(state.pager.rowsPath.value).toBe("sort/by-time/_kb_desc/_kb_x4x/2");
    } finally {
      state.wrapper.unmount();
    }
  });

  it("视图本体变化时回到第 1 页", async () => {
    const state = setupPager();
    try {
      await state.pager.handleJumpToPage(3);
      state.routeStore.computedPath = "plugin/pixiv/sort/by-time";
      await nextTick();
      expect(state.pager.currentPage.value).toBe(1);
      expect(state.pager.rowsPath.value).toBe("plugin/pixiv/sort/by-time/_kb_x2x/1");
    } finally {
      state.wrapper.unmount();
    }
  });
});
