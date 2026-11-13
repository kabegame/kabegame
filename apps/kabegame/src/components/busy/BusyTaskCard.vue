<template>
  <article
    class="box-border flex flex-col gap-2 rounded-kb-md border border-solid border-kb-line bg-kb-surface-raised px-3 py-2.5"
  >
    <div class="flex min-w-0 items-center gap-2">
      <span class="grid size-4 shrink-0 place-items-center text-kb-fg-muted [&_svg]:size-4">
        <slot name="icon"><component :is="icon" v-if="icon" /></slot>
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[13px] font-600 text-kb-fg">{{ title }}</span>
        <span v-if="subtitle" class="truncate text-[12px] text-kb-fg-muted">{{ subtitle }}</span>
      </div>
      <span v-if="meta" class="shrink-0 text-[12px] tabular-nums text-kb-fg-muted">{{ meta }}</span>
      <slot name="actions" />
      <Tooltip v-if="cancellable" :content="t('common.cancel')">
        <Button
          variant="ghost"
          size="icon-xs"
          class="-mr-1"
          :aria-label="t('common.cancel')"
          @click.stop="emit('cancel')"
        >
          <X />
        </Button>
      </Tooltip>
    </div>
    <Progress v-if="progress !== undefined" :value="progress" />
    <div v-if="$slots.default" class="flex min-w-0 items-center gap-2.5 text-[12px] tabular-nums text-kb-fg-muted">
      <slot />
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * 后台任务卡片的共用外壳（整理、清理隐藏、文件夹同步、元数据迁移、回填、下载更新）：
 * 图标 + 标题 / 副标题 + 右侧百分比 + 取消，下面一条进度，再下面一行明细（默认插槽）。
 * 各卡片只管取数；中性底色，进行中的进度用强调色。
 */
import type { Component } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Button, Progress, Tooltip } from "@/components/ui";

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    icon?: Component;
    /** 标题行右侧的短文字（百分比、等待中） */
    meta?: string;
    /** 0–100；null 为不定进度；不传不显示进度条 */
    progress?: number | null;
    cancellable?: boolean;
  }>(),
  { progress: undefined },
);
const emit = defineEmits<{ cancel: [] }>();
const { t } = useI18n();
</script>
