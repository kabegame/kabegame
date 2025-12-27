<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <div class="context-menu-item" @click.stop="$emit('command', 'detail')">
      <el-icon>
        <InfoFilled />
      </el-icon>
      <span style="margin-left: 8px;">详情</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'favorite')">
      <el-icon>
        <StarFilled v-if="image?.favorite" />
        <Star v-else />
      </el-icon>
      <span style="margin-left: 8px;">{{ image?.favorite ? '还有更喜欢滴' : '好喜欢' }}</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'addToAlbum')">
      <el-icon>
        <Collection />
      </el-icon>
      <span style="margin-left: 8px;">加入画册</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'copy')">
      <el-icon>
        <DocumentCopy />
      </el-icon>
      <span style="margin-left: 8px;">复制图片</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'open')">
      <el-icon>
        <FolderOpened />
      </el-icon>
      <span style="margin-left: 8px;">仔细欣赏</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'openFolder')">
      <el-icon>
        <Folder />
      </el-icon>
      <span style="margin-left: 8px;">欣赏更多</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'wallpaper')">
      <el-icon>
        <Picture />
      </el-icon>
      <span style="margin-left: 8px;">抱到桌面上</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'exportToWEAuto')">
      <el-icon>
        <Download />
      </el-icon>
      <span style="margin-left: 8px;">导出并导入到 WE</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'exportToWE')">
      <el-icon>
        <Download />
      </el-icon>
      <span style="margin-left: 8px;">导出到 Wallpaper Engine</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" @click.stop="$emit('command', 'delete')">
      <el-icon>
        <Delete />
      </el-icon>
      <span style="margin-left: 8px;">删除</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
  </ContextMenu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { InfoFilled, StarFilled, Star, DocumentCopy, Delete, FolderOpened, Folder, Picture, Collection, Download } from "@element-plus/icons-vue";
import type { ImageInfo } from "@/stores/crawler";
import ContextMenu from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount?: number;
}

const props = defineProps<Props>();
const selectedCount = computed(() => props.selectedCount || 1);

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
