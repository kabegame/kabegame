<template>
  <div class="mt-1 flex items-center gap-2.5 text-[12px] tabular-nums text-kb-fg-muted">
    <!-- 空跑复用去重计数表示「跳过」，其余计数恒为 0，只显示这一个 -->
    <span
      v-if="dryRun"
      :class="[ITEM, 'text-kb-fg-subtle', { 'opacity-40': dedup === 0 }]"
      :title="t('tasks.dryRunSkippedCount', { n: dedup })"
    >
      <ChevronsRight />
      <span>{{ dedup }}</span>
    </span>
    <template v-else>
      <span
        :class="[ITEM, 'text-kb-success', { 'opacity-40': success === 0 }]"
        :title="t('tasks.totalCount', { n: success })"
      >
        <CircleCheck />
        <span>{{ success }}</span>
      </span>
      <span
        :class="[ITEM, 'text-kb-danger', { 'opacity-40': failed === 0 }]"
        :title="t('tasks.failedCount', { n: failed })"
      >
        <CircleAlert />
        <span>{{ failed }}</span>
      </span>
      <span
        :class="[ITEM, 'text-kb-fg-muted', { 'opacity-40': deleted === 0 }]"
        :title="t('tasks.deletedCount', { n: deleted })"
      >
        <Trash2 />
        <span>{{ deleted }}</span>
      </span>
      <span
        :class="[ITEM, 'text-kb-fg-subtle', { 'opacity-40': dedup === 0 }]"
        :title="t('tasks.dedupCount', { n: dedup })"
      >
        <Copy />
        <span>{{ dedup }}</span>
      </span>
    </template>
    <span v-if="duration" class="whitespace-nowrap text-[11px] text-kb-fg-subtle">{{ duration }}</span>
  </div>
</template>

<script setup lang="ts">
/** 任务的四项计数（成功 / 失败 / 已删除 / 去重）+ 可选耗时：任务详情页副标题与任务抽屉条目共用。 */
import { ChevronsRight, CircleAlert, CircleCheck, Copy, Trash2 } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";

defineProps<{
  success: number;
  failed: number;
  deleted: number;
  dedup: number;
  duration?: string;
  dryRun?: boolean;
}>();

const { t } = useI18n();

const ITEM = "inline-flex shrink-0 items-center gap-1 transition-opacity duration-150 [&_svg]:size-3.5";
</script>
