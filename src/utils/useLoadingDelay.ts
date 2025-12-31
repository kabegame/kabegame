import { ref, onBeforeUnmount } from "vue";

/**
 * 用于延迟显示内容的组合式函数，防止加载过快时的闪屏
 * @param delayMs 延迟时间（毫秒），默认 300ms
 * @returns { loading, showContent, startLoading, finishLoading }
 */
export function useLoadingDelay(delayMs: number = 300) {
  const loading = ref(true);
  const showContent = ref(false);
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let startTime: number = Date.now();

  /**
   * 开始加载
   */
  const startLoading = () => {
    loading.value = true;
    showContent.value = false;
    startTime = Date.now();
    
    // 清除之前的定时器
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
  };

  /**
   * 完成加载
   */
  const finishLoading = () => {
    loading.value = false;
    
    // 清除之前的定时器
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }

    // 计算从开始加载到现在的实际耗时
    const actualElapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, delayMs - actualElapsed);

    // 如果已经超过延迟时间，立即显示内容
    if (remainingDelay <= 0) {
      showContent.value = true;
      return;
    }

    // 否则等待剩余时间后显示内容
    loadingTimer = setTimeout(() => {
      showContent.value = true;
      loadingTimer = null;
    }, remainingDelay);
  };

  // 组件卸载时清理定时器
  onBeforeUnmount(() => {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
  });

  return {
    /** 是否正在加载（用于显示 loading 状态） */
    loading,
    /** 是否显示内容（用于控制内容显示，有 300ms 防闪屏延迟） */
    showContent,
    /** 开始加载 */
    startLoading,
    /** 完成加载 */
    finishLoading,
  };
}
