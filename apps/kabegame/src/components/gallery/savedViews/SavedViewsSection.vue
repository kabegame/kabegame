<template>
  <!-- ⋯ 面板里的收藏视图。列表在面板打开时读一次库、按最后使用排好，打开期间顺序不变；点一行只是应用，
       收起面板时才给本次最后应用的那条记最后使用。改名 / 用当前视图更新走编辑浮层，移除走叉号确认。
       语义见 cocs/gallery/SAVED_VIEWS.md。 -->
  <div class="flex min-w-0 flex-col">
    <div class="flex items-baseline justify-between gap-2 px-2 pb-1 pt-2">
      <span class="text-xs text-[var(--anime-text-secondary)]">{{ t("gallery.savedViews") }}</span>
      <span class="truncate text-[11px] text-[var(--anime-text-secondary)] opacity-75">
        {{ scopeLabel }} · {{ rows.length }}
      </span>
    </div>

    <!-- 顶部新增：点加号展开命名输入框；当前视图已收藏时换成「已收藏为」，点它让那一行闪一下 -->
    <div v-if="adding" class="mb-1 px-1">
      <div class="flex items-center gap-1">
        <el-input
          ref="addInputRef"
          v-model="nameDraft"
          size="small"
          :placeholder="currentBody"
          :aria-label="t('gallery.savedViewName')"
          maxlength="80"
          @keydown.enter.stop.prevent="confirmAdd"
          @keydown.esc.stop.prevent="cancelAdd"
        />
        <button
          type="button"
          class="saved-view-icon-btn saved-view-icon-btn--primary"
          :title="t('common.ok')"
          :aria-label="t('common.ok')"
          @click="confirmAdd"
        >
          <el-icon><Check /></el-icon>
        </button>
        <button
          type="button"
          class="saved-view-icon-btn"
          :title="t('common.cancel')"
          :aria-label="t('common.cancel')"
          @click="cancelAdd"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
      <p
        class="m-0 mt-1 px-0.5 text-[11px]"
        :class="addError ? 'text-[var(--anime-danger)]' : 'text-[var(--anime-text-secondary)] opacity-80'"
      >
        {{ addError || t("gallery.savedViewNameHint") }}
      </p>
    </div>
    <button v-else-if="savedAs" type="button" class="saved-view-add is-saved" @click="flash(savedAs.id)">
      <el-icon class="flex-none"><Check /></el-icon>
      <span class="min-w-0 truncate">
        {{ t("gallery.savedViewAlreadySaved", { name: savedViewDisplayName(savedAs) }) }}
      </span>
    </button>
    <button v-else type="button" class="saved-view-add" @click="startAdd">
      <el-icon class="flex-none"><Plus /></el-icon>
      <span>{{ t("gallery.savedViewAdd") }}</span>
    </button>

    <el-scrollbar v-if="rows.length > 0" max-height="248px">
      <div
        v-for="row in rows"
        :key="row.id"
        :ref="(el) => setRowEl(row.id, el)"
        class="saved-view-row group"
        :class="{ 'is-current': row.path === currentBody, 'is-flash': flashId === row.id }"
        :title="row.path"
        @click="applyRow(row)"
      >
        <span class="min-w-0 flex-1 truncate" :class="{ 'saved-view-row__path': row.name === null }">
          {{ savedViewDisplayName(row) }}
        </span>
        <el-icon
          v-if="row.id != null && rotationRowIds.has(row.id)"
          class="flex-none text-[var(--anime-primary)]"
          :title="t('gallery.savedViewRotationSource')"
        >
          <RefreshRight />
        </el-icon>
        <span
          class="saved-view-row__actions"
          :class="{ 'is-shown': uiStore.isCompact || editingId === row.id || removeConfirmId === row.id }"
          @click.stop
        >
          <button
            type="button"
            class="saved-view-icon-btn"
            :class="{ 'is-active': editingId === row.id }"
            :title="t('gallery.savedViewEdit')"
            :aria-label="t('gallery.savedViewEdit')"
            @click="openEditor(row)"
          >
            <el-icon><EditPen /></el-icon>
          </button>
          <!-- 与任务抽屉「停止任务」同款确认：受控，同一时刻只开一个。popper 挂 layer 类，点它不关 ⋯ 面板 -->
          <el-popconfirm
            placement="bottom-end"
            :title="t('gallery.savedViewRemoveConfirm')"
            :confirm-button-text="t('common.confirm')"
            :cancel-button-text="t('common.cancel')"
            confirm-button-type="danger"
            :popper-class="SAVED_VIEW_LAYER_CLASS"
            :visible="removeConfirmId === row.id"
            @update:visible="(v: boolean) => setRemoveConfirm(row.id, v)"
            @confirm="removeRow(row)"
          >
            <template #reference>
              <button
                type="button"
                class="saved-view-icon-btn saved-view-icon-btn--danger"
                :title="t('gallery.savedViewRemove')"
                :aria-label="t('gallery.savedViewRemove')"
              >
                <el-icon><Close /></el-icon>
              </button>
            </template>
          </el-popconfirm>
        </span>
      </div>
    </el-scrollbar>
    <p
      v-else-if="loaded && !adding"
      class="m-0 px-2 pb-1 pt-0.5 text-xs leading-relaxed text-[var(--anime-text-secondary)] opacity-80"
    >
      {{ t("gallery.savedViewEmpty") }}
    </p>

    <!-- 编辑浮层：紧凑档（⋯ 面板本身是对话框）叠一个对话框；桌面档锚在那一行左侧 -->
    <el-dialog
      v-if="uiStore.isCompact"
      :model-value="!!editingView"
      :title="t('gallery.savedViewEditorTitle')"
      width="min(92vw, 480px)"
      append-to-body
      align-center
      @update:model-value="(v: boolean) => !v && closeEditor()"
    >
      <SavedViewEditor
        v-if="editingView"
        :key="editingView.id"
        :view="editingView"
        :views="rows"
        :current-query="query"
        :current-sort="sort"
        :current-body="currentBody"
        :show-title="false"
        @saved="onEditorSaved"
        @cancel="closeEditor"
      />
    </el-dialog>
    <el-popover
      v-else
      :visible="!!editingView"
      :virtual-ref="editingRowEl"
      virtual-triggering
      trigger="click"
      placement="left-start"
      :width="360"
      :popper-class="SAVED_VIEW_LAYER_CLASS"
      @update:visible="(v: boolean) => !v && closeEditor()"
    >
      <SavedViewEditor
        v-if="editingView"
        :key="editingView.id"
        :view="editingView"
        :views="rows"
        :current-query="query"
        :current-sort="sort"
        :current-body="currentBody"
        @saved="onEditorSaved"
        @cancel="closeEditor"
      />
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, Close, EditPen, Plus, RefreshRight } from "@kabegame/element-plus-icons";
import { useModalBack } from "@/composables/useModalBack";
import { IS_WEB } from "@/env";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { parseComposablePath, type GallerySort, type GalleryQueryPatch } from "@/utils/galleryPath";
import type { GalleryQuery } from "@/utils/galleryQuery";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";
import { viewRotationPath } from "@/utils/wallpaperRotationPath";
import { useActiveWallpaperRotationPaths } from "@/composables/useWallpaperTarget";
import {
  findNameConflict,
  normalizeSavedViewName,
  parseSavedViewBody,
  savedViewBody,
  savedViewDisplayName,
  type SavedView,
  type SavedViewQuery,
  type SavedViewSource,
} from "@/utils/savedViews";
import {
  addSavedView,
  listSavedViews,
  removeSavedView,
  SavedViewConflictError,
  touchSavedView,
} from "@/services/savedViews";
import SavedViewEditor from "./SavedViewEditor.vue";
import { SAVED_VIEW_LAYER_CLASS } from "./savedViewLayer";

