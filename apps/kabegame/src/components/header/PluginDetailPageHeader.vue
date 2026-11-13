<template>
  <PageHeader
    :title="displayName || pluginId || t('plugins.pluginDetailTitle')"
    :show="[HeaderFeatureId.TaskDrawer]"
    show-back
    @back="emit('back')"
  >
    <template v-if="iconUrl || plugin" #icon>
      <img v-if="iconUrl" :src="iconUrl" alt="" draggable="false" class="size-full object-contain" />
      <Puzzle v-else class="size-5 text-kb-fg-muted" />
    </template>

    <template #subtitle>
      <span class="font-mono">{{ plugin?.id ?? pluginId }}</span>
      <span v-if="plugin" class="ml-2">v{{ plugin.version }}</span>
    </template>

    <template #extra>
      <div v-if="plugin" class="flex items-center gap-1">
        <template v-if="actionState === 'installed'">
          <span
            v-if="!uiStore.isCompact"
            class="mr-1 inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full bg-[color-mix(in_srgb,var(--kb-success)_12%,transparent)] px-2 text-[12px] font-500 text-kb-success"
          >
            <Check class="size-3.5" />
            {{ t("plugins.installed") }}
          </span>
          <Tooltip :content="t('plugins.detailCopyId')">
            <Button
              variant="ghost"
              size="icon"
              :aria-label="t('plugins.detailCopyId')"
              @click="emit('copy-id', plugin.id)"
            >
              <Copy />
            </Button>
          </Tooltip>
          <Tooltip :content="t('plugins.uninstall')">
            <Button variant="ghost-danger" size="icon" :aria-label="t('plugins.uninstall')" @click="emit('uninstall')">
              <Trash2 />
            </Button>
          </Tooltip>
        </template>
        <Tooltip
          v-else
          :content="
            plugin.minAppIncompatible
              ? t('plugins.detail.appVersionBad', { app: appVersion ?? '?', min: plugin.minAppVersion })
              : uiStore.isCompact
                ? installButtonText
                : ''
          "
        >
          <!-- 禁用的按钮不接收指针事件，提示挂在外面这层 span 上才能在禁用时弹出 -->
          <span class="inline-flex">
            <Button
              variant="primary"
              :size="uiStore.isCompact ? 'icon' : 'md'"
              :disabled="!!plugin.minAppIncompatible"
              :aria-label="installButtonText"
              @click="emit('install')"
            >
              <RefreshCw v-if="actionState === 'update' || actionState === 'reinstall'" />
              <Download v-else />
              <template v-if="!uiStore.isCompact">{{ installButtonText }}</template>
            </Button>
          </span>
        </Tooltip>
      </div>
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Check, Copy, Download, Puzzle, RefreshCw, Trash2 } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import { useI18n, resolveManifestText } from "@kabegame/i18n";
import PageHeader from "@/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@/stores/header";
import type { Plugin } from "@/stores/plugins";
import { pluginIconToDataUrl } from "@/stores/plugins";
import { usePluginActionState } from "@/composables/usePluginActionState";
import { useUiStore } from "@/stores/ui";
import { APP_VERSION } from "@/env";

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
const uiStore = useUiStore();

const iconUrl = computed(() => pluginIconToDataUrl(props.plugin?.iconPngBase64));
const appVersion = computed(() => APP_VERSION ?? undefined);

const displayName = computed(() =>
  props.plugin
    ? resolveManifestText(props.plugin.name, locale.value) ||
      (typeof props.plugin.name === "object" && props.plugin.name["default"]) ||
      ""
    : "",
);

const { actionState } = usePluginActionState(
  () => props.plugin,
  () => props.isRemote,
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
