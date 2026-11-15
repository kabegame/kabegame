/**
 * dev 覆盖「场景阴影」设置（P13d 验收）：不改用户设置、不重启 WPE 也能按任一档位渲染，和 WPE 五档抓帧逐档比。宿主加载（`host.ts`）
 * 与 dev 探针（`probe.ts` 的 `renderFrame`）都读它：`localStorage["kabegame-dev-scene-shadows"]` 为 `follow` / `disabled` / `low` /
 * `medium` / `high` / `ultra` 时生效，生产构建摇掉。同 `reflectionOverride.ts`。
 */
import { SCENE_SHADOW_SETTINGS, type SceneShadowSetting } from "../compile/postprocess";

export const SHADOWS_OVERRIDE_KEY = "kabegame-dev-scene-shadows";

export function shadowsOverride(): SceneShadowSetting | null {
  // vitest 里没有构建期常量（探针的单测不打桩）：当生产处理；构建时 `typeof true` 照样被折叠掉
  if (typeof __SCENE_DEV__ === "undefined" || !__SCENE_DEV__) return null;
  try {
    const value = localStorage.getItem(SHADOWS_OVERRIDE_KEY);
    return SCENE_SHADOW_SETTINGS.includes(value as SceneShadowSetting) ? (value as SceneShadowSetting) : null;
  } catch {
    return null;
  }
}
