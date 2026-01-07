<template>
    <el-dialog v-model="visible" title="开始收集图片" width="600px" :close-on-click-modal="false" class="crawl-dialog"
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
                    <el-option v-for="plugin in enabledPlugins" :key="plugin.id" :label="plugin.name"
                        :value="plugin.id">
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
            <el-form-item label="输出目录">
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

            <!-- local-import：导入文件夹/zip 时，可选“自动创建画册（名称=文件夹名/zip文件名）” -->
            <el-form-item v-if="showAutoCreateAlbumOption" label="导入画册">
                <div class="auto-album-row">
                    <el-checkbox v-model="autoCreateAlbumForLocalImport" :disabled="autoCreateAlbumDisabled">
                        为该{{ localImportTypeLabel }}创建画册
                        <span v-if="suggestedAlbumName" class="auto-album-hint">（名称：{{ suggestedAlbumName }}）</span>
                    </el-checkbox>
                    <div v-if="autoCreateAlbumDisabled" class="auto-album-tip">
                        已选择“输出画册”，该选项将被忽略
                    </div>
                </div>
            </el-form-item>

            <!-- 插件变量配置 -->
            <template v-if="pluginVars.length > 0">
                <el-divider content-position="left">插件配置</el-divider>
                <el-form-item v-for="varDef in pluginVars" :key="varDef.key" :label="varDef.name"
                    :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef)">
                    <el-input-number v-if="varDef.type === 'int' || varDef.type === 'float'"
                        v-model="form.vars[varDef.key]" :min="varDef.min !== undefined ? varDef.min : undefined"
                        :max="varDef.max !== undefined ? varDef.max : undefined"
                        :placeholder="varDef.descripts || `请输入${varDef.name}`" style="width: 100%" />
                    <el-select v-else-if="varDef.type === 'options'" v-model="form.vars[varDef.key]"
                        :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%">
                        <el-option v-for="option in varDef.options" :key="optionValue(option)"
                            :label="optionLabel(option)" :value="optionValue(option)" />
                    </el-select>
                    <el-switch v-else-if="varDef.type === 'boolean'" v-model="form.vars[varDef.key]" />
                    <el-select v-else-if="varDef.type === 'list'" v-model="form.vars[varDef.key]" multiple
                        :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%">
                        <el-option v-for="option in varDef.options" :key="optionValue(option)"
                            :label="optionLabel(option)" :value="optionValue(option)" />
                    </el-select>
                    <el-checkbox-group v-else-if="varDef.type === 'checkbox'" v-model="form.vars[varDef.key]">
                        <el-checkbox v-for="option in (varDef.options || [])" :key="optionValue(option)"
                            :label="optionValue(option)">
                            {{ optionLabel(option) }}
                        </el-checkbox>
                    </el-checkbox-group>
                    <el-input v-else-if="varDef.type === 'path' || varDef.type === 'file_or_folder'"
                        v-model="form.vars[varDef.key]" :placeholder="varDef.descripts || `请选择${varDef.name}`"
                        clearable>
                        <template #append>
                            <el-dropdown trigger="click" @command="(cmd: string) => {
                                if (cmd === 'file') return selectFileByExtensions(varDef.key, getFileExtensions(varDef));
                                if (cmd === 'folder') return selectFolder(varDef.key);
                            }">
                                <el-button>
                                    <el-icon>
                                        <FolderOpened />
                                    </el-icon>
                                    浏览
                                </el-button>
                                <template #dropdown>
                                    <el-dropdown-menu>
                                        <el-dropdown-item command="file">选择文件</el-dropdown-item>
                                        <el-dropdown-item command="folder">选择文件夹</el-dropdown-item>
                                    </el-dropdown-menu>
                                </template>
                            </el-dropdown>
                        </template>
                    </el-input>
                    <el-input v-else-if="varDef.type === 'file'" v-model="form.vars[varDef.key]"
                        :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable>
                        <template #append>
                            <el-button @click="() => selectFile(varDef.key)">
                                <el-icon>
                                    <FolderOpened />
                                </el-icon>
                                选择文件
                            </el-button>
                        </template>
                    </el-input>
                    <el-input v-else-if="varDef.type === 'folder'" v-model="form.vars[varDef.key]"
                        :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable>
                        <template #append>
                            <el-button @click="() => selectFolder(varDef.key)">
                                <el-icon>
                                    <FolderOpened />
                                </el-icon>
                                选择
                            </el-button>
                        </template>
                    </el-input>
                    <el-input v-else v-model="form.vars[varDef.key]"
                        :placeholder="varDef.descripts || `请输入${varDef.name}`" style="width: 100%" />
                    <div v-if="varDef.descripts">
                        {{ varDef.descripts }}
                    </div>
                </el-form-item>
            </template>

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
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { FolderOpened, Grid } from "@element-plus/icons-vue";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";
import { useConfigCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAlbumStore } from "@/stores/albums";
import { ElMessage } from "element-plus";
import { stat } from "@tauri-apps/plugin-fs";

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

