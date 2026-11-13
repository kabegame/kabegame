<template>
  <Dialog :open="modelValue" :title="title" :width="360" @update:open="(v: boolean) => emit('update:modelValue', v)">
    <div class="flex flex-col gap-2">
      <button
        v-for="opt in options"
        :key="opt.id"
        type="button"
        class="group box-border flex w-full cursor-pointer items-center gap-3 rounded-kb-lg border border-solid border-kb-line-strong bg-transparent px-3.5 py-3 text-left [font:inherit] text-kb-fg outline-none transition-[background-color,border-color] duration-150 hover:border-kb-fg-subtle hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring"
        @click="handleSelect(opt.id)"
      >
        <span
          class="grid size-9 shrink-0 place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-[18px]"
        >
          <component :is="opt.icon" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[13.5px] font-500 leading-5">{{ opt.title }}</span>
          <span v-if="opt.desc" class="mt-0.5 block text-[12px] leading-[1.45] text-kb-fg-muted">{{ opt.desc }}</span>
        </span>
      </button>
    </div>
    <Checkbox v-model="keepChecked" class="mt-4">
      {{ t("common.keepChoiceNextTime") }}
    </Checkbox>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Checkbox, Dialog } from "@/components/ui";
import type { OptionItem } from "./OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
  options: OptionItem[];
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", payload: { id: string; persist: boolean }): void;
}>();
const { t } = useI18n();
const keepChecked = ref(false);

// 每次打开都从「不记住」开始
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) keepChecked.value = false;
  },
  { immediate: true },
);

function handleSelect(id: string) {
  emit("select", { id, persist: keepChecked.value });
}
</script>
