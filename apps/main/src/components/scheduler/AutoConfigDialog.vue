<template>
  <el-dialog
    v-model="dialogVisible"
    :title="dialogTitle"
    width="600px"
    :append-to-body="true"
    class="auto-config-dialog task-params-dialog"
    destroy-on-close
    @closed="onDialogClosed"
  >
    <div v-if="showMissing" class="acd-missing">
      {{ t("autoConfig.configDeleted") }}
    </div>

    <AutoConfigDetailContent
      v-else-if="panelMode === 'view' && viewConfig"
      ref="detailRef"
      :key="viewConfig.id"
      :config="viewConfig"
    />

    <el-form v-else ref="formRef" label-position="top" class="acd-edit-form">
      <el-divider content-position="left">{{ t("autoConfig.basicInfo") }}</el-divider>
      <el-form-item :label="t('common.name')" required>
        <el-input v-model="name" maxlength="80" />
      </el-form-item>
      <el-form-item :label="t('common.description')">
        <el-input v-model="description" type="textarea" :rows="2" />
      </el-form-item>

      <el-divider content-position="left">{{ t("autoConfig.pluginAndParams") }}</el-divider>
      <el-form-item :label="t('plugins.selectSource')" required>
        <el-select
          v-model="form.pluginId"
          filterable
          :placeholder="t('plugins.selectSourcePlaceholder')"
          @change="onPluginChange"
        >
          <el-option
            v-for="plugin in pluginStore.plugins"
            :key="plugin.id"
            :label="pluginName(plugin.id)"
            :value="plugin.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="!IS_ANDROID" :label="t('plugins.outputDir')">
        <OutputDirSelect
          v-model="form.outputDir"
          :placeholder="t('plugins.outputDirPlaceholder')"
        />
      </el-form-item>

      <PluginVarsForm
        v-if="visiblePluginVars.length > 0"
        v-model="form.vars"
        :plugin-vars="visiblePluginVars"
        :var-display-name="varDisplayName"
        :var-descripts="varDescripts"
        :options-for-var="optionsForVar"
        :is-required="isRequired"
        :get-validation-rules="getValidationRules"
        :get-file-extensions="getFileExtensions"
      />

      <el-form-item :label="t('plugins.httpHeaders')">
        <HttpHeadersEditor v-model="headersModel" />
      </el-form-item>

      <section ref="scheduleSectionRef">
        <el-divider content-position="left">{{ t("autoConfig.schedule") }}</el-divider>
        <el-form-item :label="t('autoConfig.scheduleEnabled')">
          <el-switch v-model="scheduleEnabled" />
        </el-form-item>

        <template v-if="scheduleEnabled">
          <el-form-item :label="t('autoConfig.mode')">
            <el-radio-group v-model="scheduleMode">
              <el-radio value="interval">{{ t("autoConfig.modeInterval") }}</el-radio>
              <el-radio value="daily">{{ t("autoConfig.modeDaily") }}</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="scheduleMode === 'interval'" :label="t('autoConfig.modeInterval')">
            <div class="mode-line">
              <el-input-number v-model="intervalValue" :min="1" />
              <el-select v-model="intervalUnit">
                <el-option value="minutes" :label="t('autoConfig.unitMinutes')" />
                <el-option value="hours" :label="t('autoConfig.unitHours')" />
                <el-option value="days" :label="t('autoConfig.unitDays')" />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item v-if="scheduleMode === 'daily'" :label="t('autoConfig.modeDaily')">
            <div class="mode-line">
              <el-select v-model="dailyHour">
                <el-option :value="-1" :label="t('autoConfig.everyHour')" />
                <el-option
                  v-for="h in 24"
                  :key="`h-${h - 1}`"
                  :value="h - 1"
                  :label="`${String(h - 1).padStart(2, '0')}:xx`"
                />
              </el-select>
              <el-select v-model="dailyMinute">
                <el-option
                  v-for="m in 60"
                  :key="`m-${m - 1}`"
                  :value="m - 1"
                  :label="String(m - 1).padStart(2, '0')"
                />
              </el-select>
            </div>
          </el-form-item>

          <el-alert type="info" :closable="false" :title="schedulePreview" />
        </template>
      </section>
    </el-form>

    <template #footer>
      <template v-if="showMissing">
        <el-button @click="dialogStore.close()">{{ t("common.close") }}</el-button>
      </template>
      <template v-else-if="panelMode === 'view' && viewConfig">
        <el-button @click="copyFullJson">{{ t("autoConfig.detailCopyFullJson") }}</el-button>
        <el-button type="primary" @click="enterEdit">{{ t("autoConfig.edit") }}</el-button>
      </template>
      <template v-else-if="panelMode === 'edit' || dialogStore.isCreate">
        <el-button @click="handleEditCancel">
          {{ dialogStore.isCreate ? t("common.cancel") : t("autoConfig.detailBackToView") }}
        </el-button>
        <el-button type="primary" @click="handleSave">{{ t("common.save") }}</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "@kabegame/core/env";
