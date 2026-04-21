import { computed, type ComputedRef } from "vue";
import { useRoute } from "vue-router";
import { IS_WEB } from "../env";

// Why: web 模式下 super 以 URL `?super=1` 为唯一真源，不再写 localStorage；
// 非 web 平台 isSuper 恒为 true，setSuper 无副作用。
// setSuper 触发整页刷新（而非 router.replace），以清空所有运行时缓存
// （SSE 订阅、RPC 凭据、gallery store 等），避免权限切换后状态错乱。
export function useSuper(): {
  isSuper: ComputedRef<boolean>;
  setSuper: (v: boolean) => Promise<void>;
} {
  const route = useRoute();

  const isSuper = computed<boolean>(() => {
    if (!IS_WEB) return true;
    return route.query.super === "1";
  });

  async function setSuper(v: boolean): Promise<void> {
    if (!IS_WEB) return;
    const url = new URL(window.location.href);
    if (v) url.searchParams.set("super", "1");
    else url.searchParams.delete("super");
    // 整页刷新：与 `location = location` 等价，但保留新的 query 字符串
    window.location.href = url.toString();
  }

  return { isSuper, setSuper };
}
