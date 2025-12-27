<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <div class="context-menu-item" @click.stop="$emit('command', 'browse')">
      <el-icon>
        <FolderOpened />
      </el-icon>
      <span style="margin-left: 8px;">浏览</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'exportToWEAuto')">
      <el-icon>
        <Download />
      </el-icon>
      <span style="margin-left: 8px;">导出并导入到 WE</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'exportToWE')">
      <el-icon>
        <Download />
      </el-icon>
      <span style="margin-left: 8px;">导出到 Wallpaper Engine</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'setWallpaperRotation')">
      <el-icon>
        <Picture />
      </el-icon>
      <span style="margin-left: 8px;">设为桌面轮播</span>
      <span v-if="isCurrentRotationAlbum" style="margin-left: 8px; color: var(--anime-primary); font-size: 12px;">
        (已设置)
      </span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" @click.stop="$emit('command', 'delete')">
      <el-icon>
        <Delete />
      </el-icon>
      <span style="margin-left: 8px;">删除</span>
    </div>
  </ContextMenu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Delete, FolderOpened, Picture, Download } from "@element-plus/icons-vue";
import ContextMenu from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  albumId?: string;
  currentRotationAlbumId?: string | null;
  wallpaperRotationEnabled?: boolean;
}

const props = defineProps<Props>();

const isCurrentRotationAlbum = computed(() => {
  // 只有在轮播已开启且画册ID匹配时才显示"已设置"
  return props.wallpaperRotationEnabled && props.albumId && props.currentRotationAlbumId === props.albumId;
});

defineEmits<{
  close: [];
  command: [command: "browse" | "delete" | "setWallpaperRotation" | "exportToWE" | "exportToWEAuto"];
}>();
</script>

<style scoped lang="scss"></style>


