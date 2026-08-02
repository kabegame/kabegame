<template>
  <el-dialog
    :model-value="visible"
    :show-close="false"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    append-to-body
    destroy-on-close
    width="min(940px, calc(100vw - 24px))"
    class="advanced-query-dialog"
    @update:model-value="onDialogVisible"
  >
    <div class="advanced-query-shell flex max-h-[calc(90dvh-40px)] min-h-0 flex-col overflow-hidden rounded-xl">
      <header class="flex flex-none items-start gap-3 border-b border-solid border-[var(--anime-border)] px-1 pb-4">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="m-0 text-xl font-semibold text-[var(--anime-text-primary)]">
              {{ t("gallery.advancedQuery") }}
            </h2>
            <span class="inline-flex items-center gap-1.5 rounded-lg border border-solid border-[color-mix(in_srgb,var(--anime-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--anime-primary)_8%,transparent)] px-2.5 py-1 text-sm font-semibold text-[var(--anime-primary)]">
              <el-icon v-if="hitCountLoading" class="animate-spin"><Loading /></el-icon>
              <span v-else>
                {{ t("gallery.advancedHitCount", { count: formatCount(hitCount ?? 0) }) }}
              </span>
            </span>
          </div>
          <p class="mb-0 mt-2 text-sm text-[var(--anime-text-secondary)]">
            {{ t("gallery.advancedIntro") }}
          </p>
        </div>
        <button
          type="button"
          class="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border-0 bg-transparent text-[var(--anime-text-secondary)] hover:bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] hover:text-[var(--anime-primary)] cursor-pointer"
          :aria-label="t('common.close')"
          @click="cancel"
        >
          <el-icon><Close /></el-icon>
        </button>
      </header>

      <main class="max-h-[calc(90dvh-250px)] min-h-0 flex-1 overflow-y-auto py-4 pr-1">
        <GalleryAdvancedQuerySequence
          :tree="draft"
          :sequence="draft"
          root-group
          :compact="uiStore.isCompact"
          :context-prefix="contextPrefix"
          @update:tree="draft = ensureRootGroup($event)"
        />
      </main>

      <footer class="flex flex-none flex-col gap-3 border-t border-solid border-[var(--anime-border)] pt-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class="flex-none text-sm font-medium text-[var(--anime-secondary)]">
            {{ t("gallery.advancedPath") }}
          </span>
          <div class="min-w-0 flex-1 overflow-x-auto rounded-lg border border-solid border-[var(--anime-border)] bg-[var(--anime-bg-sidebar)] px-3 py-2 font-mono text-xs text-[var(--anime-text-secondary)] whitespace-nowrap">
            {{ previewPath }}
          </div>
          <el-button class="flex-none" @click="copyPath">
            <el-icon class="mr-1"><DocumentCopy /></el-icon>
            {{ t("gallery.advancedCopy") }}
          </el-button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-button @click="clear">{{ t("gallery.advancedClear") }}</el-button>
          <div class="ml-auto flex items-center gap-2">
            <el-button @click="cancel">{{ t("common.cancel") }}</el-button>
            <el-button type="primary" @click="apply">{{ t("gallery.advancedApply") }}</el-button>
          </div>
        </div>
      </footer>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useI18n } from "@kabegame/i18n";
import { ElButton, ElDialog, ElIcon } from "@kabegame/element-plus";
import { Close, DocumentCopy, Loading } from "@kabegame/element-plus-icons";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { isTauri } from "@tauri-apps/api/core";
import { useUiStore } from "@kabegame/core/stores/ui";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useAdvancedHitCount } from "@/composables/useAdvancedQueryFacets";
import {
  advancedQueryRuntimePath,
  buildComposablePath,
  type GallerySort,
} from "@/utils/galleryPath";
import {
  collapseRootGroup,
  emptyRootGroup,
  ensureRootGroup,
  normalizeQuery,
  type GalleryAdvancedQuery,
} from "@/utils/galleryQuery";
import GalleryAdvancedQuerySequence from "./GalleryAdvancedQuerySequence.vue";

const props = withDefaults(defineProps<{
  query?: GalleryAdvancedQuery;
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
  apply: [tree: GalleryAdvancedQuery];
}>();

const visible = defineModel<boolean>("visible", { required: true });
const { t } = useI18n();
const uiStore = useUiStore();
// draft 是编辑态(顶层恒为一个或组);对外一律用坍缩+归一后的 effectiveQuery。
const draft = ref<GalleryAdvancedQuery>(emptyRootGroup());
const effectiveQuery = computed(() =>
  normalizeQuery(collapseRootGroup(draft.value))
);
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
    draft.value = ensureRootGroup(props.query);
  },
  { flush: "post" },
);

const previewPath = computed(() =>
  advancedQueryRuntimePath(
    buildComposablePath({
      filters: {},
      advanced: effectiveQuery.value,
      sort: props.sort,
      page: props.page,
      pageSize: props.pageSize,
    }),
    contextPrefix.value,
  )
);

function formatCount(value: number): string {
  return value.toLocaleString();
}

function onDialogVisible(next: boolean): void {
  if (!next) cancel();
}

function clear(): void {
  draft.value = emptyRootGroup();
}

function cancel(): void {
  visible.value = false;
}

function apply(): void {
  emit("apply", effectiveQuery.value);
  visible.value = false;
}

async function copyPath(): Promise<void> {
  try {
    if (isTauri()) await writeText(previewPath.value);
    else await navigator.clipboard.writeText(previewPath.value);
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制高级查询路径失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped>
.advanced-query-shell {
  container-type: inline-size;
  /* --anime-bg-card 本身带透明度;叠在实底上合成不透明卡片,避免底下画廊透出干扰。 */
  background-color: var(--el-bg-color);
  background-image: linear-gradient(var(--anime-bg-card), var(--anime-bg-card));
}

@container (max-width: 600px) {
  .advanced-query-shell footer > div:first-child {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .advanced-query-shell footer > div:first-child > div {
    flex-basis: calc(100% - 48px);
  }
}
</style>
