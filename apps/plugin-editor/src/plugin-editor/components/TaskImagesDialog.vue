<template>
  <el-dialog v-model="visible" title="任务图片" width="90vw" top="5vh" :append-to-body="true" :close-on-click-modal="true"
    class="task-images-dialog" @open="handleOpen" @closed="handleClosed">
    <div class="dialog-body">
      <div v-if="loading" class="loading">
        <el-skeleton :rows="8" animated />
      </div>

      <el-empty v-else-if="!taskId" description="缺少 taskId" :image-size="80" />

      <ImageGrid v-else ref="gridRef" class="grid-wrapper" :images="images" :image-url-map="imageUrlMap"
        :enable-ctrl-wheel-adjust-columns="true" :enable-ctrl-key-adjust-columns="true" :show-empty-state="true"
        :context-menu-component="TaskImageContextMenu" :on-context-command="handleContextCommand" />
    </div>
  </el-dialog>

  <!-- 删除/移除确认对话框（与 main Gallery 行为一致） -->
  <RemoveImagesConfirmDialog v-model="showRemoveDialog" v-model:delete-files="removeDeleteFiles"
    :message="removeDialogMessage" title="确认删除" :confirm-loading="removeConfirmLoading"
    @confirm="confirmRemoveImages" />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import ImageGrid, { type ContextCommandPayload } from "./ImageGrid.vue";
import type { ImageUrlMap } from "@kabegame/core/types/image";
import TaskImageContextMenu from "./TaskImageContextMenu.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";

type ImageInfo = {
  id: string;
  url?: string;
  localPath: string;
  pluginId?: string;
  thumbnailPath?: string;
  taskId?: string | null;
  crawledAt?: number;
  metadata?: Record<string, string>;
};

type ImagesChangePayload = {
  reason?: string;
  imageIds?: string[];
  taskId?: string;
  albumId?: string;
};

