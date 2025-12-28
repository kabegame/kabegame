<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <!-- 详情：仅单选时显示 -->
    <div v-if="selectedCount === 1" class="context-menu-item" @click.stop="$emit('command', 'detail')">
      <el-icon>
        <InfoFilled />
      </el-icon>
      <span style="margin-left: 8px;">详情</span>
    </div>
    <!-- 收藏：仅当多选时右键多选的其中一个时才能批量操作 -->
    <div v-if="selectedCount === 1 || isImageSelected" class="context-menu-item"
      @click.stop="$emit('command', 'favorite')">
      <el-icon>
        <StarFilled v-if="image?.favorite" />
        <Star v-else />
      </el-icon>
      <span style="margin-left: 8px;">{{ image?.favorite ? '还有更喜欢滴' : '好喜欢' }}</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <!-- 加入画册：仅当多选时右键多选的其中一个时才能批量操作 -->
    <div v-if="selectedCount === 1 || isImageSelected" class="context-menu-item"
      @click.stop="$emit('command', 'addToAlbum')">
      <el-icon>
        <Collection />
      </el-icon>
      <span style="margin-left: 8px;">加入画册</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
    <!-- 复制：仅当多选时右键多选的其中一个时才能批量操作 -->
    <div v-if="selectedCount === 1 || isImageSelected" class="context-menu-item" @click.stop="$emit('command', 'copy')">
      <el-icon>
        <DocumentCopy />
      </el-icon>
      <span style="margin-left: 8px;">{{ selectedCount > 1 ? '全部复制' : '复制图片' }}</span>
    </div>
    <!-- 仔细欣赏：仅单选时显示 -->
    <div v-if="selectedCount === 1" class="context-menu-item" @click.stop="$emit('command', 'open')">
      <el-icon>
        <FolderOpened />
      </el-icon>
      <span style="margin-left: 8px;">仔细欣赏</span>
    </div>
    <!-- 欣赏更多：仅单选时显示 -->
    <div v-if="selectedCount === 1" class="context-menu-item" @click.stop="$emit('command', 'openFolder')">
      <el-icon>
        <Folder />
      </el-icon>
      <span style="margin-left: 8px;">欣赏更多</span>
    </div>
    <!-- 抱到桌面上：仅当多选时右键多选的其中一个时才能批量操作 -->
    <div v-if="selectedCount === 1 || isImageSelected" class="context-menu-item"
      @click.stop="$emit('command', 'wallpaper')">
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
    <div class="context-menu-item" @click.stop="$emit('command', 'remove')">
      <el-icon>
        <Remove />
      </el-icon>
      <span style="margin-left: 8px;">移除</span>
      <span v-if="selectedCount > 1" style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
        ({{ selectedCount }})
      </span>
    </div>
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
import { InfoFilled, StarFilled, Star, DocumentCopy, Delete, FolderOpened, Folder, Picture, Collection, Download, Remove } from "@element-plus/icons-vue";
import type { ImageInfo } from "@/stores/crawler";
import ContextMenu from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount?: number;
  isImageSelected?: boolean; // 右键的图片是否在选中列表中
}

const props = withDefaults(defineProps<Props>(), {
  selectedCount: 1,
  isImageSelected: true, // 默认值为 true，单选时总是 true，多选时由父组件传递
});

const selectedCount = computed(() => props.selectedCount);
const isImageSelected = computed(() => props.isImageSelected);

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
