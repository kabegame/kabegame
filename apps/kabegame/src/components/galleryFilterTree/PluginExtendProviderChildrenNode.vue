<template>
  <ProviderChildrenNode
    v-if="!isLeaf"
    :name="name"
    :path="path"
    :depth="depth"
    :active="active"
    :default-expanded="defaultExpanded"
    :filter="imagesChangeFilter"
    @select="$emit('select', filterForSelf)"
    @update:expanded="onExpanded"
  >
    <PluginExtendProviderChildrenNode
      v-for="child in children"
      :key="child.name"
      :plugin-id="pluginId"
      :name="child.name"
      :extend-path="childExtendPath(child.name)"
      :is-leaf="isProviderLeaf(child)"
      :depth="depth + 1"
      @select="$emit('select', $event)"
    />
  </ProviderChildrenNode>
  <ProviderChildrenNode
    v-else
    :name="name"
    :path="path"
    :depth="depth"
    :active="active"
    :filter="imagesChangeFilter"
    @select="$emit('select', filterForSelf)"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { GalleryFilter } from "@/utils/galleryPath";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import {
  isProviderLeaf,
  isSameGalleryFilter,
  joinProviderPath,
  listProviderDirs,
  normalizeProviderPath,
  pluginExtendPath,
  unknownOrMatchingPlugin,
  useGalleryFilterTreeContext,
  type ProviderChildDir,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  pluginId: string;
  name: string;
  extendPath: string;
  isLeaf?: boolean;
  depth?: number;
}>(), {
  isLeaf: false,
  depth: 2,
});

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { filter, prefix, registerRefreshTarget } = useGalleryFilterTreeContext();
const children = ref<ProviderChildDir[]>([]);
const loaded = ref(false);
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;

const path = computed(() =>
  pluginExtendPath(prefix.value, props.pluginId, props.extendPath)
);
const filterForSelf = computed<GalleryFilter>(() => ({
  type: "plugin",
  pluginId: props.pluginId,
  extendPath: normalizeProviderPath(props.extendPath),
}));
const active = computed(() => isSameGalleryFilter(filterForSelf.value, filter.value));
const defaultExpanded = computed(() => {
  if (filter.value.type !== "plugin" || filter.value.pluginId !== props.pluginId) return false;
  const current = normalizeProviderPath(props.extendPath);
  const activePath = normalizeProviderPath(filter.value.extendPath ?? "");
  return !!current && activePath.startsWith(`${current}/`);
});
const matchesPlugin = computed(() => unknownOrMatchingPlugin(props.pluginId));
const imagesChangeFilter = (payload: ImagesChangePayload) =>
  matchesPlugin.value(payload.pluginIds);

function childExtendPath(name: string) {
  return joinProviderPath(props.extendPath, name);
}

async function refreshChildren() {
  if (props.isLeaf) return;
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const entries = await listProviderDirs(`${path.value}/`);
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
