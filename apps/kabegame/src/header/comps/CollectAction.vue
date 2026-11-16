<template>
  <!-- 紧凑布局：单按钮打开「本地 / 网络」选择 picker，无下拉箭头 -->
  <Button v-if="uiStore.isCompact" variant="primary" class="ml-1.5" @click="store.openChooser('collect_menu')">
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
      <!-- 两组入口：本地（文件夹 / WPE 壁纸）、网络（插件 / 网页 / Steam）；具体来源在对话框顶部切换 -->
      <DropdownMenuItem v-if="LOCAL_SOURCES.length" @select="store.enter('local')">
        <FolderOpen />
        {{ t("gallery.local") }}
      </DropdownMenuItem>
      <DropdownMenuItem @select="store.enter('network')">
        <Globe />
        {{ t("gallery.network") }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { ChevronDown, FolderOpen, Globe, Plus } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import { LOCAL_SOURCES, useCollectDialogsStore } from "@/stores/collectDialogs";

const { t } = useI18n();

/**
 * 页头的「开始收集」：直接调 collectDialogs store，界面由全局的 CollectEntryHost 承载，
 * 所以放在哪个页面的页头都能用（画廊、自动配置……），页面不用接 action。
 */
const uiStore = useUiStore();
const store = useCollectDialogsStore();
</script>
