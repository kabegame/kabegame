/** 后端 get_file_drop_kinds 的单项 */
export interface DragFileItem {
  path: string;
  isDirectory: boolean;
  isImage: boolean;
  isVideo: boolean;
  isKgpg: boolean;
}

/** plan() 的返回值：既是浮层内容，也是 onDrop 的入参 */
export interface DragFilePlan {
  /** 浮层主文案 */
  label: string;
  /** 浮层副文案；不给则浮层用 common.releaseToImport 兜底 */
  hint?: string;
  /** 本区域接受的媒体文件（图片 + 视频） */
  media: DragFileItem[];
  /** 本区域接受的文件夹 */
  folders: DragFileItem[];
  /** 本区域接受的 .kgpg 插件包 */
  plugins: DragFileItem[];
  /** 不属于媒体 / 文件夹 / 插件包的通用拖入项（路径控件用） */
  items?: DragFileItem[];
}

/** `<DragFileZone>` 的响应式 props；注册表直接持有它，命中时读到的总是最新值 */
export interface DragFileZoneProps {
  /** 决定接不接、浮层显示什么。返回 null = 本区域拒绝这批文件 */
  plan: (items: DragFileItem[]) => DragFilePlan | null;
  /** 松手即执行，无确认。入参就是 plan() 的返回值 */
  onDrop: (plan: DragFilePlan) => void | Promise<void>;
  /** 整体关闭该热区（例如只读画册）。true 时等同于不存在 */
  disabled?: boolean;
}

/** 注册表里的一条热区 */
export interface DragFileZone {
  el: HTMLElement;
  options: DragFileZoneProps;
  /** 宿主元素当前的视口矩形，浮层定位要用 */
  rect: () => DOMRect;
}

/** 模块级热区注册表：所有挂载中的 `<DragFileZone>` */
const zones = new Map<HTMLElement, DragFileZoneProps>();

export function registerDragZone(el: HTMLElement, props: DragFileZoneProps): void {
  zones.set(el, props);
}

export function unregisterDragZone(el: HTMLElement): void {
  zones.delete(el);
}

/**
 * 按 CSS 视口坐标命中热区。
 * 先按 z 序取落点最上层的元素，再沿父链找最近的已注册热区：
 * teleport 到 body 的弹窗会自然挡住底下页面的热区，而不需要比较 rect。
 * 跳过 disabled 的、以及 rect 宽高为 0 的（被 v-if/display:none 卸掉的情况）。
 */
export function hitTestDragZone(cssX: number, cssY: number): DragFileZone | null {
  const top = document.elementsFromPoint(cssX, cssY)[0] ?? null;
  for (let el: HTMLElement | null = top as HTMLElement | null; el; el = el.parentElement) {
    const props = zones.get(el);
    if (!props || props.disabled) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return { el, options: props, rect: () => el.getBoundingClientRect() };
  }
  return null;
}
