<template>
  <el-dialog
    v-model="visible"
    title="导入插件"
    width="800"
    top="5vh"
    :close-on-click-modal="false"
    append-to-body
    class="plugin-import-dialog"
  >
    <PluginDetailPage
      v-if="preview"
      :title="pageTitle"
      :subtitle="props.kgpgPath || '（未提供文件路径）'"
      :show-back="false"
      :loading="false"
      :show-skeleton="false"
      :plugin="pluginVm"
      :installed="installed"
      :installing="installing"
      :show-uninstall="false"
      :install-text="installText"
      :installing-text="'安装中...'"
      :empty-description="'插件不存在'"
      :doc-empty-description="'该插件暂无文档'"
      :load-doc-image-bytes="loadDocImageBytes"
      @install="doInstall"
      @copy-id="copyText"
    >
      <template #detail-extra-items>
        <el-descriptions-item label="版本" v-if="preview">
          v{{ preview.preview.version }}
          <span v-if="preview.preview.alreadyExists" class="muted">
            （已安装：v{{ preview.preview.existingVersion || "?" }}）
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="目标目录" v-if="preview">
          {{ preview.pluginsDir }}
        </el-descriptions-item>
        <el-descriptions-item v-if="preview && preview.preview.installError" label="提示">
          <el-alert type="warning" :closable="false" :show-icon="true" :title="preview.preview.installError" />
        </el-descriptions-item>
      </template>
      <template #detail-actions>
        <el-button 
          :type="installed ? 'warning' : 'primary'" 
          :loading="installing" 
          :disabled="installing || !canInstall"
          @click="doInstall">
          {{ installText }}
        </el-button>
      </template>
    </PluginDetailPage>
    <el-alert v-else-if="errorMsg" type="error" :closable="false" show-icon title="解析失败" :description="errorMsg" />
    <div v-else v-loading="loading" class="loading-container">
      加载中...
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { ElMessage } from 'element-plus';
import PluginDetailPage from '@kabegame/core/components/plugin/PluginDetailPage.vue';
import { usePluginStore } from '@/stores/plugins';
import { isUpdateAvailable } from '@kabegame/core/utils/version';

type ImportPreview = {
  id: string;
  name: string;
  version: string;
  sizeBytes: number;
  alreadyExists: boolean;
  existingVersion?: string | null;
  changeLogDiff?: string | null;
  canInstall?: boolean;
  installError?: string | null;
};

type PluginManifest = {
  name: string;
  version: string;
  description: string;
  author?: string;
};

type ImportPreviewWithIcon = {
  preview: ImportPreview;
  manifest: PluginManifest;
  iconBase64?: string | null;
  baseUrl?: string | null;
  pluginsDir: string;
};

const props = defineProps<{
  kgpgPath: string | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void;
  (e: 'success'): void;
}>();

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
});

const loading = ref(false);
const errorMsg = ref<string | null>(null);
const preview = ref<ImportPreviewWithIcon | null>(null);
const installed = ref(false);
const installing = ref(false);
const detail = ref<any | null>(null);
const pluginStore = usePluginStore();

watch(() => props.kgpgPath, async (newPath) => {
  if (newPath && visible.value) {
    await loadPreview(newPath);
  }
});

watch(() => visible.value, async (val) => {
  if (val && props.kgpgPath) {
    await loadPreview(props.kgpgPath);
  } else {
    // Reset state when closed
    loading.value = false;
    preview.value = null;
    errorMsg.value = null;
    installed.value = false;
    detail.value = null;
  }
});

const loadPreview = async (path: string) => {
  loading.value = true;
  errorMsg.value = null;
  preview.value = null;
  installed.value = false;
  detail.value = null;
  try {
    const res = await invoke<ImportPreviewWithIcon>('preview_import_plugin_with_icon', { zipPath: path });
    preview.value = res;
    installed.value = !!res.preview.alreadyExists;
    
    // Load plugin detail (doc, baseUrl, etc.)
    try {
      const doc = await invoke<string | null>('get_plugin_doc_from_zip', { zipPath: path });
      detail.value = {
        doc: doc || null,
        baseUrl: res.baseUrl || null,
      };
    } catch (e) {
      // If doc loading fails, continue with what we have
      detail.value = {
        doc: null,
        baseUrl: res.baseUrl || null,
      };
    }
  } catch (e: any) {
    errorMsg.value = typeof e === 'string' ? e : String(e?.message || e);
  } finally {
    loading.value = false;
  }
};

const iconDataUrl = computed(() => {
  const b64 = preview.value?.iconBase64;
  if (!b64) return null;
  return `data:image/png;base64,${b64}`;
});

const pluginVm = computed(() => {
  if (!preview.value) return null;
  return {
    id: preview.value.preview.id,
    name: preview.value.preview.name,
    desp: preview.value.manifest.description,
    icon: iconDataUrl.value ?? undefined,
    doc: (detail.value?.doc as string | undefined) ?? undefined,
    baseUrl: (detail.value?.baseUrl as string | undefined) ?? undefined,
  };
});

const pageTitle = computed(() => pluginVm.value?.name || "导入插件");

const canInstall = computed(() => {
  const p = preview.value?.preview;
  return p?.canInstall !== false; // 默认为 true，只有明确为 false 时才禁用
});

const installText = computed(() => {
  const p = preview.value?.preview;
  if (!p) return "安装";
  if (!p.alreadyExists) return "安装";
  const existing = p.existingVersion ?? null;
  // 已安装版本不比要安装的版本旧 => 重新安装，否则更新
  return isUpdateAvailable(existing, p.version) ? "更新" : "重新安装";
});

const loadDocImageBytes = async (imagePath: string): Promise<number[]> => {
  if (!props.kgpgPath) throw new Error("未提供插件文件路径");
  return await invoke<number[]>('get_plugin_image_from_zip', { 
    zipPath: props.kgpgPath, 
    imagePath 
  });
};

const doInstall = async () => {
  if (!props.kgpgPath) return;
  installing.value = true;
  try {
    await invoke('import_plugin_from_zip', { zipPath: props.kgpgPath });
    ElMessage.success("导入成功");
    await pluginStore.loadPlugins();
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
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败");
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
