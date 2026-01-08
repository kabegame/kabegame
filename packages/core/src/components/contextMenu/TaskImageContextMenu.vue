<template>
    <SingleImageContextMenu v-if="selectedCount === 1" :visible="visible" :position="position" :image="image"
        :hide="hide" remove-text="删除" @close="$emit('close')" @command="$emit('command', $event)" />
    <MultiImageContextMenu v-else :visible="visible" :position="position" :image="image" :selected-count="selectedCount"
        :is-image-selected="isImageSelected" :hide="hide" remove-text="删除" @close="$emit('close')"
        @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ImageInfo } from "../../types/image";
import SingleImageContextMenu from "./SingleImageContextMenu.vue";
import MultiImageContextMenu from "./MultiImageContextMenu.vue";

interface Props {
    visible: boolean;
    position: { x: number; y: number };
    image: ImageInfo | null;
    selectedCount?: number;
    selectedImageIds?: Set<string>;
    hide?: string[];
}

const props = withDefaults(defineProps<Props>(), {
    hide: () => [],
});

const selectedCount = computed(() => props.selectedCount || 1);
const isImageSelected = computed(() => {
    if (!props.image || !props.selectedImageIds || selectedCount.value === 1) {
        return true;
    }
    return props.selectedImageIds.has(props.image.id);
});

defineEmits<{
    close: [];
    command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
