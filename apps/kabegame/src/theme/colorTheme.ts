/**
 * 颜色主题。
 *
 * 一个主题就是一份 JSON（`builtin/*.json`）：`id`、多语言 `name`（同插件 manifest 的 `{ default, zh, … }`）、
 * `vars`（CSS 变量 → 值）。应用主题 = 把 `vars` 写到 `<html>` 的行内样式上，覆盖 tokens.css 里 `:root` 的默认值
 * （默认值就是「动漫粉」）。主题只需给主色、点缀色（第二个色相）与四档文字；填充、浅阶、渐变、页面底、悬停、
 * 分隔线、阴影在 tokens.css 里由它们 color-mix 出来，主题也可以显式覆盖。
 *
 * 目前只有内置主题。`vars` 只认 THEME_VARIABLES 里的 `--kb-*`，`parseColorTheme` 是将来接入自定义主题时的唯一校验口。
 * 选中的主题 id 存在设置 `colorTheme`（localStorage 后端）；主窗口启动时先按存储值应用一次（启动页也换肤），
 * 之后由 App.vue 跟随设置变化。
 */
import { resolveManifestText } from "@kabegame/i18n";
import animePink from "./builtin/anime-pink.json";
import freshBlue from "./builtin/fresh-blue.json";
import premiumGray from "./builtin/premium-gray.json";
import freshGreen from "./builtin/fresh-green.json";
import elegantPurple from "./builtin/elegant-purple.json";

/** 主题必须给出的基色：主色、点缀色与四档文字。其余颜色在 tokens.css 里由它们推出。 */
export const REQUIRED_THEME_VARIABLES = [
  "--kb-primary",
  "--kb-primary-hover",
  "--kb-secondary",
  "--kb-fg",
  "--kb-fg-regular",
  "--kb-fg-muted",
  "--kb-fg-subtle",
] as const;

/** 主题可以写的全部变量：基色 + 可选覆盖的派生 / 表面 token。状态色、形状、动效不归主题管。 */
export const THEME_VARIABLES: readonly string[] = [
  ...REQUIRED_THEME_VARIABLES,
  "--kb-primary-fg",
  "--kb-primary-soft",
  "--kb-secondary-soft",
  "--kb-gradient",
  "--kb-gradient-hover",
  "--kb-gradient-soft",
  "--kb-bg",
  "--kb-bg-sidebar",
  "--kb-fill",
  "--kb-fill-light",
  "--kb-fill-lighter",
  "--kb-fill-dark",
  "--kb-accent",
  "--kb-ring",
  "--kb-hover",
  "--kb-pressed",
  "--kb-line",
  "--kb-line-strong",
  "--kb-surface",
  "--kb-surface-raised",
  "--kb-glass",
  "--kb-glass-strong",
  "--kb-overlay",
  "--kb-shadow-sm",
  "--kb-shadow-md",
  "--kb-shadow-lg",
  "--kb-shadow-pop",
];

export interface ColorTheme {
  id: string;
  /** `{ default, zh, en, … }`，按当前语言取，缺省取 default */
  name: Record<string, string>;
  vars: Record<string, string>;
}

export const DEFAULT_COLOR_THEME_ID = "anime-pink";

/** 校验一份主题 JSON；不合法返回 null。 */
export function parseColorTheme(raw: unknown): ColorTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, vars } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) return null;
  if (!name || typeof name !== "object") return null;
  if (typeof (name as Record<string, unknown>).default !== "string") return null;
  if (!Object.values(name).every((v) => typeof v === "string")) return null;
  if (!vars || typeof vars !== "object") return null;
  const entries = Object.entries(vars as Record<string, unknown>);
  if (!entries.every(([k, v]) => THEME_VARIABLES.includes(k) && typeof v === "string" && v.trim() !== "")) return null;
  if (!REQUIRED_THEME_VARIABLES.every((k) => k in (vars as object))) return null;
  return { id, name: name as Record<string, string>, vars: vars as Record<string, string> };
}

/** 内置主题，按设置里的展示顺序。 */
export const BUILTIN_COLOR_THEMES: readonly ColorTheme[] = [
  freshBlue,
  animePink,
  premiumGray,
  freshGreen,
  elegantPurple,
].map((raw) => {
  const theme = parseColorTheme(raw);
  if (!theme) throw new Error(`内置颜色主题不合法：${(raw as { id?: string }).id}`);
  return theme;
});

export function findColorTheme(id: string | null | undefined): ColorTheme {
  return (
    BUILTIN_COLOR_THEMES.find((theme) => theme.id === id) ??
    BUILTIN_COLOR_THEMES.find((theme) => theme.id === DEFAULT_COLOR_THEME_ID)!
  );
}

export function colorThemeName(theme: ColorTheme, locale: string): string {
  return resolveManifestText(theme.name, locale) || theme.id;
}

/** 上一次写到 <html> 上的变量，换主题时先清掉，免得前一个主题的可选覆盖残留。 */
let appliedVars: string[] = [];

export function applyColorTheme(id: string | null | undefined): void {
  if (typeof document === "undefined") return;
  const theme = findColorTheme(id);
  const style = document.documentElement.style;
  for (const name of appliedVars) style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.vars)) style.setProperty(name, value);
  appliedVars = Object.keys(theme.vars);
  document.documentElement.dataset.kbTheme = theme.id;
}

/** 启动早期（settings store 建立之前）按 localStorage 里存的值应用一次，避免启动页先闪默认主题。 */
export function applyStoredColorTheme(storageKey: string): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    // 存储不可用时用默认主题
  }
  applyColorTheme(stored);
}
