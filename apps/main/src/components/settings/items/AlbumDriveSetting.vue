<template>
  <div class="album-drive-setting">
    <el-switch v-model="enabled" :loading="showEnabledLoading" :disabled="!IS_WINDOWS || enabledDisabled"
      @change="handleToggle" />

    <el-input v-model="mountPoint" class="mount-point-input" size="default"
      :disabled="enabled || showEnabledLoading || showMountPointLoading" placeholder="例如 K:\\ 或 K:"
      @blur="handleMountPointBlur" />

    <el-button v-if="enabled" :disabled="showEnabledLoading" @click="openExplorer">
      打开
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage } from "element-plus";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_WINDOWS } from "@kabegame/core/env";

const {
  settingValue: enabledValue,
  set: setEnabled,
  showDisabled: showEnabledLoading,
  disabled: enabledDisabled
} = useSettingKeyState("albumDriveEnabled");

const {
  settingValue: mountPointValue,
  set: setMountPoint,
  showDisabled: showMountPointLoading,
} = useSettingKeyState("albumDriveMountPoint");

const enabled = ref<boolean>(!!enabledValue.value);
const mountPoint = ref<string>((mountPointValue.value as string) ?? "K:\\");

watch(
  enabledValue,
  (v) => {
    enabled.value = !!v;
  },
  { immediate: true }
);

watch(
  mountPointValue,
  (v) => {
    // 仅当本地值与 store 值不一致时更新（避免输入时的光标跳动问题，虽然 blur 才保存）
    // 但这里 mountPoint 是 v-model，且只有 blur 才保存，所以平时 store 不会变
    // 当 store 变了（比如初始化，或保存失败回滚），更新本地
    const newVal = (v as string) ?? "K:\\";
    if (mountPoint.value !== newVal) {
      mountPoint.value = newVal;
    }
  },
  { immediate: true }
);

const normalizedMountPoint = computed(() => mountPoint.value.trim());

const handleMountPointBlur = async () => {
  const mp = normalizedMountPoint.value;
  if (!mp) return;

  // 如果值没有变化，不触发保存
  if (mp === mountPointValue.value) return;

  try {
    await setMountPoint(mp);
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

  try {
    await setEnabled(val, async () => {
      if (val) {
        ElMessage.success("画册盘已开启");
      } else {
        ElMessage.success("画册盘已关闭");
      }
    });
  } catch (e) {
    console.error(e);
    // 错误时 enabled.value 会由 watch 回滚
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
