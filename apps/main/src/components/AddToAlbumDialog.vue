<template>
  <el-dialog v-model="visible" title="加入画册" width="420px">
    <el-form label-width="80px">
      <el-form-item label="选择画册">
        <el-select v-model="selectedAlbumId" placeholder="选择一个心仪的画册吧" style="width: 100%">
          <el-option v-for="album in filteredAlbums" :key="album.id" :label="album.name" :value="album.id" />
          <el-option value="__create_new__" label="+ 新建画册">
            <span style="color: var(--el-color-primary); font-weight: 500;">+ 新建画册</span>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item v-if="isCreatingNewAlbum" label="画册名称" required>
        <el-input v-model="newAlbumName" placeholder="请输入画册名称" maxlength="50" show-word-limit
          @keyup.enter="handleCreateAndAddAlbum" ref="newAlbumNameInputRef" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button v-if="isCreatingNewAlbum" type="primary" :disabled="!newAlbumName.trim()"
        @click="handleCreateAndAddAlbum">确定</el-button>
      <el-button v-else type="primary" :disabled="!selectedAlbumId" @click="confirmAddToAlbum">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import { useAlbumStore } from "@/stores/albums";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

interface Props {
  modelValue: boolean;
  /** 要加入画册的图片 id；在任务一键加入时可不传，改传 taskId 由后端取任务全部图片 */
  imageIds: string[];
  /**
   * 可选：任务 id。传入时为“一键加入画册”模式，只弹选择画册，由后端把该任务全部图片加入
   */
  taskId?: string;
  /**
   * 可选：排除一些画册（例如在画册详情页里，不要让用户选“当前画册”，避免无意义操作）
   */
  excludeAlbumIds?: string[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "added"): void;
}>();

const albumStore = useAlbumStore();
const { albums } = storeToRefs(albumStore);

const filteredAlbums = computed(() => {
  const exclude = new Set(props.excludeAlbumIds || []);
  return (albums.value || []).filter((a) => !exclude.has(a.id));
});

const selectedAlbumId = ref<string>("");
const newAlbumName = ref<string>("");
const newAlbumNameInputRef = ref<any>(null);

// 是否正在创建新画册
const isCreatingNewAlbum = computed(() => selectedAlbumId.value === "__create_new__");

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

useModalBack(visible);

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      // 确保画册列表可用
      await albumStore.loadAlbums();
    } else {
      selectedAlbumId.value = "";
      newAlbumName.value = "";
    }
  }
);

// 如果排除列表变化，且当前选中的 album 被排除了，则重置选择
watch(
  () => props.excludeAlbumIds,
  (next) => {
    if (!selectedAlbumId.value) return;
    const exclude = new Set(next || []);
    if (exclude.has(selectedAlbumId.value)) {
      selectedAlbumId.value = "";
    }
  },
  { deep: true }
);

// 监听画册选择变化，当选择"新建"时自动聚焦输入框
watch(selectedAlbumId, (newValue) => {
  if (newValue === "__create_new__") {
    // 等待 DOM 更新后聚焦输入框
    nextTick(() => {
      if (newAlbumNameInputRef.value) {
        newAlbumNameInputRef.value.focus();
      }
    });
  } else {
    // 选择已有画册时清空新建名称
    newAlbumName.value = "";
  }
});

// 处理新建画册并加入图片
const handleCreateAndAddAlbum = async () => {
  const isTaskMode = !!props.taskId;
  if (!isTaskMode && props.imageIds.length === 0) {
    visible.value = false;
    return;
  }

  if (!newAlbumName.value.trim()) {
    ElMessage.warning("请输入画册名称");
    return;
  }

  try {
    const created = await albumStore.createAlbum(newAlbumName.value.trim());

    if (isTaskMode) {
      const result = await albumStore.addTaskImagesToAlbum(props.taskId!, created.id);
      ElMessage.success(`已创建画册「${created.name}」并加入任务全部图片（${result.added} 张）`);
    } else {
      await albumStore.addImagesToAlbum(created.id, props.imageIds);
      ElMessage.success(`已创建画册「${created.name}」并加入 ${props.imageIds.length} 张图片`);
    }

    visible.value = false;
    emit("added");
  } catch (error: any) {
    console.error("创建画册并加入图片失败:", error);
    const errorMessage = typeof error === "string"
      ? error
      : error?.message || String(error) || "操作失败";
    ElMessage.error(errorMessage);
  }
};

const confirmAddToAlbum = async () => {
  const isTaskMode = !!props.taskId;
  if (!isTaskMode && props.imageIds.length === 0) {
    visible.value = false;
    return;
  }

  const albumId = selectedAlbumId.value;
  if (!albumId) {
    ElMessage.warning("请选择画册");
    return;
  }

  try {
    if (isTaskMode) {
      const result = await albumStore.addTaskImagesToAlbum(props.taskId!, albumId);
      if (result.added === 0) {
        ElMessage.info("任务图片已全部在该画册中");
      } else {
        ElMessage.success(`已加入画册（${result.added} 张）`);
      }
      visible.value = false;
      emit("added");
      return;
    }

    // 非任务模式：过滤掉已经在画册中的图片
    let idsToAdd = props.imageIds;
    try {
      const existingIds = await albumStore.getAlbumImageIds(albumId);
      const existingSet = new Set(existingIds);
      idsToAdd = props.imageIds.filter(id => !existingSet.has(id));

      if (idsToAdd.length === 0) {
        ElMessage.info("所选图片已全部在画册中");
        visible.value = false;
        emit("added");
        return;
      }

      if (idsToAdd.length < props.imageIds.length) {
        const skippedCount = props.imageIds.length - idsToAdd.length;
        ElMessage.warning(`已跳过 ${skippedCount} 张已在画册中的图片`);
      }
    } catch (error) {
      console.error("获取画册图片列表失败:", error);
    }

    await albumStore.addImagesToAlbum(albumId, idsToAdd);
    ElMessage.success(`已加入画册（${idsToAdd.length} 张）`);
    visible.value = false;
    emit("added");
  } catch (error: any) {
    console.error("加入画册失败:", error);
    const errorMessage = error?.message || String(error);
    ElMessage.error(errorMessage || "加入画册失败");
  }
};
</script>
