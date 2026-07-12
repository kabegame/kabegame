/** 展示偏好：优先原图还是缩略图（缩略图始终作为打底层）。 */
export type ImagePrefer = "original" | "thumbnail";

/** 图片资源三级来源：缩略图 / 浏览器兼容副本 / 原始文件。既是加载回退链的环，也是失败标记的等级。 */
export type ImageSourceTag = "thumb" | "comp" | "local";

/**
 * 尽量与主程序的 ImageInfo 兼容（字段多不要求全传）。
 * core 组件只依赖少量字段：id/localPath/thumbnailPath/localExists/favorite/order/crawledAt。
 */
export interface ImageInfo {
  id: string;
  localPath: string;
  thumbnailPath?: string;

  // 可选：主程序/任务页会用到
  url?: string;
  pluginId?: string;
  taskId?: string;
  surfRecordId?: string;
  crawledAt?: number;
  /** 外键 `image_metadata.id`；列表常带此字段以合并懒加载请求 */
  metadataId?: number;
  /** `image_metadata.version`；用于 metadata 缓存失效 */
  pluginVersion?: number;
  hash?: string;
  order?: number;
  width?: number;
  height?: number;

  // UI 状态字段
  favorite?: boolean;
  isHidden?: boolean;
  localExists?: boolean;

  // 显示名称（从数据库 display_name 列读取）
  displayName?: string;

  /** 媒体 MIME（如 image/jpeg、video/mp4）；视频判定用 `video` 或 `video/*` 前缀。 */
  type?: string;

  /** 最后一次被设为壁纸的 Unix 时间戳（秒） */
  lastSetWallpaperAt?: number;

  /** 图片磁盘大小（字节） */
  size?: number;

  /** 浏览器兼容副本的本地路径（桌面端：浏览器无法直接播放/显示的格式会生成 H.264 MP4 / PNG 副本） */
  compatiblePath?: string;

  /** 帖子/页面地址（与下载 url 分开）；本地导入或无帖子概念时为 null。 */
  postUrl?: string;
}

export interface TaskFailedImage {
  id: number;
  taskId: string;
  pluginId: string;
  url: string;
  order: number;
  createdAt: number;
  lastError?: string | null;
  lastAttemptedAt?: number | null;
  headerSnapshot?: Record<string, string> | null;
  /** 外键 `image_metadata.id`；重试成功时写入新图片 */
  metadataId?: number | null;
  displayName?: string | null;
}
