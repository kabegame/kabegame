<template>
  <Dialog v-model:open="open" :title="dialogTitle" :width="600" @close-auto-focus="onDialogClosed">
    <div v-if="showMissing" class="p-6 text-center text-[13px] text-kb-fg-muted">
      {{ t("autoConfig.configDeleted") }}
    </div>

    <div v-else-if="panelMode === 'view' && viewConfig" ref="panelRootRef" class="flex flex-col gap-4">
      <Alert
        v-if="viewConfig.lastResult === 'failed'"
        tone="danger"
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
        <h4 class="m-0 mb-1.5 text-[12.5px] font-600 text-kb-fg-muted">{{ t("autoConfig.recentTasks") }}</h4>
        <AutoConfigRelatedTasks
          :config-id="viewConfig.id"
          @open-task-images="openTaskImages"
          @open-task-log="openTaskLog"
        />
      </section>
      <TaskLogDialog ref="taskLogDialogRef" />
    </div>

    <div v-else-if="open" ref="panelRootRef" class="flex flex-col gap-4 pb-1">
      <SectionTitle>{{ t("autoConfig.basicInfo") }}</SectionTitle>
      <Field
        :label="t('common.name')"
        required
        :validator="() => (name.trim() ? undefined : t('common.configNamePlaceholder'))"
      >
        <Input v-model="name" maxlength="80" />
      </Field>
      <Field :label="t('common.description')">
        <Textarea v-model="description" :rows="2" />
      </Field>

      <SectionTitle>{{ t("autoConfig.pluginAndParams") }}</SectionTitle>
      <Field
        :label="t('plugins.selectSource')"
        required
        :validator="() => (form.pluginId ? undefined : t('plugins.selectSourcePlaceholder'))"
      >
        <PluginPickerField
          :model-value="form.pluginId || null"
          :plugins="pluginStore.visiblePlugins"
          :placeholder="t('plugins.selectSourcePlaceholder')"
          :select-trigger="IS_ANDROID"
          show-labels
          @update:model-value="(id) => onPluginChange(id ?? '')"
        />
      </Field>

      <Field v-if="!IS_ANDROID" :label="t('plugins.outputDir')">
        <OutputDirSelect v-model="form.outputDir" :placeholder="t('plugins.outputDirPlaceholder')" />
      </Field>

      <Field :label="t('albums.outputAlbum')">
        <AlbumPicker
          v-model="outputAlbumId"
          :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
          expand-label-dirs
          :placeholder="t('plugins.defaultGalleryOnly')"
          :picker-title="t('albums.outputAlbum')"
          clearable
        />
      </Field>

      <div class="flex flex-wrap gap-x-6 gap-y-4">
        <Field class="min-w-56 flex-1" :label="t('plugins.maxConcurrentDownloads')">
          <MaxDownloadsField v-model="maxConcurrentDownloads" />
        </Field>
        <Field class="min-w-56 flex-1" :label="t('plugins.dryRun')">
          <label class="inline-flex min-h-8 cursor-pointer items-center gap-2 text-[12.5px] text-kb-fg-muted">
            <Switch v-model="isDryRun" />
            {{ t("plugins.dryRunDesc") }}
          </label>
        </Field>
        <Field class="min-w-56 flex-1" :label="t('plugins.retryOnFail')">
          <RetryCountField v-model="retryCount" />
        </Field>
      </div>

      <PluginVarsForm v-if="visiblePluginVars.length > 0" v-model="form.vars" :plugin-vars="visiblePluginVars" />

      <Field :label="t('plugins.httpHeaders')">
        <HttpHeadersEditor v-model="headersModel" />
      </Field>

      <section ref="scheduleSectionRef" class="flex scroll-mt-2 flex-col gap-4">
        <SectionTitle>{{ t("autoConfig.schedule") }}</SectionTitle>
        <Field :label="t('autoConfig.scheduleEnabled')">
          <div class="flex min-h-8 items-center"><Switch v-model="scheduleEnabled" /></div>
        </Field>
        <ScheduleSpecEditor
          v-if="scheduleEnabled || scheduleSpec"
          v-model="scheduleSpec"
          :disabled="!scheduleEnabled"
        />
      </section>
    </div>

    <template #footer>
      <template v-if="showMissing">
        <Button variant="outline" @click="dialogStore.close()">{{ t("common.close") }}</Button>
      </template>
      <template v-else-if="panelMode === 'view' && viewConfig">
        <Button variant="outline" @click="copyFullJson">
          <Copy />
          {{ t("autoConfig.detailCopyFullJson") }}
        </Button>
        <Button variant="primary" @click="enterEdit">
          <Pencil />
          {{ t("autoConfig.edit") }}
        </Button>
      </template>
      <template v-else-if="panelMode === 'edit' || dialogStore.isCreate">
        <Button variant="outline" @click="handleEditCancel">
          {{ dialogStore.isCreate ? t("common.cancel") : t("autoConfig.detailBackToView") }}
        </Button>
        <Button variant="primary" :disabled="saving" @click="handleSave">
          <Spinner v-if="saving" :size="14" />
          {{ t("common.save") }}
        </Button>
      </template>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { kameMessage } from "@/utils/kameMessage";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import AutoConfigDetailContent from "@/components/scheduler/AutoConfigDetailContent.vue";