const props = defineProps<{
  modelValue: boolean;
  taskId: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const taskId = computed(() => (props.taskId || "").trim());
const loading = ref(false);
const images = ref<ImageInfo[]>([]);
const imageUrlMap = ref<ImageUrlMap>({});
const brokenIds = new Set<string>();
const ownedBlobUrls = new Set<string>();
const gridRef = ref<any>(null);
const imagePathSigById = new Map<string, string>();

// 删除/移除确认对话框（main 同款）
const showRemoveDialog = ref(false);
const removeDeleteFiles = ref(false);
const removeDialogMessage = ref("");
const removeConfirmLoading = ref(false);
const pendingRemoveImageIds = ref<string[]>([]);

let unlistenImagesChange: null | (() => void) = null;
let reloadTimer: number | null = null;

const uiStore = useUiStore();
const settingsStore = useSettingsStore();
const { imageGridColumns } = storeToRefs(uiStore);

function markBroken(id: string) {
  brokenIds.add(id);
}

function buildImagePathSignature(img: ImageInfo) {
  const thumbPath = String(img.thumbnailPath || img.localPath || "").trim();
  const origPath = String(img.localPath || "").trim();
  return `${thumbPath}@@${origPath}`;
}

async function buildUrlItem(img: ImageInfo) {
  const thumbPath = String(img.thumbnailPath || img.localPath || "").trim();
  const origPath = String(img.localPath || "").trim();
  const thumbUrl = await fileToSrc(thumbPath);
  const origUrl = origPath && origPath !== thumbPath ? await fileToSrc(origPath) : thumbUrl;
  return { thumbnail: thumbUrl, original: origUrl };
}

function revokeBlobUrlsInMapByIds(map: ImageUrlMap, ids: string[]) {
  for (const id of ids) {
    const item = map?.[id];
    if (item?.thumbnail && item.thumbnail.startsWith("blob:")) {
      try { URL.revokeObjectURL(item.thumbnail); } catch { }
    }
    if (item?.original && item.original.startsWith("blob:")) {
      try { URL.revokeObjectURL(item.original); } catch { }
    }
  }
}

function detectMime(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  let mimeType = "image/jpeg";
  if (ext === "png") mimeType = "image/png";
  else if (ext === "gif") mimeType = "image/gif";
  else if (ext === "webp") mimeType = "image/webp";
  else if (ext === "bmp") mimeType = "image/bmp";
  return mimeType;
}

async function pathToBlobUrl(path: string): Promise<string> {
  const p = (path || "").trim();
  if (!p) return "";
  try {
    // 移除 Windows 长路径前缀 \\?\
    const normalizedPath = p.trimStart().replace(/^\\\\\?\\/, "").trim();
    if (!normalizedPath) return "";
    const fileData = await readFile(normalizedPath);
    if (!fileData || fileData.length === 0) return "";
    const blob = new Blob([fileData], { type: detectMime(normalizedPath) });
    if (blob.size === 0) return "";
    const url = URL.createObjectURL(blob);
    ownedBlobUrls.add(url);
    return url;
  } catch {
    return "";
  }
}

async function fileToSrc(path: string | undefined | null): Promise<string> {
  const p = (path || "").trim();
  if (!p) return "";
  try {
    // 在非 Tauri/某些环境下 convertFileSrc 可能返回原样路径（不会 throw），会导致浏览器尝试加载 D:\... 并报错。
    const u = convertFileSrc(p);
    const looksLikeWindowsPath = /^[a-zA-Z]:\\/.test(u) || /^[a-zA-Z]:\//.test(u);
    if (u && u !== p && !looksLikeWindowsPath) return u;
    // fallback：使用 fs.readFile + Blob URL（与主程序 ImageGrid 行为一致）
    return await pathToBlobUrl(p);
  } catch {
    return await pathToBlobUrl(p);
  }
}

async function loadTaskImages() {
  if (!taskId.value) return;
  loading.value = true;
  try {
    const list = await invoke<ImageInfo[]>("get_task_images", { taskId: taskId.value });
    images.value = list || [];

    imagePathSigById.clear();
    const map: ImageUrlMap = {};
    for (const img of images.value) {
      const id = String(img.id);
      imagePathSigById.set(id, buildImagePathSignature(img));
      map[id] = await buildUrlItem(img);
    }
    imageUrlMap.value = map;
  } finally {
    loading.value = false;
  }
}

let isRefreshingByDiff = false;
async function refreshTaskImagesByDiff() {
  if (!taskId.value) return;
  if (isRefreshingByDiff) return;
  isRefreshingByDiff = true;
  const currentTaskId = taskId.value;
  try {
    const prevImages = images.value.slice();
    const prevMap: ImageUrlMap = { ...(imageUrlMap.value || {}) };
    const prevSig = new Map(imagePathSigById);

    const nextList = (await invoke<ImageInfo[]>("get_task_images", { taskId: currentTaskId })) || [];
    if (!visible.value) return;
    if (taskId.value !== currentTaskId) return;

    const nextSig = new Map<string, string>();
    const nextIds = new Set<string>();
    for (const img of nextList) {
      const id = String(img.id);
      nextIds.add(id);
      nextSig.set(id, buildImagePathSignature(img));
    }

    const prevIds = new Set(prevImages.map((x) => String(x.id)));
    const removedIds: string[] = [];
    prevIds.forEach((id) => {
      if (!nextIds.has(id)) removedIds.push(id);
    });

    const addedOrChangedImages: ImageInfo[] = [];
    for (const img of nextList) {
      const id = String(img.id);
      const sig = nextSig.get(id) ?? "";
      const prev = prevSig.get(id);
      if (!prev || prev !== sig || !prevMap[id]) {
        addedOrChangedImages.push(img);
      }
    }

    if (removedIds.length > 0) {
      revokeBlobUrlsInMapByIds(prevMap, removedIds);
      for (const id of removedIds) delete prevMap[id];
    }

    for (const img of addedOrChangedImages) {
      const id = String(img.id);
      const prevItem = prevMap[id];
      if (prevItem) {
        revokeBlobUrlsInMapByIds(prevMap, [id]);
      }
      prevMap[id] = await buildUrlItem(img);
    }

    images.value = nextList;
    imageUrlMap.value = prevMap;
    imagePathSigById.clear();
    nextSig.forEach((v, k) => imagePathSigById.set(k, v));
  } finally {
    isRefreshingByDiff = false;
  }
}

function cleanupOwnedBlobUrls() {
  for (const u of ownedBlobUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      // ignore
    }
  }
  ownedBlobUrls.clear();
}

const revokeUrlsForIds = (ids: string[]) => {
  const nextMap: ImageUrlMap = { ...(imageUrlMap.value || {}) };
  for (const id of ids) {
    const item = nextMap[id];
    if (item?.thumbnail && item.thumbnail.startsWith("blob:")) {
      try { URL.revokeObjectURL(item.thumbnail); } catch { }
    }
    if (item?.original && item.original.startsWith("blob:")) {
      try { URL.revokeObjectURL(item.original); } catch { }
    }
    delete nextMap[id];
  }
  imageUrlMap.value = nextMap;
};

