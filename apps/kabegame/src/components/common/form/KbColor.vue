<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="kb-control box-border inline-flex h-8 w-8 cursor-pointer items-center justify-center p-1"
        :aria-label="hex ?? undefined"
      >
        <span
          class="block size-full rounded-[5px] border border-solid border-kb-line"
          :style="{ background: hex ?? 'transparent' }"
        />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" :width="232">
      <ColorPickerPanel v-model="draft" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
/**
 * 颜色（`#rrggbb`）：色块按钮 + 取色气泡。与原来的 el-color-picker 一样只在确定后提交——这里是气泡关闭时，
 * 拖动中间不写值（壁纸属性每次写库都要改 metadata）。
 * P4 从 el-color-picker 换成新组件：它的气泡里有输入框，放进 Reka 的模态对话框（图片预览）里会被焦点陷阱抢走焦点。
 */
import { computed, ref, watch } from "vue";
import { ColorPickerPanel, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";

const props = defineProps<{ modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const hex = computed(() => (typeof props.modelValue === "string" ? props.modelValue : null));

const open = ref(false);
const draft = ref<string | null>(hex.value);
watch(open, (value) => {
  if (value) {
    draft.value = hex.value;
  } else if (draft.value && draft.value.toLowerCase() !== hex.value?.toLowerCase()) {
    emit("update:modelValue", draft.value);
  }
});
</script>