import AutoConfigDetailContent from "@kabegame/core/components/scheduler/AutoConfigDetailContent.vue";
import OutputDirSelect from "@kabegame/core/components/crawler/OutputDirSelect.vue";
import PluginVarsForm from "@kabegame/core/components/crawler/PluginVarsForm.vue";
import HttpHeadersEditor from "@kabegame/core/components/crawler/HttpHeadersEditor.vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { matchesPluginVarWhen } from "@kabegame/core/utils/pluginVarWhen";
import type { RunConfig } from "@kabegame/core/stores/crawler";

const { t } = useI18n();
const { varDisplayName, varDescripts, optionDisplayName } = usePluginConfigI18n();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const dialogStore = useAutoConfigDialogStore();

const {
  form,
  formRef,
  pluginVars,
  isRequired,
  getValidationRules,
  loadPluginVarDefs,
  normalizeVarsForUI,
  expandVarsForBackend,
} = usePluginConfig();

const panelMode = ref<"view" | "edit">("view");
const detailRef = ref<InstanceType<typeof AutoConfigDetailContent> | null>(null);
const scheduleSectionRef = ref<HTMLElement | null>(null);

const name = ref("");
const description = ref("");
const scheduleEnabled = ref(false);
const scheduleMode = ref<"interval" | "daily">("interval");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const dailyHour = ref(-1);
const dailyMinute = ref(0);
const headersModel = ref<Record<string, string>>({});

const dialogVisible = computed({
  get: () => dialogStore.visible,
  set: (v: boolean) => {
    if (!v) dialogStore.close();
  },
});

useModalBack(dialogVisible);

const viewConfig = computed(() => {
  const id = dialogStore.configId;
  if (!id) return null;
  return crawlerStore.runConfigById(id) ?? null;
});

const showMissing = computed(
  () =>
    dialogStore.visible &&
    !dialogStore.isCreate &&
    panelMode.value === "view" &&
    dialogStore.configId &&
    !viewConfig.value,
);

const dialogTitle = computed(() => {
  if (dialogStore.isCreate) return t("autoConfig.create");
  if (panelMode.value === "view") return t("autoConfig.detailTitle");
  return t("autoConfig.edit");
});

const pluginName = (id: string) => pluginStore.pluginLabel(id);

const secondsByUnit = (unit: "minutes" | "hours" | "days") => {
  if (unit === "days") return 86400;
  if (unit === "hours") return 3600;
  return 60;
};

const optionsForVar = (varDef: PluginVarDef): (string | { name: string; variable: string })[] =>
  (varDef.options ?? []).map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );

const visiblePluginVars = computed(() =>
  pluginVars.value.filter((varDef) => matchesPluginVarWhen(varDef.when, form.value.vars)),
);

const getFileExtensions = (varDef: PluginVarDef): string[] | undefined => {
  const opts = varDef.options;
  if (!Array.isArray(opts)) return undefined;
  const exts = opts
    .map((o) => (typeof o === "string" ? o : o.variable))
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? exts : undefined;
};

