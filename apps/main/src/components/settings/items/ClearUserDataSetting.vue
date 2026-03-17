<template>
  <el-button type="danger" :loading="loading" @click="handleClear">
    <el-icon><Delete /></el-icon>
    {{ $t('settings.clearDataButton') }}
  </el-button>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";

const { t } = useI18n();
const loading = ref(false);

const handleClear = async () => {
  try {
    await ElMessageBox.confirm(
      t("settings.clearDataConfirmMessage"),
      t("settings.clearDataConfirmTitle"),
      {
        type: "warning",
        confirmButtonText: t("settings.clearDataConfirmOk"),
        cancelButtonText: t("common.cancel"),
        dangerouslyUseHTMLString: false,
      }
    );

    await ElMessageBox.confirm(
      t("settings.clearDataFinalMessage"),
      t("settings.clearDataFinalTitle"),
      {
        type: "error",
        confirmButtonText: t("settings.clearDataFinalOk"),
        cancelButtonText: t("common.cancel"),
        confirmButtonClass: "el-button--danger",
      }
    );

    loading.value = true;
    await invoke("clear_user_data");
    ElMessage.success(t("settings.clearDataSuccess"));
  } catch (e) {
    if (e !== "cancel") {
      // eslint-disable-next-line no-console
      console.error("清理数据失败:", e);
      ElMessage.error(t("settings.clearDataFailed"));
    }
  } finally {
    loading.value = false;
  }
};
</script>


