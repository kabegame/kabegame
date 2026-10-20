<template>
  <!-- 与 PluginGridCard 同一套边框 / 圆角 / 悬停；固定三行：标题+动作、定时、结果或描述 -->
  <article
    class="flex min-w-0 cursor-pointer flex-col gap-2.25 rounded-[14px] border-2 border-solid bg-[var(--anime-bg-card)] px-3 pb-2.5 pt-3 transition-[box-shadow,border-color] duration-300 hover:shadow-[var(--anime-shadow-hover)]"
    :class="
      failed
        ? 'border-[color-mix(in_srgb,var(--el-color-danger)_55%,transparent)] hover:border-[var(--el-color-danger)]'
        : 'border-[var(--anime-border)] hover:border-[var(--anime-primary-light)]'
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
      class="flex min-h-[26px] min-w-0 items-center gap-1.75 border-0 border-t border-dashed border-[color-mix(in_srgb,var(--anime-primary)_16%,transparent)] pt-2 text-xs tabular-nums"
    >
      <slot name="footer" />
    </div>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ failed?: boolean; paused?: boolean }>(), { failed: false, paused: false });
defineEmits<{ click: [] }>();
</script>
