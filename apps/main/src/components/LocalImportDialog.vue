<template>
  <!-- Android：自研全宽抽屉 -->
  <AndroidDrawer
    v-if="IS_ANDROID"
    v-model="visible"
    @opened="handleOpen"
    @closed="handleClosed">
    <template #header>
      <div class="local-import-drawer-header">
        <h3>本地导入</h3>
      </div>
    </template>
    <el-form label-width="110px" class="local-import-form">
      <el-form-item label="输出画册">
        <el-select
          v-model="selectedOutputAlbumId"
          placeholder="不指定（仅添加到画廊）"
          clearable
          style="width: 100%"
        >
          <el-option
            v-for="album in albums"
            :key="album.id"
            :label="album.name"
            :value="album.id"
          />
          <el-option value="__create_new__" label="+ 新建画册">
            <span style="color: var(--el-color-primary); font-weight: 500">+ 新建画册</span>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" label="画册名称" required>
        <el-input
          v-model="newOutputAlbumName"
          placeholder="请输入画册名称"
          maxlength="50"
          show-word-limit
          @keyup.enter="handleCreateOutputAlbum"
        />
      </el-form-item>

      <el-form-item label="选择路径">
        <div class="path-picker-actions">
          <el-button @click="handleAddFiles">
            <el-icon><Document /></el-icon>
            添加文件
          </el-button>
          <el-button @click="handleAddFolder">
            <el-icon><FolderOpened /></el-icon>
            添加文件夹
          </el-button>
        </div>
      </el-form-item>

      <el-form-item v-if="paths.length > 0" label="已选路径">
        <div class="paths-list">
          <div
            v-for="(p, idx) in paths"
            :key="idx"
            class="path-item"
          >
            <span class="path-text">{{ p }}</span>
            <el-button type="danger" link size="small" @click="removePath(idx)">
              移除
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="递归子文件夹">
        <el-checkbox v-model="recursive">
          递归扫描子文件夹中的图片
        </el-checkbox>
      </el-form-item>
      <el-form-item label="包含压缩包">
        <el-checkbox v-model="includeArchive">
          扫描时包含支持的压缩文件（zip、rar），加入解压队列
        </el-checkbox>
      </el-form-item>
    </el-form>
    <div class="dialog-footer">
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="paths.length === 0" @click="handleSubmit">
        开始导入
      </el-button>
    </div>
  </AndroidDrawer>

  <ElDialog
    v-else
    v-model="visible"
    title="本地导入"
    width="560px"
    class="local-import-dialog"
    :show-close="true"
    @open="handleOpen"
    @closed="handleClosed">
    <el-form label-width="110px" class="local-import-form">
      <el-form-item label="输出画册">
        <el-select
          v-model="selectedOutputAlbumId"
          placeholder="不指定（仅添加到画廊）"
          clearable
          style="width: 100%"
        >
          <el-option
            v-for="album in albums"
            :key="album.id"
            :label="album.name"
            :value="album.id"
          />
          <el-option value="__create_new__" label="+ 新建画册">
            <span style="color: var(--el-color-primary); font-weight: 500">+ 新建画册</span>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" label="画册名称" required>
        <el-input
          v-model="newOutputAlbumName"
          placeholder="请输入画册名称"
          maxlength="50"
          show-word-limit
          @keyup.enter="handleCreateOutputAlbum"
        />
      </el-form-item>

      <el-form-item label="选择路径">
        <div class="path-picker-actions">
          <el-button @click="handleAddFiles">
            <el-icon><Document /></el-icon>
            添加文件
          </el-button>
          <el-button @click="handleAddFolder">
            <el-icon><FolderOpened /></el-icon>
            添加文件夹
          </el-button>
        </div>
      </el-form-item>

      <el-form-item v-if="paths.length > 0" label="已选路径">
        <div class="paths-list">
          <div
            v-for="(p, idx) in paths"
            :key="idx"
            class="path-item"
          >
            <span class="path-text">{{ p }}</span>
            <el-button type="danger" link size="small" @click="removePath(idx)">
              移除
            </el-button>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="递归子文件夹">
        <el-checkbox v-model="recursive">
          递归扫描子文件夹中的图片
        </el-checkbox>
      </el-form-item>
      <el-form-item label="包含压缩包">
        <el-checkbox v-model="includeArchive">
          扫描时包含支持的压缩文件（zip、rar），加入解压队列
        </el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :disabled="paths.length === 0" @click="handleSubmit">
          开始导入
        </el-button>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Document, FolderOpened } from "@element-plus/icons-vue";
