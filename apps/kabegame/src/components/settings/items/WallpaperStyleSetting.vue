<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="localValue"
    :options="pickerOptions"
    :title="t('settings.styleTitle')"
    :placeholder="t('settings.stylePlaceholder')"
    :disabled="props.disabled || busy || wallpaperModeSwitching"
    @update:model-value="onPickerChange"
  />
  <el-select
    v-else
    v-model="localValue"
    :placeholder="t('settings.stylePlaceholder')"
    style="min-width: 180px"
    :disabled="props.disabled || busy || wallpaperModeSwitching"
    @change="handleChange"
  >
    <el-option
      v-for="opt in options"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
      :title="opt.desc || opt.label"
    >
      <span>{{ opt.desc }}</span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "@/env";
import { useUiStore } from "@/stores/ui";
import { useWallpaperTarget } from "@/composables/useWallpaperTarget";
import { logger } from "@/utils/logger";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
  /** 壁纸目标 id；缺省为默认目标 */
  targetId?: string | null;
}>();

const { t, locale } = useI18n();

// 样式挂在壁纸目标上（按壁纸模式存）：值读目标的有效样式，选项取当前「壁纸模式 × 显示器模式」的能力
const target = useWallpaperTarget(toRef(props, "targetId"));
const { wallpaperModeSwitching } = useUiStore();

/**
 * 保存中状态由本组件自己持有（目标配置没有 setter，不经设置 store 的保存状态机）：
 * 新值随 setting-change 落地或命令返回即结束，先到者为准——命令还要把当前壁纸重新输出一次，不必等它。
 */
const saving = ref(false);
const busy = computed(() => target.loading.value || saving.value);

const options = computed(() =>
  (target.combo.value?.styles ?? []).map((opt) => ({
    value: opt.value,
    label: resolveManifestText(opt.label, locale.value),
    desc: resolveManifestText(opt.desc, locale.value),
  })),
);

const pickerOptions = computed(() => options.value.map((o) => ({ label: o.label, value: o.value })));

const localValue = ref<string>("fill");
watch(
  target.style,
  (v) => {
    localValue.value = v || "fill";
    saving.value = false;
  },
  { immediate: true },
);

const handleChange = async (style: string) => {
  if (saving.value) return;
  saving.value = true;
  try {
    // 不乐观写：成功后由后端的 setting-change 落到目标配置
    await target.setStyle(style);
  } catch (error) {
    logger.warn("设置壁纸样式失败:", error);
    localValue.value = target.style.value || "fill";
  } finally {
    saving.value = false;
  }
};

const onPickerChange = async (v: string | null) => {
  await handleChange(v ?? "fill");
};
</script>
