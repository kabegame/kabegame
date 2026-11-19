<template>
  <div class="flex flex-col gap-2">
    <!-- 筛选：都交给 Steam 做，换了就回到第 1 页 -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <CheckboxGroup v-model="ratings" :items="ratingItems" />
      <CheckboxGroup v-if="source === 'discover'" v-model="kinds" :items="kindItems" />
    </div>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-kb-fg-muted">
      <Checkbox
        :model-value="pageCheckState"
        :disabled="selectAll || !selectableOnPage.length"
        :label="$t('gallery.wpeSteamSubsSelectPage')"
        @update:model-value="togglePage"
      />
      <Checkbox
        v-if="source === 'subscriptions'"
        v-model="selectAll"
        :disabled="!total"
        :label="$t('gallery.wpeSteamSubsSelectAll', { n: total })"
      />
      <span v-else class="tabular-nums">{{ $t("gallery.wpeSteamDiscoverTotal", { n: formatCount(total) }) }}</span>

      <div class="ml-auto flex items-center gap-2">
        <!-- 工坊发现的搜索：平时收成一个按钮，点开是输入框；失焦且为空时收回。输入停 500 ms 或回车才查 -->
        <template v-if="source === 'discover'">
          <Input
            v-if="searchOpen || textInput"
            ref="searchInput"
            v-model="textInput"
            size="sm"
            clearable
            class="w-[220px]"
            :placeholder="$t('gallery.wpeSteamDiscoverSearch')"
            @keydown.enter="applyText"
            @keydown.esc="closeSearch"
            @blur="onSearchBlur"
          >
            <template #prefix><Search /></template>
          </Input>
          <Button
            v-else
            variant="ghost"
            size="sm"
            :aria-label="$t('gallery.wpeSteamDiscoverSearch')"
            @click="openSearch"
          >
            <Search />
          </Button>
        </template>
        <div v-if="source === 'discover' && sort === 'trend'" class="w-[96px]">
          <Select v-model="days" :options="dayOptions" size="sm" />
        </div>
        <div class="w-[124px]">
          <Select v-model="sort" :options="sortOptions" size="sm" />
        </div>
      </div>
    </div>

    <!-- 照 WPE 的创意工坊：网格，缩略图底部居中是名称，右上角勾选；类型 / 大小 / 分级等放在悬停提示里 -->
    <div v-if="loading && !items.length" :class="GRID_CLASS">
      <Skeleton v-for="n in 10" :key="n" class="aspect-square w-full" />
    </div>
    <div
      v-else-if="error"
      class="box-border flex flex-col items-center gap-2 rounded-kb-lg border border-solid border-kb-line-strong px-3 py-5 text-center"
    >
      <span class="text-[12.5px] text-kb-danger">{{ $t("gallery.wpeSteamSubsLoadFailed") }}：{{ error }}</span>
      <Button variant="ghost" size="sm" @click="load">
        <RefreshCw />
        {{ $t("gallery.wpeSteamSubsRetry") }}
      </Button>
    </div>
    <div
      v-else-if="!items.length"
      class="box-border rounded-kb-lg border border-solid border-kb-line-strong px-3 py-5 text-center text-[12.5px] text-kb-fg-subtle"
    >
      {{ $t("gallery.wpeSteamSubsEmpty") }}
    </div>
    <div v-else :class="[GRID_CLASS, loading ? 'opacity-60' : '']">
      <div
        v-for="item in items"
        :key="item.id"
        class="group relative aspect-square overflow-hidden rounded-kb-md bg-kb-fill"
        :class="[
          canPick(item) ? 'cursor-pointer' : 'cursor-default',
          item.supported ? '' : 'opacity-50',
          isChecked(item) ? 'shadow-[0_0_0_2px_var(--kb-primary)]' : '',
        ]"
        :title="tileTitle(item)"
        @click="toggle(item)"
      >
        <img
          v-if="item.previewUrl"
          :src="item.previewUrl"
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          class="absolute inset-0 size-full object-cover transition-transform duration-200"
          :class="canPick(item) ? 'group-hover:scale-105' : ''"
        />
        <!-- 左上：本地状态 / 不支持 / 成人 -->
        <div class="absolute left-1 top-1 flex flex-col items-start gap-0.5">
          <Tag v-if="!item.supported" size="sm" tone="warning">{{ $t("gallery.wpeSteamSubsUnsupported") }}</Tag>
          <Tag v-else-if="item.local === 'current'" size="sm" tone="success">
            {{ $t("gallery.wpeSteamSubsLocalCurrent") }}
          </Tag>
          <Tag v-else-if="item.local === 'outdated'" size="sm" tone="accent">
            {{ $t("gallery.wpeSteamSubsLocalOutdated") }}
          </Tag>
          <Tag v-if="item.rating === 'Mature'" size="sm" tone="danger">{{ ratingLabel(item.rating) }}</Tag>
        </div>
        <!-- 右上：勾选（选中时常显，否则悬停才显示）；整块可点，复选框只做显示 -->
        <Checkbox
          v-if="item.supported"
          :model-value="isChecked(item)"
          class="pointer-events-none absolute right-1.5 top-1.5 transition-opacity duration-150"
          :class="isChecked(item) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        />
        <!-- 底部居中：名称，最多两行 -->
        <div
          class="absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.75),rgba(0,0,0,0))] px-1.5 pb-1.5 pt-5"
        >
          <span class="line-clamp-2 break-words text-center text-[11.5px] leading-[1.3] text-white">
            {{ item.title || item.id }}
          </span>
        </div>
      </div>
    </div>

    <!-- 翻页：与画廊同一个底层组件，只有一页时不显示 -->
    <Paginator v-if="pageCount > 1" v-model:page="page" :page-count="pageCount" class="justify-center" />
  </div>