const props = defineProps<{
  source: SavedViewSource;
  /** 当前视图的查询与排序（查询行的 props）。 */
  query: GalleryQuery;
  sort: GallerySort;
  /** ⋯ 面板是否打开：打开时读库，收起时记最后使用。 */
  active: boolean;
  /** 本页某个查询的完整视图路径（判断哪条是当前轮播来源）。 */
  pathFor: (patch: GalleryQueryPatch) => string;
}>();

const emit = defineEmits<{
  apply: [view: SavedViewQuery];
}>();

const { t } = useI18n();
const uiStore = useUiStore();
const settingsStore = useSettingsStore();

const SCOPE_KEYS: Record<SavedViewSource, string> = {
  gallery: "gallery.savedViewsScopeGallery",
  album: "gallery.savedViewsScopeAlbum",
  task: "gallery.savedViewsScopeTask",
  surf: "gallery.savedViewsScopeSurf",
};
const scopeLabel = computed(() => t(SCOPE_KEYS[props.source]));

/** 本次打开的快照：打开时读库排好，增删改就地更新，顺序不再变。 */
const rows = ref<SavedView[]>([]);
const loaded = ref(false);
/** 本次打开期间最后应用的那条：收起时才写它的最后使用时间。 */
let pendingAppliedId: number | null = null;
let loadSeq = 0;

