<template>
    <PluginDetailContent
        :title="(plugin ? pluginName(plugin) : '') || t('plugins.pluginDetailTitle')"
        show-back
        :loading="loading"
        :show-skeleton="showSkeleton"
        :plugin="plugin"
        :installed="isInstalled"
        :installing="installing"
        :show-uninstall="true"
        :installing-text="t('plugins.installing')"
        :app-version="appVersion"
        :load-doc-image-bytes="loadDocImageBytes"
        :doc-image-base-url="docImageBaseUrl"
        @back="goBack" @install="handleInstall"
        @uninstall="handleUninstall"
        @copy-id="handleCopyPluginId" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "@kabegame/core/env";
import { usePluginStore } from "@/stores/plugins";
import { useApp } from "@/stores/app";
import { storeToRefs } from "pinia";
import PluginDetailContent from "@kabegame/core/components/plugin/PluginDetailContent.vue";
import type { Plugin } from "@kabegame/core/stores/plugins";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const pluginStore = usePluginStore();
const { version: appVersion } = storeToRefs(useApp());

// 关键：本组件会被 keep-alive 缓存，route 会随着全局路由变化而变化。
// 若不做守卫：当用户从"源详情"切到"画册详情(/albums/:id)"时，
// 这里的 watch 会把画册 id 当成插件 id 去加载，失败后还会把用户强制跳回"源"页。
const isOnPluginDetailRoute = computed(() => route.name === "PluginDetail");

const loading = ref(true);
const showSkeleton = ref(false); // 控制是否显示骨架屏（延迟300ms显示）
const skeletonTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const plugin = ref<Plugin | null>(null);
const installing = ref(false);

const pluginIdDecoded = computed(() => decodeURIComponent(route.params.id as string));
const mode = computed(() => route.query.mode === "remote" ? "remote" as const : "local" as const);
const sourceId = computed(() => (typeof route.query.sourceId === "string" ? route.query.sourceId : null));

const isInstalled = computed(() => {
    if (!plugin.value) return false;
    return pluginStore.plugins.some((p) => p.id === plugin.value!.id);
});

const loadPlugin = async () => {
    const pluginId = decodeURIComponent(route.params.id as string);

    // 已安装插件：直接从 store 读取（零 IPC）
    if (mode.value !== "remote") {
        const found = pluginStore.plugins.find((p) => p.id === pluginId);
        plugin.value = found ?? null;
        loading.value = false;
        showSkeleton.value = false;
        if (!found && isOnPluginDetailRoute.value) {
            ElMessage.error(t("plugins.loadPluginFailed"));
            goBack();
        }
        return;
    }

    // 远程插件：先检查 pluginDetailCache
    const cacheKey = `${pluginId}::${sourceId.value}`;
    const cached = pluginStore.getCachedPluginDetail(cacheKey);
    if (cached) {
        plugin.value = cached;
        loading.value = false;
        showSkeleton.value = false;
        return;
    }

    // 缓存未命中，从后端加载（后端返回完整 Plugin）
    plugin.value = null;
    loading.value = true;
    showSkeleton.value = false;
    if (skeletonTimer.value) {
        clearTimeout(skeletonTimer.value);
    }
    skeletonTimer.value = setTimeout(() => {
        if (loading.value) {
            showSkeleton.value = true;
        }
    }, 300);
    try {
        const result = await invoke<Plugin>("get_plugin_detail", {
            pluginId,
            sourceId: sourceId.value ?? undefined,
        });
        plugin.value = result;
        pluginStore.setCachedPluginDetail(cacheKey, result);
    } catch (error) {
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
        // 已安装插件直接使用 Plugin.docResources（内嵌 base64），无需 HTTP/自定义 host
        if (mode.value !== "remote") {
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
        sourceId: sourceId.value ?? undefined,
    });
};

const handleInstall = async () => {
    if (!plugin.value || mode.value !== "remote" || !sourceId.value) return;

    try {
        await ElMessageBox.confirm(
            t("plugins.installFromStoreConfirm", { name: pluginName(plugin.value) }),
            t("plugins.confirmInstall"),
            {
                type: "warning",
                confirmButtonText: t("plugins.installButton"),
                cancelButtonText: t("common.cancel"),
            },
        );

        installing.value = true;
        await invoke("install_from_store", {
            sourceId: sourceId.value,
            pluginId: pluginIdDecoded.value,
        });
        ElMessage.success(t("plugins.installSuccess"));
        // plugin-added / plugin-updated event auto-updates the store
    } catch (error) {
        if (error !== "cancel") {
            ElMessage.error(t("plugins.installFailed"));
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

        const installed = pluginStore.plugins.find((p) => p.id === plugin.value!.id);
        if (installed) {
            await pluginStore.deletePlugin(installed.id);
            ElMessage.success("卸载成功");
            pluginStore.clearPluginDetailCache();
            await loadPlugin();
        }
    } catch (error) {
        if (error !== "cancel") {
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
        ElMessage.error(t("plugins.copyFailed"));
    }
};

onMounted(async () => {
    await loadPlugin();
});

// 监听路由参数变化，当切换插件时重新加载
watch(
    () => [route.params.id, route.query.mode, route.query.sourceId],
    async ([newId, newMode, newSourceId], [oldId, oldMode, oldSourceId]) => {
        // keep-alive 下，route 变化会在后台触发；只在"源详情"页激活时才响应
        if (!isOnPluginDetailRoute.value) return;

        const idChanged = newId !== oldId;
        const queryChanged = newMode !== oldMode || newSourceId !== oldSourceId;
        if (newId && (idChanged || queryChanged)) {
            plugin.value = null;
            loading.value = true;
            showSkeleton.value = false;
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
