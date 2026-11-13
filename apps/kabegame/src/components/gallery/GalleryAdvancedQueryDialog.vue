<template>
  <Dialog v-model:open="visible" :width="940" :description="t('gallery.advancedIntro')">
    <template #title>
      <span class="flex flex-wrap items-center gap-2.5">
        {{ t("gallery.advancedQuery") }}
        <Tag tone="accent" class="tabular-nums">
          <Spinner v-if="hitCountLoading" :size="12" />
          <!-- 请求失败时 hitCount 是 undefined：显示 "—" 而不是冒充 0（"一张不剩"）。 -->
          <template v-else>
            {{ t("gallery.advancedHitCount", { count: hitCount == null ? "—" : formatCount(hitCount) }) }}
          </template>
        </Tag>
      </span>
    </template>

    <div class="advanced-query-shell min-h-0 py-1">
      <GalleryAdvancedQuerySequence
        :tree="draft"
        :sequence="draft"
        :compact="uiStore.isCompact"
        :context-prefix="contextPrefix"
        @update:tree="draft = $event"
      />
    </div>

    <template #footer>
      <div class="advanced-query-footer flex w-full flex-col gap-3">
        <PathqlPathBar :path="previewPath" show-label />
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="ghost" @click="clear">{{ t("gallery.advancedClear") }}</Button>
          <div class="ml-auto flex items-center gap-2">
            <Button @click="cancel">{{ t("common.cancel") }}</Button>
            <Button variant="primary" @click="apply">{{ t("gallery.advancedApply") }}</Button>
          </div>
        </div>
      </div>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Button, Dialog, Spinner, Tag } from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import { useAdvancedHitCount } from "@/composables/useAdvancedQueryFacets";
import { queryRuntimePath, buildComposablePath, type GallerySort } from "@/utils/galleryPath";
import { cloneQuery, composeQueryFilters, normalizeQuery, type GalleryQuery } from "@/utils/galleryQuery";
import GalleryAdvancedQuerySequence from "./GalleryAdvancedQuerySequence.vue";
import PathqlPathBar from "./PathqlPathBar.vue";

const props = withDefaults(
  defineProps<{
    query?: GalleryQuery;
    sort: GallerySort;
    contextPrefix?: string;
  }>(),
  {
    query: () => [],
    contextPrefix: "images://gallery/",
  },
);

const emit = defineEmits<{
  apply: [tree: GalleryQuery];
}>();

const visible = defineModel<boolean>("visible", { required: true });
const { t } = useI18n();
const uiStore = useUiStore();
const draft = ref<GalleryQuery>([]);
const effectiveQuery = computed(() => normalizeQuery(draft.value));
const contextPrefix = toRef(props, "contextPrefix");
const { count: hitCount, loading: hitCountLoading } = useAdvancedHitCount(effectiveQuery, contextPrefix);

watch(
  () => [visible.value, props.query] as const,
  ([open]) => {
    if (!open) return;
    draft.value = cloneTree(props.query);
  },
  { flush: "post" },
);

const previewPath = computed(() =>
  queryRuntimePath(
    buildComposablePath({
      // 路径预览保留追加边界，与查询条实际应用后的持久化路径一致。
      query: composeQueryFilters({}, effectiveQuery.value),
      sort: props.sort,
    }),
    contextPrefix.value,
  ),
);

function cloneTree(tree: GalleryQuery): GalleryQuery {
  return cloneQuery(tree);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function clear(): void {
  draft.value = [];
}

function cancel(): void {
  visible.value = false;
}

function apply(): void {
  emit("apply", effectiveQuery.value);
  visible.value = false;
}
</script>

<style scoped>
.advanced-query-shell {
  container-type: inline-size;
}

.advanced-query-footer {
  container-type: inline-size;
}

@container (max-width: 600px) {
  .advanced-query-footer > div:first-child {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .advanced-query-footer > div:first-child > div {
    flex-basis: calc(100% - 48px);
  }
}
</style>
