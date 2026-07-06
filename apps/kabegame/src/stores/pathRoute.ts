import { defineStore, storeToRefs } from "pinia";
import { computed, type WritableComputedRef } from "vue";
import { useLocalStorage } from "@vueuse/core";
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
  /** 初始状态，必须包含所有可枚举键；传函数则延迟到 store setup 内求值（可安全调用其它 Pinia store）。 */
  defaultState: TState | (() => TState);

  onStateChange?: (state: TState & GlobalRouteState, path: string) => void;
  /**
   * 返回 true 时：build 不加 `hide/` 前缀；syncFromUrl 见到前缀也不回写 hide。
   * 用于让某些路由（HIDDEN 画册 / TaskDetail）不参与全局 hide。
   */
  ignoreHide?: (state: TState & GlobalRouteState) => boolean;
};

type StateComputedRefs<TState extends object> = {
  [K in keyof TState]: WritableComputedRef<TState[K], TState[K]>;
};

/**
 * 将 url 中的 `?path=xxx` 解析成 state，并保持两者双向同步，其中path可配置
 * 不负责keepalive页面跨页面guard,如有需求由调用方保证 
 */ 
export function createPathRouteStore<TState extends object>(
  storeId: string,
  config: PathRouteStoreConfig<TState>
) {
  const getDefault = (): TState =>
    typeof config.defaultState === "function"
      ? (config.defaultState as () => TState)()
      : ({ ...config.defaultState });

  return defineStore(storeId, () => {
    const globalStore = useGlobalPathRoute();
    const { hide } = storeToRefs(globalStore);
    const { settingValue: path, set: setPath } = useSettingKeyState(config.settingKey);
    const defaults = getDefault();

    const stripHidePrefix = (raw: string): string =>
      raw.startsWith(HIDE_PREFIX) ? raw.slice(HIDE_PREFIX.length) : raw;

    const parsePathState = (raw: string): TState => {
      const inner = stripHidePrefix(raw.trim());
      return inner ? config.parse(inner) : getDefault();
    };

    const fullPathFor = (
      nextState: TState,
      overrideHide = hide.value,
    ): string => {
      const full = { ...nextState, hide: overrideHide } as TState & GlobalRouteState;
      const effHide = !config.ignoreHide?.(full) && overrideHide;
      const inner = config.build(nextState);
      return effHide ? HIDE_PREFIX + inner : inner;
    };

    const writeState = async (
      nextState: TState,
      options?: { history?: "push" | "replace" },
    ): Promise<boolean> => {
      const nextPath = fullPathFor(nextState);
      if (nextPath === String(path.value ?? "")) {
        console.log(`[path-route] repeated path`);
        return true;
      }
      const ok = await setPath(nextPath as any, options);
      if (ok) {
        config.onStateChange?.(
          { ...nextState, hide: hide.value } as TState & GlobalRouteState,
          nextPath,
        );
      }
      return ok;
    };

    const state = computed<TState>({
      // 读：直接读state路径
      get: () => {
        return path.value ? parsePathState(String(path.value)) : getDefault();
      },
      // 写：全量赋值路径
      set: value => {
        void writeState(value).catch((e) => {
          console.error(`[path-route] state set failed: ${e}`);
        });
      }
    });

    type StateKey = Extract<keyof TState, string>;
    const stateKeys = Object.keys(defaults) as StateKey[];
    const createStateComputedRef = <K extends StateKey>(key: K): StateComputedRefs<TState>[K] =>
      computed<TState[K]>({
        get: () => {
          return state.value[key]
        },
        set: value => {
          if (value === state.value[key]) return;
          state.value = {
            ...state.value,
            [key]: value
          }
        }
      });

    // 逐字段赋值路径
    const stateComputedKeys = {} as StateComputedRefs<TState>;
    for (const key of stateKeys) {
      stateComputedKeys[key] = createStateComputedRef(key);
    }

    const pathFor = (
      overrideState: Partial<TState>,
      overrideHide?: boolean
    ): string => {
      const mergedState = { ...state.value, ...overrideState } as TState;
      return fullPathFor(mergedState, overrideHide ?? hide.value);
    };

    const computedPath = computed(() => pathFor({}));

    /**
     * 构建"上下文前缀"——`[hide/]` + `config.buildContext(state)`（若未声明则空串）。
     * 跟 `pathFor` 一样支持覆盖 local / hide；用于"我想列 `<ctx>plugin/`、`<ctx>date/` 这种
     * filter 根下选项"的场景，让调用方不用手拼 hide/search 等前缀。
     */
    const contextPathFor = (
      overrideLocal: Partial<TState> = {},
      overrideHide?: boolean
    ): string => {
      const ml = { ...state.value, ...overrideLocal } as TState;
      const h = overrideHide ?? hide.value;
      const full = { ...ml, hide: h } as TState & GlobalRouteState;
      const effHide = !config.ignoreHide?.(full) && h;
      const ctx = config.buildContext?.(ml) ?? "";
      return effHide ? HIDE_PREFIX + ctx : ctx;
    };

    const computedContextPath = computed(() => contextPathFor({}));

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
        } else {
          overrideLocal[k] = v;
        }
      }
      return pathFor(overrideLocal as Partial<TState>, overrideHide);
    };

    // todo: 去掉这个接口，应该在内部own这个接口
    const syncFromUrl = (raw: string) => {
      // const trimmed = (raw || "").trim();
      // console.log(`[${storeId}] syncFromUrl ←`, JSON.stringify(trimmed));
      // if (!trimmed) {
      //   Object.assign(local, getDefault());
      //   return;
      // }
      // const hasHide = trimmed.startsWith(HIDE_PREFIX);
      // const inner = hasHide ? trimmed.slice(HIDE_PREFIX.length) : trimmed;
      // if (inner) {
      //   Object.assign(local, config.parse(inner));
      // } else {
      //   Object.assign(local, getDefault());
      // }
      // if (!config.ignoreHide?.(merged())) {
      //   hide.value = hasHide;
      // }
    };

    // state → URL：state 变化时 replace，以及路由激活/store 首次实例化时修正 stale URL。
    // immediate：首屏访问 `/gallery`（无 `?path=`）时立即把默认路径写入 URL，
    // 否则 watcher 要等 currentPath 变化才触发，而默认路径下它不会再变。
    // watch(
    //   computedPath,
    //   async (path) => {
    //     if (path === String(pathSettingValue())) return;
    //     console.log(`[${storeId}] state→URL replace`, path);
    //     await setPath(path as any, { history: "replace" });
    //     config.onStateChange?.(merged(), path);
    //   },
    //   { immediate: true }
    // );

    // URL → state：浏览器 back/forward、手输 URL、replace 后的回灌
    // prevName 跟踪：路由刚激活（name 发生变化切入本路由）时跳过 URL→state，
    // 改由 state→URL watcher 来纠正 stale URL，避免两个 watcher 竞争 hide。
    // watch(
    //     path,
    //   (raw, oldValue) => {
    //     const prevName = oldValue?.[0];
    //     const s = String(raw ?? "").trim();
    //     if (!s) {
    //       Object.assign(state, getDefault());
    //       return;
    //     }
    //     if (s === computedPath.value) return;
    //     if (prevName !== name) return; // 路由刚切入：让 state→URL 负责
    //     syncFromUrl(s);
    //   },
    //   { immediate: true },
    // );

    /** 批量 replace：一次性修改多个字段，由 state→URL watcher 统一触发 replace */
    const patch = async (u: Partial<TState & GlobalRouteState>) => {
      console.log(`[${storeId}] patch`, u);
      const draft = { ...state.value }
      let nextHide = hide.value;
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          nextHide = v as boolean;
        } else if (k in stateComputedKeys) {
          draft[k as StateKey] = v as TState[StateKey];
        }
      }
      hide.value = nextHide;
      return writeState(draft as TState);
    };

    /** 跨页跳转：push 一条新的 history 记录（可前进/后退），不 mutate local，由 URL→state watcher 回灌 */
    const push = async (u: Partial<TState & GlobalRouteState>) => {
      const overrideState: Record<string, unknown> = {};
      let overrideHide: boolean | undefined;
      for (const [k, v] of Object.entries(u)) {
        if (k === "hide") {
          overrideHide = v as boolean;
        } else {
          overrideState[k] = v;
        }
      }
      const nextState = { ...state.value, ...overrideState } as TState;
      const path = fullPathFor(nextState, overrideHide ?? hide.value);
      console.log(`[${storeId}] push → `, path);
      await setPath(path as any, { history: "push" });
    };

    return {
      ...stateComputedKeys,
      hide,
      // 根据state算出的path，不是真实url path
      computedPath,
      // 根据 state 算出的上下文path.
      computedContextPath,
      // 从某个state算一个path
      computePath,
      // 
      syncFromUrl,
      patch,
      push,
      /** 此接口最完整。`store.field = v`(replace) / `patch`(replace) / `push` */
      navigate: (
        u: Partial<TState & GlobalRouteState>,
        o?: { push?: boolean }
      ) => (o?.push ? push(u) : patch(u)),
      clear: () => setPath('')
    };
  });
}
