<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <div v-if="(albumImageCount ?? 0) > 0" class="context-menu-item" @click.stop="$emit('command', 'browse')">
      <el-icon>
        <FolderOpened />
      </el-icon>
      <span style="margin-left: 8px;">浏览</span>
    </div>
    <div v-if="(albumImageCount ?? 0) > 0" class="context-menu-item" @click.stop="$emit('command', 'setWallpaperRotation')">
      <el-icon>
        <Picture />
      </el-icon>
      <span style="margin-left: 8px;">设为桌面轮播</span>
      <span v-if="isCurrentRotationAlbum" style="margin-left: 8px; color: var(--anime-primary); font-size: 12px;">
        (已设置)
      </span>
    </div>
    <div v-if="(albumImageCount ?? 0) > 0" class="context-menu-divider"></div>
    <div class="context-menu-item" @click.stop="$emit('command', 'rename')">
      <el-icon>
        <Edit />
      </el-icon>
      <span style="margin-left: 8px;">重命名</span>
    </div>
    <div v-if="albumId !== FAVORITE_ALBUM_ID" class="context-menu-item" @click.stop="$emit('command', 'delete')">
      <el-icon>
        <Delete />
      </el-icon>
      <span style="margin-left: 8px;">删除</span>
    </div>
  </ContextMenu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Delete, FolderOpened, Picture, Download, Edit } from "@element-plus/icons-vue";
import ContextMenu from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  albumId?: string;
  albumName?: string; // 画册名称（保留用于显示）
  currentRotationAlbumId?: string | null;
  wallpaperRotationEnabled?: boolean;
  albumImageCount?: number; // 画册图片数量
}

// 收藏画册的固定ID（与后端保持一致）
const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";

const props = defineProps<Props>();

const isCurrentRotationAlbum = computed(() => {
  // 只有在轮播已开启且画册ID匹配时才显示"已设置"
  return props.wallpaperRotationEnabled && props.albumId && props.currentRotationAlbumId === props.albumId;
});

defineEmits<{
  close: [];
  command: [command: "browse" | "delete" | "setWallpaperRotation" | "rename"];
}>();
</script>

<style scoped lang="scss"></style>
