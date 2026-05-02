import { listen, type UnlistenFn } from "@/api/rpc";
import { invoke } from "@/api/rpc";
import { fileToUrl, initHttpServerBaseUrl } from "@kabegame/core/httpServer";
import { IS_DEV } from "@kabegame/core/env";

type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
type Transition = "none" | "fade" | "slide" | "zoom";
type Phase = "idle" | "prep" | "enter";
type MediaType = "image" | "video";

// 状态管理
let baseSrc = "";
let topSrc = "";
let baseVideoSrc = "";
let topVideoSrc = "";
let phase: Phase = "idle";
let lastRawPath = "";
let currentPath = "";
let pendingPath = "";
let queuedPath = "";
let busy = false;
let mode: Mode = "fill";
let transition: Transition = "fade";
let currentMediaType: MediaType = "image";
/** 视频壁纸音量 0~1，与设置页、预览内逻辑一致 */
let wallpaperVolume = 1;
/** 视频播放速率 0.25～3 */
let wallpaperPlaybackRate = 1;

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

// 事件监听器（setting-change）
let unlistenSettingChange: UnlistenFn | null = null;

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

    // 应用 top 层类名和样式（图片/ tile）
    if (topImgEl || topTileEl) {
        const topClasses = getTopClasses();
        const el = topImgEl || topTileEl;
        if (el) {
            el.className = `wallpaper-${topImgEl ? "img" : "tile"} top ${topClasses.join(" ")}`.trim();
        }
    }
    // 视频 top 层使用同一套过渡类名
    if (topVideoEl && topVideoSrc) {
        const topClasses = transition === "none" ? [] : [transition, phase];
        topVideoEl.className = `wallpaper-img top ${topClasses.join(" ")}`.trim();
    }
}

/** 安全清除 img 元素的 src：使用 removeAttribute 避免触发 error 事件 */
function clearImgSrc(el: HTMLImageElement | null) {
    if (!el) return;
    el.removeAttribute("src");
}

