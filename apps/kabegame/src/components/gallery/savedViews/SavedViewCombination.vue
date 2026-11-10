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
      <p v-if="anyDimsText" class="m-0 text-[11px] text-[var(--anime-text-secondary)] opacity-80">{{ anyDimsText }}</p>
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
        <button
          type="button"
          class="saved-view-combination__copy"
          :title="t('gallery.savedViewCopyPath')"
          :aria-label="t('gallery.savedViewCopyPath')"
          @click="copyPath"
        >
          <el-icon><CopyDocument /></el-icon>
        </button>
      </div>
      <div
        class="select-text break-all rounded-md bg-[color-mix(in_srgb,var(--anime-primary)_6%,transparent)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--anime-text-secondary)]"
      >
        {{ path }}
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw } from "vue";
import { useI18n } from "@kabegame/i18n";
import { CopyDocument, SortAsc, SortDesc } from "@kabegame/element-plus-icons";
import { SORT_FIELD_ICONS } from "@/components/gallery/galleryChipIcons";
import { usePluginStore } from "@/stores/plugins";
import type { GallerySort } from "@/utils/galleryPath";
import { gallerySortFieldLabel, type GalleryLabelContext } from "@/utils/galleryFilterLabels";
import { conditionCount, splitQueryFilters, type GalleryQuery } from "@/utils/galleryQuery";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
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
const sortFieldPill = computed<Pill>(() => {
  const label = gallerySortFieldLabel(props.sort.field, t);
  return { key: `sort:${props.sort.field}`, icon: SORT_FIELD_ICONS[props.sort.field], label, title: label };
});
/** 随机排序没有方向可言（升降只是同一次洗牌倒着读），不出方向 chip。 */
const sortOrderPill = computed<Pill | null>(() => {
  if (props.sort.field === "random") return null;
  const label = props.sort.desc ? t("gallery.sortDescending") : t("gallery.sortAscending");
  return { key: `order:${props.sort.desc}`, icon: markRaw(props.sort.desc ? SortDesc : SortAsc), label, title: label };
});
const sortFieldChanged = computed(() => !!props.base && props.base.sort.field !== props.sort.field);
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
    ElMessage.success(t("common.copied"));
  } catch {
    ElMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped lang="scss">
.saved-view-combination__title {
  margin: 0 0 6px;
  color: var(--anime-text-secondary);
  font-size: 12px;
}

.saved-view-combination__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-bottom: 6px;
  padding: 0;
  border: none;
  border-radius: 6px;
  color: var(--anime-text-secondary);
  background: transparent;
  cursor: pointer;

  &:hover {
    color: var(--anime-primary);
    background: color-mix(in srgb, var(--anime-primary) 8%, transparent);
  }
}
</style>
