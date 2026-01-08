<template>
  <el-dialog v-model="visible" title="任务图片" width="92%" top="6vh" :append-to-body="true" :close-on-click-modal="true"
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
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import ImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import type { ImageUrlMap } from "@kabegame/core/types/image";
import TaskImageContextMenu from "./TaskImageContextMenu.vue";

type ImageInfo = {
  id: string;
  localPath: string;
  thumbnailPath?: string;
  taskId?: string | null;
};

type ImageAddedPayload = {
  taskId: string;
  imageId: string;
  image?: any;
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

let unlistenImageAdded: null | (() => void) = null;

const uiStore = useUiStore();
const settingsStore = useSettingsStore();
const { imageGridColumns } = storeToRefs(uiStore);
const { values } = storeToRefs(settingsStore);

function markBroken(id: string) {
  brokenIds.add(id);
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

    const map: ImageUrlMap = {};
    for (const img of images.value) {
      const p = (img.thumbnailPath || img.localPath || "").trim();
      const u = await fileToSrc(p);
      map[img.id] = { thumbnail: u, original: "" };
    }
    imageUrlMap.value = map;
  } finally {
    loading.value = false;
  }
}

async function startListeners() {
  if (unlistenImageAdded) return;
  unlistenImageAdded = await listen<ImageAddedPayload>("image-added", async (event) => {
    if (!taskId.value) return;
    if (event.payload?.taskId !== taskId.value) return;
    const raw = event.payload.image as any;
    if (!raw?.id) return;
    if (images.value.some((x) => x.id === raw.id)) return;

    const img: ImageInfo = {
      id: String(raw.id),
      localPath: String(raw.localPath || ""),
      thumbnailPath: raw.thumbnailPath ? String(raw.thumbnailPath) : undefined,
      taskId: raw.taskId ? String(raw.taskId) : undefined,
    };

    images.value = [...images.value, img];
    const u = await fileToSrc((img.thumbnailPath || img.localPath || "").trim());
    imageUrlMap.value = {
      ...imageUrlMap.value,
      [img.id]: { thumbnail: u, original: "" },
    };
  });
}

function stopListeners() {
  try {
    unlistenImageAdded?.();
  } catch {
    // ignore
  }
  unlistenImageAdded = null;
}

async function handleContextCommand(_payload: any) {
  // plugin-editor：目前仅用于展示/预览，不在这里落地右键业务（避免依赖 main 的后端命令集）
  return null;
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
  // 释放本对话框创建的 blob url，避免内存泄漏
  for (const u of ownedBlobUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      // ignore
    }
  }
  ownedBlobUrls.clear();
}

watch(
  () => taskId.value,
  async () => {
    if (!visible.value) return;
    stopListeners();
    images.value = [];
    imageUrlMap.value = {};
    await handleOpen();
  }
);

onBeforeUnmount(() => {
  stopListeners();
});
</script>

<style scoped>
.dialog-body {
  height: 72vh;
  overflow: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(v-bind(imageGridColumns), minmax(0, 1fr));
  gap: 10px;
  padding: 8px;
}

.cell {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}

.thumb {
  width: 100%;
  height: 140px;
  object-fit: cover;
  display: block;
}

.preview-img {
  width: 100%;
  height: auto;
  display: block;
}
</style>
