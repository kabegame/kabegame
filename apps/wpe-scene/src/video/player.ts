/**
 * 场景视频的公共定义（P9a 步骤 1 起，P9d 步骤 2b 后只剩这些）：视频在磁盘上的位置、日志出口、空闲 / 跳转 / 卡住的常量与复用键。
 * 播放器本身在 `codecPlayer.ts`（WebCodecs，`CodecVideoPlayer`）：WPE 语义（rea-p9-video 第 3、4、6、7 节、p9-REPORT「结论」）都写在那边的
 * 文件头；场景级的复用、帧号与宿主暂停在 `sceneVideos.ts`。`compile/bundle.ts`、`compile/tex.ts` 从这里取 `SceneVideoSource`。
 */

/** 视频在磁盘上的位置：散 `.tex` 或 `scene.pkg` 的绝对区间 `[start, end)`（编译期给出，P9a 步骤 2）。 */
export interface SceneVideoSource {
  path: string;
  start: number;
  end: number;
  /** 容器时长（秒，`containerDuration`，编译期读）；读不出时没有，播放器取帧表的时长（P9b）。 */
  duration?: number;
}

export interface VideoReport {
  warn(message: string, detail?: unknown): void;
}

/** 纹理连续这么多个渲染帧没被画到就暂停（WPE 常量，rea 第 4 节；实测第 32 帧冻住，差的是工作线程的延迟）。 */
export const IDLE_FRAMES = 30;

/** `setCurrentTime` 读回钳到 `[0, duration − 0.005]`（p9-REPORT「脚本 API」：钳制发生在媒体引擎里，脚本看得到）。 */
export const SEEK_END_MARGIN = 0.005;

/**
 * 该在放的视频没有任何输出这么久（墙钟毫秒）就算解码器卡住（P9c 步骤 1 的数，`codecPlayer.ts` 沿用）。实测的短暂缺帧每次约 1 s
 * 自己恢复，2 s 不会误伤。
 */
export const STALL_MS = 2000;

/** 复用播放器的键：同一文件的同一区间就是同一段视频。 */
export function videoSourceKey(source: SceneVideoSource): string {
  return `${source.path}\n${source.start}\n${source.end}`;
}
