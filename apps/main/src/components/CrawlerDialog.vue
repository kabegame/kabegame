<template>
    <!-- Android：自研全宽抽屉，不显示右上角关闭按钮，关闭靠遮罩/返回 -->
    <AndroidDrawer v-if="IS_ANDROID" v-model="visible" show-close-button class="crawl-dialog">
        <template #header>
            <div class="crawl-drawer-header">
                <h3>{{ $t('plugins.startCollect') }}</h3>
            </div>
        </template>
        <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
            <el-form-item :label="$t('plugins.runConfig')">
                <div class="run-config-row">
                    <AndroidPickerSelect
                        :model-value="selectedRunConfigId ?? null"
                        :options="runConfigPickerOptions"
                        :title="$t('plugins.runConfig')"
                        :placeholder="$t('plugins.selectConfigOptional')"
                        clearable
                        @update:model-value="setRunConfigId"
                    />
                    <el-button v-if="!selectedRunConfigId" class="run-config-btn" @click="showAddConfigDialog = true">
                        {{ $t('plugins.addConfig') }}
                    </el-button>
                    <el-button v-else class="run-config-btn" @click="updateCurrentConfig">
                        {{ $t('plugins.updateToConfig') }}
                    </el-button>
                </div>
            </el-form-item>
            <el-form-item :label="$t('plugins.selectSource')">
                <div class="plugin-select-with-warning">
                    <AndroidPickerSelect
                        :model-value="form.pluginId ?? null"
                        :options="pluginPickerOptions"
                        :title="$t('plugins.selectSource')"
                        :placeholder="$t('plugins.selectSourcePlaceholder')"
                        @update:model-value="onPluginChange"
                    >
                        <template #option="{ option }">
                            <span class="plugin-picker-option-label">{{ option.label }}</span>
                            <el-icon v-if="option.warning" class="plugin-picker-option-warning" :title="$t('plugins.androidNotSupported')">
                                <WarningFilled />
                            </el-icon>
                        </template>
                    </AndroidPickerSelect>
                    <el-icon v-if="isSelectedPluginJs" class="plugin-js-warning-icon" :title="$t('plugins.jsPluginAndroidNotSupportedTitle')">
                        <WarningFilled />
                    </el-icon>
                </div>
            </el-form-item>
            <el-form-item v-if="!IS_ANDROID" :label="$t('plugins.outputDir')">
                <el-input v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
                    <template #append>
                        <el-button @click="selectOutputDir">
                            <el-icon>
                                <FolderOpened />
                            </el-icon>
                            {{ $t('common.chooseFolder') }}
                        </el-button>
                    </template>
                </el-input>
            </el-form-item>

            <el-form-item :label="$t('albums.outputAlbum')">
                <AndroidPickerSelect
                    :model-value="selectedOutputAlbumId"
                    :options="outputAlbumPickerOptions"
                    :title="$t('albums.outputAlbum')"
                    :placeholder="$t('plugins.defaultGalleryOnly')"
                    clearable
                    @update:model-value="setOutputAlbumId"
                />
            </el-form-item>
            <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
                <el-input v-model="newOutputAlbumName" :placeholder="$t('albums.placeholderName')" maxlength="50" show-word-limit
                    @keyup.enter="handleCreateOutputAlbum" ref="newOutputAlbumNameInputRef" />
            </el-form-item>

            <template v-if="pluginVars.length > 0">
                <el-divider content-position="left">{{ $t('plugins.pluginConfig') }}</el-divider>
                <el-form-item v-for="varDef in visiblePluginVars" :key="varDef.key" :label="varDisplayName(varDef)"
                    :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef, varDisplayName(varDef))">
                    <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="optionsForVar(varDef)"
                        :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
                        :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
                        :file-extensions="getFileExtensions(varDef)"
                        :placeholder="varDescripts(varDef) || (varDef.type === 'options' || varDef.type === 'list' || varDef.type === 'checkbox' ? `请选择${varDisplayName(varDef)}` : `请输入${varDisplayName(varDef)}`)"
                        :allow-unset="!isRequired(varDef)"
                        @update:model-value="(val) => (form.vars[varDef.key] = val)" />
                    <div v-if="varDescripts(varDef)">
                        {{ varDescripts(varDef) }}
                    </div>
                </el-form-item>
            </template>

            <el-divider content-position="left">{{ $t('plugins.advancedSettings') }}</el-divider>
            <el-form-item :label="$t('plugins.httpHeaders')">
                <div class="headers-editor">
                    <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
                        <el-input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" />
                        <el-input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" />
                        <el-button type="danger" link @click="removeHeaderRow(idx)">{{ $t('plugins.delete') }}</el-button>
                    </div>
                    <div class="header-actions">
                        <el-button size="small" @click="addHeaderRow">{{ $t('plugins.addHeader') }}</el-button>
                    </div>
                    <div class="config-hint">
                        {{ $t('plugins.httpHeadersHint') }}
                    </div>
                </div>
            </el-form-item>

        </el-form>
        <div class="crawl-dialog-footer crawl-dialog-footer--android">
            <el-button type="primary" @click="handleStartCrawl" :disabled="!selectedRunConfigId && !form.pluginId">
                {{ $t('plugins.startCollect') }}
            </el-button>
        </div>
    </AndroidDrawer>

    <ElDialog
        v-else
        v-model="visible"
        :title="$t('plugins.startCollect')"
        width="600px"
        class="crawl-dialog"
        :show-close="true">
        <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
            <el-form-item :label="$t('plugins.runConfig')">
                <div class="run-config-row">
                    <el-select v-model="selectedRunConfigId" :placeholder="$t('plugins.selectConfigOptional')" clearable
                        popper-class="run-config-select-dropdown" class="run-config-select"
                        @change="(v: string | null) => void setRunConfigId(v)">
                        <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="runConfigName(cfg)" :value="cfg.id">
                            <div class="run-config-option">
                                <div class="run-config-info">
                                    <div class="name">
                                        <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false"
                                            type="danger" size="small" style="margin-right: 6px;">
                                            {{ $t('plugins.incompatible') }}
                                        </el-tag>
                                        <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false"
                                            type="warning" size="small" style="margin-right: 6px;">
                                            {{ $t('plugins.incompatible') }}
                                        </el-tag>
                                        {{ runConfigName(cfg) }}
                                        <span v-if="runConfigDescription(cfg)" class="desc"> - {{ runConfigDescription(cfg) }}</span>
                                    </div>
                                </div>
                                <div class="run-config-actions">
                                    <el-button type="danger" link size="small" @click.stop="handleDeleteConfig(cfg.id)">
                                        {{ $t('plugins.delete') }}
                                    </el-button>
                                </div>
                            </div>
                        </el-option>
                    </el-select>
                    <el-button v-if="!selectedRunConfigId" class="run-config-btn" @click="showAddConfigDialog = true">
                        {{ $t('plugins.saveToConfig') }}
                    </el-button>
                    <el-button v-else class="run-config-btn" @click="updateCurrentConfig">
                        {{ $t('plugins.updateToConfig') }}
                    </el-button>
                </div>
            </el-form-item>
            <el-form-item :label="$t('plugins.selectSource')">
                <el-select v-model="form.pluginId" :placeholder="$t('plugins.selectSourcePlaceholder')" style="width: 100%"
                    popper-class="crawl-plugin-select-dropdown" @change="onPluginChange">
                    <el-option v-for="plugin in plugins" :key="plugin.id" :label="pluginName(plugin)" :value="plugin.id">
                        <div class="plugin-option">
                            <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]"
                                class="plugin-option-icon" />
                            <el-icon v-else class="plugin-option-icon-placeholder">
                                <Grid />
                            </el-icon>
                            <span>{{ pluginName(plugin) }}</span>
                        </div>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="!IS_ANDROID" :label="$t('plugins.outputDir')">
                <el-input v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
                    <template #append>
                        <el-button @click="selectOutputDir">
                            <el-icon>
                                <FolderOpened />
                            </el-icon>
                            {{ $t('common.chooseFolder') }}
                        </el-button>
                    </template>
                </el-input>
            </el-form-item>

            <el-form-item :label="$t('albums.outputAlbum')">
                <el-select v-model="selectedOutputAlbumId" :placeholder="$t('plugins.defaultGalleryOnly')" clearable style="width: 100%">
                    <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
                    <el-option value="__create_new__" :label="$t('albums.createNewAlbum')">
                        <span style="color: var(--el-color-primary); font-weight: 500;">{{ $t('albums.createNewAlbum') }}</span>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
                <el-input v-model="newOutputAlbumName" :placeholder="$t('albums.placeholderName')" maxlength="50" show-word-limit
                    @keyup.enter="handleCreateOutputAlbum" ref="newOutputAlbumNameInputRef" />
            </el-form-item>

            <!-- 插件变量配置 -->
            <template v-if="pluginVars.length > 0">
                <el-divider content-position="left">{{ $t('plugins.pluginConfig') }}</el-divider>
                <el-form-item v-for="varDef in visiblePluginVars" :key="varDef.key" :label="varDisplayName(varDef)"
                    :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef, varDisplayName(varDef))">
                    <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="optionsForVar(varDef)"
                        :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
                        :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
                        :file-extensions="getFileExtensions(varDef)"
                        :placeholder="varDescripts(varDef) || (varDef.type === 'options' || varDef.type === 'list' || varDef.type === 'checkbox' ? `请选择${varDisplayName(varDef)}` : `请输入${varDisplayName(varDef)}`)"
                        :allow-unset="!isRequired(varDef)"
                        @update:model-value="(val) => (form.vars[varDef.key] = val)" />
                    <div v-if="varDescripts(varDef)">
                        {{ varDescripts(varDef) }}
                    </div>
                </el-form-item>
            </template>

            <el-divider content-position="left">{{ $t('plugins.advancedSettings') }}</el-divider>
            <el-form-item :label="$t('plugins.httpHeaders')">
                <div class="headers-editor">
                    <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
                        <el-input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" />
                        <el-input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" />
                        <el-button type="danger" link @click="removeHeaderRow(idx)">{{ $t('plugins.delete') }}</el-button>
                    </div>
                    <div class="header-actions">
                        <el-button size="small" @click="addHeaderRow">{{ $t('plugins.addHeader') }}</el-button>
                    </div>
                    <div class="config-hint">
                        {{ $t('plugins.httpHeadersHint') }}
                    </div>
                </div>
            </el-form-item>

        </el-form>

        <template #footer>
            <el-button @click="visible = false">{{ $t('common.close') }}</el-button>
            <el-button type="primary" @click="handleStartCrawl" :disabled="!selectedRunConfigId && !form.pluginId">
                {{ $t('plugins.startCollect') }}
            </el-button>
        </template>
    </ElDialog>

    <!-- 新增配置弹窗 -->
    <ElDialog
        v-model="showAddConfigDialog"
        :title="$t('plugins.newConfig')"
        width="400px"
        :close-on-click-modal="false"
        @closed="newConfigName = ''; newConfigDescription = '';">
        <el-form label-width="80px">
            <el-form-item :label="$t('common.name')" required>
                <el-input v-model="newConfigName" :placeholder="$t('common.configNamePlaceholder')" maxlength="80" show-word-limit />
            </el-form-item>
            <el-form-item :label="$t('common.description')">
                <el-input v-model="newConfigDescription" type="textarea" :placeholder="$t('common.configDescPlaceholder')" :rows="2" />
            </el-form-item>
        </el-form>
        <template #footer>
            <el-button @click="showAddConfigDialog = false">{{ $t('common.cancel') }}</el-button>
            <el-button type="primary" @click="handleAddConfig">{{ $t('common.save') }}</el-button>
        </template>
    </ElDialog>
