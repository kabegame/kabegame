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
        <el-select
          v-model="selectedOutputAlbumId"
          :placeholder="$t('albums.notSpecifiedAddToGallery')"
          clearable
          style="width: 100%"
        >
          <el-option
            v-for="album in albums"
            :key="album.id"
            :label="album.name"
            :value="album.id"
          />
          <el-option value="__create_new__" :label="$t('albums.createNewAlbum')">
            <span style="color: var(--el-color-primary); font-weight: 500">{{ $t('albums.createNewAlbum') }}</span>
          </el-option>
        </el-select>
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

      <el-form-item v-if="paths.length > 0" :label="$t('common.selectedPaths')">
        <div class="paths-list">
          <div
            v-for="(p, idx) in paths"
            :key="idx"
            class="path-item"
          >
            <span class="path-text">{{ p }}</span>
            <el-button type="danger" link size="small" @click="removePath(idx)">
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
      <el-form-item :label="$t('albums.includeArchiveLabel')">
        <el-checkbox v-model="includeArchive">
          {{ $t('albums.includeArchiveScan') }}
        </el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :disabled="paths.length === 0" @click="handleSubmit">
          {{ $t('albums.startImport') }}
        </el-button>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Document, FolderOpened } from "@element-plus/icons-vue";
import { ElDialog, ElMessage } from "element-plus";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCrawlerStore } from "@/stores/crawler";
import { useImageTypes } from "@/composables/useImageTypes";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

interface Album {
  id: string;
  name: string;
}

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
const { extensions: imageExtensions, load: loadImageTypes } = useImageTypes();

const albums = ref<Album[]>([]);
const selectedOutputAlbumId = ref<string | undefined>();
const newOutputAlbumName = ref("");
const paths = ref<string[]>([]);
const recursive = ref(true);
const includeArchive = ref(false);
const isCreatingNewOutputAlbum = computed(
  () => selectedOutputAlbumId.value === "__create_new__"
);

function hasExplicitArchivePath(path: string): boolean {
  return /\.(zip|rar)$/i.test(path.trim());
}

async function loadAlbums() {
  try {
    const list = await invoke<Album[]>("get_albums");
    albums.value = list ?? [];
  } catch (e) {
    console.error("加载画册列表失败:", e);
    albums.value = [];
  }
}

async function handleAddFiles() {
  try {
    await loadImageTypes();
    const exts = imageExtensions.value.length ? imageExtensions.value : ["jpg", "jpeg", "png", "gif", "webp", "bmp", "mp4", "mov"];
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [
        { name: t('common.media'), extensions: exts },
        { name: t('common.archive'), extensions: ["zip", "rar"] },
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

// TODO: web实现本地导入和服务器不同
async function handleAddFolder() {
  try {
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

function removePath(idx: number) {
  paths.value.splice(idx, 1);
}

async function handleCreateOutputAlbum() {
  const name = newOutputAlbumName.value.trim();
  if (!name) {
          ElMessage.warning(t('albums.enterAlbumNameFirst'));
    return;
  }
  try {
    const album = await invoke<{ id: string; name: string }>("add_album", { name });
    if (album?.id) {
      albums.value.push({ id: album.id, name: album.name });
      selectedOutputAlbumId.value = album.id;
      newOutputAlbumName.value = "";
    }
  } catch (e) {
    console.error("创建画册失败:", e);
    ElMessage.error(t('albums.createAlbumFailed'));
  }
}

async function handleSubmit() {
  if (paths.value.length === 0) {
    ElMessage.warning(t('albums.addPathFirst'));
    return;
  }

  let outputAlbumId: string | undefined;
  if (selectedOutputAlbumId.value === "__create_new__") {
    const name = newOutputAlbumName.value.trim();
    if (!name) {
      ElMessage.warning(t('albums.enterAlbumNameFirst'));
      return;
    }
    try {
      const album = await invoke<{ id: string; name: string }>("add_album", { name });
      outputAlbumId = album?.id;
    } catch (e) {
      console.error("创建画册失败:", e);
      ElMessage.error(t('albums.createAlbumFailed'));
      return;
    }
  } else if (selectedOutputAlbumId.value) {
    outputAlbumId = selectedOutputAlbumId.value;
  }

  const hasArchiveFiles = paths.value.some(hasExplicitArchivePath);
  const effectiveIncludeArchive = includeArchive.value || hasArchiveFiles;

  crawlerStore.addTask("local-import", undefined, {
    paths: paths.value,
    recursive: recursive.value,
    include_archive: effectiveIncludeArchive,
  }, outputAlbumId);

  visible.value = false;
  paths.value = [];
  ElMessage.success(t('gallery.localImportTaskAdded'));
}

function handleOpen() {
  loadAlbums();
}

function handleClosed() {
  paths.value = [];
  newOutputAlbumName.value = "";
  selectedOutputAlbumId.value = undefined;
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
