<template>
  <Switch
    v-if="settingKey === 'paused' || settingKey === 'mediaIntegration'"
    :model-value="values[settingKey]"
    :disabled="disabled"
    @update:model-value="(v: boolean) => emit('update', settingKey, v)"
  />
  <WpeSettingSlider
    v-else-if="settingKey === 'volume' || settingKey === 'playbackRate'"
    :model-value="values[settingKey]"
    v-bind="settingKey === 'volume' ? VOLUME_RANGE : RATE_RANGE"
    :disabled="disabled"
    @commit="(v) => emit('update', settingKey, v)"
  />
  <template v-else-if="choiceKey">
    <!-- 设置页里项少的用分段器（同原来的单选）；阴影、体积光六档与预览侧栏（窄）用下拉，紧凑档用底部滚轮 -->
    <KbSegmentedControl
      v-if="variant === 'settings' && choiceKey !== 'shadows' && choiceKey !== 'volumetrics'"
      :model-value="current"
      :options="options"
      :disabled="disabled"
      @update:model-value="onChoice"
    />
    <AndroidPickerSelect
      v-else-if="uiStore.isCompact"
      :model-value="current"
      :options="options"
      :title="label"
      :placeholder="label"
      :disabled="disabled"
      @update:model-value="onChoice"
    />
    <Select
      v-else
      :model-value="current"
      :options="options"
      :placeholder="label"
      :class="variant === 'settings' ? '!w-[180px]' : 'w-full'"
      :disabled="disabled"
      @update:model-value="onChoice"
    />
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import Switch from "@/components/ui/Switch.vue";
import Select from "@/components/ui/Select.vue";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";
import KbSegmentedControl from "@/components/common/form/KbSegmentedControl.vue";
import { useUiStore } from "@/stores/ui";
import {
  WPE_SETTING_LABEL_KEYS,
  isWpeChoiceKey,
  wpeChoiceDisplay,
  wpeChoiceValues,
  type WpeChoiceKey,
  type WpeSettingKey,
  type WpeSettingValues,
} from "@/utils/wpeSettings";
import WpeSettingSlider from "./WpeSettingSlider.vue";

/** 字段组里的一个控件（`WpeSettingsFields.vue`）；选项值是 `follow` 但不能跟随时显示 Kabegame 默认值 */
const props = defineProps<{
  settingKey: WpeSettingKey;
  values: WpeSettingValues;
  followAvailable: boolean;
  variant: "settings" | "panel";
  disabled?: boolean;
}>();
const emit = defineEmits<{ update: [key: WpeSettingKey, value: boolean | number | string] }>();

const VOLUME_RANGE = { min: 0, max: 1, step: 0.1, precision: 1 };
const RATE_RANGE = { min: 0.25, max: 3, step: 0.25, precision: 2 };
/** 选项文案的词条：`<字段词条><Follow|Disabled|…>` */
const capitalize = (value: string) => `${value[0].toUpperCase()}${value.slice(1)}`;

const { t } = useI18n();
const uiStore = useUiStore();

const choiceKey = computed<WpeChoiceKey | null>(() => (isWpeChoiceKey(props.settingKey) ? props.settingKey : null));
const label = computed(() => t(WPE_SETTING_LABEL_KEYS[props.settingKey]));
const current = computed(() =>
  choiceKey.value ? wpeChoiceDisplay(choiceKey.value, props.values[choiceKey.value], props.followAvailable) : "",
);
const options = computed(() =>
  choiceKey.value
    ? wpeChoiceValues(choiceKey.value, props.followAvailable).map((value) => ({
        value,
        label: t(`${WPE_SETTING_LABEL_KEYS[choiceKey.value as WpeChoiceKey]}${capitalize(value)}`),
      }))
    : [],
);

function onChoice(value: string | undefined | null) {
  if (value && value !== current.value) emit("update", props.settingKey, value);
}
</script>
