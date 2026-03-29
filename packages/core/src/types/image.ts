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
  /** 爬虫写入的任意 JSON，详情区由插件 `templates/description.ejs` 渲染 */
  metadata?: Record<string, unknown>;
  hash?: string;
  order?: number;
  width?: number;
  height?: number;

  // UI 状态字段
  favorite?: boolean;
  localExists?: boolean;

  // 显示名称（从数据库 display_name 列读取）
  displayName?: string;

  /** 图片 MIME 类型（来自表 mime_type，分享/剪贴板优先使用） */
  mimeType?: string | null;
  /** 媒体类型：默认 image，video 表示视频壁纸。 */
  type?: "image" | "video";

  /** 最后一次被设为壁纸的 Unix 时间戳（秒） */
  lastSetWallpaperAt?: number;

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
}
