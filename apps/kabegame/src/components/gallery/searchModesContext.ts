import { computed, inject, type ComputedRef, type InjectionKey } from "vue";
import { GALLERY_SEARCH_MODES, type GallerySearchMode } from "@/utils/galleryPath";

/** 高级弹窗链路（QueryBar → Dialog → Sequence 递归 → ConditionRow）四层且中间递归，
 *  tab 可见集合用 provide/inject 下发，不逐层透传。 */
export const GallerySearchModesKey: InjectionKey<ComputedRef<readonly GallerySearchMode[]>> =
  Symbol("GallerySearchModes");

export function useGallerySearchModes(): ComputedRef<readonly GallerySearchMode[]> {
  return inject(GallerySearchModesKey, computed(() => GALLERY_SEARCH_MODES));
}
