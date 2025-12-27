<template>
    <div class="plugin-detail-container">
        <div class="plugin-detail-header">
            <div class="header-left">
                <el-button @click="goBack" circle>
                    <el-icon>
                        <ArrowLeft />
                    </el-icon>
                </el-button>
                <div class="plugin-icon-header" v-if="plugin?.icon">
                    <el-image :src="plugin.icon" fit="contain" class="plugin-icon-image" />
                </div>
                <div class="plugin-icon-placeholder-header" v-else>
                    <el-icon>
                        <Grid />
                    </el-icon>
                </div>
                <h1>{{ plugin?.name || "收集源详情" }}</h1>
            </div>
            <div v-if="plugin" class="header-actions">
                <el-tooltip content="收藏" placement="bottom" v-if="!plugin.favorite">
                    <el-button :icon="Star" circle @click="handleToggleFavorite" />
                </el-tooltip>
                <el-tooltip content="取消收藏" placement="bottom" v-else>
                    <el-button :icon="StarFilled" circle type="warning" @click="handleToggleFavorite" />
                </el-tooltip>
                <el-tooltip content="卸载" placement="bottom" v-if="isInstalled">
                    <el-button :icon="Delete" circle type="danger" @click="handleUninstall" />
                </el-tooltip>
            </div>
        </div>

        <div v-if="loading" class="loading">
            <el-skeleton :rows="5" animated />
        </div>

        <div v-else-if="!plugin" class="empty">
            <el-empty description="收集源不存在" />
        </div>

        <div v-else class="plugin-detail-content">
            <!-- 基本信息 -->
            <div class="plugin-info-section">
                <el-descriptions :column="1" border>
                    <el-descriptions-item label="名称">
                        {{ plugin.name }}
                    </el-descriptions-item>
                    <el-descriptions-item label="描述">
                        {{ plugin.desp || "无描述" }}
                    </el-descriptions-item>
                    <el-descriptions-item label="状态">
                        <el-tag v-if="isInstalled" type="success">
                            已安装
                        </el-tag>
                        <el-tag v-else type="info">未安装</el-tag>
                    </el-descriptions-item>
                    <el-descriptions-item label="收藏">
                        <el-tag v-if="plugin.favorite" type="warning">
                            已收藏
                        </el-tag>
                        <el-tag v-else>未收藏</el-tag>
                    </el-descriptions-item>
                </el-descriptions>

                <div class="plugin-actions">
                    <el-button v-if="!isInstalled" type="primary" @click="handleInstall">
                        安装
                    </el-button>
                </div>
            </div>

            <!-- 文档 -->
            <div class="plugin-doc-section">
                <div v-if="plugin.doc" class="plugin-doc-content" v-html="renderedDoc"></div>
                <el-empty v-else description="该收集源暂无文档" :image-size="100" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Star, StarFilled, Delete, Grid } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { usePluginStore } from "@/stores/plugins";
import { pluginCache, type CachedPluginData } from "@/utils/pluginCache";

interface BrowserPlugin {
    id: string;
    name: string;
    desp: string;
    icon?: string;
    favorite?: boolean;
    filePath?: string;
    doc?: string;
}

const route = useRoute();
const router = useRouter();
const pluginStore = usePluginStore();

const loading = ref(true);
const plugin = ref<BrowserPlugin | null>(null);
const renderedDoc = ref<string>("");

