<template>
  <transition-group name="fade-in-list" tag="div" class="image-grid" :style="gridStyle">
    <ImageItem v-for="(image, index) in images" :key="image.id" :image="image" :image-url="imageUrlMap[image.id]"
      :image-click-action="imageClickAction" :use-original="props.columns > 0 && props.columns <= 2"
      :aspect-ratio-match-window="props.aspectRatioMatchWindow" :window-aspect-ratio="props.windowAspectRatio"
      :selected="selectedImages.has(image.id)" :draggable="props.draggable" :drag-index="index"
      @click="(e) => handleImageClick(image, e)" @dblclick="(e) => handleImageDblClick(image, e)"
      @contextmenu="(e) => $emit('contextmenu', e, image)" @dragstart="handleDragStart" @dragover="handleDragOver"
      @drop="handleDrop" @dragend="handleDragEnd" />
  </transition-group>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
  imageClickAction: "preview" | "open";
  columns: number; // 0 表示自动（auto-fill），其他值表示固定列数
  aspectRatioMatchWindow: boolean; // 图片宽高比是否与窗口相同
  windowAspectRatio: number; // 窗口宽高比
  selectedImages: Set<string>; // 选中的图片 ID 集合
  draggable?: boolean; // 是否可以通过拖动来调整顺序
}

const props = defineProps<Props>();

const emit = defineEmits<{
  imageClick: [image: ImageInfo, event?: MouseEvent];
  imageDblClick: [image: ImageInfo, event?: MouseEvent];
  imageSelect: [image: ImageInfo, event: MouseEvent];
  contextmenu: [event: MouseEvent, image: ImageInfo];
  reorder: [newOrder: ImageInfo[]]; // 拖拽排序后新的顺序
}>();

const handleImageClick = (image: ImageInfo, event?: MouseEvent) => {
  emit("imageClick", image, event);
};

const handleImageDblClick = (image: ImageInfo, event?: MouseEvent) => {
  emit("imageDblClick", image, event);
};

// 拖拽排序相关
const draggedIndex = ref<number | null>(null);

const handleDragStart = (_event: DragEvent, index: number) => {
  draggedIndex.value = index;
};

const handleDragOver = (_event: DragEvent, index: number) => {
  // 只允许在有效索引之间拖拽
  if (draggedIndex.value === null || draggedIndex.value === index) return;
};

const handleDrop = (_event: DragEvent, index: number) => {
  if (draggedIndex.value === null || draggedIndex.value === index) {
    draggedIndex.value = null;
    return;
  }

  // 计算新的顺序
  const newImages = [...props.images];
  const draggedItem = newImages[draggedIndex.value];
  newImages.splice(draggedIndex.value, 1);
  newImages.splice(index, 0, draggedItem);

  // 发出 reorder 事件
  emit("reorder", newImages);
  draggedIndex.value = null;
};

const handleDragEnd = () => {
  draggedIndex.value = null;
};

// 计算网格列样式
const gridStyle = computed(() => {
  if (props.columns === 0) {
    // 自动列数
    return {
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))'
    };
  } else {
    // 固定列数
    return {
      gridTemplateColumns: `repeat(${props.columns}, 1fr)`
    };
  }
});

</script>

<style scoped lang="scss">
.image-grid {
  display: grid;
  gap: 16px;
  width: 100%;
}

/* 列表淡入动画 */
.fade-in-list-enter-active {
  transition: all 0.4s ease-out;
}

.fade-in-list-leave-active {
  transition: all 0.3s ease-in;
}

.fade-in-list-enter-from {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.fade-in-list-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

.fade-in-list-move {
  /* 避免新增元素时旧元素产生移动动画导致列表上跳闪烁 */
  transition: none;
}
</style>
