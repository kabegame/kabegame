<template>
  <div class="mt-2">
    <p class="m-0 mb-4 text-[13px] leading-[1.5] text-kb-fg-muted">{{ $t("settings.pluginDefaultsDesc") }}</p>
    <PluginPickerField
      :model-value="selectedPluginId || null"
      class="mb-4 w-full max-w-[420px]"
      clearable
      :placeholder="$t('settings.pluginDefaultsSelectPlugin')"
      :select-trigger="IS_ANDROID"
      @update:model-value="(value) => (selectedPluginId = value ?? '')"
    />

    <div v-if="selectedPluginId" v-loading="loading" class="flex max-w-[640px] flex-col gap-3">
      <template v-if="pluginVars.length > 0">
        <SectionTitle>{{ $t("plugins.pluginConfig") }}</SectionTitle>
        <PluginVarsForm v-model="form.vars" :plugin-vars="pluginVars" ignore-required ignore-when />
      </template>

      <div class="mt-2 flex gap-3">
        <Button variant="primary" :disabled="saving || resetting" @click="handleSave">
          <Spinner v-if="saving" :size="14" />
          {{ $t("settings.pluginDefaultsSave") }}
        </Button>
        <Button :disabled="saving || resetting" @click="handleReset">
          <Spinner v-if="resetting" :size="14" />
          {{ $t("settings.pluginDefaultsReset") }}
        </Button>
      </div>
    </div>

    <Empty v-else-if="!loadingPlugins && plugins.length === 0" :description="$t('settings.pluginDefaultsNoPlugins')" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { kameMessage } from "@/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { IS_ANDROID } from "@/env";
import { useI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { usePluginConfig } from "@/composables/usePluginConfig";
import {
  expandVarsForBackend,
  normalizeVarsForUI,
  matchUserConfigFromDefaults,
  type PluginVarDef,
} from "@/utils/pluginVarForm";
import PluginVarsForm from "@/components/crawler/PluginVarsForm.vue";
import { useForm } from "@/components/ui/form";
import PluginPickerField from "@/components/PluginPickerField.vue";
import { messageBox } from "@/components/ui/messageBox";
import { vLoading } from "@/components/ui/loading";
import Button from "@/components/ui/Button.vue";
import Empty from "@/components/ui/Empty.vue";
import SectionTitle from "@/components/ui/SectionTitle.vue";
import Spinner from "@/components/ui/Spinner.vue";

const { t } = useI18n();
const pluginStore = usePluginStore();

const { form, pluginVars, loadPluginVars, loadPluginVarDefs } = usePluginConfig();
/** 整个面板的校验：PluginVarsForm 的每个 Field 注册在这里 */
const validation = useForm();

const selectedPluginId = ref("");
/** 面板不显示的两个字段：保存/重置时原样回写，不能用面板输入清掉用户已有的默认值 */
const keptHttpHeaders = ref<Record<string, string>>({});
const keptOutputDir = ref("");
const loading = ref(false);
const saving = ref(false);
const resetting = ref(false);
const loadingPlugins = ref(true);

const plugins = computed(() => pluginStore.plugins);

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
  if (!validation.validate()) {
    kameMessage.warning(t("plugins.fillRequired"));
    return;
  }
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
    kameMessage.success(t("settings.pluginDefaultsSaveSuccess"));
  } catch (e) {
    console.error(e);
    kameMessage.error(String(e));
  } finally {
    saving.value = false;
  }
}

async function handleReset() {
  if (!selectedPluginId.value) return;
  try {
    await messageBox.confirm(t("settings.pluginDefaultsResetConfirm"), t("settings.pluginDefaultsReset"), {
      type: "warning",
    });
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
    const raw = (json?.userConfig && typeof json.userConfig === "object" ? json.userConfig : {}) as Record<string, any>;
    const matched = matchUserConfigFromDefaults(raw, pluginVars.value as PluginVarDef[]);
    form.value.vars = normalizeVarsForUI(matched, pluginVars.value as PluginVarDef[]);
    keptHttpHeaders.value = { ...(json?.httpHeaders ?? {}) };
    keptOutputDir.value = typeof json?.outputDir === "string" ? json.outputDir : "";
    kameMessage.success(t("common.save"));
  } catch (e) {
    console.error(e);
    kameMessage.error(String(e));
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
