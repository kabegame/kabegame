<template>
  <el-button
    class="check-update-trigger"
    :disabled="store.busy"
    @click="onClick"
  >
    <el-icon class="check-update-icon" :class="{ spinning: store.isChecking }">
      <Refresh />
    </el-icon>
    <span class="check-update-label">{{ t('updater.checkUpdate') }}</span>
  </el-button>
</template>

<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElButton, ElIcon, ElMessage } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useUpdaterStore } from "@/stores/updater";
import * as updaterService from "@/services/updater";

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

<style scoped lang="scss">
.check-update-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.check-update-label {
  font-size: 13px;
}

.spinning {
  animation: check-update-spin 1s linear infinite;
}

@keyframes check-update-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
