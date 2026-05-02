<template>
  <!-- Android：自研全宽抽屉 -->
  <AndroidDrawer v-if="uiStore.isCompact" v-model="visible" show-close-button class="crawl-dialog">
    <template #header>
      <div class="crawl-drawer-header">
        <h3>{{ $t("plugins.startCollect") }}</h3>
      </div>
    </template>
    <el-form ref="formRef" :model="form" label-position="top" class="crawl-form">
      <el-form-item :label="$t('plugins.runConfig')">
        <div class="run-config-row">
          <AndroidPickerSelect :model-value="selectedRunConfigId ?? null" :options="runConfigPickerOptions"
            :title="$t('plugins.runConfig')" :placeholder="$t('plugins.selectConfigOptional')" clearable
            @update:model-value="setRunConfigId" />
          <el-button v-if="!selectedRunConfigId" class="run-config-btn" @click="showAddConfigDialog = true">
            {{ $t("plugins.addConfig") }}
          </el-button>
          <el-button v-else class="run-config-btn" @click="updateCurrentConfig">
            {{ $t("plugins.updateToConfig") }}
          </el-button>
        </div>
      </el-form-item>
      <el-form-item :label="$t('plugins.selectSource')">
        <div class="plugin-source-field">
          <div class="plugin-select-with-warning">
            <AndroidPickerSelect :model-value="form.pluginId ?? null" :options="pluginPickerOptions"
              :title="$t('plugins.selectSource')" :placeholder="$t('plugins.selectSourcePlaceholder')"
              @update:model-value="onPluginChange">
              <template #option="{ option }">
                <div class="plugin-option">
                  <img v-if="option.iconSrc" :src="option.iconSrc" class="plugin-option-icon" alt="" />
                  <el-icon v-else class="plugin-option-icon-placeholder">
                    <Grid />
                  </el-icon>
                  <span class="plugin-picker-option-label">{{ option.label }}</span>
                  <el-icon v-if="option.warning" class="plugin-picker-option-warning"
                    :title="$t('plugins.androidNotSupported')">
                    <WarningFilled />
                  </el-icon>
                </div>
              </template>
            </AndroidPickerSelect>
            <el-icon v-if="isSelectedPluginJs" class="plugin-js-warning-icon"
              :title="$t('plugins.jsPluginAndroidNotSupportedTitle')">
              <WarningFilled />
            </el-icon>
          </div>
          <div v-if="selectedPluginMinAppIncompatible" class="plugin-min-app-error" role="alert">
            {{ crawlDialogMinAppErrorText }}
          </div>
        </div>
      </el-form-item>
      <el-form-item v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
        <el-input v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
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
        <AlbumPickerField v-model="selectedOutputAlbumId" :album-tree="outputAlbumTree" :album-counts="albumCounts"
          allow-create :placeholder="$t('plugins.defaultGalleryOnly')" :picker-title="$t('albums.outputAlbum')"
          clearable />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <el-input ref="newOutputAlbumNameInputRef" v-model="newOutputAlbumName"
          :placeholder="$t('albums.placeholderName')" maxlength="50" show-word-limit
          @keyup.enter="handleCreateOutputAlbum" />
      </el-form-item>

      <template v-if="pluginVars.length > 0">
        <el-divider content-position="left">{{ $t("plugins.pluginConfig") }}</el-divider>
        <el-form-item v-for="varDef in visiblePluginVars" :key="varDef.key" :label="varDisplayName(varDef)"
          :prop="`vars.${varDef.key}`" :required="isRequired(varDef)"
          :rules="getValidationRules(varDef, varDisplayName(varDef))">
          <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="optionsForVar(varDef)"
            :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
            :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
            :file-extensions="getFileExtensions(varDef)" :date-format="typeof varDef.format === 'string' && varDef.format.trim() !== '' ? varDef.format : undefined
              " :date-min="typeof varDef.dateMin === 'string' && varDef.dateMin.trim() !== '' ? varDef.dateMin : undefined
              " :date-max="typeof varDef.dateMax === 'string' && varDef.dateMax.trim() !== '' ? varDef.dateMax : undefined
              " :placeholder="varDescripts(varDef) ||
              (varDef.type === 'options' ||
                varDef.type === 'list' ||
                varDef.type === 'checkbox' ||
                varDef.type === 'date'
                ? `请选择${varDisplayName(varDef)}`
                : `请输入${varDisplayName(varDef)}`)
              " :allow-unset="!isRequired(varDef)" @update:model-value="(val) => (form.vars[varDef.key] = val)" />
          <div v-if="varDescripts(varDef)">
            {{ varDescripts(varDef) }}
          </div>
        </el-form-item>
      </template>

      <el-divider content-position="left">{{ $t("plugins.advancedSettings") }}</el-divider>
      <el-form-item :label="$t('plugins.httpHeaders')">
        <div class="headers-editor">
          <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
            <el-input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" />
            <el-input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" />
            <el-button type="danger" link @click="removeHeaderRow(idx)">{{ $t("plugins.delete") }}</el-button>
          </div>
          <div class="header-actions">
            <el-button size="small" @click="addHeaderRow">{{ $t("plugins.addHeader") }}</el-button>
          </div>
          <div class="config-hint">
            {{ $t("plugins.httpHeadersHint") }}
          </div>
        </div>
      </el-form-item>

      <el-divider content-position="left">{{ $t("autoConfig.schedule") }}</el-divider>
      <el-form-item :label="$t('autoConfig.scheduleEnabled')">
        <el-switch v-model="scheduleEnabled" />
      </el-form-item>
      <template v-if="scheduleEnabled">
        <el-form-item :label="$t('autoConfig.mode')">
          <el-radio-group v-model="scheduleMode">
            <el-radio value="interval">{{ $t("autoConfig.modeInterval") }}</el-radio>
            <el-radio value="daily">{{ $t("autoConfig.modeDaily") }}</el-radio>
            <el-radio value="weekly">{{ $t("autoConfig.modeWeekly") }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'interval'" :label="$t('autoConfig.modeInterval')">
          <div class="mode-line">
            <el-input-number v-model="intervalValue" :min="1" />
            <el-select v-model="intervalUnit">
              <el-option value="minutes" :label="$t('autoConfig.unitMinutes')" />
              <el-option value="hours" :label="$t('autoConfig.unitHours')" />
              <el-option value="days" :label="$t('autoConfig.unitDays')" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'daily'" :label="$t('autoConfig.modeDaily')">
          <div class="mode-line">
            <el-select v-model="dailyHour">
              <el-option :value="-1" :label="$t('autoConfig.everyHour')" />
              <el-option v-for="h in 24" :key="`h-${h - 1}`" :value="h - 1"
                :label="`${String(h - 1).padStart(2, '0')}:xx`" />
            </el-select>
            <el-select v-model="dailyMinute">
              <el-option v-for="m in 60" :key="`m-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'weekly'" :label="$t('autoConfig.modeWeekly')">
          <div class="mode-line">
            <el-select v-model="weeklyWeekday">
              <el-option v-for="wd in 7" :key="`awd-${wd - 1}`" :value="wd - 1"
                :label="$t(`autoConfig.weekday${wd - 1}`)" />
            </el-select>
            <el-select v-model="dailyHour">
              <el-option v-for="h in 24" :key="`awh-${h - 1}`" :value="h - 1"
                :label="`${String(h - 1).padStart(2, '0')}:xx`" />
            </el-select>
            <el-select v-model="dailyMinute">
              <el-option v-for="m in 60" :key="`awm-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
            </el-select>
          </div>
        </el-form-item>
        <el-alert type="info" :closable="false" :title="schedulePreview" />
      </template>
    </el-form>
    <div class="crawl-dialog-footer crawl-dialog-footer--android">
      <el-button type="primary" :disabled="!selectedRunConfigId && !form.pluginId" @click="handleStartCrawl">
        {{ $t("plugins.startCollect") }}
      </el-button>
    </div>
  </AndroidDrawer>

  <ElDialog v-else v-model="visible" :title="$t('plugins.startCollect')" width="600px" class="crawl-dialog" align-center
    :show-close="true">
    <el-form ref="formRef" :model="form" label-position="top" class="crawl-form">
      <el-form-item :label="$t('plugins.runConfig')">
        <div class="run-config-row">
          <el-select v-model="selectedRunConfigId" class="run-config-select"
            :placeholder="$t('plugins.selectConfigOptional')" clearable popper-class="run-config-select-dropdown"
            @change="(v: string | null) => void setRunConfigId(v)">
            <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="runConfigName(cfg)" :value="cfg.id">
              <div class="run-config-option">
                <div class="run-config-info">
                  <div class="name">
                    <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false" type="danger"
                      size="small" style="margin-right: 6px">
                      {{ $t("plugins.incompatible") }}
                    </el-tag>
                    <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false" type="warning"
                      size="small" style="margin-right: 6px">
                      {{ $t("plugins.incompatible") }}
                    </el-tag>
                    {{ runConfigName(cfg) }}
                    <span v-if="runConfigDescription(cfg)" class="desc"> - {{ runConfigDescription(cfg) }}</span>
                  </div>
                </div>
                <div class="run-config-actions">
                  <el-button type="danger" link size="small" @click.stop="handleDeleteConfig(cfg.id)">
                    {{ $t("plugins.delete") }}
                  </el-button>
                </div>
              </div>
            </el-option>
          </el-select>
          <el-button v-if="!selectedRunConfigId" class="run-config-btn" @click="showAddConfigDialog = true">
            {{ $t("plugins.saveToConfig") }}
          </el-button>
          <el-button v-else class="run-config-btn" @click="updateCurrentConfig">
            {{ $t("plugins.updateToConfig") }}
          </el-button>
        </div>
        <div class="run-config-recommended-row">
          <el-button type="primary" link class="run-config-rec-btn" @click="goImportRecommendedPresets">
            {{ $t("plugins.importRecommendedConfigs") }}
            <span v-if="recommendedPresetCount > 0" class="run-config-rec-count">({{ recommendedPresetCount }})</span>
          </el-button>
        </div>
      </el-form-item>
      <el-form-item :label="$t('plugins.selectSource')">
        <div class="plugin-source-field">
          <el-select v-model="form.pluginId" style="width: 100%" :placeholder="$t('plugins.selectSourcePlaceholder')"
            popper-class="crawl-plugin-select-dropdown" @change="onPluginChange">
            <el-option v-for="plugin in plugins" :key="plugin.id" :label="pluginName(plugin)" :value="plugin.id">
              <div class="plugin-option">
                <img v-if="pluginIconUrl(plugin.id)" :src="pluginIconUrl(plugin.id)" class="plugin-option-icon" />
                <el-icon v-else class="plugin-option-icon-placeholder">
                  <Grid />
                </el-icon>
                <span>{{ pluginName(plugin) }}</span>
              </div>
            </el-option>
          </el-select>
          <div v-if="selectedPluginMinAppIncompatible" class="plugin-min-app-error" role="alert">
            {{ crawlDialogMinAppErrorText }}
          </div>
        </div>
      </el-form-item>
      <el-form-item v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
        <el-input v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
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
        <AlbumPickerField v-model="selectedOutputAlbumId" :album-tree="outputAlbumTree" :album-counts="albumCounts"
          allow-create :placeholder="$t('plugins.defaultGalleryOnly')" :picker-title="$t('albums.outputAlbum')"
          clearable />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <el-input ref="newOutputAlbumNameInputRef" v-model="newOutputAlbumName"
          :placeholder="$t('albums.placeholderName')" maxlength="50" show-word-limit
          @keyup.enter="handleCreateOutputAlbum" />
      </el-form-item>

      <template v-if="pluginVars.length > 0">
        <el-divider content-position="left">{{ $t("plugins.pluginConfig") }}</el-divider>
        <el-form-item v-for="varDef in visiblePluginVars" :key="varDef.key" :label="varDisplayName(varDef)"
          :prop="`vars.${varDef.key}`" :required="isRequired(varDef)"
          :rules="getValidationRules(varDef, varDisplayName(varDef))">
          <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="optionsForVar(varDef)"
            :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
            :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
            :file-extensions="getFileExtensions(varDef)" :date-format="typeof varDef.format === 'string' && varDef.format.trim() !== '' ? varDef.format : undefined
              " :date-min="typeof varDef.dateMin === 'string' && varDef.dateMin.trim() !== '' ? varDef.dateMin : undefined
              " :date-max="typeof varDef.dateMax === 'string' && varDef.dateMax.trim() !== '' ? varDef.dateMax : undefined
              " :placeholder="varDescripts(varDef) ||
              (varDef.type === 'options' ||
                varDef.type === 'list' ||
                varDef.type === 'checkbox' ||
                varDef.type === 'date'
                ? `请选择${varDisplayName(varDef)}`
                : `请输入${varDisplayName(varDef)}`)
              " :allow-unset="!isRequired(varDef)" @update:model-value="(val) => (form.vars[varDef.key] = val)" />
          <div v-if="varDescripts(varDef)">
            {{ varDescripts(varDef) }}
          </div>
        </el-form-item>
      </template>

      <el-divider content-position="left">{{ $t("plugins.advancedSettings") }}</el-divider>
      <el-form-item :label="$t('plugins.httpHeaders')">
        <div class="headers-editor">
          <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
            <el-input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" />
            <el-input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" />
            <el-button type="danger" link @click="removeHeaderRow(idx)">{{ $t("plugins.delete") }}</el-button>
          </div>
          <div class="header-actions">
            <el-button size="small" @click="addHeaderRow">{{ $t("plugins.addHeader") }}</el-button>
          </div>
          <div class="config-hint">
            {{ $t("plugins.httpHeadersHint") }}
          </div>
        </div>
      </el-form-item>

      <el-divider content-position="left">{{ $t("autoConfig.schedule") }}</el-divider>
      <el-form-item :label="$t('autoConfig.scheduleEnabled')">
        <el-switch v-model="scheduleEnabled" />
      </el-form-item>
      <template v-if="scheduleEnabled">
        <el-form-item :label="$t('autoConfig.mode')">
          <el-radio-group v-model="scheduleMode">
            <el-radio value="interval">{{ $t("autoConfig.modeInterval") }}</el-radio>
            <el-radio value="daily">{{ $t("autoConfig.modeDaily") }}</el-radio>
            <el-radio value="weekly">{{ $t("autoConfig.modeWeekly") }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'interval'" :label="$t('autoConfig.modeInterval')">
          <div class="mode-line">
            <el-input-number v-model="intervalValue" :min="1" />
            <el-select v-model="intervalUnit">
              <el-option value="minutes" :label="$t('autoConfig.unitMinutes')" />
              <el-option value="hours" :label="$t('autoConfig.unitHours')" />
              <el-option value="days" :label="$t('autoConfig.unitDays')" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'daily'" :label="$t('autoConfig.modeDaily')">
          <div class="mode-line">
            <el-select v-model="dailyHour">
              <el-option :value="-1" :label="$t('autoConfig.everyHour')" />
              <el-option v-for="h in 24" :key="`h-${h - 1}`" :value="h - 1"
                :label="`${String(h - 1).padStart(2, '0')}:xx`" />
            </el-select>
            <el-select v-model="dailyMinute">
              <el-option v-for="m in 60" :key="`m-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item v-if="scheduleMode === 'weekly'" :label="$t('autoConfig.modeWeekly')">
          <div class="mode-line">
            <el-select v-model="weeklyWeekday">
              <el-option v-for="wd in 7" :key="`bwd-${wd - 1}`" :value="wd - 1"
                :label="$t(`autoConfig.weekday${wd - 1}`)" />
            </el-select>
            <el-select v-model="dailyHour">
              <el-option v-for="h in 24" :key="`bwh-${h - 1}`" :value="h - 1"
                :label="`${String(h - 1).padStart(2, '0')}:xx`" />
            </el-select>
            <el-select v-model="dailyMinute">
              <el-option v-for="m in 60" :key="`bwm-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
            </el-select>
          </div>
        </el-form-item>
        <el-alert type="info" :closable="false" :title="schedulePreview" />
      </template>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">{{ $t("common.close") }}</el-button>
      <el-button type="primary" :disabled="!selectedRunConfigId && !form.pluginId" @click="handleStartCrawl">
        {{ $t("plugins.startCollect") }}
      </el-button>
    </template>
  </ElDialog>

  <!-- 新增配置弹窗 -->
  <ElDialog v-model="showAddConfigDialog" :title="$t('plugins.newConfig')" width="400px" :close-on-click-modal="false"
    @closed="onAddConfigDialogClosed">
    <el-form label-width="80px">
      <el-form-item :label="$t('common.name')" required>
        <el-input v-model="newConfigName" :placeholder="$t('common.configNamePlaceholder')" maxlength="80"
          show-word-limit />
      </el-form-item>
      <el-form-item :label="$t('common.description')">
        <el-input v-model="newConfigDescription" type="textarea" :placeholder="$t('common.configDescPlaceholder')"
          :rows="2" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showAddConfigDialog = false">{{ $t("common.cancel") }}</el-button>
      <el-button type="primary" @click="handleAddConfig">{{ $t("common.save") }}</el-button>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useI18n, usePluginManifestI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { FolderOpened, Grid, WarningFilled } from "@element-plus/icons-vue";
import { ElDialog } from "element-plus";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { useConfigCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore, type RunConfig, type ScheduleSpec } from "@/stores/crawler";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore, HIDDEN_ALBUM_ID } from "@/stores/albums";
import PluginVarField from "@kabegame/core/components/plugin/var-fields/PluginVarField.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import {
  matchesPluginVarWhen,
  filterVarOptionsByWhen,
  coerceOptionsVarsToVisibleChoices,
} from "@kabegame/core/utils/pluginVarWhen";
import { isPluginMinAppNotSatisfied } from "@/composables/pluginMinAppVersionGate";
import { useApp } from "@/stores/app";
import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
  modelValue: boolean;
  initialConfig?: {
    pluginId?: string;
    outputDir?: string;
    vars?: Record<string, any>;
    httpHeaders?: Record<string, string>;
    outputAlbumId?: string | null;
  };
}

