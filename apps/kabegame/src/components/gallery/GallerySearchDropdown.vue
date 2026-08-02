<template>
  <KbFilterDropdown
    :model-value="query.trim() ? query : null"
    :chip-label="t('gallery.advancedChipSearch')"
    :selected-label="query"
    :badge="query.trim() ? searchModeLabel(mode) : undefined"
    :any-label="t('gallery.filterAny')"
    :title="t('gallery.searchPlaceholder')"
    :negated="negated"
    @update:model-value="(value) => { if (value === null) commit(''); }"
  >
    <template #icon><Search /></template>
    <template #panel="{ close }">
      <!-- 宽度不写死：由三个模式 tab 并排的自然宽度决定。输入框与说明文字都要
           w-0!+min-w-full 退出宽度测量（el-input 的固有宽度有 440px、整段说明的
           max-content 更宽，任一个都会把 w-max 撑回去），定完宽再撑满。 -->
      <div class="w-max max-w-[calc(100vw-48px)] p-3">
        <KbTab
          :model-value="mode"
          :items="searchModeItems"
          @update:model-value="(next) => emit('update:mode', next)"
        />
        <KbText
          :model-value="draft"
          class="mt-3 w-0! min-w-full"
          allow-unset
          :placeholder="placeholder"
          @update:model-value="onInput"
          @keyup.enter="close"
        />
        <p class="mb-0 mt-3 w-0! min-w-full text-xs leading-5 text-[var(--anime-text-secondary)]">
          {{ help }}
        </p>
      </div>
    </template>
  </KbFilterDropdown>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { KbFilterDropdown, KbTab, type KbTabItem } from "@kabegame/element-plus";
import { Search } from "@kabegame/element-plus-icons";
import KbText from "@kabegame/core/components/common/form/KbText.vue";
import { GALLERY_SEARCH_MODES, type GallerySearchMode } from "@/utils/galleryPath";

/**
 * 搜索维度的 chip 下拉：chip 里显示当前模式徽章 + 关键词，面板里切模式 + 输入。
 * 画廊工具行与高级查询条件行共用一份——两边只差「要不要防抖」和「要不要底部说明」。
 */
const props = withDefaults(
  defineProps<{
    query: string;
    mode: GallerySearchMode;
    /** 取非语境（高级查询的 ~not 组）：计数显示为负数。 */
    negated?: boolean;
    /**
     * 提交防抖毫秒数。0 = 逐键提交。
     * 画廊工具行的每次提交都会 navigate + 重查，必须防抖；高级弹窗里只改本地
     * 草稿树，不需要。清空一律立即生效，不必等这段时间。
     */
    debounce?: number;
  }>(),
  { negated: false, debounce: 0 },
);

const emit = defineEmits<{
  "update:query": [value: string];
  "update:mode": [value: GallerySearchMode];
}>();

const { t } = useI18n();

const draft = ref(props.query);
let debounceTimer: number | null = null;

watch(
  () => props.query,
  (value) => {
    if (value !== draft.value) draft.value = value;
  },
);

function clearDebounce() {
  if (debounceTimer === null) return;
  window.clearTimeout(debounceTimer);
  debounceTimer = null;
}

function commit(value: string) {
  clearDebounce();
  draft.value = value;
  if (props.query !== value) emit("update:query", value);
}

function onInput(value: string) {
  draft.value = value;
  clearDebounce();
  // 清空立即生效：等 300ms 才撤销过滤会让人以为没点上。
  if (!props.debounce || !value) {
    commit(value);
    return;
  }
  debounceTimer = window.setTimeout(() => commit(value), props.debounce);
}

onBeforeUnmount(clearDebounce);

function searchModeLabel(mode: GallerySearchMode): string {
  if (mode === "metadata") return t("gallery.searchModeMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeNativeMetadata");
  return t("gallery.searchModeDisplayName");
}

const searchModeItems = computed<KbTabItem<GallerySearchMode>[]>(() =>
  GALLERY_SEARCH_MODES.map((mode) => ({ name: mode, label: searchModeLabel(mode) })),
);

const placeholder = computed(() => {
  if (props.mode === "metadata") return t("gallery.searchPlaceholderMetadata");
  if (props.mode === "native-metadata") return t("gallery.searchPlaceholderNativeMetadata");
  return t("gallery.searchPlaceholder");
});

/** 说明按模式走：一段把三个模式串起来的总说明，读的人得先自己找哪半句是当前模式。 */
const help = computed(() => {
  if (props.mode === "metadata") return t("gallery.searchModeHelpMetadata");
  if (props.mode === "native-metadata") return t("gallery.searchModeHelpNativeMetadata");
  return t("gallery.searchModeHelpDisplayName");
});
</script>