import { ElDialog, ElMessage } from "element-plus";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import { open } from "@tauri-apps/plugin-dialog";
import { stat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { useCrawlerStore } from "@/stores/crawler";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";
import { useImageTypes } from "@/composables/useImageTypes";

interface Album {
  id: string;
  name: string;
}

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

const crawlerStore = useCrawlerStore();
const modalStackStore = useModalStackStore();
const modalStackId = ref<string | null>(null);
const { extensions: imageExtensions, load: loadImageTypes } = useImageTypes();

watch(
  () => visible.value,
  (val) => {
    if (val && IS_ANDROID) {
      modalStackId.value = modalStackStore.push(() => {
        visible.value = false;
      });
    } else if (!val && modalStackId.value) {
      modalStackStore.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

const albums = ref<Album[]>([]);
const selectedOutputAlbumId = ref<string | undefined>();
const newOutputAlbumName = ref("");
const paths = ref<string[]>([]);
const recursive = ref(true);
const includeArchive = ref(false);
const isCreatingNewOutputAlbum = computed(
  () => selectedOutputAlbumId.value === "__create_new__"
);

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
    const exts = imageExtensions.value.length ? imageExtensions.value : ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico"];
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [
        { name: "图片", extensions: exts },
        { name: "压缩包", extensions: ["zip", "rar"] },
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
      ElMessage.error("选择文件失败");
    }
  }
}

async function handleAddFolder() {
  try {
    let selected: string | string[] | null = null;

    if (IS_ANDROID) {
      const result = await invoke<{ uri: string; path?: string }>("plugin:folder-picker|pickFolder");
      if (result?.uri) {
        selected = result.path || result.uri;
      }
    } else {
      selected = await open({
        directory: true,
        multiple: false,
      });
    }

    if (!selected) return;

    const pathStr = typeof selected === "string" ? selected : selected?.[0];
    if (pathStr && !paths.value.includes(pathStr)) {
      if (!IS_ANDROID) {
        try {
          const meta = await stat(pathStr);
          if (!meta.isDirectory) {
            ElMessage.warning("请选择文件夹");
            return;
          }
        } catch {
          // continue
        }
      }
      paths.value.push(pathStr);
    }
  } catch (e) {
    if (e !== "cancel" && e !== "close") {
      console.error("选择文件夹失败:", e);
      ElMessage.error("选择文件夹失败");
    }
  }
}

function removePath(idx: number) {
  paths.value.splice(idx, 1);
}

async function handleCreateOutputAlbum() {
  const name = newOutputAlbumName.value.trim();
  if (!name) {
    ElMessage.warning("请输入画册名称");
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
    ElMessage.error("创建画册失败");
  }
}

async function handleSubmit() {
  if (paths.value.length === 0) {
    ElMessage.warning("请至少添加一个路径");
    return;
  }

  let outputAlbumId: string | undefined;
  if (selectedOutputAlbumId.value === "__create_new__") {
    const name = newOutputAlbumName.value.trim();
    if (!name) {
      ElMessage.warning("请先输入画册名称");
      return;
    }
    try {
      const album = await invoke<{ id: string; name: string }>("add_album", { name });
      outputAlbumId = album?.id;
    } catch (e) {
      console.error("创建画册失败:", e);
      ElMessage.error("创建画册失败");
      return;
    }
  } else if (selectedOutputAlbumId.value) {
    outputAlbumId = selectedOutputAlbumId.value;
  }

  crawlerStore.addTask("本地导入", undefined, {
    paths: paths.value,
    recursive: recursive.value,
    include_archive: includeArchive.value,
  }, outputAlbumId);

  visible.value = false;
  paths.value = [];
  ElMessage.success("已添加本地导入任务");
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

.local-import-drawer-header h3 {
  margin: 0;
  font-size: 18px;
}
</style>
