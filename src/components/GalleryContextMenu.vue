<template>
  <ImageContextMenu
    :visible="visible"
    :position="position"
    :image="image"
    :selected-count="selectedCount"
    @close="$emit('close')"
    @command="$emit('command', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ImageInfo } from "@/stores/crawler";
import ImageContextMenu from "@/components/ImageContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount?: number; // 选中的图片数量
}

const props = defineProps<Props>();

const selectedCount = computed(() => props.selectedCount || 1);

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
