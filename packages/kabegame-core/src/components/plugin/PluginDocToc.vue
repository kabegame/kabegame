<template>
  <KbResizable
    v-model="width"
    side="right"
    class="flex min-h-0"
    :default-size="defaultWidth"
    :handle-title="t('plugins.detail.toc')"
  >
    <KbMenuList
      class="flex-1 min-w-0"
      :groups="groups"
      :active="activeId ?? null"
      :title="t('plugins.detail.toc')"
      @select="emit('select', $event)"
    >
      <template #actions>
        <button
          type="button"
          :title="t('plugins.detail.tocCollapse')"
          :aria-label="t('plugins.detail.tocCollapse')"
          class="w-22px h-22px border-none rounded-8px bg-transparent text-[var(--anime-text-muted)] flex items-center justify-center cursor-pointer hover:bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] hover:text-[var(--anime-primary)]"
          @click="emit('collapse')"
        >
          <el-icon :size="14"><ArrowLeft /></el-icon>
        </button>
      </template>
    </KbMenuList>
  </KbResizable>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ArrowLeft } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import KbMenuList, { type KbMenuGroup } from "../common/KbMenuList.vue";
import KbResizable from "../common/KbResizable.vue";
import type { DocHeading } from "./PluginDocRenderer.vue";

const props = defineProps<{
  headings: DocHeading[];
  activeId?: string | null;
  /** 双击把手复位到的宽度；上下限由 kb-side-pane 的 CSS 变量给 */
  defaultWidth?: number;
}>();

/** 目录栏宽度（px），由宿主持久化 */
const width = defineModel<number>("width");

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "collapse"): void;
}>();

const { t } = useI18n();

// 设计稿：字重不随层级变化，仅二级以下用半缩进区分；只有高亮项加粗
const groups = computed<KbMenuGroup[]>(() => [
  {
    key: "headings",
    items: props.headings.map((h) => ({ name: h.id, label: h.text, indent: h.level > 2 })),
  },
]);
</script>