const schedulePreview = computed(() => {
  if (!scheduleEnabled.value) return t("autoConfig.scheduleDisabled");
  if (scheduleMode.value === "interval") {
    const unitKey =
      intervalUnit.value === "days"
        ? "autoConfig.unitDays"
        : intervalUnit.value === "hours"
          ? "autoConfig.unitHours"
          : "autoConfig.unitMinutes";
    return t("autoConfig.intervalSummary", {
      n: intervalValue.value,
      unit: t(unitKey),
    });
  }
  if (dailyHour.value === -1) {
    return t("autoConfig.dailyHourly", { minute: String(dailyMinute.value).padStart(2, "0") });
  }
  return t("autoConfig.dailyAt", {
    hour: String(dailyHour.value).padStart(2, "0"),
    minute: String(dailyMinute.value).padStart(2, "0"),
  });
});

const loadFromConfig = async (cfg: RunConfig) => {
  name.value = String(cfg.name ?? "");
  description.value = cfg.description ?? "";
  form.value.pluginId = cfg.pluginId;
  form.value.outputDir = cfg.outputDir ?? "";
  await loadPluginVarDefs(cfg.pluginId);
  form.value.vars = normalizeVarsForUI(cfg.userConfig ?? {}, pluginVars.value as PluginVarDef[]);
  headersModel.value = { ...(cfg.httpHeaders ?? {}) };

  scheduleEnabled.value = !!cfg.scheduleEnabled;
  scheduleMode.value =
    cfg.scheduleMode === "interval" || cfg.scheduleMode === "daily" ? cfg.scheduleMode : "interval";
  if (cfg.scheduleMode === "interval") {
    const secs = Math.max(60, Number(cfg.scheduleIntervalSecs ?? 3600));
    if (secs % 86400 === 0) {
      intervalUnit.value = "days";
      intervalValue.value = Math.max(1, Math.round(secs / 86400));
    } else if (secs % 3600 === 0) {
      intervalUnit.value = "hours";
      intervalValue.value = Math.max(1, Math.round(secs / 3600));
    } else {
      intervalUnit.value = "minutes";
      intervalValue.value = Math.max(1, Math.round(secs / 60));
    }
  }
  if (cfg.scheduleMode === "daily") {
    dailyHour.value = Number(cfg.scheduleDailyHour ?? -1);
    dailyMinute.value = Number(cfg.scheduleDailyMinute ?? 0);
  }
};

const resetCreateForm = () => {
  name.value = "";
  description.value = "";
  scheduleEnabled.value = false;
  scheduleMode.value = "interval";
  intervalValue.value = 1;
  intervalUnit.value = "hours";
  dailyHour.value = -1;
  dailyMinute.value = 0;
  headersModel.value = {};
  form.value.pluginId = "";
  form.value.outputDir = "";
  form.value.vars = {};
  pluginVars.value = [];
};

const buildScheduleFields = () => {
  if (!scheduleEnabled.value) {
    return {
      scheduleEnabled: false,
      scheduleMode: undefined,
      scheduleIntervalSecs: undefined,
      scheduleDailyHour: undefined,
      scheduleDailyMinute: undefined,
      scheduleDelaySecs: undefined,
      schedulePlannedAt: undefined,
      scheduleLastRunAt: undefined,
    };
  }
  if (scheduleMode.value === "interval") {
    return {
      scheduleEnabled: true,
      scheduleMode: "interval" as const,
      scheduleIntervalSecs: Math.max(1, intervalValue.value) * secondsByUnit(intervalUnit.value),
      scheduleDailyHour: undefined,
      scheduleDailyMinute: undefined,
      scheduleDelaySecs: undefined,
      schedulePlannedAt: undefined,
      scheduleLastRunAt: undefined,
    };
  }
  return {
    scheduleEnabled: true,
    scheduleMode: "daily" as const,
    scheduleIntervalSecs: undefined,
    scheduleDailyHour: dailyHour.value,
    scheduleDailyMinute: dailyMinute.value,
    scheduleDelaySecs: undefined,
    schedulePlannedAt: undefined,
    scheduleLastRunAt: undefined,
  };
};

const onPluginChange = async (pluginId: string) => {
  form.value.pluginId = pluginId;
  if (!pluginId) {
    pluginVars.value = [];
    form.value.vars = {};
    return;
  }
  await loadPluginVarDefs(pluginId);
  form.value.vars = normalizeVarsForUI({}, pluginVars.value as PluginVarDef[]);
};

