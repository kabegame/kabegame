<template>
  <!-- 桌面是工作台尺寸的大对话框（详情主体自己管内部滚动）；紧凑档铺满屏幕 -->
  <Dialog
    v-model:open="open"
    :title="pageTitle"
    :width="isCompact ? '100vw' : 'min(1120px, 92vw)'"
    :height="isCompact ? undefined : preview ? 'min(720px, 82vh)' : undefined"
    :fullscreen="isCompact"
    :close-on-overlay="false"
    :body-class="preview ? '!p-0 !overflow-hidden flex flex-col' : ''"
  >
    <PluginDetailContent v-if="preview" :loading="false" :show-skeleton="false" :plugin="preview" :is-remote="true" />
    <Alert v-else-if="errorMsg" tone="danger" :title="t('common.parseFailed')" :description="errorMsg" />
    <div v-else class="flex h-[200px] items-center justify-center gap-2 text-[13px] text-kb-fg-muted">
      <Spinner :size="16" />
      {{ t("common.loading") }}
    </div>

    <!-- 详情组件不再自带标题栏/操作区（已下沉到页面 PageHeader），导入这条路径由本弹窗提供 -->
    <template v-if="preview" #footer>
      <div class="flex w-full items-center gap-2 border-t border-t-solid border-kb-line pt-3">
        <Tag size="sm" class="font-mono">{{ preview.id }}</Tag>
        <Tag size="sm" class="font-mono">v{{ preview.version }}</Tag>
        <div class="flex-1" />
        <Button @click="open = false">{{ t("common.cancel") }}</Button>
        <Button variant="primary" :disabled="!!preview.minAppIncompatible" @click="doInstall">
          {{ installButtonText }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { kameMessage } from "@/utils/kameMessage";
import type { Plugin } from "@/stores/plugins";
import { usePluginActionState } from "@/composables/usePluginActionState";
import { useUiStore } from "@/stores/ui";
import PluginDetailContent from "@/components/plugin/PluginDetailContent.vue";
import { Alert, Button, Dialog, Spinner, Tag } from "@/components/ui";
import { messageBox } from "@/components/ui/messageBox";

const props = defineProps<{
  kgpgPath: string | null;
}>();

const emit = defineEmits<{
  (e: "success"): void;
}>();

/** 开关（Dialog 自己接 Android 返回栈与层级） */
const open = defineModel<boolean>("open", { default: false });

const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

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

watch(
  () => props.kgpgPath,
  async (newPath) => {
    if (newPath && open.value) {
      await loadPreview(newPath);
    }
  },
);

watch(open, async (val) => {
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
    preview.value = await invoke<Plugin>("preview_import_plugin", { zipPath: path });
  } catch (e: any) {
    errorMsg.value = typeof e === "string" ? e : String(e?.message || e);
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
    ? t("plugins.confirmReinstall")
    : isUpdateFlow.value
      ? t("plugins.confirmUpdate")
      : t("plugins.confirmInstall");
  const successMsg = isReinstallFlow.value
    ? t("plugins.reinstallSuccess")
    : isUpdateFlow.value
      ? t("plugins.updateSuccess")
      : t("common.importSuccess");

  try {
    await messageBox.confirm(t("plugins.installLocalConfirm", { name: pluginName(preview.value) }), confirmTitle, {
      type: "warning",
      confirmButtonText: t("plugins.installButton"),
      cancelButtonText: t("common.cancel"),
    });
  } catch {
    return;
  }

  try {
    await invoke("import_plugin_from_zip", { zipPath: props.kgpgPath });
    kameMessage.success(successMsg);
    // plugin-added / plugin-changed 事件自动更新插件 store
    emit("success");
    open.value = false;
  } catch (e: any) {
    kameMessage.error(typeof e === "string" ? e : String(e?.message || e));
  }
};
</script>
