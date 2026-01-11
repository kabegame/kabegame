<template>
    <div v-loading="loading">
        <el-alert v-if="errorMsg" type="error" :closable="false" show-icon title="解析失败" :description="errorMsg" />

        <PluginDetailPage v-else :title="pageTitle" :subtitle="zipPath || '（未提供文件路径）'" :show-back="false"
            :loading="loading" :show-skeleton="false" :plugin="pluginVm" :installed="installed" :installing="installing"
            :show-uninstall="false" :install-text="installText" :installing-text="'安装中...'" :empty-description="'插件不存在'"
            :doc-empty-description="'该插件暂无文档'" :load-doc-image-bytes="loadDocImageBytes" @install="doInstall"
            @copy-id="copyText">
            <template #detail-extra-items>
                <el-descriptions-item label="版本" v-if="preview">
                    v{{ preview.preview.version }}
                    <span v-if="preview.preview.alreadyExists" class="muted">
                        （已安装：v{{ preview.preview.existingVersion || "?" }}）
                    </span>
                </el-descriptions-item>
                <el-descriptions-item label="目标目录" v-if="preview">
                    {{ preview.pluginsDir }}
                </el-descriptions-item>
            </template>
            <template #detail-actions>
                <el-button :type="installed ? 'warning' : 'primary'" :loading="installing" :disabled="installing"
                    @click="doInstall">
                    {{ installText }}
                </el-button>
            </template>
        </PluginDetailPage>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ElMessage } from "element-plus";
import PluginDetailPage from "@kabegame/core/components/plugin/PluginDetailPage.vue";
import { isUpdateAvailable } from "@kabegame/core/utils/version";

type ImportPreview = {
    id: string;
    name: string;
    version: string;
    sizeBytes: number;
    alreadyExists: boolean;
    existingVersion?: string | null;
    changeLogDiff?: string | null;
};

type PluginManifest = {
    name: string;
    version: string;
    description: string;
    author?: string;
};

type CliImportPreview = {
    preview: ImportPreview;
    manifest: PluginManifest;
    iconPngBase64?: string | null;
    filePath: string;
    pluginsDir: string;
};

const query = new URLSearchParams(location.search);
const zipPath = query.get("zipPath") || "";

const loading = ref(false);
const installing = ref(false);
const errorMsg = ref<string | null>(null);
const preview = ref<CliImportPreview | null>(null);
const installed = ref(false);
const detail = ref<any | null>(null);

const iconDataUrl = computed(() => {
    const b64 = preview.value?.iconPngBase64;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
});

const pluginVm = computed(() => {
    if (!preview.value) return null;
    return {
        id: preview.value.preview.id,
        name: preview.value.preview.name,
        desp: preview.value.manifest.description,
        icon: iconDataUrl.value ?? undefined,
        doc: (detail.value?.doc as string | undefined) ?? undefined,
        baseUrl: (detail.value?.baseUrl as string | undefined) ?? undefined,
    };
});

const pageTitle = computed(() => pluginVm.value?.name || "插件导入");
const installText = computed(() => {
    const p = preview.value?.preview;
    if (!p) return "安装";
    if (!p.alreadyExists) return "安装";
    const existing = p.existingVersion ?? null;
    // 已安装版本不比要安装的版本旧 => 重新安装，否则更新
    return isUpdateAvailable(existing, p.version) ? "更新" : "重新安装";
});

const shouldCloseOnError = computed(() => true);

const closeWindow = async () => {
    try {
        await getCurrentWindow().close();
    } catch {
        // ignore
    }
};

const loadPreview = async (opts?: { closeOnError?: boolean }) => {
    const closeOnError = opts?.closeOnError ?? shouldCloseOnError.value;
    if (!zipPath) {
        errorMsg.value = "未提供 zipPath 参数（需要通过 CLI 传入 .kgpg 路径）";
        if (closeOnError) await closeWindow();
        return;
    }
    loading.value = true;
    errorMsg.value = null;
    try {
        const res = await invoke<CliImportPreview>("cli_preview_import_plugin", {
            zipPath,
        });
        preview.value = res;
        installed.value = !!res.preview.alreadyExists;
        detail.value = await invoke("cli_get_plugin_detail_from_zip", { zipPath });
    } catch (e: any) {
        errorMsg.value = typeof e === "string" ? e : String(e?.message || e);
        if (closeOnError) {
            // 让用户能看到一眼错误（避免“闪退”）
            setTimeout(() => void closeWindow(), 1200);
        }
    } finally {
        loading.value = false;
    }
};

const loadDocImageBytes = async (imagePath: string): Promise<number[]> => {
    return await invoke<number[]>("cli_get_plugin_image_from_zip", { zipPath, imagePath });
};

const doInstall = async () => {
    if (!preview.value) return;
    installing.value = true;
    try {
        await invoke("cli_import_plugin_from_zip", { zipPath });
        ElMessage.success("安装成功");
        // 安装完成：刷新一次页面信息（状态/版本/按钮文案）
        // 这里不应因刷新失败而关闭窗口（避免“安装成功但界面闪退”）
        await loadPreview({ closeOnError: false });
    } catch (e: any) {
        ElMessage.error(typeof e === "string" ? e : String(e?.message || e));
        // 失败：按需求直接关闭
        await closeWindow();
    } finally {
        installing.value = false;
    }
};

const copyText = async (text: string) => {
    try {
        await navigator.clipboard.writeText(text);
        ElMessage.success("已复制");
    } catch {
        ElMessage.error("复制失败");
    }
};

onMounted(() => {
    void loadPreview({ closeOnError: true });
});
</script>

<style scoped>
.muted {
    opacity: 0.7;
}
</style>
