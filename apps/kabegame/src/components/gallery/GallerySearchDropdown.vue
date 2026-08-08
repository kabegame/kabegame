<template>
  <KbFilterDropdown
    :model-value="query.trim() ? query : null"
    :chip-label="t('gallery.advancedChipSearch')"
    :selected-label="query"
    :badge="query.trim() ? searchModeLabel(mode) : undefined"
    :any-label="t('gallery.filterAnyKeyword')"
    :chip-display="chipDisplay"
    :title="chipTitle"
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
    /** 面板里可见的 tab 集合：任务/畅游详情只暴露基础三项。 */
    modes?: readonly GallerySearchMode[];
    /** 取非语境（高级查询的 ~not 组）：计数显示为负数。 */
    negated?: boolean;
    /**
     * chip 信息密度，透传给 KbFilterDropdown。画廊工具条给 `value`（维度名进
     * tooltip）或 `icon`（精简）；高级查询条件行留默认的 `full`。
     */
    chipDisplay?: "full" | "value" | "icon";
    /**
     * 提交防抖毫秒数。0 = 逐键提交。
     * 画廊工具行的每次提交都会 navigate + 重查，必须防抖；高级弹窗里只改本地
     * 草稿树，不需要。清空一律立即生效，不必等这段时间。
     */
    debounce?: number;
  }>(),
  { modes: () => GALLERY_SEARCH_MODES, negated: false, chipDisplay: "full", debounce: 0 },
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

/** chip 上省掉的维度名与取值在 tooltip 里补回来（工具条的 value / icon 档）。 */
const chipTitle = computed(() => {
  const label = t("gallery.advancedChipSearch");
  const value = props.query.trim()
    ? `${searchModeLabel(props.mode)}：${props.query}`
    : t("gallery.filterAnyKeyword");
  return `${label} · ${value}`;
});

function searchModeLabel(mode: GallerySearchMode): string {
  if (mode === "metadata") return t("gallery.searchModeMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeNativeMetadata");
  if (mode === "local-path") return t("gallery.searchModeLocalPath");
  if (mode === "url") return t("gallery.searchModeUrl");
  return t("gallery.searchModeDisplayName");
}

/** 当前 mode 不在允许集合里（分享来的 URL 落到受限页）时把它临时补进 tab 列表：
 *  既不静默改写用户的查询语义，也让人能一眼看见并切走；切走后该 tab 自然消失。 */
const visibleModes = computed<readonly GallerySearchMode[]>(() =>
  props.modes.includes(props.mode) ? props.modes : [...props.modes, props.mode],
);

const searchModeItems = computed<KbTabItem<GallerySearchMode>[]>(() =>
  visibleModes.value.map((mode) => ({ name: mode, label: searchModeLabel(mode) })),
);

const placeholder = computed(() => {
  if (props.mode === "metadata") return t("gallery.searchPlaceholderMetadata");
  if (props.mode === "native-metadata") return t("gallery.searchPlaceholderNativeMetadata");
  if (props.mode === "local-path") return t("gallery.searchPlaceholderLocalPath");
  if (props.mode === "url") return t("gallery.searchPlaceholderUrl");
  return t("gallery.searchPlaceholder");
});

/** 说明按模式走：一段把各模式串起来的总说明，读的人得先自己找哪半句是当前模式。 */
const help = computed(() => {
  if (props.mode === "metadata") return t("gallery.searchModeHelpMetadata");
  if (props.mode === "native-metadata") return t("gallery.searchModeHelpNativeMetadata");
  if (props.mode === "local-path") return t("gallery.searchModeHelpLocalPath");
  if (props.mode === "url") return t("gallery.searchModeHelpUrl");
  return t("gallery.searchModeHelpDisplayName");
});
</script>
