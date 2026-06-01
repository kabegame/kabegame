<template>
  <ElDialog
    v-model="visible"
    :title="$t('albums.localImport')"
    width="560px"
    class="local-import-dialog"
    :show-close="true"
    @open="handleOpen"
    @closed="handleClosed">
    <el-form label-width="110px" class="local-import-form">
      <el-form-item :label="$t('albums.outputAlbum')">
        <AlbumPickerField
          v-model="selectedOutputAlbumId"
          :album-tree="outputAlbumTree"
          :album-counts="albumCounts"
          allow-create
          :placeholder="$t('albums.notSpecifiedAddToGallery')"
          :picker-title="$t('albums.outputAlbum')"
          clearable
        />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <el-input
          v-model="newOutputAlbumName"
          :placeholder="$t('albums.placeholderName')"
          maxlength="50"
          show-word-limit
          @keyup.enter="handleCreateOutputAlbum"
        />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.parentAlbum')">
        <AlbumPickerField
          v-model="newOutputAlbumParentId"
          :album-tree="outputAlbumParentTree"
          :album-counts="albumCounts"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />
      </el-form-item>

      <el-form-item :label="$t('albums.selectPath')">
        <div class="path-picker-actions">
          <el-button @click="handleAddFiles">
            <el-icon><Document /></el-icon>
            {{ $t('common.addFiles') }}
          </el-button>
          <el-button @click="handleAddFolder">
            <el-icon><FolderOpened /></el-icon>
            {{ $t('common.addFolder') }}
          </el-button>
        </div>
      </el-form-item>

      <el-form-item v-if="displayItems.length > 0" :label="$t('common.selectedPaths')">
        <div class="paths-list">
          <div
            v-for="(label, idx) in displayItems"
            :key="idx"
            class="path-item"
          >
            <span class="path-text">{{ label }}</span>
            <el-button type="danger" link size="small" @click="removeItem(idx)">
              {{ $t('common.remove') }}
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item :label="$t('albums.recursiveSubdirsLabel')">
        <el-checkbox v-model="recursive">
          {{ $t('albums.recursiveSubdirs') }}
        </el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :disabled="displayItems.length === 0" @click="handleSubmit">
          {{ $t('albums.startImport') }}
        </el-button>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Document, FolderOpened } from "@element-plus/icons-vue";
import { ElDialog, ElMessage } from "element-plus";
import { open } from "@tauri-apps/plugin-dialog";
import { storeToRefs } from "pinia";
import { IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";
import { uploadImport } from "@/api/rpc";
import { useCrawlerStore } from "@/stores/crawler";
import { useAlbumStore, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useImageTypes } from "@/composables/useImageTypes";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";

const { t } = useI18n();
const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

useModalBack(visible);

const crawlerStore = useCrawlerStore();
const albumStore = useAlbumStore();
const { albumCounts } = storeToRefs(albumStore);
const { extensions: imageExtensions, load: loadImageTypes } = useImageTypes();

const outputAlbumTree = computed(() => albumStore.getAlbumTreeExcluding([HIDDEN_ALBUM_ID]));
const outputAlbumParentTree = computed(() =>
  albumStore.getAlbumTreeExcluding([FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID]),
);
const selectedOutputAlbumId = ref<string | null>(null);
const newOutputAlbumName = ref("");
const newOutputAlbumParentId = ref<string | null>(null);
const paths = ref<string[]>([]);
const files = ref<File[]>([]);
const recursive = ref(true);
const isCreatingNewOutputAlbum = computed(
  () => selectedOutputAlbumId.value === "__create_new__"
);
watch(selectedOutputAlbumId, (value) => {
  if (value !== "__create_new__") {
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
  }
});
const displayItems = computed(() =>
  IS_WEB ? files.value.map((f) => f.name) : paths.value,
);

function trackLocalImportStart(data: Record<string, unknown>) {
  if (!IS_WEB) return;
  trackEvent("gallery_import_start", {
    plugin_id: "local-import",
    source: "local",
    ...data,
  });
}

function pickWebFiles(directory: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (directory) {
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    }
    input.style.display = "none";
    let settled = false;
    const finish = (list: File[]) => {
      if (settled) return;
      settled = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(list);
    };
    input.addEventListener("change", () => {
      finish(input.files ? Array.from(input.files) : []);
    });
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

async function loadAlbums() {
  try {
    await albumStore.loadAlbums();
  } catch (e) {
    console.error("加载画册列表失败:", e);
  }
}

async function handleAddFiles() {
  try {
    await loadImageTypes();
    if (IS_WEB) {
      const picked = await pickWebFiles(false);
      for (const f of picked) {
        if (!files.value.some((x) => x.name === f.name && x.size === f.size)) {
          files.value.push(f);
        }
      }
      return;
    }
    const exts = imageExtensions.value.length ? imageExtensions.value : ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "mp4", "mov"];
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [
        { name: t('common.media'), extensions: exts },
      ],
    });

    if (!selected) return;

    const arr = Array.isArray(selected) ? selected : [selected];
    for (const p of arr) {
      if (p && !paths.value.includes(p)) {
        paths.value.push(p);
      }
    }
  } catch (e) {
    if (e !== "cancel" && e !== "close") {
      console.error("选择文件失败:", e);
      ElMessage.error(t('albums.selectFileFailed'));
    }
  }
}

