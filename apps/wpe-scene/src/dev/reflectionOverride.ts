/**
 * dev 覆盖「场景反射」设置（P13b2 验收）：不改用户设置也能按反射开 / 关渲染。宿主加载（`host.ts`）与 dev 探针（`probe.ts` 的
 * `renderFrame`）都读它：`localStorage["kabegame-dev-scene-reflection"]` 为 `follow` / `disabled` / `enabled` 时生效，生产构建摇掉。
 */
import { SCENE_REFLECTION_SETTINGS, type SceneReflectionSetting } from "../compile/postprocess";

export const REFLECTION_OVERRIDE_KEY = "kabegame-dev-scene-reflection";

export function reflectionOverride(): SceneReflectionSetting | null {
  // vitest 里没有构建期常量（探针的单测不打桩）：当生产处理；构建时 `typeof true` 照样被折叠掉
  if (typeof __SCENE_DEV__ === "undefined" || !__SCENE_DEV__) return null;
  try {
    const value = localStorage.getItem(REFLECTION_OVERRIDE_KEY);
    return SCENE_REFLECTION_SETTINGS.includes(value as SceneReflectionSetting)
      ? (value as SceneReflectionSetting)
      : null;
  } catch {
    return null;
  }
}
