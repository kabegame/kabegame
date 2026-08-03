import type { ObjectDirective } from "vue";

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
}

export interface DragFileOptions {
  /** 整体关闭该热区（例如只读画册）。true 时等同于不存在 */
  disabled?: boolean;
  /** 决定接不接、浮层显示什么。返回 null = 本区域拒绝这批文件 */
  plan: (items: DragFileItem[]) => DragFilePlan | null;
  /** 松手即执行，无确认。入参就是 plan() 的返回值 */
  onDrop: (plan: DragFilePlan) => void | Promise<void>;
}

/** 注册表里的一条热区 */
export interface DragFileZone {
  el: HTMLElement;
  options: DragFileOptions;
  /** 宿主元素当前的视口矩形，浮层定位要用 */
  rect: () => DOMRect;
}

/** 模块级热区注册表：v-drag-file 挂载的所有元素 */
const zones = new Map<HTMLElement, DragFileOptions>();

/** 计算元素在 DOM 树中的深度（根到自身的父链长度），用于多命中时取最内层 */
function domDepth(el: HTMLElement): number {
  let depth = 0;
  let current: HTMLElement | null = el;
  while (current) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

/**
 * 按 CSS 视口坐标命中热区。
 * 跳过 disabled 的、以及 rect 宽高为 0 的（被 v-if/display:none 卸掉的情况）。
 * 多个命中时取 DOM 深度最大的那个（最内层优先）。
 * 不用 document.elementFromPoint —— 浮层与 v-loading 遮罩都可能挡在中间，rect 判定不受影响。
 */
export function hitTestDragZone(cssX: number, cssY: number): DragFileZone | null {
  let best: HTMLElement | null = null;
  let bestOptions: DragFileOptions | null = null;
  let bestDepth = -1;

  for (const [el, options] of zones) {
    if (options.disabled) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (cssX < rect.left || cssX > rect.right || cssY < rect.top || cssY > rect.bottom) continue;

    const depth = domDepth(el);
    if (depth > bestDepth) {
      best = el;
      bestOptions = options;
      bestDepth = depth;
    }
  }

  if (!best || !bestOptions) return null;
  const el = best;
  const options = bestOptions;
  return {
    el,
    options,
    rect: () => el.getBoundingClientRect(),
  };
}

export const vDragFile: ObjectDirective<HTMLElement, DragFileOptions> = {
  mounted(el, binding) {
    zones.set(el, binding.value);
  },
  updated(el, binding) {
    // 只更新 options，不重新登记（保持注册表里的 key 不变）
    zones.set(el, binding.value);
  },
  unmounted(el) {
    zones.delete(el);
  },
};
