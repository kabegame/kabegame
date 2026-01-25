<template>
    <!-- TODO: 这里AI写的代码太乱，不能细看 -->
    <PluginDetailPage :title="plugin?.name || '源详情'" :show-back="true" :loading="loading" :show-skeleton="showSkeleton"
        :plugin="plugin" :installed="isInstalled" :installing="installing" :show-uninstall="true"
        :load-doc-image-bytes="loadDocImageBytes" @back="goBack" @install="handleInstall" @uninstall="handleUninstall"
        @copy-id="handleCopyPluginId" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { usePluginStore } from "@/stores/plugins";
import { pluginCache } from "@/utils/pluginCache";
import PluginDetailPage from "@kabegame/core/components/plugin/PluginDetailPage.vue";
import { BrowserPlugin } from "@/utils/pluginCache";

interface PluginDetailDto {
    id: string;
    name: string;
    desp: string;
    doc?: string | null;
    iconData?: number[] | null;
    origin: "installed" | "remote" | "builtin" | string;
    baseUrl?: string | null;
}

interface ImportPreview {
    id: string;
    name: string;
    version: string;
    sizeBytes: number;
    alreadyExists: boolean;
    existingVersion?: string | null;
    changeLogDiff?: string | null;
}

interface StoreInstallPreview {
    tmpPath: string;
    preview: ImportPreview;
}

const route = useRoute();
const router = useRouter();
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

const downloadUrl = computed(() => (typeof route.query.downloadUrl === "string" ? route.query.downloadUrl : null));
const sha256 = computed(() => (typeof route.query.sha256 === "string" ? route.query.sha256 : null));
const iconUrl = computed(() => (typeof route.query.iconUrl === "string" ? route.query.iconUrl : null));
const sizeBytes = computed(() => {
    const v = route.query.sizeBytes;
    if (typeof v !== "string") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
});

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
    const cached = pluginCache.get(cacheKey);
    if (cached) {
        // 缓存命中，直接使用，不需要 loading
        console.log(`[缓存命中] 插件 key: ${cacheKey}`);
        plugin.value = cached.plugin;
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
        });

        const icon =
            detail.iconData && detail.iconData.length > 0
                ? `data:image/png;base64,${bytesToBase64(new Uint8Array(detail.iconData))}`
                : (iconUrl.value ?? undefined);

        const found: BrowserPlugin = {
            id: detail.id,
            name: detail.name,
            desp: detail.desp,
            icon,
            doc: detail.doc ?? undefined,
            baseUrl: detail.baseUrl ?? undefined,
            isBuiltIn: detail.origin === "builtin",
        };

        plugin.value = found;

        // 存入缓存（按“来源”区分）
        pluginCache.set(cacheKey, {
            plugin: found,
        });
        console.log(`[缓存已保存] 插件 key: ${cacheKey}，缓存大小: ${pluginCache.size()}`);
    } catch (error) {
        console.error("加载源失败:", error);
        // 如果用户已经离开“源详情”页：不要再弹窗/跳转（避免打断其他页面的正常导航）
        if (isOnPluginDetailRoute.value) {
            ElMessage.error("加载源失败");
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

// 供 core 的 PluginDocRenderer 加载 doc_root 图片
const loadDocImageBytes = async (imagePath: string): Promise<number[]> => {
    const pluginId = decodeURIComponent(route.params.id as string);
    return await invoke<number[]>("get_plugin_image_for_detail", {
        pluginId,
        imagePath,
        downloadUrl: downloadUrl.value ?? undefined,
        sha256: sha256.value ?? undefined,
        sizeBytes: sizeBytes.value ?? undefined,
    });
};

const handleInstall = async () => {
    if (!plugin.value) return;

    try {
        // 先弹确认（不要先下载/预览，否则确认会延迟）
        const title = "确认安装";
        const prettySize = sizeBytes.value != null ? `${sizeBytes.value} bytes` : "未知大小";
        const msg = downloadUrl.value
            ? `将从商店下载并安装「${plugin.value.name}」（${prettySize}），是否继续？`
            : `将安装本地源「${plugin.value.name}」，是否继续？`;

        await ElMessageBox.confirm(msg, title, {
            type: "warning",
            confirmButtonText: "安装",
            cancelButtonText: "取消",
        });

        installing.value = true;

        if (downloadUrl.value) {
            // 商店/官方源：确认后再下载到临时文件并安装
            const res = await invoke<StoreInstallPreview>("preview_store_install", {
                downloadUrl: downloadUrl.value,
                sha256: sha256.value ?? null,
                sizeBytes: sizeBytes.value ?? null,
            });
            await invoke("import_plugin_from_zip", { zipPath: res.tmpPath });
            ElMessage.success("安装成功");
        } else {
            // 兼容：本地已存在但未“标记安装”的情况
            await invoke("install_browser_plugin", { pluginId: plugin.value.id });
            ElMessage.success("安装成功");
        }

        // 只刷新 store，让“已安装”状态即时更新；不重载详情页，避免“刷新感”
        await pluginStore.loadPlugins();
    } catch (error) {
        if (error !== "cancel") {
            console.error("安装失败:", error);
            ElMessage.error("安装失败");
        }
    } finally {
        installing.value = false;
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
            pluginCache.clear();
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
        await navigator.clipboard.writeText(pluginId);
        ElMessage.success("插件ID已复制到剪贴板");
    } catch (error) {
        console.error("复制失败:", error);
        ElMessage.error("复制失败");
    }
};

onMounted(async () => {
    await loadPlugin();
});

// 监听路由参数变化，当切换插件时重新加载
watch(
    () => [route.params.id, route.query.downloadUrl, route.query.sha256, route.query.sizeBytes],
    async ([newId, newDownloadUrl, newSha256, newSizeBytes], [oldId, oldDownloadUrl, oldSha256, oldSizeBytes]) => {
        // keep-alive 下，route 变化会在后台触发；只在“源详情”页激活时才响应
        if (!isOnPluginDetailRoute.value) return;

        // 只有当 ID 或 query 参数真正变化时才重新加载（避免首次加载时重复调用）
        const idChanged = newId !== oldId;
        const queryChanged = newDownloadUrl !== oldDownloadUrl || newSha256 !== oldSha256 || newSizeBytes !== oldSizeBytes;

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
