import { ElMessage, ElMessageBox } from "@kabegame/element-plus";
import { invoke } from "@/api";
import type { CoverRegionScope } from "@/components/wallpaper/WallpaperPreviewCanvas.vue";

type Translate = (key: string) => string;

/**
 * 「设为封面」：`source` 包住一次截取（量画布区域、藏住盖在画布上的 UI），命令在它的回调里发出。
 * 成功后后端换 `thumbnail_path` 并发字段补丁，属性面板据此重读、显示「恢复默认封面」。成功返回 true。
 */
export async function captureWpeCover(imageId: string, source: CoverRegionScope, t: Translate): Promise<boolean> {
  try {
    await source((region) => invoke<string>("capture_wallpaper_cover", { imageId, region }));
    ElMessage.success(t("gallery.wpeSetCoverDone"));
    return true;
  } catch (failure) {
    ElMessage.error(`${t("gallery.wpeSetCoverFailed")}: ${String(failure)}`);
    return false;
  }
}

/**
 * 「清空脚本存储」：存储在宿主的 `file:` 来源里，应用页碰不到，由后端广播，同一张图正在运行的宿主收到后清空并重启脚本。
 * 没有宿主存活时没人收、不生效，所以入口只放在有实时实例的地方：预览的右键菜单与工具条。
 */
export async function clearWpeSceneStorage(imageId: string, t: Translate): Promise<void> {
  try {
    await ElMessageBox.confirm(t("gallery.wpeClearStorageConfirm"), t("gallery.wpeClearStorage"), { type: "warning" });
  } catch {
    return;
  }
  try {
    await invoke("wpe_scene_clear_storage", { imageId });
    ElMessage.success(t("gallery.wpeClearStorageDone"));
  } catch (failure) {
    ElMessage.error(`${t("gallery.wpeClearStorageFailed")}: ${String(failure)}`);
  }
}
