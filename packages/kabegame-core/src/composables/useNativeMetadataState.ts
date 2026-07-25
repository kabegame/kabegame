import { computed, ref, watch, type Ref } from "vue";
import { resolveNativeMetadata } from "./useNativeMetadataCache";
import { useLoadingDelay } from "./useLoadingDelay";
import type { NativeMetadataPayload } from "../types/nativeMetadata";

export type NativeMetadataState = "loading" | "empty" | "error" | "loaded";

export function useNativeMetadataState(imageId: Ref<string | undefined>) {
  const state = ref<NativeMetadataState>("loading");
  const payload = ref<NativeMetadataPayload>(null);
  const errorDetail = ref("");
  const { showLoading, startLoading, finishLoading } = useLoadingDelay(300);
  let loadSequence = 0;

  const displayGroups = computed(() =>
    (payload.value?.groups ?? []).filter((group) => group.entries.length > 0),
  );

  async function load(): Promise<void> {
    const sequence = ++loadSequence;
    startLoading();
    state.value = "loading";
    payload.value = null;
    errorDetail.value = "";

    const currentImageId = imageId.value?.trim();
    if (!currentImageId) {
      errorDetail.value = "native-metadata:image-not-found";
      state.value = "error";
      finishLoading();
      return;
    }

    try {
      const result = await resolveNativeMetadata(currentImageId);
      if (sequence !== loadSequence) {
        finishLoading();
        if (state.value === "loading") startLoading();
        return;
      }
      payload.value = result;
      const hasEntries = (result?.groups ?? []).some((group) => group.entries.length > 0);
      state.value = hasEntries ? "loaded" : "empty";
      finishLoading();
      return;
    } catch (error) {
      if (sequence !== loadSequence) {
        finishLoading();
        if (state.value === "loading") startLoading();
        return;
      }
      errorDetail.value = error instanceof Error ? error.message : String(error);
      state.value = "error";
      finishLoading();
      return;
    }
  }

  watch(imageId, load, { immediate: true });

  return {
    state,
    showLoading,
    payload,
    errorDetail,
    displayGroups,
    load,
  };
}
