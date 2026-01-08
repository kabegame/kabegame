<template>
  <CoreTaskImageContextMenu
    :visible="visible"
    :position="position"
    :image="image"
    :selected-count="selectedCount"
    :selected-image-ids="selectedImageIds"
    :hide="hideKeys"
    @close="$emit('close')"
    @command="$emit('command', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import CoreTaskImageContextMenu from "@kabegame/core/components/contextMenu/TaskImageContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: any;
  selectedCount?: number;
  selectedImageIds?: Set<string>;
}

const props = defineProps<Props>();

// plugin-editor 里只保留“详情/删除”类入口；其余命令需要 main 的后端命令集，暂时隐藏
const hideKeys = computed(() => [
  "copy",
  "open",
  "openFolder",
  "more",
  "exportToWEAuto",
]);
</script>


