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

      <section ref="scheduleSectionRef" class="acd-schedule-section">
        <el-divider content-position="left">{{ t("autoConfig.schedule") }}</el-divider>
        <el-form-item :label="t('autoConfig.scheduleEnabled')">
          <el-switch v-model="scheduleEnabled" />
        </el-form-item>

        <div
          v-if="showScheduleDetailFields"
          class="acd-schedule-fields"
          :class="{ 'acd-schedule-fields--readonly': scheduleFieldsReadonly }"
        >
          <el-form-item :label="t('autoConfig.mode')">
            <el-radio-group v-model="scheduleMode" :disabled="scheduleFieldsReadonly">
              <el-radio value="interval">{{ t("autoConfig.modeInterval") }}</el-radio>
              <el-radio value="daily">{{ t("autoConfig.modeDaily") }}</el-radio>
              <el-radio value="weekly">{{ t("autoConfig.modeWeekly") }}</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="scheduleMode === 'interval'" :label="t('autoConfig.modeInterval')">
            <div class="mode-line">
              <el-input-number v-model="intervalValue" :min="1" :disabled="scheduleFieldsReadonly" />
              <el-select v-model="intervalUnit" :disabled="scheduleFieldsReadonly">
                <el-option value="minutes" :label="t('autoConfig.unitMinutes')" />
                <el-option value="hours" :label="t('autoConfig.unitHours')" />
                <el-option value="days" :label="t('autoConfig.unitDays')" />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item v-if="scheduleMode === 'daily'" :label="t('autoConfig.modeDaily')">
            <div class="mode-line">
              <el-select v-model="dailyHour" :disabled="scheduleFieldsReadonly">
                <el-option :value="-1" :label="t('autoConfig.everyHour')" />
                <el-option
                  v-for="h in 24"
                  :key="`h-${h - 1}`"
                  :value="h - 1"
                  :label="`${String(h - 1).padStart(2, '0')}:xx`"
                />
              </el-select>
              <el-select v-model="dailyMinute" :disabled="scheduleFieldsReadonly">
                <el-option
                  v-for="m in 60"
                  :key="`m-${m - 1}`"
                  :value="m - 1"
                  :label="String(m - 1).padStart(2, '0')"
                />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item v-if="scheduleMode === 'weekly'" :label="t('autoConfig.modeWeekly')">
            <div class="mode-line">
              <el-select v-model="weeklyWeekday" :disabled="scheduleFieldsReadonly">
                <el-option
                  v-for="wd in 7"
                  :key="`wd-${wd - 1}`"
                  :value="wd - 1"
                  :label="t(`autoConfig.weekday${wd - 1}`)"
                />
              </el-select>
              <el-select v-model="dailyHour" :disabled="scheduleFieldsReadonly">
                <el-option
                  v-for="h in 24"
                  :key="`wh-${h - 1}`"
                  :value="h - 1"
                  :label="`${String(h - 1).padStart(2, '0')}:xx`"
                />
              </el-select>
              <el-select v-model="dailyMinute" :disabled="scheduleFieldsReadonly">
                <el-option
                  v-for="m in 60"
                  :key="`wm-${m - 1}`"
                  :value="m - 1"
                  :label="String(m - 1).padStart(2, '0')"
                />
              </el-select>
            </div>
          </el-form-item>

          <el-alert type="info" :closable="false" :title="schedulePreview" />
          <ScheduleProgressBar
            v-if="editScheduleProgressConfig"
            :config="editScheduleProgressConfig"
            class="acd-schedule-progress"
          />
        </div>
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
import ScheduleProgressBar from "@kabegame/core/components/scheduler/ScheduleProgressBar.vue";
import OutputDirSelect from "@kabegame/core/components/crawler/OutputDirSelect.vue";
import PluginVarsForm from "@kabegame/core/components/crawler/PluginVarsForm.vue";
import HttpHeadersEditor from "@kabegame/core/components/crawler/HttpHeadersEditor.vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import {
  matchesPluginVarWhen,
  filterVarOptionsByWhen,
  coerceOptionsVarsToVisibleChoices,
} from "@kabegame/core/utils/pluginVarWhen";
import type { RunConfig, ScheduleSpec } from "@kabegame/core/stores/crawler";

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
  loadPluginVars,
  normalizeVarsForUI,
  expandVarsForBackend,
} = usePluginConfig();

const panelMode = ref<"view" | "edit">("view");
const detailRef = ref<InstanceType<typeof AutoConfigDetailContent> | null>(null);
const scheduleSectionRef = ref<HTMLElement | null>(null);

