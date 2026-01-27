import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@kabegame/core/fs/readFile";
import { IS_DEV } from "@kabegame/core/env";

type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
type Transition = "none" | "fade" | "slide" | "zoom";
type Phase = "idle" | "prep" | "enter";

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
let baseTileEl: HTMLElement | null = null;
let topTileEl: HTMLElement | null = null;
let debugPanelEl: HTMLElement | null = null;

// 事件监听器
let unlistenImage: UnlistenFn | null = null;
let unlistenStyle: UnlistenFn | null = null;
let unlistenTransition: UnlistenFn | null = null;

// 防止并发读取同一文件的 Map
const inflight = new Map<string, Promise<string>>(); // path -> promise(dataURL)

// Z-order 修复节流
let lastZOrderFixAt = 0;
function handleWallpaperPointerDown() {
    const now = Date.now();
    if (now - lastZOrderFixAt < 400) return;
    lastZOrderFixAt = now;
    invoke("fix_wallpaper_zorder");
}

// 验证图片文件头
function validateImageHeader(bytes: Uint8Array): { valid: boolean; mime?: string; reason?: string } {
    if (!bytes || bytes.length < 4) {
        return { valid: false, reason: "文件太小" };
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { valid: true, mime: "image/jpeg" };
    }
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { valid: true, mime: "image/png" };
    }
    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { valid: true, mime: "image/gif" };
    }
    // WebP: RIFF...WEBP
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { valid: true, mime: "image/webp" };
    }
    // BMP: 42 4D
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { valid: true, mime: "image/bmp" };
    }

    return { valid: false, reason: "无法识别的图片格式" };
}

async function createObjectUrlFromFile(path: string): Promise<string> {
    try {
        const normalizedPath = path.trimStart().replace(/^\\\\\?\\/, "").trim();

        if (!normalizedPath) {
            throw new Error("路径为空");
        }

        const uint8Array = await readFile(normalizedPath);

        if (uint8Array.length === 0) {
            throw new Error("文件数据为空");
        }

        const isValidImage = validateImageHeader(uint8Array);
        if (!isValidImage.valid) {
            throw new Error(`文件不是有效的图片格式: ${isValidImage.reason || "未知格式"}`);
        }

        const ext = (normalizedPath.split(".").pop() || "").toLowerCase();
        let mime = isValidImage.mime || (
            ext === "png"
                ? "image/png"
                : ext === "webp"
                    ? "image/webp"
                    : ext === "gif"
                        ? "image/gif"
                        : "image/jpeg"
        );

        const chunkSize = 8192;
        let binaryString = '';
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, Array.from(chunk));
        }

        const base64 = btoa(binaryString);
        const dataUrl = `data:${mime};base64,${base64}`;

        if (!dataUrl || !dataUrl.startsWith("data:")) {
            throw new Error("创建 base64 data URL 失败");
        }

        return dataUrl;
    } catch (e) {
        const errorMsg = String(e);
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

async function getOrCreateCachedUrl(path: string): Promise<string> {
    const existing = inflight.get(path);
    if (existing) return await existing;

    const p = createObjectUrlFromFile(path).finally(() => {
        inflight.delete(path);
    });

    inflight.set(path, p);
    return await p;
}

function prefetchPath(path: string) {
    if (!path) return;
    if (inflight.has(path)) return;
    void getOrCreateCachedUrl(path).catch(() => { });
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
    if (normalizedPath === currentPath && !!baseSrc) {
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
        const url = await getOrCreateCachedUrl(normalizedPath);

        lastError = "";

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
    // 根据模式显示/隐藏对应的元素
    if (mode !== "tile") {
        // 图片模式：显示图片，隐藏 tile
        if (baseImgEl) baseImgEl.style.display = "block";
        if (topImgEl) topImgEl.style.display = "block";
        if (baseTileEl) baseTileEl.style.display = "none";
        if (topTileEl) topTileEl.style.display = "none";
    } else {
        // Tile 模式：显示 tile，隐藏图片
        if (baseImgEl) baseImgEl.style.display = "none";
        if (topImgEl) topImgEl.style.display = "none";
        if (baseTileEl) baseTileEl.style.display = "block";
        if (topTileEl) topTileEl.style.display = "block";
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
}

// 启动应用
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

// 清理
window.addEventListener("beforeunload", cleanup);
