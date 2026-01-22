<template>
  <div class="album-drive-setting">
    <el-switch v-model="enabled" :loading="switchLoading" :disabled="!IS_WINDOWS" @change="handleToggle" />

    <el-input v-model="mountPoint" class="mount-point-input" size="default" :disabled="enabled || switchLoading"
      placeholder="例如 K:\\ 或 K:" @blur="handleMountPointBlur" />

    <el-button v-if="enabled" :disabled="switchLoading" @click="openExplorer">
      打开
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage } from "element-plus";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WINDOWS } from "@kabegame/core/env";

const settingsStore = useSettingsStore();

const enabled = ref<boolean>(!!settingsStore.values.albumDriveEnabled);
const mountPoint = ref<string>(
  (settingsStore.values.albumDriveMountPoint as string | undefined) ?? "K:\\"
);
const switchLoading = ref(false);

watch(
  () => settingsStore.values.albumDriveEnabled,
  (v) => {
    enabled.value = !!v;
    // 设置变化时，停止加载状态并显示消息
    if (switchLoading.value) {
      switchLoading.value = false;
      if (v) {
        ElMessage.success("画册盘已开启");
      } else {
        ElMessage.success("画册盘已关闭");
      }
    }
  }
);
watch(
  () => settingsStore.values.albumDriveMountPoint,
  (v) => {
    if (typeof v === "string" && v.trim() && !enabled.value) {
      mountPoint.value = v;
    }
  }
);

const normalizedMountPoint = computed(() => mountPoint.value.trim());

const persistMountPoint = async () => {
  const mp = normalizedMountPoint.value;
  if (!mp) return;
  await invoke("set_album_drive_mount_point", { mountPoint: mp });
  settingsStore.values.albumDriveMountPoint = mp;
};

const handleMountPointBlur = async () => {
  // 仅保存，不自动挂载
  try {
    await persistMountPoint();
  } catch (e) {
    console.error(e);
    ElMessage.error(String(e));
  }
};

const openExplorer = async () => {
  try {
    const mp = normalizedMountPoint.value || "K:\\";
    await invoke("open_explorer", { path: mp });
  } catch (e) {
    console.error(e);
    ElMessage.error(String(e));
  }
};

const handleToggle = async (val: boolean) => {
  if (!IS_WINDOWS) {
    enabled.value = false;
    return;
  }
  const mp = normalizedMountPoint.value;
  if (val && !mp) {
    enabled.value = false;
    ElMessage.error("请先填写挂载点（例如 K:\\）");
    return;
  }

  switchLoading.value = true;
  try {
    // 直接设置 enabled，daemon 会自动处理挂载/卸载
    await invoke("set_album_drive_enabled", { enabled: val });
  } catch (e) {
    console.error(e);
    enabled.value = !val;
    switchLoading.value = false;
    ElMessage.error(String(e));
  }
};
</script>

<style scoped>
.album-drive-setting {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mount-point-input {
  width: 180px;
}
</style>
