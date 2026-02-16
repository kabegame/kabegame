<template>
    <!-- Android：自研全宽抽屉，不显示右上角关闭按钮，关闭靠遮罩/返回 -->
    <AndroidDrawer v-if="IS_ANDROID" v-model="visible" show-close-button class="crawl-dialog">
        <template #header>
            <div class="crawl-drawer-header">
                <h3>开始收集图片</h3>
            </div>
        </template>
        <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
            <el-form-item label="运行配置">
                <el-select v-model="selectedRunConfigId" placeholder="选择配置（可选）" style="width: 100%" clearable
                    popper-class="run-config-select-dropdown">
                    <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="cfg.name" :value="cfg.id">
                        <div class="run-config-option">
                            <div class="run-config-info">
                                <div class="name">
                                    <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false"
                                        type="danger" size="small" style="margin-right: 6px;">
                                        不兼容
                                    </el-tag>
                                    <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false"
                                        type="warning" size="small" style="margin-right: 6px;">
                                        不兼容
                                    </el-tag>
                                    {{ cfg.name }}
                                    <span v-if="cfg.description" class="desc"> - {{ cfg.description }}</span>
                                </div>
                            </div>
                            <div class="run-config-actions">
                                <el-button type="danger" link size="small" @click.stop="handleDeleteConfig(cfg.id)">
                                    删除
                                </el-button>
                            </div>
                        </div>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item label="选择源">
                <el-select v-model="form.pluginId" placeholder="请选择源" style="width: 100%"
                    popper-class="crawl-plugin-select-dropdown">
                    <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
                        <div class="plugin-option">
                            <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]"
                                class="plugin-option-icon" />
                            <el-icon v-else class="plugin-option-icon-placeholder">
                                <Grid />
                            </el-icon>
                            <span>{{ plugin.name }}</span>
                        </div>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="!IS_ANDROID" label="输出目录">
                <el-input v-model="form.outputDir" placeholder="留空使用默认位置" clearable>
                    <template #append>
                        <el-button @click="selectOutputDir">
                            <el-icon>
                                <FolderOpened />
                            </el-icon>
                            选择
                        </el-button>
                    </template>
                </el-input>
            </el-form-item>

            <el-form-item label="输出画册">
                <el-select v-model="selectedOutputAlbumId" placeholder="默认仅添加到画廊" clearable style="width: 100%">
                    <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
                    <el-option value="__create_new__" label="+ 新建画册">
                        <span style="color: var(--el-color-primary); font-weight: 500;">+ 新建画册</span>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="isCreatingNewOutputAlbum" label="画册名称" required>
                <el-input v-model="newOutputAlbumName" placeholder="请输入画册名称" maxlength="50" show-word-limit
                    @keyup.enter="handleCreateOutputAlbum" ref="newOutputAlbumNameInputRef" />
            </el-form-item>

            <template v-if="pluginVars.length > 0">
                <el-divider content-position="left">插件配置</el-divider>
                <el-form-item v-for="varDef in pluginVars" :key="varDef.key" :label="varDef.name"
                    :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef)">
                    <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="varDef.options"
                        :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
                        :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
                        :file-extensions="getFileExtensions(varDef)"
                        :placeholder="varDef.descripts || (varDef.type === 'options' || varDef.type === 'list' || varDef.type === 'checkbox' ? `请选择${varDef.name}` : `请输入${varDef.name}`)"
                        :allow-unset="!isRequired(varDef)"
                        @update:model-value="(val) => (form.vars[varDef.key] = val)" />
                    <div v-if="varDef.descripts">
                        {{ varDef.descripts }}
                    </div>
                </el-form-item>
            </template>

            <el-divider content-position="left">高级设置</el-divider>
            <el-form-item label="HTTP 头">
                <div class="headers-editor">
                    <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
                        <el-input v-model="row.key" placeholder="Header 名（如 Authorization）" />
                        <el-input v-model="row.value" placeholder="Header 值（如 Bearer xxx）" />
                        <el-button type="danger" link @click="removeHeaderRow(idx)">删除</el-button>
                    </div>
                    <div class="header-actions">
                        <el-button size="small" @click="addHeaderRow">添加 Header</el-button>
                        <el-button v-if="selectedRunConfigId" size="small" type="primary"
                            @click="saveHeadersToSelectedConfig">
                            保存到当前配置
                        </el-button>
                    </div>
                    <div class="config-hint">
                        提示：这里的 HTTP 头会用于爬虫请求（to/to_json）与图片下载（download_image），不会注入到脚本变量里。
                    </div>
                </div>
            </el-form-item>

            <el-divider content-position="left">保存为配置（可选）</el-divider>
            <el-form-item>
                <el-checkbox v-model="saveAsConfig">保存为配置（下次再使用啦）</el-checkbox>
            </el-form-item>
            <el-form-item label="配置名称" v-if="saveAsConfig">
                <el-input v-model="configName" placeholder="请输入配置名称" />
            </el-form-item>
            <el-form-item label="配置描述" v-if="saveAsConfig">
                <el-input v-model="configDescription" placeholder="可选：配置说明" />
            </el-form-item>
        </el-form>
        <div class="crawl-dialog-footer crawl-dialog-footer--android">
            <el-button type="primary" @click="handleStartCrawl" :disabled="!selectedRunConfigId && !form.pluginId">
                开始收集
            </el-button>
        </div>
    </AndroidDrawer>

    <ElDialog
        v-else
        v-model="visible"
        title="开始收集图片"
        width="600px"
        class="crawl-dialog"
        :show-close="true">
        <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
            <el-form-item label="运行配置">
                <el-select v-model="selectedRunConfigId" placeholder="选择配置（可选）" style="width: 100%" clearable
                    popper-class="run-config-select-dropdown">
                    <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="cfg.name" :value="cfg.id">
                        <div class="run-config-option">
                            <div class="run-config-info">
                                <div class="name">
                                    <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false"
                                        type="danger" size="small" style="margin-right: 6px;">
                                        不兼容
                                    </el-tag>
                                    <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false"
                                        type="warning" size="small" style="margin-right: 6px;">
                                        不兼容
                                    </el-tag>
                                    {{ cfg.name }}
                                    <span v-if="cfg.description" class="desc"> - {{ cfg.description }}</span>
                                </div>
                            </div>
                            <div class="run-config-actions">
                                <el-button type="danger" link size="small" @click.stop="handleDeleteConfig(cfg.id)">
                                    删除
                                </el-button>
                            </div>
                        </div>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item label="选择源">
                <el-select v-model="form.pluginId" placeholder="请选择源" style="width: 100%"
                    popper-class="crawl-plugin-select-dropdown">
                    <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
                        <div class="plugin-option">
                            <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]"
                                class="plugin-option-icon" />
                            <el-icon v-else class="plugin-option-icon-placeholder">
                                <Grid />
                            </el-icon>
                            <span>{{ plugin.name }}</span>
                        </div>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="!IS_ANDROID" label="输出目录">
                <el-input v-model="form.outputDir" placeholder="留空使用默认位置" clearable>
                    <template #append>
                        <el-button @click="selectOutputDir">
                            <el-icon>
                                <FolderOpened />
                            </el-icon>
                            选择
                        </el-button>
                    </template>
                </el-input>
            </el-form-item>

            <el-form-item label="输出画册">
                <el-select v-model="selectedOutputAlbumId" placeholder="默认仅添加到画廊" clearable style="width: 100%">
                    <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
                    <el-option value="__create_new__" label="+ 新建画册">
                        <span style="color: var(--el-color-primary); font-weight: 500;">+ 新建画册</span>
                    </el-option>
                </el-select>
            </el-form-item>
            <el-form-item v-if="isCreatingNewOutputAlbum" label="画册名称" required>
                <el-input v-model="newOutputAlbumName" placeholder="请输入画册名称" maxlength="50" show-word-limit
                    @keyup.enter="handleCreateOutputAlbum" ref="newOutputAlbumNameInputRef" />
            </el-form-item>

            <!-- 插件变量配置 -->
            <template v-if="pluginVars.length > 0">
                <el-divider content-position="left">插件配置</el-divider>
                <el-form-item v-for="varDef in pluginVars" :key="varDef.key" :label="varDef.name"
                    :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef)">
                    <PluginVarField :type="varDef.type" :model-value="form.vars[varDef.key]" :options="varDef.options"
                        :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
                        :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
                        :file-extensions="getFileExtensions(varDef)"
                        :placeholder="varDef.descripts || (varDef.type === 'options' || varDef.type === 'list' || varDef.type === 'checkbox' ? `请选择${varDef.name}` : `请输入${varDef.name}`)"
                        :allow-unset="!isRequired(varDef)"
                        @update:model-value="(val) => (form.vars[varDef.key] = val)" />
                    <div v-if="varDef.descripts">
                        {{ varDef.descripts }}
                    </div>
                </el-form-item>
            </template>

            <el-divider content-position="left">高级设置</el-divider>
            <el-form-item label="HTTP 头">
                <div class="headers-editor">
                    <div v-for="(row, idx) in httpHeaderRows" :key="idx" class="header-row">
                        <el-input v-model="row.key" placeholder="Header 名（如 Authorization）" />
                        <el-input v-model="row.value" placeholder="Header 值（如 Bearer xxx）" />
                        <el-button type="danger" link @click="removeHeaderRow(idx)">删除</el-button>
                    </div>
                    <div class="header-actions">
                        <el-button size="small" @click="addHeaderRow">添加 Header</el-button>
                        <el-button v-if="selectedRunConfigId" size="small" type="primary"
                            @click="saveHeadersToSelectedConfig">
                            保存到当前配置
                        </el-button>
                    </div>
                    <div class="config-hint">
                        提示：这里的 HTTP 头会用于爬虫请求（to/to_json）与图片下载（download_image），不会注入到脚本变量里。
                    </div>
                </div>
            </el-form-item>

            <el-divider content-position="left">保存为配置（可选）</el-divider>
            <el-form-item>
                <el-checkbox v-model="saveAsConfig">保存为配置（下次再使用啦）</el-checkbox>
            </el-form-item>
            <el-form-item label="配置名称" v-if="saveAsConfig">
                <el-input v-model="configName" placeholder="请输入配置名称" />
            </el-form-item>
            <el-form-item label="配置描述" v-if="saveAsConfig">
                <el-input v-model="configDescription" placeholder="可选：配置说明" />
            </el-form-item>
        </el-form>

        <template #footer>
            <el-button @click="visible = false">关闭</el-button>
            <el-button type="primary" @click="handleStartCrawl" :disabled="!selectedRunConfigId && !form.pluginId">
                开始收集
            </el-button>
        </template>
    </ElDialog>
