<template>
  <dl
    class="m-0 grid gap-x-6 gap-y-2.5 text-[13px]"
    :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, '--kb-dl-label-width': labelWidth }"
  >
    <template v-if="items">
      <DescriptionItem v-for="item in items" :key="item.label" :label="item.label" :span="item.span">
        <slot :name="item.slot ?? 'value'" :item="item">{{ item.value ?? "—" }}</slot>
      </DescriptionItem>
    </template>
    <slot v-else />
  </dl>
</template>

<script setup lang="ts">
/**
 * 键值列表（取代 el-descriptions）：标签在左（--kb-dl-label-width 宽、次要色）、值在右，可分多列。
 * items 给数据（值为空显示「—」，单项要自定义时给 slot 名并写同名插槽），
 * 或在默认插槽里直接放 <DescriptionItem label>。
 */
import DescriptionItem from "./DescriptionItem.vue";

withDefaults(
  defineProps<{
    items?: { label: string; value?: string | number | null; span?: number; slot?: string }[];
    columns?: number;
    labelWidth?: string;
  }>(),
  { columns: 1, labelWidth: "112px" },
);
</script>
