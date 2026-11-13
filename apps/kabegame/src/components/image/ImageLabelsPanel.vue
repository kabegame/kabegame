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
      <Tooltip :content="labelKeysText(labels)">
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="t('albums.imageLabelsCopy')"
          :disabled="labels.length === 0"
          @click.stop="copyLabels"
        >
          <Copy />
        </Button>
      </Tooltip>
    </template>

    <div class="flex flex-col gap-2.5 px-3 pb-3">
      <!-- 标签多时不撑高侧栏：最多占预览侧栏高度的 25%，内部滚动（cqh 基于 ImagePreviewDialog 左侧栏容器） -->
      <div v-if="labels.length > 0" class="flex max-h-[25cqh] flex-wrap content-start gap-1.5 overflow-y-auto">
        <!-- 同目录的标签共用一个淡色（presentImageLabels 给 --kb-label-* 变量），根级标签是中性灰 -->
        <Tag
          v-for="{ label, style } in presentedLabels"
          :key="label.id"
          class="image-labels-tag"
          :style="style"
          closable
          :title="label.labelPath ?? undefined"
          @click="openLabel(label)"
          @close="removeLabel(label)"
        >
          {{ label.name }}
        </Tag>
      </div>
      <p v-else class="m-0 text-[12px] text-kb-fg-subtle">
        {{ t("albums.imageLabelsEmpty") }}
      </p>

      <div v-if="picking" class="flex flex-col gap-1.5">
        <AlbumPicker
          v-model="pickedLabelId"
          :scope="{ sections: ['label'] }"
          :is-selectable="isLabelPickable"
          expand-label-dirs
          :placeholder="t('albums.imageLabelsFilterPlaceholder')"
        />
      </div>

      <div class="flex flex-wrap gap-2">
        <Button size="sm" @click="togglePicking">
          <X v-if="picking" />
          <Plus v-else />
          {{ picking ? t("common.cancel") : t("albums.imageLabelsAdd") }}
        </Button>
        <Button size="sm" @click="openCreateDialog">
          <TagIcon />
          {{ t("albums.imageLabelsCreate") }}
        </Button>
      </div>
    </div>
  </CollapsibleDrawerPanel>

  <Dialog v-model:open="createOpen" :title="t('albums.imageLabelsCreate')" :width="380">
    <div class="flex flex-col gap-3">
      <Field :error="newKey && !newKeyValid ? t('albums.labelKeyInvalidHint') : undefined">
        <Input v-model="newKey" :placeholder="t('albums.labelKeyPlaceholder')" @keyup.enter="submitCreate" />
      </Field>
      <Input v-model="newName" :placeholder="t('albums.labelNamePlaceholder')" @keyup.enter="submitCreate" />
      <AlbumPicker
        v-model="newParentId"
        :scope="{ sections: ['label'], kinds: ['label_dir'] }"
        :placeholder="t('albums.selectParentLabel')"
        :picker-title="t('albums.parentAlbum')"
      />
    </div>
    <template #footer>
      <Button @click="createOpen = false">{{ t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="!newKeyValid || creating" @click="submitCreate">
        <Spinner v-if="creating" :size="14" />
        {{ t("albums.create") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { onScopeDispose, computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "@kabegame/i18n";
import { Copy, Plus, Tag as TagIcon, X } from "@lucide/vue";
import { Button, Dialog, Field, Input, Spinner, Tag, Tooltip } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import CollapsibleDrawerPanel from "@/components/common/CollapsibleDrawerPanel.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import type { ImageInfo } from "@/types/image";
import {
  FAVORITE_ALBUM_ID,
  HIDDEN_ALBUM_ID,
  addImagesToAlbum,
  createLabelAlbum,
  fetchAlbum,
  imageAlbumsPath,
  normalizeAlbumRow,
  removeImagesFromAlbum,
  type Album,
  type AlbumNode,
} from "@/services/albums";
import {
  on,
  pathqlRequest$,
  usePathqlLooker,
  albumPatchTriggers,
  kbEvent$,
  moveAlbumPath,
  pathHasAlbum,
  type AlbumMovedPayload,
} from "@/services/kbEvents";
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

// 只要标签画册：走 PathQL 的 album_kind/label 段由后端过滤
const labelsKey = computed(() => imageAlbumsPath(props.image.id, ["label"]));
const requestLabels = () => pathqlRequest$.next(["rows", labelsKey.value]);

// 切图是用户操作：先清掉上一张的标签，再请求新 key，避免新图上残留旧标签
watch(
  labelsKey,
  () => {
    picking.value = false;
    labels.value = [];
    requestLabels();
  },
  { immediate: true, flush: "sync" },
);

// 其它入口（插件下载、迁移、画册页移除）改动成员，或已挂标签被改名 / 删除时，由核心窗口重读。
usePathqlLooker({
  kind: "rows",
  key: () => labelsKey.value,
  refreshOn: [
    // 收藏 / 隐藏不是标签，交给图片补丁流。
    on(
      "album-images-added",
      (p) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(p.albumId) && p.imageIds.includes(props.image.id),
    ),
    on(
      "album-images-deleted",
      (p) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(p.albumId) && p.imageIds.includes(props.image.id),
    ),
    ...albumPatchTriggers((patch) => labels.value.some((label) => label.id === patch.id)),
    on("album-moved", (p) => labels.value.some((label) => pathHasAlbum(label.ancestorPath, p.id))),
    on("albums-deleted", (p) =>
      labels.value.some((label) =>
        p.albums.some((a) => !a.ancestorPath || label.ancestorPath.startsWith(a.ancestorPath)),
      ),
    ),
  ],
  onResult: ({ rows }) => {
    labels.value = rows.map((row) => normalizeAlbumRow(row as Record<string, unknown>));
  },
  // 读取失败保留已有标签
  onError: (error) => console.warn("load image labels failed", error),
});

const movedPaths = kbEvent$<AlbumMovedPayload>("album-moved").subscribe(({ payload }) => {
  labels.value = labels.value.map((label) => moveAlbumPath(label, payload));
});
onScopeDispose(() => movedPaths.unsubscribe());

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : (error as Error)?.message || String(error);
}

async function removeLabel(label: Album) {
  try {
    await removeImagesFromAlbum(label.id, [props.image.id]);
    // 本地先改给即时反馈；这是用户操作，写完再请求一次，结果以数据源为准
    labels.value = labels.value.filter((item) => item.id !== label.id);
    requestLabels();
  } catch (error) {
    kameMessage.error(errorMessage(error));
  }
}

async function addLabel(label: Album) {
  try {
    await addImagesToAlbum(label.id, [props.image.id]);
    if (!labels.value.some((item) => item.id === label.id)) labels.value = [...labels.value, label];
    requestLabels();
    picking.value = false;
  } catch (error) {
    kameMessage.error(errorMessage(error));
  }
}

async function copyLabels() {
  const text = labelKeysText(labels.value);
  if (!text) return;
  try {
    await writeClipboardText(text);
    kameMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制标签失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
}

async function openLabel(label: Album) {
  await albumPath.set(label.ancestorPath, { history: "push" });
  if (router.currentRoute.value.name !== "Albums") await router.push({ name: "Albums" });
  emit("navigate");
}

// ---------- 从已有标签添加 ----------

const pickedLabelId = ref<string | null>(null);
// 目录不能挂图，但必须保持可用：禁用行连展开箭头一起锁死，插件建的目录下的标签就选不到了。
// 配合 expand-label-dirs，目录行点击只展开、不会触发选择。
function isLabelPickable(node: AlbumNode) {
  if (node.type === "label_dir") return true;
  return node.type === "label" && !labels.value.some((label) => label.id === node.id);
}
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
const createOpen = ref(false);
const newKey = ref("");
const newName = ref("");
const newParentId = ref<string | null>(null);
const creating = ref(false);
const newKeyValid = computed(() => isLabelKey(newKey.value.trim()));

// 打开时清空上一次的输入（关闭时不清：免得关闭动画里内容先变空）
function openCreateDialog() {
  resetCreateForm();
  createOpen.value = true;
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
    createOpen.value = false;
  } catch (error) {
    kameMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
/* 目录色板：presentImageLabels 给的 --kb-label-* 盖掉 Tag 中性色调；带 scoped 属性的选择器比 Uno 工具类更具体 */
.image-labels-tag {
  background-color: var(--kb-label-bg);
  color: var(--kb-label-fg);
  cursor: pointer;
}

.image-labels-tag:hover {
  color: var(--kb-label-hover);
}
</style>
