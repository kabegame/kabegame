<template>
  <div class="gallery-page-size-setting">
    <el-radio-group
      :model-value="localValue"
      :disabled="disabled"
      :loading="showDisabled"
      @change="onChange"
    >
      <el-radio v-for="n in options" :key="n" :value="n">{{ n }}</el-radio>
    </el-radio-group>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const options = [100, 500, 1000] as const;

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("galleryPageSize");
const localValue = ref<number>(100);

watch(
  () => settingValue.value,
  (v) => {
    const n = Number(v ?? 100);
    localValue.value = options.includes(n as (typeof options)[number]) ? n : 100;
  },
  { immediate: true },
);

const onChange = async (v: string | number | boolean | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  await set(n);
};
</script>

<style scoped lang="scss">
.gallery-page-size-setting {
  width: 100%;
}
</style>