const { t } = useI18n();
const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "started"): void;
}>();

const router = useRouter();
const crawlerStore = useCrawlerStore();
const batteryOptimizationStore = useBatteryOptimizationStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const recommendedPresetCount = computed(
  () => crawlerStore.pluginRecommendedConfigs.length,
);

function goImportRecommendedPresets() {
  visible.value = false;
  void router.push({ name: "AutoConfigs", query: { tab: "recommended" } });
}
const pluginStore = usePluginStore();
const pluginIconUrl = (pluginId: string) => pluginStore.pluginIconDataUrl(pluginId);
const appStore = useApp();
const { version: crawlDialogAppVersion } = storeToRefs(appStore);
const { pluginName } = usePluginManifestI18n();
const { varDisplayName, varDescripts, optionDisplayName, resolveConfigText, locale } = usePluginConfigI18n();

function runConfigName(cfg: { name?: unknown }): string {
  return resolveConfigText(cfg.name as any, locale.value);
}
function runConfigDescription(cfg: { description?: unknown }): string {
  return resolveConfigText(cfg.description as any, locale.value);
}

function optionsForVar(varDef: PluginVarDef): (string | { name: string; variable: string })[] {
  const filtered = filterVarOptionsByWhen(varDef.options, form.value.vars);
  return filtered.map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );
}
const albumStore = useAlbumStore();
const uiStore = useUiStore();

