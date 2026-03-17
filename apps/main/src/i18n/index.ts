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
    "ja": "ja",
    "ja-jp": "ja",
    "ko-kr": "ko",
    "ko-kp": "ko",
  };
  return map[normalized] ?? null;
}

export function resolveLanguage(lang: string | null | undefined): SupportedLocale {
  if (!lang || !lang.trim()) {
    const nav = typeof navigator !== "undefined" ? navigator.language : "zh";
    return resolveLanguage(nav);
  }
  const normalized = lang.toLowerCase().replace(/_/g, "-");
  const alias = localeAlias(normalized);
  if (alias && alias in messages) return alias as SupportedLocale;
  const prefix = normalized.split("-")[0];
  if (prefix in messages) return prefix as SupportedLocale;
  return "zh";
}

export const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "zh",
  messages,
  globalInjection: true,
});

export function setLocale(locale: SupportedLocale) {
  i18n.global.locale.value = locale;
}
