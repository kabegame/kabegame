<template>
  <ProgressRoot
    :model-value="value"
    :max="100"
    class="relative block w-full overflow-hidden rounded-full bg-kb-fill"
    :style="{ height: `${height}px` }"
  >
    <ProgressIndicator
      class="block h-full rounded-full transition-[width] duration-300 ease-[var(--kb-ease-out)]"
      :class="[TONES[tone], value == null ? 'w-[40%] animate-[kb-progress-flow_1.2s_ease-in-out_infinite]' : '']"
      :style="value == null ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }"
    />
  </ProgressRoot>
</template>

<script setup lang="ts">
/**
 * 进度条。value 为 null 时是不定进度（一段来回流动的条）。
 * accent：进行中；danger：失败；neutral：墨色（启动页这类没有强调语义的地方）；muted：浅灰（已取消、已停止）。
 */
import { ProgressIndicator, ProgressRoot } from "reka-ui";

type Tone = "accent" | "danger" | "neutral" | "muted";

withDefaults(defineProps<{ value: number | null; tone?: Tone; height?: number }>(), {
  tone: "accent",
  height: 4,
});

const TONES: Record<Tone, string> = {
  accent: "bg-kb-accent",
  danger: "bg-kb-danger",
  neutral: "bg-kb-primary",
  muted: "bg-kb-fg-subtle",
};
</script>