</template>

<script setup lang="ts">
/**
 * 「从 Steam 导入」的条目列表：`source` 为 `subscriptions`（我的订阅）或 `discover`（工坊发现），登录后显示，
 * 用户在这里挑要导入的创意工坊条目。
 *
 * 只持有当前一页：每次翻页 / 换筛选调一次 `wpe_steam_subscriptions` / `wpe_steam_workshop_query`（后端用账号的
 * 共享 CM 连接），分页、排序、搜索与筛选都由 Steam 做。勾选的条目 id 经 `v-model:selected-ids` 与另一个页签
 * 共用、跨页保留；「选中本页未下载」只勾 / 取消本页本地还没有的条目。排序与筛选（不含搜索字）按页签记在
 * localStorage，下次打开沿用；总页数封顶 2500。「全部 N 个」只在订阅里有：表示当前分级下的全部订阅，经 `v-model:all-subscriptions` 交出分级
 * 与总数，提交时只带分级，任务运行时重新列。
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { RefreshCw, Search } from "@lucide/vue";
import { Button, Checkbox, CheckboxGroup, Input, Paginator, Select, Skeleton, Tag } from "@/components/ui";
import { invoke } from "@/api";

export interface SteamAllSubscriptions {
  ratings: string[];
  total: number;
}

interface WorkshopItem {
  id: string;
  title: string;
  previewUrl: string | null;
  fileSize: number;
  manifestId: string;
  timeUpdated: number;
  timeSubscribed: number;
  subscriptions: number;
  tags: string[];
  rating: string | null;
  kind: string;
  supported: boolean;
  local: "missing" | "current" | "outdated";
}

interface WorkshopPage {
  total: number;
  page: number;
  perPage: number;
  items: WorkshopItem[];
}

type SubscriptionSort = "lastUpdated" | "subscriptionDate";
type DiscoverSort = "trend" | "mostSubscribed" | "topRated" | "newest" | "recentlyUpdated" | "relevance";

const props = defineProps<{ account: string; source: "subscriptions" | "discover" }>();
const selectedIds = defineModel<string[]>("selectedIds", { default: () => [] });
const allSubscriptions = defineModel<SteamAllSubscriptions | null>("allSubscriptions", { default: null });

const { t, locale } = useI18n();

const PER_PAGE = 20;
/** 网格：每格最小 108px，对话框里约 5 列 */
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2";
const RATINGS = ["Everyone", "Questionable", "Mature"] as const;
const KINDS = ["scene", "video", "web"] as const;

/**
 * 总页数上限（每页 20 条即前 50000 条）：工坊发现有约 300 万条，按页码翻不到底（实测第 2000 页还能取），
 * 翻页只给到这里；「共 N 个」仍显示 Steam 给的总数。
 */
const MAX_PAGES = 2500;
const SUBSCRIPTION_SORTS: readonly SubscriptionSort[] = ["lastUpdated", "subscriptionDate"];
/** 能记住的发现排序：`relevance` 只在有搜索字时有意义，搜索字不记，所以它也不记 */
const DISCOVER_SORTS: readonly DiscoverSort[] = ["trend", "mostSubscribed", "topRated", "newest", "recentlyUpdated"];
const DAY_VALUES = [1, 7, 30, 90, 180, 365] as const;

/** 记住的排序与筛选（每个页签一份，存在本机 localStorage；搜索字不记） */
interface SavedView {
  ratings: string[];
  kinds: string[];
  sort: SubscriptionSort | DiscoverSort;
  days: number;
}

const viewStorageKey = `kabegame-steam-workshop-view:${props.source}`;

