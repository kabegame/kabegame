<template>
  <el-dialog
    :model-value="dialogStore.visible"
    :z-index="modal.zIndex.value"
    :title="dialogTitle"
    width="600px"
    :append-to-body="true"
    class="auto-config-dialog task-params-dialog"
    destroy-on-close
    @update:model-value="modal.close"
    @closed="onDialogClosed"
  >
    <div v-if="showMissing" class="acd-missing">
      {{ t("autoConfig.configDeleted") }}
    </div>

    <div v-else-if="panelMode === 'view' && viewConfig" class="flex flex-col gap-4">
      <el-alert
        v-if="viewConfig.lastResult === 'failed'"
        type="error"
        show-icon
        :closable="false"
        :title="t('autoConfig.lastRunFailed')"
        :description="viewConfig.lastTask?.error"
      />
      <AutoConfigDetailContent
        ref="detailRef"
        :key="viewConfig.id"
        :config="viewConfig"
        :output-album-name="viewAlbumName"
      />
      <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold">{{ t("autoConfig.recentTasks") }}</h3>
        <AutoConfigRelatedTasks
          :config-id="viewConfig.id"
          @open-task-images="openTaskImages"
          @open-task-log="openTaskLog"
        />
      </section>
      <TaskLogDialog ref="taskLogDialogRef" />
    </div>

    <el-form v-else ref="formRef" :model="form" label-position="top" class="acd-edit-form">
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
            v-for="plugin in pluginStore.visiblePlugins"
            :key="plugin.id"
            :label="pluginName(plugin.id)"
            :value="plugin.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="!IS_ANDROID" :label="t('plugins.outputDir')">
        <OutputDirSelect v-model="form.outputDir" :placeholder="t('plugins.outputDirPlaceholder')" />
      </el-form-item>

      <el-form-item :label="t('albums.outputAlbum')">
        <AlbumPicker
          v-model="outputAlbumId"
          :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
          expand-label-dirs
          :placeholder="t('plugins.defaultGalleryOnly')"
          :picker-title="t('albums.outputAlbum')"
          clearable
        />
      </el-form-item>

      <div class="flex flex-wrap gap-x-6">
        <el-form-item class="min-w-56 flex-1" :label="t('plugins.maxConcurrentDownloads')">
          <MaxDownloadsField v-model="maxConcurrentDownloads" />
        </el-form-item>
        <el-form-item class="min-w-56 flex-1" :label="t('plugins.dryRun')">
          <div class="flex items-center gap-2">
            <el-switch v-model="isDryRun" />
            <span class="text-sm text-[var(--anime-text-secondary)]">{{ t("plugins.dryRunDesc") }}</span>
          </div>
        </el-form-item>
      </div>

      <PluginVarsForm v-if="visiblePluginVars.length > 0" v-model="form.vars" :plugin-vars="visiblePluginVars" />

      <el-form-item :label="t('plugins.httpHeaders')">
        <HttpHeadersEditor v-model="headersModel" />
      </el-form-item>

      <section ref="scheduleSectionRef" class="acd-schedule-section">
        <el-divider content-position="left">{{ t("autoConfig.schedule") }}</el-divider>
        <el-form-item :label="t('autoConfig.scheduleEnabled')">
          <el-switch v-model="scheduleEnabled" />
        </el-form-item>
        <ScheduleSpecEditor
          v-if="scheduleEnabled || scheduleSpec"
          v-model="scheduleSpec"
          :disabled="!scheduleEnabled"
        />
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
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import AutoConfigDetailContent from "@/components/scheduler/AutoConfigDetailContent.vue";
import AutoConfigRelatedTasks from "@/components/scheduler/AutoConfigRelatedTasks.vue";
import TaskLogDialog from "@/components/task/TaskLogDialog.vue";
import ScheduleSpecEditor from "@/components/scheduler/ScheduleSpecEditor.vue";
import OutputDirSelect from "@/components/crawler/OutputDirSelect.vue";
import PluginVarsForm from "@/components/crawler/PluginVarsForm.vue";
import HttpHeadersEditor from "@/components/crawler/HttpHeadersEditor.vue";
import MaxDownloadsField from "@/components/crawler/MaxDownloadsField.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import { HIDDEN_ALBUM_ID, fetchAlbum } from "@/services/albums";
import { useModal } from "@/composables/useModal";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { usePluginConfig } from "@/composables/usePluginConfig";
import { coerceOptionsVarsToVisibleChoices, visibleVarDefs } from "@/utils/pluginVarWhen";
import { normalizeVarsForUI, expandVarsForBackend, type PluginVarDef } from "@/utils/pluginVarForm";
import type { RunConfig, ScheduleSpec } from "@/stores/crawler";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { cloneScheduleSpec } from "@/utils/scheduleText";
import { normalizeRunConfigRow } from "@/services/runConfigs";
import { on, pathqlRequest$, usePathqlLooker } from "@/services/kbEvents";
import { encodeSeg } from "@kabegame/pathql-client";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useRouter } from "vue-router";

