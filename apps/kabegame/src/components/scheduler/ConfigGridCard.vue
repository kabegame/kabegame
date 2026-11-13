<template>
  <!-- 与插件卡片同一套外框（细线、圆角、悬停加深与阴影）；固定三行：标题+动作、定时、结果或描述 -->
  <article
    class="box-border flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-kb-lg border border-solid bg-kb-surface-raised px-3 pb-2.5 pt-3 outline-none transition-[border-color,box-shadow] duration-150 hover:shadow-kb-md focus-visible:ring-2 focus-visible:ring-kb-ring"
    :class="
      failed
        ? 'border-[color-mix(in_srgb,var(--kb-danger)_40%,transparent)] hover:border-[color-mix(in_srgb,var(--kb-danger)_65%,transparent)]'
        : 'border-kb-line hover:border-kb-line-strong'
    "
    role="button"
    tabindex="0"
    @click="$emit('click')"
    @keydown.enter.self="$emit('click')"
  >
    <div class="flex min-w-0 items-center gap-2.5">
      <div :class="{ 'opacity-55': paused }" class="flex min-w-0 flex-1 items-center gap-2.5">
        <slot name="icon" />
        <div class="flex min-w-0 flex-1 flex-col gap-px">
          <slot name="title" />
        </div>
      </div>
      <div class="flex-none" @click.stop><slot name="action" /></div>
    </div>
    <div class="flex min-w-0 items-center gap-2 text-xs tabular-nums">
      <slot name="schedule" />
    </div>
    <div
      class="flex min-h-[26px] min-w-0 items-center gap-1.75 border-0 border-t border-solid border-kb-line pt-2 text-xs tabular-nums"
    >
      <slot name="footer" />
    </div>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ failed?: boolean; paused?: boolean }>(), { failed: false, paused: false });
defineEmits<{ click: [] }>();
</script>