import AutoConfigRelatedTasks from "@/components/scheduler/AutoConfigRelatedTasks.vue";
import TaskLogDialog from "@/components/task/TaskLogDialog.vue";
import ScheduleSpecEditor from "@/components/scheduler/ScheduleSpecEditor.vue";
import OutputDirSelect from "@/components/crawler/OutputDirSelect.vue";
import PluginVarsForm from "@/components/crawler/PluginVarsForm.vue";
import { Alert, Button, Dialog, Field, Input, SectionTitle, Spinner, Switch, Textarea, useForm } from "@/components/ui";
import { Copy, Pencil } from "@lucide/vue";
import PluginPickerField from "@/components/PluginPickerField.vue";
import HttpHeadersEditor from "@/components/crawler/HttpHeadersEditor.vue";
import MaxDownloadsField from "@/components/crawler/MaxDownloadsField.vue";
import RetryCountField from "@/components/crawler/RetryCountField.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import { HIDDEN_ALBUM_ID, fetchAlbum } from "@/services/albums";
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

const { form, pluginVars, loadPluginVarDefs, loadPluginVars } = usePluginConfig();
/** 编辑表单的校验：名称、源与插件变量（PluginVarsForm 的 Field）都注册在这里 */
const editForm = useForm();
const saving = ref(false);

const panelMode = ref<"view" | "edit">("view");
const detailRef = ref<InstanceType<typeof AutoConfigDetailContent> | null>(null);
const scheduleSectionRef = ref<HTMLElement | null>(null);
const panelRootRef = ref<HTMLElement | null>(null);
// 查看 / 编辑切换时回到顶部（两者共用对话框的滚动容器，否则沿用上一个面板的滚动位置）
watch(panelMode, async () => {
  await nextTick();
  if (!dialogStore.scrollSchedule) panelRootRef.value?.scrollIntoView({ block: "start" });
});
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
const retryCount = ref(0);

const viewAlbumName = ref("");

// 开关由 store 持有；Dialog 自己接返回栈与层级
const open = computed({
  get: () => dialogStore.visible,
  set: (value: boolean) => {
    if (!value) dialogStore.close();
  },
});

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
  retryCount.value = cfg.retryCount ?? 0;

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
  retryCount.value = 0;
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
        scheduleSectionRef.value?.scrollIntoView({ block: "start" });
      }
      dialogStore.clearScrollSchedule();
    }
  },
);

function onDialogClosed() {
  panelMode.value = "view";
  editForm.reset();
}

const enterEdit = async () => {
  const id = dialogStore.configId;
  const cfg = id ? config.value : null;
  if (!cfg) {
    kameMessage.error(t("autoConfig.configDeleted"));
    return;
  }
  panelMode.value = "edit";
  editForm.reset();
  await loadFromConfig(cfg);
  await nextTick();
  if (dialogStore.scrollSchedule) {
    scheduleSectionRef.value?.scrollIntoView({ block: "start" });
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
  // 名称、源、插件变量一起检查：出错的字段标红并滚进视野
  if (!editForm.validate()) {
    kameMessage.warning(t("plugins.fillRequired"));
    return;
  }
  if (scheduleEnabled.value && !scheduleSpec.value) {
    kameMessage.warning(t("autoConfig.needScheduleMode"));
    return;
  }
  saving.value = true;
  try {
    await save();
  } finally {
    saving.value = false;
  }
};

const save = async () => {
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
    retryCount: retryCount.value,
    ...schedule,
  };

  if (dialogStore.isCreate) {
    config.value = await crawlerStore.addRunConfig(payload);
    if (scheduleEnabled.value) {
      kameMessage.success(t("autoConfig.keepRunningHint"));
    } else {
      kameMessage.success(t("common.save"));
    }
    dialogStore.close();
    return;
  }

  const id = String(dialogStore.configId || "");
  const current = config.value?.id === id ? config.value : null;
  if (!current) {
    kameMessage.error(t("autoConfig.configDeleted"));
    dialogStore.close();
    return;
  }
  config.value = await crawlerStore.updateRunConfig({
    ...current,
    ...payload,
  });

  if (scheduleEnabled.value) {
    kameMessage.success(t("autoConfig.keepRunningHint"));
  } else {
    kameMessage.success(t("common.save"));
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
    kameMessage.success(t("common.copySuccess"));
  } catch (e) {
    console.error(e);
    kameMessage.error(t("common.copyFailed"));
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
