<template>
  <CollapsibleDrawerPanel
    class="image-labels-panel"
    storage-key="kabegame-image-detail-labels-open"
    :fill-when-expanded="false"
    :toggle-aria-label="t('albums.imageLabelsTitle')"
  >
    <template #title>
      {{ t("albums.imageLabelsTitle") }}
    </template>
    <template #trailing>
      <button
        type="button"
        class="image-labels-icon-btn"
        :title="labelKeysText(labels)"
        :disabled="labels.length === 0"
        @click.stop="copyLabels"
      >
        <el-icon><CopyDocument /></el-icon>
      </button>
    </template>

    <div class="flex flex-col gap-2 px-3 pb-3">
      <div v-if="labels.length > 0" class="image-labels-list flex flex-wrap content-start gap-1.5">
        <el-tag
          v-for="{ label, style } in presentedLabels"
          :key="label.id"
          class="image-labels-tag"
          :style="style"
          closable
          disable-transitions
          :title="label.labelPath ?? undefined"
          @click="openLabel(label)"
          @close="removeLabel(label)"
        >
          {{ label.name }}
        </el-tag>
      </div>
      <p v-else class="m-0 text-xs text-[var(--anime-text-muted)]">
        {{ t("albums.imageLabelsEmpty") }}
      </p>

      <div v-if="picking" class="flex flex-col gap-1.5">
        <AlbumPicker
          v-model="pickedLabelId"
          :scope="{ sections: ['label'] }"
          :is-selectable="(node) => node.type === 'label' && !labels.some((label) => label.id === node.id)"
          :placeholder="t('albums.imageLabelsFilterPlaceholder')"
        />
      </div>

      <div class="flex gap-2">
        <el-button size="small" :icon="picking ? Close : Plus" @click="togglePicking">
          {{ picking ? t("common.cancel") : t("albums.imageLabelsAdd") }}
        </el-button>
        <el-button size="small" :icon="PriceTag" @click="openCreateDialog">
          {{ t("albums.imageLabelsCreate") }}
        </el-button>
      </div>
    </div>
  </CollapsibleDrawerPanel>

  <el-dialog
    :model-value="createDialog.isOpen.value"
    :z-index="createDialog.zIndex.value"
    :title="t('albums.imageLabelsCreate')"
    width="380px"
    append-to-body
    @update:model-value="createDialog.close"
    @closed="resetCreateForm"
  >
    <el-form label-width="0" @submit.prevent>
      <el-input v-model="newKey" :placeholder="t('albums.labelKeyPlaceholder')" @keyup.enter="submitCreate" />
      <p v-if="newKey && !newKeyValid" class="image-labels-error">
        {{ t("albums.labelKeyInvalidHint") }}
      </p>
      <el-input
        v-model="newName"
        class="mt-3"
        :placeholder="t('albums.labelNamePlaceholder')"
        @keyup.enter="submitCreate"
      />
      <AlbumPicker
        v-model="newParentId"
        class="mt-3"
        :scope="{ sections: ['label'], kinds: ['label_dir'] }"
        :placeholder="t('albums.selectParentLabel')"
        :picker-title="t('albums.parentAlbum')"
      />
    </el-form>
    <template #footer>
      <el-button @click="createDialog.close()">{{ t("common.cancel") }}</el-button>
      <el-button type="primary" :disabled="!newKeyValid" :loading="creating" @click="submitCreate">
        {{ t("albums.create") }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "@kabegame/i18n";
import { Close, CopyDocument, Plus, PriceTag } from "@kabegame/element-plus-icons";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import CollapsibleDrawerPanel from "@kabegame/core/components/common/CollapsibleDrawerPanel.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import { useModal } from "@kabegame/core/composables/useModal";
import type { ImageInfo } from "@kabegame/core/types/image";
import {
  addImagesToAlbum,
  createLabelAlbum,
  fetchAlbum,
  fetchImageAlbums,
  removeImagesFromAlbum,
  type Album,
} from "@/services/albums";
import { subscribeChanges } from "@/services/dataChangeHub";
import { useAlbumIdPathState } from "@/composables/useAlbumIdPathState";
import { isLabelKey } from "@/utils/labelKey";
import { labelKeysText, writeClipboardText } from "@/utils/imageLabels";
import { presentImageLabels } from "@/utils/imageLabelPresentation";

/**
 * 预览弹窗信息区的「标签」面板：列出图片直接打上的标签画册，支持删除、从已有标签添加、
 * 当场新建、复制 key 与点击跳转。已挂标签按当前图片 id 即时查询，不保留全量画册列表。
 */
const props = defineProps<{ image: ImageInfo }>();
const emit = defineEmits<{
  /** 点击标签跳到画册页后：宿主据此关闭预览弹窗 */
  navigate: [];
}>();

const { t } = useI18n();
const router = useRouter();
const albumPath = useAlbumIdPathState();

// 切图时要重置 picking，必须在 immediate watch 之前声明（否则 TDZ）
const picking = ref(false);
const labels = ref<Album[]>([]);
const presentedLabels = computed(() => presentImageLabels(labels.value));

let loadSeq = 0;
async function load() {
  const imageId = props.image.id;
  const seq = ++loadSeq;
  try {
    // 只要标签画册：走 PathQL 的 album_kind/label 段由后端过滤
    const albums = await fetchImageAlbums(imageId, ["label"]);
    // 快速切图时丢弃过期结果
    if (seq === loadSeq) labels.value = albums;
  } catch (error) {
    console.warn("load image labels failed", error);
    if (seq === loadSeq) labels.value = [];
  }
}

watch(
  () => props.image.id,
  () => {
    picking.value = false;
    void load();
  },
  { immediate: true },
);

// 其它入口（插件下载、迁移、画册页移除）改动成员，或已挂标签被改名 / 删除时同步刷新。
// 走 dataChangeHub 而非裸 listen：批次合并 + 回调串行 + 本地写命令去重都由枢纽负责。
const unsubscribe = subscribeChanges({
  waitMs: 500,
  filter: (batch) =>
    // 成员变更：命中当前图片，或事件未带 imageIds（全量）
    (batch.albumImages.size > 0 && (batch.albumImageIds.size === 0 || batch.albumImageIds.has(props.image.id))) ||
    // 结构变更：当前已挂的标签被改名 / 移动 / 删除，tag 文案要跟着变
    labels.value.some((label) => batch.albumIds.has(label.id)),
  onBatch: load,
});
onBeforeUnmount(unsubscribe);

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : (error as Error)?.message || String(error);
}

