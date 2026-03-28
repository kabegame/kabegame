<template>
  <div class="plugin-defaults-panel">
    <p class="plugin-defaults-desc">{{ $t("settings.pluginDefaultsDesc") }}</p>
    <el-select
      v-model="selectedPluginId"
      class="plugin-defaults-select"
      filterable
      clearable
      :placeholder="$t('settings.pluginDefaultsSelectPlugin')"
    >
      <el-option
        v-for="p in plugins"
        :key="p.id"
        :label="pluginStore.pluginLabel(p.id)"
        :value="p.id"
      />
    </el-select>

    <div v-if="selectedPluginId" v-loading="loading" class="plugin-defaults-editor">
      <el-form label-position="top" class="plugin-defaults-form">
        <el-form-item v-if="!IS_ANDROID" :label="$t('plugins.outputDir')">
          <el-input v-model="form.outputDir" clearable :placeholder="$t('plugins.outputDirPlaceholder')">
            <template #append>
              <el-button @click="selectOutputDir">
                <el-icon>
                  <FolderOpened />
                </el-icon>
                {{ $t("common.chooseFolder") }}
              </el-button>
            </template>
          </el-input>
        </el-form-item>

        <template v-if="pluginVars.length > 0">
          <el-divider content-position="left">{{ $t("plugins.pluginConfig") }}</el-divider>
          <el-form-item
            v-for="varDef in visiblePluginVars"
            :key="varDef.key"
            :label="varDisplayName(varDef)"
          >
            <PluginVarField
              :type="varDef.type"
              :model-value="form.vars[varDef.key]"
              :options="optionsForVar(varDef)"
              :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
              :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
              :file-extensions="getFileExtensions(varDef)"
              :date-format="
                typeof varDef.format === 'string' && varDef.format.trim() !== '' ? varDef.format : undefined
              "
              :date-min="
                typeof varDef.dateMin === 'string' && varDef.dateMin.trim() !== '' ? varDef.dateMin : undefined
              "
              :date-max="
                typeof varDef.dateMax === 'string' && varDef.dateMax.trim() !== '' ? varDef.dateMax : undefined
              "
              :placeholder="
                varDescripts(varDef) ||
                (varDef.type === 'options' ||
                varDef.type === 'list' ||
                varDef.type === 'checkbox' ||
                varDef.type === 'date'
                  ? `请选择${varDisplayName(varDef)}`
                  : `请输入${varDisplayName(varDef)}`)
              "
              :allow-unset="true"
              @update:model-value="(val) => (form.vars[varDef.key] = val)"
            />
            <div v-if="varDescripts(varDef)" class="var-desc">{{ varDescripts(varDef) }}</div>
          </el-form-item>
        </template>

        <el-divider content-position="left">{{ $t("plugins.advancedSettings") }}</el-divider>
        <el-form-item :label="$t('plugins.httpHeaders')">
          <HttpHeadersEditor v-model="headersModel" />
        </el-form-item>

        <div class="plugin-defaults-actions">
          <el-button type="primary" :loading="saving" @click="handleSave">
            {{ $t("settings.pluginDefaultsSave") }}
          </el-button>
          <el-button :loading="resetting" @click="handleReset">
            {{ $t("settings.pluginDefaultsReset") }}
          </el-button>
        </div>
      </el-form>
    </div>

    <el-empty
      v-else-if="!loadingPlugins && plugins.length === 0"
      :description="$t('settings.pluginDefaultsNoPlugins')"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { FolderOpened } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { matchesPluginVarWhen } from "@kabegame/core/utils/pluginVarWhen";
import PluginVarField from "@kabegame/core/components/plugin/var-fields/PluginVarField.vue";
import HttpHeadersEditor from "@kabegame/core/components/crawler/HttpHeadersEditor.vue";
import { IS_ANDROID } from "@kabegame/core/env";

const { t } = useI18n();
const { varDisplayName, varDescripts, optionDisplayName } = usePluginConfigI18n();
const pluginStore = usePluginStore();

