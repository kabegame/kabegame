<template>
  <ToolRow :label="t('updater.checkUpdate')" :disabled="store.busy" @click="onClick">
    <template #icon><RefreshCw :class="{ 'animate-spin': store.isChecking }" /></template>
  </ToolRow>
</template>

<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import { ElMessage } from "@kabegame/element-plus";
import { useI18n } from "@kabegame/i18n";
import { useUpdaterStore } from "@/stores/updater";
import * as updaterService from "@/services/updater";
import ToolRow from "./ToolRow.vue";

const { t } = useI18n();
const store = useUpdaterStore();

async function onClick() {
  if (store.busy) return;
  const phase = await updaterService.checkNow();
  if (phase === "updateAvailable" || phase === "restartable") {
    ElMessage.success(t("updater.foundUpdate"));
  } else if (phase === "checked") {
    ElMessage.info(t("updater.alreadyLatest"));
  }
}
</script>
