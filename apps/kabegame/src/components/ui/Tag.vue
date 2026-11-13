<template>
  <span
    class="inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-kb-sm font-500 leading-none [&_svg]:shrink-0"
    :class="[
      TONES[tone],
      size === 'sm' ? 'h-5 px-1.5 text-[11.5px] [&_svg]:size-3' : 'h-6 px-2 text-[12px] [&_svg]:size-3.5',
    ]"
  >
    <slot name="icon" />
    <span class="truncate"><slot /></span>
    <button
      v-if="closable"
      type="button"
      class="-mr-0.5 grid size-4 cursor-pointer place-items-center rounded-[3px] border-0 bg-transparent p-0 text-current opacity-60 hover:bg-[rgba(0,0,0,0.06)] hover:opacity-100"
      :aria-label="t('common.delete')"
      @click.stop="emit('close')"
    >
      <X class="!size-3" />
    </button>
  </span>
</template>

<script setup lang="ts">
/**
 * 标签：中性（默认）/ 强调 / 成功 / 警告 / 危险五种色调，浅底同色字。closable 时右侧有 ×（发 close）。
 * 状态（任务成功 / 失败）、类型（插件来源）、计数这类短文字用它。
 */
import { X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

withDefaults(defineProps<{ tone?: Tone; size?: "sm" | "md"; closable?: boolean }>(), {
  tone: "neutral",
  size: "md",
});

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const TONES: Record<Tone, string> = {
  neutral: "bg-kb-fill text-kb-fg-muted",
  accent: "bg-[color-mix(in_srgb,var(--kb-accent)_12%,transparent)] text-kb-accent",
  success: "bg-[color-mix(in_srgb,var(--kb-success)_12%,transparent)] text-kb-success",
  warning:
    "bg-[color-mix(in_srgb,var(--kb-warning)_14%,transparent)] text-[color-mix(in_srgb,var(--kb-warning)_80%,black)]",
  danger: "bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)] text-kb-danger",
};
</script>
