<template>
  <div class="default-download-dir-setting">
    <el-input v-model="localDir" placeholder="留空使用默认位置" clearable :disabled="saving" @clear="handleClear">
      <template #append>
        <el-button :disabled="saving" @click="handleChoose">
          <el-icon>
            <FolderOpened />
          </el-icon>
          选择
        </el-button>
      </template>
    </el-input>

    <div class="hint">
      生效路径：
      <el-button text size="small" class="path-button" :disabled="!effectiveDownloadDir" @click="handleOpenEffective">
        <el-icon>
          <FolderOpened />
        </el-icon>
        <span class="path-text">{{ effectiveDownloadDir || "（未知）" }}</span>
      </el-button>
      <el-button v-if="(settingsStore.values.defaultDownloadDir as any)" link type="warning" :disabled="saving" @click="handleClear">
        恢复默认
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { FolderOpened } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../../stores/settings";

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey.defaultDownloadDir === true);

const defaultImagesDir = ref<string>("");
const effectiveDownloadDir = computed(() => {
  const custom = settingsStore.values.defaultDownloadDir as any as string | null | undefined;
  return custom && custom.trim() ? custom : defaultImagesDir.value || "";
});

const localDir = ref<string>("");
watch(
  () => settingsStore.values.defaultDownloadDir,
  (v) => {
    localDir.value = (v as any as string | null) || "";
  },
  { immediate: true }
);

onMounted(async () => {
  try {
    defaultImagesDir.value = await invoke<string>("get_default_images_dir");
  } catch {
    defaultImagesDir.value = "";
  }
});

const saveDir = async (dir: string | null) => {
  const prev = settingsStore.values.defaultDownloadDir as any;
  settingsStore.values.defaultDownloadDir = dir as any;
  settingsStore.savingByKey.defaultDownloadDir = true;
  try {
    await invoke("set_default_download_dir", { dir });
  } catch (e) {
    settingsStore.values.defaultDownloadDir = prev;
    localDir.value = (prev as any as string | null) || "";
    ElMessage.error("保存失败");
    // eslint-disable-next-line no-console
    console.error("保存默认下载目录失败:", e);
  } finally {
    settingsStore.savingByKey.defaultDownloadDir = false;
  }
};

const handleChoose = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择默认下载目录",
    });
    if (!selected || Array.isArray(selected)) return;
    localDir.value = selected;
    await saveDir(selected);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    ElMessage.error("选择失败");
  }
};

const handleClear = async () => {
  localDir.value = "";
  await saveDir(null);
};

const handleOpenEffective = async () => {
  try {
    if (!effectiveDownloadDir.value) return;
    await invoke("open_file_path", { filePath: effectiveDownloadDir.value });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("打开目录失败:", e);
    ElMessage.error("打开目录失败");
  }
};
</script>

<style scoped lang="scss">
.default-download-dir-setting {
  width: 100%;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--anime-text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.path-button {
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.path-text {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}
</style>

