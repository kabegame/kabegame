<template>
  <el-dialog
    :model-value="visible"
    :close-on-press-escape="true"
    append-to-body
    destroy-on-close
    width="min(940px, calc(100vw - 24px))"
    class="advanced-query-dialog"
    @update:model-value="onDialogVisible"
  >
    <template #header>
      <div class="min-w-0 pr-6">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="m-0 text-xl font-semibold text-[var(--anime-text-primary)]">
            {{ t("gallery.advancedQuery") }}
          </h2>
          <span class="inline-flex items-center gap-1.5 rounded-lg border border-solid border-[color-mix(in_srgb,var(--anime-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--anime-primary)_8%,transparent)] px-2.5 py-1 text-sm font-semibold text-[var(--anime-primary)]">
            <el-icon v-if="hitCountLoading" class="animate-spin"><Loading /></el-icon>
            <!-- 请求失败时 hitCount 是 undefined：显示 "—" 而不是冒充 0（"一张不剩"）。 -->
            <span v-else>
              {{ t("gallery.advancedHitCount", { count: hitCount == null ? "—" : formatCount(hitCount) }) }}
            </span>
          </span>
        </div>
        <p class="mb-0 mt-2 text-sm text-[var(--anime-text-secondary)]">
          {{ t("gallery.advancedIntro") }}
        </p>
      </div>
    </template>

    <div class="advanced-query-shell min-h-0">
      <GalleryAdvancedQuerySequence
        :tree="draft"
        :sequence="draft"
        :compact="uiStore.isCompact"
        :context-prefix="contextPrefix"
        @update:tree="draft = $event"
      />
    </div>

    <template #footer>
      <div class="advanced-query-footer flex flex-col gap-3 text-left">
        <PathqlPathBar :path="previewPath" show-label />
        <div class="flex flex-wrap items-center gap-2">
          <el-button @click="clear">{{ t("gallery.advancedClear") }}</el-button>
          <div class="ml-auto flex items-center gap-2">
            <el-button @click="cancel">{{ t("common.cancel") }}</el-button>
            <el-button type="primary" @click="apply">{{ t("gallery.advancedApply") }}</el-button>
          </div>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElButton, ElDialog, ElIcon } from "@kabegame/element-plus";
import { Loading } from "@kabegame/element-plus-icons";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useAdvancedHitCount } from "@/composables/useAdvancedQueryFacets";
import {
  queryRuntimePath,
  buildComposablePath,
  type GallerySort,
} from "@/utils/galleryPath";
import {
  cloneQuery,
  normalizeQuery,
  type GalleryQuery,
} from "@/utils/galleryQuery";
import GalleryAdvancedQuerySequence from "./GalleryAdvancedQuerySequence.vue";
import PathqlPathBar from "./PathqlPathBar.vue";

const props = withDefaults(defineProps<{
  query?: GalleryQuery;
  sort: GallerySort;
  page?: number;
  pageSize?: number;
  contextPrefix?: string;
}>(), {
  query: () => [],
  page: 1,
  pageSize: 100,
  contextPrefix: "images://gallery/",
});

const emit = defineEmits<{
  apply: [tree: GalleryQuery];
}>();

const visible = defineModel<boolean>("visible", { required: true });
const { t } = useI18n();
const uiStore = useUiStore();
const draft = ref<GalleryQuery>([]);
const effectiveQuery = computed(() => normalizeQuery(draft.value));
const contextPrefix = toRef(props, "contextPrefix");
const { count: hitCount, loading: hitCountLoading } = useAdvancedHitCount(
  effectiveQuery,
  contextPrefix,
);

useModalBack(visible);

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
      query: effectiveQuery.value,
      sort: props.sort,
      page: props.page,
      pageSize: props.pageSize,
    }),
    contextPrefix.value,
  )
);

function cloneTree(tree: GalleryQuery): GalleryQuery {
  return cloneQuery(tree);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function onDialogVisible(next: boolean): void {
  if (!next) cancel();
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

/* header / body / footer 三段交给 el-dialog：只把 body 限高并滚动，
   footer 才不会压到最后一条条件上。 */
.advanced-query-dialog :deep(.el-dialog__body) {
  max-height: calc(90dvh - 240px);
  overflow-y: auto;
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
