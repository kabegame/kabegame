<template>
  <div
    class="flex flex-col overflow-y-auto py-3.5 px-3 [scrollbar-width:none] bg-[color-mix(in_srgb,white_35%,transparent)] border-r border-r-solid border-[var(--anime-border)]"
  >
    <div v-if="title || $slots.title || $slots.actions" class="flex items-center gap-1.5 pb-3 pl-2.5 pr-1">
      <div class="min-w-0 text-13px font-600 text-[var(--anime-text-muted)] break-all">
        <slot name="title">{{ title }}</slot>
      </div>
      <div class="flex-1" />
      <slot name="actions" />
    </div>

    <div
      v-for="(group, gi) in groups"
      :key="group.key ?? gi"
      class="flex flex-col gap-1"
      :class="gi > 0 && !group.title ? 'mt-3' : ''"
    >
      <div
        v-if="group.title"
        class="text-13px font-600 text-[var(--anime-text-muted)] px-2.5 pb-1.5"
        :class="gi > 0 ? 'pt-3' : ''"
      >
        {{ group.title }}<template v-if="group.count != null"> · {{ group.count }}</template>
      </div>
      <button
        v-for="item in group.items"
        :key="item.name"
        type="button"
        class="flex items-baseline gap-1.5 text-left border-none rounded-10px py-2 text-14px leading-[1.5] cursor-pointer transition-colors"
        :class="[
          /* 缩进项（如文档目录三级标题）只换左内边距；padding 二选一，避免与 px-2.5 争优先级 */
          item.indent ? 'pl-4.5 pr-2.5' : 'px-2.5',
          item.name === active
            ? 'bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] text-[var(--anime-text-primary)] font-600'
            : 'bg-transparent font-400 text-[var(--anime-text-primary)] hover:bg-[color-mix(in_srgb,var(--anime-primary)_6%,transparent)]',
        ]"
        @click="select(item)"
      >
        <span class="min-w-0" :class="item.mono ? 'font-mono break-all' : ''">{{ item.label }}</span>
        <span v-if="item.count != null" class="flex-none text-12px font-600 font-mono text-[var(--anime-text-muted)]">
          {{ item.count }}
        </span>
      </button>
    </div>

    <slot name="footer" />
  </div>
</template>

<script setup lang="ts" generic="T extends string">
export interface KbMenuItem<T extends string = string> {
  /** 唯一标识，也是 select / update:active 事件的载荷 */
  name: T;
  label: string;
  /** 尾部计数；null/undefined 表示不显示（区别于「数量为 0」） */
  count?: number | null;
  /** 半级缩进，表示从属于上一项（文档目录的三级及以下标题） */
  indent?: boolean;
  /** 等宽字体 + 长串换行（provider 名、文件名这类标识符） */
  mono?: boolean;
}

export interface KbMenuGroup<T extends string = string> {
  /** 列表 key；省略时用下标 */
  key?: string;
  /** 分组标题；省略则该组直接接在上一组后面（仅留间距） */
  title?: string;
  /** 分组标题后的「· N」计数 */
  count?: number | null;
  items: KbMenuItem<T>[];
}

defineProps<{
  groups: KbMenuGroup<T>[];
  /** 高亮项，完全由外部决定（组件不持有选中状态） */
  active?: T | null;
  /** 顶部标题文本；需要富文本时改用 #title 插槽 */
  title?: string;
}>();

const emit = defineEmits<{
  (e: "select", name: T): void;
  (e: "update:active", name: T): void;
}>();

function select(item: KbMenuItem<T>) {
  emit("select", item.name);
  emit("update:active", item.name);
}
</script>
