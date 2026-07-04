import { ref, onUnmounted } from "vue";

/**
 * 用于延迟加载态显示的组合式函数，防止加载过快时的闪烁出现的loading骨架
 * 当加载完成时，会立即显示内容，无需等待
 *
 * 使用方式：
 * - `loading`: 实际的加载状态
 * - `showLoading`: 用于 v-loading 指令（仅在超过 delayMs 后才为 true）
 * - `startLoading()`: 开始加载时调用
 * - `finishLoading()`: 加载完成时调用
 *
 * 示例：
 * ```vue
 * <div v-loading="showLoading">
 *   <Content v-if="!loading" />
 * </div>
 * ```
 */
export function useLoadingDelay(delayMs: number = 300) {
  // 实际的加载状态
  const loading = ref(false);
  // 是否显示 loading UI（延迟后才设为 true）
  const showLoading = ref(false);
  // 定时器句柄
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 开始加载
   * - 立即将 loading 设为 true
   * - 延迟 delayMs 后才显示 loading UI
   */
  const startLoading = () => {
    // 清理之前的定时器
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    loading.value = true;
    showLoading.value = false;

    // 延迟后才显示 loading UI
    timer = setTimeout(() => {
      if (loading.value) {
        showLoading.value = true;
      }
    }, delayMs);
  };

  /**
   * 完成加载
   * - 立即隐藏 loading UI 并显示内容
   */
  const finishLoading = () => {
    // 清理定时器
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    loading.value = false;
    showLoading.value = false;
  };

  // 组件卸载时清理定时器
  onUnmounted(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });

  return {
    /** 实际的加载状态 */
    loading,
    /** 用于 v-loading 指令，仅在超过 delayMs 后才为 true */
    showLoading,
    /** 开始加载时调用 */
    startLoading,
    /** 加载完成时调用 */
    finishLoading,
  };
}