const visible = computed({
    get: () => props.modelValue,
    set: (v) => emit("update:modelValue", v),
});

const enabledPlugins = computed(() => pluginStore.plugins.filter((p) => p.enabled));
const runConfigs = computed(() => crawlerStore.runConfigs);
const albums = computed(() => albumStore.albums);

// 选择的输出画册ID
const selectedOutputAlbumId = ref<string | null>(null);
// 新建输出画册相关
const newOutputAlbumName = ref<string>("");
const newOutputAlbumNameInputRef = ref<any>(null);
// 是否正在创建新画册
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");

// local-import：自动为当前“文件夹/zip”创建画册（名称=文件夹名或 zip 文件名）
const autoCreateAlbumForLocalImport = ref(false);
const localImportType = ref<"folder" | "zip" | null>(null);
const suggestedAlbumName = ref("");

const normalizeBasenameFromPath = (p: string): string => {
    const trimmed = `${p}`.trim().replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : trimmed;
};

const autoCreateAlbumDisabled = computed(() => {
    // 如果用户已手选输出画册（含"新建画册"流程），则自动创建无意义
    return !!selectedOutputAlbumId.value;
});

const localImportTypeLabel = computed(() => {
    if (localImportType.value === "zip") return "压缩包";
    if (localImportType.value === "folder") return "文件夹";
    return "来源";
});

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

// 以下 computed 和 watch 依赖 form，必须放在 form 定义之后
const currentLocalImportPath = computed(() => {
    const vars = form.value.vars || {};
    // 新字段优先，其次兼容旧字段
    return (vars as any).path || (vars as any).file_path || (vars as any).folder_path || "";
});

const showAutoCreateAlbumOption = computed(() => {
    return form.value.pluginId === "local-import" && localImportType.value !== null;
});

watch(
    () => [form.value.pluginId, currentLocalImportPath.value] as const,
    async ([pluginId, p]) => {
        // 重置
        localImportType.value = null;
        suggestedAlbumName.value = "";
        // 自动勾选不做强制重置：用户可能想手动保持；但当不是 folder/zip 时隐藏即可

        if (pluginId !== "local-import") return;
        if (!p || typeof p !== "string") return;

        const lower = p.toLowerCase().trim();
        if (lower.endsWith(".zip")) {
            localImportType.value = "zip";
            suggestedAlbumName.value = normalizeBasenameFromPath(p); // zip：带后缀
            return;
        }

        // 尝试判断是否为文件夹
        try {
            const meta = await stat(p);
            if ((meta as any)?.isDirectory) {
                localImportType.value = "folder";
                suggestedAlbumName.value = normalizeBasenameFromPath(p); // folder：文件夹名
            }
        } catch {
            // ignore：可能是不存在/无权限/非文件夹
        }
    },
    { immediate: true }
);

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
    } catch (error) {
        console.error("创建画册失败:", error);
        ElMessage.error("创建画册失败");
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
            const created = await albumStore.createAlbum(newOutputAlbumName.value.trim());
            selectedOutputAlbumId.value = created.id;
            newOutputAlbumName.value = "";
        }

        // local-import：导入文件夹/zip 时，可选自动创建画册（仅当未手选输出画册时生效）
        if (
            !selectedOutputAlbumId.value &&
            autoCreateAlbumForLocalImport.value === true &&
            form.value.pluginId === "local-import" &&
            localImportType.value !== null
        ) {
            const name = suggestedAlbumName.value?.trim();
            if (name) {
                try {
                    const created = await albumStore.createAlbum(name);
                    selectedOutputAlbumId.value = created.id;
                    ElMessage.success(`已创建画册「${created.name}」`);
                } catch (e) {
                    console.warn("自动创建画册失败，将仅添加到画廊:", e);
                    ElMessage.warning("自动创建画册失败：将仅添加到画廊");
                }
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
            });
        }

        // 添加任务（异步执行，不等待完成）
        // outputAlbumId 单独传递，不作为 userConfig 的一部分
        crawlerStore.addTask(
            form.value.pluginId,
            "",
            form.value.outputDir || undefined,
            backendVars,
            selectedOutputAlbumId.value || undefined
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
    } catch (error) {
        console.error("添加任务失败:", error);
        // 只处理添加任务时的错误（如保存配置失败），执行错误由 watch 处理
        ElMessage.error(error instanceof Error ? error.message : "添加任务失败");
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
});
</script>

<style lang="scss" scoped>
.crawl-form {
    margin-bottom: 20px;

    :deep(.el-form-item__label) {
        color: var(--anime-text-primary);
        font-weight: 500;
    }
}

.auto-album-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
}

.auto-album-hint {
    color: var(--anime-text-secondary);
    font-size: 12px;
    margin-left: 6px;
}

.auto-album-tip {
    color: var(--anime-text-secondary);
    font-size: 12px;
}

.config-hint {
    font-size: 12px;
    color: var(--anime-text-secondary);
    margin-top: 4px;
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
