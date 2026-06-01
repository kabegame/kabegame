<template>
  <template v-if="!shouldHide">
    <div
      class="min-h-8 flex items-center pl-[calc(var(--tree-depth)*16px)] rounded-[6px] text-[var(--anime-text-primary)] hover:bg-[var(--el-fill-color-light)]"
      :class="{
        '!bg-[rgba(255,107,157,0.14)] !text-[var(--anime-primary)]': active,
      }"
      :style="{ '--tree-depth': depth }"
      :aria-busy="loading"
    >
      <button
        v-if="hasChildren"
        class="w-[26px] h-[26px] flex-none inline-flex items-center justify-center border-0 bg-transparent text-inherit cursor-pointer transition-transform duration-150 ease-[ease]"
        :class="{ 'rotate-90': isExpanded }"
        type="button"
        @click.stop="setExpanded(!isExpanded)"
      >
        <el-icon>
          <ArrowRight />
        </el-icon>
      </button>
      <span v-else class="flex-none w-[26px]" />

      <button
        class="min-w-0 flex-1 h-[30px] flex items-center gap-1 border-0 bg-transparent text-inherit text-left cursor-pointer"
        :class="{ 'cursor-default': !selectable }"
        type="button"
        @click="onLabelClick"
      >
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ name }}</span>
        <span class="flex-none text-[var(--anime-text-secondary)] text-xs">({{ displayCount }})</span>
      </button>
    </div>

    <div v-if="hasChildren && childrenMounted" v-show="isExpanded">
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
const { autoExpandRoot, registerRefreshTarget, visible } = useGalleryFilterTreeContext();
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
  if (localExpanded.value === value && (!value || childrenMounted.value)) return;
  localExpanded.value = value;
  if (value) childrenMounted.value = true;
  emit("update:expanded", value);
}

function shouldAutoExpand() {
  return props.defaultExpanded || (autoExpandRoot.value && props.depth === 0 && hasChildren.value);
}

function syncAutoExpand() {
  if (visible.value && shouldAutoExpand()) {
    setExpanded(true);
  }
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
  if (!v) return;
  syncAutoExpand();
  void refresh();
});

watch([autoExpandRoot, hasChildren, () => props.defaultExpanded], syncAutoExpand);

onMounted(() => {
  syncAutoExpand();
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