type HttpHeaderRow = { key: string; value: string };
const httpHeaderRows = ref<HttpHeaderRow[]>([]);
const addHeaderRow = () => httpHeaderRows.value.push({ key: "", value: "" });
const removeHeaderRow = (idx: number) => httpHeaderRows.value.splice(idx, 1);
const toHttpHeadersMap = () => {
  const out: Record<string, string> = {};
  for (const r of httpHeaderRows.value) {
    const k = `${r.key ?? ""}`.trim();
    if (!k) continue;
    out[k] = `${r.value ?? ""}`;
  }
  return out;
};
const loadHeadersFromConfig = (cfgId: string | null) => {
  if (!cfgId) {
    httpHeaderRows.value = [];
    return;
  }
  const cfg = crawlerStore.runConfigs.find((c) => c.id === cfgId);
  const headers = cfg?.httpHeaders || {};
  httpHeaderRows.value = Object.entries(headers).map(([k, v]) => ({ key: k, value: v }));
};

const showAddConfigDialog = ref(false);
const newConfigName = ref("");
const newConfigDescription = ref("");
useModalBack(showAddConfigDialog);

function onAddConfigDialogClosed() {
  newConfigName.value = "";
  newConfigDescription.value = "";
}

const scheduleEnabled = ref(false);
const scheduleMode = ref<"interval" | "daily" | "weekly">("interval");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const dailyHour = ref(-1);
const dailyMinute = ref(0);
const weeklyWeekday = ref(0);

