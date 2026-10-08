<template>
  <!-- 与其他设置一致用方框分段切换；不套外层容器，否则会破坏 SettingRow 的右对齐 -->
  <KbSegmentedControl
    :model-value="localValue"
    :options="segmentOptions"
    :disabled="disabled || showDisabled"
    @update:model-value="onChange"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import KbSegmentedControl from "@/components/common/form/KbSegmentedControl.vue";
import { DEFAULT_GALLERY_PAGE_SIZE, GALLERY_PAGE_SIZE_OPTIONS, isGalleryPageSizeOption } from "@/utils/galleryPageSize";

const options = GALLERY_PAGE_SIZE_OPTIONS;

const { settingValue, set, disabled, showDisabled } = useSettingKeyState("galleryPageSize");
// KbSegmentedControl 以字符串比对选中项，这里统一用字符串，落库前再转回数字
const localValue = computed(() => String((settingValue.value as number | undefined) ?? DEFAULT_GALLERY_PAGE_SIZE));
const segmentOptions = computed(() => options.map((n) => ({ label: String(n), value: String(n) })));

const onChange = async (v: string) => {
  const n = Number(v);
  if (!isGalleryPageSizeOption(n)) return;
  await set(n, {
    source: location.pathname === "/settings" ? "settings_page" : "settings_dialog",
  });
};
</script>
