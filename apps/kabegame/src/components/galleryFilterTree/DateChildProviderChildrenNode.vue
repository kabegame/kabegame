<template>
  <ProviderChildrenNode
    v-if="canHaveChildren"
    :name="label"
    :path="path"
    :depth="depth"
    :active="active"
    :default-expanded="defaultExpanded"
    @select="$emit('select', filterForSelf)"
    @update:expanded="onExpanded"
  >
    <DateChildProviderChildrenNode
      v-for="child in childRows"
      :key="child.seg"
      :segments="[...segments, child.seg]"
      :depth="depth + 1"
      @select="$emit('select', $event)"
    />
  </ProviderChildrenNode>
  <ProviderChildrenNode
    v-else
    :name="label"
    :path="path"
    :depth="depth"
    :active="active"
    @select="$emit('select', filterForSelf)"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { GalleryFilter } from "@/utils/galleryPath";
import {
  buildTimeMenuScopeLabels,
  type TimeMenuScopeLabels,
} from "@/utils/galleryTimeFilterMenu";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import {
  dateFilterSegment,
  isSameGalleryFilter,
  joinProviderPath,
  listProviderDirs,
  useGalleryFilterTreeContext,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  segments: string[];
  depth?: number;
}>(), {
  depth: 1,
});

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t, locale } = useI18n();
const { filter, prefix, registerRefreshTarget } = useGalleryFilterTreeContext();
const childRows = ref<Array<{ seg: string }>>([]);
const loaded = ref(false);
let listToken = 0;
let unregisterRefresh: (() => void) | null = null;

const labels = computed(() => buildTimeMenuScopeLabels(t, String(locale.value)));
const segment = computed(() => dateFilterSegment(props.segments));
const filterForSelf = computed<GalleryFilter>(() => ({
  type: "date",
  segment: segment.value,
}));
const path = computed(() => joinProviderPath(prefix.value, "date", ...props.segments));
const canHaveChildren = computed(() => props.segments.length < 3);
const active = computed(() => isSameGalleryFilter(filterForSelf.value, filter.value));
const defaultExpanded = computed(() => {
  const activeSegment = filter.value.type === "date" ? filter.value.segment : "";
  const current = segment.value;
  return !!current && activeSegment.startsWith(`${current}-`);
});
const label = computed(() => labelForSegments(props.segments, labels.value));

function labelForSegments(segments: string[], currentLabels: TimeMenuScopeLabels) {
  const current = dateFilterSegment(segments);
  if (!current) return segments[segments.length - 1] ?? "";
  if (/^\d{4}$/.test(current)) {
    return currentLabels.labelFullYearRow(current);
  }
  if (/^\d{4}-\d{2}$/.test(current)) {
    return currentLabels.labelMonthRow(current);
  }
  return currentLabels.labelDayRow(current);
}

function childSegmentPattern() {
  switch (props.segments.length) {
    case 1:
      return /^(\d{2})m$/;
    case 2:
      return /^(\d{2})d$/;
    default:
      return null;
  }
}

async function refreshChildren() {
  if (!canHaveChildren.value) return;
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  try {
    const pattern = childSegmentPattern();
    const entries = await listProviderDirs(`${joinProviderPath(path.value)}/`);
    if (token !== listToken || expectedPrefix !== prefix.value) return;
    childRows.value = entries
      .map((entry) => ({ seg: entry.name }))
      .filter((row) => !pattern || pattern.test(row.seg));
    loaded.value = true;
  } catch {
    if (token === listToken && expectedPrefix === prefix.value) {
      childRows.value = [];
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
