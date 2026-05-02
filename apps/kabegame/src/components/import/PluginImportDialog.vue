<template>
  <el-dialog
    v-model="visible"
    :title="pageTitle"
    :width="IS_ANDROID ? '100%' : '800px'"
    :top="IS_ANDROID ? '0' : '5vh'"
    :fullscreen="IS_ANDROID"
    :close-on-click-modal="false"
    append-to-body
    class="plugin-import-dialog"
    :class="{ 'mobile-fullscreen': IS_ANDROID }"
    @close="handleClose"
  >
    <PluginDetailContent
      v-if="preview"
      :title="pageTitle"
      :subtitle="props.kgpgPath || t('common.noFilePath')"
      :show-back="IS_ANDROID"
      :loading="false"
      :show-skeleton="false"
      :plugin="preview"
      :app-version="appVersion"
      :installed="installed"
      :installing="installing"
      :show-uninstall="false"
      :install-text="installText"
      :installing-text="t('plugins.installing')"
      :empty-description="t('common.pluginNotExist')"
      :doc-empty-description="t('common.pluginNoDoc')"
      @install="doInstall"
      @copy-id="copyText"
      @back="handleBack"
    >
      <template #detail-extra-items>
        <el-descriptions-item label="版本" v-if="preview">
          v{{ preview.version }}
          <span v-if="installed" class="muted">
            （已安装：v{{ existingVersion || "?" }}）
          </span>
        </el-descriptions-item>
      </template>
      <template #detail-actions>
        <el-button
          :type="installed ? 'warning' : 'primary'"
          :loading="installing"
          :disabled="installing"
          @click="doInstall">
          {{ installText }}
        </el-button>
      </template>
    </PluginDetailContent>
    <el-alert v-else-if="errorMsg" type="error" :closable="false" show-icon :title="t('common.parseFailed')" :description="errorMsg" />
    <div v-else v-loading="loading" class="loading-container">
      {{ t('common.loading') }}
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n, usePluginManifestI18n } from '@kabegame/i18n';
import { invoke } from "@/api/rpc";
import { ElMessage } from 'element-plus';
import type { Plugin } from '@kabegame/core/stores/plugins';
import { usePluginStore } from '@/stores/plugins';
import { useApp } from '@/stores/app';
import { isUpdateAvailable } from '@kabegame/core/utils/version';
import { IS_ANDROID, IS_WEB } from '@kabegame/core/env';
import { useModalBack } from '@kabegame/core/composables/useModalBack';
import PluginDetailContent from '@kabegame/core/components/plugin/PluginDetailContent.vue';

const props = defineProps<{
  kgpgPath: string | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void;
  (e: 'success'): void;
}>();

const handleClose = () => {
  emit('update:visible', false);
};

const handleBack = () => {
  if (IS_ANDROID) {
    handleClose();
  }
};

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
});

const loading = ref(false);
const errorMsg = ref<string | null>(null);
const { version: appVersion } = storeToRefs(useApp());
const preview = ref<Plugin | null>(null);
const installing = ref(false);
const pluginStore = usePluginStore();

useModalBack(visible);

const existingPlugin = computed(() =>
  preview.value ? pluginStore.plugins.find(p => p.id === preview.value!.id) : undefined
);
const installed = computed(() => !!existingPlugin.value);
const existingVersion = computed(() => existingPlugin.value?.version ?? null);

watch(() => props.kgpgPath, async (newPath) => {
  if (newPath && visible.value) {
    await loadPreview(newPath);
  }
});

watch(() => visible.value, async (val) => {
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

const installText = computed(() => {
  if (!preview.value) return t('plugins.install');
  if (!installed.value) return t('plugins.install');
  return isUpdateAvailable(existingVersion.value, preview.value.version) ? t('plugins.update') : t('plugins.reinstall');
});

const doInstall = async () => {
  if (!props.kgpgPath) return;
  installing.value = true;
  try {
    await invoke('import_plugin_from_zip', { zipPath: props.kgpgPath });
    ElMessage.success(t('common.importSuccess'));
    // plugin-added / plugin-updated event auto-updates the store
    emit('success');
    visible.value = false;
  } catch (e: any) {
    ElMessage.error(typeof e === 'string' ? e : String(e?.message || e));
  } finally {
    installing.value = false;
  }
};

const copyText = async (text: string) => {
  try {
    if (!IS_WEB) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    ElMessage.success(t('common.copied'));
  } catch {
    ElMessage.error(t('common.copyFailed'));
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

.muted {
  opacity: 0.7;
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
</style>
