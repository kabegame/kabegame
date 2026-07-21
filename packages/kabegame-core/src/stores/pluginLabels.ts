export type ElTagType =
  | "primary"
  | "success"
  | "info"
  | "warning"
  | "danger";

/** 插件声明的标签；预定义标签只写 id，name/desc 为可选回落（仅未知标签用） */
export interface PluginLabel {
  id: string;
  name?: string;
  desc?: string;
}

/** 应用合成的“版本不兼容”标签 id（非插件声明） */
export const VERSION_INCOMPATIBLE_LABEL_ID = "app.versionIncompatible";

interface LabelDescriptor {
  nameKey: string;
  descKey: string;
  type: ElTagType;
}

const REG: Record<string, LabelDescriptor> = {
  "auth.needCookie": {
    nameKey: "plugins.pluginLabels.authNeedCookie.name",
    descKey: "plugins.pluginLabels.authNeedCookie.desc",
    type: "warning",
  },
  "auth.needProxy": {
    nameKey: "plugins.pluginLabels.authNeedProxy.name",
    descKey: "plugins.pluginLabels.authNeedProxy.desc",
    type: "warning",
  },
  "content.res.mobile": {
    nameKey: "plugins.pluginLabels.contentResMobile.name",
    descKey: "plugins.pluginLabels.contentResMobile.desc",
    type: "primary",
  },
  "content.res.desktop": {
    nameKey: "plugins.pluginLabels.contentResDesktop.name",
    descKey: "plugins.pluginLabels.contentResDesktop.desc",
    type: "primary",
  },
  "content.nsfw": {
    nameKey: "plugins.pluginLabels.contentNsfw.name",
    descKey: "plugins.pluginLabels.contentNsfw.desc",
    type: "danger",
  },
  "content.type.video": {
    nameKey: "plugins.pluginLabels.contentTypeVideo.name",
    descKey: "plugins.pluginLabels.contentTypeVideo.desc",
    type: "success",
  },
  [VERSION_INCOMPATIBLE_LABEL_ID]: {
    nameKey: "plugins.pluginLabels.versionIncompatible.name",
    descKey: "plugins.pluginLabels.versionIncompatible.desc",
    type: "danger",
  },
};

export interface ResolvedPluginLabel {
  text: string;
  desc: string;
  type: ElTagType;
}

/** 命中 registry → i18n 文案+指定色；未命中 → 插件回落 name/desc + 灰（info） */
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
      type: d.type,
    };
  }
  return {
    text: label.name || label.id,
    desc: label.desc || "",
    type: "info",
  };
}
