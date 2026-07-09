<template>
  <div class="album-drive-setting">
    <el-switch v-model="enabled" :loading="showEnabledLoading" :disabled="enabledDisabled"
      @change="handleToggle" />

    <el-button circle size="small" :icon="Refresh" :loading="driverStatusLoading"
      :title="$t('settings.albumDriveRefreshDriverStatus')" @click="handleRefreshDriverStatus" />

    <el-button v-if="showInstallDriverButton" :loading="installingDriver" @click="handleInstallDriver">
      {{ $t('settings.albumDriveInstallDriverButton') }}
    </el-button>

    <el-input v-model="mountPoint" class="mount-point-input" size="default"
      :disabled="enabled || showEnabledLoading || showMountPointLoading"
      :placeholder="$t('settings.albumDriveMountPointPlaceholder')"
      @blur="handleMountPointBlur" />

    <el-button v-if="enabled" :disabled="showEnabledLoading" @click="openExplorer">
      {{ $t('settings.albumDriveOpenButton') }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const installingDriver = ref(false);

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

const {
  settingValue: driverInstalled,
} = useSettingKeyState("albumDriveDriverInstalled");

const enabled = ref<boolean>(!!enabledValue.value);
const mountPoint = ref<string>((mountPointValue.value as string) ?? "K:\\");

const driverStatusLoading = computed(() => settingsStore.isLoading("albumDriveDriverInstalled"));
const showInstallDriverButton = computed(() => driverInstalled.value === false);

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

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const refreshDriverStatus = async () => {
  await settingsStore.refresh("albumDriveDriverInstalled");
};

onMounted(() => {
  void refreshDriverStatus();
});

const handleRefreshDriverStatus = async () => {
  try {
    await refreshDriverStatus();
  } catch (e) {
    console.error(e);
    ElMessage.error(String(e));
  }
};

const handleInstallDriver = async () => {
  if (IS_WINDOWS) {
    installingDriver.value = true;
    try {
      await invoke("install_album_drive_driver");
      ElMessage.info(t("settings.albumDriveInstallDriverStarted"));
      for (let i = 0; i < 3; i += 1) {
        await delay(3000);
        await refreshDriverStatus();
        if (driverInstalled.value) break;
      }
    } catch (e) {
      console.error(e);
      ElMessage.error(String(e));
    } finally {
      installingDriver.value = false;
    }
    return;
  }

  if (IS_MACOS || IS_LINUX) {
    const messageKey = IS_MACOS
      ? "settings.albumDriveInstallDriverManualMac"
      : "settings.albumDriveInstallDriverManualLinux";
    try {
      await ElMessageBox.alert(
        t(messageKey),
        t("settings.albumDriveInstallDriverManualTitle"),
      );
    } finally {
      await refreshDriverStatus();
    }
  }
};

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
    ElMessage.error(`${String(e)} ${t("settings.albumDriveOpenErrorHint")}`);
  }
};

const handleToggle = async (val: boolean) => {
  const mp = normalizedMountPoint.value;
  if (val && !mp) {
    enabled.value = false;
    ElMessage.error(t("settings.albumDriveMessageMountPointRequired"));
    return;
  }

  try {
    const ok = await setEnabled(val);
    if (ok) {
      if (val) {
        ElMessage.success(t("settings.albumDriveMessageEnabled"));
      } else {
        ElMessage.success(t("settings.albumDriveMessageDisabled"));
      }
    }
  } catch (e) {
    console.error(e);
    // 错误时 enabled.value 会由 watch 回滚
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
