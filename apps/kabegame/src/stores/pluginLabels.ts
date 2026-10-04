import type { Component } from "vue";
import KblCookie from "../components/plugin/icons/KblCookie.vue";
import KblDesktop from "../components/plugin/icons/KblDesktop.vue";
import KblMobile from "../components/plugin/icons/KblMobile.vue";
import KblNsfw from "../components/plugin/icons/KblNsfw.vue";
import KblProxy from "../components/plugin/icons/KblProxy.vue";
import KblVersionIncompatible from "../components/plugin/icons/KblVersionIncompatible.vue";
import KblVideo from "../components/plugin/icons/KblVideo.vue";

/** 插件声明的标签；预定义标签只写 id，name/desc 为可选回落（仅未知标签用） */
export interface PluginLabel {
  id: string;
  name?: string;
  desc?: string;
}

/** 应用合成的“版本不兼容”标签 id（非插件声明） */
export const VERSION_INCOMPATIBLE_LABEL_ID = "app.versionIncompatible";

/** 图标底色方块的底色 + 边框色，取自 KbLabel 设计稿 */
export interface LabelTile {
  bg: string;
  border: string;
}

interface LabelDescriptor {
  nameKey: string;
  descKey: string;
  icon: Component;
  tile: LabelTile;
}

const REG: Record<string, LabelDescriptor> = {
  "auth.needCookie": {
    nameKey: "plugins.pluginLabels.authNeedCookie.name",
    descKey: "plugins.pluginLabels.authNeedCookie.desc",
    icon: KblCookie,
    tile: { bg: "#fdf2e2", border: "rgba(201,138,63,0.35)" },
  },
  "auth.needProxy": {
    nameKey: "plugins.pluginLabels.authNeedProxy.name",
    descKey: "plugins.pluginLabels.authNeedProxy.desc",
    icon: KblProxy,
    tile: { bg: "#eaf2ff", border: "rgba(59,130,246,0.3)" },
  },
  "content.res.mobile": {
    nameKey: "plugins.pluginLabels.contentResMobile.name",
    descKey: "plugins.pluginLabels.contentResMobile.desc",
    icon: KblMobile,
    tile: { bg: "#f3efff", border: "rgba(139,122,219,0.35)" },
  },
  "content.res.desktop": {
    nameKey: "plugins.pluginLabels.contentResDesktop.name",
    descKey: "plugins.pluginLabels.contentResDesktop.desc",
    icon: KblDesktop,
    tile: { bg: "#ecefff", border: "rgba(79,91,213,0.3)" },
  },
  "content.nsfw": {
    nameKey: "plugins.pluginLabels.contentNsfw.name",
    descKey: "plugins.pluginLabels.contentNsfw.desc",
    icon: KblNsfw,
    tile: { bg: "#ffeded", border: "rgba(239,68,68,0.32)" },
  },
  "content.type.video": {
    nameKey: "plugins.pluginLabels.contentTypeVideo.name",
    descKey: "plugins.pluginLabels.contentTypeVideo.desc",
    icon: KblVideo,
    tile: { bg: "#e6f7f6", border: "rgba(42,196,184,0.35)" },
  },
  [VERSION_INCOMPATIBLE_LABEL_ID]: {
    nameKey: "plugins.pluginLabels.versionIncompatible.name",
    descKey: "plugins.pluginLabels.versionIncompatible.desc",
    icon: KblVersionIncompatible,
    tile: { bg: "#f4f1fe", border: "rgba(124,107,214,0.3)" },
  },
};

// REG 的声明顺序即展示顺序：认证要求 → 内容分辨率 → 内容属性 → 应用状态。
// 展示一律按这个顺序而非 id 字母序，好让同一枚图标在所有插件里落在同一相对位置。
// 调整顺序＝调整 REG 里的键顺序，不必再同步一份独立的数组。
/** 内置标签的固定展示顺序；列表的固定槽位模式按它逐槽渲染（缺的标签留空位） */
export const PLUGIN_LABEL_IDS: readonly string[] = Object.keys(REG);

const LABEL_ORDER = new Map(PLUGIN_LABEL_IDS.map((id, index) => [id, index]));

/** 展示排序比较器：内置标签按 registry 顺序，未知标签统一排在其后并按 id 稳定排序 */
export function comparePluginLabels(a: PluginLabel, b: PluginLabel): number {
  const ia = LABEL_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  const ib = LABEL_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER;
  return ia - ib || a.id.localeCompare(b.id);
}

export interface ResolvedPluginLabel {
  text: string;
  desc: string;
  /** 未命中 registry 的未知标签没有内置图标/底色，KbLabel 走灰色虚线方块回落 */
  icon?: Component;
  tile?: LabelTile;
}

/** 命中 registry → i18n 文案 + 内置图标/底色；未命中 → 插件回落 name/desc，KbLabel 灰色虚线回落 */
export function resolvePluginLabel(
  label: PluginLabel,
  t: (k: string, params?: Record<string, unknown>) => string,
): ResolvedPluginLabel {
  const d = REG[label.id];
  if (d) {
    // desc 里的 {surf} 插值位填入畅游功能名的 i18n（surf.title），随 locale 变化
    return {
      text: t(d.nameKey),
      desc: t(d.descKey, { surf: t("surf.title") }),
      icon: d.icon,
      tile: d.tile,
    };
  }
  return {
    text: label.name || label.id,
    desc: label.desc || "",
  };
}