const secondsByUnit = (unit: "minutes" | "hours" | "days") => {
  if (unit === "days") return 86400;
  if (unit === "hours") return 3600;
  return 60;
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

const schedulePreview = computed(() => {
  if (!scheduleEnabled.value) return t("autoConfig.scheduleDisabled");
  if (scheduleMode.value === "interval") {
    const unitKey =
      intervalUnit.value === "minutes"
        ? "unitMinutes"
        : intervalUnit.value === "hours"
          ? "unitHours"
          : "unitDays";
    return t("autoConfig.intervalSummary", {
      n: intervalValue.value,
      unit: t(`autoConfig.${unitKey}`),
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

function loadScheduleFromConfig(cfg: RunConfig | undefined) {
  if (!cfg) {
    scheduleEnabled.value = false;
    scheduleMode.value = "interval";
    intervalValue.value = 1;
    intervalUnit.value = "hours";
    dailyHour.value = -1;
    dailyMinute.value = 0;
    weeklyWeekday.value = 0;
    return;
  }
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
}

function buildScheduleFields(): Pick<
  RunConfig,
  "scheduleEnabled" | "scheduleSpec" | "schedulePlannedAt" | "scheduleLastRunAt"
> {
  if (!scheduleEnabled.value) {
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
}

function isFormDirtyFromConfig(cfg: RunConfig, backendVars: Record<string, any>, httpHeaders: Record<string, string>) {
  if (cfg.pluginId !== form.value.pluginId) return true;
  if ((cfg.outputDir ?? "") !== (form.value.outputDir ?? "")) return true;
  if (JSON.stringify(cfg.userConfig ?? {}) !== JSON.stringify(backendVars)) return true;
  if (JSON.stringify(cfg.httpHeaders ?? {}) !== JSON.stringify(httpHeaders)) return true;
  return false;
}

async function handleAddConfig() {
  const name = newConfigName.value.trim();
  if (!name) {
    ElMessage.warning(t("common.configNamePlaceholder"));
    return;
  }
  if (!form.value.pluginId) {
    ElMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  const backendVars =
    pluginVars.value.length > 0 ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]) : {};
  const httpHeaders = toHttpHeadersMap();
  try {
    const cfg = await crawlerStore.addRunConfig({
      name,
      description: newConfigDescription.value?.trim() || undefined,
      pluginId: form.value.pluginId,
      url: "",
      outputDir: form.value.outputDir || undefined,
      userConfig: backendVars,
      httpHeaders,
      scheduleEnabled: false,
    });
    showAddConfigDialog.value = false;
    selectedRunConfigId.value = cfg.id;
  } catch (e) {
    console.error("新增配置失败:", e);
    ElMessage.error(t("plugins.saveFailed"));
  }
}

async function updateCurrentConfig() {
  const cfgId = selectedRunConfigId.value;
  if (!cfgId) return;
  const cfg = crawlerStore.runConfigs.find((c) => c.id === cfgId);
  if (!cfg) {
    ElMessage.error(t("plugins.configNotExist"));
    return;
  }
  if (!form.value.pluginId) {
    ElMessage.warning(t("plugins.selectSourceBeforeSave"));
    return;
  }
  const backendVars =
    pluginVars.value.length > 0 ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]) : {};
  const httpHeaders = toHttpHeadersMap();
  try {
    await crawlerStore.updateRunConfig({
      ...cfg,
      pluginId: form.value.pluginId,
      outputDir: form.value.outputDir || undefined,
      userConfig: backendVars,
      httpHeaders,
    });
    ElMessage.success(t("plugins.updatedToConfig"));
  } catch (e) {
    console.error("更新配置失败:", e);
    ElMessage.error(t("plugins.saveFailed"));
  }
}

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

useModalBack(visible);

const plugins = computed(() => pluginStore.plugins);
const runConfigs = computed(() => crawlerStore.runConfigs);
const { albumCounts } = storeToRefs(albumStore);
const outputAlbumTree = computed(() => albumStore.getAlbumTreeExcluding([HIDDEN_ALBUM_ID]));

const runConfigPickerOptions = computed(() =>
  runConfigs.value.map((cfg) => {
    const name = runConfigName(cfg);
    const desc = runConfigDescription(cfg);
    return {
      label: desc ? `${name} - ${desc}` : name,
      value: cfg.id,
    };
  }),
);
const pluginPickerOptions = computed(() =>
  plugins.value.map((p) => ({
    label: pluginName(p),
    value: p.id,
    warning: p.scriptType === "js",
    iconSrc: pluginStore.pluginIconDataUrl(p.id),
  })),
);

const selectedPlugin = computed(() => {
  const id = form.value.pluginId;
  return id ? plugins.value.find((p) => p.id === id) : null;
});
const isSelectedPluginJs = computed(() => selectedPlugin.value?.scriptType === "js");

const selectedPluginMinAppIncompatible = computed(() =>
  isPluginMinAppNotSatisfied(selectedPlugin.value, crawlDialogAppVersion.value),
);

const crawlDialogMinAppErrorText = computed(() => {
  if (!selectedPluginMinAppIncompatible.value) return "";
  const minV = (selectedPlugin.value?.minAppVersion ?? "").trim();
  const cur = (crawlDialogAppVersion.value ?? "").trim();
  return t("plugins.crawlDialogMinAppError", { required: minV, current: cur });
});
const selectedOutputAlbumId = ref<string | null>(null);
const newOutputAlbumName = ref<string>("");
const newOutputAlbumNameInputRef = ref<any>(null);
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");

const pluginConfig = usePluginConfig();
const {
  form,
  selectedRunConfigId,
  formRef,
  pluginVars,
  isRequired,
  expandVarsForBackend,
  normalizeVarsForUI,
  getValidationRules,
  loadPluginVars,
  loadPluginVarDefs,
  resetFormVarsToDefaults,
  selectOutputDir,
  resetForm,
} = pluginConfig;

async function setRunConfigId(v: string | null) {
  selectedRunConfigId.value = v ?? null;
  if (v) {
    await loadConfigToForm(v);
    loadHeadersFromConfig(v);
    const cfg = crawlerStore.runConfigs.find((c) => c.id === v);
    loadScheduleFromConfig(cfg);
  } else {
    loadScheduleFromConfig(undefined);
  }
}

async function onPluginChange(v: string | null | undefined) {
  const id = v ?? "";
  form.value.pluginId = id;
  if (id) {
    const { httpHeaders } = await loadPluginVars(id);
    httpHeaderRows.value = Object.entries(httpHeaders).map(([k, v]) => ({ key: k, value: v }));
  } else {
    pluginVars.value = [];
    form.value.vars = {};
    httpHeaderRows.value = [];
  }
}

const visiblePluginVars = computed(() => {
  const filtered = pluginVars.value.filter((varDef) => matchesPluginVarWhen(varDef.when, form.value.vars));
  return filtered.map((varDef) => ({
    ...varDef,
    name: varDisplayName(varDef),
    descripts: varDescripts(varDef),
    options: varDef.options?.map((opt) =>
      typeof opt === "string" ? opt : { ...opt, name: optionDisplayName(opt) },
    ),
  }));
});

watch(
  () => form.value.vars,
  () => {
    coerceOptionsVarsToVisibleChoices(pluginVars.value as PluginVarDef[], form.value.vars);
  },
  { deep: true },
);

const getFileExtensions = (varDef: any): string[] | undefined => {
  const opts = varDef?.options;
  if (!Array.isArray(opts) || opts.length === 0) return undefined;
  const exts = opts
    .map((o: any) => (typeof o === "string" ? o : o?.variable))
    .filter((s: any) => typeof s === "string" && s.trim() !== "")
    .map((s: string) => s.trim().replace(/^\./, "").toLowerCase());
  return exts.length > 0 ? exts : undefined;
};

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
  loadPluginVarDefs,
  normalizeVarsForUI,
  isRequired,
  visible,
);

const handleDeleteConfig = async (configId: string) => {
  await confirmDeleteRunConfig(configId);
};

const handleCreateOutputAlbum = async () => {
  if (!newOutputAlbumName.value.trim()) {
    ElMessage.warning(t("albums.enterAlbumNameFirst"));
    return;
  }

  try {
    const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
    selectedOutputAlbumId.value = created.id;
    newOutputAlbumName.value = "";
    ElMessage.success(t("albums.albumCreated"));
  } catch (error: any) {
    console.error("创建画册失败:", error);
    const errorMessage =
      typeof error === "string" ? error : error?.message || String(error) || "创建画册失败";
    ElMessage.error(errorMessage);
  }
};

const handleStartCrawl = async () => {
  if (await guardDesktopOnly("crawl", { needSuper: true })) return;
  try {
    if (!form.value.pluginId) {
      ElMessage.warning(t("plugins.selectSourcePlaceholder"));
      return;
    }

    if (IS_ANDROID && isSelectedPluginJs.value) {
      await ElMessageBox.alert(
        t("plugins.jsPluginAndroidNotSupported"),
        t("plugins.jsPluginAndroidNotSupportedTitle"),
        { confirmButtonText: t("common.ok"), type: "warning" as const },
      );
      return;
    }

    if (selectedOutputAlbumId.value === "__create_new__") {
      if (!newOutputAlbumName.value.trim()) {
        ElMessage.warning(t("albums.enterAlbumNameFirst"));
        return;
      }
      try {
        const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
        selectedOutputAlbumId.value = created.id;
        newOutputAlbumName.value = "";
      } catch (error: any) {
        const errorMessage =
          typeof error === "string" ? error : error?.message || String(error) || "创建画册失败";
        ElMessage.error(errorMessage);
        return;
      }
    }

    if (formRef.value) {
      try {
        await formRef.value.validate();
      } catch {
        ElMessage.warning(t("plugins.fillRequired"));
        return;
      }
    }

    for (const varDef of visiblePluginVars.value) {
      if (isRequired(varDef)) {
        const value = form.value.vars[varDef.key];
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          ((varDef.type === "list" || varDef.type === "checkbox") && Array.isArray(value) && value.length === 0)
        ) {
          ElMessage.warning(t("plugins.fillRequiredField", { name: varDisplayName(varDef) }));
          return;
        }
      }
    }

    const backendVars =
      pluginVars.value.length > 0 ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[]) : {};
    const httpHeaders = toHttpHeadersMap();

    let runConfigIdForTask: string | undefined;

    if (scheduleEnabled.value) {
      if (!scheduleMode.value) {
        ElMessage.warning(t("autoConfig.needScheduleMode"));
        return;
      }
      const schedule = buildScheduleFields();
      const descPreview = schedulePreview.value;
      const cfgId = selectedRunConfigId.value;
      const selectedCfg = cfgId ? crawlerStore.runConfigs.find((c) => c.id === cfgId) : undefined;
      const needNew = !cfgId || !selectedCfg || isFormDirtyFromConfig(selectedCfg, backendVars, httpHeaders);
      const autoName = pluginStore.pluginLabel(form.value.pluginId);

      if (needNew) {
        const created = await crawlerStore.addRunConfig({
          name: autoName,
          description: descPreview,
          pluginId: form.value.pluginId,
          url: "",
          outputDir: form.value.outputDir || undefined,
          userConfig: backendVars,
          httpHeaders,
          ...schedule,
        });
        runConfigIdForTask = created.id;
        selectedRunConfigId.value = created.id;
        if (cfgId) {
          ElMessage.info(t("autoConfig.autoCreatedConfigDesc", { name: autoName }));
        } else {
          ElMessage.info(t("autoConfig.autoCreatedConfig", { name: autoName }));
        }
      } else {
        await crawlerStore.updateRunConfig({
          ...selectedCfg!,
          pluginId: form.value.pluginId,
          outputDir: form.value.outputDir || undefined,
          userConfig: backendVars,
          httpHeaders,
          ...schedule,
        });
        runConfigIdForTask = selectedCfg!.id;
        ElMessage.success(t("autoConfig.keepRunningHint"));
      }
    }

    if (IS_ANDROID) {
      await batteryOptimizationStore.checkAndPromptIfNeeded();
    }
    const taskAdded = await crawlerStore.addTask(
      form.value.pluginId,
      form.value.outputDir || undefined,
      backendVars,
      selectedOutputAlbumId.value || undefined,
      httpHeaders,
      runConfigIdForTask,
      "manual",
    );
    if (!taskAdded) return;

    crawlerDrawerStore.setLastRunConfig({
      pluginId: form.value.pluginId,
      outputDir: form.value.outputDir || "",
      vars: { ...form.value.vars },
      httpHeaders: { ...httpHeaders },
      outputAlbumId: selectedOutputAlbumId.value ?? null,
      runConfigId: runConfigIdForTask ?? null,
    });

    resetForm();
    selectedOutputAlbumId.value = null;
    newOutputAlbumName.value = "";
    visible.value = false;
    emit("started");
  } catch (error: any) {
    console.error("添加任务失败:", error);
    const errorMessage =
      typeof error === "string" ? error : error?.message || String(error) || "添加任务失败";
    ElMessage.error(errorMessage);
  }
};

watch(visible, async (open) => {
  if (!open) return;
  await crawlerStore.runConfigsReady;
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
  }

  try {
    await albumStore.loadAlbums();
  } catch (e) {
    console.debug("导入弹窗打开时刷新画册列表失败（忽略）：", e);
  }

  if (props.initialConfig) {
    if (props.initialConfig.pluginId) {
      form.value.pluginId = props.initialConfig.pluginId;
      await loadPluginVarDefs(props.initialConfig.pluginId);
      if (props.initialConfig.vars) {
        form.value.vars = normalizeVarsForUI(props.initialConfig.vars, pluginVars.value as PluginVarDef[]);
      } else {
        resetFormVarsToDefaults();
      }
    }
    if (props.initialConfig.outputDir !== undefined) {
      form.value.outputDir = props.initialConfig.outputDir ?? "";
    }
    if (props.initialConfig.httpHeaders && Object.keys(props.initialConfig.httpHeaders).length > 0) {
      httpHeaderRows.value = Object.entries(props.initialConfig.httpHeaders).map(([k, v]) => ({ key: k, value: v }));
    }
    if (props.initialConfig.outputAlbumId !== undefined) {
      selectedOutputAlbumId.value = props.initialConfig.outputAlbumId ?? null;
    }
    loadScheduleFromConfig(undefined);
  } else if (crawlerDrawerStore.lastRunConfig) {
    const last = crawlerDrawerStore.lastRunConfig;
    const id = last.runConfigId;
    if (id && runConfigs.value.some((c) => c.id === id)) {
      await setRunConfigId(id);
    } else {
      selectedRunConfigId.value = null;
      if (last.pluginId) {
        form.value.pluginId = last.pluginId;
        form.value.outputDir = last.outputDir ?? "";
        await loadPluginVarDefs(last.pluginId);
        form.value.vars = normalizeVarsForUI(last.vars || {}, pluginVars.value as PluginVarDef[]);
        httpHeaderRows.value =
          last.httpHeaders && Object.keys(last.httpHeaders).length > 0
            ? Object.entries(last.httpHeaders).map(([k, v]) => ({ key: k, value: v }))
            : [];
        selectedOutputAlbumId.value = last.outputAlbumId ?? null;
      }
      loadScheduleFromConfig(undefined);
    }
  } else if (form.value.pluginId) {
    await loadPluginVarDefs(form.value.pluginId);
    loadScheduleFromConfig(undefined);
  }

  await checkAllConfigsCompatibility();
});

