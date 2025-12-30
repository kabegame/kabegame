<template>
    <TabLayout :title="plugin?.name || '源详情'" show-back @back="goBack">
        <template #icon>
            <div v-if="plugin?.icon" class="plugin-icon-wrap">
                <el-image :src="plugin.icon" fit="contain" class="plugin-icon-image" />
            </div>
            <div v-else class="plugin-icon-placeholder">
                <el-icon>
                    <Grid />
                </el-icon>
            </div>
        </template>
        <template #actions>
            <div v-if="plugin" class="header-actions">
                <el-tooltip content="卸载" placement="bottom" v-if="isInstalled">
                    <el-button :icon="Delete" circle type="danger" @click="handleUninstall" />
                </el-tooltip>
            </div>
        </template>

        <div v-if="showSkeleton" class="loading">
            <el-skeleton :rows="5" animated />
        </div>

        <div v-else-if="!loading && !plugin" class="empty">
            <el-empty description="源不存在" />
        </div>

        <div v-else class="plugin-detail-content">
            <!-- 基本信息 -->
            <div class="plugin-info-section">
                <el-descriptions :column="1" border>
                    <el-descriptions-item label="插件ID">
                        <div class="plugin-id-container">
                            <span class="plugin-id-text">{{ plugin?.id }}</span>
                            <el-button :icon="DocumentCopy" circle size="small" @click="handleCopyPluginId"
                                title="复制插件ID" />
                        </div>
                    </el-descriptions-item>
                    <el-descriptions-item label="名称">
                        {{ plugin?.name }}
                    </el-descriptions-item>
                    <el-descriptions-item label="描述">
                        {{ plugin?.desp || "无描述" }}
                    </el-descriptions-item>
                    <el-descriptions-item label="状态">
                        <el-tag v-if="isInstalled" type="success">
                            已安装
                        </el-tag>
                        <el-tag v-else type="info">未安装</el-tag>
                    </el-descriptions-item>
                </el-descriptions>

                <div class="plugin-actions">
                    <el-button v-if="!isInstalled" type="primary" :loading="installing" :disabled="installing"
                        @click="handleInstall">
                        {{ installing ? "安装中..." : "安装" }}
                    </el-button>
                </div>
            </div>

            <!-- 文档 -->
            <div class="plugin-doc-section">
                <div v-if="plugin?.doc" class="plugin-doc-content" v-html="renderedDoc"></div>
                <el-empty v-else description="该源暂无文档" :image-size="100" />
            </div>
        </div>
    </TabLayout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Grid, DocumentCopy } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { usePluginStore } from "@/stores/plugins";
import { pluginCache } from "@/utils/pluginCache";
import TabLayout from "@/layouts/TabLayout.vue";

interface BrowserPlugin {
    id: string;
    name: string;
    desp: string;
    icon?: string;
    filePath?: string;
    doc?: string;
}

