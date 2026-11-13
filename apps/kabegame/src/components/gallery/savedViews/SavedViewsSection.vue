<template>
  <!-- ⋯ 面板里的收藏视图。列表在面板打开时读一次库、按最后使用排好，打开期间顺序不变；点一行只是应用，
       收起面板时才给本次最后应用的那条记最后使用。改名 / 用当前视图更新走编辑浮层，移除走叉号确认。
       语义见 cocs/gallery/SAVED_VIEWS.md。 -->
  <div class="flex min-w-0 flex-col">
    <div class="flex items-baseline justify-between gap-2 px-2 pb-1.5 pt-2">
      <span class="text-[12px] font-500 text-kb-fg-muted">{{ t("gallery.savedViews") }}</span>
      <span class="truncate text-[11.5px] text-kb-fg-subtle tabular-nums">{{ scopeLabel }} · {{ rows.length }}</span>
    </div>

    <!-- 顶部新增：点加号展开命名输入框；当前视图已收藏时换成「已收藏为」，点它让那一行闪一下 -->
    <div v-if="adding" class="mb-1 px-1">
      <div class="flex items-center gap-1">
        <Input
          ref="addInputRef"
          v-model="nameDraft"
          size="sm"
          class="min-w-0 flex-1"
          :placeholder="currentBody"
          :aria-label="t('gallery.savedViewName')"
          :invalid="!!addError"
          maxlength="80"
          @keydown.enter.stop.prevent="confirmAdd"
          @keydown.esc.stop.prevent="cancelAdd"
        />
        <Button variant="ghost" size="icon-sm" :aria-label="t('common.ok')" @click="confirmAdd">
          <Check class="!text-kb-fg" />
        </Button>
        <Button variant="ghost" size="icon-sm" :aria-label="t('common.cancel')" @click="cancelAdd">
          <X />
        </Button>
      </div>
      <p class="m-0 mt-1 px-0.5 text-[11.5px]" :class="addError ? 'text-kb-danger' : 'text-kb-fg-muted'">
        {{ addError || t("gallery.savedViewNameHint") }}
      </p>
    </div>
    <button
      v-else-if="savedAs"
      type="button"
      :class="[ADD_ROW, 'text-[12px] text-kb-fg-muted']"
      @click="flash(savedAs.id)"
    >
      <Check class="size-4 flex-none" />
      <span class="min-w-0 truncate">
        {{ t("gallery.savedViewAlreadySaved", { name: savedViewDisplayName(savedAs) }) }}
      </span>
    </button>
    <button v-else type="button" :class="[ADD_ROW, 'text-[13px] text-kb-fg']" @click="startAdd">
      <Plus class="size-4 flex-none text-kb-fg-muted" />
      <span>{{ t("gallery.savedViewAdd") }}</span>
    </button>

    <ScrollArea v-if="rows.length > 0" viewport-class="max-h-[248px]">
      <div class="flex flex-col gap-0.5">
        <div
          v-for="row in rows"
          :key="row.id"
          :ref="(el) => setRowEl(row.id, el)"
          class="group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-kb-md pl-3 pr-1 text-[13px] text-kb-fg"
          :class="[
            row.path === currentBody ? 'bg-[color-mix(in_srgb,var(--kb-accent)_10%,transparent)]' : 'hover:bg-kb-hover',
            flashId === row.id ? 'saved-view-flash' : '',
          ]"
          :title="row.path"
          @click="applyRow(row)"
        >
          <!-- 当前视图：左侧强调色竖条 -->
          <span
            v-if="row.path === currentBody"
            class="absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-kb-accent"
            aria-hidden="true"
          />
          <!-- 没起名的行显示路径：等宽小字，一眼与用户起的名字分开 -->
          <span
            class="min-w-0 flex-1 truncate"
            :class="row.name === null ? 'font-mono text-[11px] text-kb-fg-muted' : ''"
          >
            {{ savedViewDisplayName(row) }}
          </span>
          <Tooltip v-if="row.id != null && rotationRowIds.has(row.id)" :content="t('gallery.savedViewRotationSource')">
            <RefreshCw class="size-3.5 flex-none text-kb-accent" />
          </Tooltip>
          <!-- 悬停才出编辑 / 移除；正在编辑、正在确认或紧凑档常显 -->
          <span
            class="flex-none items-center gap-0.5"
            :class="
              uiStore.isCompact || editingId === row.id || removeConfirmId === row.id
                ? 'flex'
                : 'hidden group-hover:flex'
            "
            @click.stop
          >
            <Button
              variant="ghost"
              size="icon-xs"
              class="!size-6"
              :data-state="editingId === row.id ? 'open' : undefined"
              :title="t('gallery.savedViewEdit')"
              :aria-label="t('gallery.savedViewEdit')"
              @click="openEditor(row)"
            >
              <Pencil />
            </Button>
            <!-- 受控确认，同一时刻只开一个；它是 Reka 层，点它不关 ⋯ 面板 -->
            <Popconfirm
              :open="removeConfirmId === row.id"
              align="end"
              :title="t('gallery.savedViewRemoveConfirm')"
              @update:open="(v: boolean) => setRemoveConfirm(row.id, v)"
              @confirm="removeRow(row)"
            >
              <Button
                variant="ghost-danger"
                size="icon-xs"
                class="!size-6"
                :title="t('gallery.savedViewRemove')"
                :aria-label="t('gallery.savedViewRemove')"
              >
                <X />
              </Button>
            </Popconfirm>
          </span>
        </div>
      </div>
    </ScrollArea>
    <p v-else-if="loaded && !adding" class="m-0 px-2 pb-1.5 pt-0.5 text-[12px] leading-relaxed text-kb-fg-muted">
      {{ t("gallery.savedViewEmpty") }}
    </p>

    <!-- 编辑浮层：紧凑档（⋯ 面板本身是对话框）叠一个对话框；桌面档锚在那一行左侧 -->
    <Dialog
      v-if="uiStore.isCompact"
      :open="!!editingView"
      :title="t('gallery.savedViewEditorTitle')"
      @update:open="(v: boolean) => !v && closeEditor()"
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
    </Dialog>
    <Popover v-else :open="!!editingView" @update:open="(v: boolean) => !v && closeEditor()">
      <PopoverContent side="left" align="start" :side-offset="10" :width="360" :anchor="editingRowEl">
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
      </PopoverContent>
    </Popover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, Pencil, Plus, RefreshCw, X } from "@lucide/vue";