const isInstalled = computed(() => {
    if (!plugin.value) return false;
    return pluginStore.plugins.some((p) => {
        // 匹配插件 ID 或名称
        return p.id === plugin.value!.id || p.name === plugin.value!.name;
    });
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

            const imageData = await invoke<number[]>("get_plugin_image", {
                pluginId: pluginId,
                imagePath: normalizedPath,
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

const loadPlugin = async () => {
    // 从路由参数中获取插件 ID，并进行 URL 解码以支持中文字符
    const pluginId = decodeURIComponent(route.params.id as string);
    
    // 先检查缓存
    const cached = pluginCache.get(pluginId);
    if (cached) {
        // 缓存命中，直接使用，不需要 loading
        console.log(`[缓存命中] 插件 ID: ${pluginId}`);
        plugin.value = cached.plugin;
        renderedDoc.value = cached.renderedDoc;
        loading.value = false;
        return;
    }

    // 缓存未命中，需要加载
    console.log(`[缓存未命中] 插件 ID: ${pluginId}，开始加载...`);
    loading.value = true;
    try {
        // 从后端加载
        const plugins = await invoke<BrowserPlugin[]>("get_browser_plugins");
        const found = plugins.find((p) => p.id === pluginId);

        if (found) {
            // 如果有图标路径，加载图标数据
            if (found.icon) {
                try {
                    const iconData = await invoke<number[] | null>("get_plugin_icon", {
                        pluginId: pluginId,
                    });
                    if (iconData && iconData.length > 0) {
                        // 将数组转换为 Uint8Array，然后转换为 base64 data URL
                        const bytes = new Uint8Array(iconData);
                        const binaryString = Array.from(bytes)
                            .map((byte) => String.fromCharCode(byte))
                            .join("");
                        const base64 = btoa(binaryString);
                        found.icon = `data:image/x-icon;base64,${base64}`;
                    } else {
                        found.icon = undefined;
                    }
                } catch (error) {
                    console.error(`加载插件 ${pluginId} 图标失败:`, error);
                    found.icon = undefined;
                }
            }
            
            // 渲染文档（包括处理图片）
            let doc = "";
            if (found.doc) {
                doc = await renderMarkdown(found.doc, pluginId);
            }
            
            plugin.value = found;
            renderedDoc.value = doc;
            
            // 存入缓存
            pluginCache.set(pluginId, {
                plugin: found,
                renderedDoc: doc,
            });
            console.log(`[缓存已保存] 插件 ID: ${pluginId}，缓存大小: ${pluginCache.size()}`);
        } else {
            ElMessage.error("收集源不存在");
            goBack();
        }
    } catch (error) {
        console.error("加载收集源失败:", error);
        ElMessage.error("加载收集源失败");
        goBack();
    } finally {
        loading.value = false;
    }
};

const goBack = () => {
    router.push("/plugin-browser");
};

const handleInstall = async () => {
    if (!plugin.value) return;

    try {
        await invoke("install_browser_plugin", { pluginId: plugin.value.id });
        ElMessage.success("安装成功");
        await pluginStore.loadPlugins();
        // 清除缓存，强制重新加载
        pluginCache.clear();
        await loadPlugin(); // 重新加载以更新状态
    } catch (error) {
        console.error("安装失败:", error);
        ElMessage.error("安装失败");
    }
};

const handleUninstall = async () => {
    if (!plugin.value) return;

    try {
        await ElMessageBox.confirm(`确定要卸载 "${plugin.value.name}" 吗？`, "确认卸载", {
            type: "warning",
        });

        // 找到已安装的插件并删除
        const installed = pluginStore.plugins.find((p) => p.name === plugin.value!.name);
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

const handleToggleFavorite = async () => {
    if (!plugin.value) return;

    try {
        const newFavorite = !plugin.value.favorite;
        await invoke("toggle_plugin_favorite", {
            pluginId: plugin.value.id,
            favorite: newFavorite,
        });
        plugin.value.favorite = newFavorite;
        // 更新缓存中的收藏状态
        const cached = pluginCache.get(plugin.value.id);
        if (cached) {
            cached.plugin.favorite = newFavorite;
        }
        ElMessage.success(newFavorite ? "已收藏" : "已取消收藏");
    } catch (error) {
        console.error("更新收藏状态失败:", error);
        ElMessage.error("更新收藏状态失败");
    }
};

onMounted(async () => {
    await loadPlugin();
});
</script>

<style scoped lang="scss">
.plugin-detail-container {
    width: 100%;
    height: 100%;
    padding: 20px;
    overflow-y: auto;
}

.plugin-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
    padding: 16px;
    background: var(--anime-bg-card);
    border-radius: 12px;
    box-shadow: var(--anime-shadow);

.header-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
}

.plugin-icon-header {
    width: 64px;
    height: 64px;
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--anime-bg-secondary);
    border: 2px solid var(--anime-border);

        .plugin-icon-image {
    width: 100%;
    height: 100%;
}

        :deep(.el-image__inner) {
    width: 100%;
    height: 100%;
    object-fit: contain;
        }
}

.plugin-icon-placeholder-header {
    width: 64px;
    height: 64px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.2) 0%, rgba(167, 139, 250, 0.2) 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--anime-primary);
    font-size: 32px;
    border: 2px solid var(--anime-border);
}

    h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    }
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
