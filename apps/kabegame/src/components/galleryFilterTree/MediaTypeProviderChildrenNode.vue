<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByMediaType')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'media-type'"
    :selectable="false"
  >
    <ProviderChildrenNode
      :name="t('gallery.filterImageOnly')"
      :path="imagePath"
      :depth="1"
      :active="isSameGalleryFilter({ type: 'media-type', kind: 'image' }, filter)"
      :default-expanded="filter.type === 'media-type' && filter.kind === 'image' && !!filter.format"
      @select="$emit('select', { type: 'media-type', kind: 'image' })"
      @update:expanded="(expanded) => onExpanded('image', expanded)"
    >
      <ProviderChildrenNode
        v-for="entry in imageFormats"
        :key="entry.name"
        :name="entry.name"
        :path="pathForSegment(`media-type/image/${entry.name}`)"
        :depth="2"
        :active="isSameGalleryFilter({ type: 'media-type', kind: 'image', format: entry.name }, filter)"
        :initial-count="entry.total ?? undefined"
        @select="$emit('select', { type: 'media-type', kind: 'image', format: entry.name })"
      />
    </ProviderChildrenNode>
    <ProviderChildrenNode
      :name="t('gallery.filterVideoOnly')"
      :path="videoPath"
      :depth="1"
      :active="isSameGalleryFilter({ type: 'media-type', kind: 'video' }, filter)"
      :default-expanded="filter.type === 'media-type' && filter.kind === 'video' && !!filter.format"
      @select="$emit('select', { type: 'media-type', kind: 'video' })"
      @update:expanded="(expanded) => onExpanded('video', expanded)"
    >
      <ProviderChildrenNode
        v-for="entry in videoFormats"
        :key="entry.name"
        :name="entry.name"
        :path="pathForSegment(`media-type/video/${entry.name}`)"
        :depth="2"
        :active="isSameGalleryFilter({ type: 'media-type', kind: 'video', format: entry.name }, filter)"
        :initial-count="entry.total ?? undefined"
        @select="$emit('select', { type: 'media-type', kind: 'video', format: entry.name })"
      />
    </ProviderChildrenNode>
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { GalleryFilter } from "@/utils/galleryPath";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import {
  isSameGalleryFilter,
  listProviderDirs,
  useGalleryFilterTreeContext,
  type ProviderChildDir,
  type RefreshTarget,
} from "./context";

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t } = useI18n();
const { filter, prefix, pathForSegment, registerRefreshTarget } = useGalleryFilterTreeContext();
const imageFormats = ref<ProviderChildDir[]>([]);
const videoFormats = ref<ProviderChildDir[]>([]);
const loadedKinds = ref(new Set<"image" | "video">());
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;

const rootCountPath = computed(() => pathForSegment("all"));
const imagePath = computed(() => pathForSegment("media-type/image"));
const videoPath = computed(() => pathForSegment("media-type/video"));

function formatsRef(kind: "image" | "video") {
  return kind === "image" ? imageFormats : videoFormats;
}

function pathForKind(kind: "image" | "video") {
  return kind === "image" ? imagePath.value : videoPath.value;
}

async function refreshFormats(kind: "image" | "video") {
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const entries = await listProviderDirs(`${pathForKind(kind)}/`);
    if (token !== listToken || expectedPrefix !== prefix.value) return;
    formatsRef(kind).value = entries;
    loadedKinds.value = new Set([...loadedKinds.value, kind]);
  } catch {
    if (token === listToken && expectedPrefix === prefix.value) {
      formatsRef(kind).value = [];
      loadedKinds.value = new Set([...loadedKinds.value, kind]);
    }
  }
}

async function onExpanded(kind: "image" | "video", expanded: boolean) {
  if (expanded && !loadedKinds.value.has(kind)) {
    await refreshFormats(kind);
  }
}

async function refreshLoadedFormats() {
  await Promise.all([...loadedKinds.value].map((kind) => refreshFormats(kind)));
}

useImagesChangeRefresh({
  enabled: computed(() => loadedKinds.value.size > 0),
  waitMs: 3000,
  onRefresh: refreshLoadedFormats,
});

useAlbumImagesChangeRefresh({
  enabled: computed(() => loadedKinds.value.size > 0),
  waitMs: 3000,
  filter: (payload) => (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID),
  onRefresh: refreshLoadedFormats,
});

onMounted(() => {
  if (filter.value.type === "media-type" && filter.value.format) {
    void refreshFormats(filter.value.kind);
  }
  const target: RefreshTarget = {
    refresh: refreshLoadedFormats,
  };
  unregisterRefresh = registerRefreshTarget(target);
});

onBeforeUnmount(() => {
  unregisterRefresh?.();
  unregisterRefresh = null;
});
</script>
