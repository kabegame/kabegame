<template>
  <Switch
    v-if="settingKey === 'paused' || settingKey === 'mediaIntegration' || settingKey === 'forceRender'"
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
  <!-- 帧率：能跟随时上面一个「跟随 WPE」开关，跟随期间滑条置灰；滑条 10～显示器最高刷新率，松手提交 -->
  <div
    v-else-if="settingKey === 'fps'"
    class="flex min-w-0 flex-col gap-2"
    :class="variant === 'panel' ? 'items-stretch' : 'items-end'"
  >
    <label
      v-if="followAvailable"
      class="flex items-center gap-2 text-[12px] text-kb-fg-muted"
      :class="disabled ? 'cursor-not-allowed' : 'cursor-pointer'"
      data-testid="wpe-fps-follow"
    >
      <Switch size="sm" :model-value="fpsFollowing" :disabled="disabled" @update:model-value="onFpsFollow" />
      <span>{{ t("settings.wpeFpsFollow") }}</span>
    </label>
    <WpeSettingSlider
      :model-value="fpsSliderValue"
      :min="WPE_FPS_MIN"
      :max="fpsMax"
      :step="1"
      :precision="0"
      :disabled="disabled || fpsFollowing"
      @commit="(v) => emit('update', 'fps', v)"
    />
  </div>
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
import { useDisplayMaxFps } from "@/composables/useDisplayMaxFps";
import {
  WPE_FPS_DEFAULT,
  WPE_FPS_MIN,
  WPE_SETTING_LABEL_KEYS,
  clampWpeFps,
  isWpeChoiceKey,
  wpeChoiceDisplay,
  wpeChoiceValues,
  wpeFpsDisplay,
  type WpeChoiceKey,
  type WpeSettingKey,
  type WpeSettingValues,
} from "@/utils/wpeSettings";
import WpeSettingSlider from "./WpeSettingSlider.vue";

/**
 * 字段组里的一个控件（`WpeSettingsFields.vue`）；选项值是 `follow` 但不能跟随时显示 Kabegame 默认值。
 * 帧率的 `follow` 同理：不能跟随时不给开关、滑条按 30 显示。
 */
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

/** 帧率滑条的上限：显示器最高刷新率（取不到时 60） */
const displayMaxFps = useDisplayMaxFps();
const fpsMax = computed(() => Math.max(WPE_FPS_MIN, Math.round(displayMaxFps.value)));
const fpsShown = computed(() => wpeFpsDisplay(props.values.fps, props.followAvailable, fpsMax.value));
const fpsFollowing = computed(() => fpsShown.value === "follow");
/** 跟随期间滑条停在默认值上（置灰；实际帧率由后端按 WPE 的设置算，前端不知道） */
const fpsSliderValue = computed(() =>
  typeof fpsShown.value === "number" ? fpsShown.value : clampWpeFps(WPE_FPS_DEFAULT, fpsMax.value),
);

/** 打开跟随写 `follow`；关掉写默认值 30（钳到上限） */
function onFpsFollow(follow: boolean) {
  if (follow === fpsFollowing.value) return;
  emit("update", "fps", follow ? "follow" : clampWpeFps(WPE_FPS_DEFAULT, fpsMax.value));
}
</script>
