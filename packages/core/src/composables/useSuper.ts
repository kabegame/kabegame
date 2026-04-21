import { computed, type ComputedRef } from "vue";
import { useRoute, useRouter } from "vue-router";
import { IS_WEB } from "../env";

// Why: web 模式下 super 以 URL `?super=1` 为唯一真源，不再写 localStorage；
// 非 web 平台 isSuper 恒为 true，setSuper 无副作用。
export function useSuper(): {
  isSuper: ComputedRef<boolean>;
  setSuper: (v: boolean) => Promise<void>;
} {
  const route = useRoute();
  const router = useRouter();

  const isSuper = computed<boolean>(() => {
    if (!IS_WEB) return true;
    return route.query.super === "1";
  });

  async function setSuper(v: boolean): Promise<void> {
    if (!IS_WEB) return;
    const q = { ...route.query };
    if (v) q.super = "1";
    else delete q.super;
    await router.replace({ query: q });
  }

  return { isSuper, setSuper };
}
