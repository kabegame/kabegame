<template>
  <div class="album-tree-panel flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 pb-2 pl-4 pr-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-600 text-kb-fg">
        {{ t("albums.treePanelTitle") }}
      </span>
      <DropdownMenu>
        <Tooltip :content="t('albums.treeAddMenu')">
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="t('albums.treeAddMenu')">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent>
          <MenuItem @select="onCreate('create-album')">
            <ImageIcon />
            {{ t("albums.treeAddAlbum") }}
          </MenuItem>
          <MenuItem @select="onCreate('create-label')">
            <Tag />
            {{ t("albums.treeAddLabel") }}
          </MenuItem>
          <MenuItem @select="onCreate('create-label-dir')">
            <Folder />
            {{ t("albums.treeAddLabelDir") }}
          </MenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div class="px-3 pb-2">
      <Input v-model="searchText" size="sm" clearable :placeholder="t('albums.treeFilterPlaceholder')">
        <template #prefix>
          <Search />
        </template>
      </Input>
    </div>
    <AlbumTreeView
      ref="treeRef"
      v-model:search-text="searchText"
      :selected-id="selectedId"
      :dnd="dnd"
      expand-label-dirs
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
import { Folder, Image as ImageIcon, Plus, Search, Tag } from "@lucide/vue";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  MenuItem,
  Tooltip,
} from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import { isLabelForestKind } from "@/types/album";
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
function onCreate(command: "create-album" | "create-label" | "create-label-dir") {
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
      kameMessage.success(t("albums.moveSuccess"));
    } catch (error) {
      kameMessage.error(error instanceof Error ? error.message : t("albums.moveFailed"));
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
 * 弹窗里要的是默认那套，这里的行几何只属于画册页的侧栏。
 * 自定义属性天然向下继承，:deep() 负责跨 View 的 scope id 命中具体元素。 */
.album-tree-panel {
  /* 侧栏底色随页面（开应用背景时是透出的图），吸顶行用半透明磨砂而不是实底白条 */
  --kb-tree-sticky-bg: var(--kb-glass-strong);
  --kb-tree-sticky-backdrop: blur(12px);

  /* 树行几何：13px 字、18px 缩进、16px 折叠三角列 */
  --kb-tree-row-font-size: 13px;
  --kb-tree-row-padding-x: 8px;
  --kb-tree-row-radius: var(--kb-radius-md);
  --kb-tree-row-gap: 8px;
  --kb-tree-twistie-size: 16px;
  --kb-tree-twistie-icon-size: 12px;
  --kb-tree-separator-color: var(--kb-line);

  /* 选中态：默认的淡强调色底 + 主文字色，再加粗 */
  --kb-tree-row-active-weight: 600;
}

/* 行区左右内缩：行高亮成内缩圆角胶囊 */
.album-tree-panel :deep(.kb-tree-panel__scroller) {
  padding: 2px 8px 8px;
}

/* sticky overlay 行默认 inset-x-0 贴边，跟随行区同步内缩，避免吸顶瞬间宽度跳变 */
.album-tree-panel :deep(.kb-tree-panel__sticky-row) {
  inset-inline: 8px;
}
</style>