interface PluginDetailDto {
    id: string;
    name: string;
    desp: string;
    doc?: string | null;
    iconData?: number[] | null;
    origin: "installed" | "remote" | string;
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
const renderedDoc = ref<string>("");
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

// 简单的 Markdown 渲染，支持图片
const renderMarkdown = async (markdown: string, pluginId: string): Promise<string> => {
    if (!markdown) return "";

    // 先处理图片：将 Markdown 图片语法转换为使用 Tauri 命令加载的图片
    // 匹配 ![alt](path) 格式，注意路径可能包含括号和 URL 编码
    // 问题：标准正则 `([^)]+)` 在遇到第一个 `)` 时停止，但路径中可能有括号（如 `1 (64).jpeg`）
    // 解决方案：手动解析，查找最后一个 `)` 作为路径结束标志
    const imageMatches: Array<{ match: string; alt: string; path: string; index: number }> = [];

    // 由于标准正则无法处理路径中包含括号的情况，我们需要手动解析
    // 查找所有 `![` 开头的图片引用
    let searchIndex = 0;
    while (searchIndex < markdown.length) {
        const imgStart = markdown.indexOf('![', searchIndex);
        if (imgStart === -1) break;

        const altStart = imgStart + 2;
        const altEnd = markdown.indexOf(']', altStart);
        if (altEnd === -1) break;

        const pathStart = markdown.indexOf('(', altEnd);
        if (pathStart === -1 || pathStart !== altEnd + 1) break;

        // 从路径开始位置查找最后一个 `)`，这样可以匹配包含括号的路径
        let pathEnd = markdown.indexOf(')', pathStart + 1);
        if (pathEnd === -1) break;

        // 检查路径后面是否还有内容（可能是文件扩展名），如果是，继续查找
        // 简单方法：查找行尾或空格之前的最后一个 `)`
        let nextBrace = markdown.indexOf(')', pathEnd + 1);
        while (nextBrace !== -1 && nextBrace < markdown.length) {
            // 检查 `)` 后面的字符，如果是空格、换行、或 `!`（下一个图片），则停止
            const nextChar = markdown[nextBrace + 1];
            if (nextChar === ' ' || nextChar === '\n' || nextChar === '!' || nextChar === undefined) {
                pathEnd = nextBrace;
                break;
            }
            nextBrace = markdown.indexOf(')', nextBrace + 1);
        }

        const altText = markdown.substring(altStart, altEnd);
        const imagePath = markdown.substring(pathStart + 1, pathEnd);
        const fullMatch = markdown.substring(imgStart, pathEnd + 1);

        console.log("Parsed image path:", imagePath);

        imageMatches.push({
            match: fullMatch,
            alt: altText,
            path: imagePath,
            index: imageMatches.length,
        });

        searchIndex = pathEnd + 1;
    }

    // 为每个图片创建加载函数
    const loadImage = async (imgPath: string): Promise<string> => {
        try {
            // 规范化图片路径：移除 ./ 前缀，处理 URL 编码
            let normalizedPath = imgPath.trim();
            console.log("Original image path:", normalizedPath);

            // 安全检查 1: 拒绝绝对路径
            if (normalizedPath.startsWith("/") || normalizedPath.startsWith("\\")) {
                throw new Error("Absolute paths are not allowed");
            }

            // 安全检查 2: 拒绝明显的路径遍历攻击（前端初步检查，后端会有更严格的验证）
            if (normalizedPath.includes("../") || normalizedPath.includes("..\\")) {
                throw new Error("Path traversal attacks are not allowed");
            }

            // 移除 ./ 前缀
            if (normalizedPath.startsWith("./")) {
                normalizedPath = normalizedPath.substring(2);
            }
            // 移除 doc_root/ 前缀（如果存在，因为后端会自动添加）
            if (normalizedPath.startsWith("doc_root/")) {
                normalizedPath = normalizedPath.substring(9);
            }

            // 解码 URL 编码的字符（如 %20 -> 空格）
            // 先尝试完整的 decodeURIComponent
            try {
                normalizedPath = decodeURIComponent(normalizedPath);
            } catch (e) {
                // 如果解码失败，尝试手动替换常见的编码字符
                normalizedPath = normalizedPath
                    .replace(/%20/g, " ")
                    .replace(/%28/g, "(")
                    .replace(/%29/g, ")")
                    .replace(/%2F/g, "/")
                    .replace(/%2E/g, ".")
                    .replace(/%5F/g, "_");
            }

            // 安全检查 3: 解码后再次检查路径遍历
            if (normalizedPath.includes("../") || normalizedPath.includes("..\\")) {
                throw new Error("Path traversal detected after decoding");
            }

            // 安全检查 4: 确保路径不为空
            if (!normalizedPath) {
                throw new Error("Empty image path is not allowed");
            }

            console.log("Normalized image path:", normalizedPath);

            const imageData = await invoke<number[]>("get_plugin_image_for_detail", {
                pluginId: pluginId,
                imagePath: normalizedPath,
                downloadUrl: downloadUrl.value ?? undefined,
                sha256: sha256.value ?? undefined,
                sizeBytes: sizeBytes.value ?? undefined,
            });

            // 将字节数组转换为 base64
            // 使用分批处理避免堆栈溢出（当图片很大时，...bytes 会超出调用堆栈限制）
            const bytes = new Uint8Array(imageData);
            const chunkSize = 8192; // 每次处理 8KB
            let binaryString = '';
            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, i + chunkSize);
                binaryString += String.fromCharCode.apply(null, Array.from(chunk));
            }
            const base64 = btoa(binaryString);

            // 根据文件扩展名确定 MIME 类型
            const ext = imgPath.split('.').pop()?.toLowerCase();
            let mimeType = "image/png";
            if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
            else if (ext === "gif") mimeType = "image/gif";
            else if (ext === "webp") mimeType = "image/webp";

            return `data:${mimeType};base64,${base64}`;
        } catch (error) {
            console.error("Failed to load image:", error);
            return ""; // 返回空字符串，图片将无法显示
        }
    };

    // 处理所有图片（按索引倒序处理，避免替换时索引偏移问题）
    let processedMarkdown = markdown;
    for (const img of imageMatches.reverse()) {
        const imageUrl = await loadImage(img.path);
        if (imageUrl) {
            // 转义特殊字符以避免在 replace 时出现问题
            const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            processedMarkdown = processedMarkdown.replace(
                new RegExp(escapedMatch, 'g'),
                `<img src="${imageUrl}" alt="${img.alt}" style="max-width: 100%; height: auto;" />`
            );
        } else {
            // 如果加载失败，保留原始 Markdown 语法或显示占位符
            const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            processedMarkdown = processedMarkdown.replace(
                new RegExp(escapedMatch, 'g'),
                `[图片加载失败: ${img.path}]`
            );
        }
    }

    // 处理其他 Markdown 语法
    let html = processedMarkdown
        .replace(/^### (.*$)/gim, "<h3>$1</h3>")
        .replace(/^## (.*$)/gim, "<h2>$1</h2>")
        .replace(/^# (.*$)/gim, "<h1>$1</h1>")
        .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
        .replace(/\*(.*?)\*/gim, "<em>$1</em>")
        .replace(/```([\s\S]*?)```/gim, "<pre><code>$1</code></pre>")
        .replace(/`(.*?)`/gim, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" target="_blank">$1</a>')
        .replace(/^\s*[-*+]\s+(.*)$/gim, "<li>$1</li>")
        .replace(/^\s*\d+\.\s+(.*)$/gim, "<li>$1</li>")
        .replace(/\n\n/gim, "</p><p>")
        .replace(/\n/gim, "<br>");

    html = html.replace(/(<li>.*<\/li>)/gim, "<ul>$1</ul>");

    if (!html.startsWith("<h") && !html.startsWith("<ul") && !html.startsWith("<pre") && !html.startsWith("<img")) {
        html = "<p>" + html + "</p>";
    }

    return html;
};

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
        renderedDoc.value = cached.renderedDoc;
        loading.value = false;
        showSkeleton.value = false;
        return;
    }

    // 缓存未命中，需要加载
    console.log(`[缓存未命中] 插件 ID: ${pluginId}，开始加载...`);
    // 立即清空旧数据，避免显示上一个源的详情
    plugin.value = null;
    renderedDoc.value = "";
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
        };

        // 渲染文档（包括处理图片）
        const doc = found.doc ? await renderMarkdown(found.doc, pluginId) : "";

        plugin.value = found;
        renderedDoc.value = doc;

        // 存入缓存（按“来源”区分）
        pluginCache.set(cacheKey, {
            plugin: found,
            renderedDoc: doc,
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


const handleCopyPluginId = async () => {
    if (!plugin.value) return;

    try {
        await navigator.clipboard.writeText(plugin.value.id);
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
            renderedDoc.value = "";
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
.header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.plugin-icon-wrap,
.plugin-icon-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
}

.plugin-icon-image {
    width: 100%;
    height: 100%;
}

.plugin-icon-placeholder {
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.2) 0%, rgba(167, 139, 250, 0.2) 100%);
    color: var(--anime-primary);
    font-size: 32px;
}

.plugin-detail-content {
    background: var(--anime-bg-card);
    border-radius: 12px;
    padding: 20px;
    box-shadow: var(--anime-shadow);

    .loading {
        padding: 40px;
    }

    .empty {
        padding: 40px;
        text-align: center;
    }

    .plugin-info-section {
        margin-bottom: 32px;
    }

    .plugin-actions {
        display: flex;
        gap: 12px;
        margin-top: 20px;
    }

    .plugin-doc-section {
        margin-top: 32px;
    }

    /* 禁用标签和按钮的初始展开动画 */
    :deep(.el-tag) {
        animation: none !important;
        transition: none !important;
    }

    :deep(.el-button) {
        animation: none !important;
        transition: none !important;
    }

    /* 禁用 el-descriptions-item 内容的动画 */
    :deep(.el-descriptions-item__content) {
        animation: none !important;
        transition: none !important;
    }

    .plugin-id-container {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .plugin-id-text {
        font-family: "Courier New", monospace;
        color: var(--anime-text-primary);
        user-select: text;
    }

    .plugin-doc-content {
        padding: 16px;
        background: var(--anime-bg-card);
        border-radius: 8px;
        line-height: 1.6;

        :deep(h1),
        :deep(h2),
        :deep(h3) {
            margin-top: 16px;
            margin-bottom: 8px;
            color: var(--anime-text-primary);
            font-weight: 600;
        }

        :deep(h1) {
            font-size: 24px;
            border-bottom: 2px solid var(--anime-border);
            padding-bottom: 8px;
        }

        :deep(h2) {
            font-size: 20px;
        }

        :deep(h3) {
            font-size: 16px;
        }

        :deep(p) {
            margin: 8px 0;
            color: var(--anime-text-primary);
        }

        :deep(ul),
        :deep(ol) {
            margin: 8px 0;
            padding-left: 24px;
            color: var(--anime-text-primary);
        }

        :deep(li) {
            margin: 4px 0;
        }

        :deep(code) {
            background: rgba(255, 107, 157, 0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: "Courier New", monospace;
            font-size: 0.9em;
            color: var(--anime-primary);
        }

        :deep(pre) {
            background: rgba(255, 107, 157, 0.05);
            padding: 12px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 12px 0;
            border: 1px solid var(--anime-border);

            code {
                background: transparent;
                padding: 0;
                color: var(--anime-text-primary);
            }
        }

        :deep(a) {
            color: var(--anime-primary);
            text-decoration: none;

            &:hover {
                text-decoration: underline;
            }
        }

        :deep(strong) {
            color: var(--anime-text-primary);
            font-weight: 600;
        }

        :deep(em) {
            color: var(--anime-text-secondary);
            font-style: italic;
        }
    }
}
</style>
