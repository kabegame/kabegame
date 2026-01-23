<template>
  <div class="default-download-dir-setting">
    <el-input v-model="localDir" placeholder="留空使用默认位置" clearable :disabled="disabled" :loading="showDisabled" @clear="handleClear">
      <template #append>
        <el-button :disabled="disabled" :loading="showDisabled" @click="handleChoose">
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
      <el-button v-if="(settingValue as any)" link type="warning" :disabled="disabled" :loading="showDisabled" @click="handleClear">
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
import { useSettingKeyState } from "../../../composables/useSettingKeyState";

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("defaultDownloadDir");

const defaultImagesDir = ref<string>("");
const effectiveDownloadDir = computed(() => {
  const custom = settingValue.value as string | null | undefined;
  return custom && custom.trim() ? custom : defaultImagesDir.value || "";
});

const localDir = ref<string>("");
watch(
  () => settingValue.value,
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
  try {
    await set(dir);
  } catch (e) {
    console.error("保存默认下载目录失败:", e);
    // localDir will be reverted by watch
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
