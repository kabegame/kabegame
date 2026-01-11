<template>
    <div class="wallpaper-root" @pointerdown="handleWallpaperPointerDown">
        <div v-if="mode !== 'tile'" class="wallpaper-stage">
            <img v-if="baseSrc" class="wallpaper-img base" :style="imgStyle" :src="baseSrc" alt="wallpaper-base"
                @error="handleImageError('base')" />
            <img v-if="topSrc" class="wallpaper-img top" :class="topClasses" :style="imgStyle" :src="topSrc"
                alt="wallpaper-top" @transitionend="handleTopTransitionEnd" @error="handleImageError('top')" />
        </div>
        <div v-else class="wallpaper-stage">
            <div v-if="baseSrc" class="wallpaper-tile base" :style="baseTileStyle"></div>
            <div v-if="topSrc" class="wallpaper-tile top" :class="topClasses" :style="topTileStyle"
                @transitionend="handleTopTransitionEnd"></div>
        </div>

        <!-- 调试面板：确认壁纸窗口是否真正收到事件并渲染（仅开发模式） -->
        <div v-if="IS_DEV" class="debug-panel">
            <div class="debug-title">Wallpaper Debug</div>
            <div>label: {{ windowLabel || "unknown" }}</div>
            <div>ready invoked: {{ readyInvoked ? "yes" : "no" }}</div>
            <div>last image ts: {{ lastImageTs || "-" }}</div>
            <div>last style ts: {{ lastStyleTs || "-" }}</div>
            <div>last transition ts: {{ lastTransitionTs || "-" }}</div>
            <div>mode: {{ mode }}</div>
            <div>transition: {{ transition }}</div>
            <div class="debug-path">rawPath: {{ lastRawPath || "-" }}</div>
            <div v-if="lastError" class="debug-error">error: {{ lastError }}</div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { IS_DEV } from "@kabegame/core/env";

if (IS_DEV) {
    import("../styles/debug-panel.css")
}

type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
type Transition = "none" | "fade" | "slide" | "zoom";

const baseSrc = ref<string>("");
const topSrc = ref<string>("");
const phase = ref<"idle" | "prep" | "enter">("idle");

const lastRawPath = ref<string>("");
// 用于去重：后端在窗口模式切换时可能会短时间重复推送同一路径（保证前端监听 ready）
// 如果这里不去重，会导致反复创建 blob URL + 反复触发过渡动画，从而出现“闪烁几次才稳定”
const currentPath = ref<string>(""); // 当前已经显示在 base 的真实文件路径
const pendingPath = ref<string>(""); // 当前正在过渡中的文件路径（top）
const queuedPath = ref<string>(""); // 过渡进行中收到的新目标：只保留最后一次，避免中途打断造成闪烁
const busy = ref(false); // 严格串行：避免 async readFile 并发导致“插队闪烁”
const mode = ref<Mode>("fill");
const transition = ref<Transition>("fade");

const windowLabel = ref<string>("");
const readyInvoked = ref(false);
const lastImageTs = ref<string>("");
const lastStyleTs = ref<string>("");
const lastTransitionTs = ref<string>("");
const lastError = ref<string>("");
let transitionGuardTimer: number | null = null;

// 当壁纸窗口被点击时，说明被系统抬到图标层之上，此时需要主动触发一次后端的 Z-order 修复逻辑，把壁纸窗口压回 DefView 之下。
let lastZOrderFixAt = 0;
function handleWallpaperPointerDown() {
    // 轻量节流：避免拖动/连点导致高频 SetWindowPos
    const now = Date.now();
    if (now - lastZOrderFixAt < 400) return;
    lastZOrderFixAt = now;

    invoke("fix_wallpaper_zorder");
}

// 防止并发读取同一文件的 Map
const inflight = new Map<string, Promise<string>>(); // path -> promise(dataURL)

let unlistenImage: UnlistenFn | null = null;
let unlistenStyle: UnlistenFn | null = null;
let unlistenTransition: UnlistenFn | null = null;