/** 读上次的排序与筛选；逐项校验，读不到或不合法的项取默认值。存储不可用（隐私窗口等）时照常工作。 */
function loadSavedView(): SavedView {
  const view: SavedView = {
    ratings: [...RATINGS],
    kinds: [...KINDS],
    sort: props.source === "discover" ? "trend" : "lastUpdated",
    days: 7,
  };
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(viewStorageKey);
    raw = text ? JSON.parse(text) : null;
  } catch {
    // 忽略：只是少了记忆
  }
  if (!raw || typeof raw !== "object") return view;
  const saved = raw as Partial<Record<keyof SavedView, unknown>>;
  const pick = (value: unknown, allowed: readonly string[]) =>
    Array.isArray(value) ? allowed.filter((item) => value.includes(item)) : [];
  const ratingsSaved = pick(saved.ratings, RATINGS);
  if (ratingsSaved.length) view.ratings = ratingsSaved;
  const kindsSaved = pick(saved.kinds, KINDS);
  if (kindsSaved.length) view.kinds = kindsSaved;
  const sorts: readonly string[] = props.source === "discover" ? DISCOVER_SORTS : SUBSCRIPTION_SORTS;
  if (typeof saved.sort === "string" && sorts.includes(saved.sort)) view.sort = saved.sort as SavedView["sort"];
  if (typeof saved.days === "number" && (DAY_VALUES as readonly number[]).includes(saved.days)) view.days = saved.days;
  return view;
}

const savedView = loadSavedView();

const ratings = ref<string[]>(savedView.ratings);
const ratingItems = computed(() => RATINGS.map((value) => ({ value, label: ratingLabel(value) })));
const kinds = ref<string[]>(savedView.kinds);
const kindItems = computed(() => KINDS.map((value) => ({ value, label: kindLabel(value) })));

const sort = ref<SubscriptionSort | DiscoverSort>(savedView.sort);
const sortOptions = computed(() =>
  props.source === "subscriptions"
    ? [
        { value: "lastUpdated", label: t("gallery.wpeSteamSubsSortUpdated") },
        { value: "subscriptionDate", label: t("gallery.wpeSteamSubsSortSubscribed") },
      ]
    : [
        ...(text.value ? [{ value: "relevance", label: t("gallery.wpeSteamDiscoverSortRelevance") }] : []),
        { value: "trend", label: t("gallery.wpeSteamDiscoverSortTrend") },
        { value: "mostSubscribed", label: t("gallery.wpeSteamDiscoverSortSubscribed") },
        { value: "topRated", label: t("gallery.wpeSteamDiscoverSortRated") },
        { value: "newest", label: t("gallery.wpeSteamDiscoverSortNewest") },
        { value: "recentlyUpdated", label: t("gallery.wpeSteamDiscoverSortUpdated") },
      ],
);
/** 趋势的时间窗（天） */
const days = ref(savedView.days);
const dayOptions = computed(() =>
  DAY_VALUES.map((value) => ({ value, label: t(`gallery.wpeSteamDiscoverDays${value}`) })),
);

// 换了就记下；`relevance` 不记（记成上一个能记的排序，搜索时自动换上的相关度不覆盖用户选的排序）
let rememberedSort = savedView.sort;
watch([ratings, kinds, sort, days], () => {
  const sorts: readonly string[] = props.source === "discover" ? DISCOVER_SORTS : SUBSCRIPTION_SORTS;
  if (sorts.includes(sort.value)) rememberedSort = sort.value;
  const view: SavedView = {
    ratings: ratings.value,
    kinds: kinds.value,
    sort: rememberedSort,
    days: days.value,
  };
  try {
    localStorage.setItem(viewStorageKey, JSON.stringify(view));
  } catch {
    // 忽略
  }
});

/** 输入框里的字；停 500 ms 或回车后才成为 `text` 去查 */
const textInput = ref("");
const text = ref("");
let textTimer: ReturnType<typeof setTimeout> | null = null;
function applyText() {
  if (textTimer) clearTimeout(textTimer);
  textTimer = null;
  const next = textInput.value.trim();
  if (next === text.value) return;
  // 开始搜索时换成按相关度，清空搜索时换回趋势
  if (next && !text.value && sort.value === "trend") sort.value = "relevance";
  if (!next && sort.value === "relevance") sort.value = "trend";
  text.value = next;
}
const searchOpen = ref(false);
const searchInput = ref<InstanceType<typeof Input> | null>(null);
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
}
function closeSearch() {
  textInput.value = "";
  applyText();
  searchOpen.value = false;
}
function onSearchBlur() {
  if (!textInput.value.trim()) searchOpen.value = false;
}
watch(textInput, () => {
  if (textTimer) clearTimeout(textTimer);
  textTimer = setTimeout(applyText, 500);
});

