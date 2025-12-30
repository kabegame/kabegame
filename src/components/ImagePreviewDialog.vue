<template>
  <el-dialog v-model="visible" title="图片预览" width="90%" :close-on-click-modal="true" class="image-preview-dialog"
    @close="$emit('update:imageUrl', '')" :show-close="true" :lock-scroll="true">
    <div v-if="imageUrl" class="preview-container">
      <img :src="imageUrl" class="preview-image" alt="预览图片" @contextmenu.prevent.stop="$emit('contextmenu', $event)" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  modelValue: boolean;
  imageUrl: string;
  imagePath?: string; // 图片的本地路径
  image?: ImageInfo | null; // 图片信息
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'update:imageUrl', value: string): void;
  (e: 'contextmenu', event: MouseEvent): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});
</script>

<style lang="scss">
.image-preview-dialog.el-dialog {
  max-width: 90vw !important;
  max-height: 90vh !important;
  margin: 5vh auto !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 15px 20px !important;
    min-height: 50px !important;
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    padding: 0 !important;
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    overflow: hidden !important;
    min-height: 0 !important;
    max-height: calc(90vh - 50px) !important;
  }

  .preview-container {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
    overflow: hidden;
    box-sizing: border-box;
  }

  .preview-image {
    max-width: calc(90vw - 40px) !important;
    max-height: calc(90vh - 90px) !important;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }
}
</style>
