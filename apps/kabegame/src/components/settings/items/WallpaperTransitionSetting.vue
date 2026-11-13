<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="localValue"
    :options="options"
    :title="t('settings.transitionTitle')"
    :placeholder="t('settings.transitionPlaceholder')"
    :disabled="props.disabled || wallpaperModeSwitching || busy"
    @update:model-value="(v) => handleChange(v ?? 'none')"
  />
  <el-select
    v-else
    v-model="localValue"
    :placeholder="t('settings.transitionPlaceholder')"
    style="min-width: 180px"
    :disabled="props.disabled || wallpaperModeSwitching || busy"
    @change="handleChange"
  >
    <!-- 下拉宽度已统一为输入框宽度，长文案会被 ellipsis 截断；补原生 title 让鼠标能看全 -->
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" :title="opt.label" />
  </el-select>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";
import { IS_ANDROID } from "@/env";
import { useWallpaperTarget } from "@/composables/useWallpaperTarget";
import { logger } from "@/utils/logger";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
  /** 壁纸目标 id；缺省为默认目标 */
  targetId?: string | null;
}>();

const { t, locale } = useI18n();

// 过渡挂在壁纸目标上（按壁纸模式存）：值读目标的有效过渡（存的值不在选项里时按能力取第一项，
// 归一化只在读取时做、不写回），选项取当前「壁纸模式 × 显示器模式」的能力
const target = useWallpaperTarget(toRef(props, "targetId"));
const { wallpaperModeSwitching } = useUiStore();
const settingsStore = useSettingsStore();

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

/**
 * 保存中状态由本组件自己持有（目标配置没有 setter，不经设置 store 的保存状态机）：
 * 新值随 setting-change 落地或命令返回即结束，先到者为准——轮播开着时命令还要切一张演示过渡，不必等它。
 */
const saving = ref(false);
const busy = computed(() => target.loading.value || saving.value);

const options = computed(() =>
  (target.combo.value?.transitions ?? []).map((opt) => ({
    value: opt.value,
    label: resolveManifestText(opt.label, locale.value),
  })),
);

const localValue = ref<string>("none");
watch(
  target.transition,
  (v) => {
    localValue.value = v || "none";
    saving.value = false;
  },
  { immediate: true },
);

const handleChange = async (transition: string) => {
  if (saving.value) return;
  if (!rotationEnabled.value) {
    kameMessage.info(t("settings.transitionRotationRequired"));
  }
  saving.value = true;
  try {
    // 不乐观写：成功后由后端的 setting-change 落到目标配置
    await target.setTransition(transition);
  } catch (error) {
    logger.warn("设置壁纸过渡失败:", error);
    localValue.value = target.transition.value || "none";
  } finally {
    saving.value = false;
  }
};
</script>