</template>

<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpened, Grid, WarningFilled } from "@element-plus/icons-vue";
import { ElDialog } from "element-plus";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { usePluginManifestI18n } from "@/composables/usePluginManifestI18n";
import { usePluginConfigI18n } from "@/composables/usePluginConfigI18n";
import { useConfigCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore } from "@/stores/crawler";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import PluginVarField from "@kabegame/core/components/plugin/var-fields/PluginVarField.vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

interface Props {
    modelValue: boolean;
    pluginIcons: Record<string, string>;
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

const crawlerStore = useCrawlerStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const pluginStore = usePluginStore();
const { pluginName } = usePluginManifestI18n();
const { varDisplayName, varDescripts, optionDisplayName, resolveConfigText, locale } = usePluginConfigI18n();
/** runConfig 的 name/description 可能为 i18n 对象，统一解析为字符串供 ElOption label 等使用 */
function runConfigName(cfg: { name?: unknown }): string {
  return resolveConfigText(cfg.name as any, locale.value);
}
function runConfigDescription(cfg: { description?: unknown }): string {
  return resolveConfigText(cfg.description as any, locale.value);
}
/** 将 varDef.options 中 i18n 的 name 解析为字符串，供 ElOption/AndroidPickerSelect 的 label 使用 */
function optionsForVar(varDef: PluginVarDef): (string | { name: string; variable: string })[] {
  return (varDef.options ?? []).map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable }
  );
}
const albumStore = useAlbumStore();

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