async function handleContextCommand(payload: ContextCommandPayload) {
  const command = payload.command;
  const image = payload.image as any;
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  switch (command) {
    case "detail":
      // 对齐 main：view 层 return 'detail'，由 ImageGrid wrapper 打开详情弹窗
      return "detail";
    case "open": {
      const p = String(image?.localPath || "").trim().replace(/^\\\\\?\\/, "");
      if (!p) return null;
      try {
        await invoke("open_file_path", { filePath: p });
      } catch (e) {
        console.error("打开文件失败:", e);
        ElMessage.error("打开文件失败");
      }
      return null;
    }
    case "openFolder": {
      const p = String(image?.localPath || "").trim().replace(/^\\\\\?\\/, "");
      if (!p) return null;
      const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
      const dir = idx >= 0 ? p.slice(0, idx) : p;
      if (!dir) return null;
      try {
        await invoke("open_file_path", { filePath: dir });
      } catch (e) {
        console.error("打开文件夹失败:", e);
        ElMessage.error("打开文件夹失败");
      }
      return null;
    }
    case "remove": {
      const ids = Array.from(selectedSet).map((x) => String(x));
      pendingRemoveImageIds.value = ids.length > 0 ? ids : [String(image.id)];
      const count = pendingRemoveImageIds.value.length;
      removeDialogMessage.value = `将从列表${count > 1 ? `移除这 ${count} 张图片` : "移除这张图片"}。`;
      removeDeleteFiles.value = false; // 默认不删除文件（对齐 main）
      showRemoveDialog.value = true;
      return null;
    }
    default:
      return null;
  }
}

async function confirmRemoveImages() {
  const ids = pendingRemoveImageIds.value || [];
  if (ids.length === 0) {
    showRemoveDialog.value = false;
    return;
  }

  removeConfirmLoading.value = true;
  try {
    if (removeDeleteFiles.value) {
      await invoke("batch_delete_images", { imageIds: ids });
    } else {
      await invoke("batch_remove_images", { imageIds: ids });
    }

    // 本地同步列表（对齐 main：尽量不全量 reload，避免闪烁）
    const idSet = new Set(ids);
    images.value = images.value.filter((img) => !idSet.has(String(img.id)));
    revokeUrlsForIds(ids);
    gridRef.value?.clearSelection?.();

    ElMessage.success(`已${removeDeleteFiles.value ? "删除" : "移除"} ${ids.length} 张图片`);
  } finally {
    removeConfirmLoading.value = false;
    showRemoveDialog.value = false;
    pendingRemoveImageIds.value = [];
  }
}

async function startListeners() {
  if (unlistenImagesChange) return;
  unlistenImagesChange = await listen<ImagesChangePayload>("images-change", async (event) => {
    if (!visible.value) return;
    if (!taskId.value) return;
    const p = (event.payload ?? {}) as ImagesChangePayload;
    if ((p.taskId || "").trim() !== taskId.value) return;

    // 统一策略：不做增量 patch，合并 burst 后整页刷新，确保与后端/DB 一致
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = window.setTimeout(async () => {
      reloadTimer = null;
      await refreshTaskImagesByDiff();
    }, 250);
  });
}

function stopListeners() {
  try {
    unlistenImagesChange?.();
  } catch {
    // ignore
  }
  unlistenImagesChange = null;
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

async function handleOpen() {
  await nextTick();
  // 只加载一项就够：imageClickAction（用于单击/双击行为一致）
  try {
    await settingsStore.loadMany(["imageClickAction"]);
  } catch {
    // ignore
  }
  await loadTaskImages();
  await startListeners();
}

function handleClosed() {
  stopListeners();
  images.value = [];
  imageUrlMap.value = {};
  imagePathSigById.clear();
  cleanupOwnedBlobUrls();
}

watch(
  () => taskId.value,
  async () => {
    if (!visible.value) return;
    stopListeners();
    images.value = [];
    imageUrlMap.value = {};
    imagePathSigById.clear();
    await handleOpen();
  }
);

onBeforeUnmount(() => {
  stopListeners();
});
</script>

<style>
.task-images-dialog {
  height: 90vh;
  overflow-y: auto;
}

.task-images-dialog .el-dialog__header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--el-bg-color);
}
</style>
