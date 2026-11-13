<template>
  <Tooltip :content="t('header.failedImages')">
    <Button
      variant="ghost"
      size="icon"
      :aria-label="failedCount > 0 ? `${t('header.failedImages')} (${failedCount})` : t('header.failedImages')"
      @click="openDialog"
    >
      <TriangleAlert />
      <CountBadge :count="failedCount" tone="danger" />
    </Button>
  </Tooltip>
  <FailedImagesDialog ref="dialogRef" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { TriangleAlert } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Button, CountBadge, Tooltip } from "@/components/ui";
import { useFailedImagesStore } from "@/stores/failedImages";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";

const { t } = useI18n();
const route = useRoute();
const failedImagesStore = useFailedImagesStore();
// 只需要当前 TaskDetail 的 taskId，route.params.taskId 即权威来源。不引用 taskDetailRoute
// store：那个 store 是用来拼过滤器路径的，且在顶栏引用它会让它过早实例化(还在别的
// 路由时就 getDefault → taskId 为空)，从而污染首次进入的 URL/setting。
const currentTaskId = computed(() => {
  if (route.name !== "TaskDetail") return undefined;
  const routeId = Array.isArray(route.params.taskId) ? route.params.taskId[0] : route.params.taskId;
  const id = String(routeId || "").trim();
  return id || undefined;
});
const failedCount = computed(() => {
  const taskId = currentTaskId.value;
  return taskId ? failedImagesStore.byTaskId(taskId).length : failedImagesStore.failedCount;
});

const dialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);

const openDialog = () => {
  dialogRef.value?.setTaskId(currentTaskId.value);
  dialogRef.value?.open();
};

defineEmits<{
  action: [];
}>();
</script>
