<template>
  <ToolRow :label="t('header.cleanHidden')" :hint="hint" :disabled="disabled" :title="buttonTitle" @click="handleClick">
    <template #icon><Trash2 /></template>
  </ToolRow>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Trash2 } from "@lucide/vue";
import { ElMessageBox } from "@kabegame/element-plus";
import { useI18n } from "@kabegame/i18n";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import { on, pathqlRequest$, usePathqlLookAll } from "@/services/kbEvents";
import { useHiddenCleanupStore } from "@/stores/hiddenCleanup";
import * as hiddenCleanupService from "@/services/hiddenCleanup";
import ToolRow from "./ToolRow.vue";

const emit = defineEmits<{ done: [] }>();

const { t } = useI18n();
const store = useHiddenCleanupStore();

// 隐藏画册的直接图片数由成员增删事件持续刷新，不需要单独的计数命令
const hiddenCount = ref(0);
const hiddenQueries = [{ kind: "count", path: `images://gallery/album/${HIDDEN_ALBUM_ID}` }] as const;
const hiddenLooker = usePathqlLookAll({
  queries: () => hiddenQueries,
  refreshOn: [
    on("album-images-added", (p) => p.albumId === HIDDEN_ALBUM_ID),
    on("album-images-deleted", (p) => p.albumId === HIDDEN_ALBUM_ID),
    on("album-images-change", (p) => p.albumId === HIDDEN_ALBUM_ID),
  ],
  onResult: ([count]) => {
    hiddenCount.value = count;
  },
});
pathqlRequest$.next(["all", hiddenLooker.key()!]);

const disabled = computed(() => store.running || hiddenCount.value <= 0);

const hint = computed(() => {
  if (store.running) return t("header.cleanHiddenInProgress");
  return hiddenCount.value > 0 ? hiddenCount.value.toLocaleString() : undefined;
});

const buttonTitle = computed(() => {
  if (store.running) return t("header.cleanHiddenInProgress");
  if (hiddenCount.value <= 0) return t("header.cleanHiddenEmpty");
  return t("header.cleanHidden");
});

async function handleClick() {
  if (disabled.value) return;
  const count = hiddenCount.value;
  emit("done");
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
