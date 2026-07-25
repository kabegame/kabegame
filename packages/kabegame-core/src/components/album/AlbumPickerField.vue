<template>
  <AndroidPickerSelect
    v-if="isCompact"
    :model-value="modelValue ?? null"
    :options="frosted ? frostedOptions : androidOptions"
    :title="pickerTitleResolved"
    :placeholder="placeholder || $t('common.selectPlaceholder')"
    :clearable="clearable"
    :disabled="disabled"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <template v-if="frosted" #option="{ option }">
      <div class="album-picker-field-option">
        <span class="album-picker-field-option-title">{{ option.label }}</span>
        <span v-if="option.desc" class="album-picker-field-option-desc">{{ option.desc }}</span>
      </div>
    </template>
  </AndroidPickerSelect>
  <el-tree-select
    v-else
    :model-value="modelValue ?? undefined"
    :data="treeData"
    :props="treeProps"
    check-strictly
    filterable
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
import { useUiStore } from "../../stores/ui";
import AndroidPickerSelect from "../AndroidPickerSelect.vue";
import type { AlbumTreeNode } from "../../types/album";
import { flattenAlbumTreeForAndroidPicker, flattenAlbumTreeForFrostedPicker } from "../../utils/albumTree";

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    albumTree: AlbumTreeNode[];
    albumCounts: Record<string, number>;
    allowCreate?: boolean;
    /** 插入在画册树根之前的选项（如「全部画廊」），value 可为空字符串 */
    prependOptions?: { value: string; label: string; desc?: string }[];
    placeholder?: string;
    /** 安卓底部选择器标题；默认用 placeholder */
    pickerTitle?: string;
    clearable?: boolean;
    disabled?: boolean;
    /** 安卓下改用居中磨玻璃列表（点选即生效），而非底部滚轮选择器 */
    frosted?: boolean;
  }>(),
  { allowCreate: false, clearable: true, prependOptions: () => [], disabled: false, frosted: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { t } = useI18n();
const isCompact = computed(() => useUiStore().isCompact);

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

const frostedOptions = computed(() => {
  const prepend = (props.prependOptions ?? []).map((o) => ({
    label: o.label,
    value: o.value,
    desc: o.desc,
  }));
  const flat = flattenAlbumTreeForFrostedPicker(props.albumTree ?? [], props.albumCounts).map((n) => ({
    label: n.label,
    value: n.value,
    desc: n.childCount > 0
      ? `${t("albums.albumCount", { count: n.count })} · ${t("albums.frostedPickerSubAlbumCount", { count: n.childCount })}`
      : t("albums.albumCount", { count: n.count }),
  }));
  if (props.allowCreate) {
    flat.push({ label: t("albums.createNewAlbum"), value: "__create_new__", desc: undefined });
  }
  return [...prepend, ...flat];
});
</script>

<style scoped>
.album-picker-field-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.album-picker-field-option-title {
  font-size: 15px;
  color: var(--anime-text-primary);
}

.album-picker-field-option-desc {
  font-size: 11.5px;
  color: var(--anime-text-muted);
}
</style>
