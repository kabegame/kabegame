import { computed, ref, watch, type Ref } from "vue";
import { resolveNativeMetadata } from "./useNativeMetadataCache";
import { useLoadingDelay } from "./useLoadingDelay";
import type { NativeMetadataPayload } from "../types/nativeMetadata";

export type NativeMetadataState = "loading" | "empty" | "error" | "loaded";

export function useNativeMetadataState(imageId: Ref<string | undefined>, imageMetadataId?: Ref<number | undefined>) {
  const state = ref<NativeMetadataState>("loading");
  const payload = ref<NativeMetadataPayload>(null);
  const errorDetail = ref("");
  const { showLoading, startLoading, finishLoading } = useLoadingDelay(300);
  let loadSequence = 0;
  /** 最近一次成功展示的图片：同一张图只换了 imageMetadataId 时保留旧内容，拿到新结果再替换。 */
  let shownImageId: string | null = null;

  const displayGroups = computed(() => (payload.value?.groups ?? []).filter((group) => group.entries.length > 0));

  async function load(): Promise<void> {
    const sequence = ++loadSequence;
    const currentImageId = imageId.value?.trim();
    // 首次打开懒解析后，后端补丁把 imageMetadataId 从空改成新行，内容其实没变——不清空、不转圈，避免闪一下。
    const revalidate = !!currentImageId && currentImageId === shownImageId && state.value !== "error";
    if (!revalidate) {
      shownImageId = null;
      startLoading();
      state.value = "loading";
      payload.value = null;
      errorDetail.value = "";
    }

    if (!currentImageId) {
      errorDetail.value = "native-metadata:image-not-found";
      state.value = "error";
      finishLoading();
      return;
    }

    try {
      const result = await resolveNativeMetadata(currentImageId, imageMetadataId?.value);
      if (sequence !== loadSequence) {
        finishLoading();
        if (state.value === "loading") startLoading();
        return;
      }
      payload.value = result;
      const hasEntries = (result?.groups ?? []).some((group) => group.entries.length > 0);
      state.value = hasEntries ? "loaded" : "empty";
      shownImageId = currentImageId;
      finishLoading();
      return;
    } catch (error) {
      if (sequence !== loadSequence) {
        finishLoading();
        if (state.value === "loading") startLoading();
        return;
      }
      // 重新验证失败不推翻已经显示的同一张图的内容。
      if (revalidate) return;
      errorDetail.value = error instanceof Error ? error.message : String(error);
      state.value = "error";
      finishLoading();
      return;
    }
  }

  watch([imageId, () => imageMetadataId?.value], load, { immediate: true });

  return {
    state,
    showLoading,
    payload,
    errorDetail,
    displayGroups,
    load,
  };
}
