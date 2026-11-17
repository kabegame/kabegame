import type { WpeSceneSettings } from "@/utils/wpeSettings";

/** 壁纸样式：与壁纸目标配置里的 `style.window`（窗口模式）一致。 */
export type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
/** 壁纸切换过渡：与壁纸目标配置里的 `transition.window`（窗口模式）一致。 */
export type Transition = "none" | "fade" | "slide" | "zoom";

/** WPE 视频壁纸的作者默认播放属性（后端 `WpeVideoProps`）。 */
export interface WpeVideoProps {
  alignment: "cover" | "fill" | "stretch" | "center" | "free";
  /** −1…1：cover / fill 时沿溢出轴的位置（0 居中）。 */
  position: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
  flipH: boolean;
  background: [number, number, number] | null;
  rate: number | null;
  volume: number | null;
  color: {
    brightness: number;
    contrast: number;
    saturation: number;
    hue: number;
  } | null;
}

/**
 * 壁纸目标（后端 `WallpaperTarget`）：普通文件按扩展名 / 类型播图或播视频，目录型 WPE 视频播 `compatiblePath`；
 * WPE 网页（`x-wpe/web`）没有可播放媒体，web 层 iframe 直接加载 `webEntry`（预览与桌面同一份目标）；
 * WPE 场景（`x-wpe/scene`）由 scene 层的 `WpeSceneView` 按 `path` + `sceneAssets` 编译渲染，不能渲染时显示 `previewPath`。
 */
export interface WallpaperTarget {
  id: string;
  path: string;
  type?: string;
  compatiblePath?: string;
  wpeVideo?: WpeVideoProps | null;
  /** 网页壁纸的入口 `file://`（后端 `wallpaper::web_entry` 现算）；其它类型、Android 为空。 */
  webEntry?: string | null;
  /** 场景壁纸（`x-wpe/scene`）解析内置资源的 `<WPE 安装目录>/assets` 绝对路径，按顺序查找；其它类型、Android、没找到 WPE 安装目录为空。 */
  sceneAssets?: string[];
  /**
   * 场景壁纸退回用的预览图（行的缩略图，导入时就是作者的 `preview.*`）：不能渲染（含超时）时
   * 桌面（`Wallpaper` → `ImageContent` 的 wallpaper 形态）拿它当缩略层打底与退回画面。其它类型、缩略图为空时为空。
   */
  previewPath?: string | null;
}

/**
 * 一张 WPE 网页 / 场景壁纸的播放参数，由调用方算好下传：`ImageContent` 的 wallpaper 形态与 `WpeWallpaperContent` 都不读设置。
 * 图库预览与应用背景传这张壁纸的「预览设置」（`useWpePreviewPlayback`），桌面传全局「壁纸设置」。暂停与静音仍走
 * `ImageContent` 的 `videoPlaying` / `videoMuted`。
 */
export interface WallpaperPlayback {
  /** 0…1：网页壁纸经垫片乘到页面音量上，场景交给宿主 */
  volume: number;
  /** 场景后处理 / 反射 / 阴影 / 体积光，已按能否跟随 WPE 换算（`wpeSceneSettingsOf`） */
  sceneSettings: WpeSceneSettings;
  /**
   * 倍速（0.25…4，越界钳制；视频与场景共用，用户定）：视频只在 `ImageContent` 的 `variant="wallpaper"` 用（桌面，图库的视频倍速由预览
   * 弹窗自己设）；场景交给宿主（桌面是全局设置，预览是控制条的临时值）
   */
  playbackRate?: number;
  /** 场景的铺放（桌面传壁纸样式，含 tile）；不给时按 `ImageContent` 的 `fit` 换算 */
  style?: Mode;
}

/** `Wallpaper` 暴露给壁纸窗口调试面板的只读状态。 */
export interface WallpaperDebugState {
  mode: Mode;
  transition: Transition;
  phase: "idle" | "prep" | "enter";
  media: "image" | "video" | "web" | "scene";
  rawPath: string;
  currentPath: string;
  lastError: string;
  /** lastError 最近一次被赋值（含清空）的时刻，供窗口侧与自身错误按「后写者胜」合并显示。 */
  lastErrorAt: number;
  /** 当前场景壁纸退回预览图的原因（`WpeSceneView` 的 `fallback(reasons)`，`; ` 连接）；不是错误，渲染出来或非场景时为空。 */
  sceneFallback: string;
}