const name = ref("");
const description = ref("");
const scheduleEnabled = ref(false);
const scheduleMode = ref<"interval" | "daily" | "weekly">("interval");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const dailyHour = ref(-1);
const dailyMinute = ref(0);
/** 0=周一 … 6=周日 */
const weeklyWeekday = ref(0);
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

/** 定时已关但后端仍有 mode 时仍展示表单项（只读灰色）；新建且未启用则不展示 */
const showScheduleDetailFields = computed(() => {
  if (scheduleEnabled.value) return true;
  if (dialogStore.isCreate) return false;
  const id = dialogStore.configId;
  const c = id ? crawlerStore.runConfigById(id) : undefined;
  return (
    c?.scheduleSpec?.mode === "interval" ||
    c?.scheduleSpec?.mode === "daily" ||
    c?.scheduleSpec?.mode === "weekly"
  );
});

const scheduleFieldsReadonly = computed(
  () => !scheduleEnabled.value && showScheduleDetailFields.value,
);

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

const optionsForVar = (varDef: PluginVarDef): (string | { name: string; variable: string })[] => {
  const filtered = filterVarOptionsByWhen(varDef.options, form.value.vars);
  return filtered.map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );
};

const visiblePluginVars = computed(() =>
  pluginVars.value.filter((varDef) => matchesPluginVarWhen(varDef.when, form.value.vars)),
);