const currentBody = computed(() => savedViewBody(props.query, props.sort));
const savedAs = computed(() => rows.value.find((row) => row.path === currentBody.value));

async function reload() {
  const seq = ++loadSeq;
  try {
    const list = await listSavedViews(props.source);
    if (seq === loadSeq) rows.value = list;
  } catch (error) {
    logger.warn("读取收藏视图失败:", error);
    if (seq === loadSeq) rows.value = [];
  } finally {
    if (seq === loadSeq) loaded.value = true;
  }
}

function commitPending() {
  const id = pendingAppliedId;
  pendingAppliedId = null;
  if (id == null) return;
  touchSavedView(id).catch((error) => logger.warn("记录收藏视图使用时间失败:", error));
}

// ---------- 应用 ----------
function applyRow(row: SavedView) {
  emit("apply", parseSavedViewBody(row.path));
  pendingAppliedId = row.id ?? null;
}

// ---------- 轮播来源标记 ----------
// 随机排序的种子不可比，跳过；web 没有轮播。
// 任一活跃壁纸目标的轮播路径命中即标记；逐屏独立下各屏可以各用一条收藏视图，所以可能不止一行。
const activeRotationPaths = useActiveWallpaperRotationPaths();
const rotationRowIds = computed(() => {
  const ids = new Set<NonNullable<SavedView["id"]>>();
  const paths = activeRotationPaths.value;
  if (IS_WEB || !settingsStore.values.wallpaperRotationEnabled || paths.length === 0) return ids;
  for (const row of rows.value) {
    if (row.id == null) continue;
    const { query, sort } = parseComposablePath(row.path);
    if (sort.field === "random") continue;
    if (paths.includes(viewRotationPath(props.pathFor({ query, sort })))) ids.add(row.id);
  }
  return ids;
});

// ---------- 新增 ----------
const adding = ref(false);
const nameDraft = ref("");
const addInputRef = ref<{ focus: () => void } | null>(null);
const addConflict = computed(() =>
  adding.value ? findNameConflict(rows.value, normalizeSavedViewName(nameDraft.value), currentBody.value) : undefined,
);
const addSaveError = ref("");
const addError = computed(() =>
  addConflict.value
    ? t("gallery.savedViewNameConflict", { name: savedViewDisplayName(addConflict.value) })
    : addSaveError.value,
);
watch(nameDraft, () => (addSaveError.value = ""));

function startAdd() {
  adding.value = true;
  nameDraft.value = "";
  addSaveError.value = "";
  void nextTick(() => addInputRef.value?.focus());
}

function cancelAdd() {
  adding.value = false;
  nameDraft.value = "";
  addSaveError.value = "";
}

let addBusy = false;
async function confirmAdd() {
  if (addBusy || addConflict.value || savedAs.value) return;
  addBusy = true;
  try {
    const view = await addSavedView(props.source, currentBody.value, normalizeSavedViewName(nameDraft.value));
    rows.value.unshift(view);
    cancelAdd();
    flash(view.id);
  } catch (error) {
    if (error instanceof SavedViewConflictError) {
      const name = savedViewDisplayName(error.other);
      addSaveError.value =
        error.kind === "name"
          ? t("gallery.savedViewNameConflict", { name })
          : t("gallery.savedViewPathConflict", { name });
    } else {
      logger.error("收藏视图失败:", error);
      ElMessage.error(t("gallery.savedViewSaveFailed"));
    }
  } finally {
    addBusy = false;
  }
}

// ---------- 行定位与闪烁 ----------
const rowEls = new Map<number, HTMLElement>();
function setRowEl(id: number | undefined, el: Element | ComponentPublicInstance | null) {
  if (id == null) return;
  if (el instanceof HTMLElement) rowEls.set(id, el);
  else rowEls.delete(id);
}

const flashId = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flash(id: number | undefined) {
  if (id == null) return;
  if (flashTimer) clearTimeout(flashTimer);
  flashId.value = null;
  void nextTick(() => {
    rowEls.get(id)?.scrollIntoView({ block: "nearest" });
    flashId.value = id;
    flashTimer = setTimeout(() => (flashId.value = null), 900);
  });
}
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

