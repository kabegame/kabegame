<template>
  <KbFilterDropdown
    :model-value="query.trim() ? query : null"
    :chip-label="t('gallery.advancedChipSearch')"
    :selected-label="query"
    :badge="query.trim() ? badgeLabel : undefined"
    :any-label="t('gallery.filterAnyKeyword')"
    :chip-display="chipDisplay"
    :title="chipTitle"
    :negated="negated"
    @update:model-value="
      (value) => {
        if (value === null) commit('');
      }
    "
  >
    <template #icon><Search /></template>
    <template #panel="{ close }">
      <!-- 宽度不写死：由勾选框网格的自然宽度决定（20rem 兜底，免得输入框太窄）。输入框与说明文字都要
           w-0!+min-w-full 退出宽度测量（el-input 的固有宽度有 440px、整段说明的
           max-content 更宽，任一个都会把 w-max 撑回去），定完宽再撑满。 -->
      <div class="w-max min-w-[min(20rem,calc(100vw-48px))] max-w-[calc(100vw-48px)] p-3">
        <KbText
          :model-value="draft"
          class="w-0! min-w-full"
          allow-unset
          :placeholder="t('gallery.searchPlaceholderKeywords')"
          @update:model-value="onInput"
          @keyup.enter="close"
        />

        <div class="mt-3 text-xs text-[var(--anime-text-secondary)]">{{ t("gallery.searchModesLabel") }}</div>
        <!-- 各维度的说明收进「?」：面板只留勾选本身，读说明是按需的事。 -->
        <el-checkbox-group
          :model-value="checkedModes"
          class="mt-1 grid grid-cols-2 gap-x-5"
          @update:model-value="onModesChange"
        >
          <div v-for="mode in visibleModes" :key="mode" class="flex items-center gap-1">
            <el-checkbox :value="mode" :label="searchModeLabel(mode)" :disabled="isLastChecked(mode)" />
            <el-tooltip :content="searchModeHelp(mode)" placement="top" :trigger="IS_ANDROID ? 'click' : 'hover'">
              <el-icon
                class="flex-none cursor-help text-sm text-[var(--anime-text-muted)] hover:text-[var(--anime-secondary)]"
              >
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </div>
        </el-checkbox-group>

        <!-- 底部：这一次搜索会做什么（随输入与勾选实时变化） + 通用语法提示 -->
        <p class="mb-0 mt-3 w-0! min-w-full text-xs leading-5 text-[var(--anime-text-primary)]">
          {{ summary }}
        </p>
        <p class="mb-0 mt-1 w-0! min-w-full text-xs leading-5 text-[var(--anime-text-secondary)]">
          {{ t("gallery.searchSyntaxHint") }}
        </p>
      </div>
    </template>
  </KbFilterDropdown>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElCheckbox, ElCheckboxGroup, ElIcon, ElTooltip, KbFilterDropdown } from "@kabegame/element-plus";
import { QuestionFilled, Search } from "@kabegame/element-plus-icons";
import KbText from "@/components/common/form/KbText.vue";
import { IS_ANDROID } from "@/env";
import {
  canonicalSearchModes,
  GALLERY_SEARCH_MODES,
  searchTokens,
  type GallerySearchPathMode,
} from "@/utils/galleryPath";

/**
 * 搜索维度的 chip 下拉：chip 里显示勾选维度徽章 + 关键词，面板里输入 + 勾选维度。
 * 逗号分隔的词之间为 AND（各维度通用），勾选的维度之间为 OR。
 * 画廊工具行与高级查询条件行共用一份——两边只差「要不要防抖」。
 */
