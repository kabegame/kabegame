<template>
  <SwitchRoot
    v-model="model"
    :disabled="disabled"
    :class="[
      'relative box-border inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 p-0.5 outline-none transition-colors duration-150',
      'bg-kb-fill-dark data-[state=checked]:bg-kb-primary focus-visible:ring-2 focus-visible:ring-kb-ring',
      'disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'h-4.5 w-8' : 'h-5 w-9',
    ]"
  >
    <SwitchThumb
      :class="[
        'pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgba(16,14,20,0.2)] transition-transform duration-150 ease-[var(--kb-ease-out)]',
        size === 'sm' ? 'size-3.5 data-[state=checked]:translate-x-3.5' : 'size-4 data-[state=checked]:translate-x-4',
      ]"
    />
  </SwitchRoot>
</template>

<script setup lang="ts">
/** 开关：开是墨色（--kb-primary），与 EP 换皮后的 el-switch 一致。 */
import { SwitchRoot, SwitchThumb } from "reka-ui";

withDefaults(defineProps<{ disabled?: boolean; size?: "sm" | "md" }>(), { size: "md" });
const model = defineModel<boolean>({ default: false });
</script>
