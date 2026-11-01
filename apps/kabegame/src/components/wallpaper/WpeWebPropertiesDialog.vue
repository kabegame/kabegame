<template>
  <el-dialog v-model="visible" :title="title || t('gallery.wpePropsTitle')" width="min(620px, 94vw)" append-to-body>
    <!-- 限高后由面板内容区滚动（Slideshow 这类壁纸有上百项） -->
    <WpeWebPropertiesPanel
      v-if="imageId"
      class="max-h-[70vh]"
      :image-id="imageId"
      :image-type="imageType"
      :collapsible="false"
      :fill-when-expanded="false"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import WpeWebPropertiesPanel from "./WpeWebPropertiesPanel.vue";

/** `title` 传壁纸显示名；缺省时用「壁纸属性」。`imageType` 传图片 `type`，场景壁纸据此隐藏用不到的属性 */
const props = defineProps<{
  modelValue: boolean;
  imageId: string | null | undefined;
  imageType?: string | null;
  title?: string | null;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const { t } = useI18n();
const visible = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
useModalBack(visible);
</script>