const props = withDefaults(
  defineProps<{
    query: string;
    /** 勾选的搜索维度（规范顺序、非空）。 */
    selectedModes: readonly GallerySearchPathMode[];
    /**
     * 面板里可勾选的维度：任务/畅游详情只暴露基础几项。当前勾选里有不在此列的
     * （分享来的 URL 落到受限页）时临时补进列表，不静默改写查询语义。
     */
    modes?: readonly GallerySearchPathMode[];
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
  "update:selectedModes": [value: GallerySearchPathMode[]];
}>();

const { t, locale } = useI18n();

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

// ---------- 维度勾选 ----------

/** el-checkbox-group 要可变数组，props 是只读的，拷一份给它。 */
const checkedModes = computed<GallerySearchPathMode[]>(() => [...props.selectedModes]);

/** 可勾选列表 = 允许集合 ∪ 当前勾选，按规范顺序。 */
const visibleModes = computed<GallerySearchPathMode[]>(() =>
  GALLERY_SEARCH_MODES.filter((mode) => props.modes.includes(mode) || props.selectedModes.includes(mode)),
);

/** 至少留一个维度：最后一个勾选项禁用，免得出现「搜了但哪儿都不搜」。 */
function isLastChecked(mode: GallerySearchPathMode): boolean {
  return props.selectedModes.length === 1 && props.selectedModes[0] === mode;
}

function onModesChange(value: Array<string | number | boolean>) {
  const picked = value.filter((mode): mode is GallerySearchPathMode => typeof mode === "string");
  if (picked.length === 0) return;
  emit("update:selectedModes", canonicalSearchModes(picked));
}

function searchModeLabel(mode: GallerySearchPathMode): string {
  if (mode === "metadata") return t("gallery.searchModeMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeNativeMetadata");
  if (mode === "local-path") return t("gallery.searchModeLocalPath");
  if (mode === "url") return t("gallery.searchModeUrl");
  if (mode === "label") return t("gallery.searchModeLabel");
  return t("gallery.searchModeDisplayName");
}

function searchModeHelp(mode: GallerySearchPathMode): string {
  if (mode === "metadata") return t("gallery.searchModeHelpMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeHelpNativeMetadata");
  if (mode === "local-path") return t("gallery.searchModeHelpLocalPath");
  if (mode === "url") return t("gallery.searchModeHelpUrl");
  if (mode === "label") return t("gallery.searchModeHelpLabel");
  return t("gallery.searchModeHelpDisplayName");
}

const modesText = computed(() => props.selectedModes.map(searchModeLabel).join(" / "));

/** chip 徽章：单维度显示维度名，多维度显示个数（名字在 tooltip 里补全）。 */
const badgeLabel = computed(() =>
  props.selectedModes.length === 1
    ? searchModeLabel(props.selectedModes[0]!)
    : t("gallery.searchModesBadge", { n: props.selectedModes.length }),
);

/** chip 上省掉的维度名与取值在 tooltip 里补回来（工具条的 value / icon 档）。 */
const chipTitle = computed(() => {
  const label = t("gallery.advancedChipSearch");
  const value = props.query.trim() ? `${modesText.value}：${props.query}` : t("gallery.filterAnyKeyword");
  return `${label} · ${value}`;
});

// ---------- 底部总结 ----------

/** i18n 的语言码 → BCP 47，供 Intl.ListFormat 按语言连接词条。 */
function listLocale(value: string): string {
  return value === "zhtw" ? "zh-TW" : value;
}

/** 项目 lib 不含 ES2021 的 Intl.ListFormat 类型；运行时（CEF / Android WebView）都有。 */
type ListFormatCtor = new (
  locale: string,
  options: { type: "conjunction" },
) => { format(list: readonly string[]): string };

function formatTerms(tokens: readonly string[]): string {
  const quoted = tokens.map((term) => t("gallery.searchSummaryTerm", { term }));
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  try {
    if (ListFormat) return new ListFormat(listLocale(String(locale.value)), { type: "conjunction" }).format(quoted);
  } catch {
    /* 语言码不被识别：退回逗号连接 */
  }
  return quoted.join(", ");
}

/** 按当前输入（未提交的草稿也算）与勾选，说清这一次到底怎么搜。 */
const summary = computed(() => {
  const modes = modesText.value;
  const tokens = searchTokens(draft.value);
  if (tokens.length === 0) return t("gallery.searchSummaryIdle", { modes });
  const terms = formatTerms(tokens);
  if (tokens.length === 1) return t("gallery.searchSummaryMatch", { modes, terms });
  if (props.selectedModes.length === 1) return t("gallery.searchSummaryMatchAll", { modes, terms });
  return t("gallery.searchSummaryMatchAllAny", { modes, terms });
});
</script>
