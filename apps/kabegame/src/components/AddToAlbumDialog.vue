<template>
  <Dialog
    :open="open"
    :title="$t('albums.addToAlbumTitle')"
    :width="420"
    @update:open="
      (v: boolean) => {
        if (!v) emit('close');
      }
    "
  >
    <div class="flex flex-col gap-4 [--kb-field-label-width:100px]">
      <Field :label="$t('albums.selectAlbum')" orientation="horizontal">
        <AlbumPicker
          v-model="selectedAlbumId"
          :scope="albumScope"
          expand-label-dirs
          allow-create
          :placeholder="$t('albums.chooseAlbumPlaceholder')"
          :picker-title="$t('albums.selectAlbum')"
        />
      </Field>
      <Field v-if="isCreatingNewAlbum" :label="$t('albums.placeholderName')" orientation="horizontal" required>
        <Input
          ref="newAlbumNameInputRef"
          v-model="newAlbumName"
          :placeholder="$t('albums.placeholderName')"
          maxlength="50"
          @keyup.enter="handleCreateAndAddAlbum"
        >
          <template #suffix>
            <span class="text-[11.5px] tabular-nums">{{ newAlbumName.length }}/50</span>
          </template>
        </Input>
      </Field>
      <Field v-if="isCreatingNewAlbum" :label="$t('albums.parentAlbum')" orientation="horizontal">
        <AlbumPicker
          v-model="newAlbumParentId"
          :scope="{ sections: ['normal'] }"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />
      </Field>
    </div>
    <template #footer>
      <Button @click="emit('close')">{{ $t("common.cancel") }}</Button>
      <Button
        v-if="isCreatingNewAlbum"
        variant="primary"
        :disabled="!newAlbumName.trim()"
        @click="handleCreateAndAddAlbum"
      >
        {{ $t("common.confirm") }}
      </Button>
      <Button v-else variant="primary" :disabled="!selectedAlbumId" @click="confirmAddToAlbum">
        {{ $t("common.confirm") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { HIDDEN_ALBUM_ID, addImagesToAlbum, addTaskImagesToAlbum, createAlbum } from "@/services/albums";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import { Button, Dialog, Field, Input } from "@/components/ui";
import type { GridRefreshContext } from "@/components/imageGrid/types";

interface Props {
  open: boolean;
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
  /** ImageGrid 内传入主动视图更新；其它调用方缺省为不带 view 的写入。 */
  mutate?: GridRefreshContext["mutate"];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "added"): void;
}>();

const { t } = useI18n();
const excludedAlbumIds = computed(() => [HIDDEN_ALBUM_ID, ...(props.excludeAlbumIds ?? [])]);
const albumScope = computed(() => ({
  sections: ["system", "normal", "label"] as const,
  excludeIds: excludedAlbumIds.value,
}));

const selectedAlbumId = ref<string | null>(null);
const newAlbumName = ref<string>("");
const newAlbumParentId = ref<string | null>(null);
const newAlbumNameInputRef = ref<InstanceType<typeof Input> | null>(null);

// 是否正在创建新画册
const isCreatingNewAlbum = computed(() => selectedAlbumId.value === "__create_new__");

const runMutation = <T,>(operation: () => Promise<T>) => (props.mutate ? props.mutate(operation) : operation());

watch(
  () => props.open,
  async (v) => {
    if (!v) {
      selectedAlbumId.value = null;
      newAlbumName.value = "";
      newAlbumParentId.value = null;
    }
  },
);

// 如果排除列表变化，且当前选中的 album 被排除了，则重置选择
watch(
  excludedAlbumIds,
  (next) => {
    if (!selectedAlbumId.value) return;
    const exclude = new Set(next);
    if (exclude.has(selectedAlbumId.value)) {
      selectedAlbumId.value = null;
    }
  },
  { deep: true },
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
    newAlbumParentId.value = null;
  }
});

// 处理新建画册并加入图片
const handleCreateAndAddAlbum = async () => {
  const isTaskMode = !!props.taskId;
  if (!isTaskMode && props.imageIds.length === 0) {
    emit("close");
    return;
  }

  if (!newAlbumName.value.trim()) {
    kameMessage.warning(t("albums.enterAlbumNameFirst"));
    return;
  }

  try {
    const parentId = newAlbumParentId.value?.trim() || null;
    const created = await createAlbum(newAlbumName.value.trim(), {
      parentId,
      reload: false,
    });

    if (isTaskMode) {
      const result = await runMutation(() => addTaskImagesToAlbum(props.taskId!, created.id));
      kameMessage.success(t("albums.createAlbumAndAddTask", { name: created.name, count: result.added }));
    } else {
      const result = await runMutation(() => addImagesToAlbum(created.id, props.imageIds));
      kameMessage.success(t("albums.createAlbumAndAdd", { name: created.name, count: result.added }));
    }

    emit("close");
    emit("added");
  } catch (error: any) {
    console.error("创建画册并加入图片失败:", error);
    const errorMessage = typeof error === "string" ? error : error?.message || String(error) || "操作失败";
    kameMessage.error(errorMessage);
  }
};

const confirmAddToAlbum = async () => {
  const isTaskMode = !!props.taskId;
  if (!isTaskMode && props.imageIds.length === 0) {
    emit("close");
    return;
  }

  const albumId = selectedAlbumId.value;
  if (!albumId) {
    kameMessage.warning(t("albums.selectAlbumFirst"));
    return;
  }

  try {
    if (isTaskMode) {
      const result = await runMutation(() => addTaskImagesToAlbum(props.taskId!, albumId));
      if (result.added === 0) {
        kameMessage.info(t("albums.allInAlbum"));
      } else {
        kameMessage.success(t("albums.addedToAlbum", { count: result.added }));
      }
      emit("close");
      emit("added");
      return;
    }

    const result = await runMutation(() => addImagesToAlbum(albumId, props.imageIds));
    const skippedCount = result.attempted - result.added;
    if (result.added === 0) {
      kameMessage.info(t("albums.allInAlbum"));
    } else {
      if (skippedCount > 0) {
        kameMessage.warning(t("albums.skippedInAlbum", { count: skippedCount }));
      }
      kameMessage.success(t("albums.addedToAlbum", { count: result.added }));
    }
    emit("close");
    emit("added");
  } catch (error: any) {
    console.error("加入画册失败:", error);
    const errorMessage = error?.message || String(error);
    kameMessage.error(errorMessage || "加入画册失败");
  }
};
</script>
