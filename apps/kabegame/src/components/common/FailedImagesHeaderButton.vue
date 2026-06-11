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
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";

const { t } = useI18n();
const route = useRoute();
const failedImagesStore = useFailedImagesStore();
const taskDetailRouteStore = useTaskDetailRouteStore();
const failedCount = computed(() => failedImagesStore.allFailed.length);

const dialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);

const openDialog = () => {
  const taskId = route.name === "TaskDetail"
    ? (taskDetailRouteStore.taskId || undefined)
    : undefined;
  dialogRef.value?.open(taskId);
};
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
