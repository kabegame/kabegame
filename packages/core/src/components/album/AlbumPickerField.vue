<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="modelValue ?? null"
    :options="androidOptions"
    :title="pickerTitleResolved"
    :placeholder="placeholder || $t('common.selectPlaceholder')"
    :clearable="clearable"
    :disabled="disabled"
    @update:model-value="(v) => emit('update:modelValue', v)"
  />
  <el-tree-select
    v-else
    :model-value="modelValue ?? undefined"
    :data="treeData"
    :props="treeProps"
    check-strictly
    :clearable="clearable"
    :disabled="disabled"
    :placeholder="placeholder || $t('common.selectPlaceholder')"
    style="width: 100%"
    @update:model-value="(v: string | null | undefined) => emit('update:modelValue', v ?? null)"
  >
    <template #default="{ data }">
      <span>{{ data.label }}<template v-if="data.count >= 0"> ({{ data.count }})</template></span>
    </template>
  </el-tree-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "../../env";
import AndroidPickerSelect from "../AndroidPickerSelect.vue";
import type { AlbumTreeNode } from "../../types/album";
import { flattenAlbumTreeForAndroidPicker } from "../../utils/albumTree";

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    albumTree: AlbumTreeNode[];
    albumCounts: Record<string, number>;
    allowCreate?: boolean;
    /** 插入在画册树根之前的选项（如「全部画廊」），value 可为空字符串 */
    prependOptions?: { value: string; label: string }[];
    placeholder?: string;
    /** 安卓底部选择器标题；默认用 placeholder */
    pickerTitle?: string;
    clearable?: boolean;
    disabled?: boolean;
  }>(),
  { allowCreate: false, clearable: true, prependOptions: () => [], disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { t } = useI18n();

const pickerTitleResolved = computed(
  () => props.pickerTitle ?? props.placeholder ?? t("common.selectPlaceholder"),
);

const treeProps = {
  value: "value",
  label: "label",
  children: "children",
};

type TreeRow = {
  value: string;
  label: string;
  count: number;
  children?: TreeRow[];
  isLeaf?: boolean;
};

function mapPrepend(o: { value: string; label: string }): TreeRow {
  return {
    value: o.value,
    label: o.label,
    count: -1,
    isLeaf: true,
  };
}

function mapNode(n: AlbumTreeNode): TreeRow {
  const children = (n.children ?? []).map(mapNode);
  return {
    value: n.id,
    label: n.name,
    count: props.albumCounts[n.id] ?? 0,
    ...(children.length ? { children } : { isLeaf: true }),
  };
}

const treeData = computed((): TreeRow[] => {
  const prepend = (props.prependOptions ?? []).map(mapPrepend);
  const roots = (props.albumTree ?? []).map(mapNode);
  const out = [...prepend, ...roots];
  if (props.allowCreate) {
    out.push({
      value: "__create_new__",
      label: t("albums.createNewAlbum"),
      count: 0,
      isLeaf: true,
    });
  }
  return out;
});

const androidOptions = computed(() => {
  const prepend = (props.prependOptions ?? []).map((o) => ({
    label: o.label,
    value: o.value,
  }));
  const flat = flattenAlbumTreeForAndroidPicker(props.albumTree ?? [], props.albumCounts);
  if (props.allowCreate) {
    flat.push({ label: t("albums.createNewAlbum"), value: "__create_new__" });
  }
  return [...prepend, ...flat];
});
</script>
