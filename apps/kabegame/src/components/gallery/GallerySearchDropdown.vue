<template>
  <KbFilterDropdown
    :model-value="isActive ? query : null"
    :chip-label="t('gallery.advancedChipSearch')"
    :selected-label="query"
    :badge="isActive ? badgeLabel : undefined"
    :any-label="t('gallery.filterAnyKeyword')"
    :chip-display="chipDisplay"
    :title="chipTitle"
    :negated="negated"
    @open="focusSearchInput"
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
        <!-- 第一行：输入框 + 全选。外层 w-0!+min-w-full 退出宽度测量，同上。 -->
        <div class="flex w-0! min-w-full items-center gap-3">
          <KbText
            ref="searchInputRef"
            :model-value="draft"
            class="min-w-0 flex-1"
            allow-unset
            :placeholder="t('gallery.searchPlaceholderKeywords')"
            @update:model-value="onInput"
            @keyup.enter="close"
          />
          <el-checkbox
            class="flex-none"
            :model-value="allChecked"
            :indeterminate="someChecked"
            :label="t('gallery.searchModesSelectAll')"
            @update:model-value="onSelectAll"
          />
        </div>

        <div class="mt-3 text-xs text-[var(--anime-text-secondary)]">{{ t("gallery.searchModesLabel") }}</div>
        <!-- 各维度的说明收进「?」：面板只留勾选本身，读说明是按需的事。 -->
        <el-checkbox-group
          :model-value="checkedModes"
          class="mt-1 grid grid-cols-2 gap-x-5"
          @update:model-value="onModesChange"
        >
          <div v-for="mode in visibleModes" :key="mode" class="flex items-center gap-1">
            <el-checkbox :value="mode" :label="searchModeLabel(mode)" />
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
        <p
          class="mb-0 mt-3 w-0! min-w-full text-xs leading-5"
          :class="parsedDraft.ok ? 'text-[var(--anime-text-primary)]' : 'text-[var(--anime-danger)]'"
        >
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElCheckbox, ElCheckboxGroup, ElIcon, ElTooltip, KbFilterDropdown } from "@kabegame/element-plus";
import { QuestionFilled, Search } from "@kabegame/element-plus-icons";
import KbText from "@/components/common/form/KbText.vue";
import { IS_ANDROID } from "@/env";
import { canonicalSearchModes, GALLERY_SEARCH_MODES, type GallerySearchPathMode } from "@/utils/galleryPath";
import { parseSearchExpr, type SearchExpr } from "@/utils/searchExpr";

/**
 * 搜索维度的 chip 下拉：chip 里显示勾选维度徽章 + 关键词，面板里输入 + 勾选维度。
 * 输入是搜索表达式：`,` 且、`;` 或、前置 `!` 非、`()` 分组，`\` 转义或 `"…"` 表示字面量；
 * 勾选的维度作用在每个词上（任一维度包含即算含）。语法错误的输入不提交，底部说明指出错处。
 * 画廊工具行与高级查询条件行共用一份——两边只差「要不要防抖」。
 */
