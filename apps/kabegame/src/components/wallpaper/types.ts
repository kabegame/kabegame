/** 壁纸样式：与设置 `wallpaperStyle`（窗口模式）一致。 */
export type Mode = "fill" | "fit" | "stretch" | "center" | "tile";
/** 壁纸切换过渡：与设置 `wallpaperRotationTransition`（窗口模式）一致。 */
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

/** 壁纸目标（后端 `WallpaperTarget`）：普通文件按扩展名 / 类型播图或播视频，目录型 WPE 壁纸播 `compatiblePath`。 */
export interface WallpaperTarget {
  id: string;
  path: string;
  type?: string;
  compatiblePath?: string;
  wpeVideo?: WpeVideoProps | null;
}

/** `WallpaperStage` 暴露给调试面板的只读状态。 */
export interface WallpaperStageDebugState {
  mode: Mode;
  transition: Transition;
  phase: "idle" | "prep" | "enter";
  media: "image" | "video" | "web";
  rawPath: string;
  currentPath: string;
  lastError: string;
  /** lastError 最近一次被赋值（含清空）的时刻，供窗口侧与自身错误按「后写者胜」合并显示。 */
  lastErrorAt: number;
}
