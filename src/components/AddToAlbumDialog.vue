<template>
  <el-dialog v-model="visible" title="加入画册" width="420px">
    <el-form label-width="80px">
      <el-form-item label="选择画册">
        <el-select v-model="selectedAlbumId" placeholder="选择一个心仪的画册吧" style="width: 100%" clearable>
          <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="新建画册">
        <el-input v-model="newAlbumName" placeholder="输入新画册名称（可选）" />
      </el-form-item>
      <div style="color: var(--anime-text-muted); font-size: 12px; padding-left: 80px;">
        如果同时选择已有画册和新建名称，将优先创建新画册。
      </div>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canConfirm" @click="handleConfirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import { useAlbumStore } from "@/stores/albums";

interface Props {
  modelValue: boolean;
  imageIds: string[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "added"): void;
}>();

const albumStore = useAlbumStore();
const { albums } = storeToRefs(albumStore);

const selectedAlbumId = ref<string>("");
const newAlbumName = ref<string>("");

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

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

const canConfirm = computed(() => {
  return (newAlbumName.value.trim().length > 0 || selectedAlbumId.value.length > 0) && props.imageIds.length > 0;
});

const handleConfirm = async () => {
  try {
    let targetAlbumId = selectedAlbumId.value;
    const name = newAlbumName.value.trim();
    const isNewAlbum = !targetAlbumId && name;
    if (name) {
      const created = await albumStore.createAlbum(name);
      targetAlbumId = created.id;
    }
    if (!targetAlbumId) {
      ElMessage.warning("请选择画册或新建画册");
      return;
    }

    // 如果是已有画册，过滤掉已经在画册中的图片
    let idsToAdd = props.imageIds;
    if (!isNewAlbum) {
      try {
        const existingIds = await albumStore.getAlbumImageIds(targetAlbumId);
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
      } catch (e) {
        console.error("获取画册图片列表失败:", e);
        // 如果获取失败，仍然尝试添加（后端有 INSERT OR IGNORE 保护）
      }
    }

    await albumStore.addImagesToAlbum(targetAlbumId, idsToAdd);
    visible.value = false;
    emit("added");
  } catch (e: any) {
    console.error("加入画册失败:", e);
    const errorMessage = e?.message || String(e);
    ElMessage.error(errorMessage || "加入画册失败");
  }
};
</script>
