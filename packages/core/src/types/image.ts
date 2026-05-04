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
  crawledAt?: number;
  /** 外键 `image_metadata.id`；列表常带此字段以合并懒加载请求 */
  metadataId?: number;
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
