<template>
  <el-badge v-if="failedCount > 0" :value="failedCount" :max="99" class="failed-images-badge">
    <el-tooltip :content="t('header.failedImages')" placement="bottom">
      <el-button class="failed-images-trigger" circle @click="openDialog">
        <el-icon><WarningFilled /></el-icon>
      </el-button>
    </el-tooltip>
  </el-badge>
  <el-tooltip v-else :content="t('header.failedImages')" placement="bottom">
    <el-button class="failed-images-trigger" circle @click="openDialog">
      <el-icon><WarningFilled /></el-icon>
    </el-button>
  </el-tooltip>
  <FailedImagesDialog ref="dialogRef" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { WarningFilled } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
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
  return taskId
    ? failedImagesStore.byTaskId(taskId).length
    : failedImagesStore.failedCount;
});

const dialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);

const openDialog = () => {
  dialogRef.value?.setTaskId(currentTaskId.value);
  dialogRef.value?.open();
};

defineEmits<{
  action: []
}>()

</script>

<style scoped lang="scss">
.failed-images-trigger {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.failed-images-badge {
  display: block;
}
</style>
