/**
 * 对外统一从 `@kabegame/i18n` 引入，避免业务包与 core 直接依赖 `vue-i18n` 包名。
 * 需要更多 API 时再在此文件补充 re-export。
 */
export { useI18n } from "vue-i18n";
