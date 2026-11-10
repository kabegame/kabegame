<template>
  <!-- 收藏视图编辑：改名、用当前视图更新（先预览差异），确定才写库。点一行只是应用，改收藏只走这里。 -->
  <div class="flex min-w-0 flex-col gap-3">
    <div v-if="showTitle" class="text-sm font-medium text-[var(--anime-text-primary)]">
      {{ t("gallery.savedViewEditorTitle") }}
    </div>

    <div>
      <el-input
        ref="nameInputRef"
        v-model="nameDraft"
        size="small"
        :placeholder="targetPath"
        :aria-label="t('gallery.savedViewName')"
        maxlength="80"
        @keydown.enter.prevent="confirm"
      />
      <p
        class="m-0 mt-1 px-0.5 text-[11px]"
        :class="nameError ? 'text-[var(--anime-danger)]' : 'text-[var(--anime-text-secondary)] opacity-80'"
      >
        {{ nameError || t("gallery.savedViewNameHint") }}
      </p>
    </div>

    <!-- 用当前视图更新：相同 / 当前视图已被别的收藏占用 / 可更新（再点撤销） -->
    <div class="flex flex-wrap items-center gap-2">
      <p v-if="currentSavedAs && !useCurrent" class="m-0 text-xs text-[var(--anime-danger)]">
        {{ t("gallery.savedViewPathConflict", { name: savedViewDisplayName(currentSavedAs) }) }}
      </p>
      <el-button v-else size="small" :disabled="sameAsCurrent && !useCurrent" @click="useCurrent = !useCurrent">
        {{
          useCurrent
            ? t("gallery.savedViewUndoUpdate")
            : sameAsCurrent
              ? t("gallery.savedViewSameAsCurrent")
              : t("gallery.savedViewUpdateFromCurrent")
        }}
      </el-button>
    </div>
    <p
      v-if="useCurrent"
      class="m-0 rounded-lg bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] px-2.5 py-1.5 text-xs text-[var(--anime-text-primary)]"
    >
      {{ t("gallery.savedViewPreviewHint") }}
    </p>

    <SavedViewCombination :query="shown.query" :sort="shown.sort" :path="shown.path" :base="base" />

    <div class="flex justify-end gap-2">
      <el-button size="small" @click="emit('cancel')">{{ t("common.cancel") }}</el-button>
      <el-button size="small" type="primary" :loading="saving" :disabled="!!nameConflict" @click="confirm">
        {{ t("common.ok") }}
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { parseComposablePath, type GallerySort } from "@/utils/galleryPath";
import type { GalleryQuery } from "@/utils/galleryQuery";
import {
  findNameConflict,
  findPathConflict,
  normalizeSavedViewName,
  savedViewDisplayName,
  type SavedView,
} from "@/utils/savedViews";
import { SavedViewConflictError, updateSavedView } from "@/services/savedViews";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";
import SavedViewCombination from "./SavedViewCombination.vue";

const props = withDefaults(
  defineProps<{
    view: SavedView;
    /** 本来源当前快照：名字 / 路径冲突在这里先判一遍，写库事务里再判一次。 */
    views: readonly SavedView[];
    currentQuery: GalleryQuery;
    currentSort: GallerySort;
    /** 当前视图的查询体（savedViewBody）。 */
    currentBody: string;
    /** 浮层档自带标题；对话框档标题在对话框头上。 */
    showTitle?: boolean;
  }>(),
  { showTitle: true },
);

const emit = defineEmits<{
  saved: [view: SavedView];
  cancel: [];
}>();

const { t } = useI18n();

const nameInputRef = ref<{ focus: () => void } | null>(null);
const nameDraft = ref(props.view.name ?? "");
const useCurrent = ref(false);
const saving = ref(false);
/** 写库时才发现的冲突（快照之外被改过）。 */
const saveError = ref("");

const targetPath = computed(() => (useCurrent.value ? props.currentBody : props.view.path));
const nameConflict = computed(() =>
  findNameConflict(props.views, normalizeSavedViewName(nameDraft.value), targetPath.value, props.view.id),
);
const nameError = computed(() =>
  nameConflict.value
    ? t("gallery.savedViewNameConflict", { name: savedViewDisplayName(nameConflict.value) })
    : saveError.value,
);
const sameAsCurrent = computed(() => props.view.path === props.currentBody);
const currentSavedAs = computed(() =>
  sameAsCurrent.value ? undefined : findPathConflict(props.views, props.currentBody, props.view.id),
);

// 展示不走 parseSavedViewBody：那个会给随机排序现生成种子，这里只是看。
const stored = computed(() => parseComposablePath(props.view.path));
const shown = computed(() =>
  useCurrent.value
    ? { query: props.currentQuery, sort: props.currentSort, path: props.currentBody }
    : { query: stored.value.query, sort: stored.value.sort, path: props.view.path },
);
const base = computed(() => (useCurrent.value ? { query: stored.value.query, sort: stored.value.sort } : null));

onMounted(() => {
  void nextTick(() => nameInputRef.value?.focus());
});

async function confirm() {
  if (saving.value || nameConflict.value || props.view.id == null) return;
  saving.value = true;
  saveError.value = "";
  try {
    const updated = await updateSavedView(props.view.id, {
      name: normalizeSavedViewName(nameDraft.value),
      path: targetPath.value,
    });
    emit("saved", updated);
  } catch (error) {
    if (error instanceof SavedViewConflictError) {
      const name = savedViewDisplayName(error.other);
      saveError.value =
        error.kind === "name"
          ? t("gallery.savedViewNameConflict", { name })
          : t("gallery.savedViewPathConflict", { name });
    } else {
      logger.error("更新收藏视图失败:", error);
      ElMessage.error(t("gallery.savedViewSaveFailed"));
    }
  } finally {
    saving.value = false;
  }
}
</script>
