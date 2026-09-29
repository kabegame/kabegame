<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 pb-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--anime-text-primary)]">{{ t("albums.treePanelTitle") }}</span>
      <el-dropdown trigger="click" placement="bottom-end" @command="onTitleMenuCommand">
        <button class="flex h-5 w-5 items-center justify-center rounded-md border-0 bg-transparent text-[var(--anime-text-muted)] hover:bg-[rgba(167,139,250,0.16)]" type="button">
          <el-icon><MoreFilled /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="create-album"><el-icon><Plus /></el-icon>{{ t("albums.treeAddAlbum") }}</el-dropdown-item>
            <el-dropdown-item command="create-label"><el-icon><PriceTag /></el-icon>{{ t("albums.treeAddLabel") }}</el-dropdown-item>
            <el-dropdown-item command="create-label-dir"><el-icon><Folder /></el-icon>{{ t("albums.treeAddLabelDir") }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="px-3 pb-2.5">
      <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>
    <AlbumTreeView ref="treeRef" v-model:search-text="searchText" :selected-id="selectedId" :dnd="dnd"
      @select="(id, album) => emit('select', id, album)" @dblclick="emit('dblclick', $event)"
      @contextmenu="(album, event) => emit('contextmenu', album, event)" />
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
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID, fetchAlbum, moveAlbum, type Album, type AlbumNode } from "@/services/albums";

const props = defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{ select: [albumId: string, album: AlbumNode]; "create-album": [parentId: string | null];
  "create-label": [parentId: string | null, directory: boolean]; contextmenu: [album: AlbumNode, event: MouseEvent]; dblclick: [albumId: string] }>();
const { t } = useI18n();
const searchText = ref("");
const selectedAlbum = ref<Album | null>(null);
const treeRef = ref<InstanceType<typeof AlbumTreeView> | null>(null);
watch(() => props.selectedId, async (id) => { selectedAlbum.value = id ? await fetchAlbum(id) : null; }, { immediate: true });
function onTitleMenuCommand(command: string) {
  const album = selectedAlbum.value;
  if (command === "create-label" || command === "create-label-dir") {
    const parentId = album?.type === "label_dir" ? album.id : album?.type === "label" ? album.parentId : null;
    emit("create-label", parentId, command === "create-label-dir");
  } else if (command === "create-album") {
    emit("create-album", album?.type === "normal" && ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(album.id) ? album.id : null);
  }
}
const dnd: TreeDndController<AlbumNode> = {
  canDrag: (node) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(node.id) && node.type !== "local_folder",
  getDragLabel: (node) => node.name,
  onDragOver: (source, target) => {
    if (!target) return { accept: source.parentId != null, position: "inside" };
    if (target.id === source.id || target.id === source.parentId || [FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(target.id)) return false;
    if (target.type === "local_folder" || isLabelForestKind(source.type) !== isLabelForestKind(target.type)) return false;
    if (isLabelForestKind(source.type) && target.type === "label") return false;
    if (target.ancestorPath.includes(`/${source.id}/`)) return false;
    return { accept: true, position: "inside", autoExpand: true };
  },
  drop: async (source, target) => {
    try { await moveAlbum(source.id, target?.id ?? null); ElMessage.success(t("albums.moveSuccess")); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : t("albums.moveFailed")); }
  },
};
defineExpose({ reload: () => treeRef.value?.reload(), ensureSelectedExpanded: () => treeRef.value?.ensureSelectedExpanded() });
</script>
