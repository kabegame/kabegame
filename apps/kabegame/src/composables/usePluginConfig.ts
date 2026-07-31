import { ref } from "vue";
import { invoke } from "@/api/rpc";
import { open } from "@tauri-apps/plugin-dialog";
import { useImageTypes } from "@/composables/useImageTypes";
import { usePluginConfigI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import {
  type VarOption,
  type PluginVarDef,
  normalizeVarsForUI,
  matchUserConfigFromDefaults,
} from "@kabegame/core/utils/pluginVarForm";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

/** 从插件默认配置加载到表单时，一并返回 httpHeaders / outputDir */
export type PluginDefaultLoadResult = {
  httpHeaders: Record<string, string>;
  outputDir: string;
};

/**
 * 插件配置管理 composable
 */
export function usePluginConfig() {
  const { extensions: imageExtensions, load: loadImageTypes } = useImageTypes();
  const { resolveConfigText, locale } = usePluginConfigI18n();
  const form = ref({
    pluginId: "",
    outputDir: "",
    vars: {} as Record<string, any>,
    url: "",
  });

  const selectedRunConfigId = ref<string | null>(null);
  const saveAsConfig = ref(false);
  const configName = ref("");
  const configDescription = ref("");
  const formRef = ref<any>();
  const pluginVars = ref<PluginVarDef[]>([]);

  /** 取选项展示名（按当前 locale 解析 i18n 对象） */
  const optionLabel = (opt: VarOption) =>
    typeof opt === "string" ? opt : resolveConfigText(opt.name, locale.value);

  // 仅加载插件变量定义到 pluginVars，不修改 form.vars（用于载入配置等场景）
  const loadPluginVarDefs = async (pluginId: string) => {
    const pluginStore = usePluginStore();
    const plugin = pluginStore.plugins.find((p) => p.id === pluginId);
    const vars = (plugin?.config?.vars as PluginVarDef[] | undefined) ?? [];
    pluginVars.value = vars;
  };

  // 根据当前 pluginVars 用默认值重置 form.vars
  const resetFormVarsToDefaults = () => {
    form.value.vars = normalizeVarsForUI(
      {},
      pluginVars.value as PluginVarDef[]
    );
  };

  /** 解析磁盘默认配置 JSON 中的 httpHeaders */
  function parseHttpHeadersFromDefault(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v == null ? "" : String(v);
    }
    return out;
  }

  /**
   * 加载插件变量定义并优先应用用户数据目录下的默认配置；
   * 默认配置缺失时由后端生成；解析失败时回退到 config.json 中的 var 默认值。
   */
  const loadPluginVars = async (
    pluginId: string
  ): Promise<PluginDefaultLoadResult> => {
    await loadPluginVarDefs(pluginId);
    const defs = pluginVars.value as PluginVarDef[];
    const emptyResult = (): PluginDefaultLoadResult => ({
      httpHeaders: {},
      outputDir: "",
    });

    if (!defs.length) {
      form.value.vars = {};
      form.value.outputDir = "";
      return emptyResult();
    }

    let disk: unknown = undefined;
    try {
      disk = await invoke<unknown | null>("get_plugin_default_config", {
        pluginId,
      });
    } catch {
      resetFormVarsToDefaults();
      form.value.outputDir = "";
      return emptyResult();
    }

    if (disk == null) {
      try {
        disk = await invoke<unknown>("ensure_plugin_default_config", { pluginId });
      } catch {
        resetFormVarsToDefaults();
        form.value.outputDir = "";
        return emptyResult();
      }
    }

    const obj = disk as Record<string, unknown>;
    const rawUser =
      obj.userConfig && typeof obj.userConfig === "object" && !Array.isArray(obj.userConfig)
        ? (obj.userConfig as Record<string, any>)
        : {};
    const matched = matchUserConfigFromDefaults(rawUser, defs);
    form.value.vars = normalizeVarsForUI(matched, defs);

    const od = obj.outputDir;
    const outputDir = typeof od === "string" ? od : "";
    form.value.outputDir = outputDir;

    const httpHeaders = parseHttpHeadersFromDefault(obj.httpHeaders);
    return { httpHeaders, outputDir };
  };

  // 选择输出目录
  const selectOutputDir = async () => {
    if (await guardDesktopOnly("openLocal")) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === "string") {
        form.value.outputDir = selected;
      }
    } catch (error) {
      console.error("选择目录失败:", error);
    }
  };

  // 选择文件夹（用于插件变量）
  const selectFolder = async (varKey: string) => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === "string") {
        form.value.vars[varKey] = selected;
      }
    } catch (error) {
      console.error("选择目录失败:", error);
    }
  };

  // 选择文件（用于插件变量）
  const selectFile = async (varKey: string) => {
    return await selectFileByExtensions(varKey);
  };

  // 选择文件（用于插件变量，可按扩展名过滤）
  // - extensions: 不带点号，例如 ["jpg","png","zip"]
  const selectFileByExtensions = async (
    varKey: string,
    extensions?: string[]
  ) => {
    try {
      let exts: string[];
      if (extensions && extensions.length > 0) {
        exts = extensions
          .map((e) => `${e}`.trim().replace(/^\./, "").toLowerCase())
          .filter(Boolean);
      } else {
        await loadImageTypes();
        exts = imageExtensions.value.length
          ? [...imageExtensions.value, "zip"]
          : ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "zip"];
      }

      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: "文件",
            extensions: exts,
          },
        ],
      });

      if (selected && typeof selected === "string") {
        form.value.vars[varKey] = selected;
      }
    } catch (error) {
      console.error("选择文件失败:", error);
    }
  };

  // 重置表单
  const resetForm = () => {
    form.value.outputDir = "";
    saveAsConfig.value = false;
    configName.value = "";
    configDescription.value = "";
    form.value.vars = {};
  };

  return {
    form,
    selectedRunConfigId,
    saveAsConfig,
    configName,
    configDescription,
    formRef,
    pluginVars,
    optionLabel,
    loadPluginVars,
    loadPluginVarDefs,
    resetFormVarsToDefaults,
    selectOutputDir,
    selectFolder,
    selectFile,
    selectFileByExtensions,
    resetForm,
    parseHttpHeadersFromDefault,
  };
}
