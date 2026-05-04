<template>
  <ProviderChildrenNode
    :name="label"
    :path="path"
    :depth="1"
    :active="active"
    :default-expanded="defaultExpanded"
    :filter="imagesChangeFilter"
    @select="$emit('select', { type: 'plugin', pluginId })"
    @update:expanded="onExpanded"
  >
    <PluginExtendProviderChildrenNode
      v-for="child in children"
      :key="child.name"
      :plugin-id="pluginId"
      :name="child.name"
      :extend-path="child.name"
      :is-leaf="isProviderLeaf(child)"
      :depth="2"
      @select="$emit('select', $event)"
    />
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { usePluginStore } from "@/stores/plugins";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { GalleryFilter } from "@/utils/galleryPath";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import PluginExtendProviderChildrenNode from "./PluginExtendProviderChildrenNode.vue";
import {
  isProviderLeaf,
  isSameGalleryFilter,
  listProviderDirs,
  pluginExtendPath,
  pluginPath,
  unknownOrMatchingPlugin,
  useGalleryFilterTreeContext,
  type ProviderChildDir,
  type RefreshTarget,
} from "./context";

const props = defineProps<{
  pluginId: string;
}>();

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const pluginStore = usePluginStore();
const { filter, prefix, registerRefreshTarget } = useGalleryFilterTreeContext();
const children = ref<ProviderChildDir[]>([]);
const loaded = ref(false);
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;

const label = computed(() => pluginStore.pluginLabel(props.pluginId));
const path = computed(() => pluginPath(prefix.value, props.pluginId));
const active = computed(() =>
  isSameGalleryFilter({ type: "plugin", pluginId: props.pluginId }, filter.value)
);
const defaultExpanded = computed(() =>
  filter.value.type === "plugin" &&
  filter.value.pluginId === props.pluginId &&
  !!filter.value.extendPath?.trim()
);
const matchesPlugin = computed(() => unknownOrMatchingPlugin(props.pluginId));
const imagesChangeFilter = (payload: ImagesChangePayload) =>
  matchesPlugin.value(payload.pluginIds);

async function refreshChildren() {
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const entries = await listProviderDirs(
      `${pluginExtendPath(prefix.value, props.pluginId)}/`
    );
    if (token !== listToken || expectedPrefix !== prefix.value) return;
    children.value = entries;
    loaded.value = true;
  } catch {
    if (token === listToken && expectedPrefix === prefix.value) {
      children.value = [];
      loaded.value = true;
    }
  }
}

async function onExpanded(expanded: boolean) {
  if (expanded && !loaded.value) {
    await refreshChildren();
  }
}

useImagesChangeRefresh({
  enabled: loaded,
  waitMs: 3000,
  filter: imagesChangeFilter,
  onRefresh: refreshChildren,
});

useAlbumImagesChangeRefresh({
  enabled: loaded,
  waitMs: 3000,
  filter: (payload) => {
    return (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: refreshChildren,
});

onMounted(() => {
  if (defaultExpanded.value) {
    void refreshChildren();
  }
  const target: RefreshTarget = {
    refresh: async () => {
      if (loaded.value) await refreshChildren();
    },
  };
  unregisterRefresh = registerRefreshTarget(target);
});

onBeforeUnmount(() => {
  unregisterRefresh?.();
  unregisterRefresh = null;
});
</script>
