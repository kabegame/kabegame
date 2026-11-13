<template>
  <!-- 全选与已选计数渲染在 Field 的标签行（见 PluginVarsForm），这里只负责选项本体。
       容器外观对齐 KbSegmentedControl（同底色 / 圆角 / 内距），区别是多选可换行、选项多时限高滚动 -->
  <div
    role="group"
    class="box-border flex w-fit max-w-full flex-wrap gap-0.5 overflow-y-auto rounded-kb-md bg-kb-fill p-0.5 max-h-[min(40vh,120px)]"
  >
    <button
      v-for="opt in normalizedOptions"
      :key="opt.value"
      type="button"
      role="checkbox"
      :aria-checked="valueForGroup.includes(opt.value)"
      :title="opt.label"
      class="box-border inline-flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded-[6px] border-0 py-0 pl-2 pr-3 text-[12.5px] [font-family:inherit] leading-none outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring"
      :class="
        valueForGroup.includes(opt.value)
          ? 'bg-kb-surface-raised font-600 text-kb-fg shadow-kb-sm'
          : 'bg-transparent font-500 text-kb-fg-muted hover:text-kb-fg'
      "
      @click="toggleOne(opt.value)"
    >
      <!-- 固定宽度勾选槽：选中 / 未选中切换时按钮不跳宽 -->
      <span class="inline-flex size-3.5 items-center justify-center">
        <Check v-if="valueForGroup.includes(opt.value)" class="size-3.5 text-kb-accent" :stroke-width="2.5" />
      </span>
      {{ opt.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Check } from "@lucide/vue";

type VarOption = string | { name: string | Record<string, string>; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    allowUnset?: boolean;
  }>(),
  { allowUnset: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

function optionLabel(o: VarOption): string {
  if (typeof o === "string") return o;
  if (typeof o.name === "string") return o.name;
  if (o.name && typeof o.name === "object") return (o.name as Record<string, string>).default ?? "";
  return "";
}

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      return { label: optionLabel(o), value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "");
});

const valueForGroup = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`) : [];
});

function toggleOne(value: string) {
  const sel = valueForGroup.value;
  const next = sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value];
  emit("update:modelValue", next);
}
</script>
