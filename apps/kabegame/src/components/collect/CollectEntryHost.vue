<template>
  <!-- 收集入口的全部界面，全局唯一挂在 App.vue；入口只调 collectDialogs store -->
  <CollectNetworkDialog />
  <CollectLocalDialog v-if="!IS_WEB && !uiStore.isCompact" />

  <!-- 选择收集方式：紧凑档是 picker，桌面是对话框 -->
  <CollectSourcePicker
    v-if="uiStore.isCompact"
    :model-value="store.chooserOpen"
    @update:model-value="(v: boolean) => (store.chooserOpen = v)"
    @select="(group) => store.enter(group, 'compact_picker')"
  />
  <Dialog
    v-else
    :open="store.chooserOpen"
    :title="$t('gallery.chooseCollectMethod')"
    :width="360"
    @update:open="(v: boolean) => (store.chooserOpen = v)"
  >
    <div class="flex flex-col gap-2">
      <button
        v-for="item in chooserItems"
        :key="item.group"
        type="button"
        class="box-border flex w-full cursor-pointer items-center gap-3 rounded-kb-lg border border-solid border-kb-line-strong bg-transparent px-3.5 py-3 text-left [font:inherit] text-[13.5px] font-500 text-kb-fg outline-none transition-[background-color,border-color] duration-150 hover:border-kb-fg-subtle hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring"
        @click="store.enter(item.group, 'empty_state_dialog')"
      >
        <span
          class="grid size-9 shrink-0 place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-[18px]"
        >
          <component :is="item.icon" />
        </span>
        {{ item.label }}
      </button>
    </div>
  </Dialog>

  <!-- 紧凑档的本地导入：系统媒体选择器 -->
  <MediaPicker
    v-if="uiStore.isCompact && !IS_WEB"
    :model-value="store.mediaPickerOpen"
    @update:model-value="(v: boolean) => (store.mediaPickerOpen = v)"
    @select="handleMediaPickerSelect"
  />
</template>

<script setup lang="ts">
/**
 * 收集入口的全局宿主：「本地」「网络」两个对话框、选择收集方式层、紧凑档的媒体选择器。
 * 页头的「开始收集」（任何页面）与画廊空状态都只调 `useCollectDialogsStore()`，不再各页接事件。
 */
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpen, Globe } from "@lucide/vue";
import { pickImages, pickVideos, type PickFolderResult } from "tauri-plugin-picker-api";
import { Dialog } from "@/components/ui";
import CollectSourcePicker from "@/components/CollectSourcePicker.vue";
import MediaPicker from "@/components/MediaPicker.vue";
import { IS_WEB } from "@/env";
import { useUiStore } from "@/stores/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { COLLECT_GROUPS, useCollectDialogsStore } from "@/stores/collectDialogs";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { kameMessage } from "@/utils/kameMessage";
import CollectNetworkDialog from "./CollectNetworkDialog.vue";
import CollectLocalDialog from "./CollectLocalDialog.vue";

const { t } = useI18n();
const uiStore = useUiStore();
const crawlerStore = useCrawlerStore();
const store = useCollectDialogsStore();

const chooserItems = computed(() =>
  COLLECT_GROUPS.map((group) =>
    group === "local"
      ? { group, icon: FolderOpen, label: t("gallery.local") }
      : { group, icon: Globe, label: t("gallery.network") },
  ),
);

/** 先关掉选择器再处理（选文件夹时由 MediaPicker 调 pickFolder，结果经 payload 传入） */
async function handleMediaPickerSelect(type: "image" | "folder" | "video", payload?: PickFolderResult) {
  store.mediaPickerOpen = false;
  if (await guardDesktopOnly("picker")) return;
  try {
    let paths: string[] = [];
    let recursive = false;
    if (type === "image") {
      paths = (await pickImages()) ?? [];
    } else if (type === "video") {
      paths = (await pickVideos()) ?? [];
    } else if (type === "folder" && payload) {
      const folderPath = payload.uri ?? payload.path;
      if (folderPath) paths = [folderPath];
      recursive = true;
    }
    // 用户取消或没有选择
    if (paths.length === 0) return;
    crawlerStore.addTask("local-import", undefined, { paths, recursive });
    kameMessage.success(t("gallery.localImportTaskAdded"));
  } catch (error) {
    console.error("[collect] 安卓媒体选择失败:", error);
    if (error !== "cancel" && error !== "close") {
      kameMessage.error(t("gallery.selectFailed") + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
}
</script>
