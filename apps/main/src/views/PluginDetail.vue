<template>
    <!-- TODO: 这里AI写的代码太乱，不能细看 -->
    <PluginDetailPage :title="(plugin ? pluginName(plugin) : '') || t('plugins.pluginDetailTitle')" :show-back="true" :loading="loading" :show-skeleton="showSkeleton"
        :plugin="plugin" :installed="isInstalled" :installing="installing" :show-uninstall="true"
        :install-progress-percent="storeInstallProgressPercent"
        :installing-text="installingButtonText"
        :load-doc-image-bytes="loadDocImageBytes" :doc-image-base-url="docImageBaseUrl" @back="goBack" @install="handleInstall" @uninstall="handleUninstall"
        @copy-id="handleCopyPluginId" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "@kabegame/core/env";
import { usePluginStore } from "@/stores/plugins";
import PluginDetailPage from "@kabegame/core/components/plugin/PluginDetailPage.vue";
import type { BrowserPlugin, PluginManifestText } from "@kabegame/core/stores/plugins";

interface PluginDetailDto {
    id: string;
    name: PluginManifestText;
    desp: PluginManifestText;
    version?: string | null;
    /** 文档多语言：{ default, zh?, en?, ... } */
    doc?: Record<string, string> | null;
    iconData?: number[] | null;
    origin: "installed" | "remote" | string;
    baseUrl?: string | null;
}

interface StoreDownloadProgressPayload {
    sourceId: string;
    pluginId: string;
    percent: number;
    error?: string | null;
}

interface ImportPreview {
    id: string;
    name: string;
    version: string;
    sizeBytes: number;
    alreadyExists: boolean;
    existingVersion?: string | null;
    changeLogDiff?: string | null;
    canInstall?: boolean;
    installError?: string | null;
}

interface StoreInstallPreview {
    tmpPath: string;
    preview: ImportPreview;
}

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const pluginStore = usePluginStore();

// 关键：本组件会被 keep-alive 缓存，route 会随着全局路由变化而变化。
// 若不做守卫：当用户从“源详情”切到“画册详情(/albums/:id)”时，
// 这里的 watch 会把画册 id 当成插件 id 去加载，失败后还会把用户强制跳回“源”页。
const isOnPluginDetailRoute = computed(() => route.name === "PluginDetail");

const loading = ref(true);
const showSkeleton = ref(false); // 控制是否显示骨架屏（延迟300ms显示）
const skeletonTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const plugin = ref<BrowserPlugin | null>(null);
const installing = ref(false);
/** 与商店列表一致：sourceId::pluginId，用于 plugin-store-download-progress */
const storeInstallProgressPercent = ref<number | null>(null);
let unlistenStoreDownloadProgress: (() => void) | undefined;

const pluginIdDecoded = computed(() => decodeURIComponent(route.params.id as string));

const installingButtonText = computed(() => {
    if (installing.value && storeInstallProgressPercent.value != null) {
        const p = Math.min(100, Math.max(0, Math.round(storeInstallProgressPercent.value)));
        return t("plugins.installingWithPercent", { percent: p });
    }
    return t("plugins.installing");
});

