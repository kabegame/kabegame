<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByTime')"
    :path="rootCountPath"
    :default-expanded="defaultExpanded"
    :selectable="false"
    @update:expanded="onExpanded"
  >
    <DateChildProviderChildrenNode
      v-for="year in years"
      :key="year.seg"
      :segments="[year.seg]"
      :depth="1"
      @select="$emit('select', $event)"
    />
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
import DateChildProviderChildrenNode from "./DateChildProviderChildrenNode.vue";
import {
  joinProviderPath,
  listProviderDirs,
  useGalleryFilterTreeContext,
  type RefreshTarget,
} from "./context";

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t } = useI18n();
const { filter, prefix, registerRefreshTarget } = useGalleryFilterTreeContext();
const years = ref<Array<{ seg: string; year: string }>>([]);
const loaded = ref(false);
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;

const rootCountPath = computed(() => joinProviderPath(prefix.value, "all"));
const defaultExpanded = computed(() => filter.value.type === "date");

async function refreshList() {
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const entries = await listProviderDirs(`${joinProviderPath(prefix.value, "date")}/`);
    if (token !== listToken || expectedPrefix !== prefix.value) return;
    years.value = entries
      .map((entry) => {
        const year = /^(\d{4})y$/.exec(entry.name)?.[1];
        return year ? { seg: entry.name, year } : null;
      })
      .filter((row): row is { seg: string; year: string } => !!row);
    loaded.value = true;
  } catch {
    if (token === listToken && expectedPrefix === prefix.value) {
      years.value = [];
      loaded.value = true;
    }
  }
}

async function onExpanded(expanded: boolean) {
  if (expanded && !loaded.value) {
    await refreshList();
  }
}

useImagesChangeRefresh({
  enabled: loaded,
  waitMs: 3000,
  onRefresh: refreshList,
});

useAlbumImagesChangeRefresh({
  enabled: loaded,
  waitMs: 3000,
  filter: (payload) => {
    return (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: refreshList,
});

onMounted(() => {
  if (defaultExpanded.value) {
    void refreshList();
  }
  const target: RefreshTarget = {
    refresh: async () => {
      if (loaded.value) await refreshList();
    },
  };
  unregisterRefresh = registerRefreshTarget(target);
});

onBeforeUnmount(() => {
  unregisterRefresh?.();
  unregisterRefresh = null;
});
</script>
