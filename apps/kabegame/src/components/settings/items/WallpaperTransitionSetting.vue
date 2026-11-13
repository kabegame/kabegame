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
  <!-- 选项行自带原生 title（长文案截断时悬停看全） -->
  <Select
    v-else
    :model-value="localValue"
    :options="options"
    :placeholder="t('settings.transitionPlaceholder')"
    class="!w-[200px]"
    :disabled="props.disabled || wallpaperModeSwitching || busy"
    @update:model-value="onSelect"
  />
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
import Select from "@/components/ui/Select.vue";

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

/** 桌面下拉：先把选中框挪过去（同原 el-select 的 v-model），失败由 handleChange 回滚 */
function onSelect(v: string | undefined) {
  if (!v || v === localValue.value) return;
  localValue.value = v;
  void handleChange(v);
}
</script>