const props = withDefaults(
  defineProps<{
    query: string;
    /** 勾选的搜索维度（规范顺序）。空 = 不做搜索过滤，输入只留在框里。 */
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
  /** 带上输入框当前内容：全不选时搜索已不在查询里，重新勾选要靠它恢复。 */
  "update:selectedModes": [value: GallerySearchPathMode[], query: string];
}>();

const { t, locale } = useI18n();

const draft = ref(props.query);
const searchInputRef = ref<InstanceType<typeof KbText>>();
let debounceTimer: number | null = null;

watch(
  () => props.query,
  (value) => {
    // 全不选时搜索从查询里移除、query 变空，但输入框要保住内容，重新勾选时接着用。
    if (value === "" && props.selectedModes.length === 0) return;
    if (value !== draft.value) draft.value = value;
  },
);

/** chip 是否点亮：有输入且至少勾选一个维度才构成过滤。 */
const isActive = computed(() => !!props.query.trim() && props.selectedModes.length > 0);

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

const parsedDraft = computed(() => parseSearchExpr(draft.value));

function onInput(value: string) {
  draft.value = value;
  clearDebounce();
  // 清空立即生效：等 300ms 才撤销过滤会让人以为没点上。
  if (!value) {
    commit(value);
    return;
  }
  // 语法错误（多半是还没打完，如 `(girl;`）不提交：保持上一次有效的查询。
  if (!parseSearchExpr(value).ok) return;
  if (!props.debounce) {
    commit(value);
    return;
  }
  debounceTimer = window.setTimeout(() => commit(value), props.debounce);
}

onBeforeUnmount(clearDebounce);

async function focusSearchInput() {
  await nextTick();
  window.requestAnimationFrame(() => searchInputRef.value?.focus());
}

// ---------- 维度勾选 ----------

/** el-checkbox-group 要可变数组，props 是只读的，拷一份给它。 */
const checkedModes = computed<GallerySearchPathMode[]>(() => [...props.selectedModes]);

/** 可勾选列表 = 允许集合 ∪ 当前勾选，按规范顺序。 */
const visibleModes = computed<GallerySearchPathMode[]>(() =>
  GALLERY_SEARCH_MODES.filter((mode) => props.modes.includes(mode) || props.selectedModes.includes(mode)),
);

const allChecked = computed(() => visibleModes.value.every((mode) => props.selectedModes.includes(mode)));
const someChecked = computed(() => props.selectedModes.length > 0 && !allChecked.value);

function emitModes(modes: readonly GallerySearchPathMode[]) {
  // 勾选变化立即生效：挂起的防抖输入一并带上，不再单独提交。
  clearDebounce();
  // 输入框里是语法错误的草稿时沿用已生效的查询，不把错误输入带进路由。
  emit("update:selectedModes", canonicalSearchModes(modes), parsedDraft.value.ok ? draft.value : props.query);
}

/** 可以全部取消：一个维度都不勾 = 不做搜索过滤。 */
function onModesChange(value: Array<string | number | boolean>) {
  emitModes(value.filter((mode): mode is GallerySearchPathMode => typeof mode === "string"));
}

function onSelectAll(checked: string | number | boolean) {
  emitModes(checked ? visibleModes.value : []);
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

/** chip 徽章：全选显示「全部」，单维度显示维度名，其余显示个数（名字在 tooltip 里补全）。 */
const badgeLabel = computed(() => {
  if (allChecked.value) return t("gallery.searchModesBadgeAll");
  if (props.selectedModes.length === 1) return searchModeLabel(props.selectedModes[0]!);
  return t("gallery.searchModesBadge", { n: props.selectedModes.length });
});

/** chip 上省掉的维度名与取值在 tooltip 里补回来（工具条的 value / icon 档）。 */
const chipTitle = computed(() => {
  const label = t("gallery.advancedChipSearch");
  const value = isActive.value ? `${modesText.value}：${props.query}` : t("gallery.filterAnyKeyword");
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
  options: { type: "conjunction" | "disjunction" },
) => { format(list: readonly string[]): string };

function formatList(items: readonly string[], type: "conjunction" | "disjunction"): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  try {
    if (ListFormat) return new ListFormat(listLocale(String(locale.value)), { type }).format(items);
  } catch {
    /* 语言码不被识别：退回分隔符连接 */
  }
  return items.join(type === "conjunction" ? ", " : " / ");
}

function quoteTerm(value: string): string {
  return t("gallery.searchSummaryTerm", { term: value });
}

/** 语法树 → 一句话：词读作「含」/「不含」，嵌套的且 / 或组加括号，免得「和」「或」混读。 */
function describeExpr(expr: SearchExpr, nested = false): string {
  switch (expr.kind) {
    case "term":
      return t("gallery.searchSummaryHas", { term: quoteTerm(expr.value) });
    case "not":
      return expr.item.kind === "term"
        ? t("gallery.searchSummaryLacks", { term: quoteTerm(expr.item.value) })
        : t("gallery.searchSummaryNot", { expr: describeExpr(expr.item) });
    case "and":
    case "or": {
      const text = formatList(
        expr.items.map((item) => describeExpr(item, true)),
        expr.kind === "and" ? "conjunction" : "disjunction",
      );
      return nested ? t("gallery.searchSummaryGroup", { terms: text }) : text;
    }
  }
}

function errorMessage(code: string): string {
  return t(`gallery.searchExprError_${code}`);
}

/** 按当前输入（未提交的草稿也算）与勾选，说清这一次到底怎么搜。 */
const summary = computed(() => {
  const parsed = parsedDraft.value;
  if (!parsed.ok) {
    return t("gallery.searchSummaryError", {
      position: parsed.error.position + 1,
      message: errorMessage(parsed.error.code),
    });
  }
  if (props.selectedModes.length === 0) return t("gallery.searchSummaryNone");
  const modes = modesText.value;
  if (!parsed.expr) return t("gallery.searchSummaryIdle", { modes });
  const expr = describeExpr(parsed.expr);
  if (props.selectedModes.length === 1) return t("gallery.searchSummaryExpr", { modes, expr });
  return t("gallery.searchSummaryExprAny", { modes, expr });
});
</script>