async function handleAddConfig() {
    const name = newConfigName.value.trim();
    if (!name) {
        ElMessage.warning(t('common.configNamePlaceholder'));
        return;
    }
    if (!form.value.pluginId) {
        ElMessage.warning(t('plugins.selectSourceBeforeSave'));
        return;
    }
    const backendVars =
        pluginVars.value.length > 0
            ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[])
            : {};
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
        });
        showAddConfigDialog.value = false;
        // 仅设置选中项，由 watch(selectedRunConfigId) 统一载入并弹一次「配置已载入」提示
        selectedRunConfigId.value = cfg.id;
    } catch (e) {
        console.error("新增配置失败:", e);
        ElMessage.error(t('plugins.saveFailed'));
    }
}

async function updateCurrentConfig() {
    const cfgId = selectedRunConfigId.value;
    if (!cfgId) return;
    const cfg = crawlerStore.runConfigs.find((c) => c.id === cfgId);
    if (!cfg) {
        ElMessage.error(t('plugins.configNotExist'));
        return;
    }
    if (!form.value.pluginId) {
        ElMessage.warning(t('plugins.selectSourceBeforeSave'));
        return;
    }
    const backendVars =
        pluginVars.value.length > 0
            ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[])
            : {};
    const httpHeaders = toHttpHeadersMap();
    try {
        await crawlerStore.updateRunConfig({
            ...cfg,
            pluginId: form.value.pluginId,
            outputDir: form.value.outputDir || undefined,
            userConfig: backendVars,
            httpHeaders,
        });
        ElMessage.success(t('plugins.updatedToConfig'));
    } catch (e) {
        console.error("更新配置失败:", e);
        ElMessage.error(t('plugins.saveFailed'));
    }
}

