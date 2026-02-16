/**
 * 图片扩展名与 MIME 类型，运行时从后端获取，集中使用。
 */
import { ref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface SupportedImageTypes {
  extensions: string[];
  mimeByExt: Record<string, string>;
}

const extensions: Ref<string[]> = ref([]);
const mimeByExt: Ref<Record<string, string>> = ref({});
let loadPromise: Promise<void> | null = null;

export function useImageTypes() {
  const load = async (): Promise<void> => {
    if (extensions.value.length > 0) return;
    if (!loadPromise) {
      loadPromise = invoke<SupportedImageTypes>("get_supported_image_types")
        .then((r) => {
          extensions.value = r.extensions ?? [];
          mimeByExt.value = r.mimeByExt ?? {};
        })
        .catch((e) => {
          console.warn("[useImageTypes] 获取支持的图片类型失败，使用默认值:", e);
          extensions.value = [
            "jpg",
            "jpeg",
            "png",
            "gif",
            "webp",
            "bmp",
            "ico",
            "svg",
          ];
          mimeByExt.value = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            ico: "image/x-icon",
            svg: "image/svg+xml",
          };
        });
    }
    await loadPromise;
  };

  const getMimeType = (ext: string | undefined): string => {
    const key = ext?.trim().toLowerCase().replace(/^\./, "") ?? "";
    return mimeByExt.value[key] ?? "image/jpeg";
  };

  return {
    extensions,
    mimeByExt,
    getMimeType,
    load,
  };
}
