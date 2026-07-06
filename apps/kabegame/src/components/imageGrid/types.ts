import type { Ref, ShallowRef } from "vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import type { CreateImageActionsOptions } from "@/actions/imageActions";
import type { ImageAnalytics } from "@kabegame/core/track/imageAnalytics";

export type GridSurfaceId = "gallery" | "task" | "album" | "surf";

/**
 * ImageGrid connected 模式使用的 path-route store 子集。
 * `createPathRouteStore` 的返回值均结构性满足此接口。
 */
export interface GridRouteStore {
  computedPath: string;
  page: number;
  pageSize: number;
  navigate: (patch: { page: number }, opts?: { push?: boolean }) => Promise<unknown>;
  syncFromUrl: (path: string) => void;
}

/** ImageGrid 暴露给 adapter 回调的刷新上下文 */
export interface GridRefreshContext {
  /** 当前页图片列表；adapter 可整体替换 .value 做就地更新（如收藏星标） */
  images: ShallowRef<ImageInfo[]>;
  computedPath: Readonly<Ref<string>>;
  /**
   * 刷新当前页（保留滚动）+ 重算总数；对被移除的图片做选中清理、
   * 当前壁纸清理与页码越界回退。返回本次刷新被移除的 id。
   */
  refreshPage: () => Promise<{ removedIds: string[] }>;
  loadTotalImagesCount: () => Promise<void>;
  ensureValidPageAfterMassRemoval: () => Promise<void>;
  clearSelection: () => void;
}

export interface GridRemoveDialogText {
  title: string;
  message: string;
  confirmText?: string;
}

/** remove / deleteFile 命令的确认框与执行配置 */
export interface GridRemoveConfig {
  /** 返回 true：拦截本次操作（adapter 自行提示原因，如本地文件夹画册只读） */
  guard?: () => boolean;
  dialogText: (
    count: number,
    extra: { includesCurrentWallpaper: boolean },
  ) => GridRemoveDialogText;
  /** 确认后的执行；缺省 = `batch_delete_images`（含当前壁纸清理与成功提示） */
  confirm?: (images: ImageInfo[], ctx: GridRefreshContext) => Promise<void>;
}

export interface GridEventRefreshConfig<TPayload> {
  waitMs?: number;
  /** 返回 false 忽略此次事件；缺省不过滤 */
  filter?: (payload: TPayload, ctx: GridRefreshContext) => boolean;
  /** 缺省实现 = `ctx.refreshPage()`（含 removedIds 处理）+ adapter.onAfterRefresh */
  onRefresh?: (payload: TPayload, ctx: GridRefreshContext) => Promise<void> | void;
}

/**
 * Per-surface 适配器：让 ImageGrid 按所在页面加载数据、过滤事件、
 * 以及关闭 / 特殊处理部分菜单功能。
 *
 * 工厂（createXxxSurface）必须在对应 view 的 setup 中调用——route store
 * 只能在自己的路由 finalize 后实例化（pathRoute store 过早实例化会拼出脏路径）。
 */
export interface GridSurfaceAdapter {
  id: GridSurfaceId;
  routeStore: GridRouteStore;
  /** 视图是否处于可加载状态（路由匹配 + 关键参数就绪）；keep-alive 激活态由 ImageGrid 自己守卫 */
  isActive: () => boolean;
  /** currentPath 为空时的兜底加载路径；返回空串则跳过加载 */
  rootPathFallback?: () => string;
  /** 返回 false 则跳过本次路径加载（如 album 校验 `album/` 前缀） */
  validatePath?: (path: string) => boolean;
  computeCountPath: (path: string) => string;
  onCountError?: (
    error: unknown,
    ctx: GridRefreshContext,
  ) => Promise<number | void> | number | void;
  onLoadError?: (error: unknown, path: string) => Promise<void> | void;
  /** usePagedGallery 透传：预览跨页边界的目标 path（album 用） */
  computeTargetPath?: (page: number) => string;
  /** route.query.path 为空串时是否也执行 syncFromUrl（gallery 需要重置为默认路径） */
  syncEmptyQueryPath?: boolean;

  imagesChange?: GridEventRefreshConfig<ImagesChangePayload>;
  albumImagesChange?: GridEventRefreshConfig<AlbumImagesChangePayload>;
  /** 事件默认刷新完成后的追加动作（task: failedImagesStore.loadAll） */
  onAfterRefresh?: (
    ctx: GridRefreshContext,
    info: { removedIds: string[] },
  ) => Promise<void> | void;

  /** 菜单项配置；view 未显式传 actions prop 时由 ImageGrid 生成 */
  actionsOptions?: () => CreateImageActionsOptions;
  remove: GridRemoveConfig;
  /** 独立的「删除文件」命令（album 用；未配置时 deleteFile 命令为 no-op） */
  deleteFile?: GridRemoveConfig;
  /** swipe-remove（上划手势）语义；缺省 = 批量隐藏（加入隐藏画册） */
  swipeRemove?: (images: ImageInfo[], ctx: GridRefreshContext) => Promise<void> | void;
  /** addToHidden 强制视为「取消隐藏」（HIDDEN 画册详情内） */
  forceUnhide?: () => boolean;
  addToAlbumExcludeIds?: () => string[];
  /** 加入画册成功后的追加动作（album: loadAlbums） */
  onAddedToAlbum?: () => Promise<void> | void;
  /** 传入时 ImageGrid 会对菜单动作与预览交互自动埋点 */
  analytics?: ImageAnalytics;
}