const {
  form,
  pluginVars,
  loadPluginVars,
  loadPluginVarDefs,
  expandVarsForBackend,
  normalizeVarsForUI,
  selectOutputDir,
  matchUserConfigFromDefaults,
} = usePluginConfig();

const selectedPluginId = ref("");
const headersModel = ref<Record<string, string>>({});
const loading = ref(false);
const saving = ref(false);
const resetting = ref(false);
const loadingPlugins = ref(true);

const plugins = computed(() => pluginStore.plugins);

const visiblePluginVars = computed(() =>
  pluginVars.value.filter((varDef) => matchesPluginVarWhen(varDef.when, form.value.vars)),
);

function optionsForVar(varDef: PluginVarDef) {
  return (varDef.options ?? []).map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );
}

function getFileExtensions(varDef: PluginVarDef): string[] | undefined {
  const opts = varDef.options;
  if (!Array.isArray(opts) || opts.length === 0) return undefined;
  const exts = opts
    .map((o) => (typeof o === "string" ? o : o.variable))
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? exts : undefined;
}

async function loadEditorForPlugin(pluginId: string) {
  if (!pluginId) return;
  loading.value = true;
  try {
    form.value.pluginId = pluginId;
    const { httpHeaders, outputDir } = await loadPluginVars(pluginId);
    headersModel.value = { ...httpHeaders };
    form.value.outputDir = outputDir;
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  if (!selectedPluginId.value) return;
  saving.value = true;
  try {
    const userConfig = expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]);
    const od = form.value.outputDir?.trim() ?? "";
    await invoke("save_plugin_default_config", {
      pluginId: selectedPluginId.value,
      config: {
        userConfig,
        httpHeaders: { ...headersModel.value },
        outputDir: od === "" ? null : od,
      },
    });
    ElMessage.success(t("settings.pluginDefaultsSaveSuccess"));
  } catch (e) {
    console.error(e);
    ElMessage.error(String(e));
  } finally {
    saving.value = false;
  }
}

async function handleReset() {
  if (!selectedPluginId.value) return;
  try {
    await ElMessageBox.confirm(
      t("settings.pluginDefaultsResetConfirm"),
      t("settings.pluginDefaultsReset"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  resetting.value = true;
  try {
    const json = await invoke<{
      userConfig?: Record<string, unknown>;
      httpHeaders?: Record<string, string>;
      outputDir?: string | null;
    }>("reset_plugin_default_config", { pluginId: selectedPluginId.value });
    await loadPluginVarDefs(selectedPluginId.value);
    const raw = (json?.userConfig && typeof json.userConfig === "object" ? json.userConfig : {}) as Record<
      string,
      any
    >;
    const matched = matchUserConfigFromDefaults(raw, pluginVars.value as PluginVarDef[]);
    form.value.vars = normalizeVarsForUI(matched, pluginVars.value as PluginVarDef[]);
    headersModel.value = { ...(json?.httpHeaders ?? {}) };
    form.value.outputDir = typeof json?.outputDir === "string" ? json.outputDir : "";
    ElMessage.success(t("common.save"));
  } catch (e) {
    console.error(e);
    ElMessage.error(String(e));
  } finally {
    resetting.value = false;
  }
}

watch(
  () => pluginStore.plugins,
  () => {
    loadingPlugins.value = false;
  },
  { immediate: true },
);

watch(selectedPluginId, (id) => {
  if (id) void loadEditorForPlugin(id);
  else {
    pluginVars.value = [];
    form.value.vars = {};
    headersModel.value = {};
  }
});

onMounted(async () => {
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("loadPlugins in settings", e);
  } finally {
    loadingPlugins.value = false;
  }
});
</script>

<style scoped lang="scss">
.plugin-defaults-panel {
  margin-top: 8px;
}

.plugin-defaults-desc {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-bottom: 16px;
  line-height: 1.5;
}

.plugin-defaults-select {
  width: 100%;
  max-width: 420px;
  margin-bottom: 16px;
}

.plugin-defaults-form {
  max-width: 640px;
}

.plugin-defaults-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.var-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