watch(visible, (isOpen) => {
  if (!isOpen) {
    selectedOutputAlbumId.value = null;
    newOutputAlbumName.value = "";
  }
});

watch(selectedOutputAlbumId, (newValue) => {
  if (newValue === "__create_new__") {
    nextTick(() => {
      newOutputAlbumNameInputRef.value?.focus?.();
    });
  } else {
    newOutputAlbumName.value = "";
  }
});
</script>

<style lang="scss" scoped>
.crawl-drawer-header {
  h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--anime-text-primary);
  }
}

.crawl-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px 0;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.crawl-dialog-footer--android {
  justify-content: center;
}

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

.mode-line {
  display: flex;
  gap: 8px;
  width: 100%;
}

.mode-line>* {
  flex: 1;
}

.run-config-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.run-config-recommended-row {
  margin-top: 8px;
}

.run-config-rec-btn {
  padding-left: 0;
  height: auto;
  align-items: baseline;
}

.run-config-rec-count {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--anime-text-muted);
  opacity: 0.9;
}

.run-config-row .run-config-select,
.run-config-row>*:first-child {
  flex: 1;
  min-width: 0;
}

.run-config-btn {
  flex-shrink: 0;
  background-color: #fff !important;
  color: var(--el-text-color-primary);
}

.run-config-btn:hover {
  background-color: var(--el-fill-color-light) !important;
  color: var(--el-text-color-primary);
}

