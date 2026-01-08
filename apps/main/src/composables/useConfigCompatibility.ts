import { ref, watch, computed, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox } from "element-plus";
import { useCrawlerStore, type RunConfig } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import type { PluginVarDef } from "./usePluginConfig";

export interface ConfigCompatibility {
  versionCompatible: boolean; // 第一步：插件是否存在
  contentCompatible: boolean; // 第二步：配置内容是否符合
  versionReason?: string;
  contentErrors: string[]; // 内容不兼容的具体错误
  warnings: string[]; // 警告信息（如字段已删除但不算严重错误）
}

/**
 * 配置兼容性检查 composable
 */
export function useConfigCompatibility(
  pluginVars: Ref<PluginVarDef[]>,
  form: Ref<{ pluginId: string; outputDir: string; vars: Record<string, any> }>,
  selectedRunConfigId: Ref<string | null>,
  loadPluginVars: (pluginId: string) => Promise<void>,
  normalizeVarsForUI: (rawVars: Record<string, any>, defs: PluginVarDef[]) => Record<string, any>,
  isRequired: (varDef: { default?: any }) => boolean,
  showCrawlerDialog?: Ref<boolean>
) {
  const crawlerStore = useCrawlerStore();
  const pluginStore = usePluginStore();
  const runConfigs = computed(() => crawlerStore.runConfigs);
  const plugins = computed(() => pluginStore.plugins);

  // 配置兼容性状态（用于UI显示）
  const configCompatibilityStatus = ref<Record<string, ConfigCompatibility>>({});

  // 配置兼容性缓存（用于避免重复计算）
  const configCompatibilityCache = ref<Map<string, ConfigCompatibility>>(new Map());

  // 验证单个变量值
  const validateVarValue = (value: any, varDef: PluginVarDef): { valid: boolean; error?: string } => {
    switch (varDef.type) {
      case "int":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return { valid: false, error: "值必须是整数" };
        }
        if (varDef.min !== undefined && value < varDef.min) {
          return { valid: false, error: `值不能小于 ${varDef.min}` };
        }
        if (varDef.max !== undefined && value > varDef.max) {
          return { valid: false, error: `值不能大于 ${varDef.max}` };
        }
        break;
      case "float":
        if (typeof value !== "number") {
          return { valid: false, error: "值必须是数字" };
        }
        if (varDef.min !== undefined && value < varDef.min) {
          return { valid: false, error: `值不能小于 ${varDef.min}` };
        }
        if (varDef.max !== undefined && value > varDef.max) {
          return { valid: false, error: `值不能大于 ${varDef.max}` };
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return { valid: false, error: "值必须是布尔值" };
        }
        break;
      case "options":
        if (varDef.options && Array.isArray(varDef.options)) {
          const validValues = varDef.options.map(opt =>
            typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
          );
          if (!validValues.includes(value)) {
            return { valid: false, error: `值不在有效选项中` };
          }
        }
        break;
      case "checkbox":
        if (!Array.isArray(value)) {
          return { valid: false, error: "值必须是数组" };
        }
        if (varDef.options && Array.isArray(varDef.options)) {
          const validValues = varDef.options.map(opt =>
            typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
          );
          const invalidValues = value.filter(v => !validValues.includes(v));
          if (invalidValues.length > 0) {
            return { valid: false, error: `包含无效选项` };
          }
        }
        break;
      case "list":
        if (!Array.isArray(value)) {
          return { valid: false, error: "值必须是数组" };
        }
        break;
    }
    return { valid: true };
  };

  // 检查配置兼容性（两步验证）
  const checkConfigCompatibility = async (config: RunConfig): Promise<ConfigCompatibility> => {
    const result: ConfigCompatibility = {
      versionCompatible: true,
      contentCompatible: true,
      contentErrors: [],
      warnings: []
    };

    // 第一步：检查插件是否存在（版本检查）
    const pluginExists = plugins.value.some(p => p.id === config.pluginId);
    if (!pluginExists) {
      result.versionCompatible = false;
      result.versionReason = "插件不存在";
      result.contentCompatible = false;
      return result;
    }

    try {
      // 加载插件变量定义
      const vars = await invoke<Array<PluginVarDef> | null>("get_plugin_vars", {
        pluginId: config.pluginId,
      });

      if (!vars || vars.length === 0) {
        // 插件没有变量定义，配置总是兼容的
        return result;
      }

      const varDefMap = new Map(vars.map(def => [def.key, def]));
      const userConfig = config.userConfig || {};

      // 第二步：验证配置内容
      for (const [key, value] of Object.entries(userConfig)) {
        const varDef = varDefMap.get(key);

        if (!varDef) {
          // 字段已删除，记录为警告
          result.warnings.push(`字段 "${key}" 已在新版本中删除`);
          continue;
        }

        // 验证字段值
        const validation = validateVarValue(value, varDef);
        if (!validation.valid) {
          result.contentCompatible = false;
          result.contentErrors.push(`${varDef.name} (${key}): ${validation.error}`);
        }
      }

      // 检查是否有新增的必填字段且没有默认值
      for (const varDef of vars) {
        if (!(varDef.key in userConfig)) {
          if (isRequired(varDef) && varDef.default === undefined) {
            result.contentCompatible = false;
            result.contentErrors.push(`缺少必填字段: ${varDef.name} (${varDef.key})`);
          }
        }
      }

    } catch (error) {
      console.error("检查配置兼容性失败:", error);
      result.contentCompatible = false;
      result.contentErrors.push("验证过程出错");
    }

    return result;
  };

  // 智能匹配配置到表单（尽量匹配能匹配的字段）
  const smartMatchConfigToForm = async (config: RunConfig): Promise<{ success: boolean; message?: string }> => {
    // 检查插件是否存在
    const pluginExists = plugins.value.some(p => p.id === config.pluginId);
    if (!pluginExists) {
      return { success: false, message: "插件不存在，无法载入配置" };
    }

    // 加载插件变量定义
    await loadPluginVars(config.pluginId);

    const userConfig = config.userConfig || {};
    const matchedVars: Record<string, any> = {};
    const varDefMap = new Map(pluginVars.value.map(def => [def.key, def]));

    // 尝试匹配每个配置字段
    for (const [key, value] of Object.entries(userConfig)) {
      const varDef = varDefMap.get(key);

      if (!varDef) {
        // 字段已删除，跳过
        continue;
      }

      // 验证值是否有效
      const validation = validateVarValue(value, varDef);
      if (validation.valid) {
        // 值有效，直接使用
        matchedVars[key] = value;
      } else {
        // 值无效，使用默认值（如果有）
        if (varDef.default !== undefined) {
          matchedVars[key] = varDef.default;
        }
      }
    }

    // 填充缺失字段的默认值
    for (const varDef of pluginVars.value) {
      if (!(varDef.key in matchedVars)) {
        if (varDef.default !== undefined) {
          matchedVars[varDef.key] = varDef.default;
        }
      }
    }

    // 转换为 UI 格式
    const cfgUiVars = normalizeVarsForUI(matchedVars, pluginVars.value as PluginVarDef[]);

    // 更新表单
    form.value.pluginId = config.pluginId;
    form.value.outputDir = config.outputDir || "";
    form.value.vars = cfgUiVars;

    return { success: true };
  };

  // 获取配置兼容性（带缓存）
  const getConfigCompatibility = async (configId: string): Promise<ConfigCompatibility> => {
    if (configCompatibilityCache.value.has(configId)) {
      return configCompatibilityCache.value.get(configId)!;
    }

    const config = runConfigs.value.find(c => c.id === configId);
    if (!config) {
      return {
        versionCompatible: false,
        contentCompatible: false,
        versionReason: "配置不存在",
        contentErrors: [],
        warnings: []
      };
    }

    const compatibility = await checkConfigCompatibility(config);
    configCompatibilityCache.value.set(configId, compatibility);
    // 更新UI状态
    configCompatibilityStatus.value[configId] = compatibility;
    return compatibility;
  };

  // 清除兼容性缓存
  const clearCompatibilityCache = () => {
    configCompatibilityCache.value.clear();
    configCompatibilityStatus.value = {};
  };

  // 批量检查所有配置的兼容性（用于UI显示）
  const checkAllConfigsCompatibility = async () => {
    if (runConfigs.value.length === 0) {
      configCompatibilityStatus.value = {};
      return;
    }

    const status: Record<string, ConfigCompatibility> = {};
    const promises = runConfigs.value.map(async (config) => {
      const compatibility = await getConfigCompatibility(config.id);
      status[config.id] = compatibility;
    });
    await Promise.all(promises);
    // 一次性更新所有状态，确保响应式更新
    configCompatibilityStatus.value = { ...status };
  };

  // 删除运行配置（从下拉项直接删除）
  const confirmDeleteRunConfig = async (configId: string) => {
    try {
      const cfg = runConfigs.value.find(c => c.id === configId);
      await ElMessageBox.confirm(
        `删除后无法通过该配置再次运行。已创建的任务不会受影响。确定删除${cfg ? `「${cfg.name}」` : "该配置"}吗？`,
        "删除配置",
        { type: "warning" }
      );
      await crawlerStore.deleteRunConfig(configId);
      if (selectedRunConfigId.value === configId) {
        selectedRunConfigId.value = null;
        // 保留表单内容，便于用户直接修改后保存/运行
      }
      clearCompatibilityCache();
      ElMessage.success("配置已删除");
    } catch (error) {
      if (error !== "cancel") {
        console.error("删除运行配置失败:", error);
        ElMessage.error("删除配置失败");
      }
    }
  };

  // 载入配置到表单（强制载入，即使不兼容）
  const loadConfigToForm = async (configId: string) => {
    const config = runConfigs.value.find(c => c.id === configId);
    if (!config) {
      ElMessage.error("配置不存在");
      return;
    }

    // 检查兼容性
    const compatibility = await getConfigCompatibility(configId);

    // 如果版本不兼容，直接提示
    if (!compatibility.versionCompatible) {
      await ElMessageBox.alert(
        `该配置关联的插件不存在：${compatibility.versionReason || "未知错误"}\n无法载入配置。`,
        "插件缺失",
        { type: "error" }
      );
      return;
    }

    // 如果内容不兼容，提示用户但允许继续
    if (!compatibility.contentCompatible) {
      const errorMsg = compatibility.contentErrors.length > 0
        ? `配置内容与当前插件版本不兼容：\n${compatibility.contentErrors.join('\n')}`
        : "配置内容与当前插件版本不兼容";
      const warningMsg = compatibility.warnings.length > 0
        ? `\n\n警告：\n${compatibility.warnings.join('\n')}`
        : "";

      try {
        await ElMessageBox.confirm(
          `${errorMsg}${warningMsg}\n\n将尝试匹配可用的配置项，缺失的字段将使用默认值。是否继续？`,
          "配置不兼容",
          { type: "warning", confirmButtonText: "继续载入", cancelButtonText: "取消" }
        );
      } catch (error) {
        if (error === "cancel") {
          return;
        }
      }
    }

    // 智能匹配并载入配置
    const result = await smartMatchConfigToForm(config);
    if (result.success) {
      ElMessage.success("配置已载入，快乐玩耍吧！");
    } else {
      ElMessage.error(result.message || "载入配置失败");
    }
  };

  // 监听配置列表和插件列表变化，重新检查兼容性
  if (showCrawlerDialog) {
    watch(
      () => {
        // 关键：不要只依赖数组引用（否则 push/unshift 不会触发），而是依赖"结构化签名"
        const cfgSig = runConfigs.value.map((c) => ({
          id: c.id,
          pluginId: c.pluginId,
          // userConfig 的变化也可能导致兼容性变化；这里用 JSON 字符串作为轻量签名
          userConfigSig: JSON.stringify(c.userConfig || {}),
        }));
        const pluginSig = plugins.value.map((p) => `${p.id}:${p.version}:${p.enabled}`);
        return { cfgSig, pluginSig };
      },
      async () => {
        // 插件列表变化（尤其是版本更新）会影响 vars 定义/默认值，但如果当前 pluginId 不变，
        // `watch(form.pluginId)` 不会触发，导致导入弹窗仍展示旧 vars。
        // 因此：当导入弹窗打开时，插件列表变更也要强制 reload 一次当前 plugin 的 vars + 保存配置。
        if (showCrawlerDialog.value && form.value.pluginId) {
          await loadPluginVars(form.value.pluginId);
        }
        clearCompatibilityCache();
        await checkAllConfigsCompatibility();
      },
      { immediate: true }
    );

    // 打开导入对话框时，兜底刷新一次（保证下拉打开时就能看到兼容性提示）
    watch(showCrawlerDialog, async (open) => {
      if (!open) return;
      // 关键：用户可能刚在"源/插件"页刷新或更新了已安装源（.kgpg 内的 config.json/var 定义变更）
      // 但这里若 pluginId 没变，`watch(form.pluginId)` 不会触发，导致导入弹窗仍展示旧的变量/配置。
      // 因此弹窗打开时做一次"兜底同步"：
      // - 刷新已安装源列表（从文件系统重新读取 .kgpg）
      // - 重新加载当前选中源的变量定义 + 已保存用户配置
      // - 重新计算兼容性提示
      try {
        await pluginStore.loadPlugins();
      } catch (e) {
        // 刷新失败不应阻塞弹窗打开；兼容性/变量加载会按现有状态继续
        console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
      }

      if (form.value.pluginId) {
        await loadPluginVars(form.value.pluginId);
      }

      clearCompatibilityCache();
      await checkAllConfigsCompatibility();
    });
  }

  return {
    configCompatibilityStatus,
    checkConfigCompatibility,
    getConfigCompatibility,
    clearCompatibilityCache,
    checkAllConfigsCompatibility,
    confirmDeleteRunConfig,
    loadConfigToForm,
    smartMatchConfigToForm,
  };
}