const imgStyle = computed(() => {
    const base: Record<string, string> = {};
    switch (mode.value) {
        case "fill":
            base.objectFit = "cover";
            base.objectPosition = "center";
            break;
        case "fit":
            base.objectFit = "contain";
            base.objectPosition = "center";
            break;
        case "stretch":
            base.objectFit = "fill";
            base.objectPosition = "center";
            break;
        case "center":
            base.objectFit = "none";
            base.objectPosition = "center";
            break;
        case "tile":
            break;
    }
    return base;
});

const baseTileStyle = computed(() => ({
    backgroundImage: baseSrc.value ? `url("${baseSrc.value}")` : "",
    backgroundRepeat: "repeat",
    backgroundSize: "auto",
}));

const topTileStyle = computed(() => ({
    backgroundImage: topSrc.value ? `url("${topSrc.value}")` : "",
    backgroundRepeat: "repeat",
    backgroundSize: "auto",
}));

const topClasses = computed(() => {
    if (!topSrc.value) return [];
    if (transition.value === "none") return [];
    return [transition.value, phase.value];
});

async function createObjectUrlFromFile(path: string): Promise<string> {
    try {
        // 规范化路径：移除 Windows 长路径前缀（\\?\）和前后空格
        // 这可以解决某些 Windows 路径格式导致的读取失败问题
        const normalizedPath = path.trimStart().replace(/^\\\\\?\\/, "").trim();

        if (!normalizedPath) {
            throw new Error("路径为空");
        }

        // 尝试读取文件
        // @tauri-apps/plugin-fs 的 readFile 返回 Uint8Array
        const uint8Array = await readFile(normalizedPath);

        if (uint8Array.length === 0) {
            throw new Error("文件数据为空");
        }

        const isValidImage = validateImageHeader(uint8Array);
        if (!isValidImage.valid) {
            throw new Error(`文件不是有效的图片格式: ${isValidImage.reason || "未知格式"}`);
        }

        const ext = (normalizedPath.split(".").pop() || "").toLowerCase();
        // 根据文件头确定 MIME 类型，而不是仅依赖扩展名
        let mime = isValidImage.mime || (
            ext === "png"
                ? "image/png"
                : ext === "webp"
                    ? "image/webp"
                    : ext === "gif"
                        ? "image/gif"
                        : "image/jpeg"
        );

        // 将 Uint8Array 转换为 base64 字符串
        // 使用分批处理避免大文件导致堆栈溢出
        const chunkSize = 8192; // 每次处理 8KB
        let binaryString = '';
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, Array.from(chunk));
        }

        // 创建 base64 data URL
        const base64 = btoa(binaryString);
        const dataUrl = `data:${mime};base64,${base64}`;

        // 验证 data URL 是否有效
        if (!dataUrl || !dataUrl.startsWith("data:")) {
            throw new Error("创建 base64 data URL 失败");
        }

        return dataUrl;
    } catch (e) {
        const errorMsg = String(e);
        // 提供更详细的错误信息
        if (errorMsg.includes("NotFound") || errorMsg.includes("ENOENT") || errorMsg.includes("ERR_FILE_NOT_FOUND")) {
            throw new Error(`文件不存在: ${path}`);
        } else if (errorMsg.includes("Permission") || errorMsg.includes("EACCES")) {
            throw new Error(`文件访问权限不足: ${path}`);
        } else if (errorMsg.includes("EISDIR")) {
            throw new Error(`路径是目录而非文件: ${path}`);
        } else {
            throw new Error(`readFile failed: ${errorMsg} (path=${path})`);
        }
    }
}

// 验证图片文件头，确保是有效的图片格式
function validateImageHeader(bytes: Uint8Array): { valid: boolean; mime?: string; reason?: string } {
    if (!bytes || bytes.length < 4) {
        return { valid: false, reason: "文件太小" };
    }

    // 检查常见图片格式的文件头（魔数）
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { valid: true, mime: "image/jpeg" };
    }
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { valid: true, mime: "image/png" };
    }
    // GIF: 47 49 46 38 (GIF8)
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { valid: true, mime: "image/gif" };
    }
    // WebP: 需要检查 RIFF 头和 WEBP 标识
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { valid: true, mime: "image/webp" };
    }
    // BMP: 42 4D
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { valid: true, mime: "image/bmp" };
    }

    // 如果无法识别，但文件不为空，可能是损坏的图片或未知格式
    return { valid: false, reason: "无法识别的图片格式" };
}

