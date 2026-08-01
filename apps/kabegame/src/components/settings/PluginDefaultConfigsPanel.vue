<template>
  <div class="plugin-defaults-panel">
    <p class="plugin-defaults-desc">{{ $t("settings.pluginDefaultsDesc") }}</p>
    <PluginPickerField
      :model-value="selectedPluginId || null"
      class="plugin-defaults-select"
      clearable
      :placeholder="$t('settings.pluginDefaultsSelectPlugin')"
      @update:model-value="(value) => selectedPluginId = value ?? ''"
    />

    <div v-if="selectedPluginId" v-loading="loading" class="plugin-defaults-editor">
      <el-form label-position="top" class="plugin-defaults-form">
        <template v-if="pluginVars.length > 0">
          <el-divider content-position="left">{{ $t("plugins.pluginConfig") }}</el-divider>
          <PluginVarsForm v-model="form.vars" :plugin-vars="visiblePluginVars" allow-unset-all />
        </template>

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
import { ElMessageBox } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { useI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { usePluginConfig } from "@/composables/usePluginConfig";
import {
  matchesPluginVarWhen,
  coerceOptionsVarsToVisibleChoices,
} from "@kabegame/core/utils/pluginVarWhen";
import {
  expandVarsForBackend,
  normalizeVarsForUI,
  matchUserConfigFromDefaults,
  type PluginVarDef,
} from "@kabegame/core/utils/pluginVarForm";
import PluginVarsForm from "@kabegame/core/components/crawler/PluginVarsForm.vue";
import PluginPickerField from "@/components/PluginPickerField.vue";

const { t } = useI18n();
const pluginStore = usePluginStore();

const {
  form,
  pluginVars,
  loadPluginVars,
  loadPluginVarDefs,
} = usePluginConfig();

const selectedPluginId = ref("");
/** 面板不显示的两个字段：保存/重置时原样回写，不能用面板输入清掉用户已有的默认值 */
const keptHttpHeaders = ref<Record<string, string>>({});
const keptOutputDir = ref("");
const loading = ref(false);
const saving = ref(false);
const resetting = ref(false);
const loadingPlugins = ref(true);

const plugins = computed(() => pluginStore.plugins);

const visiblePluginVars = computed(() =>
  pluginVars.value.filter((varDef) => matchesPluginVarWhen(varDef.when, form.value.vars)),
);

async function loadEditorForPlugin(pluginId: string) {
  if (!pluginId) return;
  loading.value = true;
  // 先清空再读：loadPluginVars 抛错时不能让上一个插件的值留在 kept ref 里，
  // 否则保存会把上一个插件的输出目录/请求头写进当前插件的默认配置
  keptHttpHeaders.value = {};
  keptOutputDir.value = "";
  try {
    form.value.pluginId = pluginId;
    const { httpHeaders, outputDir } = await loadPluginVars(pluginId);
    keptHttpHeaders.value = { ...httpHeaders };
    keptOutputDir.value = outputDir;
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  if (!selectedPluginId.value) return;
  saving.value = true;
  try {
    const userConfig = expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]);
    const od = keptOutputDir.value.trim();
    await invoke("save_plugin_default_config", {
      pluginId: selectedPluginId.value,
      config: {
        userConfig,
        httpHeaders: { ...keptHttpHeaders.value },
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
    keptHttpHeaders.value = { ...(json?.httpHeaders ?? {}) };
    keptOutputDir.value = typeof json?.outputDir === "string" ? json.outputDir : "";
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
    keptHttpHeaders.value = {};
    keptOutputDir.value = "";
  }
});

watch(
  () => form.value.vars,
  () => {
    coerceOptionsVarsToVisibleChoices(pluginVars.value, form.value.vars);
  },
  { deep: true },
);

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
</style>
