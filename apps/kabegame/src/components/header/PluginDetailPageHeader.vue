<template>
  <PageHeader :title="displayName || pluginId || t('plugins.pluginDetailTitle')" show-back @back="emit('back')">
    <template v-if="iconUrl || plugin" #icon>
      <el-image v-if="iconUrl" :src="iconUrl" fit="contain" class="w-full h-full" />
      <div v-else class="w-full h-full flex items-center justify-center kb-grad text-white">
        <el-icon :size="26"><Grid /></el-icon>
      </div>
    </template>

    <template #subtitle>
      <span class="font-mono">{{ plugin?.id ?? pluginId }}</span>
      <span v-if="plugin" class="ml-2">v{{ plugin.version }}</span>
    </template>

    <template #extra>
      <div v-if="plugin" class="flex items-center gap-2">
        <template v-if="actionState === 'installed'">
          <span class="kb-chip text-white kb-grad-success whitespace-nowrap">{{ t("plugins.installed") }}</span>
          <el-button circle :title="t('plugins.detailCopyId')" @click="emit('copy-id', plugin.id)">
            <el-icon><DocumentCopy /></el-icon>
          </el-button>
          <el-button circle type="danger" :title="t('plugins.uninstall')" @click="emit('uninstall')">
            <el-icon><Delete /></el-icon>
          </el-button>
        </template>
        <el-button
          v-else
          type="primary"
          round
          :disabled="!!plugin.minAppIncompatible"
          :title="plugin.minAppIncompatible ? t('plugins.detail.appVersionBad', { app: appVersion ?? '?', min: plugin.minAppVersion }) : undefined"
          @click="emit('install')"
        >
          {{ installButtonText }}
        </el-button>
      </div>
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Delete, DocumentCopy, Grid } from "@element-plus/icons-vue";
import { useI18n, resolveManifestText } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import type { Plugin } from "@kabegame/core/stores/plugins";
import { pluginIconToDataUrl } from "@kabegame/core/stores/plugins";
import { usePluginActionState } from "@kabegame/core/composables/usePluginActionState";
import { APP_VERSION } from "@kabegame/core/env";

const props = defineProps<{
  plugin: Plugin | null;
  /** 路由参数里的 id：plugin 还没加载出来时先用它占位，避免标题闪空 */
  pluginId?: string | null;
  isRemote: boolean;
}>();

const emit = defineEmits<{
  (e: "back"): void;
  (e: "install"): void;
  (e: "uninstall"): void;
  (e: "copy-id", pluginId: string): void;
}>();

const { t, locale } = useI18n();

const iconUrl = computed(() => pluginIconToDataUrl(props.plugin?.iconPngBase64));
const appVersion = computed(() => APP_VERSION ?? undefined);

const displayName = computed(() =>
  props.plugin
    ? resolveManifestText(props.plugin.name, locale.value) ||
      (typeof props.plugin.name === "object" && props.plugin.name["default"]) ||
      ""
    : ""
);

const { actionState } = usePluginActionState(
  () => props.plugin,
  () => props.isRemote
);

const installButtonText = computed(() => {
  switch (actionState.value) {
    case "update":
      return t("plugins.update");
    case "reinstall":
      return t("plugins.reinstall");
    default:
      return t("plugins.install");
  }
});
</script>

<style scoped>
.kb-grad-success {
  background: linear-gradient(135deg, #10b981 0%, #34d399 100%);
}
</style>
