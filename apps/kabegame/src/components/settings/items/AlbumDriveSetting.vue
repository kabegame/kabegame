<template>
  <SettingRow :label="$t('settings.albumDrive')" :description="$t('settings.albumDriveDesc')">
    <el-switch v-model="enabled" :loading="showEnabledLoading" :disabled="enabledDisabled"
      @change="handleToggle" />
  </SettingRow>

  <!-- 挂载点是独立一项：盘已挂载时不能改，必须先关掉画册盘 -->
  <SettingRow :label="$t('settings.albumDriveMountPoint')"
    :description="$t('settings.albumDriveMountPointDesc')">
    <el-input v-model="mountPoint" class="mount-point-input" size="default"
      :disabled="enabled || showEnabledLoading || showMountPointLoading"
      :placeholder="$t('settings.albumDriveMountPointPlaceholder')"
      @blur="handleMountPointBlur" />
  </SettingRow>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "@kabegame/element-plus";
import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import SettingRow from "@kabegame/core/components/settings/SettingRow.vue";

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

// 驱动缺失时的安装引导。没有独立按钮，由开关的开启动作触发（见 handleToggle）。
const installDriver = async () => {
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

const handleToggle = async (val: boolean) => {
  const mp = normalizedMountPoint.value;
  if (val && !mp) {
    enabled.value = false;
    ElMessage.error(t("settings.albumDriveMessageMountPointRequired"));
    return;
  }

  // 驱动（Dokan / macFUSE / FUSE）缺失时先复查一次状态，仍然缺失就走安装引导并撤销这次开启
  if (val && driverInstalled.value === false && !installingDriver.value) {
    await refreshDriverStatus();
    if (driverInstalled.value === false) {
      enabled.value = false;
      await installDriver();
      return;
    }
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
.mount-point-input {
  width: 220px;
}
</style>