const page = ref(1);
const total = ref(0);
const items = ref<WorkshopItem[]>([]);
const pageCount = computed(() => Math.min(MAX_PAGES, Math.max(1, Math.ceil(total.value / PER_PAGE))));
const loading = ref(false);
const error = ref<string | null>(null);

const selectAll = ref(false);
const selectedSet = computed(() => new Set(selectedIds.value));

function ratingLabel(rating: string): string {
  switch (rating) {
    case "Everyone":
      return t("gallery.wpeSteamSubsRatingEveryone");
    case "Questionable":
      return t("gallery.wpeSteamSubsRatingQuestionable");
    case "Mature":
      return t("gallery.wpeSteamSubsRatingMature");
    default:
      return rating;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "scene":
      return t("gallery.wpeKindScene");
    case "video":
      return t("gallery.wpeKindVideo");
    case "web":
      return t("gallery.wpeKindWeb");
    case "application":
      return t("gallery.wpeKindApplication");
    case "preset":
      return t("gallery.wpeKindPreset");
    default:
      return t("gallery.wpeKindUnknown");
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 按应用语言显示数字（i18n 的 `zhtw` → BCP 47 的 `zh-TW`），大数用紧凑写法 */
function formatCount(value: number): string {
  const lang = String(locale.value);
  return new Intl.NumberFormat(lang === "zhtw" ? "zh-TW" : lang, {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

/** 悬停提示：名称 + 类型 · 大小 · 分级（· 订阅人数） */
function tileTitle(item: WorkshopItem): string {
  const parts = [kindLabel(item.kind), formatSize(item.fileSize)];
  if (item.rating) parts.push(ratingLabel(item.rating));
  if (props.source === "discover") {
    parts.push(t("gallery.wpeSteamDiscoverSubscribers", { n: formatCount(item.subscriptions) }));
  }
  return `${item.title || item.id}\n${parts.join(" · ")}`;
}

function canPick(item: WorkshopItem): boolean {
  return item.supported && !selectAll.value;
}

function isChecked(item: WorkshopItem): boolean {
  return item.supported && (selectAll.value || selectedSet.value.has(item.id));
}

function toggle(item: WorkshopItem) {
  if (!canPick(item)) return;
  const next = new Set(selectedIds.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  selectedIds.value = [...next];
}

/** 「选中本页未下载」管的条目：本页能选、本地还没有的（已下载的、有更新的都不算） */
const selectableOnPage = computed(() => items.value.filter((item) => item.supported && item.local === "missing"));
const pageCheckState = computed<boolean | "indeterminate">(() => {
  const picked = selectableOnPage.value.filter((item) => selectedSet.value.has(item.id)).length;
  if (!picked) return false;
  return picked === selectableOnPage.value.length ? true : "indeterminate";
});

function togglePage(value: boolean | "indeterminate" | undefined) {
  const next = new Set(selectedIds.value);
  for (const item of selectableOnPage.value) {
    if (value === true) next.add(item.id);
    else next.delete(item.id);
  }
  selectedIds.value = [...next];
}

/** 每次请求 +1；旧请求回来时作废 */
let seq = 0;

function request(): Promise<WorkshopPage> {
  if (props.source === "subscriptions") {
    return invoke<WorkshopPage>("wpe_steam_subscriptions", {
      account: props.account,
      page: page.value,
      perPage: PER_PAGE,
      sort: sort.value,
      ratings: ratings.value,
    });
  }
  return invoke<WorkshopPage>("wpe_steam_workshop_query", {
    account: props.account,
    page: page.value,
    perPage: PER_PAGE,
    sort: sort.value,
    days: days.value,
    text: text.value || null,
    ratings: ratings.value,
    kinds: kinds.value,
  });
}

async function load() {
  const current = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const result = await request();
    if (current !== seq) return;
    items.value = result.items;
    total.value = result.total;
  } catch (e) {
    if (current !== seq) return;
    error.value = e instanceof Error ? e.message : String(e);
    items.value = [];
  } finally {
    if (current === seq) loading.value = false;
  }
}

// 每组至少留一个：全不选在 Steam 那边等于不筛选，容易误会
watch(ratings, (next, prev) => {
  if (!next.length) ratings.value = prev;
});
watch(kinds, (next, prev) => {
  if (!next.length) kinds.value = prev;
});
watch([ratings, kinds, sort, days, text], () => {
  if (page.value !== 1) page.value = 1;
  else void load();
});
watch(page, () => void load());
watch(
  () => props.account,
  () => {
    selectAll.value = false;
    if (page.value !== 1) page.value = 1;
    else void load();
  },
  { immediate: true },
);

watch(
  [selectAll, ratings, total],
  () => {
    if (props.source !== "subscriptions") return;
    allSubscriptions.value =
      selectAll.value && total.value ? { ratings: [...ratings.value], total: total.value } : null;
  },
  { immediate: true },
);
</script>
