<template>
  <el-form ref="formRef" :model="formModel" label-position="top" class="crawl-form">
    <template v-if="tc">
      <el-form-item :label="$t('plugins.selectSource')">
        <div class="plugin-source-field">
          <div class="flex w-full min-w-0 items-start gap-2">
            <PluginPickerField
              class="min-w-0 flex-1"
              :model-value="tc.pluginId || null"
              :plugins="plugins"
              :placeholder="$t('plugins.selectSourcePlaceholder')"
              :popper-class="uiStore.isCompact ? undefined : 'crawl-plugin-select-dropdown'"
              :show-js-warning="uiStore.isCompact"
              :show-selected-js-warning="uiStore.isCompact"
              show-labels
              @update:model-value="onPluginChange"
            />
            <el-tooltip v-if="!uiStore.isCompact" :content="$t('plugins.detail.goSurfLogin')" placement="top">
              <span class="inline-flex flex-none">
                <el-button
                  class="!m-0 h-32px w-40px !p-0"
                  :aria-label="$t('plugins.detail.goSurfLogin')"
                  :disabled="!selectedPluginSurfUrl"
                  @click="openSelectedPluginInSurf"
                >
                  <span class="inline-flex items-center gap-0.5">
                    <Compass class="h-18px w-18px" />
                    <TopRight class="h-11px w-11px" />
                  </span>
                </el-button>
              </span>
            </el-tooltip>
          </div>
          <div v-if="selectedPluginMinAppIncompatible" class="plugin-min-app-error" role="alert">
            {{ crawlDialogMinAppErrorText }}
          </div>
        </div>
      </el-form-item>

      <el-form-item v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
        <el-input v-model="tc.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
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

      <el-form-item :label="$t('albums.outputAlbum')">
        <AlbumPicker
          v-model="tc.outputAlbumId"
          :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
          :is-selectable="(node) => node.type !== 'label_dir'"
          allow-create
          :placeholder="$t('plugins.defaultGalleryOnly')"
          :picker-title="$t('albums.outputAlbum')"
          clearable
        />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <el-input
          ref="newOutputAlbumNameInputRef"
          v-model="newOutputAlbumName"
          :placeholder="$t('albums.placeholderName')"
          maxlength="50"
          show-word-limit
          @keyup.enter="handleCreateOutputAlbum"
        />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.parentAlbum')">
        <AlbumPicker
          v-model="newOutputAlbumParentId"
          :scope="{ sections: ['normal'] }"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />
      </el-form-item>

      <PluginConfigForm
        ref="pluginConfigFormRef"
        :key="crawlerStore.taskConfigRevision"
        v-model="tc.userConfig"
        :plugin-id="tc.pluginId"
      />

      <el-divider content-position="left">{{ $t("plugins.advancedSettings") }}</el-divider>
      <el-form-item :label="$t('plugins.httpHeaders')">
        <HttpHeadersEditor v-model="tc.httpHeaders" />
      </el-form-item>
    </template>

    <!-- 还没有 task config（首次打开且无上次值）：先选源，选完由调用方写入配置后展开表单 -->
    <el-form-item v-else :label="$t('plugins.selectSource')">
      <PluginPickerField
        :model-value="null"
        :plugins="plugins"
        :placeholder="$t('plugins.selectSourcePlaceholder')"
        show-labels
        @update:model-value="(id: string | null) => writeTaskConfig(id ? { pluginId: id } : null)"
      />
    </el-form-item>
  </el-form>

  <!-- 保存为配置弹窗 -->
  <ElDialog
    :model-value="saveConfigModal.isOpen.value"
    :z-index="saveConfigModal.zIndex.value"
    :title="$t('plugins.saveAsConfig')"
    width="400px"
    :close-on-click-modal="false"
    @update:model-value="saveConfigModal.close"
  >
    <el-form label-width="80px">
      <el-form-item :label="$t('common.name')" required>
        <el-input
          v-model="saveConfigName"
          :placeholder="$t('common.configNamePlaceholder')"
          maxlength="80"
          show-word-limit
        />
      </el-form-item>
      <el-form-item :label="$t('common.description')">
        <el-input
          v-model="saveConfigDescription"
          type="textarea"
          :placeholder="$t('common.configDescPlaceholder')"
          :rows="2"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="saveConfigModal.close()">{{ $t("common.cancel") }}</el-button>
      <el-button type="primary" @click="confirmSaveConfig">{{ $t("common.save") }}</el-button>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
/**
 * 收集弹窗的表单主体（桌面 / 紧凑共用）：直接响应式编辑全局 `crawlerStore.taskConfig`，
 * 不判断来源——调用方「先写再打开」。提交与「保存为配置」都在这里完成。
 */
import { computed, nextTick, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { Compass, FolderOpened, TopRight } from "@kabegame/element-plus-icons";
import { ElDialog } from "@kabegame/element-plus";
import { open } from "@tauri-apps/plugin-dialog";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useApp } from "@/stores/app";
import { HIDDEN_ALBUM_ID, createAlbum } from "@/services/albums";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import PluginPickerField from "@/components/PluginPickerField.vue";
import PluginConfigForm from "@/components/crawler/PluginConfigForm.vue";
import HttpHeadersEditor from "@kabegame/core/components/crawler/HttpHeadersEditor.vue";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";
import { useModal } from "@kabegame/core/composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSurfStore } from "@kabegame/core/stores/surf";
import type { PluginVarDef } from "@kabegame/core/utils/pluginVarForm";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
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
const formRef = ref<any>(null);
const pluginConfigFormRef = ref<InstanceType<typeof PluginConfigForm> | null>(null);

