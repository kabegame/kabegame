import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { fileToUrl, initHttpServerBaseUrl } from "@kabegame/core/httpServer";
import { IS_DEV } from "@kabegame/core/env";

type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
type Transition = "none" | "fade" | "slide" | "zoom";
type Phase = "idle" | "prep" | "enter";
type MediaType = "image" | "video";

// 状态管理
let baseSrc = "";
let topSrc = "";
let phase: Phase = "idle";
let lastRawPath = "";
let currentPath = "";
let pendingPath = "";
let queuedPath = "";
let busy = false;
let mode: Mode = "fill";
let transition: Transition = "fade";
let currentMediaType: MediaType = "image";

// 调试状态
let windowLabel = "";
let readyInvoked = false;
let lastImageTs = "";
let lastStyleTs = "";
let lastTransitionTs = "";
let lastError = "";
let transitionGuardTimer: number | null = null;

// DOM 元素引用
let rootEl: HTMLElement | null = null;
let baseImgEl: HTMLImageElement | null = null;
let topImgEl: HTMLImageElement | null = null;
let baseVideoEl: HTMLVideoElement | null = null;
let topVideoEl: HTMLVideoElement | null = null;
let baseTileEl: HTMLElement | null = null;
let topTileEl: HTMLElement | null = null;
let debugPanelEl: HTMLElement | null = null;

// 事件监听器
let unlistenImage: UnlistenFn | null = null;
let unlistenStyle: UnlistenFn | null = null;
let unlistenTransition: UnlistenFn | null = null;

// 防止并发请求同一路径的 Map（仅用于 prefetch 去重）
const inflight = new Set<string>();

// Z-order 修复节流
let lastZOrderFixAt = 0;
function handleWallpaperPointerDown() {
    const now = Date.now();
    if (now - lastZOrderFixAt < 400) return;
    lastZOrderFixAt = now;
    invoke("fix_wallpaper_zorder");
}

function getPathExt(path: string): string {
    return (path.split(".").pop() || "").toLowerCase();
}

function isVideoPath(path: string): boolean {
    const ext = getPathExt(path);
    return ext === "mp4" || ext === "mov";
}

async function getVideoUrl(path: string): Promise<string> {
    await initHttpServerBaseUrl();
    const url = fileToUrl(path);
    if (!url) {
        throw new Error(`无法获取视频 URL: ${path}`);
    }
    return url;
}

/** 通过项目 HTTP 文件服务获取图片 URL（壁纸仅桌面端，无 Android） */
async function getImageUrl(path: string): Promise<string> {
    await initHttpServerBaseUrl();
    const url = fileToUrl(path);
    if (!url) {
        throw new Error(`无法获取图片 URL: ${path}`);
    }
    return url;
}

function prefetchPath(path: string) {
    if (!path) return;
    if (isVideoPath(path)) return;
    if (inflight.has(path)) return;
    inflight.add(path);
    void getImageUrl(path).finally(() => inflight.delete(path)).catch(() => {});
}

