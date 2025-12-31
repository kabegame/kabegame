<template>
  <el-dialog v-model="visible" title="开始导入图片" width="600px" :close-on-click-modal="false"
    class="crawl-dialog" :show-close="true">
    <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
      <el-form-item label="运行配置">
        <el-select v-model="selectedRunConfigId" placeholder="选择配置（可选）" style="width: 100%" clearable
          popper-class="run-config-select-dropdown">
          <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="cfg.name" :value="cfg.id">
            <div class="run-config-option">
              <div class="run-config-info">
                <div class="name">
                  <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false" type="danger"
                    size="small" style="margin-right: 6px;">
                    不兼容
                  </el-tag>
                  <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false"
                    type="warning" size="small" style="margin-right: 6px;">
                    不兼容
                  </el-tag>
                  {{ cfg.name }}
                  <span v-if="cfg.description" class="desc"> - {{ cfg.description }}</span>
                </div>
              </div>
              <div class="run-config-actions">
                <el-button type="primary" link size="small" @click.stop="handleLoadConfig(cfg.id)">
                  载入
                </el-button>
                <el-button type="danger" link size="small" @click.stop="handleDeleteConfig(cfg.id)">
                  删除
                </el-button>
              </div>
            </div>
          </el-option>
        </el-select>
        <div class="config-hint">
          兼容的配置：可直接选择并一键运行（表单会锁定）；不兼容的配置：会在此处提示，且只能"载入到表单"后手动编辑运行
        </div>
      </el-form-item>
      <el-form-item label="选择源">
        <el-select v-model="form.pluginId" :disabled="!!selectedRunConfigId" placeholder="请选择源"
          style="width: 100%" popper-class="crawl-plugin-select-dropdown">
          <el-option v-for="plugin in enabledPlugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
            <div class="plugin-option">
              <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]" class="plugin-option-icon" />
              <el-icon v-else class="plugin-option-icon-placeholder">
                <Grid />
              </el-icon>
              <span>{{ plugin.name }}</span>
            </div>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item label="输出目录">
        <el-input v-model="form.outputDir" :disabled="!!selectedRunConfigId" placeholder="留空使用默认目录，或输入自定义路径"
          clearable>
          <template #append>
            <el-button @click="selectOutputDir" :disabled="!!selectedRunConfigId">
              <el-icon>
                <FolderOpened />
              </el-icon>
              选择
            </el-button>
          </template>
        </el-input>
      </el-form-item>

      <!-- 插件变量配置 -->
      <template v-if="pluginVars.length > 0">
        <el-divider content-position="left">插件配置</el-divider>
        <el-form-item v-for="varDef in pluginVars" :key="varDef.key" :label="varDef.name"
          :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef)">
          <el-input-number v-if="varDef.type === 'int' || varDef.type === 'float'" v-model="form.vars[varDef.key]"
            :min="varDef.min !== undefined ? varDef.min : undefined"
            :max="varDef.max !== undefined ? varDef.max : undefined" :disabled="!!selectedRunConfigId"
            :placeholder="varDef.descripts || `请输入${varDef.name}`" style="width: 100%" />
          <el-select v-else-if="varDef.type === 'options'" v-model="form.vars[varDef.key]"
            :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%"
            :disabled="!!selectedRunConfigId">
            <el-option v-for="option in varDef.options" :key="optionValue(option)" :label="optionLabel(option)"
              :value="optionValue(option)" />
          </el-select>
          <el-switch v-else-if="varDef.type === 'boolean'" v-model="form.vars[varDef.key]" />
          <el-select v-else-if="varDef.type === 'list'" v-model="form.vars[varDef.key]" multiple
            :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%"
            :disabled="!!selectedRunConfigId">
            <el-option v-for="option in varDef.options" :key="optionValue(option)" :label="optionLabel(option)"
              :value="optionValue(option)" />
          </el-select>
          <el-checkbox-group v-else-if="varDef.type === 'checkbox'" v-model="form.vars[varDef.key]"
            :disabled="!!selectedRunConfigId">
            <el-checkbox v-for="option in (varDef.options || [])" :key="optionValue(option)"
              :label="optionValue(option)">
              {{ optionLabel(option) }}
            </el-checkbox>
          </el-checkbox-group>
          <el-input v-else-if="varDef.type === 'file'" v-model="form.vars[varDef.key]"
            :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable :disabled="!!selectedRunConfigId">
            <template #append>
              <el-button @click="() => selectFile(varDef.key)" :disabled="!!selectedRunConfigId">
                <el-icon>
                  <FolderOpened />
                </el-icon>
                选择文件
              </el-button>
            </template>
          </el-input>
          <el-input v-else-if="varDef.type === 'path' || varDef.type === 'folder'" v-model="form.vars[varDef.key]"
            :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable :disabled="!!selectedRunConfigId">
            <template #append>
              <el-button @click="() => selectFolder(varDef.key)" :disabled="!!selectedRunConfigId">
                <el-icon>
                  <FolderOpened />
                </el-icon>
                选择
              </el-button>
            </template>
          </el-input>
          <el-input v-else v-model="form.vars[varDef.key]" :placeholder="varDef.descripts || `请输入${varDef.name}`"
            style="width: 100%" :disabled="!!selectedRunConfigId" />
          <div v-if="varDef.descripts">
            {{ varDef.descripts }}
          </div>
        </el-form-item>
      </template>

      <el-divider content-position="left">保存为配置（可选）</el-divider>
      <el-form-item>
        <el-checkbox v-model="saveAsConfig" :disabled="!!selectedRunConfigId">保存为配置（下次再使用啦）</el-checkbox>
      </el-form-item>
      <el-form-item label="配置名称" v-if="saveAsConfig">
        <el-input v-model="configName" placeholder="请输入配置名称" />
      </el-form-item>
      <el-form-item label="配置描述" v-if="saveAsConfig">
        <el-input v-model="configDescription" placeholder="可选：配置说明" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" @click="handleStartCrawl" :loading="isCrawling"
        :disabled="!selectedRunConfigId && !form.pluginId">
        开始收集
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { FolderOpened, Grid } from "@element-plus/icons-vue";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { useConfigCompatibility, type ConfigCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage } from "element-plus";

