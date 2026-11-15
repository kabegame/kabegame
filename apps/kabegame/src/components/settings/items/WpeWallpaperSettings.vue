<template>
  <WpeSettingsFields
    variant="settings"
    :fields="fields"
    :values="values"
    :follow-available="followAvailable"
    :disabled-keys="disabledKeys"
    @update="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import WpeSettingsFields from "@/components/wallpaper/WpeSettingsFields.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useWpeFollowAvailable } from "@/composables/useWpeFollowAvailable";
import {
  WPE_SETTING_DEFAULTS,
  WPE_SETTING_GLOBAL_KEYS,
  WPE_SETTING_KEYS,
  type WpeSettingKey,
  type WpeSettingValues,
} from "@/utils/wpeSettings";

/**
 * 设置页的「壁纸设置」：桌面（壁纸窗口）用的全局设置，所有壁纸共用，字段全部显示（当前壁纸用不上的照样显示，
 * 只是不起作用）。每个字段接一个全局设置键（`WPE_SETTING_GLOBAL_KEYS`）。`fields` 由设置页按平台给出。
 */
const props = defineProps<{ fields: readonly WpeSettingKey[] }>();

const states = Object.fromEntries(
  WPE_SETTING_KEYS.map((key) => [key, useSettingKeyState(WPE_SETTING_GLOBAL_KEYS[key])]),
) as Record<WpeSettingKey, ReturnType<typeof useSettingKeyState>>;
const followAvailable = useWpeFollowAvailable();

const values = computed<WpeSettingValues>(() => {
  const read = <K extends WpeSettingKey>(key: K): WpeSettingValues[K] => {
    const value = states[key].settingValue.value;
    return (
      typeof value === typeof WPE_SETTING_DEFAULTS[key] ? value : WPE_SETTING_DEFAULTS[key]
    ) as WpeSettingValues[K];
  };
  return {
    paused: read("paused"),
    volume: read("volume"),
    playbackRate: read("playbackRate"),
    mediaIntegration: read("mediaIntegration"),
    postprocess: read("postprocess"),
    reflection: read("reflection"),
    shadows: read("shadows"),
  };
});
/** 读取 / 保存中不可改（同原来的 Setting*Control） */
const disabledKeys = computed(() =>
  props.fields.filter((key) => states[key].disabled.value || states[key].showDisabled.value),
);

function onUpdate(key: WpeSettingKey, value: boolean | number | string) {
  void states[key].set(value as never);
}
</script>
