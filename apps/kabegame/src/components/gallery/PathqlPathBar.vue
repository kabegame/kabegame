<template>
  <div class="flex min-w-0 items-center gap-2">
    <slot name="prefix" />
    <span
      v-if="showLabel"
      class="flex-none text-sm font-medium text-[var(--anime-secondary)]"
    >
      {{ label ?? t("gallery.advancedPath") }}
    </span>
    <el-tooltip :content="t('gallery.pathqlHelp')" placement="top">
      <el-icon class="flex-none cursor-help text-base text-[var(--anime-text-muted)] hover:text-[var(--anime-secondary)]">
        <QuestionFilled />
      </el-icon>
    </el-tooltip>
    <!-- 复制图标附在框内右侧（与设置里 MCP 代码块同一个组件） -->
    <CodeBlock :code="path" single-line class="min-w-0 flex-1" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { ElIcon, ElTooltip } from "@kabegame/element-plus";
import { QuestionFilled } from "@kabegame/element-plus-icons";
import CodeBlock from "@/components/common/CodeBlock.vue";

defineProps<{
  path: string;
  /** 左侧「路径」标签;工具栏窄行可以关掉。 */
  showLabel?: boolean;
  label?: string;
}>();

const { t } = useI18n();
</script>
