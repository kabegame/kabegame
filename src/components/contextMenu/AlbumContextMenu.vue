<template>
  <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
    @command="(cmd: string) => $emit('command', cmd as 'browse' | 'delete' | 'setWallpaperRotation' | 'rename')" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Delete, FolderOpened, Picture, Edit } from "@element-plus/icons-vue";
import ContextMenu, { type MenuItem } from "@/components/ContextMenu.vue";
import { useAlbumStore } from "@/stores/albums";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  albumId?: string;
  albumName?: string; // 画册名称（保留用于显示）
  currentRotationAlbumId?: string | null;
  wallpaperRotationEnabled?: boolean;
  albumImageCount?: number; // 画册图片数量
}

const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);

const props = defineProps<Props>();

const isCurrentRotationAlbum = computed(() => {
  // 只有在轮播已开启且画册ID匹配时才显示"已设置"
  return props.wallpaperRotationEnabled && props.albumId && props.currentRotationAlbumId === props.albumId;
});

const hasImages = computed(() => (props.albumImageCount ?? 0) > 0);

const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];

  // 浏览
  if (hasImages.value) {
    items.push({
      key: "browse",
      type: "item",
      label: "浏览",
      icon: FolderOpened,
      command: "browse",
    });
  }

  // 设为桌面轮播
  if (hasImages.value) {
    items.push({
      key: "setWallpaperRotation",
      type: "item",
      label: "设为桌面轮播",
      icon: Picture,
      command: "setWallpaperRotation",
      suffix: isCurrentRotationAlbum.value ? "(已设置)" : undefined,
    });
  }

  // 分隔符
  if (hasImages.value) {
    items.push({ key: "divider1", type: "divider" });
  }

  // 重命名
  items.push({
    key: "rename",
    type: "item",
    label: "重命名",
    icon: Edit,
    command: "rename",
  });

  // 删除
  if (props.albumId !== FAVORITE_ALBUM_ID.value) {
    items.push({
      key: "delete",
      type: "item",
      label: "删除",
      icon: Delete,
      command: "delete",
    });
  }

  return items;
});

defineEmits<{
  close: [];
  command: [command: "browse" | "delete" | "setWallpaperRotation" | "rename"];
}>();
</script>

<style scoped lang="scss"></style>
