<template>
  <Dialog v-model:open="visible" :title="title || t('gallery.wpePropsTitle')" :width="620">
    <!-- 限高后由面板内容区滚动（Slideshow 这类壁纸有上百项） -->
    <WpeWebPropertiesPanel
      v-if="imageId"
      class="max-h-[70vh]"
      :image-id="imageId"
      :image-type="imageType"
      :collapsible="false"
      :fill-when-expanded="false"
    />
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Dialog } from "@/components/ui";
import WpeWebPropertiesPanel from "./WpeWebPropertiesPanel.vue";

/**
 * 设置页「当前壁纸」的属性弹窗，只有作者属性。`title` 传壁纸显示名；缺省时用「壁纸属性」。`imageType` 传图片 `type`，
 * 场景壁纸据此隐藏用不到的属性。桌面的暂停是设置页里单独的一项（视频、网页、场景共用）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    imageId: string | null | undefined;
    imageType?: string | null;
    title?: string | null;
  }>(),
  { imageType: undefined, title: undefined },
);
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const { t } = useI18n();
const visible = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
</script>
