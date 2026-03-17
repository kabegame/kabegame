<template>
  <el-dialog v-model="visible" :title="$t('albums.addToAlbumTitle')" width="420px">
    <el-form label-width="80px">
      <el-form-item :label="$t('albums.selectAlbum')">
        <el-select v-model="selectedAlbumId" :placeholder="$t('albums.chooseAlbumPlaceholder')" style="width: 100%">
          <el-option v-for="album in filteredAlbums" :key="album.id" :label="album.name" :value="album.id" />
          <el-option value="__create_new__" :label="$t('albums.createNewAlbum')">
            <span style="color: var(--el-color-primary); font-weight: 500;">{{ $t('albums.createNewAlbum') }}</span>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item v-if="isCreatingNewAlbum" :label="$t('albums.placeholderName')" required>
        <el-input v-model="newAlbumName" :placeholder="$t('albums.placeholderName')" maxlength="50" show-word-limit
          @keyup.enter="handleCreateAndAddAlbum" ref="newAlbumNameInputRef" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
      <el-button v-if="isCreatingNewAlbum" type="primary" :disabled="!newAlbumName.trim()"
        @click="handleCreateAndAddAlbum">{{ $t('common.confirm') }}</el-button>
      <el-button v-else type="primary" :disabled="!selectedAlbumId" @click="confirmAddToAlbum">{{ $t('common.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
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

const { t } = useI18n();
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
    ElMessage.warning(t('albums.enterAlbumNameFirst'));
    return;
  }

  try {
    const created = await albumStore.createAlbum(newAlbumName.value.trim());

    if (isTaskMode) {
      const result = await albumStore.addTaskImagesToAlbum(props.taskId!, created.id);
      ElMessage.success(t('albums.createAlbumAndAddTask', { name: created.name, count: result.added }));
    } else {
      await albumStore.addImagesToAlbum(created.id, props.imageIds);
      ElMessage.success(t('albums.createAlbumAndAdd', { name: created.name, count: props.imageIds.length }));
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
    ElMessage.warning(t('albums.selectAlbumFirst'));
    return;
  }

  try {
    if (isTaskMode) {
      const result = await albumStore.addTaskImagesToAlbum(props.taskId!, albumId);
      if (result.added === 0) {
        ElMessage.info(t('albums.allInAlbum'));
      } else {
        ElMessage.success(t('albums.addedToAlbum', { count: result.added }));
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
        ElMessage.info(t('albums.allInAlbum'));
        visible.value = false;
        emit("added");
        return;
      }

      if (idsToAdd.length < props.imageIds.length) {
        const skippedCount = props.imageIds.length - idsToAdd.length;
        ElMessage.warning(t('albums.skippedInAlbum', { count: skippedCount }));
      }
    } catch (error) {
      console.error("获取画册图片列表失败:", error);
    }

    await albumStore.addImagesToAlbum(albumId, idsToAdd);
    ElMessage.success(t('albums.addedToAlbum', { count: idsToAdd.length }));
    visible.value = false;
    emit("added");
  } catch (error: any) {
    console.error("加入画册失败:", error);
    const errorMessage = error?.message || String(error);
    ElMessage.error(errorMessage || "加入画册失败");
  }
};
</script>