async function removeLabel(label: Album) {
  try {
    await removeImagesFromAlbum(label.id, [props.image.id]);
    labels.value = labels.value.filter((item) => item.id !== label.id);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function addLabel(label: Album) {
  try {
    await addImagesToAlbum(label.id, [props.image.id]);
    if (!labels.value.some((item) => item.id === label.id)) labels.value = [...labels.value, label];
    picking.value = false;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function copyLabels() {
  const text = labelKeysText(labels.value);
  if (!text) return;
  try {
    await writeClipboardText(text);
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制标签失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
}

async function openLabel(label: Album) {
  await albumPath.set(label.ancestorPath, { history: "push" });
  if (router.currentRoute.value.name !== "Albums") await router.push({ name: "Albums" });
  emit("navigate");
}

// ---------- 从已有标签添加 ----------

const pickedLabelId = ref<string | null>(null);
watch(pickedLabelId, async (id) => {
  if (!id) return;
  const label = await fetchAlbum(id);
  pickedLabelId.value = null;
  if (label?.type === "label") await addLabel(label);
});

async function togglePicking() {
  picking.value = !picking.value;
}

// ---------- 当场新建 ----------
const createDialog = useModal();
const newKey = ref("");
const newName = ref("");
const newParentId = ref<string | null>(null);
const creating = ref(false);
const newKeyValid = computed(() => isLabelKey(newKey.value.trim()));

function openCreateDialog() {
  createDialog.open();
}

function resetCreateForm() {
  newKey.value = "";
  newName.value = "";
  newParentId.value = null;
  creating.value = false;
}

async function submitCreate() {
  if (!newKeyValid.value || creating.value) return;
  creating.value = true;
  try {
    const created = await createLabelAlbum({
      key: newKey.value.trim(),
      name: newName.value.trim() || null,
      parentId: newParentId.value,
    });
    await addLabel(created);
    createDialog.close();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
.image-labels-tag {
  cursor: pointer;
}

/* 标签多时不撑高侧栏：最多占预览侧栏高度的 25%，内部滚动（cqh 基于 ImagePreviewDialog 左侧栏容器） */
.image-labels-list {
  max-height: 25cqh;
  overflow-y: auto;
}

.image-labels-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--anime-text-muted);
  cursor: pointer;
}

.image-labels-icon-btn:hover:not(:disabled) {
  color: var(--anime-text-secondary);
  background: rgba(167, 139, 250, 0.16);
}

.image-labels-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.image-labels-candidates {
  max-height: 180px;
  overflow-y: auto;
}

.image-labels-candidate {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--anime-text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.image-labels-candidate:hover {
  background: rgba(167, 139, 250, 0.16);
}

.image-labels-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