interface Props {
  modelValue: boolean;
  pluginIcons: Record<string, string>;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "started"): void;
}>();

const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const enabledPlugins = computed(() => pluginStore.plugins.filter((p) => p.enabled));
const runConfigs = computed(() => crawlerStore.runConfigs);
const isCrawling = computed(() => crawlerStore.isCrawling);

// 使用插件配置 composable
const pluginConfig = usePluginConfig();
const {
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
} = pluginConfig;

// 使用配置兼容性 composable
const {
  configCompatibilityStatus,
  loadConfigToForm,
  confirmDeleteRunConfig,
  checkAllConfigsCompatibility,
} = useConfigCompatibility(
  pluginVars,
  form,
  selectedRunConfigId,
  loadPluginVars,
  normalizeVarsForUI,
  isRequired,
  visible
);

// 处理载入配置
const handleLoadConfig = async (configId: string) => {
  await loadConfigToForm(configId);
};

// 处理删除配置
const handleDeleteConfig = async (configId: string) => {
  await confirmDeleteRunConfig(configId);
};

// 开始收集
const handleStartCrawl = async () => {
  try {
    // 若选择了运行配置，直接运行配置
    if (selectedRunConfigId.value) {
      await crawlerStore.runConfig(selectedRunConfigId.value);
      visible.value = false;
      emit("started");
      return;
    }

    if (!form.value.pluginId) {
      ElMessage.warning("请选择源");
      return;
    }

    // 验证表单
    if (formRef.value) {
      try {
        await formRef.value.validate();
      } catch (error) {
        ElMessage.warning("请填写所有必填项");
        return;
      }
    }

    // 手动验证必填的插件配置项
    for (const varDef of pluginVars.value) {
      if (isRequired(varDef)) {
        const value = form.value.vars[varDef.key];
        if (value === undefined || value === null || value === '' ||
          ((varDef.type === 'list' || varDef.type === 'checkbox') && Array.isArray(value) && value.length === 0)) {
          ElMessage.warning(`请填写必填项：${varDef.name}`);
          return;
        }
      }
    }

    // 运行/保存配置时，userConfig 统一传对象（至少是 {}），避免"预设保存后 userConfig 为空导致后端未注入变量"
    const backendVars =
      pluginVars.value.length > 0
        ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[])
        : undefined;

    // 保存用户配置（如果有变量定义）
    if (pluginVars.value.length > 0 && backendVars && Object.keys(backendVars).length > 0) {
      await invoke("save_plugin_config", {
        pluginId: form.value.pluginId,
        config: backendVars,
      });
    }

    // 可选：保存为运行配置（不影响本次直接运行）
    if (saveAsConfig.value) {
      if (!configName.value.trim()) {
        ElMessage.warning("请输入配置名称");
        return;
      }
      await crawlerStore.addRunConfig({
        name: configName.value.trim(),
        description: configDescription.value?.trim() || undefined,
        pluginId: form.value.pluginId,
        url: "",
        outputDir: form.value.outputDir || undefined,
        userConfig: backendVars,
      });
    }

    // 添加任务（异步执行，不等待完成）
    crawlerStore.addTask(
      form.value.pluginId,
      "",
      form.value.outputDir || undefined,
      backendVars
    ).catch(error => {
      // 这里的错误是任务初始化失败，由 watch 监听来处理任务状态变化时的错误显示
      console.error("任务执行失败:", error);
    });

    // 重置表单
    resetForm();
    // 关闭对话框
    visible.value = false;
    emit("started");
  } catch (error) {
    console.error("添加任务失败:", error);
    // 只处理添加任务时的错误（如保存配置失败），执行错误由 watch 处理
    ElMessage.error(error instanceof Error ? error.message : "添加任务失败");
  }
};