import { Button, Dialog, Input, Popconfirm, Popover, PopoverContent, ScrollArea, Tooltip } from "@/components/ui";
import { IS_WEB } from "@/env";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { parseComposablePath, type GallerySort, type GalleryQueryPatch } from "@/utils/galleryPath";
import type { GalleryQuery } from "@/utils/galleryQuery";
import { kameMessage } from "@/utils/kameMessage";
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

const ADD_ROW =
  "mb-1 flex h-8 cursor-pointer items-center gap-2 rounded-kb-md border-0 bg-transparent px-2 text-left [font-family:inherit] hover:bg-kb-hover";
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
      kameMessage.error(t("gallery.savedViewSaveFailed"));
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
// Popconfirm 自己接返回栈
function setRemoveConfirm(id: number | undefined, visible: boolean) {
  if (id == null) return;
  if (visible) removeConfirmId.value = id;
  else if (removeConfirmId.value === id) removeConfirmId.value = null;
}

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
    kameMessage.error(t("gallery.savedViewSaveFailed"));
  }
}

// ---------- 编辑 ----------
const editingId = ref<number | null>(null);
const editingRowEl = ref<HTMLElement>();
// 编辑浮层（Popover / Dialog）自己接返回栈
const editingView = computed(() => rows.value.find((row) => row.id === editingId.value) ?? null);

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

<style scoped>
/* 定位到某一行（「已收藏为」）时闪一下 */
.saved-view-flash {
  animation: saved-view-flash 0.9s ease;
}

@keyframes saved-view-flash {
  30% {
    background: color-mix(in srgb, var(--kb-accent) 22%, transparent);
  }
}
</style>
