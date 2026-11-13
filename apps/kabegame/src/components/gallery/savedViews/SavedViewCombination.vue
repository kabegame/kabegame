<template>
  <!-- 收藏视图的 chip 组合（只读）。传 base 时是「用当前视图更新」的预览：相对 base 新增的条件画粉底，
       base 有而这里没有的列进「将移除」。对比按「维度 + 取值」摊平、不分位置，够人看就行。 -->
  <div class="flex min-w-0 flex-col gap-3 text-[13px]">
    <section>
      <p class="saved-view-combination__title">{{ t("gallery.savedViewSortTitle") }}</p>
      <div class="flex flex-wrap gap-1.5">
        <SavedViewPill :pill="sortFieldPill" :variant="sortFieldChanged ? 'new' : 'normal'" />
        <SavedViewPill v-if="sortOrderPill" :pill="sortOrderPill" :variant="sortOrderChanged ? 'new' : 'normal'" />
      </div>
    </section>

    <section>
      <p class="saved-view-combination__title">{{ t("gallery.savedViewFiltersTitle") }}</p>
      <div v-if="simplePills.length > 0" class="mb-1 flex flex-wrap gap-1.5">
        <SavedViewPill
          v-for="pill in simplePills"
          :key="pill.key"
          :pill="pill"
          :variant="newKeys?.has(pill.key) ? 'new' : 'normal'"
        />
      </div>
      <p v-if="anyDimsText" class="m-0 text-[11.5px] text-kb-fg-subtle">{{ anyDimsText }}</p>
    </section>

    <section v-if="advanced.length > 0">
      <p class="saved-view-combination__title">
        {{ t("gallery.savedViewAdvancedTitle", { n: advancedCount }) }}
      </p>
      <SavedViewQueryTree :query="advanced" :ctx="labelCtx" :new-keys="newKeys" />
    </section>

    <section v-if="removedPills.length > 0">
      <p class="saved-view-combination__title">{{ t("gallery.savedViewRemovedTitle") }}</p>
      <div class="flex flex-wrap gap-1.5">
        <SavedViewPill v-for="pill in removedPills" :key="pill.key" :pill="pill" variant="removed" />
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between">
        <p class="saved-view-combination__title">{{ t("gallery.savedViewPathTitle") }}</p>
        <Tooltip :content="t('gallery.savedViewCopyPath')">
          <Button
            variant="ghost"
            size="icon-xs"
            class="mb-1.5 !size-[22px]"
            :aria-label="t('gallery.savedViewCopyPath')"
            @click="copyPath"
          >
            <Copy />
          </Button>
        </Tooltip>
      </div>
      <div
        class="select-text break-all rounded-kb-md bg-kb-fill px-2 py-1.5 font-mono text-[11px] leading-relaxed text-kb-fg-muted"
      >
        {{ path }}
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Copy } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import { SORT_FIELD_ICONS } from "@/components/gallery/galleryChipIcons";
import { useColorBuckets } from "@/composables/useColorBuckets";
import { usePluginStore } from "@/stores/plugins";
import { isColorSortField, type GallerySort } from "@/utils/galleryPath";
import { colorLabel, gallerySortFieldLabel, type GalleryLabelContext } from "@/utils/galleryFilterLabels";
import { conditionCount, splitQueryFilters, type GalleryQuery } from "@/utils/galleryQuery";
import { kameMessage } from "@/utils/kameMessage";
import SavedViewPill from "./SavedViewPill.vue";
import SavedViewQueryTree from "./SavedViewQueryTree.vue";
import { filterSetPills, queryPills, type SavedViewPill as Pill } from "./savedViewPills";

