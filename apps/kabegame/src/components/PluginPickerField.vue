<template>
  <div class="plugin-picker-field">
    <AndroidPickerSelect
      v-if="isCompact"
      :model-value="modelValue ?? null"
      :options="androidOptions"
      :title="pickerTitleResolved"
      :placeholder="placeholder || $t('common.selectPlaceholder')"
      :clearable="clearable"
      :disabled="disabled"
      @update:model-value="emitValue"
    >
      <template #option="{ option }">
        <div class="plugin-picker-option">
          <template v-if="showIcons && (option.pluginId || option.iconSrc)">
            <img v-if="option.iconSrc" :src="option.iconSrc" class="plugin-picker-option__icon" alt="" />
            <el-icon v-else class="plugin-picker-option__icon-placeholder">
              <Grid />
            </el-icon>
          </template>
          <span class="plugin-picker-option__label">{{ option.label }}</span>
          <span v-if="option.count !== undefined" class="plugin-picker-option__count">({{ option.count }})</span>
          <el-icon
            v-if="option.warning"
            class="plugin-picker-option__warning"
            :title="$t('plugins.androidNotSupported')"
          >
            <WarningFilled />
          </el-icon>
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
      :size="size"
      :popper-class="popperClass"
      style="width: 100%"
      @update:model-value="emitValue"
    >
      <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value">
        <div class="plugin-picker-option">
          <template v-if="showIcons && option.pluginId">
            <img v-if="option.iconSrc" :src="option.iconSrc" class="plugin-picker-option__icon" alt="" />
            <el-icon v-else class="plugin-picker-option__icon-placeholder">
              <Grid />
            </el-icon>
          </template>
          <span class="plugin-picker-option__label">{{ option.label }}</span>
          <span v-if="option.count !== undefined" class="plugin-picker-option__count">({{ option.count }})</span>
          <el-icon
            v-if="option.warning"
            class="plugin-picker-option__warning"
            :title="$t('plugins.androidNotSupported')"
          >
            <WarningFilled />
          </el-icon>
        </div>
      </el-option>
    </el-select>

    <el-icon
      v-if="showSelectedJsWarning && selectedPluginIsJs"
      class="plugin-picker-field__selected-warning"
      :title="$t('plugins.jsPluginAndroidNotSupportedTitle')"
    >
      <WarningFilled />
    </el-icon>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Grid, WarningFilled } from "@element-plus/icons-vue";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";
import { useUiStore } from "@kabegame/core/stores/ui";
import { usePluginStore, type Plugin } from "@/stores/plugins";

type PluginPickerValueKey = "id" | "baseUrl";
type PluginPickerSize = "" | "default" | "small" | "large";

type PluginPickerOption = {
  value: string;
  label: string;
  pluginId?: string;
  iconSrc?: string;
  warning?: boolean;
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
    filterable?: boolean;
    showIcons?: boolean;
    showJsWarning?: boolean;
    showSelectedJsWarning?: boolean;
    size?: PluginPickerSize;
    popperClass?: string;
  }>(),
  {
    valueKey: "id",
    prependOptions: () => [],
    optionCounts: () => ({}),
    clearable: false,
    disabled: false,
    filterable: true,
    showIcons: true,
    showJsWarning: false,
    showSelectedJsWarning: false,
    size: "default",
    popperClass: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();

const isCompact = computed(() => uiStore.isCompact);
const pickerTitleResolved = computed(
  () => props.pickerTitle ?? props.placeholder ?? t("common.selectPlaceholder"),
);

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

const pluginRows = computed((): PluginPickerOption[] => {
  if (props.pluginIds) {
    return props.pluginIds.map((pluginId) => ({
      value: pluginId,
      label: pluginStore.pluginLabel(pluginId),
      pluginId,
      iconSrc: pluginStore.pluginIconDataUrl(pluginId),
      warning: props.showJsWarning && pluginStore.plugins.find((p) => p.id === pluginId)?.scriptType === "js",
      count: rowCount(pluginId),
      plugin: pluginStore.plugins.find((p) => p.id === pluginId),
    }));
  }

  const rows: PluginPickerOption[] = [];
  for (const plugin of props.plugins ?? pluginStore.plugins) {
    const value = valueForPlugin(plugin);
    if (!value) continue;
    rows.push({
      value,
      label: pluginLabel(plugin),
      pluginId: plugin.id,
      iconSrc: pluginStore.pluginIconDataUrl(plugin.id),
      warning: props.showJsWarning && plugin.scriptType === "js",
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

const androidOptions = computed(() =>
  options.value.map((option) => ({
    label: option.label,
    value: option.value,
    pluginId: option.pluginId,
    iconSrc: option.iconSrc,
    warning: option.warning,
    count: option.count,
  })),
);

const selectedPluginIsJs = computed(() => {
  const selected = options.value.find((option) => option.value === props.modelValue);
  const plugin = selected?.plugin ?? pluginStore.plugins.find((p) => p.id === selected?.pluginId);
  return plugin?.scriptType === "js";
});
</script>

<style scoped lang="scss">
.plugin-picker-field {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

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

.plugin-picker-option__warning,
.plugin-picker-field__selected-warning {
  flex-shrink: 0;
  color: var(--el-color-danger);
}

.plugin-picker-option__warning {
  margin-left: auto;
  font-size: 18px;
}

.plugin-picker-field__selected-warning {
  font-size: 20px;
}

:deep(.android-picker-select__list-item) .plugin-picker-option {
  width: 100%;
}
</style>
