<template>
  <div class="plugin-picker-field flex w-full min-w-0 flex-col gap-1.5">
    <div class="flex w-full min-w-0 items-center gap-2">
      <AndroidPickerSelect
        v-if="isCompact"
        :model-value="modelValue ?? null"
        :options="androidOptions"
        :title="pickerTitleResolved"
        :subtitle="$t('plugins.selectSourceSubtitle')"
        :primary-group-label="$t('plugins.recommendedSources')"
        :restricted-group-label="$t('plugins.webviewPlugins')"
        :restricted-group-note="$t('plugins.webviewMobileUnsupportedNote')"
        :placeholder="placeholder || $t('common.selectPlaceholder')"
        :clearable="clearable"
        :disabled="disabled"
        @update:model-value="emitValue"
      >
        <template v-if="selectTrigger" #trigger="{ open }">
          <slot name="compact-trigger" :open="open" :selected-label="selectedTriggerLabel" :disabled="disabled">
            <div
              class="w-full"
              role="button"
              :tabindex="disabled ? -1 : 0"
              :aria-disabled="disabled"
              :aria-label="selectedTriggerLabel || placeholder || $t('common.selectPlaceholder')"
              @click="open()"
              @keydown.enter.prevent="open()"
              @keydown.space.prevent="open()"
            >
              <!-- 复用桌面 el-select 展示当前值；实际选择交给 Android 弹窗，避免同时打开两个面板。 -->
              <el-select
                class="pointer-events-none w-full"
                :model-value="modelValue ?? undefined"
                :placeholder="placeholder || $t('common.selectPlaceholder')"
                :disabled="disabled"
                :size="size"
                :tabindex="-1"
                aria-hidden="true"
              >
                <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </div>
          </slot>
        </template>
        <template #option="{ option }">
          <div class="plugin-picker-option">
            <!-- 图标瓦片：优先真实图标，回退首字符 + 色相渐变 -->
            <div class="plugin-picker-option__tile" :style="tileStyle(option)">
              <img
                v-if="showIcons && option.iconSrc"
                :src="option.iconSrc"
                class="plugin-picker-option__tile-img"
                alt=""
              />
              <span v-else>{{ tileInitial(option.label) }}</span>
            </div>
            <div class="plugin-picker-option__main">
              <div class="plugin-picker-option__name">{{ option.label }}</div>
              <div v-if="option.desc" class="plugin-picker-option__desc">{{ option.desc }}</div>
              <div class="plugin-picker-option__tagrow">
                <PluginLabelTags v-if="option.labels?.length" :labels="option.labels" size="small" />
              </div>
            </div>
          </div>
        </template>
      </AndroidPickerSelect>

      <el-select
        v-else
        :model-value="modelValue ?? undefined"
        :placeholder="placeholder || $t('common.selectPlaceholder')"
        :clearable="clearable"
        :disabled="disabled"
        :filterable="filterable"
        :filter-method="filterable ? onFilter : undefined"
        :size="size"
        :popper-class="popperClass"
        style="width: 100%"
        @update:model-value="emitValue"
      >
        <el-option v-for="option in filteredOptions" :key="option.value" :label="option.label" :value="option.value">
          <!-- 悬浮时在整行右侧弹出插件快捷预览（与「源」页面同一张面板）；
               「全部」这类没有插件实体的行不弹 -->
          <HoverRevealPanel :disabled="!option.plugin">
            <div class="plugin-picker-option">
              <template v-if="showIcons && option.pluginId">
                <img v-if="option.iconSrc" :src="option.iconSrc" class="plugin-picker-option__icon" alt="" />
                <el-icon v-else class="plugin-picker-option__icon-placeholder">
                  <Grid />
                </el-icon>
              </template>
              <span class="plugin-picker-option__label">{{ option.label }}</span>
              <span v-if="option.count !== undefined" class="plugin-picker-option__count">({{ option.count }})</span>
              <!-- 尾部整体右对齐：让各行的标签落在同一条右边线上，便于纵向对比 -->
              <span class="plugin-picker-option__trailing">
                <PluginLabelTags v-if="showLabels" :labels="labelsFor(option.plugin)" size="small" fixed-slots />
              </span>
            </div>
            <template v-if="option.plugin" #panel>
              <PluginQuickPreviewPanel v-bind="quickPreviewProps(option.plugin)" :show-detail-hint="false" />
            </template>
          </HoverRevealPanel>
        </el-option>
      </el-select>
    </div>

    <PluginLabelTags v-if="showLabels && modelValue" :labels="labelsFor(selectedPluginObj)" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Grid } from "@kabegame/element-plus-icons";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";
