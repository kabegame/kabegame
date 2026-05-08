<template>
  <template v-if="!shouldHide">
  <div
    class="provider-tree-row"
    :class="{
      'is-active': active,
      'is-disabled': !selectable,
      'is-loading': loading,
    }"
    :style="{ '--tree-depth': depth }"
  >
    <button
      v-if="hasChildren"
      class="tree-toggle"
      :class="{ 'is-expanded': isExpanded }"
      type="button"
      @click.stop="setExpanded(!isExpanded)"
    >
      <el-icon>
        <ArrowRight />
      </el-icon>
    </button>
    <span v-else class="tree-toggle-spacer" />

    <button
      v-if="selectable"
      class="tree-select"
      type="button"
      @click="onLabelClick"
    >
      <span class="tree-label">{{ name }}</span>
      <span class="tree-count">({{ displayCount }})</span>
    </button>
    <button
      v-else
      class="tree-select is-static"
      type="button"
      @click="onLabelClick"
    >
      <span class="tree-label">{{ name }}</span>
      <span class="tree-count">({{ displayCount }})</span>
    </button>
  </div>

  <div v-if="hasChildren && childrenMounted" v-show="isExpanded" class="tree-children">
    <slot />
  </div>
  </template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useSlots, watch } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import { useImagesChangeRefresh, type ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh, type AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import {
  countProviderPath,
  useGalleryFilterTreeContext,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  name: string;
  path: string;
  depth?: number;
  active?: boolean;
  defaultExpanded?: boolean;
  debounce?: number;
  filter?: (payload: ImagesChangePayload) => boolean;
  selectable?: boolean;
  initialCount?: number;
  hideWhenEmpty?: boolean;
}>(), {
  depth: 0,
  active: false,
  defaultExpanded: false,
  debounce: 3000,
  selectable: true,
  hideWhenEmpty: false,
});

const emit = defineEmits<{
  select: [];
  "update:expanded": [value: boolean];
}>();

const slots = useSlots();
const { registerRefreshTarget, visible } = useGalleryFilterTreeContext();
const localExpanded = ref(props.defaultExpanded);
const childrenMounted = ref(props.defaultExpanded);
const count = ref<number | null>(null);
const loading = ref(false);
let refreshToken = 0;
let unregisterRefresh: (() => void) | null = null;

const hasChildren = computed(() => Boolean(slots.default));
const isExpanded = computed(() => localExpanded.value);
const displayCount = computed(() => (count.value == null ? "..." : String(count.value)));
const shouldHide = computed(() => props.hideWhenEmpty && count.value !== null && count.value === 0);

function setExpanded(value: boolean) {
  localExpanded.value = value;
  if (value) childrenMounted.value = true;
  emit("update:expanded", value);
}

function onLabelClick() {
  if (props.selectable) {
    emit("select");
    return;
  }
  if (hasChildren.value) {
    setExpanded(!isExpanded.value);
  }
}

async function refresh() {
  const token = ++refreshToken;
  loading.value = true;
  try {
    const next = await countProviderPath(props.path);
    if (token === refreshToken) count.value = next;
  } catch {
    if (token === refreshToken) count.value = 0;
  } finally {
    if (token === refreshToken) loading.value = false;
  }
}

function isHiddenAlbumChange(payload: AlbumImagesChangePayload) {
  return (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID);
}

useImagesChangeRefresh({
  enabled: visible,
  waitMs: props.debounce,
  filter: (payload) => {
    return props.filter ? props.filter(payload) : true;
  },
  onRefresh: refresh,
});

useAlbumImagesChangeRefresh({
  enabled: visible,
  waitMs: props.debounce,
  filter: isHiddenAlbumChange,
  onRefresh: refresh,
});

watch(visible, (v) => {
  if (v) void refresh();
});

onMounted(() => {
  if (props.initialCount != null) {
    count.value = props.initialCount;
  } else if (visible.value) {
    void refresh();
  }
  const target: RefreshTarget = { refresh };
  unregisterRefresh = registerRefreshTarget(target);
});

onBeforeUnmount(() => {
  unregisterRefresh?.();
  unregisterRefresh = null;
});

defineExpose({ refresh });
</script>

<style scoped lang="scss">
.provider-tree-row {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding-left: calc(var(--tree-depth) * 16px);
  border-radius: 6px;
  color: var(--anime-text-primary);

  &:hover {
    background: var(--el-fill-color-light);
  }

  &.is-active {
    background: rgba(255, 107, 157, 0.14);
    color: var(--anime-primary);
  }

  &.is-disabled {
    color: var(--anime-text-primary);
  }
}

.tree-toggle,
.tree-select {
  border: 0;
  background: transparent;
  color: inherit;
}

.tree-toggle {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s ease;

  &.is-expanded {
    transform: rotate(90deg);
  }
}

.tree-toggle-spacer {
  flex: 0 0 26px;
}

.tree-select {
  min-width: 0;
  flex: 1;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 4px;
  text-align: left;
  cursor: pointer;

  &.is-static {
    cursor: default;
  }
}

.tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-count {
  flex: 0 0 auto;
  color: var(--anime-text-secondary);
  font-size: 12px;
}
</style>
