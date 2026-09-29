import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { IS_WINDOWS } from "@kabegame/core/env";
import { i18n } from "@kabegame/i18n";
import { useCrawlerStore } from "@/stores/crawler";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import type { Album } from "@/services/albums";
import type { DragFileItem, DragFilePlan } from "@/directives/dragFile";

const normalizeLocalPath = (path: string): string => {
  const unified = path.trim().replace(/\\/g, "/");
  const withoutTrailingSlash = unified.replace(/\/+$/, "");
  const normalized = withoutTrailingSlash || (unified.startsWith("/") ? "/" : unified);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
};

/** 路径是否是目录的直接子项；不依赖 node:path，兼容两种分隔符。 */
const isDirectChildOf = (path: string, folder: string): boolean => {
  const child = normalizeLocalPath(path);
  const parent = normalizeLocalPath(folder);
  if (!child || !parent || child === parent) return false;
  const slash = child.lastIndexOf("/");
  if (slash < 0) return false;
  const childParent = slash === 0 ? "/" : child.slice(0, slash);
  return childParent === parent;
};

/** 统一生成媒体/文件夹拖入计划；targetName 为空表示导入画廊。 */
export function buildDropPlan(items: DragFileItem[], targetName: string | null): DragFilePlan | null {
  const media = items.filter((item) => !item.isDirectory && (item.isImage || item.isVideo));
  const folders = items.filter((item) => item.isDirectory);
  if (media.length === 0 && folders.length === 0) return null;

  const t = i18n.global.t;
  const label = targetName
    ? media.length > 0 && folders.length > 0
      ? t("import.dropZone.albumMixed", {
          count: media.length,
          folders: folders.length,
          album: targetName,
        })
      : media.length > 0
        ? t("import.dropZone.albumMedia", {
            count: media.length,
            album: targetName,
          })
        : t("import.dropZone.albumFolders", {
            count: folders.length,
            album: targetName,
          })
    : media.length > 0 && folders.length > 0
      ? t("import.dropZone.galleryMixed", {
          count: media.length,
          folders: folders.length,
        })
      : media.length > 0
        ? t("import.dropZone.galleryMedia", { count: media.length })
        : t("import.dropZone.galleryFolders", { count: folders.length });

  return { label, media, folders, plugins: [] };
}

/**
 * 把计划中的媒体与文件夹统一交给 local-import 扁平递归导入。
 * 文件夹画册额外先复制到同步目录，并立即把导入结果挂到目标画册。
 */
export async function importDroppedFiles(plan: DragFilePlan, target: Album | null): Promise<void> {
  const folderAlbum = target?.type === "local_folder" && target.syncFolder ? target : null;
  let paths = [...plan.media, ...plan.folders].map((item) => item.path);
  if (folderAlbum) {
    paths = paths.filter((path) => !isDirectChildOf(path, folderAlbum.syncFolder!));
  }
  if (paths.length === 0) return;

  const ok = await useCrawlerStore().addTask(
    "local-import",
    folderAlbum?.syncFolder ?? undefined,
    {
      paths,
      recursive: true,
      ...(folderAlbum ? { copy_to_dir: true } : {}),
    },
    target?.id,
  );
  const t = i18n.global.t;
  if (ok) {
    useTaskDrawerStore().open();
    ElMessage.success(t("import.addedLocalImport"));
  } else {
    ElMessage.error(t("import.fileDropFailed"));
  }
}