const props = defineProps<{
  query: GalleryQuery;
  sort: GallerySort;
  /** 展示用的查询体（PathQL 路径）。 */
  path: string;
  /** 对比基准：「用当前视图更新」预览时传原收藏的组合。 */
  base?: { query: GalleryQuery; sort: GallerySort } | null;
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const labelCtx = computed<GalleryLabelContext>(() => ({
  t,
  locale: String(locale.value),
  pluginLabel: (id: string) => pluginStore.pluginLabel(id),
}));

const parts = computed(() => splitQueryFilters(props.query));
const simplePills = computed(() => filterSetPills(parts.value.simple, labelCtx.value));
const advanced = computed(() => parts.value.advanced);
const advancedCount = computed(() => conditionCount(advanced.value));

/** 简单 chip 里没出现的维度：一句「…：任意」，名字与查询行 ⋯ 面板的开关同源。 */
const DIMENSION_NAME_KEYS = [
  ["search", "gallery.advancedChipSearch"],
  ["date", "gallery.advancedChipTime"],
  ["plugin", "gallery.advancedChipPlugin"],
  ["mediaType", "gallery.advancedChipMediaType"],
  ["aspect", "gallery.advancedChipAspect"],
  ["size", "gallery.advancedChipSize"],
] as const;
const anyDimsText = computed(() => {
  const simple = parts.value.simple;
  const missing = DIMENSION_NAME_KEYS.filter(([dim]) =>
    dim === "search" ? !simple.search?.query.trim() : !simple[dim],
  ).map(([, key]) => t(key));
  return missing.length > 0 ? t("gallery.savedViewAnyDims", { dims: missing.join("、") }) : "";
});

// ---------- 排序 ----------
// 色桶列表只用来把基本色桶显示成名字（「红」）；不是颜色排序时不观察。列表到之前先显示 #rrggbb。
const { buckets: colorBuckets } = useColorBuckets(() => isColorSortField(props.sort.field));
const sortFieldPill = computed<Pill>(() => {
  const { field, color } = props.sort;
  const label = gallerySortFieldLabel(field, t);
  const pill: Pill = { key: `sort:${field}`, icon: SORT_FIELD_ICONS[field], label, title: label };
  if (!isColorSortField(field) || !color) return pill;
  // 颜色排序：维度名后跟一个小色块与颜色名
  const name = colorLabel(color, colorBuckets.value, t);
  return { ...pill, title: `${label} · ${name}`, swatch: `#${color}`, swatchLabel: name };
});
/** 随机排序没有方向可言（升降只是同一次洗牌倒着读），不出方向 chip。 */
const sortOrderPill = computed<Pill | null>(() => {
  if (props.sort.field === "random") return null;
  const label = props.sort.desc ? t("gallery.sortDescending") : t("gallery.sortAscending");
  return {
    key: `order:${props.sort.desc}`,
    icon: markRaw(props.sort.desc ? ArrowDownWideNarrow : ArrowUpNarrowWide),
    label,
    title: label,
  };
});
/** 排序维度的身份：两个颜色字段是同一个维度，换了颜色才算变。 */
function sortIdentity(sort: GallerySort): string {
  return isColorSortField(sort.field) ? `color:${sort.color ?? ""}` : sort.field;
}
const sortFieldChanged = computed(() => !!props.base && sortIdentity(props.base.sort) !== sortIdentity(props.sort));
const sortOrderChanged = computed(() => !!props.base && props.base.sort.desc !== props.sort.desc);

// ---------- 差异 ----------
const basePills = computed(() => (props.base ? queryPills(props.base.query, labelCtx.value) : []));
const newKeys = computed<ReadonlySet<string> | null>(() => {
  if (!props.base) return null;
  const old = new Set(basePills.value.map((pill) => pill.key));
  return new Set(
    queryPills(props.query, labelCtx.value)
      .map((pill) => pill.key)
      .filter((key) => !old.has(key)),
  );
});
const removedPills = computed(() => {
  if (!props.base) return [];
  const current = new Set(queryPills(props.query, labelCtx.value).map((pill) => pill.key));
  const seen = new Set<string>();
  return basePills.value.filter((pill) => !current.has(pill.key) && !seen.has(pill.key) && seen.add(pill.key));
});

async function copyPath() {
  try {
    await navigator.clipboard.writeText(props.path);
    kameMessage.success(t("common.copied"));
  } catch {
    kameMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped>
.saved-view-combination__title {
  margin: 0 0 6px;
  color: var(--kb-fg-muted);
  font-size: 12px;
}
</style>
