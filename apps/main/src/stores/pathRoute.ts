import { defineStore, storeToRefs } from "pinia";
import { computed, reactive, ref, toRefs, watch } from "vue";
import router from "@/router";

const HIDE_PREFIX = "hide/";
const GLOBAL_HIDE_KEY = "pathRoute.hide";
const LEGACY_GALLERY_HIDE_KEY = "kabegame-gallery-hide";

const readInitialHide = (): boolean => {
  const cur = localStorage.getItem(GLOBAL_HIDE_KEY);
  if (cur !== null) return cur !== "false";
  const legacy = localStorage.getItem(LEGACY_GALLERY_HIDE_KEY);
  if (legacy !== null) {
    const v = legacy !== "false";
    localStorage.setItem(GLOBAL_HIDE_KEY, String(v));
    return v;
  }
  return true;
};

export interface GlobalRouteState {
  hide: boolean;
}

/**
 * 全局路由参数 singleton：目前只有 `hide`。它是"路由参数"——序列化进 URL
 * 的 `hide/` 前缀——但值在所有 path-route store 之间共享。
 */
export const useGlobalPathRoute = defineStore("globalPathRoute", () => {
  const hide = ref<boolean>(readInitialHide());
  watch(hide, (v) => {
    console.log("[globalHide] updated →", v);
    localStorage.setItem(GLOBAL_HIDE_KEY, String(v));
  });
  return { hide };
});

type PathRouteStoreConfig<TState extends object> = {
  /** 解析业务部分：工厂会先剥掉 `hide/` 前缀再把剩余 path 交过来 */
  parse: (path: string) => TState;
  /** 构建业务部分：工厂会在外面自动套 `hide/`，不要自己套 */
  build: (state: TState) => string;
  defaultState: TState;
  /** 该 store 所属的 vue-router route.name。URL↔state 同步只在 cur.name === routeName 时发生。 */
  routeName?: string;
  onStateChange?: (state: TState & GlobalRouteState, path: string) => void;
  /**
   * 返回 true 时：build 不加 `hide/` 前缀；syncFromUrl 见到前缀也不回写 hide。
   * 用于让某些路由（HIDDEN 画册 / TaskDetail）不参与全局 hide。
   */
  ignoreHide?: (state: TState & GlobalRouteState) => boolean;
};

export function createPathRouteStore<TState extends object>(
  storeId: string,
  config: PathRouteStoreConfig<TState>
) {
  return defineStore(storeId, () => {
    const local = reactive({ ...config.defaultState }) as TState;
    const globalStore = useGlobalPathRoute();
    const { hide } = storeToRefs(globalStore);

    const isOwningRoute = (): boolean => {
      if (!config.routeName) return true;
      return router.currentRoute.value.name === config.routeName;
    };

    const merged = (): TState & GlobalRouteState =>
      ({ ...local, hide: hide.value } as TState & GlobalRouteState);

    const pathFor = (
      overrideLocal: Partial<TState>,
      overrideHide?: boolean
    ): string => {
      const ml = { ...local, ...overrideLocal } as TState;
      const h = overrideHide ?? hide.value;
      const full = { ...ml, hide: h } as TState & GlobalRouteState;
      const effHide = !config.ignoreHide?.(full) && h;
      const inner = config.build(ml);
      return effHide ? HIDE_PREFIX + inner : inner;
    };

    const currentPath = computed(() => pathFor({}));

    const syncFromUrl = (raw: string) => {
      const trimmed = (raw || "").trim();
      console.log(`[${storeId}] syncFromUrl ←`, JSON.stringify(trimmed));
      if (!trimmed) {
        Object.assign(local, { ...config.defaultState });
        return;
      }
      const hasHide = trimmed.startsWith(HIDE_PREFIX);
      const inner = hasHide ? trimmed.slice(HIDE_PREFIX.length) : trimmed;
      if (inner) {
        Object.assign(local, config.parse(inner));
      } else {
        Object.assign(local, { ...config.defaultState });
      }
      if (!config.ignoreHide?.(merged())) {
        hide.value = hasHide;
      }
    };

    // 初始 URL → state（仅当已在本 store 所属路由时）
    if (isOwningRoute()) {
      const raw = router.currentRoute.value.query.path;
      const s = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
      if (s.trim()) syncFromUrl(s);
    }

    // state → URL：state 变化时 replace，以及路由激活时修正 stale URL
    watch(
      [currentPath, () => router.currentRoute.value.name] as const,
      async ([path]) => {
        if (!isOwningRoute()) {
          console.log(`[${storeId}] state→URL skip (not owning route)`, path);
          return;
        }
        const cur = router.currentRoute.value;
        if (cur.query.path === path) return;
        console.log(`[${storeId}] state→URL replace`, path);
        await router.replace({ path: cur.path, query: { ...cur.query, path } });
        config.onStateChange?.(merged(), path);
      }
    );

    // URL → state：浏览器 back/forward、手输 URL、replace 后的回灌
    // prevName 跟踪：路由刚激活（name 发生变化切入本路由）时跳过 URL→state，
    // 改由 state→URL watcher 来纠正 stale URL，避免两个 watcher 竞争 hide。
    watch(
      () => [
        router.currentRoute.value.name,
        router.currentRoute.value.query.path,
      ] as const,
      ([name, raw], [prevName]) => {
        if (config.routeName && name !== config.routeName) return;
        const s = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
        if (!s.trim()) return;
        if (s === currentPath.value) return;
        if (prevName !== name) return; // 路由刚切入：让 state→URL 负责
        syncFromUrl(s);
      }
    );

    /** 批量 replace：一次性修改多个字段，由 state→URL watcher 统一触发 replace */
    const patch = (u: Partial<TState & GlobalRouteState>) => {
      console.log(`[${storeId}] patch`, u);
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          hide.value = v as boolean;
        } else if (k in config.defaultState) {
          (local as Record<string, unknown>)[k] = v;
        }
      }
    };

    /** 跨页跳转：不 mutate local，直接 replace URL，由 URL→state watcher 回灌 */
    const push = async (u: Partial<TState & GlobalRouteState>) => {
      const overrideLocal: Record<string, unknown> = {};
      let overrideHide: boolean | undefined;
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          overrideHide = v as boolean;
        } else if (k in config.defaultState) {
          overrideLocal[k] = v;
        }
      }
      const path = pathFor(overrideLocal as Partial<TState>, overrideHide);
      console.log(`[${storeId}] push → name:${config.routeName}`, path);
      if (config.routeName) {
        await router.replace({
          name: config.routeName,
          query: { path },
        });
      } else {
        const cur = router.currentRoute.value;
        await router.replace({
          path: cur.path,
          query: { ...cur.query, path },
        });
      }
    };

    return {
      ...toRefs(local),
      hide,
      currentPath,
      syncFromUrl,
      patch,
      push,
      /** 过渡期兼容旧 API；新代码建议直接 `store.field = v` / `patch` / `push` */
      navigate: (
        u: Partial<TState & GlobalRouteState>,
        o?: { push?: boolean }
      ) => (o?.push ? push(u) : Promise.resolve(patch(u))),
    };
  });
}
