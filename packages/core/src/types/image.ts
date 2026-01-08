export type ImageUrlMap = Record<
  string,
  { thumbnail?: string; original?: string }
>;

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
  metadata?: Record<string, any>;
  hash?: string;
  order?: number;

  // UI 状态字段
  favorite?: boolean;
  localExists?: boolean;
}