const formatBytes = (bytes: number) => {
    if (!bytes || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
    return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MB`;
};

const downloadUrl = computed(() => (typeof route.query.downloadUrl === "string" ? route.query.downloadUrl : null));
const sha256 = computed(() => (typeof route.query.sha256 === "string" ? route.query.sha256 : null));
const iconUrl = computed(() => (typeof route.query.iconUrl === "string" ? route.query.iconUrl : null));
const sizeBytes = computed(() => {
    const v = route.query.sizeBytes;
    if (typeof v !== "string") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
});
const sourceId = computed(() => (typeof route.query.sourceId === "string" ? route.query.sourceId : null));
const version = computed(() => (typeof route.query.version === "string" ? route.query.version : null));

/** 与 Rust preview_store_install 中 source_for_key 一致（无 sourceId 时为 "_"） */
const storeProgressKey = computed(
    () => `${sourceId.value ?? "_"}::${pluginIdDecoded.value}`,
);

const isInstalled = computed(() => {
    if (!plugin.value) return false;
    // 插件 ID 已统一为插件文件名（file_stem），按 id 判断即可
    return pluginStore.plugins.some((p) => p.id === plugin.value!.id);
});

const bytesToBase64 = (bytes: Uint8Array): string => {
    // 分批避免堆栈溢出
    const chunkSize = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
};

const loadPlugin = async () => {
    // 从路由参数中获取插件 ID，并进行 URL 解码以支持中文字符
    const pluginId = decodeURIComponent(route.params.id as string);
    const cacheKey = downloadUrl.value ? `${pluginId}::${downloadUrl.value}` : pluginId;

    // 先检查缓存
    const cached = pluginStore.getCachedPluginDetail(cacheKey);
    if (cached) {
        // 缓存命中，直接使用，不需要 loading（路由上的版本号仍可补全旧缓存）
        console.log(`[缓存命中] 插件 key: ${cacheKey}`);
        plugin.value = {
            ...cached,
            version: cached.version ?? version.value ?? undefined,
        };
        loading.value = false;
        showSkeleton.value = false;
        return;
    }

    // 缓存未命中，需要加载
    console.log(`[缓存未命中] 插件 ID: ${pluginId}，开始加载...`);
    // 立即清空旧数据，避免显示上一个源的详情
    plugin.value = null;
    loading.value = true;
    showSkeleton.value = false;
    // 延迟 300ms 显示骨架屏，避免快速加载时闪烁
    if (skeletonTimer.value) {
        clearTimeout(skeletonTimer.value);
    }
    skeletonTimer.value = setTimeout(() => {
        if (loading.value) {
            showSkeleton.value = true;
        }
    }, 300);
    try {
        const detail = await invoke<PluginDetailDto>("get_plugin_detail", {
            pluginId,
            downloadUrl: downloadUrl.value ?? undefined,
            sha256: sha256.value ?? undefined,
            sizeBytes: sizeBytes.value ?? undefined,
            sourceId: sourceId.value ?? undefined,
            version: version.value ?? undefined,
        });

        const icon =
            detail.iconData && detail.iconData.length > 0
                ? `data:image/png;base64,${bytesToBase64(new Uint8Array(detail.iconData))}`
                : (iconUrl.value ?? undefined);

        const found: BrowserPlugin = {
            id: detail.id,
            name: detail.name,
            desp: detail.desp,
            version: detail.version ?? version.value ?? undefined,
            icon,
            doc: detail.doc ?? undefined,
            baseUrl: detail.baseUrl ?? undefined,
        };

        plugin.value = found;

        // 存入缓存（按“来源”区分）
        pluginStore.setCachedPluginDetail(cacheKey, found);
        console.log(`[缓存已保存] 插件 key: ${cacheKey}`);
    } catch (error) {
        console.error("加载源失败:", error);
        // 如果用户已经离开“源详情”页：不要再弹窗/跳转（避免打断其他页面的正常导航）
        if (isOnPluginDetailRoute.value) {
            ElMessage.error(t("plugins.loadPluginFailed"));
            goBack();
        }
    } finally {
        loading.value = false;
        showSkeleton.value = false;
        if (skeletonTimer.value) {
            clearTimeout(skeletonTimer.value);
            skeletonTimer.value = null;
        }
    }
};

const goBack = () => {
    router.push("/plugin-browser");
};

// 插件文档图片 URL 前缀：桌面走 HTTP 服务，安卓走 Kotlin 拦截的 kbg-plugin-doc.localhost
const docImageBaseUrl = ref<string | null>(null);
watch(
    plugin,
    async (p) => {
        if (!p) {
            docImageBaseUrl.value = null;
            return;
        }
        const pluginId = p.id;
        if (IS_ANDROID) {
            docImageBaseUrl.value = `http://kbg-plugin-doc.localhost/${encodeURIComponent(pluginId)}/`;
        } else {
            try {
                const base = await invoke<string>("get_http_server_base_url");
                docImageBaseUrl.value = `${base}/plugin-doc-image?pluginId=${encodeURIComponent(pluginId)}&path=`;
            } catch {
                docImageBaseUrl.value = null;
            }
        }
    },
    { immediate: true }
);

// 供 core 的 PluginDocRenderer 加载 doc_root 图片（无 docImageBaseUrl 时回退，如导入预览）
const loadDocImageBytes = async (imagePath: string): Promise<number[]> => {
    const pluginId = decodeURIComponent(route.params.id as string);
    return await invoke<number[]>("get_plugin_image_for_detail", {
        pluginId,
        imagePath,
        downloadUrl: downloadUrl.value ?? undefined,
        sha256: sha256.value ?? undefined,
        sizeBytes: sizeBytes.value ?? undefined,
        sourceId: sourceId.value ?? undefined,
        version: version.value ?? undefined,
    });
};