const visible = computed({
    get: () => props.modelValue,
    set: (v) => emit("update:modelValue", v),
});

useModalBack(visible);

const plugins = computed(() => pluginStore.plugins);
const runConfigs = computed(() => crawlerStore.runConfigs);
const albums = computed(() => albumStore.albums);

const runConfigPickerOptions = computed(() =>
    runConfigs.value.map((cfg) => {
        const name = runConfigName(cfg);
        const desc = runConfigDescription(cfg);
        return {
            label: desc ? `${name} - ${desc}` : name,
            value: cfg.id,
        };
    })
);
const pluginPickerOptions = computed(() =>
    plugins.value.map((p) => ({
        label: pluginName(p),
        value: p.id,
        warning: p.scriptType === "js",
    }))
);

const selectedPlugin = computed(() => {
    const id = form.value.pluginId;
    return id ? plugins.value.find((p) => p.id === id) : null;
});
const isSelectedPluginJs = computed(() => selectedPlugin.value?.scriptType === "js");
const outputAlbumPickerOptions = computed(() => [
    ...albums.value.map((a) => ({ label: a.name, value: a.id })),
    { label: t('albums.createNewAlbum'), value: "__create_new__" },
]);

// 选择的输出画册ID
const selectedOutputAlbumId = ref<string | null>(null);
// 新建输出画册相关
const newOutputAlbumName = ref<string>("");
const newOutputAlbumNameInputRef = ref<any>(null);
// 是否正在创建新画册
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");

// 使用插件配置 composable
const pluginConfig = usePluginConfig();
const {
    form,
    selectedRunConfigId,
    formRef,
    pluginVars,
    isRequired,
    optionLabel,
    optionValue,
    expandVarsForBackend,
    normalizeVarsForUI,
    getValidationRules,
    loadPluginVars,
    loadPluginVarDefs,
    resetFormVarsToDefaults,
    selectOutputDir,
    selectFolder,
    selectFile,
    selectFileByExtensions,
    resetForm,
} = pluginConfig;

async function setRunConfigId(v: string | null) {
    selectedRunConfigId.value = v ?? null;
    if (v) {
        await loadConfigToForm(v);
        loadHeadersFromConfig(v);
    }
}

function onPluginChange(v: string | null | undefined) {
    const id = v ?? "";
    form.value.pluginId = id;
    if (id) {
        loadPluginVars(id);
    } else {
        pluginVars.value = [];
        form.value.vars = {};
    }
}
function setOutputAlbumId(v: string | null) {
    selectedOutputAlbumId.value = v ?? null;
}

