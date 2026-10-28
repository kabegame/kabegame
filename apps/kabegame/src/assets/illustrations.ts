// 插画按模式选版本：web 从 CDN 下载，用按显示尺寸（3 倍屏）压缩的 WebP；
// 本地模式随安装包分发，用原图。IS_WEB 是编译期常量，另一份在代码里被折叠掉，
// 其资源文件由 vite.config.ts 的 dropUnreferencedSrcAssets 从产物中删除。
import { IS_WEB } from "@/env";
import kamechanStandPng from "./kamechan/stand.png";
import kamechanStandWebp from "./kamechan/stand.webp";
import kamechanWavePng from "./kamechan/wave.png";
import kamechanWaveWebp from "./kamechan/wave.webp";
import lostPng from "./lost.png";
import lostWebp from "./lost.webp";
import albumEmptyPng from "./album-empty.png";
import albumEmptyWebp from "./album-empty.webp";
import swimPng from "./swim.png";
import swimWebp from "./swim.webp";

export const kamechanStandImageUrl = IS_WEB ? kamechanStandWebp : kamechanStandPng;
export const kamechanWaveImageUrl = IS_WEB ? kamechanWaveWebp : kamechanWavePng;
export const lostImageUrl = IS_WEB ? lostWebp : lostPng;
export const albumEmptyImageUrl = IS_WEB ? albumEmptyWebp : albumEmptyPng;
export const swimImageUrl = IS_WEB ? swimWebp : swimPng;
