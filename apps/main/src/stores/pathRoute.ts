import { defineStore } from "pinia";
import { computed, reactive, toRefs } from "vue";
import router from "@/router";

type NavigateOptions = {
  push?: boolean;
};

type PathRouteStoreConfig<TState extends object> = {
  parse: (path: string) => TState;
  build: (state: TState) => string;
  defaultState: TState;
  routePath?: string;
  onStateChange?: (state: TState, path: string) => void;
};

function cloneState<TState extends object>(state: TState): TState {
  return { ...state };
}

function toPlainState<TState extends object>(state: TState): TState {
  return { ...(state as Record<string, unknown>) } as TState;
}

export function createPathRouteStore<TState extends object>(
  storeId: string,
  config: PathRouteStoreConfig<TState>
) {
  return defineStore(storeId, () => {
    const state = reactive(cloneState(config.defaultState)) as TState;

    const currentPath = computed(() => config.build(toPlainState(state)));

    const persist = () => {
      if (!config.onStateChange) return;
      config.onStateChange(toPlainState(state), currentPath.value);
    };

    const syncFromUrl = (path: string) => {
      const trimmed = (path || "").trim();
      if (!trimmed) {
        Object.assign(state, cloneState(config.defaultState));
      } else {
        Object.assign(state, config.parse(trimmed));
      }
      persist();
    };

    const navigate = async (
      update: Partial<TState>,
      options: NavigateOptions = {}
    ) => {
      Object.assign(state, update);
      persist();

      const nextPath = currentPath.value;
      const currentRoute = router.currentRoute.value;
      const shouldPush =
        options.push === true ||
        (!!config.routePath && currentRoute.path !== config.routePath);
      const targetRoutePath = shouldPush
        ? config.routePath || currentRoute.path
        : currentRoute.path;

      const target = {
        path: targetRoutePath,
        query: { ...currentRoute.query, path: nextPath },
      };

      if (shouldPush) {
        await router.push(target);
        return;
      }
      await router.replace(target);
    };

    const initialRaw = router.currentRoute.value.query.path;
    const initialPath = Array.isArray(initialRaw)
      ? String(initialRaw[0] ?? "")
      : String(initialRaw ?? "");
    if ((initialPath || "").trim()) {
      syncFromUrl(initialPath);
    }

    return {
      ...toRefs(state),
      currentPath,
      syncFromUrl,
      navigate,
    };
  });
}