</template>

<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { FolderOpened, Grid } from "@element-plus/icons-vue";
import { ElDialog } from "element-plus";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { useConfigCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import PluginVarField from "@kabegame/core/components/plugin/var-fields/PluginVarField.vue";
import { ElMessage } from "element-plus";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";

interface Props {
    modelValue: boolean;
    pluginIcons: Record<string, string>;
    initialConfig?: {
        pluginId?: string;
        outputDir?: string;
        vars?: Record<string, any>;
    };
}

const props = defineProps<Props>();
const emit = defineEmits<{
    (e: "update:modelValue", v: boolean): void;
    (e: "started"): void;
}>();

const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
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
const saveHeadersToSelectedConfig = async () => {
    const cfgId = selectedRunConfigId.value;
    if (!cfgId) return;
    const cfg = crawlerStore.runConfigs.find((c) => c.id === cfgId);
    if (!cfg) {
        ElMessage.error("配置不存在");
        return;
    }
    try {
        await crawlerStore.updateRunConfig({
            ...cfg,
            httpHeaders: toHttpHeadersMap(),
        });
        ElMessage.success("已保存到当前配置");
    } catch (e) {
        console.error("更新配置失败:", e);
        ElMessage.error("保存失败");
    }
};

const visible = computed({
    get: () => props.modelValue,
    set: (v) => emit("update:modelValue", v),
});

const modalStack = useModalStackStore();
const modalStackId = ref<string | null>(null);

watch(
  () => visible.value,
  (val) => {
    if (val && IS_ANDROID) {
      modalStackId.value = modalStack.push(() => {
        visible.value = false;
      });
    } else if (!val && modalStackId.value) {
      modalStack.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

const plugins = computed(() => pluginStore.plugins);
const runConfigs = computed(() => crawlerStore.runConfigs);
const albums = computed(() => albumStore.albums);

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
    saveAsConfig,
    configName,
    configDescription,
    formRef,
    pluginVars,
    isRequired,
    optionLabel,
    optionValue,
    expandVarsForBackend,
    normalizeVarsForUI,
    getValidationRules,
    loadPluginVars,
    selectOutputDir,
    selectFolder,
    selectFile,
    selectFileByExtensions,
    resetForm,
} = pluginConfig;

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
        ElMessage.warning("请输入画册名称");
        return;
    }

    try {
        // 创建新画册
        const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
        // 自动选择新创建的画册
        selectedOutputAlbumId.value = created.id;
        // 清空输入框
        newOutputAlbumName.value = "";
        ElMessage.success(`已创建画册「${created.name}」`);
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
            ElMessage.warning("请选择源");
            return;
        }

        // 如果选择了"新建画册"，先创建画册
        if (selectedOutputAlbumId.value === "__create_new__") {
            if (!newOutputAlbumName.value.trim()) {
                ElMessage.warning("请输入画册名称");
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
                ElMessage.warning("请填写所有必填项");
                return;
            }
        }

        // 手动验证必填的插件配置项
        for (const varDef of pluginVars.value) {
            if (isRequired(varDef)) {
                const value = form.value.vars[varDef.key];
                if (value === undefined || value === null || value === '' ||
                    ((varDef.type === 'list' || varDef.type === 'checkbox') && Array.isArray(value) && value.length === 0)) {
                    ElMessage.warning(`请填写必填项：${varDef.name}`);
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

        // 可选：保存为运行配置（不影响本次直接运行）
        if (saveAsConfig.value) {
            if (!configName.value.trim()) {
                ElMessage.warning("请输入配置名称");
                return;
            }
            await crawlerStore.addRunConfig({
                name: configName.value.trim(),
                description: configDescription.value?.trim() || undefined,
                pluginId: form.value.pluginId,
                url: "",
                outputDir: form.value.outputDir || undefined,
                userConfig: backendVars,
                httpHeaders,
            });
        }

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

    // 如果传入了初始配置，应用它
    if (props.initialConfig) {
        if (props.initialConfig.pluginId) {
            form.value.pluginId = props.initialConfig.pluginId;
            await loadPluginVars(props.initialConfig.pluginId);
        }
        if (props.initialConfig.outputDir) {
            form.value.outputDir = props.initialConfig.outputDir;
        }
        if (props.initialConfig.vars) {
            // 等待插件变量加载完成后再设置变量值
            await nextTick();
            Object.assign(form.value.vars, props.initialConfig.vars);
        }
    } else if (form.value.pluginId) {
        await loadPluginVars(form.value.pluginId);
    }

    await checkAllConfigsCompatibility();
});

// 监听插件选择变化
watch(() => form.value.pluginId, (newPluginId) => {
    if (newPluginId) {
        loadPluginVars(newPluginId);
    } else {
        pluginVars.value = [];
        form.value.vars = {};
    }
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

// 监听运行配置选择变化，选择时直接载入配置
watch(selectedRunConfigId, async (cfgId) => {
    if (!cfgId) {
        return;
    }

    await loadConfigToForm(cfgId);
    loadHeadersFromConfig(cfgId);
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
