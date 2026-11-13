<template>
  <div class="flex min-w-0 items-center gap-2">
    <slot name="prefix" />
    <span v-if="showLabel" class="flex-none text-[13px] font-500 text-kb-fg">
      {{ label ?? t("gallery.advancedPath") }}
    </span>
    <HelpTip :content="t('gallery.pathqlHelp')" />
    <!-- 复制图标附在框内右侧（与设置里 MCP 代码块同一个组件） -->
    <CodeBlock :code="path" single-line class="min-w-0 flex-1" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { HelpTip } from "@/components/ui";
import CodeBlock from "@/components/common/CodeBlock.vue";

defineProps<{
  path: string;
  /** 左侧「路径」标签;工具栏窄行可以关掉。 */
  showLabel?: boolean;
  label?: string;
}>();

const { t } = useI18n();
</script>
