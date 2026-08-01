<template>
  <el-dialog
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    :title="pageTitle"
    :width="isCompact ? '100%' : 'min(1120px, 92vw)'"
    :top="isCompact ? '0' : '5vh'"
    :fullscreen="isCompact"
    :close-on-click-modal="false"
    append-to-body
    class="plugin-import-dialog"
    :class="{ 'mobile-fullscreen': isCompact, 'is-workbench': !isCompact }"
    @update:model-value="modal.close"
    @close="handleClose"
  >
    <PluginDetailContent
      v-if="preview"
      :loading="false"
      :show-skeleton="false"
      :plugin="preview"
      :is-remote="true"
    />
    <el-alert v-else-if="errorMsg" type="error" :closable="false" show-icon :title="t('common.parseFailed')" :description="errorMsg" />
    <div v-else v-loading="loading" class="loading-container">
      {{ t('common.loading') }}
    </div>

    <!-- 详情组件不再自带标题栏/操作区（已下沉到页面 PageHeader），导入这条路径由本弹窗提供 -->
    <template v-if="preview" #footer>
      <div class="flex items-center gap-2">
        <span class="kb-chip bg-[#ecf5ff] text-[#409eff] font-mono">{{ preview.id }}</span>
        <span class="kb-chip bg-[#f4f4f5] text-[#909399]">v{{ preview.version }}</span>
        <div class="flex-1" />
        <el-button @click="handleClose">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :disabled="!!preview.minAppIncompatible" @click="doInstall">
          {{ installButtonText }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElMessageBox } from '@kabegame/element-plus';
import { useI18n, usePluginManifestI18n } from '@kabegame/i18n';
import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import type { Plugin } from '@kabegame/core/stores/plugins';
import { usePluginActionState } from '@kabegame/core/composables/usePluginActionState';
import { useUiStore } from '@kabegame/core/stores/ui';
import { useModal } from '@kabegame/core/composables/useModal';
import PluginDetailContent from '@kabegame/core/components/plugin/PluginDetailContent.vue';

const props = defineProps<{
  kgpgPath: string | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void;
  (e: 'success'): void;
}>();

const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

const handleClose = () => {
  emit('update:visible', false);
};

const modal = useModal({ onClose: () => emit('update:visible', false) });
watch(() => props.visible, (v) => v ? modal.open() : modal.close(), { immediate: true });

const loading = ref(false);
const errorMsg = ref<string | null>(null);
const preview = ref<Plugin | null>(null);

// 与详情页头部共用同一套判据：决定按钮文案与确认弹窗/成功提示用「安装/更新/重新安装」哪一套
const { actionState } = usePluginActionState(preview, true);
const isUpdateFlow = computed(() => actionState.value === "update");
const isReinstallFlow = computed(() => actionState.value === "reinstall");
const installButtonText = computed(() => {
  switch (actionState.value) {
    case "update":
      return t("plugins.update");
    case "reinstall":
      return t("plugins.reinstall");
    default:
      return t("plugins.installButton");
  }
});

watch(() => props.kgpgPath, async (newPath) => {
  if (newPath && modal.isOpen) {
    await loadPreview(newPath);
  }
});

watch(modal.isOpen, async (val) => {
  if (val && props.kgpgPath) {
    await loadPreview(props.kgpgPath);
  } else if (!val) {
    loading.value = false;
    preview.value = null;
    errorMsg.value = null;
  }
});

const loadPreview = async (path: string) => {
  loading.value = true;
  errorMsg.value = null;
  preview.value = null;
  try {
    preview.value = await invoke<Plugin>('preview_import_plugin', { zipPath: path });
  } catch (e: any) {
    errorMsg.value = typeof e === 'string' ? e : String(e?.message || e);
  } finally {
    loading.value = false;
  }
};

const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const pageTitle = computed(() => (preview.value ? pluginName(preview.value) : "") || t("common.importPlugin"));

const doInstall = async () => {
  if (!props.kgpgPath || !preview.value) return;

  const confirmTitle = isReinstallFlow.value
    ? t('plugins.confirmReinstall')
    : isUpdateFlow.value
      ? t('plugins.confirmUpdate')
      : t('plugins.confirmInstall');
  const successMsg = isReinstallFlow.value
    ? t('plugins.reinstallSuccess')
    : isUpdateFlow.value
      ? t('plugins.updateSuccess')
      : t('common.importSuccess');

  try {
    await ElMessageBox.confirm(
      t('plugins.installLocalConfirm', { name: pluginName(preview.value) }),
      confirmTitle,
      { type: 'warning', confirmButtonText: t('plugins.installButton'), cancelButtonText: t('common.cancel') }
    );
  } catch {
    return;
  }

  try {
    await invoke('import_plugin_from_zip', { zipPath: props.kgpgPath });
    ElMessage.success(successMsg);
    // plugin-added / plugin-updated event auto-updates the store
    emit('success');
    modal.close();
  } catch (e: any) {
    ElMessage.error(typeof e === 'string' ? e : String(e?.message || e));
  }
};

</script>

<style scoped>
.loading-container {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

<style>
.plugin-import-dialog {
  display: flex;
  flex-direction: column;
}

.plugin-import-dialog.mobile-fullscreen {
  margin: 0 !important;
}

.plugin-import-dialog.mobile-fullscreen .el-dialog {
  margin: 0 !important;
  max-height: 100vh !important;
  height: 100vh !important;
  border-radius: 0 !important;
}

.plugin-import-dialog.mobile-fullscreen .el-dialog__body {
  padding: 0 !important;
  height: calc(100vh - 60px) !important;
}

.plugin-import-dialog .el-dialog {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  margin: 5vh auto;
}

.plugin-import-dialog .el-dialog__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

/* 桌面工作台尺寸：详情主体自己控制内部滚动，body 不再加 padding。
   选择器必须落在 .el-dialog 自身——class prop 加在该元素上，写成后代选择器匹配不到。 */
.el-dialog.plugin-import-dialog.is-workbench {
  display: flex;
  flex-direction: column;
  height: min(720px, 82vh);
  max-height: 82vh;
  margin: 5vh auto;
  overflow: hidden;
  background: #fff;
}

.el-dialog.plugin-import-dialog.is-workbench .el-dialog__body {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
</style>
