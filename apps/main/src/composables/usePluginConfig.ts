import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useImageTypes } from "@/composables/useImageTypes";
import { usePluginConfigI18n } from "@kabegame/i18n";
import type { PluginConfigText } from "@kabegame/core/stores/plugins";
import {
  formatPluginDateForBackend,
  parsePluginDateBound,
  parsePluginDateStored,
  shiftPluginDateByDays,
} from "@kabegame/core/utils/pluginDateVar";
import { validateVarValue } from "@/utils/pluginVarValidation";

/** 从插件默认配置加载到表单时，一并返回 httpHeaders / outputDir */
export type PluginDefaultLoadResult = {
  httpHeaders: Record<string, string>;
  outputDir: string;
};

/** 将默认配置中的 userConfig 按字段与 var 定义对齐（不兼容字段回退到 default） */
function matchUserConfigFromDefaults(
  userConfig: Record<string, any>,
  defs: PluginVarDef[]
): Record<string, any> {
  const matched: Record<string, any> = {};
  const varDefMap = new Map(defs.map((d) => [d.key, d]));
  const explicitNullKeys = new Set<string>();

  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);
    if (!varDef) continue;
    if (value === null) {
      explicitNullKeys.add(key);
      continue;
    }
    if (value === undefined) continue;
    const validation = validateVarValue(value, varDef);
    if (validation.valid) {
      matched[key] = value;
    } else if (varDef.default !== undefined) {
      matched[key] = varDef.default;
    }
  }

  for (const varDef of defs) {
    if (varDef.key in matched) continue;
    if (explicitNullKeys.has(varDef.key)) continue;
    if (varDef.default !== undefined) {
      matched[varDef.key] = varDef.default;
    }
  }
  return matched;
}

export type VarOption =
  | string
  | { name: PluginConfigText | string; variable: string; when?: Record<string, string[]> };