// 根据 when 条件过滤，并按当前 locale 解析 name/descripts/options 为展示用字符串
const visiblePluginVars = computed(() => {
    const filtered = pluginVars.value.filter((varDef) => {
        if (!varDef.when) return true;
        return Object.entries(varDef.when).every(
            ([depKey, acceptedValues]) =>
                acceptedValues.includes(String(form.value.vars[depKey] ?? ""))
        );
    });
    return filtered.map((varDef) => ({
        ...varDef,
        name: varDisplayName(varDef),
        descripts: varDescripts(varDef),
        options: varDef.options?.map((opt) =>
            typeof opt === "string" ? opt : { variable: opt.variable, name: optionDisplayName(opt) }
        ),
    }));
});

// file_or_folder 类型：将 varDef.options 作为可选择文件扩展名列表（不带点号）
const getFileExtensions = (varDef: any): string[] | undefined => {
    const opts = varDef?.options;
    if (!Array.isArray(opts) || opts.length === 0) return undefined;
    const exts = opts
        .map((o: any) => (typeof o === "string" ? o : o?.variable))
        .filter((s: any) => typeof s === "string" && s.trim() !== "")
        .map((s: string) => s.trim().replace(/^\./, "").toLowerCase());
    return exts.length > 0 ? exts : undefined;
};

// 使用配置兼容性 composable
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
    visible
);

// 处理删除配置
const handleDeleteConfig = async (configId: string) => {
    await confirmDeleteRunConfig(configId);
};

// 处理创建新输出画册
const handleCreateOutputAlbum = async () => {
    if (!newOutputAlbumName.value.trim()) {
        ElMessage.warning(t('albums.enterAlbumNameFirst'));
        return;
    }

    try {
        // 创建新画册
        const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
        // 自动选择新创建的画册
        selectedOutputAlbumId.value = created.id;
        // 清空输入框
        newOutputAlbumName.value = "";
        ElMessage.success(t('albums.albumCreated'));
    } catch (error: any) {
        console.error("创建画册失败:", error);
        // 提取友好的错误信息
        const errorMessage = typeof error === "string"
            ? error
            : error?.message || String(error) || "创建画册失败";
        ElMessage.error(errorMessage);
    }
};

// 开始收集
const handleStartCrawl = async () => {
    try {
        if (!form.value.pluginId) {
            ElMessage.warning(t('plugins.selectSourcePlaceholder'));
            return;
        }

        if (IS_ANDROID && isSelectedPluginJs.value) {
            await ElMessageBox.alert(
                t('plugins.jsPluginAndroidNotSupported'),
                t('plugins.jsPluginAndroidNotSupportedTitle'),
                { confirmButtonText: t('common.ok'), type: "warning" as const }
            );
            return;
        }

        // 如果选择了"新建画册"，先创建画册
        if (selectedOutputAlbumId.value === "__create_new__") {
            if (!newOutputAlbumName.value.trim()) {
                ElMessage.warning(t('albums.enterAlbumNameFirst'));
                return;
            }
            try {
                const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
                selectedOutputAlbumId.value = created.id;
                newOutputAlbumName.value = "";
            } catch (error: any) {
                // 提取友好的错误信息
                const errorMessage = typeof error === "string"
                    ? error
                    : error?.message || String(error) || "创建画册失败";
                ElMessage.error(errorMessage);
                return; // 创建画册失败，停止后续流程
            }
        }

        // 验证表单
        if (formRef.value) {
            try {
                await formRef.value.validate();
            } catch (error) {
                ElMessage.warning(t('plugins.fillRequired'));
                return;
            }
        }

        // 手动验证必填的插件配置项（仅验证当前可见的）
        for (const varDef of visiblePluginVars.value) {
            if (isRequired(varDef)) {
                const value = form.value.vars[varDef.key];
                if (value === undefined || value === null || value === '' ||
                    ((varDef.type === 'list' || varDef.type === 'checkbox') && Array.isArray(value) && value.length === 0)) {
                    ElMessage.warning(t('plugins.fillRequiredField', { name: varDisplayName(varDef) }));
                    return;
                }
            }
        }

        // 运行/保存配置时，userConfig 统一传对象（至少是 {}），避免"预设保存后 userConfig 为空导致后端未注入变量"
        let backendVars =
            pluginVars.value.length > 0
                ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[])
                : {};
        const httpHeaders = toHttpHeadersMap();

        // 添加任务（异步执行，不等待完成）
        // outputAlbumId 单独传递，不作为 userConfig 的一部分
        crawlerStore.addTask(
            form.value.pluginId,
            form.value.outputDir || undefined,
            backendVars,
            selectedOutputAlbumId.value || undefined,
            httpHeaders
        ).catch(error => {
            // 这里的错误是任务初始化失败，由 watch 监听来处理任务状态变化时的错误显示
            console.error("任务执行失败:", error);
        });

        // 保存为「上次运行配置」，下次打开对话框时恢复
        crawlerDrawerStore.setLastRunConfig({
            pluginId: form.value.pluginId,
            outputDir: form.value.outputDir || "",
            vars: { ...form.value.vars },
            httpHeaders: { ...httpHeaders },
            outputAlbumId: selectedOutputAlbumId.value ?? null,
        });

        // 重置表单
        resetForm();
        // 重置选择的输出画册
        selectedOutputAlbumId.value = null;
        // 重置新建画册相关状态
        newOutputAlbumName.value = "";
        // 关闭对话框
        visible.value = false;
        emit("started");
    } catch (error: any) {
        console.error("添加任务失败:", error);
        // 只处理添加任务时的错误（如保存配置失败），执行错误由 watch 处理
        // 提取友好的错误信息
        const errorMessage = typeof error === "string"
            ? error
            : error?.message || String(error) || "添加任务失败";
        ElMessage.error(errorMessage);
    }
};

