<template>
  <div class="we-dir-setting">
    <el-input
      v-model="localDir"
      placeholder="用于“导出并自动导入到 WE”（建议选择 WE 安装目录或 projects/myprojects）"
      clearable
      :disabled="saving"
      @clear="handleClear"
    >
      <template #append>
        <el-button :disabled="saving" @click="handleChoose">
          <el-icon><FolderOpened /></el-icon>
          选择
        </el-button>
      </template>
    </el-input>

    <div class="hint">
      自动导入会写入：<b>projects\myprojects</b>
      <span v-if="myprojectsDir">
        ，当前识别为：
        <el-button text size="small" class="path-button" @click="handleOpenMyprojects">
          <el-icon><FolderOpened /></el-icon>
          <span class="path-text">{{ myprojectsDir }}</span>
        </el-button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { FolderOpened } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settings";

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey.wallpaperEngineDir === true);

const localDir = ref<string>("");
const myprojectsDir = ref<string>("");

watch(
  () => settingsStore.values.wallpaperEngineDir,
  (v) => {
    localDir.value = (v as any as string | null) || "";
  },
  { immediate: true }
);

const refreshMyprojects = async () => {
  try {
    const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
    myprojectsDir.value = mp || "";
  } catch {
    myprojectsDir.value = "";
  }
};

onMounted(async () => {
  await refreshMyprojects();
});

const saveDir = async (dir: string | null) => {
  const prev = settingsStore.values.wallpaperEngineDir as any;
  settingsStore.values.wallpaperEngineDir = dir as any;
  settingsStore.savingByKey.wallpaperEngineDir = true;
  try {
    await invoke("set_wallpaper_engine_dir", { dir });
    await refreshMyprojects();
    if (dir && !myprojectsDir.value) {
      ElMessage.warning("未识别到 projects/myprojects，请换一个目录（比如 WE 安装目录或 projects 目录）");
    }
  } catch (e) {
    settingsStore.values.wallpaperEngineDir = prev;
    localDir.value = (prev as any as string | null) || "";
    ElMessage.error("保存失败");
    // eslint-disable-next-line no-console
    console.error("保存 Wallpaper Engine 目录失败:", e);
  } finally {
    settingsStore.savingByKey.wallpaperEngineDir = false;
  }
};

const handleChoose = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Wallpaper Engine 目录（建议选择安装目录或 projects/myprojects）",
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
  myprojectsDir.value = "";
  await saveDir(null);
};

const handleOpenMyprojects = async () => {
  try {
    if (!myprojectsDir.value) return;
    await invoke("open_file_path", { filePath: myprojectsDir.value });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("打开 myprojects 目录失败:", e);
    ElMessage.error("打开失败");
  }
};
</script>

<style scoped lang="scss">
.we-dir-setting {
  width: 100%;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--anime-text-muted);
  line-height: 1.4;
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