function getImgStyle(): Record<string, string> {
    const base: Record<string, string> = {};
    switch (mode) {
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
}

function getBaseTileStyle(): Record<string, string> {
    return {
        backgroundImage: baseSrc ? `url("${baseSrc}")` : "",
        backgroundRepeat: "repeat",
        backgroundSize: "auto",
    };
}

function getTopTileStyle(): Record<string, string> {
    return {
        backgroundImage: topSrc ? `url("${topSrc}")` : "",
        backgroundRepeat: "repeat",
        backgroundSize: "auto",
    };
}

function getTopClasses(): string[] {
    if (!topSrc) return [];
    if (transition === "none") return [];
    return [transition, phase];
}

function applyStyles() {
    const imgStyle = getImgStyle();
    
    // 应用图片样式
    if (baseImgEl) {
        Object.assign(baseImgEl.style, {
            objectFit: imgStyle.objectFit || "",
            objectPosition: imgStyle.objectPosition || "",
        });
    }
    if (topImgEl) {
        Object.assign(topImgEl.style, {
            objectFit: imgStyle.objectFit || "",
            objectPosition: imgStyle.objectPosition || "",
        });
    }
    if (baseVideoEl) {
        Object.assign(baseVideoEl.style, {
            objectFit: imgStyle.objectFit || "cover",
            objectPosition: imgStyle.objectPosition || "center",
        });
    }
    if (topVideoEl) {
        Object.assign(topVideoEl.style, {
            objectFit: imgStyle.objectFit || "cover",
            objectPosition: imgStyle.objectPosition || "center",
        });
    }

    // 应用 tile 样式
    if (baseTileEl) {
        const baseTileStyle = getBaseTileStyle();
        Object.assign(baseTileEl.style, baseTileStyle);
    }
    if (topTileEl) {
        const topTileStyle = getTopTileStyle();
        Object.assign(topTileEl.style, topTileStyle);
    }

    // 应用 top 层类名和样式
    if (topImgEl || topTileEl) {
        const topClasses = getTopClasses();
        const el = topImgEl || topTileEl;
        if (el) {
            el.className = `wallpaper-${topImgEl ? "img" : "tile"} top ${topClasses.join(" ")}`.trim();
        }
    }
}

function commitTopToBase() {
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
    if (!topSrc) return;
    baseSrc = topSrc;
    topSrc = "";
    phase = "idle";
    currentPath = pendingPath || currentPath;
    pendingPath = "";
    busy = false;

    // 更新 DOM
    if (mode !== "tile") {
        if (baseImgEl) baseImgEl.src = baseSrc;
        if (topImgEl) {
            topImgEl.src = "";
            topImgEl.style.opacity = "0";
        }
    } else {
        if (baseTileEl) {
            const baseTileStyle = getBaseTileStyle();
            Object.assign(baseTileEl.style, baseTileStyle);
        }
        if (topTileEl) {
            topTileEl.style.backgroundImage = "";
            topTileEl.style.opacity = "0";
        }
    }
    applyStyles();

    // 处理队列
    if (queuedPath && queuedPath !== currentPath) {
        const next = queuedPath;
        queuedPath = "";
        prefetchPath(next);
        setTimeout(() => {
            void setImagePath(next);
        }, 0);
    } else {
        queuedPath = "";
    }
}

function handleTopTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget) return;
    if (transition === "none") return;
    if (phase !== "enter") return;
    if (e.propertyName !== "opacity") return;
    commitTopToBase();
}

function handleImageError(type: "base" | "top") {
    if (type === "top") {
        lastError = "top 层图片加载失败";
        if (transitionGuardTimer) {
            window.clearTimeout(transitionGuardTimer);
            transitionGuardTimer = null;
        }
        topSrc = "";
        phase = "idle";
        pendingPath = "";
        busy = false;
        if (topImgEl) {
            topImgEl.src = "";
            topImgEl.style.opacity = "0";
        }
        if (topTileEl) {
            topTileEl.style.backgroundImage = "";
            topTileEl.style.opacity = "0";
        }
    } else {
        lastError = "base 层图片加载失败";
    }
    updateDebugPanel();
}

function resetVideoElement(el: HTMLVideoElement | null) {
    if (!el) return;
    try {
        el.pause();
        el.removeAttribute("src");
        el.load();
    } catch {
        // ignore
    }
}

async function playVideo(el: HTMLVideoElement | null, src: string) {
    if (!el) return;
    if (el.src !== src) {
        el.src = src;
    }
    try {
        await el.play();
    } catch {
        // 自动播放被阻止时保持静默，后续事件会重试
    }
}

