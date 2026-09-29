<template>
  <div class="album-tree-panel flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 pb-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--anime-text-primary)]">
        {{ t("albums.treePanelTitle") }}
      </span>
      <el-dropdown trigger="click" placement="bottom-end" @command="onTitleMenuCommand">
        <button class="album-tree-menu-btn" type="button">
          <el-icon><MoreFilled /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="create-album">
              <el-icon><Plus /></el-icon>
              {{ t("albums.treeAddAlbum") }}
            </el-dropdown-item>
            <el-dropdown-item command="create-label">
              <el-icon><PriceTag /></el-icon>
              {{ t("albums.treeAddLabel") }}
            </el-dropdown-item>
            <el-dropdown-item command="create-label-dir">
              <el-icon><Folder /></el-icon>
              {{ t("albums.treeAddLabelDir") }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="album-tree-filter px-3 pb-2.5">
      <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>
    <AlbumTreeView
      ref="treeRef"
      v-model:search-text="searchText"
      :selected-id="selectedId"
      :dnd="dnd"
      show-status
      @select="(id, album) => emit('select', id, album)"
      @dblclick="emit('dblclick', $event)"
      @contextmenu="(album, event) => emit('contextmenu', album, event)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Folder, MoreFilled, Plus, PriceTag, Search } from "@kabegame/element-plus-icons";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { isLabelForestKind } from "@kabegame/core/types/album";
import AlbumTreeView from "./AlbumTreeView.vue";
import type { TreeDndController } from "@/components/tree/types";
import {
  FAVORITE_ALBUM_ID,
  HIDDEN_ALBUM_ID,
  fetchAlbum,
  moveAlbum,
  type Album,
  type AlbumNode,
} from "@/services/albums";

const props = defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{
  select: [albumId: string, album: AlbumNode];
  "create-album": [parentId: string | null];
  "create-label": [parentId: string | null, directory: boolean];
  contextmenu: [album: AlbumNode, event: MouseEvent];
  dblclick: [albumId: string];
}>();
const { t } = useI18n();
const searchText = ref("");
const selectedAlbum = ref<Album | null>(null);
const treeRef = ref<InstanceType<typeof AlbumTreeView> | null>(null);
watch(
  () => props.selectedId,
  async (id) => {
    selectedAlbum.value = id ? await fetchAlbum(id) : null;
  },
  { immediate: true },
);
function onTitleMenuCommand(command: string) {
  const album = selectedAlbum.value;
  if (command === "create-label" || command === "create-label-dir") {
    const parentId = album?.type === "label_dir" ? album.id : album?.type === "label" ? album.parentId : null;
    emit("create-label", parentId, command === "create-label-dir");
  } else if (command === "create-album") {
    emit(
      "create-album",
      album?.type === "normal" && ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(album.id) ? album.id : null,
    );
  }
}
const dnd: TreeDndController<AlbumNode> = {
  canDrag: (node) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(node.id) && node.type !== "local_folder",
  getDragLabel: (node) => node.name,
  onDragOver: (source, target) => {
    if (!target) return { accept: source.parentId != null, position: "inside" };
    if (
      target.id === source.id ||
      target.id === source.parentId ||
      [FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(target.id)
    )
      return false;
    if (target.type === "local_folder" || isLabelForestKind(source.type) !== isLabelForestKind(target.type))
      return false;
    if (isLabelForestKind(source.type) && target.type === "label") return false;
    if (target.ancestorPath.includes(`/${source.id}/`)) return false;
    return { accept: true, position: "inside", autoExpand: true };
  },
  drop: async (source, target) => {
    try {
      await moveAlbum(source.id, target?.id ?? null);
      ElMessage.success(t("albums.moveSuccess"));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : t("albums.moveFailed"));
    }
  },
};
defineExpose({
  reload: () => treeRef.value?.reload(),
  ensureSelectedExpanded: () => treeRef.value?.ensureSelectedExpanded(),
});
</script>

<style scoped>
/* 行的视觉 token 挂在本面板而非 AlbumTreeView：View 还被 AlbumPicker 复用，
 * 弹窗里要的是默认那套，这里的内缩/紫色选中态只属于 Albums 页的侧栏。
 * 自定义属性天然向下继承，:deep() 负责跨 View 的 scope id 命中具体元素。 */
.album-tree-panel {
  --kb-tree-sticky-bg: var(--anime-surface, #fff);
  --kb-tree-sticky-backdrop: none;

  /* 树行几何：对齐设计稿 kabegame-albums-1b（行 padding 7/8、13px 字、18px 缩进、
   * 14px 折叠三角列）。这些是 KbTreeRow 的 token，不缺省即画廊树原样。 */
  --kb-tree-row-font-size: 13px;
  --kb-tree-row-padding-x: 8px;
  --kb-tree-row-radius: 8px;
  --kb-tree-row-gap: 8px;
  /* 设计稿是 14px 列；这里取 16px 换一点点击面积，图标左缘只差 2px */
  --kb-tree-twistie-size: 16px;
  --kb-tree-twistie-icon-size: 9px;
  --kb-tree-separator-color: rgba(120, 140, 180, 0.14);

  /* 选中态：设计稿是淡紫底 + 深色加粗字，而非画廊树那套粉底粉字
   * （粉底粉字在本页粉色背景上对比度不足，糊成一团） */
  --kb-tree-row-active-bg: rgba(167, 139, 250, 0.18);
  --kb-tree-row-active-color: var(--anime-text-primary);
  --kb-tree-row-active-weight: 600;
}

/* 次要信息（计数 / 中性文件夹图标 / 小节标题）：设计稿是主文字色 45% 的灰。
 * --anime-text-muted(#a78bfa) 在本页浅色底上太淡，改用主文字色调透明度。
 * 元素带的 text-[var(--anime-text-muted)] 是 AlbumTreeView 给弹窗用的缺省，
 * 这条选择器更具体，只在本面板内把它顶掉。 */
.album-tree-panel :deep(.album-tree-dim) {
  color: color-mix(in srgb, var(--anime-text-primary) 52%, transparent);
}

/* 本地文件夹状态异常的红点 */
.album-tree-panel :deep(.album-tree-status-dot) {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef4444;
}

/* 行区左右内缩：行高亮成内缩圆角胶囊（对齐设计稿），比过滤框再往外 4px */
.album-tree-panel :deep(.kb-tree-panel__scroller) {
  padding: 2px 8px 8px;
}

/* sticky overlay 行默认 inset-x-0 贴边，跟随行区同步内缩，避免吸顶瞬间宽度跳变 */
.album-tree-panel :deep(.kb-tree-panel__sticky-row) {
  inset-inline: 8px;
}

/* 过滤框：设计稿 30px 高、12px 字。高度经 el 的 component-size 走正规链路
 * （--el-input-height 由它派生），不去写死 .el-input__wrapper 的 height。 */
.album-tree-filter {
  --el-component-size: 30px;
}

.album-tree-filter :deep(.el-input__inner) {
  font-size: 12px;
}

/* 标题右侧三点：设计稿是一枚低调图标，不要 el-button 的圆形 hover 块 */
.album-tree-menu-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--anime-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.album-tree-menu-btn:hover {
  color: var(--anime-text-secondary);
  background: rgba(167, 139, 250, 0.16);
}
</style>
