import { useCrawlerStore, type CrawlTask, type RunConfig, type TaskConfig } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import {
  expandVarsForBackend,
  matchUserConfigFromDefaults,
  normalizeVarsForUI,
  validateVarValue,
  type PluginVarDef,
} from "@/utils/pluginVarForm";
import { matchesPluginVarWhen, withCoercedOptions } from "@/utils/pluginVarWhen";
import { fetchPluginUserDefault, type PluginUserDefault } from "@/composables/usePluginConfig";

/**
 * 写入 task config 的入参：`pluginId` 必填，其余字段可缺省（缺省时按优先级回落）。
 */
export type TaskConfigInput = { pluginId: string } & Partial<Omit<TaskConfig, "pluginId">>;

/**
 * 只保留与 var 定义对齐且通过校验的字段；显式 `null` 原样保留，
 * 以便在下游 `matchUserConfigFromDefaults` 中抑制该 key 的默认值填充。
 */
function validSubset(raw: Record<string, any> | undefined, defs: PluginVarDef[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!raw) return out;
  const defMap = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(raw)) {
    const def = defMap.get(key);
    if (!def) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (value === undefined) continue;
    if (validateVarValue(value, def).valid) out[key] = value;
  }
  return out;
}

/**
 * 按优先级把入参补齐成完整 task config：
 * vars 逐 key 取 `入参 > 用户默认 > 插件声明默认`；`outputDir` / `httpHeaders` / `outputAlbumId` 整字段覆盖。
 * 纯函数，无副作用。
 */
export function resolveTaskConfig(
  input: TaskConfigInput,
  userDefault: PluginUserDefault | null,
  defs: PluginVarDef[],
): TaskConfig {
  const layered = {
    ...validSubset(userDefault?.userConfig, defs),
    ...validSubset(input.userConfig, defs),
  };
  return {
    pluginId: input.pluginId,
    userConfig: matchUserConfigFromDefaults(layered, defs),
    outputDir: input.outputDir ?? userDefault?.outputDir ?? "",
    httpHeaders: input.httpHeaders ?? userDefault?.httpHeaders ?? {},
    outputAlbumId: input.outputAlbumId ?? null,
  };
}

/** 任务 → 写入入参（通路 1「再次执行」） */
export function taskConfigFromTask(task: CrawlTask): TaskConfigInput {
  return {
    pluginId: task.pluginId,
    userConfig: task.userConfig ?? {},
    outputDir: task.outputDir ?? "",
    httpHeaders: task.httpHeaders ?? {},
    outputAlbumId: task.outputAlbumId ?? null,
  };
}

/** 自动任务配置 → 写入入参（通路 4「以此配置运行」，只取 task 部分，不带配置 id） */
export function taskConfigFromRunConfig(cfg: RunConfig): TaskConfigInput {
  return {
    pluginId: cfg.pluginId,
    userConfig: cfg.userConfig ?? {},
    outputDir: cfg.outputDir ?? "",
    httpHeaders: cfg.httpHeaders ?? {},
    outputAlbumId: cfg.outputAlbumId ?? null,
  };
}

/**
 * 按真实表单结构产出提交用 plugin config（后端格式）：
 * 选项回退 → 只保留当前可见字段 → 转后端格式；被隐藏字段不传给插件脚本。
 */
export function buildSubmitUserConfig(userConfig: Record<string, any>, defs: PluginVarDef[]): Record<string, any> {
  const effective = withCoercedOptions(normalizeVarsForUI(userConfig ?? {}, defs), defs);
  const visible = defs.filter((d) => matchesPluginVarWhen(d.when, effective));
  const picked = Object.fromEntries(visible.map((d) => [d.key, effective[d.key]]));
  return expandVarsForBackend(picked, visible);
}

/**
 * 唯一的 task config 写入口：读插件定义与用户默认配置，整体替换 store 值并递增 revision。
 * 调用方随后自行 `crawlerDrawerStore.open()`。
 */
export async function writeTaskConfig(input: TaskConfigInput | null): Promise<void> {
  const crawlerStore = useCrawlerStore();
  if (!input?.pluginId) {
    crawlerStore.setTaskConfig(null);
    return;
  }
  const pluginStore = usePluginStore();
  if (pluginStore.plugins.length === 0) {
    try {
      await pluginStore.loadPlugins();
    } catch {
      // 插件列表拉取失败时按「没有插件定义」处理，vars 为空
    }
  }
  const defs =
    (pluginStore.plugins.find((p) => p.id === input.pluginId)?.config?.vars as PluginVarDef[] | undefined) ?? [];
  const userDefault = await fetchPluginUserDefault(input.pluginId);
  crawlerStore.setTaskConfig(resolveTaskConfig(input, userDefault, defs));
}