// 监听对话框打开，刷新插件列表和兼容性
watch(visible, async (open) => {
  if (!open) return;
  // 刷新已安装源列表
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
  }

  if (form.value.pluginId) {
    await loadPluginVars(form.value.pluginId);
  }

  await checkAllConfigsCompatibility();
});

// 监听插件选择变化
watch(() => form.value.pluginId, (newPluginId) => {
  if (newPluginId) {
    loadPluginVars(newPluginId);
  } else {
    pluginVars.value = [];
    form.value.vars = {};
  }
});

// 监听运行配置选择变化
watch(selectedRunConfigId, async (cfgId) => {
  if (!cfgId) {
    return;
  }

  const cfg = runConfigs.value.find(c => c.id === cfgId);
  if (!cfg) {
    ElMessage.warning("运行配置不存在，请重新选择");
    selectedRunConfigId.value = null;
    return;
  }

  // 检查兼容性
  const compatibility = configCompatibilityStatus.value[cfgId];
  if (compatibility && (!compatibility.versionCompatible || !compatibility.contentCompatible)) {
    selectedRunConfigId.value = null;
    await loadConfigToForm(cfgId);
    return;
  }

  // 兼容的配置，直接设置表单
  saveAsConfig.value = false;
  configName.value = "";
  configDescription.value = "";

  form.value.pluginId = cfg.pluginId;
  form.value.outputDir = cfg.outputDir || "";
  form.value.vars = {};

  await loadPluginVars(cfg.pluginId);

  const userConfig = cfg.userConfig || {};
  const matchedVars: Record<string, any> = {};
  const varDefMap = new Map(pluginVars.value.map(def => [def.key, def]));

  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);
    if (!varDef) continue;
    matchedVars[key] = value;
  }

  for (const varDef of pluginVars.value) {
    if (!(varDef.key in matchedVars) && varDef.default !== undefined) {
      matchedVars[varDef.key] = varDef.default;
    }
  }

  const cfgUiVars = normalizeVarsForUI(matchedVars, pluginVars.value as PluginVarDef[]);
  form.value.vars = cfgUiVars;
});
</script>

<style lang="scss" scoped>
.crawl-form {
  margin-bottom: 20px;

  :deep(.el-form-item__label) {
    color: var(--anime-text-primary);
    font-weight: 500;
  }
}

.config-hint {
  font-size: 12px;
  color: var(--anime-text-secondary);
  margin-top: 4px;
}

.plugin-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-option-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}

.plugin-option-icon-placeholder {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--anime-text-secondary);
}

.run-config-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 32px;
  width: 100%;
}

.run-config-info {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;

  .name {
    font-weight: 600;
    color: var(--el-text-color-primary);
    line-height: 1.4;
    display: flex;
    align-items: center;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    .desc {
      font-size: 12px;
      color: var(--el-text-color-secondary);
      font-weight: normal;
      margin-left: 4px;
    }
  }
}

.run-config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  align-self: flex-start;
  padding-top: 2px;
}
</style>

<style lang="scss">
.crawl-dialog.el-dialog {
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin-top: 5vh !important;
  margin-bottom: 5vh !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    max-height: none !important;
  }

  .el-dialog__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);
  }
}

.crawl-plugin-select-dropdown {
  .el-select-dropdown__item {
    padding: 8px 12px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .plugin-option-icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 4px;
  }

  .plugin-option-icon-placeholder {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--anime-text-secondary);
  }

  .plugin-option span {
    line-height: 1.2;
    color: var(--anime-text-primary);
  }
}

.run-config-select-dropdown {
  .el-select-dropdown__item {
    padding: 6px 12px;
    min-height: 40px;
  }

  .run-config-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 32px;
    width: 100%;
  }

  .run-config-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;

    .name {
      font-weight: 600;
      color: var(--el-text-color-primary);
      line-height: 1.4;
      display: flex;
      align-items: center;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .desc {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        font-weight: normal;
        margin-left: 4px;
      }
    }
  }

  .run-config-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    align-self: flex-start;
    padding-top: 2px;
  }
}
</style>

