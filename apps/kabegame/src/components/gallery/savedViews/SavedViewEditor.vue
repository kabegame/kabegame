<template>
  <!-- 收藏视图编辑：改名、用当前视图更新（先预览差异），确定才写库。点一行只是应用，改收藏只走这里。 -->
  <div class="flex min-w-0 flex-col gap-3">
    <div v-if="showTitle" class="px-0.5 text-[14px] font-600 text-kb-fg">
      {{ t("gallery.savedViewEditorTitle") }}
    </div>

    <div>
      <Input
        ref="nameInputRef"
        v-model="nameDraft"
        size="sm"
        :placeholder="targetPath"
        :aria-label="t('gallery.savedViewName')"
        :invalid="!!nameError"
        maxlength="80"
        @keydown.enter.prevent="confirm"
      />
      <p class="m-0 mt-1 px-0.5 text-[11.5px]" :class="nameError ? 'text-kb-danger' : 'text-kb-fg-muted'">
        {{ nameError || t("gallery.savedViewNameHint") }}
      </p>
    </div>

    <!-- 用当前视图更新：相同 / 当前视图已被别的收藏占用 / 可更新（再点撤销） -->
    <div class="flex flex-wrap items-center gap-2">
      <p v-if="currentSavedAs && !useCurrent" class="m-0 text-[12px] text-kb-danger">
        {{ t("gallery.savedViewPathConflict", { name: savedViewDisplayName(currentSavedAs) }) }}
      </p>
      <Button v-else size="sm" :disabled="sameAsCurrent && !useCurrent" @click="useCurrent = !useCurrent">
        {{
          useCurrent
            ? t("gallery.savedViewUndoUpdate")
            : sameAsCurrent
              ? t("gallery.savedViewSameAsCurrent")
              : t("gallery.savedViewUpdateFromCurrent")
        }}
      </Button>
    </div>
    <p
      v-if="useCurrent"
      class="m-0 rounded-kb-md bg-[color-mix(in_srgb,var(--kb-accent)_8%,transparent)] px-2.5 py-1.5 text-[12px] text-kb-fg"
    >
      {{ t("gallery.savedViewPreviewHint") }}
    </p>

    <SavedViewCombination :query="shown.query" :sort="shown.sort" :path="shown.path" :base="base" />

    <div class="flex justify-end gap-2">
      <Button size="sm" @click="emit('cancel')">{{ t("common.cancel") }}</Button>
      <Button size="sm" variant="primary" :disabled="!!nameConflict || saving" @click="confirm">
        <Spinner v-if="saving" :size="12" />
        {{ t("common.ok") }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Button, Input, Spinner } from "@/components/ui";
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
import { kameMessage } from "@/utils/kameMessage";
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
      kameMessage.error(t("gallery.savedViewSaveFailed"));
    }
  } finally {
    saving.value = false;
  }
}
</script>
