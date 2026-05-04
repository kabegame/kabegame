<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByPlugin')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'plugin'"
    :selectable="false"
    @update:expanded="onExpanded"
  >
    <PluginProviderChildrenNode
      v-for="entry in pluginEntries"
      :key="pluginKey(entry.pluginId)"
      :plugin-id="entry.pluginId"
      @select="$emit('select', $event)"
    />
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import type { GalleryFilter } from "@/utils/galleryPath";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useTrailingThrottleFn } from "@/composables/useTrailingThrottle";
import { listen } from "@/api/rpc";
import { usePluginStore } from "@/stores/plugins";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import PluginProviderChildrenNode from "./PluginProviderChildrenNode.vue";
import {
  countProviderPath,
  joinProviderPath,
  listProviderDirs,
  pluginPath,
  useGalleryFilterTreeContext,
  type RefreshTarget,
} from "./context";

defineEmits<{
  select: [filter: GalleryFilter];
}>();

type UnlistenFn = () => void;

const { t } = useI18n();
const pluginStore = usePluginStore();
const { filter, prefix, registerRefreshTarget } = useGalleryFilterTreeContext();
const pluginEntries = ref<Array<{ pluginId: string }>>([]);
const loaded = ref(false);
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;
const unlistenFns: UnlistenFn[] = [];

const rootCountPath = computed(() => joinProviderPath(prefix.value, "all"));
const throttledRefreshList = useTrailingThrottleFn(async () => {
  if (loaded.value) await refreshList();
}, 3000);

function pluginKey(pluginId: string) {
  const version = pluginStore.plugins.find((plugin) => plugin.id === pluginId)?.version ?? "";
  return `${pluginId}:${version}`;
}

async function refreshList() {
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const entries = await listProviderDirs(`${joinProviderPath(prefix.value, "plugin")}/`);
    const groups = await Promise.all(
      entries.map(async (entry) => ({
        pluginId: entry.name,
        count:
          typeof entry.total === "number"
            ? entry.total
            : await countProviderPath(pluginPath(expectedPrefix, entry.name)),
      }))
    );
    if (token !== listToken || expectedPrefix !== prefix.value) return;
    pluginEntries.value = groups
      .filter((group) => group.pluginId && group.count > 0)
      .map((group) => ({ pluginId: group.pluginId }));
    loaded.value = true;
  } catch {
    if (token === listToken && expectedPrefix === prefix.value) {
      pluginEntries.value = [];
      loaded.value = true;
    }
  }
}

async function onExpanded(expanded: boolean) {
  if (expanded && !loaded.value) {
    await refreshList();
  }
}

async function listenPluginTreeRefreshEvents() {
  unlistenFns.push(
    await listen<ImagesChangePayload>("images-change", async () => {
      await throttledRefreshList.trigger();
    })
  );
  for (const eventName of ["plugin-added", "plugin-updated", "plugin-deleted"] as const) {
    unlistenFns.push(
      await listen<Record<string, unknown>>(eventName, async () => {
        await throttledRefreshList.trigger();
      })
    );
  }
}

useAlbumImagesChangeRefresh({
  enabled: loaded,
  waitMs: 3000,
  filter: (payload) => {
    return (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: refreshList,
});

onMounted(() => {
  if (filter.value.type === "plugin") {
    void refreshList();
  }
  void listenPluginTreeRefreshEvents();
  const target: RefreshTarget = {
    refresh: async () => {
      if (loaded.value) await refreshList();
    },
  };
  unregisterRefresh = registerRefreshTarget(target);
});

onBeforeUnmount(() => {
  throttledRefreshList.cancel();
  unregisterRefresh?.();
  unregisterRefresh = null;
  for (const unlisten of unlistenFns.splice(0)) {
    unlisten();
  }
});
</script>
