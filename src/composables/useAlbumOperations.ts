import { ref, computed, nextTick, type Ref } from "vue";
import { ElMessage } from "element-plus";
import { useAlbumStore } from "@/stores/albums";
import type { ImageInfo } from "@/stores/crawler";

/**
 * 画册操作 composable
 */
export function useAlbumOperations() {
  const albumStore = useAlbumStore();
  const albums = computed(() => albumStore.albums);
  const showAlbumDialog = ref(false);
  const selectedAlbumId = ref<string>("");
  const newAlbumName = ref<string>("");
  const pendingAlbumImages = ref<ImageInfo[]>([]);
  const newAlbumNameInputRef = ref<any>(null);

  // 是否正在创建新画册
  const isCreatingNewAlbum = computed(() => selectedAlbumId.value === "__create_new__");

  // 打开加入画册对话框
  const openAddToAlbumDialog = async (images: ImageInfo[]) => {
    pendingAlbumImages.value = images;
    if (albums.value.length === 0) {
      await albumStore.loadAlbums();
    }
    // 重置状态
    selectedAlbumId.value = "";
    newAlbumName.value = "";
    showAlbumDialog.value = true;
  };

  // 处理新建画册并加入图片
  const handleCreateAndAddAlbum = async () => {
    if (pendingAlbumImages.value.length === 0) {
      showAlbumDialog.value = false;
      return;
    }

    if (!newAlbumName.value.trim()) {
      ElMessage.warning("请输入画册名称");
      return;
    }

    try {
      // 创建新画册
      const created = await albumStore.createAlbum(newAlbumName.value.trim());

      // 添加图片到新画册（新画册为空，无需过滤）
      const allIds = pendingAlbumImages.value.map(img => img.id);
      await albumStore.addImagesToAlbum(created.id, allIds);

      // 成功后弹窗提示
      ElMessage.success(`已创建画册「${created.name}」并加入 ${allIds.length} 张图片`);

      // 关闭对话框并重置状态
      showAlbumDialog.value = false;
      pendingAlbumImages.value = [];
      selectedAlbumId.value = "";
      newAlbumName.value = "";
    } catch (error) {
      console.error("创建画册并加入图片失败:", error);
      ElMessage.error("操作失败");
    }
  };

  // 确认加入画册
  const confirmAddToAlbum = async () => {
    if (pendingAlbumImages.value.length === 0) {
      showAlbumDialog.value = false;
      return;
    }

    const albumId = selectedAlbumId.value;
    if (!albumId) {
      ElMessage.warning("请选择画册");
      return;
    }

    const allIds = pendingAlbumImages.value.map(img => img.id);

    // 过滤掉已经在画册中的图片
    let idsToAdd = allIds;
    try {
      const existingIds = await albumStore.getAlbumImageIds(albumId);
      const existingSet = new Set(existingIds);
      idsToAdd = allIds.filter(id => !existingSet.has(id));

      if (idsToAdd.length === 0) {
        ElMessage.info("所选图片已全部在画册中");
        showAlbumDialog.value = false;
        pendingAlbumImages.value = [];
        return;
      }

      if (idsToAdd.length < allIds.length) {
        const skippedCount = allIds.length - idsToAdd.length;
        ElMessage.warning(`已跳过 ${skippedCount} 张已在画册中的图片`);
      }
    } catch (error) {
      console.error("获取画册图片列表失败:", error);
      // 如果获取失败，仍然尝试添加（后端有 INSERT OR IGNORE 保护）
    }

    await albumStore.addImagesToAlbum(albumId, idsToAdd);
    ElMessage.success(`已加入画册（${idsToAdd.length} 张）`);
    showAlbumDialog.value = false;
    pendingAlbumImages.value = [];
    selectedAlbumId.value = "";
  };

  // 监听画册选择变化，当选择"新建"时自动聚焦输入框
  const setupAlbumDialogWatchers = () => {
    // 这个函数需要在组件中调用，因为需要 nextTick
    return {
      watchSelectedAlbumId: (callback: (newValue: string) => void) => {
        // 返回一个 watch 函数，由调用者处理
        return callback;
      },
    };
  };

  return {
    showAlbumDialog,
    selectedAlbumId,
    newAlbumName,
    pendingAlbumImages,
    newAlbumNameInputRef,
    isCreatingNewAlbum,
    albums,
    openAddToAlbumDialog,
    handleCreateAndAddAlbum,
    confirmAddToAlbum,
  };
}

