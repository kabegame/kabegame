<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <!-- 简化多选菜单：只显示复制、移除、删除 -->
    <template v-if="showSimplifiedMenu">
      <!-- 全部复制 -->
      <div class="context-menu-item" @click.stop="$emit('command', 'copy')">
        <el-icon>
          <DocumentCopy />
        </el-icon>
        <span style="margin-left: 8px;">全部复制</span>
        <span style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
          ({{ selectedCount }})
        </span>
      </div>
      <!-- 移除 -->
      <div class="context-menu-item" @click.stop="$emit('command', 'remove')">
        <el-icon>
          <Remove />
        </el-icon>
        <span style="margin-left: 8px;">{{ removeText }}</span>
        <span style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
          ({{ selectedCount }})
        </span>
      </div>
      <!-- 删除 -->
      <div class="context-menu-item" @click.stop="$emit('command', 'delete')">
        <el-icon>
          <Delete />
        </el-icon>
        <span style="margin-left: 8px;">删除</span>
        <span style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
          ({{ selectedCount }})
        </span>
      </div>
    </template>
    <!-- 完整菜单：单选或非简化模式 -->
    <template v-else>
      <!-- 详情：仅单选时显示 -->
      <div v-if="selectedCount === 1" class="context-menu-item" @click.stop="$emit('command', 'detail')">
        <el-icon>
          <InfoFilled />
        </el-icon>
        <span style="margin-left: 8px;">详情</span>
      </div>
      <!-- 收藏：仅支持普通（单张）收藏 -->
      <div v-if="selectedCount === 1 && !hideFavoriteAndAddToAlbum" class="context-menu-item" @click.stop="$emit('command', 'favorite')">
        <el-icon>
          <StarFilled v-if="image?.favorite" />
          <Star v-else />
        </el-icon>
        <span style="margin-left: 8px;">{{ image?.favorite ? '还有更喜欢滴' : '好喜欢' }}</span>
      </div>
      <!-- 加入画册：仅当多选时右键多选的其中一个时才能批量操作 -->
      <div v-if="(selectedCount === 1 && !hideFavoriteAndAddToAlbum) || (selectedCount > 1 && isImageSelected)" class="context-menu-item"
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
        <span style="margin-left: 8px;">{{ removeText }}</span>
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
    </template>
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
  removeText?: string; // "移除"菜单项文案（不同页面可定制）
  simplifiedMultiSelectMenu?: boolean; // 多选时是否只显示简化菜单（复制、移除、删除）
  hideFavoriteAndAddToAlbum?: boolean; // 是否隐藏收藏和加入画册菜单项（单选时）
}

const props = withDefaults(defineProps<Props>(), {
  selectedCount: 1,
  isImageSelected: true, // 默认值为 true，单选时总是 true，多选时由父组件传递
  removeText: "移除",
  simplifiedMultiSelectMenu: false,
  hideFavoriteAndAddToAlbum: false,
});

const selectedCount = computed(() => props.selectedCount);
const isImageSelected = computed(() => props.isImageSelected);
const removeText = computed(() => props.removeText);
const showSimplifiedMenu = computed(() => props.simplifiedMultiSelectMenu && selectedCount.value > 1);

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
