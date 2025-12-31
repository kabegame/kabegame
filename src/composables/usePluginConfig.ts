import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type VarOption = string | { name: string; variable: string };

export type PluginVarDef = {
  key: string;
  type: string;
  name: string;
  descripts?: string;
  default?: any;
  options?: VarOption[];
  min?: number;
  max?: number;
};

/**
 * 插件配置管理 composable
 */
export function usePluginConfig() {
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

  const optionLabel = (opt: VarOption) => (typeof opt === "string" ? opt : opt.name);
  const optionValue = (opt: VarOption) => (typeof opt === "string" ? opt : opt.variable);

  // 将 UI 表单中的 vars（checkbox 在 UI 层使用 string[]）转换为后端/脚本需要的对象：
  // 例如 { foo: ["a","b"] } -> { foo: { a: true, b: true } }
  const expandVarsForBackend = (uiVars: Record<string, any>, defs: PluginVarDef[]) => {
    const expanded: Record<string, any> = { ...uiVars };
    for (const def of defs) {
      if (def.type !== "checkbox") continue;
      const options = def.options || [];
      const optionVars = options.map(optionValue);
      const selected = Array.isArray(uiVars[def.key]) ? (uiVars[def.key] as string[]) : [];
      const obj: Record<string, boolean> = {};
      for (const v of optionVars) obj[v] = selected.includes(v);
      expanded[def.key] = obj;
    }
    return expanded;
  };

  // 将后端保存/运行配置中的 checkbox 值聚合回 UI 用的 foo: string[]
  // - 格式：foo: { a: true, b: false }（脚本中用 foo.a/foo.b）
  const normalizeVarsForUI = (rawVars: Record<string, any>, defs: PluginVarDef[]) => {
    const normalized: Record<string, any> = {};
    for (const def of defs) {
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
          normalized[def.key] = optionVars.filter((v) => (d as any)[v] === true);
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

  // 获取验证规则
  const getValidationRules = (varDef: PluginVarDef) => {
    if (!isRequired(varDef)) {
      return [];
    }

    // 根据类型返回不同的验证规则
    if (varDef.type === 'list' || varDef.type === 'checkbox') {
      return [
        {
          required: true,
          message: `请选择${varDef.name}`,
          trigger: 'change',
          validator: (_rule: any, value: any, callback: any) => {
            if (!value || (Array.isArray(value) && value.length === 0)) {
              callback(new Error(`请选择${varDef.name}`));
            } else {
              callback();
            }
          }
        }
      ];
    } else if (varDef.type === 'boolean') {
      // boolean 类型总是有值（true/false），不需要验证
      return [];
    } else {
      return [
        {
          required: true,
          message: `请输入${varDef.name}`,
          trigger: varDef.type === 'options' ? 'change' : 'blur',
          validator: (_rule: any, value: any, callback: any) => {
            if (value === undefined || value === null || value === '') {
              callback(new Error(`请输入${varDef.name}`));
              return;
            }
            // 对于 int 和 float 类型，验证 min/max
            if ((varDef.type === 'int' || varDef.type === 'float') && typeof value === 'number') {
              const varDefWithMinMax = varDef as PluginVarDef;
              if (varDefWithMinMax.min !== undefined && value < varDefWithMinMax.min) {
                callback(new Error(`${varDef.name}不能小于 ${varDefWithMinMax.min}`));
                return;
              }
              if (varDefWithMinMax.max !== undefined && value > varDefWithMinMax.max) {
                callback(new Error(`${varDef.name}不能大于 ${varDefWithMinMax.max}`));
                return;
              }
            }
            callback();
          }
        }
      ];
    }
  };

  // 加载插件变量定义
  const loadPluginVars = async (pluginId: string) => {
    try {
      const vars = await invoke<Array<{ key: string; type: string; name: string; descripts?: string; default?: any; options?: VarOption[] }> | null>("get_plugin_vars", {
        pluginId,
      });
      pluginVars.value = vars || [];

      // DEV 调试：确认后端实际返回的 var 定义是否已更新（排查"插件已更新但导入仍旧配置"）
      if (import.meta.env.DEV) {
        console.info("[loadPluginVars] get_plugin_vars result:", {
          pluginId,
          vars: pluginVars.value,
        });
      }

      // 加载已保存的用户配置
      const savedConfig = await invoke<Record<string, any>>("load_plugin_config", {
        pluginId,
      });

      if (import.meta.env.DEV) {
        console.info("[loadPluginVars] load_plugin_config result:", {
          pluginId,
          savedConfig,
        });
      }

      // 将保存的配置聚合为 UI 表单模型（checkbox: foo -> ["a","b"]），并补默认值
      form.value.vars = normalizeVarsForUI(savedConfig || {}, pluginVars.value as PluginVarDef[]);
    } catch (error) {
      console.error("加载插件变量失败:", error);
      pluginVars.value = [];
    }
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
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: "图片",
            extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
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
    selectOutputDir,
    selectFolder,
    selectFile,
    resetForm,
  };
}

