<template>
  <SingleImageContextMenu v-if="selectedCount === 1" :visible="visible" :position="position" :image="image"
    @close="$emit('close')" @command="$emit('command', $event)" />
  <MultiImageContextMenu v-else :visible="visible" :position="position" :image="image" :selected-count="selectedCount"
    :is-image-selected="isImageSelected" @close="$emit('close')" @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ImageInfo } from "@/stores/crawler";
import SingleImageContextMenu from "./SingleImageContextMenu.vue";
import MultiImageContextMenu from "./MultiImageContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount?: number; // 选中的图片数量
  selectedImageIds?: Set<string>; // 选中的图片ID集合
}

const props = defineProps<Props>();

const selectedCount = computed(() => props.selectedCount || 1);
const isImageSelected = computed(() => {
  if (!props.image || !props.selectedImageIds || selectedCount.value === 1) {
    return true; // 单选时总是返回 true
  }
  return props.selectedImageIds.has(props.image.id);
});

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
