import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import { useAlbumStore } from "@/stores/albums";
import type { DragFileItem } from "@/directives/dragFile";

/** 从路径取文件名（不依赖 node:path，兼容两种分隔符） */
export function dragFileBasename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/**
 * 把拖入的文件夹逐个建成本地文件夹同步画册（递归），并汇报结果。
 *
 * 单个失败不中断整批：后端的每一条拒绝理由（重名、路径已是同步画册根、
 * 虚拟磁盘路径、无权限……）都是一句完整的人话，**原样透给用户**——
 * 换成「创建失败」这类通用文案等于把唯一有用的信息丢掉，用户没法自己解决。
 *
 * @param parentId 父画册 id；null 表示建根级画册
 */
export async function createFolderAlbumsFromDrag(
  folders: DragFileItem[],
  parentId: string | null,
): Promise<void> {
  if (folders.length === 0) return;

  const albumStore = useAlbumStore();
  const t = i18n.global.t;
  let successCount = 0;

  for (const folder of folders) {
    const name = dragFileBasename(folder.path);
    try {
      await albumStore.createLocalFolderAlbum(
        { name, syncFolder: folder.path, recursive: true, parentId },
        { reload: false },
      );
      successCount++;
    } catch (error) {
      console.error("[DragFile] 创建文件夹画册失败:", folder.path, error);
      const reason = error instanceof Error ? error.message : String(error);
      ElMessage.error(t("import.createFolderAlbumFailed", { name, reason }));
    }
  }

  if (successCount > 0) {
    ElMessage.success(t("import.createdFolderAlbums", { count: successCount }));
  }
}
