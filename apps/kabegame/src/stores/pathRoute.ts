import { defineStore, storeToRefs } from "pinia";
import { computed, reactive, toRefs, watch } from "vue";
import { useLocalStorage } from "@vueuse/core";
import router from "@/router";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import type { AppSettingKey } from "@kabegame/core/stores/settings";

const HIDE_PREFIX = "hide/";
const GLOBAL_HIDE_KEY = "pathRoute.hide";

export interface GlobalRouteState {
  hide: boolean;
}

/**
 * 全局路由参数 singleton：目前只有 `hide`。它是"路由参数"——序列化进 URL
 * 的 `hide/` 前缀——但值在所有 path-route store 之间共享。
 * 持久化通过 `useLocalStorage` 自动完成。
 */
export const useGlobalPathRoute = defineStore("globalPathRoute", () => {
  const hide = useLocalStorage<boolean>(GLOBAL_HIDE_KEY, true);
  return { hide };
});

type PathRouteStoreConfig<TState extends object> = {
  /**
   * 用于镜像 `?path=` 的 settings query key。
   *
   * @example
   * ```ts
   * createPathRouteStore("galleryRoute", { settingKey: "gallery-path", ... })
   * ```
   */
  settingKey: Extract<AppSettingKey, "gallery-path" | "task-detail-path" | "surf-images-path" | "album-detail-path">;
  /** 解析业务部分：工厂会先剥掉 `hide/` 前缀再把剩余 path 交过来 */
  parse: (path: string) => TState;
  /** 构建业务部分：工厂会在外面自动套 `hide/`，不要自己套 */
  build: (state: TState) => string;
  /**
   * 可选：构建"上下文前缀"——是 `build` 的 **严格前缀**，代表任何属于本 store 路由
   * 语义下的子路径都会共享的那部分（例如 gallery 的 `search/display-name/<q>/`）。
   * 工厂会自动在外面拼 `hide/`。
   *
   * 用途：调用侧想列出某个 filter 根下的选项（`plugin/` / `media-type/` / `date/`），
   * 同时让 hide + search 等"上下文"原样生效，避免手拼字符串。见暴露的 `contextPath`。
   */
  buildContext?: (state: TState) => string;
  /** 初始状态；传函数则延迟到 store setup 内求值（可安全调用其它 Pinia store） */
  defaultState: TState | (() => TState);
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
  const getDefault = (): TState =>
    typeof config.defaultState === "function"
      ? (config.defaultState as () => TState)()
      : ({ ...config.defaultState });

  return defineStore(storeId, () => {
    const local = reactive(getDefault()) as TState;
    const allowedKeys = new Set(Object.keys(local));
    const globalStore = useGlobalPathRoute();
    const { hide } = storeToRefs(globalStore);
    const { settingValue: path, set: setPath } = useSettingKeyState(config.settingKey);

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

    /**
     * 构建"上下文前缀"——`[hide/]` + `config.buildContext(state)`（若未声明则空串）。
     * 跟 `pathFor` 一样支持覆盖 local / hide；用于"我想列 `<ctx>plugin/`、`<ctx>date/` 这种
     * filter 根下选项"的场景，让调用方不用手拼 hide/search 等前缀。
     */
    const contextPathFor = (
      overrideLocal: Partial<TState> = {},
      overrideHide?: boolean
    ): string => {
      const ml = { ...local, ...overrideLocal } as TState;
      const h = overrideHide ?? hide.value;
      const full = { ...ml, hide: h } as TState & GlobalRouteState;
      const effHide = !config.ignoreHide?.(full) && h;
      const ctx = config.buildContext?.(ml) ?? "";
      return effHide ? HIDE_PREFIX + ctx : ctx;
    };

    const contextPath = computed(() => contextPathFor({}));

    /**
     * 计算"**若用给定 overrides 调 navigate/push，最终会路由到哪条 path**"——
     * 不真正 mutate state、也不 replace URL。常见用途：想拿某个视图下的
     * provider path（例如在 currentPath 基础上去掉 search、或切换 filter）
     * 交给后端做单独查询（如 `pathql_entry` 取 total）。
     *
     * 行为与 `push` 内部计算的 path 完全一致：
     * - `overrideLocal` 里出现的字段覆盖 local state；未列出的字段沿用当前值
     * - `hide` 字段单独走 global hide store；`config.ignoreHide` 仍然生效
     */
    const computePath = (u: Partial<TState & GlobalRouteState> = {}): string => {
      const overrideLocal: Record<string, unknown> = {};
      let overrideHide: boolean | undefined;
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          overrideHide = v as boolean;
        } else if (allowedKeys.has(k)) {
          overrideLocal[k] = v;
        }
      }
      return pathFor(overrideLocal as Partial<TState>, overrideHide);
    };

    const syncFromUrl = (raw: string) => {
      const trimmed = (raw || "").trim();
      console.log(`[${storeId}] syncFromUrl ←`, JSON.stringify(trimmed));
      if (!trimmed) {
        Object.assign(local, getDefault());
        return;
      }
      const hasHide = trimmed.startsWith(HIDE_PREFIX);
      const inner = hasHide ? trimmed.slice(HIDE_PREFIX.length) : trimmed;
      if (inner) {
        Object.assign(local, config.parse(inner));
      } else {
        Object.assign(local, getDefault());
      }
      if (!config.ignoreHide?.(merged())) {
        hide.value = hasHide;
      }
    };

    // 初始 settings query → state（仅当已在本 store 所属路由时）。
    // query 的 routeName/激活态 guard 由本 store 自己处理，settings 层只镜像 `?path=`。
    if (isOwningRoute()) {
      const s = pathSettingValue().trim();
      if (s) syncFromUrl(s);
    }

    // state → URL：state 变化时 replace，以及路由激活/store 首次实例化时修正 stale URL。
    // immediate：首屏访问 `/gallery`（无 `?path=`）时立即把默认路径写入 URL，
    // 否则 watcher 要等 currentPath 变化才触发，而默认路径下它不会再变。
    watch(
      [currentPath, () => router.currentRoute.value.name] as const,
      async ([path]) => {
        if (!isOwningRoute()) {
          console.log(`[${storeId}] state→URL skip (not owning route)`, path);
          return;
        }
        if (path === String(pathSettingValue())) return;
        console.log(`[${storeId}] state→URL replace`, path);
        await setPath(path as any, { history: "replace" });
        config.onStateChange?.(merged(), path);
      },
      { immediate: true }
    );

    // URL → state：浏览器 back/forward、手输 URL、replace 后的回灌
    // prevName 跟踪：路由刚激活（name 发生变化切入本路由）时跳过 URL→state，
    // 改由 state→URL watcher 来纠正 stale URL，避免两个 watcher 竞争 hide。
    watch(
      () => [
        router.currentRoute.value.name,
        path.value,
      ] as const,
      ([name, raw], oldValue) => {
        const prevName = oldValue?.[0];
        if (config.routeName && name !== config.routeName) return;
        const s = String(raw ?? "").trim();
        if (!s) {
          Object.assign(local, getDefault());
          return;
        }
        if (s === currentPath.value) return;
        if (prevName !== name) return; // 路由刚切入：让 state→URL 负责
        syncFromUrl(s);
      },
      { immediate: true },
    );

    /** 批量 replace：一次性修改多个字段，由 state→URL watcher 统一触发 replace */
    const patch = (u: Partial<TState & GlobalRouteState>) => {
      console.log(`[${storeId}] patch`, u);
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          hide.value = v as boolean;
        } else if (allowedKeys.has(k)) {
          (local as Record<string, unknown>)[k] = v;
        }
      }
    };

    /** 跨页跳转：push 一条新的 history 记录（可前进/后退），不 mutate local，由 URL→state watcher 回灌 */
    const push = async (u: Partial<TState & GlobalRouteState>) => {
      const overrideLocal: Record<string, unknown> = {};
      let overrideHide: boolean | undefined;
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          overrideHide = v as boolean;
        } else if (allowedKeys.has(k)) {
          overrideLocal[k] = v;
        }
      }
      const path = pathFor(overrideLocal as Partial<TState>, overrideHide);
      console.log(`[${storeId}] push → name:${config.routeName}`, path);
      if (config.routeName && !isOwningRoute()) {
        await router.push({
          name: config.routeName,
          query: { path },
        });
      } else {
        await setPath(path as any, { history: "push" });
      }
    };

    function pathSettingValue(): string {
      return String(path.value ?? "");
    }

    return {
      ...toRefs(local),
      hide,
      currentPath,
      contextPath,
      computePath,
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