const { t } = useI18n();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const dialogStore = useAutoConfigDialogStore();
const router = useRouter();
const taskLogDialogRef = ref<InstanceType<typeof TaskLogDialog> | null>(null);

const { form, formRef, pluginVars, loadPluginVarDefs, loadPluginVars } = usePluginConfig();

const panelMode = ref<"view" | "edit">("view");
const detailRef = ref<InstanceType<typeof AutoConfigDetailContent> | null>(null);
const scheduleSectionRef = ref<HTMLElement | null>(null);
const config = ref<RunConfig | null>(null);
const configKey = computed(() =>
  dialogStore.visible && !dialogStore.isCreate && dialogStore.configId
    ? `run_configs://id_${encodeSeg(dialogStore.configId)}`
    : null,
);
const landedKey = ref<string | null>(null);
const configLoading = computed(() => !!configKey.value && landedKey.value !== configKey.value);

// 先清理旧配置，再切换观察方，避免重放新 key 的已有数据后又被清空。
watch(
  configKey,
  () => {
    config.value = null;
    landedKey.value = null;
  },
  { flush: "sync" },
);
usePathqlLooker({
  kind: "rows",
  key: () => configKey.value,
  refreshOn: [on("auto-config-change", (payload) => payload.configId === dialogStore.configId)],
  onResult: ({ rows }) => {
    config.value = normalizeRunConfigRow(rows[0]);
    landedKey.value = configKey.value;
  },
});
watch(
  configKey,
  (key) => {
    if (key) pathqlRequest$.next(["rows", key]);
  },
  { immediate: true, flush: "sync" },
);

const name = ref("");
const description = ref("");
const scheduleEnabled = ref(false);
const scheduleSpec = ref<ScheduleSpec | undefined>();
const headersModel = ref<Record<string, string>>({});
/** 输出画册：与 task config 同义，定时任务也写入该画册 */
const outputAlbumId = ref<string | null>(null);
const maxConcurrentDownloads = ref<number | null>(null);
const isDryRun = ref(false);

const viewAlbumName = ref("");

const modal = useModal({ onClose: () => dialogStore.close() });
watch(
  () => dialogStore.visible,
  (v) => (v ? modal.open() : modal.close()),
  { immediate: true },
);

const viewConfig = computed(() => config.value);

/** 查看态展示画册名；解析失败退回 id */
watch(
  viewConfig,
  async (cfg) => {
    const id = cfg?.outputAlbumId ?? "";
    if (!id) {
      viewAlbumName.value = "";
      return;
    }
    try {
      viewAlbumName.value = (await fetchAlbum(id))?.name ?? "";
    } catch {
      viewAlbumName.value = "";
    }
  },
  { immediate: true },
);

const showMissing = computed(
  () =>
    dialogStore.visible &&
    !dialogStore.isCreate &&
    panelMode.value === "view" &&
    dialogStore.configId &&
    !viewConfig.value &&
    !configLoading.value,
);

const dialogTitle = computed(() => {
  if (dialogStore.isCreate) return t("autoConfig.create");
  if (panelMode.value === "view") return t("autoConfig.detailTitle");
  return t("autoConfig.edit");
});

const pluginName = (id: string) => pluginStore.pluginLabel(id);

const visiblePluginVars = computed(() => visibleVarDefs(pluginVars.value as PluginVarDef[], form.value.vars));

watch(
  () => form.value.vars,
  () => {
    coerceOptionsVarsToVisibleChoices(pluginVars.value, form.value.vars);
  },
  { deep: true },
);

