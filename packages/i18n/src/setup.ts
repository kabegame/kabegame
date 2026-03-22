import { createI18n } from "vue-i18n";
import zh from "./locales/zh";
import en from "./locales/en";
import zhtw from "./locales/zhtw";
import ja from "./locales/ja";
import ko from "./locales/ko";

export const SUPPORTED_LANGUAGES = [
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "zhtw", label: "繁體中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
] as const;

export type SupportedLocale = (typeof SUPPORTED_LANGUAGES)[number]["value"];

const messages: Record<string, object> = {
  zh,
  en,
  zhtw,
  ja,
  ko,
};

function localeAlias(locale: string): string | null {
  const normalized = locale.toLowerCase().replace(/_/g, "-");
  const map: Record<string, string> = {
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-sg": "zh",
    "zh-my": "zh",
    "zh-tw": "zhtw",
    "zh-hk": "zhtw",
    "zh-hant": "zhtw",
    "zh-mo": "zhtw",
    ja: "ja",
    "ja-jp": "ja",
    "ko-kr": "ko",
    "ko-kp": "ko",
  };
  return map[normalized] ?? null;
}

/**
 * 仅当字符串能映射到已安装语言包时返回语种，否则 null（不套用系统/默认）。
 */
export function tryResolveStoredLanguage(lang: string | null | undefined): SupportedLocale | null {
  if (!lang || !lang.trim()) return null;
  const normalized = lang.toLowerCase().replace(/_/g, "-");
  const alias = localeAlias(normalized);
  if (alias && alias in messages) return alias as SupportedLocale;
  const prefix = normalized.split("-")[0];
  if (prefix in messages) return prefix as SupportedLocale;
  return null;
}

/**
 * 生效语言：已保存且合法的语言 → 系统语言 → 英语。
 */
export function resolveLanguage(lang: string | null | undefined): SupportedLocale {
  const direct = tryResolveStoredLanguage(lang);
  if (direct) return direct;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const fromSystem = tryResolveStoredLanguage(nav);
  if (fromSystem) return fromSystem;
  return "en";
}

export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages,
  globalInjection: true,
});

export function setLocale(locale: SupportedLocale) {
  i18n.global.locale.value = locale;
}
