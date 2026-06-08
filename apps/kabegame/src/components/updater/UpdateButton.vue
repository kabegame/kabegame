<template>
  <!-- 折叠侧栏：仅小红点指示 -->
  <span
    v-if="collapsed"
    v-show="showButton"
    class="update-dot"
    :class="{ 'is-restart': store.canShowRestart }"
    :title="pillLabel"
  />

  <!-- 展开侧栏：完整 pill 按钮（「Kabegame」下方） -->
  <button
    v-else-if="showButton"
    type="button"
    class="update-pill"
    :class="{ 'is-restart': store.canShowRestart }"
    @click="onClick"
  >
    {{ pillLabel }}
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useUpdaterStore } from "@/stores/updater";
import * as updaterService from "@/services/updater";

defineProps<{ collapsed: boolean }>();

const { t } = useI18n();
const store = useUpdaterStore();

// restartable 优先于 updateAvailable（已下载就绪时即便瞬时 checking 也显示重启按钮）
const showButton = computed(() => store.canShowRestart || store.hasUpdate);
const pillLabel = computed(() =>
  store.canShowRestart ? t("updater.restartUpdate") : t("updater.new"),
);

async function onClick() {
  if (store.canShowRestart) {
    try {
      await ElMessageBox.confirm(
        t("updater.restartConfirmMessage"),
        t("updater.restartConfirmTitle"),
        { type: "warning" },
      );
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
.update-pill {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border: none;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  box-shadow: 0 2px 8px rgba(255, 107, 157, 0.4);
  animation: update-pulse 2s ease-in-out infinite;
  transition: transform 0.2s ease;

  &:hover {
    transform: scale(1.06);
  }

  &.is-restart {
    background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.45);
  }
}

.update-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--anime-primary);
  box-shadow: 0 0 0 2px var(--anime-bg-card);
  animation: update-dot-pulse 2s ease-in-out infinite;

  &.is-restart {
    background: #7c3aed;
  }
}

@keyframes update-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(0.92);
  }
}

@keyframes update-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}
</style>