watch(
  () => form.value.vars,
  () => {
    coerceOptionsVarsToVisibleChoices(pluginVars.value as PluginVarDef[], form.value.vars);
  },
  { deep: true },
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
  if (scheduleMode.value === "weekly") {
    const wd = Math.min(6, Math.max(0, weeklyWeekday.value));
    return t("autoConfig.weeklyAt", {
      weekday: t(`autoConfig.weekday${wd}`),
      hour: String(dailyHour.value).padStart(2, "0"),
      minute: String(dailyMinute.value).padStart(2, "0"),
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
  const spec = cfg.scheduleSpec;
  scheduleMode.value =
    spec?.mode === "interval" || spec?.mode === "daily" || spec?.mode === "weekly"
      ? spec.mode
      : "interval";
  weeklyWeekday.value = 0;
  if (spec?.mode === "interval") {
    const secs = Math.max(60, Number(spec.intervalSecs ?? 3600));
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
  if (spec?.mode === "daily") {
    dailyHour.value = Number(spec.hour ?? -1);
    dailyMinute.value = Number(spec.minute ?? 0);
  }
  if (spec?.mode === "weekly") {
    weeklyWeekday.value = Math.min(6, Math.max(0, Number(spec.weekday ?? 0)));
    dailyHour.value = Math.min(23, Math.max(0, Number(spec.hour ?? 0)));
    dailyMinute.value = Math.min(59, Math.max(0, Number(spec.minute ?? 0)));
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
  weeklyWeekday.value = 0;
  headersModel.value = {};
  form.value.pluginId = "";
  form.value.outputDir = "";
  form.value.vars = {};
  pluginVars.value = [];
};

const buildScheduleFields = (): Pick<
  RunConfig,
  "scheduleEnabled" | "scheduleSpec" | "schedulePlannedAt" | "scheduleLastRunAt"
> => {
  if (!scheduleEnabled.value) {
    if (dialogStore.isCreate) {
      return {
        scheduleEnabled: false,
        scheduleSpec: undefined,
        schedulePlannedAt: undefined,
        scheduleLastRunAt: undefined,
      };
    }
    const id = dialogStore.configId;
    const cur = id ? crawlerStore.runConfigById(id) : undefined;
    const curSpec = cur?.scheduleSpec;
    if (
      !cur ||
      !curSpec ||
      (curSpec.mode !== "interval" &&
        curSpec.mode !== "daily" &&
        curSpec.mode !== "weekly")
    ) {
      return {
        scheduleEnabled: false,
        scheduleSpec: undefined,
        schedulePlannedAt: undefined,
        scheduleLastRunAt: undefined,
      };
    }
    if (scheduleMode.value === "interval") {
      const scheduleSpec: ScheduleSpec = {
        mode: "interval",
        intervalSecs: Math.max(1, intervalValue.value) * secondsByUnit(intervalUnit.value),
      };
      return {
        scheduleEnabled: false,
        scheduleSpec,
        schedulePlannedAt: cur.schedulePlannedAt,
        scheduleLastRunAt: cur.scheduleLastRunAt,
      };
    }
    if (scheduleMode.value === "weekly") {
      const scheduleSpec: ScheduleSpec = {
        mode: "weekly",
        weekday: Math.min(6, Math.max(0, weeklyWeekday.value)),
        hour: Math.min(23, Math.max(0, dailyHour.value)),
        minute: Math.min(59, Math.max(0, dailyMinute.value)),
      };
      return {
        scheduleEnabled: false,
        scheduleSpec,
        schedulePlannedAt: cur.schedulePlannedAt,
        scheduleLastRunAt: cur.scheduleLastRunAt,
      };
    }
    const scheduleSpec: ScheduleSpec = {
      mode: "daily",
      hour: dailyHour.value,
      minute: dailyMinute.value,
    };
    return {
      scheduleEnabled: false,
      scheduleSpec,
      schedulePlannedAt: cur.schedulePlannedAt,
      scheduleLastRunAt: cur.scheduleLastRunAt,
    };
  }
  if (scheduleMode.value === "interval") {
    const scheduleSpec: ScheduleSpec = {
      mode: "interval",
      intervalSecs: Math.max(1, intervalValue.value) * secondsByUnit(intervalUnit.value),
    };
    return {
      scheduleEnabled: true,
      scheduleSpec,
      schedulePlannedAt: undefined,
      scheduleLastRunAt: undefined,
    };
  }
  if (scheduleMode.value === "weekly") {
    const scheduleSpec: ScheduleSpec = {
      mode: "weekly",
      weekday: Math.min(6, Math.max(0, weeklyWeekday.value)),
      hour: Math.min(23, Math.max(0, dailyHour.value)),
      minute: Math.min(59, Math.max(0, dailyMinute.value)),
    };
    return {
      scheduleEnabled: true,
      scheduleSpec,
      schedulePlannedAt: undefined,
      scheduleLastRunAt: undefined,
    };
  }
  const scheduleSpec: ScheduleSpec = {
    mode: "daily",
    hour: dailyHour.value,
    minute: dailyMinute.value,
  };
  return {
    scheduleEnabled: true,
    scheduleSpec,
    schedulePlannedAt: undefined,
    scheduleLastRunAt: undefined,
  };
};

/** 编辑态：表单定时字段 + 后端 planned/lastRun，供倒计时条（周期变化时进度仍以服务端计划为准） */
const editScheduleProgressConfig = computed((): RunConfig | null => {
  if (panelMode.value !== "edit" || dialogStore.isCreate || !scheduleEnabled.value) return null;
  const id = dialogStore.configId;
  if (!id) return null;
  const base = crawlerStore.runConfigById(id);
  if (!base) return null;
  const draft = buildScheduleFields();
  return {
    ...base,
    scheduleEnabled: draft.scheduleEnabled,
    scheduleSpec: draft.scheduleSpec,
    schedulePlannedAt: base.schedulePlannedAt,
    scheduleLastRunAt: base.scheduleLastRunAt,
  };
});

const onPluginChange = async (pluginId: string) => {
  form.value.pluginId = pluginId;
  if (!pluginId) {
    pluginVars.value = [];
    form.value.vars = {};
    headersModel.value = {};
    return;
  }
  const { httpHeaders, outputDir } = await loadPluginVars(pluginId);
  form.value.outputDir = outputDir;
  headersModel.value = { ...httpHeaders };
};

function monday0FromDate(d: Date): number {
  const w = d.getDay();
  return w === 0 ? 6 : w - 1;
}

watch(
  () => scheduleMode.value,
  (mode) => {
    if (mode === "interval") {
      dailyHour.value = -1;
      dailyMinute.value = 0;
      weeklyWeekday.value = 0;
    } else if (mode === "daily") {
      intervalValue.value = 1;
      intervalUnit.value = "hours";
      weeklyWeekday.value = 0;
      dailyHour.value = -1;
      dailyMinute.value = 0;
    } else {
      intervalValue.value = 1;
      intervalUnit.value = "hours";
      const d = new Date();
      weeklyWeekday.value = monday0FromDate(d);
      dailyHour.value = d.getHours();
      dailyMinute.value = d.getMinutes();
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
  padding: 2px 0 4px;
}

.acd-schedule-fields--readonly {
  opacity: 0.72;
  padding-bottom: 4px;
  border-radius: 8px;
}

.acd-schedule-progress {
  margin-top: 12px;
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

<style lang="scss">
/* 与 CrawlerDialog `.crawl-dialog` 一致：整窗限高、仅 body 滚动，避免蒙层与内容双重滚动 */
.auto-config-dialog.el-dialog {
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
</style>