.config-hint {
  font-size: 12px;
  color: var(--anime-text-secondary);
  margin-top: 4px;
}

.headers-editor {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.header-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.plugin-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

:deep(.android-picker-select__list-item) .plugin-option {
  width: 100%;
  min-width: 0;
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

.plugin-source-field {
  width: 100%;
}

.plugin-min-app-error {
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.45;
  margin-top: 6px;
}

.plugin-select-with-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.plugin-js-warning-icon {
  color: var(--el-color-danger);
  font-size: 20px;
  flex-shrink: 0;
}

.plugin-picker-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-picker-option-warning {
  flex-shrink: 0;
  margin-left: 8px;
  color: var(--el-color-danger);
  font-size: 18px;
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
  height: auto !important;
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin: 5vh auto !important;
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

.crawl-dialog.el-drawer {
  max-width: 500px !important;

  .el-drawer__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
    margin-bottom: 0 !important;
  }

  .el-drawer__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    display: flex !important;
    flex-direction: column !important;
  }

  .el-drawer__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);

    .el-button--primary {
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%) !important;
      border: none !important;
      box-shadow: var(--anime-shadow) !important;
      color: white !important;
    }

    .el-button--primary:hover {
      background: linear-gradient(135deg, var(--anime-primary-dark) 0%, var(--anime-secondary-dark) 100%) !important;
      box-shadow: var(--anime-shadow-hover) !important;
    }

    .el-button--primary:disabled {
      background: var(--el-button-disabled-bg-color) !important;
      color: var(--el-button-disabled-text-color) !important;
      box-shadow: none !important;
    }
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
