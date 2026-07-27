import { defineStore } from "pinia";
import { ref } from "vue";
import { IS_ANDROID } from "@kabegame/core/env";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { fetchSurfImageCounts } from "@/utils/surfMediaCount";

export const useSurfImageCountsStore = defineStore("surfImageCounts", () => {
  const globalRoute = useGlobalPathRoute();
  const countsByHost = ref<Record<string, number>>({});

  const countOf = (host: string): number => countsByHost.value[host] ?? 0;

  const refreshAll = async (hosts: Iterable<string>): Promise<void> => {
    if (IS_ANDROID) return;
    const counts = await fetchSurfImageCounts(hosts, globalRoute.hide);
    countsByHost.value = counts;
  };

  const refreshSome = async (hosts: Iterable<string>): Promise<void> => {
    if (IS_ANDROID) return;
    const list = Array.from(hosts);
    if (list.length === 0) return;
    const counts = await fetchSurfImageCounts(list, globalRoute.hide);
    countsByHost.value = { ...countsByHost.value, ...counts };
  };

  // 记录被删时不需要单独的 forget：refreshAll 是覆盖式的，只保留传入的 hosts。

  return {
    countsByHost,
    countOf,
    refreshAll,
    refreshSome,
  };
});