async function getOrCreateCachedUrl(path: string): Promise<string> {
    // 如果正在读取同一文件，等待现有请求完成
    const existing = inflight.get(path);
    if (existing) return await existing;

    // 创建新的读取请求
    const p = createObjectUrlFromFile(path).finally(() => {
        inflight.delete(path);
    });

    inflight.set(path, p);
    return await p;
}

function prefetchPath(path: string) {
    if (!path) return;
    if (inflight.has(path)) return;
    // 预取失败不影响主流程
    void getOrCreateCachedUrl(path).catch(() => { });
}

function commitTopToBase() {
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
    if (!topSrc.value) return;
    baseSrc.value = topSrc.value;
    topSrc.value = "";
    phase.value = "idle";
    currentPath.value = pendingPath.value || currentPath.value;
    pendingPath.value = "";
    busy.value = false;

    // 如果过渡期间收到了新的目标路径，当前过渡完成后再切换（只处理最后一次）
    if (queuedPath.value && queuedPath.value !== currentPath.value) {
        const next = queuedPath.value;
        queuedPath.value = "";
        // 过渡结束后马上要用 next，尽量提前预取（如果还没缓存）
        prefetchPath(next);
        // 异步触发，避免在 transitionend 栈内直接修改 DOM 引起重复事件
        setTimeout(() => {
            void setImagePath(next);
        }, 0);
    } else {
        queuedPath.value = "";
    }
}

async function setImagePath(path: string) {
    if (!path) return;
    lastRawPath.value = path;

    // 规范化路径（与 createObjectUrlFromFile 中的处理保持一致）
    const normalizedPath = path.trimStart().replace(/^\\\\\?\\/, "").trim();

    if (!normalizedPath) {
        lastError.value = "路径为空";
        return;
    }

    // 去重 1：如果当前 base 已经是这张图，忽略重复事件（无论是否正在过渡）
    // 解释：后端为"保证首帧显示"会短时间重复推送当前路径；如果在过渡中放行，会导致"旧图插队闪一下"。
    // 注意：使用规范化后的路径进行比较
    if (normalizedPath === currentPath.value && !!baseSrc.value) {
        return;
    }
    // 去重 2：如果正在过渡到同一路径，忽略重复事件，避免"反复重启动画"
    if (normalizedPath === pendingPath.value && phase.value !== "idle") {
        return;
    }

    // 关键：严格串行。只要当前有"读文件/准备动画/动画进行中"的工作，就先排队，避免并发交错导致闪烁。
    if (busy.value || phase.value !== "idle") {
        queuedPath.value = normalizedPath;
        // "下一张"就是 queuedPath：提前预取，减少真正切换时的读盘耗时
        prefetchPath(normalizedPath);
        return;
    }
    busy.value = true;
    try {
        // 获取 URL
        const url = await getOrCreateCachedUrl(normalizedPath);

        lastError.value = "";

        // 首次/无过渡：直接替换
        if (!baseSrc.value || transition.value === "none") {
            baseSrc.value = url;
            topSrc.value = "";
            phase.value = "idle";
            currentPath.value = normalizedPath;
            pendingPath.value = "";
            queuedPath.value = "";
            busy.value = false;
            return;
        }

        // 有过渡：top 覆盖 base，进入动画，结束后交换为 base
        topSrc.value = url;
        phase.value = "prep";
        pendingPath.value = normalizedPath;
        queuedPath.value = "";

        await nextTick();
        // 两次 RAF 保证浏览器把 prep 样式刷进渲染树，再进入 enter 才会触发 transition
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        phase.value = "enter";

        // 兜底：如果某些情况下 transitionend 没触发（例如被中断/浏览器优化），避免卡住
        if (transitionGuardTimer) {
            window.clearTimeout(transitionGuardTimer);
        }
        transitionGuardTimer = window.setTimeout(() => {
            if (phase.value === "enter") {
                commitTopToBase();
            }
        }, 1400);
    } catch (e) {
        lastError.value = String(e);
        busy.value = false;
        // 清理可能已经设置的状态
        topSrc.value = "";
        phase.value = "idle";
        pendingPath.value = "";
    }
}