watch(
  () => scheduleMode.value,
  (mode) => {
    if (mode === "interval") {
      dailyHour.value = -1;
      dailyMinute.value = 0;
    } else {
      intervalValue.value = 1;
      intervalUnit.value = "hours";
    }
  },
);

watch(
  () => [dialogStore.visible, dialogStore.openGeneration] as const,
  async ([vis]) => {
    if (!vis) return;
    await crawlerStore.runConfigsReady;
    const create = dialogStore.isCreate;
    const id = dialogStore.configId;
    const initPanel = dialogStore.initialPanel;
    const scrollSched = dialogStore.scrollSchedule;
    panelMode.value = create ? "edit" : initPanel;
    await nextTick();
    if (create) {
      resetCreateForm();
    } else if (panelMode.value === "edit" && id) {
      const cfg = crawlerStore.runConfigById(id);
      if (cfg) await loadFromConfig(cfg);
    }
    await nextTick();
    if (scrollSched) {
      if (panelMode.value === "view") {
        detailRef.value?.scrollScheduleIntoView();
      } else {
        scheduleSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      dialogStore.clearScrollSchedule();
    }
  },
);

function onDialogClosed() {
  panelMode.value = "view";
}

const enterEdit = async () => {
  const id = dialogStore.configId;
  const cfg = id ? crawlerStore.runConfigById(id) : null;
  if (!cfg) {
    ElMessage.error(t("autoConfig.configDeleted"));
    return;
  }
  panelMode.value = "edit";
  await loadFromConfig(cfg);
  await nextTick();
  if (dialogStore.scrollSchedule) {
    scheduleSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
    dialogStore.clearScrollSchedule();
  }
};

const handleEditCancel = () => {
  if (dialogStore.isCreate) {
    dialogStore.close();
    return;
  }
  panelMode.value = "view";
};

const handleSave = async () => {
  if (!name.value.trim()) {
    ElMessage.warning(t("common.configNamePlaceholder"));
    return;
  }
  if (!form.value.pluginId) {
    ElMessage.warning(t("plugins.selectSourcePlaceholder"));
    return;
  }
  if (scheduleEnabled.value && !scheduleMode.value) {
    ElMessage.warning(t("autoConfig.needScheduleMode"));
    return;
  }
  if (formRef.value) {
    try {
      await formRef.value.validate();
    } catch {
      ElMessage.warning(t("plugins.fillRequired"));
      return;
    }
  }

  const userConfig = expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]);
  const schedule = buildScheduleFields();
  const payload = {
    name: name.value.trim(),
    description: description.value.trim() || undefined,
    pluginId: form.value.pluginId,
    url: "",
    outputDir: form.value.outputDir || undefined,
    userConfig,
    httpHeaders: { ...headersModel.value },
    ...schedule,
  };

  if (dialogStore.isCreate) {
    await crawlerStore.addRunConfig(payload);
    if (scheduleEnabled.value) {
      ElMessage.success(t("autoConfig.keepRunningHint"));
    } else {
      ElMessage.success(t("common.save"));
    }
    dialogStore.close();
    return;
  }

  const id = String(dialogStore.configId || "");
  const current = crawlerStore.runConfigs.find((item) => item.id === id);
  if (!current) {
    ElMessage.error(t("autoConfig.configDeleted"));
    dialogStore.close();
    return;
  }
  await crawlerStore.updateRunConfig({
    ...current,
    ...payload,
  });

  if (scheduleEnabled.value) {
    ElMessage.success(t("autoConfig.keepRunningHint"));
  } else {
    ElMessage.success(t("common.save"));
  }
  panelMode.value = "view";
};

async function copyFullJson() {
  const cfg = viewConfig.value;
  if (!cfg) return;
  const text = JSON.stringify(cfg, null, 2);
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    ElMessage.success(t("common.copySuccess"));
  } catch (e) {
    console.error(e);
    ElMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped lang="scss">
.acd-missing {
  padding: 24px;
  text-align: center;
  color: var(--anime-text-muted);
}

.acd-edit-form {
  max-height: min(72vh, 620px);
  overflow-y: auto;
  padding: 2px 0 4px;
}

.mode-line {
  display: flex;
  gap: 8px;
  width: 100%;
}

.mode-line > * {
  flex: 1;
}
</style>