async function setImagePath(path: string) {
    if (!path) return;
    lastRawPath = path;

    const normalizedPath = path.trimStart().replace(/^\\\\\?\\/, "").trim();

    if (!normalizedPath) {
        lastError = "路径为空";
        updateDebugPanel();
        return;
    }

    // 去重 1
    if (
        normalizedPath === currentPath &&
        (
            (currentMediaType === "image" && !!baseSrc) ||
            (currentMediaType === "video" && !!baseVideoEl?.src)
        )
    ) {
        return;
    }
    // 去重 2
    if (normalizedPath === pendingPath && phase !== "idle") {
        return;
    }

    // 严格串行
    if (busy || phase !== "idle") {
        queuedPath = normalizedPath;
        prefetchPath(normalizedPath);
        return;
    }
    busy = true;
    try {
        const isVideoMedia = isVideoPath(normalizedPath);
        if (isVideoMedia) {
            const videoUrl = await getVideoUrl(normalizedPath);
            lastError = "";
            phase = "idle";
            pendingPath = "";
            queuedPath = "";
            currentPath = normalizedPath;
            currentMediaType = "video";
            topSrc = "";
            baseSrc = "";
            if (topImgEl) {
                topImgEl.src = "";
                topImgEl.style.opacity = "0";
            }
            if (baseImgEl) {
                baseImgEl.src = "";
            }
            if (topTileEl) {
                topTileEl.style.backgroundImage = "";
                topTileEl.style.opacity = "0";
            }
            if (baseTileEl) {
                baseTileEl.style.backgroundImage = "";
            }
            resetVideoElement(topVideoEl);
            await playVideo(baseVideoEl, videoUrl);
            updateModeDisplay();
            applyStyles();
            busy = false;
            updateDebugPanel();
            return;
        }

        const url = await getImageUrl(normalizedPath);

        lastError = "";
        currentMediaType = "image";
        resetVideoElement(baseVideoEl);
        resetVideoElement(topVideoEl);
        updateModeDisplay();

        // 首次/无过渡：直接替换
        if (!baseSrc || transition === "none") {
            baseSrc = url;
            topSrc = "";
            phase = "idle";
            currentPath = normalizedPath;
            pendingPath = "";
            queuedPath = "";
            busy = false;

            // 更新 DOM
            if (mode !== "tile") {
                if (baseImgEl) baseImgEl.src = baseSrc;
                if (topImgEl) {
                    topImgEl.src = "";
                    topImgEl.style.opacity = "0";
                }
            } else {
                if (baseTileEl) {
                    const baseTileStyle = getBaseTileStyle();
                    Object.assign(baseTileEl.style, baseTileStyle);
                }
                if (topTileEl) {
                    topTileEl.style.backgroundImage = "";
                    topTileEl.style.opacity = "0";
                }
            }
            applyStyles();
            updateDebugPanel();
            return;
        }

        // 有过渡：top 覆盖 base，进入动画
        topSrc = url;
        phase = "prep";
        pendingPath = normalizedPath;
        queuedPath = "";

        // 更新 DOM
        if (mode !== "tile") {
            if (topImgEl) {
                topImgEl.src = topSrc;
                topImgEl.style.opacity = "0";
            }
        } else {
            if (topTileEl) {
                const topTileStyle = getTopTileStyle();
                Object.assign(topTileEl.style, topTileStyle);
                topTileEl.style.opacity = "0";
            }
        }
        applyStyles();

        // 等待浏览器渲染 prep 状态
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        
        phase = "enter";
        applyStyles();

        // 兜底定时器
        if (transitionGuardTimer) {
            window.clearTimeout(transitionGuardTimer);
        }
        transitionGuardTimer = window.setTimeout(() => {
            if (phase === "enter") {
                commitTopToBase();
            }
        }, 1400);
        updateDebugPanel();
    } catch (e) {
        lastError = String(e);
        busy = false;
        topSrc = "";
        phase = "idle";
        pendingPath = "";
        if (topImgEl) {
            topImgEl.src = "";
            topImgEl.style.opacity = "0";
        }
        if (topTileEl) {
            topTileEl.style.backgroundImage = "";
            topTileEl.style.opacity = "0";
        }
        updateDebugPanel();
    }
}

function updateDebugPanel() {
    if (!IS_DEV || !debugPanelEl) return;
    
    debugPanelEl.innerHTML = `
        <div class="debug-title">Wallpaper Debug</div>
        <div>label: ${windowLabel || "unknown"}</div>
        <div>ready invoked: ${readyInvoked ? "yes" : "no"}</div>
        <div>last image ts: ${lastImageTs || "-"}</div>
        <div>last style ts: ${lastStyleTs || "-"}</div>
        <div>last transition ts: ${lastTransitionTs || "-"}</div>
        <div>mode: ${mode}</div>
        <div>media: ${currentMediaType}</div>
        <div>transition: ${transition}</div>
        <div class="debug-path">rawPath: ${lastRawPath || "-"}</div>
        ${lastError ? `<div class="debug-error">error: ${lastError}</div>` : ""}
    `;
}

function initDOM() {
    // 获取根容器
    const root = document.querySelector(".wallpaper-root") as HTMLElement;
    if (!root) {
        throw new Error("找不到 .wallpaper-root 元素");
    }
    rootEl = root;
    
    // 绑定点击事件
    root.addEventListener("pointerdown", handleWallpaperPointerDown);

    // 获取图片元素
    baseImgEl = document.getElementById("base-img") as HTMLImageElement;
    topImgEl = document.getElementById("top-img") as HTMLImageElement;
    baseVideoEl = document.getElementById("base-video") as HTMLVideoElement;
    topVideoEl = document.getElementById("top-video") as HTMLVideoElement;
    
    // 获取 tile 元素
    baseTileEl = document.getElementById("base-tile") as HTMLElement;
    topTileEl = document.getElementById("top-tile") as HTMLElement;

    // 绑定事件监听器
    if (baseImgEl) {
        baseImgEl.addEventListener("error", () => handleImageError("base"));
    }
    if (topImgEl) {
        topImgEl.addEventListener("transitionend", handleTopTransitionEnd);
        topImgEl.addEventListener("error", () => handleImageError("top"));
    }
    if (baseVideoEl) {
        baseVideoEl.addEventListener("error", () => {
            lastError = "base 层视频加载失败";
            updateDebugPanel();
        });
    }
    if (topVideoEl) {
        topVideoEl.addEventListener("error", () => {
            lastError = "top 层视频加载失败";
            updateDebugPanel();
        });
    }
    if (topTileEl) {
        topTileEl.addEventListener("transitionend", handleTopTransitionEnd);
    }

    // 获取调试面板
    debugPanelEl = document.getElementById("debug-panel") as HTMLElement;
    if (debugPanelEl && IS_DEV) {
        debugPanelEl.style.display = "block";
    }
}

