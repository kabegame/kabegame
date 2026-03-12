/**
 * 媒体扩展名与 MIME 类型，运行时从后端获取，集中使用。
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
          console.warn("[useImageTypes] 获取支持的媒体类型失败，使用默认值:", e);
          extensions.value = [
            "jpg",
            "jpeg",
            "png",
            "gif",
            "webp",
            "bmp",
            "mp4",
            "mov",
          ];
          mimeByExt.value = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            mp4: "video/mp4",
            mov: "video/quicktime",
          };
        });
    }
    await loadPromise;
  };

  /** 按扩展名查 MIME，用作表字段 mimeType 缺失时的回退；默认 application/octet-stream */
  const getMimeType = (ext: string | undefined): string => {
    const key = ext?.trim().toLowerCase().replace(/^\./, "") ?? "";
    return mimeByExt.value[key] ?? "application/octet-stream";
  };

  /** 分享/剪贴板用：优先使用记录的 mimeType，否则按扩展名推断，最后回退 application/octet-stream */
  const getMimeTypeForImage = (
    image: { mimeType?: string | null } | undefined,
    ext: string | undefined
  ): string => {
    const fromRecord = image?.mimeType?.trim();
    if (fromRecord) return fromRecord;
    return getMimeType(ext);
  };

  return {
    extensions,
    mimeByExt,
    getMimeType,
    getMimeTypeForImage,
    load,
  };
}