const loadFromConfig = async (cfg: RunConfig) => {
  name.value = String(cfg.name ?? "");
  description.value = cfg.description ?? "";
  form.value.pluginId = cfg.pluginId;
  form.value.outputDir = cfg.outputDir ?? "";
  await loadPluginVarDefs(cfg.pluginId);
  form.value.vars = normalizeVarsForUI(cfg.userConfig ?? {}, pluginVars.value as PluginVarDef[]);
  headersModel.value = { ...(cfg.httpHeaders ?? {}) };
  outputAlbumId.value = cfg.outputAlbumId ?? null;
  maxConcurrentDownloads.value = cfg.maxConcurrentDownloads ?? null;
  isDryRun.value = cfg.isDryRun;

  scheduleEnabled.value = !!cfg.scheduleEnabled;
  scheduleSpec.value = cfg.scheduleSpec ? cloneScheduleSpec(cfg.scheduleSpec) : undefined;
};

const resetCreateForm = () => {
  name.value = "";
  description.value = "";
  scheduleEnabled.value = false;
  scheduleSpec.value = undefined;
  headersModel.value = {};
  outputAlbumId.value = null;
  maxConcurrentDownloads.value = null;
  isDryRun.value = false;
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
    const cur = id ? config.value : undefined;
    const curSpec = scheduleSpec.value ?? cur?.scheduleSpec;
    if (!cur || !curSpec) {
      return {
        scheduleEnabled: false,
        scheduleSpec: undefined,
        schedulePlannedAt: undefined,
        scheduleLastRunAt: undefined,
      };
    }
    return {
      scheduleEnabled: false,
      scheduleSpec: cloneScheduleSpec(curSpec),
      schedulePlannedAt: cur.schedulePlannedAt,
      scheduleLastRunAt: cur.scheduleLastRunAt,
    };
  }
  return {
    scheduleEnabled: true,
    scheduleSpec: cloneScheduleSpec(scheduleSpec.value ?? { mode: "interval", intervalSecs: 3600 }),
    schedulePlannedAt: undefined,
    scheduleLastRunAt: undefined,
  };
};

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

watch(scheduleEnabled, (enabled) => {
  if (enabled && !scheduleSpec.value) scheduleSpec.value = { mode: "interval", intervalSecs: 3600 };
});

watch(
  () => [dialogStore.visible, dialogStore.openGeneration, configLoading.value] as const,
  async ([vis]) => {
    if (!vis) return;
    const create = dialogStore.isCreate;
    const id = dialogStore.configId;
    const initPanel = dialogStore.initialPanel;
    const scrollSched = dialogStore.scrollSchedule;
    panelMode.value = create ? "edit" : initPanel;
    if (configLoading.value) return;
    await nextTick();
    if (create) {
      resetCreateForm();
    } else if (panelMode.value === "edit" && id) {
      const cfg = config.value;
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
  const cfg = id ? config.value : null;
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
  if (await guardDesktopOnly("saveRunConfig", { needSuper: true })) return;
  if (!name.value.trim()) {
    ElMessage.warning(t("common.configNamePlaceholder"));
    return;
  }
  if (!form.value.pluginId) {
    ElMessage.warning(t("plugins.selectSourcePlaceholder"));
    return;
  }
  if (scheduleEnabled.value && !scheduleSpec.value) {
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

  const visible = visiblePluginVars.value;
  const userConfig = expandVarsForBackend(
    Object.fromEntries(visible.map((def) => [def.key, form.value.vars[def.key]])),
    visible,
  );
  const schedule = buildScheduleFields();
  const payload = {
    name: name.value.trim(),
    description: description.value.trim() || undefined,
    pluginId: form.value.pluginId,
    url: "",
    outputDir: form.value.outputDir || undefined,
    userConfig,
    httpHeaders: { ...headersModel.value },
    outputAlbumId: outputAlbumId.value || undefined,
    maxConcurrentDownloads: maxConcurrentDownloads.value,
    isDryRun: isDryRun.value,
    ...schedule,
  };

  if (dialogStore.isCreate) {
    config.value = await crawlerStore.addRunConfig(payload);
    if (scheduleEnabled.value) {
      ElMessage.success(t("autoConfig.keepRunningHint"));
    } else {
      ElMessage.success(t("common.save"));
    }
    dialogStore.close();
    return;
  }

  const id = String(dialogStore.configId || "");
  const current = config.value?.id === id ? config.value : null;
  if (!current) {
    ElMessage.error(t("autoConfig.configDeleted"));
    dialogStore.close();
    return;
  }
  config.value = await crawlerStore.updateRunConfig({
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
    if (!IS_WEB) {
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

function openTaskImages(taskId: string) {
  void router.push({ name: "TaskDetail", params: { taskId } });
  dialogStore.close();
}

async function openTaskLog(taskId: string) {
  await taskLogDialogRef.value?.openTaskLog(taskId);
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