import HoverRevealPanel from "@/components/common/HoverRevealPanel.vue";
import PluginLabelTags from "@/components/plugin/PluginLabelTags.vue";
import PluginQuickPreviewPanel, { type QuickPreviewPluginLike } from "@/components/plugin/PluginQuickPreviewPanel.vue";
import { bannerPreviewImages } from "@/utils/assetPath";
import { VERSION_INCOMPATIBLE_LABEL_ID, type PluginLabel } from "@/stores/pluginLabels";
import { useUiStore } from "@/stores/ui";
import { usePluginStore, type Plugin } from "@/stores/plugins";

type PluginPickerValueKey = "id" | "baseUrl";
type PluginPickerSize = "" | "default" | "small" | "large";

type PluginPickerOption = {
  value: string;
  label: string;
  pluginId?: string;
  iconSrc?: string;
  count?: number;
  plugin?: Plugin;
};

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    plugins?: Plugin[];
    pluginIds?: string[];
    valueKey?: PluginPickerValueKey;
    prependOptions?: { value: string; label: string; count?: number }[];
    optionCounts?: Record<string, number>;
    placeholder?: string;
    pickerTitle?: string;
    clearable?: boolean;
    disabled?: boolean;
    selectTrigger?: boolean;
    filterable?: boolean;
    showIcons?: boolean;
    showLabels?: boolean;
    size?: PluginPickerSize;
    popperClass?: string;
  }>(),
  {
    valueKey: "id",
    prependOptions: () => [],
    optionCounts: () => ({}),
    clearable: false,
    disabled: false,
    selectTrigger: false,
    filterable: true,
    showIcons: true,
    showLabels: false,
    size: "default",
    popperClass: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { t } = useI18n();
const { pluginName, pluginDescription } = usePluginManifestI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();

const isCompact = computed(() => uiStore.isCompact);
const pickerTitleResolved = computed(() => props.pickerTitle ?? props.placeholder ?? t("common.selectPlaceholder"));

function emitValue(value: string | null | undefined) {
  emit("update:modelValue", value ? String(value) : null);
}

function rowCount(value: string, explicit?: number) {
  if (explicit !== undefined) return explicit;
  const count = props.optionCounts[value];
  return count === undefined ? undefined : count;
}

function pluginLabel(plugin: Plugin) {
  return pluginName(plugin) || pluginStore.pluginLabel(plugin.id) || plugin.id;
}

function valueForPlugin(plugin: Plugin) {
  return props.valueKey === "baseUrl" ? plugin.baseUrl : plugin.id;
}

function labelsFor(p?: Plugin): PluginLabel[] {
  if (!p) return [];
  const base = p.labels ?? [];
  return p.minAppIncompatible ? [...base, { id: VERSION_INCOMPATIBLE_LABEL_ID }] : base;
}

/**
 * 快捷预览面板的 props。这里的插件一定是已安装的，示例图直接从内存里的 `assets` 读，
 * 不存在「未安装故读不到」的分支；标签口径与行尾标签保持一致（含版本不兼容这类派生标签）。
 */
function quickPreviewProps(plugin: Plugin) {
  return {
    plugin: { ...plugin, labels: labelsFor(plugin) } as QuickPreviewPluginLike,
    iconSrc: pluginStore.pluginIconSrc(plugin.id),
    images: bannerPreviewImages(plugin.assets),
  };
}

const pluginRows = computed((): PluginPickerOption[] => {
  if (props.pluginIds) {
    return (
      props.pluginIds
        .map((pluginId) => ({
          pluginId,
          plugin: pluginStore.plugins.find((p) => p.id === pluginId),
        }))
        // 过滤掉内建插件（如 local-import），选择器不应展示
        .filter(({ plugin }) => plugin?.scriptType !== "builtin")
        .map(({ pluginId, plugin }) => ({
          value: pluginId,
          label: pluginStore.pluginLabel(pluginId),
          pluginId,
          iconSrc: pluginStore.pluginIconSrc(pluginId),
          count: rowCount(pluginId),
          plugin,
        }))
    );
  }

  const rows: PluginPickerOption[] = [];
  // 过滤掉内建插件（如 local-import），选择器不应展示
  const source = (props.plugins ?? pluginStore.visiblePlugins).filter((plugin) => plugin.scriptType !== "builtin");
  for (const plugin of source) {
    const value = valueForPlugin(plugin);
    if (!value) continue;
    rows.push({
      value,
      label: pluginLabel(plugin),
      pluginId: plugin.id,
      iconSrc: pluginStore.pluginIconSrc(plugin.id),
      count: rowCount(value),
      plugin,
    });
  }
  return rows;
});

const options = computed((): PluginPickerOption[] => [
  ...props.prependOptions.map((option) => ({
    value: option.value,
    label: option.label,
    count: rowCount(option.value, option.count),
  })),
  ...pluginRows.value,
]);

const selectedTriggerLabel = computed(
  () => options.value.find((option) => option.value === props.modelValue)?.label ?? "",
);

// 桌面下拉的搜索：同时匹配显示名与插件 id（不区分大小写）。
// 传了 filter-method 后 el-select 不再按 label 自行隐藏选项，展开时会以空串回调重置。
const filterQuery = ref("");

function onFilter(query: string) {
  filterQuery.value = query;
}

const filteredOptions = computed((): PluginPickerOption[] => {
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) return options.value;
  return options.value.filter(
    (option) => option.label.toLowerCase().includes(q) || !!option.pluginId?.toLowerCase().includes(q),
  );
});

