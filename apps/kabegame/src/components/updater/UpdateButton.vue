<template>
  <Tooltip v-if="showButton" :content="buttonLabel" side="right">
    <button
      type="button"
      class="box-border grid size-10 flex-none cursor-pointer place-items-center self-center rounded-kb-md border-0 bg-kb-accent p-0 text-white outline-none transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-kb-ring [&_svg]:size-[18px]"
      :class="corner ? 'absolute bottom-3 left-3 z-1700' : 'my-2'"
      :aria-label="buttonLabel"
      @click="onClick"
    >
      <RotateCw v-if="store.canShowRestart" />
      <Download v-else />
    </button>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElMessage, ElMessageBox } from "@kabegame/element-plus";
import { Download, RotateCw } from "@lucide/vue";
import { Tooltip } from "@/components/ui";
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