/** el-form 的 model：PluginVarsForm 的 prop 路径是 `vars.<key>` */
const formModel = computed(() => ({ vars: tc.value?.userConfig ?? {} }));

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
    ElMessage.success(t("surf.sessionStartSuccess"));
  } catch (error: any) {
    ElMessage.error(error?.message || String(error) || t("surf.sessionStartFailed"));
  }
}

/** 改选来源插件本身也是一次外部写入：vars / outputDir / headers 取用户默认 > 插件默认 */
function onPluginChange(id: string | null | undefined) {
  trackCrawlerEvent("gallery_import_plugin_select", { plugin_id: id ?? "", has_plugin: !!id });
  void writeTaskConfig(id ? { pluginId: id } : null);
}

const selectOutputDir = async () => {
  if (await guardDesktopOnly("openLocal")) return;
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string" && tc.value) {
      tc.value.outputDir = selected;
    }
  } catch (error) {
    console.error("选择目录失败:", error);
  }
};

/* ---------- 新建输出画册 ---------- */

const newOutputAlbumName = ref<string>("");
const newOutputAlbumParentId = ref<string | null>(null);
const newOutputAlbumNameInputRef = ref<any>(null);
const isCreatingNewOutputAlbum = computed(() => tc.value?.outputAlbumId === "__create_new__");

watch(
  () => tc.value?.outputAlbumId,
  (newValue) => {
    if (newValue === "__create_new__") {
      nextTick(() => newOutputAlbumNameInputRef.value?.focus?.());
    } else {
      newOutputAlbumName.value = "";
      newOutputAlbumParentId.value = null;
    }
  },
);

const createOutputAlbum = async (showSuccess = true) => {
  if (!newOutputAlbumName.value.trim()) {
    ElMessage.warning(t("albums.enterAlbumNameFirst"));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const created = await createAlbum(newOutputAlbumName.value.trim(), { parentId });
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
    if (showSuccess) ElMessage.success(t("albums.albumCreated"));
    return created;
  } catch (error: any) {
    console.error("创建画册失败:", error);
    const errorMessage = typeof error === "string" ? error : error?.message || String(error) || "创建画册失败";
    ElMessage.error(errorMessage);
    return null;
  }
};

const handleCreateOutputAlbum = async () => {
  const created = await createOutputAlbum();
  if (created && tc.value) tc.value.outputAlbumId = created.id;
};

/* ---------- 保存为配置 ---------- */

const saveConfigModal = useModal();
const saveConfigName = ref("");
const saveConfigDescription = ref("");

function openSaveConfigDialog() {
  const cfg = tc.value;
  if (!cfg?.pluginId) {
    ElMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  saveConfigName.value = pluginStore.pluginLabel(cfg.pluginId);
  saveConfigDescription.value = "";
  saveConfigModal.open();
}

async function confirmSaveConfig() {
  const cfg = tc.value;
  if (!cfg?.pluginId) {
    ElMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  const name = saveConfigName.value.trim();
  if (!name) {
    ElMessage.warning(t("common.configNamePlaceholder"));
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
      // Dialog 恒为手动任务：保存出来的配置默认不定时
      scheduleEnabled: false,
    });
    ElMessage.success(t("tasks.saveConfigSuccess"));
    saveConfigModal.close();
  } catch (error) {
    console.error("保存为配置失败:", error);
    ElMessage.error(t("tasks.saveFailed"));
  }
}

/* ---------- 提交 ---------- */

async function submit() {
  const cfg = tc.value;
  if (!(await guardPluginPlatform(cfg?.pluginId ?? ""))) return;
  if (!cfg?.pluginId) {
    ElMessage.warning(t("plugins.selectSourcePlaceholder"));
    return;
  }

  if (isCreatingNewOutputAlbum.value) {
    const created = await createOutputAlbum(false);
    if (!created) return;
    cfg.outputAlbumId = created.id;
  }

  if (formRef.value) {
    try {
      await formRef.value.validate();
    } catch {
      ElMessage.warning(t("plugins.fillRequired"));
      return;
    }
  }

  const invalid = pluginConfigFormRef.value?.firstInvalidVar();
  if (invalid) {
    ElMessage.warning(t("plugins.fillRequiredField", { name: varDisplayName(invalid) }));
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

<style lang="scss" scoped>
.crawl-form {
  margin-bottom: 20px;

  :deep(.el-form-item__label) {
    color: var(--anime-text-primary);
    font-weight: 500;
  }

  :deep(.el-form-item__content) {
    width: 100%;
  }
}

.plugin-source-field {
  width: 100%;
}

.plugin-min-app-error {
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.45;
  margin-top: 6px;
}
</style>

<style lang="scss">
.crawl-plugin-select-dropdown {
  .el-select-dropdown__item {
    padding: 8px 12px;
  }

  .plugin-picker-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .plugin-picker-option__icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 4px;
  }

  .plugin-picker-option__icon-placeholder {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--anime-text-secondary);
  }

  .plugin-picker-option span {
    line-height: 1.2;
    color: var(--anime-text-primary);
  }
}
</style>
