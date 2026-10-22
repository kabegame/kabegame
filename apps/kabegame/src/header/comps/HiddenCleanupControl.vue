<template>
  <div class="hidden-cleanup-control flex w-full items-center">
    <el-button class="w-full" :disabled="disabled" :title="buttonTitle" @click="handleClick">
      <el-icon><Delete /></el-icon>
      <span>{{ t("header.cleanHidden") }}</span>
      <span v-if="store.running" class="ml-auto text-xs text-[var(--anime-text-muted)]">
        {{ t("header.cleanHiddenInProgress") }}
      </span>
      <span v-else-if="hiddenCount > 0" class="ml-auto font-mono text-xs text-[var(--anime-text-muted)]">
        {{ hiddenCount.toLocaleString() }}
      </span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Delete } from "@kabegame/element-plus-icons";
import { ElMessageBox } from "@kabegame/element-plus";
import { useI18n } from "@kabegame/i18n";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import { on, pathqlRequest$, useLookAll } from "@/services/kbEvents";
import { useHiddenCleanupStore } from "@/stores/hiddenCleanup";
import * as hiddenCleanupService from "@/services/hiddenCleanup";

const { t } = useI18n();
const store = useHiddenCleanupStore();

// 隐藏画册的直接图片数由 album-images-change 事件持续刷新，不需要单独的计数命令
const hiddenCount = ref(0);
const hiddenQueries = [{ kind: "count", path: `images://gallery/album/${HIDDEN_ALBUM_ID}` }] as const;
const hiddenLooker = useLookAll({
  queries: () => hiddenQueries,
  refreshOn: [on("album-images-change", (p) => !!p.albumIds?.includes(HIDDEN_ALBUM_ID))],
  onResult: ([count]) => {
    hiddenCount.value = count;
  },
});
pathqlRequest$.next(["all", hiddenLooker.key()!]);

const disabled = computed(() => store.running || hiddenCount.value <= 0);

const buttonTitle = computed(() => {
  if (store.running) return t("header.cleanHiddenInProgress");
  if (hiddenCount.value <= 0) return t("header.cleanHiddenEmpty");
  return t("header.cleanHidden");
});

async function handleClick() {
  if (disabled.value) return;
  const count = hiddenCount.value;
  try {
    await ElMessageBox.confirm(t("gallery.hiddenCleanupConfirm", { count }), t("gallery.hiddenCleanupConfirmTitle"), {
      type: "warning",
    });
  } catch {
    return; // 用户取消
  }
  await hiddenCleanupService.start(count);
}
</script>

<style scoped lang="scss">
/* el-button 把整个 default 插槽裹进一个 <span>，而那层是 inline 的：button 自己的
   flex 布局够不到里面，剩余数量上的 ml-auto 就永远推不动。把这层 wrapper 也变成
   撑满的 flex 才行。icon 与文字的间距仍由 EP 的 `.el-icon + span` margin 管，
   这里不再加 gap，否则会和「整理」那行的缩进对不齐。 */
.hidden-cleanup-control :deep(.el-button > span) {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}
</style>
