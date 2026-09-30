<template>
  <button
    v-if="showButton"
    type="button"
    class="sidebar-update-button"
    :class="{ 'is-restart': store.canShowRestart, 'is-corner': corner }"
    :title="buttonLabel"
    :aria-label="buttonLabel"
    @click="onClick"
  >
    <el-icon>
      <RefreshRight v-if="store.canShowRestart" />
      <Download v-else />
    </el-icon>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElMessage, ElMessageBox } from "@kabegame/element-plus";
import { Download, RefreshRight } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useUpdaterStore } from "@/stores/updater";
import * as updaterService from "@/services/updater";

defineProps<{ corner?: boolean }>();

const { t } = useI18n();
const store = useUpdaterStore();

// restartable 优先于 updateAvailable（已下载就绪时即便瞬时 checking 也显示重启按钮）
const showButton = computed(() => store.canShowRestart || store.hasUpdate);
const buttonLabel = computed(() => (store.canShowRestart ? t("updater.restartUpdate") : t("updater.foundUpdate")));

async function onClick() {
  if (store.canShowRestart) {
    try {
      await ElMessageBox.confirm(t("updater.restartConfirmMessage"), t("updater.restartConfirmTitle"), {
        type: "warning",
      });
    } catch {
      return; // 用户取消
    }
    try {
      await updaterService.applyUpdateAndRestart();
    } catch (e) {
      ElMessage.error(String(e));
    }
    return;
  }
  store.openDialog();
}
</script>

<style scoped lang="scss">
.sidebar-update-button {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin: 8px 0;
  padding: 0;
  border: none;
  border-radius: 11px;
  font-size: 18px;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  box-shadow: 0 2px 8px rgba(255, 107, 157, 0.4);
  animation: update-pulse 2s ease-in-out infinite;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;

  &:hover {
    transform: translateY(-1px) scale(1.04);
    box-shadow: 0 4px 12px rgba(255, 107, 157, 0.48);
  }

  &.is-restart {
    background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.45);
  }

  &.is-corner {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 1700;
    margin: 0;
  }
}

@keyframes update-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.82;
  }
}
</style>