// 监听对话框打开，刷新插件列表和兼容性
watch(visible, async (open) => {
    if (!open) return;
    // 刷新已安装源列表
    try {
        await pluginStore.loadPlugins();
    } catch (e) {
        console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
    }

    // 刷新画册列表（用于输出画册下拉列表）
    try {
        await albumStore.loadAlbums();
    } catch (e) {
        console.debug("导入弹窗打开时刷新画册列表失败（忽略）：", e);
    }

    // 如果传入了初始配置，应用它（命令式：仅加载定义，再手动赋值）
    if (props.initialConfig) {
        if (props.initialConfig.pluginId) {
            form.value.pluginId = props.initialConfig.pluginId;
            await loadPluginVarDefs(props.initialConfig.pluginId);
            if (props.initialConfig.vars) {
                form.value.vars = normalizeVarsForUI(
                    props.initialConfig.vars,
                    pluginVars.value as PluginVarDef[]
                );
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
    } else if (crawlerDrawerStore.lastRunConfig) {
        // 无 initialConfig 时恢复上次运行的配置（命令式）
        const last = crawlerDrawerStore.lastRunConfig;
        form.value.pluginId = last.pluginId;
        form.value.outputDir = last.outputDir;
        await loadPluginVarDefs(last.pluginId);
        form.value.vars = normalizeVarsForUI(
            last.vars || {},
            pluginVars.value as PluginVarDef[]
        );
        httpHeaderRows.value = Object.keys(last.httpHeaders).length > 0
            ? Object.entries(last.httpHeaders).map(([k, v]) => ({ key: k, value: v }))
            : [];
        selectedOutputAlbumId.value = last.outputAlbumId;
    } else if (form.value.pluginId) {
        await loadPluginVarDefs(form.value.pluginId);
    }

    await checkAllConfigsCompatibility();
});

// 监听对话框关闭，重置输出画册选择
watch(visible, (isOpen) => {
    if (!isOpen) {
        selectedOutputAlbumId.value = null;
        newOutputAlbumName.value = "";
    }
});

// 监听输出画册选择变化，当选择"新建"时自动聚焦输入框
watch(selectedOutputAlbumId, (newValue) => {
    if (newValue === "__create_new__") {
        // 等待 DOM 更新后聚焦输入框
        nextTick(() => {
            if (newOutputAlbumNameInputRef.value) {
                newOutputAlbumNameInputRef.value.focus();
            }
        });
    } else {
        // 选择已有画册时清空新建名称
        newOutputAlbumName.value = "";
    }
});

</script>

<style lang="scss" scoped>
:deep(.el-form-item) {
    align-items: center;
}

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
}

.run-config-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
}

.run-config-row .run-config-select,
.run-config-row > *:first-child {
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
