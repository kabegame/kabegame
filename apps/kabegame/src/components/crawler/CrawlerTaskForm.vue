<template>
  <div class="flex flex-col gap-4 pb-1">
    <!-- 任务设置（最上）：输出目录 / 输出画册。未选源时同样显示，选到源后并入 taskConfig -->
    <SectionTitle>{{ $t("plugins.taskSettings") }}</SectionTitle>
    <Field v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
      <OutputDirSelect v-model="outputDirValue" :placeholder="$t('plugins.outputDirPlaceholder')" />
    </Field>

    <Field :label="$t('albums.outputAlbum')">
      <AlbumPicker
        v-model="albumValue"
        :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
        expand-label-dirs
        allow-create
        :placeholder="$t('plugins.defaultGalleryOnly')"
        :picker-title="$t('albums.outputAlbum')"
        :compact-presentation="IS_ANDROID ? 'dialog' : 'overlay'"
        clearable
      />
    </Field>
    <template v-if="isCreatingNewOutputAlbum">
      <Field
        :label="$t('albums.placeholderName')"
        required
        :validator="() => (newOutputAlbumName.trim() ? undefined : $t('albums.enterAlbumNameFirst'))"
      >
        <Input
          ref="newOutputAlbumNameInputRef"
          v-model="newOutputAlbumName"
          :placeholder="$t('albums.placeholderName')"
          maxlength="50"
          @keyup.enter="handleCreateOutputAlbum"
        >
          <template #suffix>
            <span class="text-[11.5px] tabular-nums">{{ newOutputAlbumName.length }}/50</span>
          </template>
        </Input>
      </Field>
      <Field :label="$t('albums.parentAlbum')">
        <AlbumPicker
          v-model="newOutputAlbumParentId"
          :scope="{ sections: ['normal'] }"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />
      </Field>
    </template>
    <div class="flex flex-wrap gap-x-6 gap-y-4">
      <Field class="min-w-56 flex-1" :label="$t('plugins.maxConcurrentDownloads')">
        <MaxDownloadsField v-model="maxDownloadsValue" />
      </Field>
      <Field class="min-w-56 flex-1" :label="$t('plugins.dryRun')">
        <label class="inline-flex min-h-8 cursor-pointer items-center gap-2 text-[12.5px] text-kb-fg-muted">
          <Switch v-model="isDryRunValue" />
          {{ $t("plugins.dryRunDesc") }}
        </label>
      </Field>
      <Field class="min-w-56 flex-1" :label="$t('plugins.retryOnFail')">
        <RetryCountField v-model="retryCountValue" />
      </Field>
    </div>

    <!-- 插件设置（中间）：选择源 + 插件变量 -->
    <SectionTitle>{{ $t("plugins.pluginSettings") }}</SectionTitle>
    <Field :label="$t('plugins.selectSource')" :error="crawlDialogMinAppErrorText || undefined">
      <div class="flex w-full min-w-0 items-start gap-2">
        <PluginPickerField
          class="min-w-0 flex-1"
          :model-value="tc?.pluginId || null"
          :plugins="plugins"
          :placeholder="$t('plugins.selectSourcePlaceholder')"
          :select-trigger="IS_ANDROID"
          show-labels
          @update:model-value="onPluginChange"
        />
        <Tooltip :content="$t('plugins.detail.goSurfLogin')">
          <!-- 包一层 span：按钮禁用时悬停提示照样能弹 -->
          <span class="inline-flex shrink-0">
            <Button
              variant="outline"
              size="icon"
              :aria-label="$t('plugins.detail.goSurfLogin')"
              :disabled="!selectedPluginSurfUrl"
              @click="openSelectedPluginInSurf"
            >
              <Compass />
            </Button>
          </span>
        </Tooltip>
      </div>
    </Field>

    <PluginConfigForm
      v-if="tc"
      ref="pluginConfigFormRef"
      :key="crawlerStore.taskConfigRevision"
      v-model="tc.userConfig"
      :plugin-id="tc.pluginId"
    />

    <!-- 高级设置（最下）：HTTP 头 -->
    <SectionTitle>{{ $t("plugins.advancedSettings") }}</SectionTitle>
    <Field :label="$t('plugins.httpHeaders')">
      <HttpHeadersEditor v-model="headersValue" />
    </Field>
  </div>

  <!-- 保存为配置弹窗 -->
  <Dialog v-model:open="saveConfigOpen" :title="$t('plugins.saveAsConfig')" :width="400" :close-on-overlay="false">
    <div class="flex flex-col gap-4">
      <Field :label="$t('common.name')" required>
        <Input
          v-model="saveConfigName"
          :placeholder="$t('common.configNamePlaceholder')"
          maxlength="80"
          @keyup.enter="confirmSaveConfig"
        />
      </Field>
      <Field :label="$t('common.description')">
        <Textarea v-model="saveConfigDescription" :placeholder="$t('common.configDescPlaceholder')" :rows="2" />
      </Field>
    </div>
    <template #footer>
      <Button variant="outline" @click="saveConfigOpen = false">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" @click="confirmSaveConfig">{{ $t("common.save") }}</Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * 收集弹窗的表单主体（桌面 / 紧凑共用）：直接响应式编辑全局 `crawlerStore.taskConfig`，
 * 不判断来源——调用方「先写再打开」。提交与「保存为配置」都在这里完成。
 */