async function handleAddFolder() {
  try {
    if (IS_WEB) {
      const picked = await pickWebFiles(true);
      for (const f of picked) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (!files.value.some((x) => ((x as File & { webkitRelativePath?: string }).webkitRelativePath || x.name) === rel)) {
          files.value.push(f);
        }
      }
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
    });

    if (!selected) return;

    const pathStr = typeof selected === "string" ? selected : selected?.[0];
    if (pathStr && !paths.value.includes(pathStr)) {
      paths.value.push(pathStr);
    }
  } catch (e) {
    if (e !== "cancel" && e !== "close") {
      console.error("选择文件夹失败:", e);
      ElMessage.error(t('albums.selectFolderFailed'));
    }
  }
}

function removeItem(idx: number) {
  if (IS_WEB) {
    files.value.splice(idx, 1);
  } else {
    paths.value.splice(idx, 1);
  }
}

async function createOutputAlbum(showSuccess = true) {
  const name = newOutputAlbumName.value.trim();
  if (!name) {
    ElMessage.warning(t('albums.enterAlbumNameFirst'));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const album = await albumStore.createAlbum(name, { parentId, reload: false });
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
    if (showSuccess) {
      ElMessage.success(t('albums.albumCreated'));
    }
    return album;
  } catch (e) {
    console.error("创建画册失败:", e);
    ElMessage.error(t('albums.createAlbumFailed'));
    return null;
  }
}

async function handleCreateOutputAlbum() {
  const album = await createOutputAlbum();
  if (album?.id) {
    selectedOutputAlbumId.value = album.id;
  }
}

async function handleSubmit() {
  if (displayItems.value.length === 0) {
    ElMessage.warning(t('albums.addPathFirst'));
    return;
  }

  if (await guardDesktopOnly("localImport", { needSuper: true })) return;

  let outputAlbumId: string | undefined;
  if (selectedOutputAlbumId.value === "__create_new__") {
    const album = await createOutputAlbum(false);
    if (!album?.id) return;
    outputAlbumId = album.id;
  } else if (selectedOutputAlbumId.value) {
    outputAlbumId = selectedOutputAlbumId.value;
  }

  if (IS_WEB) {
    const fileCount = files.value.length;
    try {
      await uploadImport(files.value, {
        outputAlbumId,
        recursive: recursive.value,
      });
    } catch (e) {
      console.error("上传导入失败:", e);
      ElMessage.error(t('albums.selectFileFailed'));
      return;
    }
    visible.value = false;
    files.value = [];
    ElMessage.success(t('gallery.localImportTaskAdded'));
    trackLocalImportStart({
      mode: "upload",
      file_count: fileCount,
      recursive: recursive.value,
      output_album: outputAlbumId ? "existing" : "none",
    });
    return;
  }

  const pathCount = paths.value.length;

  crawlerStore.addTask("local-import", undefined, {
    paths: paths.value,
    recursive: recursive.value,
  }, outputAlbumId);

  visible.value = false;
  paths.value = [];
  ElMessage.success(t('gallery.localImportTaskAdded'));
  trackLocalImportStart({
    mode: "task",
    path_count: pathCount,
    recursive: recursive.value,
    output_album: outputAlbumId ? "existing" : "none",
  });
}

function handleOpen() {
  loadAlbums();
}

function handleClosed() {
  paths.value = [];
  files.value = [];
  newOutputAlbumName.value = "";
  newOutputAlbumParentId.value = null;
  selectedOutputAlbumId.value = null;
}
</script>

<style lang="scss" scoped>
.local-import-form {
  padding: 0 8px;
}

.path-picker-actions {
  display: flex;
  gap: 12px;
}

.paths-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.path-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: none;
  }
}

.path-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  word-break: break-all;
  color: var(--el-text-color-regular);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