function commitTopToBase() {
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
    // 视频 top → base：交换 base/top 元素引用，避免重新加载视频导致闪烁
    if (topVideoSrc) {
        baseVideoSrc = topVideoSrc;
        topVideoSrc = "";
        phase = "idle";
        currentPath = pendingPath || currentPath;
        pendingPath = "";
        busy = false;
        // top 已在播放新内容，直接提升为 base；旧 base 降为 top 待复用
        if (topVideoEl) topVideoEl.className = "wallpaper-img base";
        if (baseVideoEl) baseVideoEl.className = "wallpaper-img top";
        [baseVideoEl, topVideoEl] = [topVideoEl, baseVideoEl];
        resetVideoElement(topVideoEl);
        updateModeDisplay();
        applyStyles();
        if (queuedPath && queuedPath !== currentPath) {
            const next = queuedPath;
            queuedPath = "";
            prefetchPath(next);
            setTimeout(() => void setImagePath(next), 0);
        } else {
            queuedPath = "";
        }
        updateDebugPanel();
        return;
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
            clearImgSrc(topImgEl);
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
        if (currentMediaType === "video") return;
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
            clearImgSrc(topImgEl);
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

/** 播放成功后取消静音并应用当前音量设置 */
function unmuteVideo(el: HTMLVideoElement | null) {
    if (!el) return;
    const v = Math.min(1, Math.max(0, Number.isFinite(wallpaperVolume) ? wallpaperVolume : 1));
    el.volume = v;
    el.muted = v === 0;
}

/** 将当前 wallpaperVolume 应用到所有视频元素 */
function applyWallpaperVolume() {
    const v = Math.min(1, Math.max(0, Number.isFinite(wallpaperVolume) ? wallpaperVolume : 1));
    if (baseVideoEl) {
        baseVideoEl.volume = v;
        baseVideoEl.muted = v === 0;
    }
    if (topVideoEl) {
        topVideoEl.volume = v;
        topVideoEl.muted = v === 0;
    }
}

/** 当前生效的播放速率（0.25～3） */
function getPlaybackRateMagnitude(): number {
    return Math.min(3, Math.max(0.25, Number.isFinite(wallpaperPlaybackRate) ? wallpaperPlaybackRate : 1));
}

/** 将 loop 与 playbackRate 应用到单个视频元素 */
function applyVideoLoopToElement(el: HTMLVideoElement | null) {
    if (!el) return;
    el.setAttribute("loop", "");
    el.playbackRate = getPlaybackRateMagnitude();
}

/** 将 loop 与 playbackRate 应用到所有视频元素 */
function applyVideoLoopMode() {
    applyVideoLoopToElement(baseVideoEl);
    applyVideoLoopToElement(topVideoEl);
}

/** 将当前播放速率应用到所有视频元素 */
function applyWallpaperPlaybackRate() {
    const rate = getPlaybackRateMagnitude();
    for (const el of [baseVideoEl, topVideoEl]) {
        if (!el?.src) continue;
        el.playbackRate = rate;
    }
}

async function playVideo(el: HTMLVideoElement | null, src: string) {
    if (!el) return;
    if (el.src !== src) {
        el.src = src;
    }
    applyVideoLoopToElement(el);
    try {
        await el.play();
        unmuteVideo(el);
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
            currentMediaType = "video";
            clearImgSrc(topImgEl);
            if (topImgEl) topImgEl.style.opacity = "0";
            clearImgSrc(baseImgEl);
            if (topTileEl) {
                topTileEl.style.backgroundImage = "";
                topTileEl.style.opacity = "0";
            }
            if (baseTileEl) baseTileEl.style.backgroundImage = "";

            // 无过渡或首帧：直接设 base
            if (transition === "none" || !baseVideoSrc) {
                baseVideoSrc = videoUrl;
                topVideoSrc = "";
                phase = "idle";
                currentPath = normalizedPath;
                pendingPath = "";
                queuedPath = "";
                resetVideoElement(topVideoEl);
                await playVideo(baseVideoEl, videoUrl);
                updateModeDisplay();
                applyStyles();
                busy = false;
                updateDebugPanel();
                return;
            }

            // 有过渡：新视频进 top 层，与图片同一套 prep → enter
            topVideoSrc = videoUrl;
            phase = "prep";
            pendingPath = normalizedPath;
            queuedPath = "";
            resetVideoElement(topVideoEl);
            if (topVideoEl) {
                topVideoEl.src = videoUrl;
                topVideoEl.style.opacity = "0";
                applyVideoLoopToElement(topVideoEl);
            }
            updateModeDisplay();
            applyStyles();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            if (topVideoEl) topVideoEl.style.opacity = "";
            phase = "enter";
            applyStyles();
            if (topVideoEl) void topVideoEl.play().then(() => unmuteVideo(topVideoEl)).catch(() => {});
            if (transitionGuardTimer) window.clearTimeout(transitionGuardTimer);
            transitionGuardTimer = window.setTimeout(() => {
                if (phase === "enter" && topVideoSrc) commitTopToBase();
            }, 1400);
            busy = false;
            updateDebugPanel();
            return;
        }

        const url = await getImageUrl(normalizedPath);

        lastError = "";
        currentMediaType = "image";
        baseVideoSrc = "";
        topVideoSrc = "";
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
                    clearImgSrc(topImgEl);
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
        
        // 清除内联 opacity，让 CSS 类控制过渡动画
        // 内联 style.opacity 优先级高于类选择器，若不清除会阻止 .top.fade.enter { opacity:1 } 生效
        if (mode !== "tile") {
            if (topImgEl) topImgEl.style.opacity = "";
        } else {
            if (topTileEl) topTileEl.style.opacity = "";
        }

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
            clearImgSrc(topImgEl);
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
    // 空 src / 无 src 属性不视为加载错误，仅当有实际 src 加载失败时才触发错误处理
    if (baseImgEl) {
        baseImgEl.addEventListener("error", () => {
            if (!baseImgEl?.getAttribute("src")) return;
            handleImageError("base");
        });
    }
    if (topImgEl) {
        topImgEl.addEventListener("transitionend", handleTopTransitionEnd);
        topImgEl.addEventListener("error", () => {
            if (!topImgEl?.getAttribute("src")) return;
            handleImageError("top");
        });
    }
    // 视频元素：两个元素绑定相同的 transitionend 和角色感知的 error handler，
    // 以支持 commitTopToBase 中 base/top 引用交换后仍能正确工作
    const handleVideoError = (e: Event) => {
        const el = e.currentTarget as HTMLVideoElement;
        if (el === topVideoEl) {
            lastError = "top 层视频加载失败";
            if (transitionGuardTimer) {
                window.clearTimeout(transitionGuardTimer);
                transitionGuardTimer = null;
            }
            topVideoSrc = "";
            phase = "idle";
            pendingPath = "";
            busy = false;
            resetVideoElement(topVideoEl);
            updateModeDisplay();
        } else {
            lastError = "base 层视频加载失败";
        }
        updateDebugPanel();
    };
    if (baseVideoEl) {
        baseVideoEl.addEventListener("transitionend", handleTopTransitionEnd);
        baseVideoEl.addEventListener("error", handleVideoError);
    }
    if (topVideoEl) {
        topVideoEl.addEventListener("transitionend", handleTopTransitionEnd);
        topVideoEl.addEventListener("error", handleVideoError);
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
        if (topVideoEl) topVideoEl.style.display = topVideoSrc ? "block" : "none";
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

function applyStyleFromMode() {
    if (currentMediaType === "video") {
        applyStyles();
        updateDebugPanel();
        return;
    }
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

    // 监听 setting-change 事件（payload 为 { key: value } 形式的变更对象）
    unlistenSettingChange = await listen<Record<string, unknown>>("setting-change", async (event) => {
        const raw = event.payload;
        const changes =
            raw && typeof raw === "object" && "changes" in raw && typeof (raw as { changes?: unknown }).changes === "object"
                ? ((raw as { changes: Record<string, unknown> }).changes as Record<string, unknown>)
                : (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
        if ("wallpaperStyle" in changes && typeof changes.wallpaperStyle === "string") {
            lastStyleTs = new Date().toLocaleTimeString();
            mode = changes.wallpaperStyle as Mode;
            updateModeDisplay();
            applyStyleFromMode();
        }
        if ("wallpaperRotationTransition" in changes && typeof changes.wallpaperRotationTransition === "string") {
            lastTransitionTs = new Date().toLocaleTimeString();
            transition = changes.wallpaperRotationTransition as Transition;
            applyStyles();
            updateDebugPanel();
        }
        if ("currentWallpaperImageId" in changes) {
            lastImageTs = new Date().toLocaleTimeString();
            try {
                const path = await invoke<unknown>("get_current_wallpaper_path");
                if (path && typeof path === "string") {
                    setImagePath(path);
                }
            } catch {
                // 忽略，可能是无壁纸
            }
        }
        if ("wallpaperVolume" in changes && typeof changes.wallpaperVolume === "number") {
            const v = changes.wallpaperVolume;
            wallpaperVolume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
            applyWallpaperVolume();
        }
        if ("wallpaperVideoPlaybackRate" in changes && typeof changes.wallpaperVideoPlaybackRate === "number") {
            wallpaperPlaybackRate = Math.min(3, Math.max(0.25, changes.wallpaperVideoPlaybackRate));
            applyWallpaperPlaybackRate();
        }
    });

    // 初始化时从 settings 拉取当前状态
    try {
        const [styleRes, transitionRes, volumeRes, playbackRateRes, pathRes] = await Promise.all([
            invoke<string>("get_wallpaper_rotation_style"),
            invoke<string>("get_wallpaper_rotation_transition"),
            invoke<number>("get_wallpaper_volume"),
            invoke<number>("get_wallpaper_video_playback_rate"),
            invoke<string | null>("get_current_wallpaper_path"),
        ]);
        if (styleRes && typeof styleRes === "string") {
            mode = styleRes as Mode;
        }
        if (transitionRes && typeof transitionRes === "string") {
            transition = transitionRes as Transition;
        }
        if (typeof volumeRes === "number" && Number.isFinite(volumeRes)) {
            wallpaperVolume = Math.min(1, Math.max(0, volumeRes));
        }
        if (typeof playbackRateRes === "number" && Number.isFinite(playbackRateRes)) {
            wallpaperPlaybackRate = Math.min(3, Math.max(0.25, playbackRateRes));
        }
        updateModeDisplay();
        applyStyles();
        applyWallpaperVolume();
        applyVideoLoopMode();
        if (pathRes && typeof pathRes === "string") {
            setImagePath(pathRes);
        }
    } catch (e) {
        lastError = `init settings fetch failed: ${String(e)}`;
    }

    // 壁纸窗口 ready 握手（初始加载完成后通知后端，用于 remount/show）
    try {
        readyInvoked = true;
        await invoke("wallpaper_window_ready");
    } catch (e) {
        lastError = `invoke wallpaper_window_ready failed: ${String(e)}`;
    }

    updateDebugPanel();
}

function cleanup() {
    unlistenSettingChange?.();
    unlistenSettingChange = null;

    inflight.clear();
    queuedPath = "";
    busy = false;
    if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
    }
    baseVideoSrc = "";
    topVideoSrc = "";
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
