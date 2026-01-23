import { computed, watch } from "vue";
import { AppSettingKey, AppSettings, useSettingsStore } from "../stores/settings";
import { useLoadingDelay } from "./useLoadingDelay";

/**
 * 封装设置键的状态管理
 *
 * 状态机：初始状态 -> loading -> down -> saving -> down
 * - loading: 正在从后端加载设置值
 * - down: 空闲状态，可以响应用户操作
 * - saving: 正在保存设置值到后端
 *
 * 使用延迟显示（300ms）来避免短暂的状态闪烁
 *
 * @param key - 设置键名
 * @returns 状态管理相关的响应式引用和方法
 */
export function useSettingKeyState<K extends AppSettingKey>(key: K) {
  const settingsStore = useSettingsStore();

  // 原始状态
  const isLoading = computed(() => settingsStore.isLoading(key));
  const isSaving = computed(() => settingsStore.isSaving(key));
  const isDown = computed(() => settingsStore.isDown(key));

  // 延迟显示的状态（300ms）
  const { showLoading: showLoadingState, startLoading: startLoadingDelay, finishLoading: finishLoadingDelay } = useLoadingDelay(300);
  const { showLoading: showSavingState, startLoading: startSavingDelay, finishLoading: finishSavingDelay } = useLoadingDelay(300);

  // watch isLoading/isSaving 驱动延迟状态
  watch(isLoading, (v) => v ? startLoadingDelay() : finishLoadingDelay(), { immediate: true });
  watch(isSaving, (v) => v ? startSavingDelay() : finishSavingDelay(), { immediate: true });

  // 设置值（响应式引用）
  const settingValue = computed({
    get: () => settingsStore.values[key] as AppSettings[K] | undefined,
    set: (value: AppSettings[K]) => {
      // 直接更新 store 中的值（set 函数会处理保存逻辑）
      (settingsStore.values as any)[key] = value;
    },
  });

  // 是否禁用（用于 UI）
  const disabled = computed(() => !isDown.value);
  const showDisabled = computed(() => showLoadingState.value || showSavingState.value);

  /**
   * 设置值并保存到后端
   *
   * @param value - 要设置的值
   * @param onAfterSave - 保存成功后的可选回调，回调完成后才将状态转换为 down
   * @throws 如果保存失败会抛出错误，并自动回滚本地值
   */
  const set = async (
    value: AppSettings[K],
    onAfterSave?: () => Promise<void> | void
  ) => {
    // 如果不在 down 状态，不响应用户操作
    if (!isDown.value) {
      return;
    }

    await settingsStore.save(key, value, onAfterSave);
  };

  return {
    // 状态
    isLoading,
    isSaving,
    isDown,
    showLoading: showLoadingState,
    showSaving: showSavingState,
    disabled,
    showDisabled,

    // 值
    settingValue,

    // 方法
    set,
  };
}