/** 插件变量定义：name/descripts/options[].name 为后端下发的 record（default/zh/en）或兼容 string */
export type PluginVarDef = {
  key: string;
  type: string;
  name: PluginConfigText | string;
  descripts?: PluginConfigText | string;
  default?: any;
  options?: VarOption[];
  min?: number;
  max?: number;
  when?: Record<string, string[]>;
  /** type 为 date 时可选：dayjs 格式，提交给后端的日期字符串（默认 YYYY-MM-DD） */
  format?: string;
  /** type 为 date 时可选：最早/最晚可选日，`YYYY-MM-DD` 或 `today` / `yesterday` */
  dateMin?: string;
  dateMax?: string;
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

  // 判断配置项是否必填（没有 default 值则为必填）
  const isRequired = (varDef: { default?: any }) => {
    return varDef.default === undefined || varDef.default === null;
  };

  /** 取选项展示名（按当前 locale 解析 i18n 对象） */
  const optionLabel = (opt: VarOption) =>
    typeof opt === "string" ? opt : resolveConfigText(opt.name, locale.value);
  const optionValue = (opt: VarOption) =>
    typeof opt === "string" ? opt : opt.variable;

  // 将 UI 表单中的 vars（checkbox 在 UI 层使用 string[]）转换为后端/脚本需要的对象：
  // 例如 { foo: ["a","b"] } -> { foo: { a: true, b: true } }
  const expandVarsForBackend = (
    uiVars: Record<string, any>,
    defs: PluginVarDef[]
  ) => {
    const expanded: Record<string, any> = { ...uiVars };
    for (const def of defs) {
      if (def.type === "checkbox") {
        const options = def.options || [];
        const optionVars = options.map(optionValue);
        const selected = Array.isArray(uiVars[def.key])
          ? (uiVars[def.key] as string[])
          : [];
        const obj: Record<string, boolean> = {};
        for (const v of optionVars) obj[v] = selected.includes(v);
        expanded[def.key] = obj;
      } else if (def.type === "date") {
        const raw = expanded[def.key];
        if (typeof raw !== "string") continue;
        const fmt =
          def.format && def.format.trim() !== ""
            ? def.format.trim()
            : "YYYY-MM-DD";
        expanded[def.key] = formatPluginDateForBackend(raw, fmt);
      }
    }
    return expanded;
  };

  // 将后端保存/运行配置中的 checkbox 值聚合回 UI 用的 foo: string[]
  // - 格式：foo: { a: true, b: false }（脚本中用 foo.a/foo.b）
  const normalizeVarsForUI = (
    rawVars: Record<string, any>,
    defs: PluginVarDef[]
  ) => {
    const normalized: Record<string, any> = {};
    for (const def of defs) {
      // 兼容：local-import 旧配置字段 file_path/folder_path -> 新字段 path
      if (def.key === "path" && rawVars?.[def.key] === undefined) {
        const legacyFile = rawVars?.["file_path"];
        const legacyFolder = rawVars?.["folder_path"];
        if (typeof legacyFile === "string" && legacyFile.trim() !== "") {
          normalized[def.key] = legacyFile;
          continue;
        }
        if (typeof legacyFolder === "string" && legacyFolder.trim() !== "") {
          normalized[def.key] = legacyFolder;
          continue;
        }
      }

      // 兼容：Pixiv 等旧配置 date_range（天）+ start_date -> end_date
      if (
        def.type === "date" &&
        def.key === "end_date" &&
        (rawVars[def.key] === undefined ||
          rawVars[def.key] === "" ||
          rawVars[def.key] === null)
      ) {
        const legacyRange = rawVars["date_range"];
        const start = rawVars["start_date"];
        if (
          typeof legacyRange === "number" &&
          legacyRange >= 1 &&
          typeof start === "string" &&
          start.trim() !== ""
        ) {
          const fmt =
            def.format && def.format.trim() !== ""
              ? def.format.trim()
              : "YYYY-MM-DD";
          const endStr = shiftPluginDateByDays(start, fmt, legacyRange - 1);
          if (endStr) {
            normalized[def.key] = endStr;
            continue;
          }
        }
      }

      if (def.type === "checkbox") {
        const options = def.options || [];
        const optionVars = options.map(optionValue);
        // foo 是对象（{a:true,b:false}）
        const raw = rawVars[def.key];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          normalized[def.key] = optionVars.filter((v) => raw?.[v] === true);
          continue;
        }
        // default: 支持数组（["a","b"]）或对象（{a:true,b:false}）
        const d = def.default;
        if (Array.isArray(d)) {
          normalized[def.key] = d;
        } else if (d && typeof d === "object") {
          normalized[def.key] = optionVars.filter(
            (v) => (d as any)[v] === true
          );
        } else {
          normalized[def.key] = [];
        }
        continue;
      }

      if (rawVars[def.key] !== undefined) {
        normalized[def.key] = rawVars[def.key];
      } else if (def.default !== undefined) {
        normalized[def.key] = def.default;
      }
    }
    return normalized;
  };

  /** 从 varDef.name（可能为 i18n 对象）取当前 locale 的展示字符串 */
  const varDefNameString = (v: { name?: PluginConfigText | string }) =>
    resolveConfigText(v?.name, locale.value);

  /** 获取验证规则。displayName 可选：传入时用于错误文案（已按 locale 解析），否则用 varDefNameString(varDef) */
  const getValidationRules = (varDef: PluginVarDef, displayName?: string) => {
    if (!isRequired(varDef)) {
      return [];
    }
    const label = displayName ?? varDefNameString(varDef);

    if (varDef.type === "list" || varDef.type === "checkbox") {
      return [
        {
          required: true,
          message: `请选择${label}`,
          trigger: "change",
          validator: (_rule: any, value: any, callback: any) => {
            if (!value || (Array.isArray(value) && value.length === 0)) {
              callback(new Error(`请选择${label}`));
            } else {
              callback();
            }
          },
        },
      ];
    } else if (varDef.type === "boolean") {
      return [];
    } else {
      return [
        {
          required: true,
          message: `请输入${label}`,
          trigger:
            varDef.type === "options" || varDef.type === "date"
              ? "change"
              : "blur",
          validator: (_rule: any, value: any, callback: any) => {
            if (value === undefined || value === null || value === "") {
              callback(new Error(`请输入${label}`));
              return;
            }
            if (
              (varDef.type === "int" || varDef.type === "float") &&
              typeof value === "number"
            ) {
              const varDefWithMinMax = varDef as PluginVarDef;
              if (
                varDefWithMinMax.min !== undefined &&
                value < varDefWithMinMax.min
              ) {
                callback(new Error(`${label}不能小于 ${varDefWithMinMax.min}`));
                return;
              }
              if (
                varDefWithMinMax.max !== undefined &&
                value > varDefWithMinMax.max
              ) {
                callback(new Error(`${label}不能大于 ${varDefWithMinMax.max}`));
                return;
              }
            }
            if (varDef.type === "date" && typeof value === "string") {
              const vd = varDef as PluginVarDef;
              const fmt =
                vd.format && vd.format.trim() !== ""
                  ? vd.format.trim()
                  : "YYYY-MM-DD";
              const d = parsePluginDateStored(value, fmt);
              if (!d) {
                callback(new Error(`请输入有效的${label}`));
                return;
              }
              if (vd.dateMin?.trim()) {
                const minD = parsePluginDateBound(vd.dateMin);
                if (minD && d.startOf("day").isBefore(minD, "day")) {
                  callback(new Error(`${label}不能早于 ${vd.dateMin}`));
                  return;
                }
              }
              if (vd.dateMax?.trim()) {
                const maxD = parsePluginDateBound(vd.dateMax);
                if (maxD && d.startOf("day").isAfter(maxD, "day")) {
                  callback(new Error(`${label}不能晚于 ${vd.dateMax}`));
                  return;
                }
              }
            }
            callback();
          },
        },
      ];
    }
  };

  // 仅加载插件变量定义到 pluginVars，不修改 form.vars（用于载入配置等场景）
  const loadPluginVarDefs = async (pluginId: string) => {
    try {
      const vars = await invoke<Array<PluginVarDef> | null>("get_plugin_vars", {
        pluginId,
      });
      pluginVars.value = vars || [];
      console.debug("[loadPluginVarDefs] get_plugin_vars result:", {
        pluginId,
        vars: pluginVars.value,
      });
    } catch (error) {
      console.error("加载插件变量失败:", error);
      pluginVars.value = [];
    }
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
          : ["jpg", "jpeg", "png", "gif", "webp", "bmp", "zip"];
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
    isRequired,
    optionLabel,
    optionValue,
    expandVarsForBackend,
    normalizeVarsForUI,
    getValidationRules,
    loadPluginVars,
    loadPluginVarDefs,
    resetFormVarsToDefaults,
    selectOutputDir,
    selectFolder,
    selectFile,
    selectFileByExtensions,
    resetForm,
    matchUserConfigFromDefaults,
    parseHttpHeadersFromDefault,
  };
}