import { computed, nextTick, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { Compass } from "@lucide/vue";
import { Button, Dialog, Field, Input, SectionTitle, Switch, Textarea, Tooltip, useForm } from "@/components/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useApp } from "@/stores/app";
import { HIDDEN_ALBUM_ID, createAlbum } from "@/services/albums";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import PluginPickerField from "@/components/PluginPickerField.vue";
import PluginConfigForm from "@/components/crawler/PluginConfigForm.vue";
import HttpHeadersEditor from "@/components/crawler/HttpHeadersEditor.vue";
import OutputDirSelect from "@/components/crawler/OutputDirSelect.vue";
import MaxDownloadsField from "@/components/crawler/MaxDownloadsField.vue";
import RetryCountField from "@/components/crawler/RetryCountField.vue";
import { kameMessage } from "@/utils/kameMessage";
import { IS_ANDROID, IS_WEB } from "@/env";
import { trackEvent } from "@/track/umami";
import { useUiStore } from "@/stores/ui";
import { useSurfStore } from "@/stores/surf";
import type { PluginVarDef } from "@/utils/pluginVarForm";
import { enqueueTask, guardPluginPlatform } from "@/composables/useCrawlTaskLauncher";
import { buildSubmitUserConfig, writeTaskConfig } from "@/composables/taskConfig";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { t } = useI18n();
const { varDisplayName } = usePluginConfigI18n();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const appStore = useApp();
const { version: appVersion } = storeToRefs(appStore);
const uiStore = useUiStore();
const surfStore = useSurfStore();

/** 全局唯一的 task config；Dialog 只响应式编辑它，不判断来源 */
const tc = computed(() => crawlerStore.taskConfig);
const plugins = computed(() => pluginStore.plugins);
const pluginConfigFormRef = ref<InstanceType<typeof PluginConfigForm> | null>(null);
/** 表单校验：插件变量（PluginVarsForm 的 Field）与新建画册名都注册在这里 */
const form = useForm();

function pluginDefs(pluginId: string): PluginVarDef[] {
  return (pluginStore.plugins.find((p) => p.id === pluginId)?.config?.vars as PluginVarDef[] | undefined) ?? [];
}

function trackCrawlerEvent(name: string, data: Record<string, unknown> = {}) {
  if (!IS_WEB) return;
  trackEvent(name, data);
}

const selectedPlugin = computed(() => {
  const id = tc.value?.pluginId;
  return id ? (plugins.value.find((p) => p.id === id) ?? null) : null;
});
const selectedPluginSurfUrl = computed(() => selectedPlugin.value?.baseUrl?.trim() ?? "");
const selectedPluginMinAppIncompatible = computed(() => !!selectedPlugin.value?.minAppIncompatible);
const crawlDialogMinAppErrorText = computed(() => {
  if (!selectedPluginMinAppIncompatible.value) return "";
  const minV = (selectedPlugin.value?.minAppVersion ?? "").trim();
  const cur = (appVersion.value ?? "").trim();
  return t("plugins.crawlDialogMinAppError", { required: minV, current: cur });
});

async function openSelectedPluginInSurf() {
  const url = selectedPluginSurfUrl.value;
  if (!url) return;
  try {
    await surfStore.startSession(url);
    kameMessage.success(t("surf.sessionStartSuccess"));
  } catch (error: any) {
    kameMessage.error(error?.message || String(error) || t("surf.sessionStartFailed"));
  }
}

/** 改选来源插件本身也是一次外部写入：vars / outputDir / headers 取用户默认 > 插件默认 */
function onPluginChange(id: string | null | undefined) {
  trackCrawlerEvent("gallery_import_plugin_select", { plugin_id: id ?? "", has_plugin: !!id });
  if (!id) {
    void writeTaskConfig(null);
    return;
  }
  // 还没选源时用户可能先填了任务设置/高级设置，选到源后并入，避免这两块的白填
  const carried = tc.value
    ? {}
    : {
        outputDir: draftOutputDir.value,
        outputAlbumId: draftOutputAlbumId.value,
        httpHeaders: draftHttpHeaders.value,
        maxConcurrentDownloads: draftMaxConcurrentDownloads.value,
        isDryRun: draftIsDryRun.value,
        retryCount: draftRetryCount.value,
      };
  void writeTaskConfig({ pluginId: id, ...carried });
}

/* ---------- 任务设置：未选源时先存在本地草稿，选到源后并入 taskConfig ---------- */

/** 未选源时的草稿（通路 3：`taskConfig` 为 null，但任务设置/高级设置仍可编辑） */
const draftOutputDir = ref("");
const draftOutputAlbumId = ref<string | null>(null);
const draftHttpHeaders = ref<Record<string, string>>({});
const draftMaxConcurrentDownloads = ref<number | null>(null);
const draftIsDryRun = ref(false);
const draftRetryCount = ref(0);

const outputDirValue = computed<string>({
  get: () => tc.value?.outputDir ?? draftOutputDir.value,
  set: (value) => {
    if (tc.value) tc.value.outputDir = value;
    else draftOutputDir.value = value;
  },
});

const albumValue = computed<string | null>({
  get: () => tc.value?.outputAlbumId ?? draftOutputAlbumId.value,
  set: (value) => {
    if (tc.value) tc.value.outputAlbumId = value;
    else draftOutputAlbumId.value = value;
  },
});

const headersValue = computed<Record<string, string>>({
  get: () => tc.value?.httpHeaders ?? draftHttpHeaders.value,
  set: (value) => {
    if (tc.value) tc.value.httpHeaders = value;
    else draftHttpHeaders.value = value;
  },
});

const maxDownloadsValue = computed<number | null>({
  get: () => (tc.value ? tc.value.maxConcurrentDownloads : draftMaxConcurrentDownloads.value),
  set: (value) => {
    if (tc.value) tc.value.maxConcurrentDownloads = value;
    else draftMaxConcurrentDownloads.value = value;
  },
});

const isDryRunValue = computed<boolean>({
  get: () => (tc.value ? tc.value.isDryRun : draftIsDryRun.value),
  set: (value) => {
    if (tc.value) tc.value.isDryRun = value;
    else draftIsDryRun.value = value;
  },
});

const retryCountValue = computed<number>({
  get: () => (tc.value ? tc.value.retryCount : draftRetryCount.value),
  set: (value) => {
    if (tc.value) tc.value.retryCount = value;
    else draftRetryCount.value = value;
  },
});

/* ---------- 新建输出画册 ---------- */

const newOutputAlbumName = ref<string>("");
const newOutputAlbumParentId = ref<string | null>(null);
const newOutputAlbumNameInputRef = ref<any>(null);
const isCreatingNewOutputAlbum = computed(() => albumValue.value === "__create_new__");

watch(albumValue, (newValue) => {
  if (newValue === "__create_new__") {
    nextTick(() => newOutputAlbumNameInputRef.value?.focus?.());
  } else {
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
  }
});

const createOutputAlbum = async (showSuccess = true) => {
  if (!newOutputAlbumName.value.trim()) {
    kameMessage.warning(t("albums.enterAlbumNameFirst"));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const created = await createAlbum(newOutputAlbumName.value.trim(), { parentId });
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
    if (showSuccess) kameMessage.success(t("albums.albumCreated"));
    return created;
  } catch (error: any) {
    console.error("创建画册失败:", error);
    const errorMessage = typeof error === "string" ? error : error?.message || String(error) || "创建画册失败";
    kameMessage.error(errorMessage);
    return null;
  }
};

const handleCreateOutputAlbum = async () => {
  const created = await createOutputAlbum();
  if (created) albumValue.value = created.id;
};

/* ---------- 保存为配置 ---------- */

const saveConfigOpen = ref(false);
const saveConfigName = ref("");
const saveConfigDescription = ref("");

function openSaveConfigDialog() {
  const cfg = tc.value;
  if (!cfg?.pluginId) {
    kameMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  saveConfigName.value = pluginStore.pluginLabel(cfg.pluginId);
  saveConfigDescription.value = "";
  saveConfigOpen.value = true;
}

async function confirmSaveConfig() {
  const cfg = tc.value;
  if (!cfg?.pluginId) {
    kameMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  const name = saveConfigName.value.trim();
  if (!name) {
    kameMessage.warning(t("common.configNamePlaceholder"));
    return;
  }
  try {
    await crawlerStore.addRunConfig({
      name,
      description: saveConfigDescription.value.trim() || undefined,
      pluginId: cfg.pluginId,
      url: "",
      outputDir: cfg.outputDir || undefined,
      userConfig: buildSubmitUserConfig(cfg.userConfig, pluginDefs(cfg.pluginId)),
      httpHeaders: { ...cfg.httpHeaders },
      outputAlbumId: cfg.outputAlbumId || undefined,
      maxConcurrentDownloads: cfg.maxConcurrentDownloads,
      isDryRun: cfg.isDryRun,
      retryCount: cfg.retryCount,
      // Dialog 恒为手动任务：保存出来的配置默认不定时
      scheduleEnabled: false,
    });
    kameMessage.success(t("tasks.saveConfigSuccess"));
    saveConfigOpen.value = false;
  } catch (error) {
    console.error("保存为配置失败:", error);
    kameMessage.error(t("tasks.saveFailed"));
  }
}

/* ---------- 提交 ---------- */

async function submit() {
  const cfg = tc.value;
  if (!(await guardPluginPlatform())) return;
  if (!cfg?.pluginId) {
    kameMessage.warning(t("plugins.selectSourcePlaceholder"));
    return;
  }

  // 先校验再建画册：画册名为空时直接在字段上标红，不先弹「请先输入画册名」
  if (!form.validate()) {
    kameMessage.warning(t("plugins.fillRequired"));
    return;
  }

  if (isCreatingNewOutputAlbum.value) {
    const created = await createOutputAlbum(false);
    if (!created) return;
    albumValue.value = created.id;
  }

  const invalid = pluginConfigFormRef.value?.firstInvalidVar();
  if (invalid) {
    kameMessage.warning(t("plugins.fillRequiredField", { name: varDisplayName(invalid) }));
    return;
  }

  // 按真实表单结构裁剪：隐藏字段在此被清理，不传给插件脚本
  const userConfig = buildSubmitUserConfig(cfg.userConfig, pluginDefs(cfg.pluginId));
  cfg.userConfig = userConfig;
  const httpHeaders = { ...cfg.httpHeaders };

  const taskAdded = await enqueueTask({
    pluginId: cfg.pluginId,
    outputDir: cfg.outputDir || undefined,
    userConfig,
    outputAlbumId: cfg.outputAlbumId || undefined,
    httpHeaders,
    maxConcurrentDownloads: cfg.maxConcurrentDownloads,
    isDryRun: cfg.isDryRun,
    retryCount: cfg.retryCount,
    // Dialog 发起的任务一律是手动任务，不带 runConfigId
    triggerSource: "manual",
  });
  if (!taskAdded) return;

  trackCrawlerEvent("gallery_import_start", {
    source: "network",
    plugin_id: cfg.pluginId,
    has_output_dir: !!cfg.outputDir,
    output_album: cfg.outputAlbumId ? "existing" : "none",
    run_config_id: null,
    has_run_config: false,
    schedule_enabled: false,
    visible_param_count: pluginConfigFormRef.value?.visibleVarCount() ?? 0,
    http_header_count: Object.keys(httpHeaders).length,
  });

  // 提交后重建插件表单，使被清理的隐藏字段不会在下次编辑时回填
  crawlerStore.setTaskConfig({ ...cfg, userConfig });
  emit("close");
}

defineExpose({ submit, openSaveConfigDialog });
</script>
