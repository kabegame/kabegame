<template>
  <!-- 紧凑布局：单按钮打开「本地 / 网络 / 网页」选择 picker，无下拉箭头 -->
  <Button v-if="uiStore.isCompact" variant="primary" class="ml-1.5" @click="emit('action', { type: 'openMenu' })">
    <Plus />
    {{ t("gallery.startCollect") }}
  </Button>
  <DropdownMenu v-else>
    <DropdownMenuTrigger as-child>
      <Button variant="primary" class="ml-1.5 pr-2">
        <Plus />
        {{ t("gallery.startCollect") }}
        <ChevronDown class="opacity-70" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem v-if="!IS_WEB" @select="select('local')">
        <FolderOpen />
        {{ t("gallery.local") }}
      </DropdownMenuItem>
      <DropdownMenuItem @select="select('network')">
        <Globe />
        {{ t("gallery.network") }}
      </DropdownMenuItem>
      <DropdownMenuItem v-if="!IS_WEB" @select="select('webpage')">
        <Link2 />
        {{ t("gallery.webpage") }}
      </DropdownMenuItem>
      <DropdownMenuItem v-if="!IS_WEB && !IS_ANDROID" @select="select('wallpaper')">
        <Monitor />
        {{ t("gallery.wallpaper") }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { ChevronDown, FolderOpen, Globe, Link2, Monitor, Plus } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import { IS_ANDROID, IS_WEB } from "@/env";

const { t } = useI18n();

const emit = defineEmits<{
  action: [data: { type: string; value?: string }];
}>();

const uiStore = useUiStore();

const select = (value: string) => {
  emit("action", { type: "select", value });
};
</script>