const androidOptions = computed(() =>
  options.value.map((option) => ({
    label: option.label,
    value: option.value,
    pluginId: option.pluginId,
    iconSrc: option.iconSrc,
    count: option.count,
    desc: option.plugin ? pluginDescription(option.plugin) : undefined,
    labels: option.plugin ? labelsFor(option.plugin) : undefined,
  })),
);

// 无真实图标时，用插件 id 派生稳定色相生成瓦片渐变（呼应设计的 oklch 辉光）。
function tileHue(option: { pluginId?: string; value: string }) {
  const seed = option.pluginId ?? option.value ?? "";
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function tileStyle(option: { pluginId?: string; value: string; iconSrc?: string }) {
  // 有真实图标时瓦片仅作底衬，无需辉光渐变
  if (props.showIcons && option.iconSrc) return {};
  const h = tileHue(option);
  return {
    background: `linear-gradient(140deg, oklch(0.77 0.12 ${h}), oklch(0.6 0.16 ${h}))`,
    boxShadow: `0 6px 16px oklch(0.7 0.16 ${h} / 0.5)`,
  };
}

function tileInitial(label: string) {
  return Array.from(label ?? "")[0] ?? "?";
}

const selectedPluginObj = computed<Plugin | undefined>(() => {
  const selected = options.value.find((option) => option.value === props.modelValue);
  return selected?.plugin ?? pluginStore.plugins.find((p) => p.id === selected?.pluginId);
});
</script>

<style scoped lang="scss">
.plugin-picker-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.plugin-picker-option__icon,
.plugin-picker-option__icon-placeholder {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.plugin-picker-option__icon {
  object-fit: contain;
  border-radius: 4px;
}

.plugin-picker-option__icon-placeholder {
  color: var(--anime-text-secondary);
}

.plugin-picker-option__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-picker-option__count {
  flex-shrink: 0;
  color: var(--anime-text-muted);
  font-size: 12px;
}

/* 右推尾部标签；flex-shrink:0 保证挤压时先省略插件名而不是压扁标签。 */
.plugin-picker-option__trailing {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* ============ 移动端居中弹窗行内容（方案 1c 图标 + 名称 + 描述 + 标签） ============ */
.plugin-picker-option:has(.plugin-picker-option__tile) {
  gap: 13px;
}

.plugin-picker-option__tile {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 50px;
  border-radius: 15px;
  overflow: hidden;
  color: #fff;
  font-size: 19px;
  font-weight: 800;
}

.plugin-picker-option__tile-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 受限（Webview）行的图标去饱和 */
.apk-row--disabled .plugin-picker-option__tile {
  filter: grayscale(0.35);
}

.plugin-picker-option__main {
  flex: 1;
  min-width: 0;
}

.plugin-picker-option__name {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--anime-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-picker-option__desc {
  margin-top: 2px;
  font-size: 12.5px;
  color: #8a6d8b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-picker-option__tagrow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;

  &:empty {
    display: none;
  }
}
</style>