function updateModeDisplay() {
    if (currentMediaType === "video") {
        if (baseImgEl) baseImgEl.style.display = "none";
        if (topImgEl) topImgEl.style.display = "none";
        if (baseTileEl) baseTileEl.style.display = "none";
        if (topTileEl) topTileEl.style.display = "none";
        if (baseVideoEl) baseVideoEl.style.display = "block";
        if (topVideoEl) topVideoEl.style.display = "none";
        return;
    }

    // 根据模式显示/隐藏对应的元素
    if (mode !== "tile") {
        // 图片模式：显示图片，隐藏 tile
        if (baseImgEl) baseImgEl.style.display = "block";
        if (topImgEl) topImgEl.style.display = "block";
        if (baseTileEl) baseTileEl.style.display = "none";
        if (topTileEl) topTileEl.style.display = "none";
        if (baseVideoEl) baseVideoEl.style.display = "none";
        if (topVideoEl) topVideoEl.style.display = "none";
    } else {
        // Tile 模式：显示 tile，隐藏图片
        if (baseImgEl) baseImgEl.style.display = "none";
        if (topImgEl) topImgEl.style.display = "none";
        if (baseTileEl) baseTileEl.style.display = "block";
        if (topTileEl) topTileEl.style.display = "block";
        if (baseVideoEl) baseVideoEl.style.display = "none";
        if (topVideoEl) topVideoEl.style.display = "none";
    }
}

async function init() {
    initDOM();
    updateModeDisplay();

    try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        windowLabel = getCurrentWebviewWindow().label;
    } catch (e) {
        lastError = `getCurrentWebviewWindow failed: ${String(e)}`;
    }

    unlistenImage = await listen<string>("wallpaper-update-image", (e) => {
        lastImageTs = new Date().toLocaleTimeString();
        setImagePath(e.payload);
    });
    unlistenStyle = await listen<string>("wallpaper-update-style", (e) => {
        lastStyleTs = new Date().toLocaleTimeString();
        const v = e.payload as Mode;
        mode = v;
        updateModeDisplay();
        if (currentMediaType === "video") {
            applyStyles();
            updateDebugPanel();
            return;
        }
        // 恢复当前图片状态
        if (baseSrc) {
            if (mode !== "tile") {
                if (baseImgEl) baseImgEl.src = baseSrc;
            } else {
                if (baseTileEl) {
                    const baseTileStyle = getBaseTileStyle();
                    Object.assign(baseTileEl.style, baseTileStyle);
                }
            }
        }
        if (topSrc) {
            if (mode !== "tile") {
                if (topImgEl) topImgEl.src = topSrc;
            } else {
                if (topTileEl) {
                    const topTileStyle = getTopTileStyle();
                    Object.assign(topTileEl.style, topTileStyle);
                }
            }
        }
        applyStyles();
        updateDebugPanel();
    });
    unlistenTransition = await listen<string>("wallpaper-update-transition", (e) => {
        lastTransitionTs = new Date().toLocaleTimeString();
        const v = e.payload as Transition;
        transition = v;
        applyStyles();
        updateDebugPanel();
    });

    // 壁纸窗口 ready 握手
    try {
        readyInvoked = true;
        await invoke("wallpaper_window_ready");
    } catch (e) {
        lastError = `invoke wallpaper_window_ready failed: ${String(e)}`;
    }

    updateDebugPanel();
}

function cleanup() {
    unlistenImage?.();
    unlistenStyle?.();
    unlistenTransition?.();
    unlistenImage = null;
    unlistenStyle = null;
    unlistenTransition = null;

    inflight.clear();
    queuedPath = "";
    busy = false;
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
    resetVideoElement(baseVideoEl);
    resetVideoElement(topVideoEl);
}

// 启动应用
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

// 清理
window.addEventListener("beforeunload", cleanup);