// ---------- 移除 ----------
const removeConfirmId = ref<number | null>(null);
function setRemoveConfirm(id: number | undefined, visible: boolean) {
  if (id == null) return;
  if (visible) removeConfirmId.value = id;
  else if (removeConfirmId.value === id) removeConfirmId.value = null;
}
useModalBack(
  computed({
    get: () => removeConfirmId.value !== null,
    set: (open) => {
      if (!open) removeConfirmId.value = null;
    },
  }),
);

async function removeRow(row: SavedView) {
  if (row.id == null) return;
  const id = row.id;
  try {
    await removeSavedView(id);
    rows.value = rows.value.filter((item) => item.id !== id);
    if (pendingAppliedId === id) pendingAppliedId = null;
    if (editingId.value === id) editingId.value = null;
  } catch (error) {
    logger.error("移除收藏视图失败:", error);
    ElMessage.error(t("gallery.savedViewSaveFailed"));
  }
}

// ---------- 编辑 ----------
const editingId = ref<number | null>(null);
const editingRowEl = ref<HTMLElement>();
const editingView = computed(() => rows.value.find((row) => row.id === editingId.value) ?? null);
useModalBack(
  computed({
    get: () => editingId.value !== null,
    set: (open) => {
      if (!open) editingId.value = null;
    },
  }),
);

function openEditor(row: SavedView) {
  if (row.id == null) return;
  cancelAdd();
  editingRowEl.value = rowEls.get(row.id);
  editingId.value = row.id;
}

function closeEditor() {
  editingId.value = null;
}

function onEditorSaved(updated: SavedView) {
  rows.value = rows.value.map((row) => (row.id === updated.id ? updated : row));
  closeEditor();
  flash(updated.id);
}

// ---------- 面板开合 ----------
// 放在最后：immediate 回调会用到上面声明的全部状态。
watch(
  () => props.active,
  (open) => {
    if (open) {
      pendingAppliedId = null;
      void reload();
      return;
    }
    commitPending();
    cancelAdd();
    removeConfirmId.value = null;
    editingId.value = null;
  },
  { immediate: true },
);
onBeforeUnmount(commitPending);
</script>

<style scoped lang="scss">
.saved-view-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  padding: 6px 8px;
  border: 1px dashed color-mix(in srgb, var(--anime-primary) 45%, transparent);
  border-radius: 8px;
  color: var(--anime-primary);
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: color-mix(in srgb, var(--anime-primary) 8%, transparent);
  }

  &.is-saved {
    border-style: solid;
    border-color: var(--anime-border);
    color: var(--anime-text-secondary);
    font-size: 12px;
  }
}

.saved-view-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 4px 0 12px;
  border-radius: 8px;
  color: var(--anime-text-primary);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: color-mix(in srgb, var(--anime-primary) 6%, var(--anime-bg-card));
  }

  /* 当前视图：左侧粉色竖条 + 淡底 */
  &.is-current {
    background: color-mix(in srgb, var(--anime-primary) 10%, transparent);

    &::before {
      position: absolute;
      top: 8px;
      bottom: 8px;
      left: 3px;
      width: 3px;
      border-radius: 2px;
      background: var(--anime-primary);
      content: "";
    }
  }

  &.is-flash {
    animation: saved-view-flash 0.9s ease;
  }
}

/* 没起名的行显示路径：等宽小字，一眼与用户起的名字分开 */
.saved-view-row__path {
  color: var(--anime-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

/* 悬停才出编辑 / 移除；正在编辑、正在确认或紧凑档常显 */
.saved-view-row__actions {
  display: none;
  flex: none;
  align-items: center;
  gap: 2px;

  &.is-shown {
    display: flex;
  }
}

.saved-view-row:hover .saved-view-row__actions {
  display: flex;
}

.saved-view-icon-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  color: var(--anime-text-secondary);
  background: transparent;
  font-size: 14px;
  cursor: pointer;

  &:hover,
  &.is-active {
    color: var(--anime-primary);
    background: color-mix(in srgb, var(--anime-primary) 12%, transparent);
  }

  &--primary {
    color: var(--anime-primary);
  }

  &--danger:hover {
    color: var(--anime-danger);
    background: color-mix(in srgb, var(--anime-danger) 10%, transparent);
  }
}

@keyframes saved-view-flash {
  30% {
    background: color-mix(in srgb, var(--anime-primary) 24%, transparent);
  }
}
</style>
