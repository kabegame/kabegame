export { useI18n } from "./vue-i18n";
export {
  SUPPORTED_LANGUAGES,
  type SupportedLocale,
  tryResolveStoredLanguage,
  resolveLanguage,
  i18n,
  setLocale,
} from "./setup";
export {
  resolveManifestText,
  resolveManifestDoc,
  resolveConfigText,
} from "./resolve";
export { usePluginManifestI18n } from "./composables/usePluginManifestI18n";
export {
  usePluginConfigI18n,
  type ConfigVarOption,
  type PluginVarDefI18n,
} from "./composables/usePluginConfigI18n";