const handleInstall = async () => {
    if (!plugin.value) return;

    try {
        const sizeLabel = sizeBytes.value != null ? formatBytes(sizeBytes.value) : t("plugins.unknownSize");
        const msg = downloadUrl.value
            ? t("plugins.installFromStoreConfirm", {
                  name: pluginName(plugin.value),
                  size: sizeLabel,
              })
            : t("plugins.installLocalConfirm", { name: pluginName(plugin.value) });

        await ElMessageBox.confirm(msg, t("plugins.confirmInstall"), {
            type: "warning",
            confirmButtonText: t("plugins.installButton"),
            cancelButtonText: t("common.cancel"),
        });

        installing.value = true;
        if (downloadUrl.value) {
            storeInstallProgressPercent.value = 0;
        }

        if (downloadUrl.value) {
            const res = await invoke<StoreInstallPreview>("preview_store_install", {
                downloadUrl: downloadUrl.value,
                sha256: sha256.value ?? null,
                sizeBytes: sizeBytes.value ?? null,
                sourceId: sourceId.value ?? null,
                version: version.value ?? null,
            });

            if (res.preview.canInstall === false) {
                ElMessage.warning(res.preview.installError || t("plugins.pluginNotAllowed"));
                return;
            }

            await invoke("import_plugin_from_zip", { zipPath: res.tmpPath });
            await invoke("refresh_installed_plugin_cache", { pluginId: plugin.value.id });
            ElMessage.success(t("plugins.installSuccess"));
        } else {
            await invoke("install_browser_plugin", { pluginId: plugin.value.id });
            ElMessage.success(t("plugins.installSuccess"));
        }

        await pluginStore.loadPlugins();
    } catch (error) {
        if (error !== "cancel") {
            console.error("安装失败:", error);
            ElMessage.error(t("plugins.installFailed"));
        }
    } finally {
        installing.value = false;
        storeInstallProgressPercent.value = null;
    }
};

const handleUninstall = async () => {
    if (!plugin.value) return;

    try {
        await ElMessageBox.confirm(`确定要卸载 "${plugin.value.name}" 吗？`, "确认卸载", {
            type: "warning",
        });

        // 找到已安装的插件并删除
        const installed = pluginStore.plugins.find((p) => p.id === plugin.value!.id);
        if (installed) {
            await pluginStore.deletePlugin(installed.id);
            ElMessage.success("卸载成功");
            // 清除缓存，强制重新加载
            pluginStore.clearPluginDetailCache();
            await loadPlugin(); // 重新加载以更新状态
        }
    } catch (error) {
        if (error !== "cancel") {
            console.error("卸载失败:", error);
            ElMessage.error("卸载失败");
        }
    }
};


const handleCopyPluginId = async (id?: string) => {
    const pluginId = id ?? plugin.value?.id;
    if (!pluginId) return;

    try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
            const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(pluginId);
        } else {
            await navigator.clipboard.writeText(pluginId);
        }
        ElMessage.success(t("plugins.pluginIdCopied"));
    } catch (error) {
        console.error("复制失败:", error);
        ElMessage.error(t("plugins.copyFailed"));
    }
};

onMounted(async () => {
    try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
            const { listen } = await import("@tauri-apps/api/event");
            unlistenStoreDownloadProgress = await listen<StoreDownloadProgressPayload>(
                "plugin-store-download-progress",
                (event) => {
                    const { sourceId: sid, pluginId: pid, percent, error: evErr } = event.payload;
                    const k = `${sid}::${pid}`;
                    if (k !== storeProgressKey.value) return;
                    if (evErr) {
                        storeInstallProgressPercent.value = null;
                        return;
                    }
                    storeInstallProgressPercent.value = percent;
                },
            );
        }
    } catch {
        /* 无事件环境 */
    }
    await loadPlugin();
});

onUnmounted(() => {
    unlistenStoreDownloadProgress?.();
});

// 监听路由参数变化，当切换插件时重新加载
watch(
    () => [
        route.params.id,
        route.query.downloadUrl,
        route.query.sha256,
        route.query.sizeBytes,
        route.query.sourceId,
        route.query.version,
    ],
    async (
        [newId, newDownloadUrl, newSha256, newSizeBytes, newSourceId, newVersion],
        [oldId, oldDownloadUrl, oldSha256, oldSizeBytes, oldSourceId, oldVersion],
    ) => {
        // keep-alive 下，route 变化会在后台触发；只在“源详情”页激活时才响应
        if (!isOnPluginDetailRoute.value) return;

        // 只有当 ID 或 query 参数真正变化时才重新加载（避免首次加载时重复调用）
        const idChanged = newId !== oldId;
        const queryChanged =
            newDownloadUrl !== oldDownloadUrl ||
            newSha256 !== oldSha256 ||
            newSizeBytes !== oldSizeBytes ||
            newSourceId !== oldSourceId ||
            newVersion !== oldVersion;

        if ((idChanged || queryChanged) && newId) {
            // 立即清空旧数据，避免显示上一个源的详情
            plugin.value = null;
            loading.value = true;
            showSkeleton.value = false;
            // 清理之前的定时器
            if (skeletonTimer.value) {
                clearTimeout(skeletonTimer.value);
                skeletonTimer.value = null;
            }
            await loadPlugin();
        }
    }
);
</script>

<style scoped lang="scss">
/* 样式已下沉到 @kabegame/core/components/plugin/PluginDetailPage.vue 与 PluginDocRenderer.vue */
</style>
