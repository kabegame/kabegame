<template>
  <div
    role="alert"
    class="box-border flex items-start gap-2.5 rounded-kb-md px-3 py-2.5 text-[13px] leading-[1.55]"
    :class="TONES[tone].box"
  >
    <component :is="ICONS[tone]" class="mt-[2px] size-4 shrink-0" :class="TONES[tone].icon" />
    <div class="min-w-0 flex-1">
      <div v-if="title" class="font-600 text-kb-fg">{{ title }}</div>
      <div v-if="description || $slots.default" class="text-kb-fg-muted" :class="title ? 'mt-0.5' : ''">
        <slot>{{ description }}</slot>
      </div>
    </div>
    <slot name="actions" />
  </div>
</template>

<script setup lang="ts">
/** 页内提示条（取代 el-alert）：信息 / 成功 / 警告 / 危险，浅底 + 同色图标，正文仍是中性色。 */
import { CircleCheck, CircleX, Info, TriangleAlert } from "@lucide/vue";

type Tone = "info" | "success" | "warning" | "danger";

withDefaults(defineProps<{ tone?: Tone; title?: string; description?: string }>(), { tone: "info" });

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleX } as const;
const TONES: Record<Tone, { box: string; icon: string }> = {
  info: { box: "bg-kb-fill-light", icon: "text-kb-fg-muted" },
  success: { box: "bg-[color-mix(in_srgb,var(--kb-success)_9%,white)]", icon: "text-kb-success" },
  warning: { box: "bg-[color-mix(in_srgb,var(--kb-warning)_11%,white)]", icon: "text-kb-warning" },
  danger: { box: "bg-[color-mix(in_srgb,var(--kb-danger)_8%,white)]", icon: "text-kb-danger" },
};
</script>
