<template>
  <!-- Android：自研全宽抽屉 -->
  <AndroidDrawer
    v-if="uiStore.isCompact"
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    show-close-button
    class="crawl-dialog"
    @update:model-value="modal.close"
  >
    <template #header>
      <div class="crawl-drawer-header">
        <h3>{{ $t("plugins.startCollect") }}</h3>
        <el-button link type="primary" class="crawl-header-link" @click="goRunConfigs">
          {{ $t("plugins.runConfig") }}
        </el-button>
      </div>
    </template>

    <CrawlerTaskForm ref="taskFormRef" @close="modal.close" />

    <div class="crawl-dialog-footer crawl-dialog-footer--android">
      <el-button :disabled="!hasPlugin" @click="taskFormRef?.openSaveConfigDialog()">
        {{ $t("plugins.saveAsConfig") }}
      </el-button>
      <el-button type="primary" :disabled="!hasPlugin" @click="taskFormRef?.submit()">
        {{ $t("plugins.startCollect") }}
      </el-button>
    </div>
  </AndroidDrawer>

  <ElDialog
    v-else
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    width="600px"
    class="crawl-dialog"
    align-center
    :show-close="true"
    @update:model-value="modal.close"
  >
    <template #header>
      <div class="crawl-dialog-header">
        <span class="crawl-dialog-header__title">{{ $t("plugins.startCollect") }}</span>
        <el-button link type="primary" class="crawl-header-link" @click="goRunConfigs">
          {{ $t("plugins.runConfig") }}
        </el-button>
      </div>
    </template>

    <CrawlerTaskForm ref="taskFormRef" @close="modal.close" />

    <template #footer>
      <div class="crawl-dialog-footer">
        <el-button :disabled="!hasPlugin" @click="taskFormRef?.openSaveConfigDialog()">
          {{ $t("plugins.saveAsConfig") }}
        </el-button>
        <div class="crawl-dialog-footer__actions">
          <el-button @click="modal.close()">{{ $t("common.close") }}</el-button>
          <el-button type="primary" :disabled="!hasPlugin" @click="taskFormRef?.submit()">
            {{ $t("plugins.startCollect") }}
          </el-button>
        </div>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
/**
 * 收集弹窗：对来源无感。全局 crawler store 只存一份 `taskConfig`，
 * 调用方「先写再打开」（`writeTaskConfig` + `crawlerDrawerStore.open()`），
 * 这里只响应式地编辑这份对象。
 */
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElDialog } from "@kabegame/element-plus";
import AndroidDrawer from "@/components/AndroidDrawer.vue";
import { useModal } from "@/composables/useModal";
import { useUiStore } from "@/stores/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import CrawlerTaskForm from "@/components/crawler/CrawlerTaskForm.vue";

interface Props {
  modelValue: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const router = useRouter();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const uiStore = useUiStore();
const taskFormRef = ref<InstanceType<typeof CrawlerTaskForm> | null>(null);

const modal = useModal({ onClose: () => emit("update:modelValue", false) });
watch(
  () => props.modelValue,
  (v) => (v ? modal.open() : modal.close()),
  { immediate: true },
);

const hasPlugin = computed(() => !!crawlerStore.taskConfig?.pluginId);

/** 任何入口都显示：跳自动配置页（定时只在那边编辑） */
function goRunConfigs() {
  modal.close();
  void router.push({ name: "AutoConfigs" });
}

watch(modal.isOpen, async (open) => {
  if (!open) return;
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
  }
});
</script>

<style lang="scss" scoped>
.crawl-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.crawl-dialog-header__title {
  font-weight: 600;
}

.crawl-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--anime-text-primary);
  }
}

.crawl-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.crawl-dialog-footer__actions {
  display: flex;
  gap: 12px;
}

.crawl-dialog-footer--android {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px 0;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
</style>

<style lang="scss">
.crawl-dialog.el-drawer {
  max-width: 500px !important;

  .el-drawer__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
    margin-bottom: 0 !important;
  }

  .el-drawer__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    display: flex !important;
    flex-direction: column !important;
  }

  .el-drawer__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);

    .el-button--primary {
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%) !important;
      border: none !important;
      box-shadow: var(--anime-shadow) !important;
      color: white !important;
    }

    .el-button--primary:hover {
      background: linear-gradient(135deg, var(--anime-primary-dark) 0%, var(--anime-secondary-dark) 100%) !important;
      box-shadow: var(--anime-shadow-hover) !important;
    }

    .el-button--primary:disabled {
      background: var(--el-button-disabled-bg-color) !important;
      color: var(--el-button-disabled-text-color) !important;
      box-shadow: none !important;
    }
  }
}
</style>