function handleTopTransitionEnd(e: TransitionEvent) {
    // 只处理 top 层自己的 transition end
    if (e.target !== e.currentTarget) return;
    if (transition.value === "none") return;
    if (phase.value !== "enter") return;
    // 淡入淡出/滑动/缩放都以 opacity 结束为准，避免 transform 触发两次
    if (e.propertyName !== "opacity") return;
    commitTopToBase();
}

function handleImageError(type: "base" | "top") {
    // 图片加载错误处理
    if (type === "top") {
        // top 层图片加载失败，取消当前过渡并清理状态
        lastError.value = "top 层图片加载失败";
        if (transitionGuardTimer) {
            window.clearTimeout(transitionGuardTimer);
            transitionGuardTimer = null;
        }
        topSrc.value = "";
        phase.value = "idle";
        pendingPath.value = "";
        busy.value = false;
    } else {
        // base 层图片加载失败，记录错误（但保留 baseSrc 以显示占位）
        lastError.value = "base 层图片加载失败";
    }
}

onMounted(async () => {
    try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        windowLabel.value = getCurrentWebviewWindow().label;
    } catch (e) {
        lastError.value = `getCurrentWebviewWindow failed: ${String(e)}`;
    }

    unlistenImage = await listen<string>("wallpaper-update-image", (e) => {
        lastImageTs.value = new Date().toLocaleTimeString();
        setImagePath(e.payload);
    });
    unlistenStyle = await listen<string>("wallpaper-update-style", (e) => {
        lastStyleTs.value = new Date().toLocaleTimeString();
        const v = e.payload as Mode;
        mode.value = v;
    });
    unlistenTransition = await listen<string>("wallpaper-update-transition", (e) => {
        lastTransitionTs.value = new Date().toLocaleTimeString();
        const v = e.payload as Transition;
        transition.value = v;
    });

    // 壁纸窗口 ready 握手：让后端重新推送一次当前壁纸/样式/过渡，避免事件早到被丢
    try {
        readyInvoked.value = true;
        await invoke("wallpaper_window_ready");
    } catch (e) {
        lastError.value = `invoke wallpaper_window_ready failed: ${String(e)}`;
    }
});

onBeforeUnmount(() => {
    unlistenImage?.();
    unlistenStyle?.();
    unlistenTransition?.();
    unlistenImage = null;
    unlistenStyle = null;
    unlistenTransition = null;

    // 组件卸载：清空进行中的请求
    inflight.clear();
    queuedPath.value = "";
    busy.value = false;
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
});
</script>

<style scoped>
.wallpaper-root {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
}

.wallpaper-stage {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
}

.wallpaper-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: none;
}

.wallpaper-img.base {
    opacity: 1;
}

.wallpaper-img.top {
    opacity: 0;
    transform: none;
    transition: none;
    will-change: opacity, transform;
}

.wallpaper-tile {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background-color: transparent;
    pointer-events: none;
}

.wallpaper-tile.base {
    opacity: 1;
}

.wallpaper-tile.top {
    opacity: 0;
    transform: none;
    transition: none;
    will-change: opacity, transform;
}

/* transitions */
.top.fade.enter {
    opacity: 1;
    transition: opacity 800ms ease-in-out;
}

.top.slide.prep {
    opacity: 0;
    transform: translateX(32px);
}

.top.slide.enter {
    opacity: 1;
    transform: translateX(0);
    transition: opacity 800ms ease, transform 800ms ease;
}

.top.zoom.prep {
    opacity: 0;
    transform: scale(1.06);
}

.top.zoom.enter {
    opacity: 1;
    transform: scale(1);
    transition: opacity 900ms ease, transform 900ms ease;
}
</style>
