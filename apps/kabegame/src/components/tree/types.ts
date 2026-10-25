import type { PathqlQuery } from "@/services/pathql";
import type { EventTrigger } from "@/services/kbEvents/events";

/** 树的分支：分区根列表，或某节点的子项。 */
export type TreeBranch<T> = { kind: "section"; sectionId: string } | { kind: "children"; parent: T };

/** 结构查询先渲染；补充查询按元素 key 打字段补丁，不阻塞结构。 */
export interface TreePage<T> {
  queries: readonly PathqlQuery[];
  parse(results: readonly unknown[]): T[];
  extra?: {
    queries: readonly PathqlQuery[];
    parse(results: readonly unknown[]): Map<string, Partial<T>>;
  };
}

export interface TreeQuerySource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  /** 页码从 1 起；null 表示没有此页。可读响应式参数，父元素只依赖 id、ancestorPath 等稳定字段。 */
  page(branch: TreeBranch<T>, page: number): TreePage<T> | null;
  refreshOn(branch: TreeBranch<T>, part: "page" | "extra"): readonly EventTrigger[];
  /** 不提供则只有一页。 */
  pageSize?: number;
  totalChildren?(element: T): number;
}

/**
 * 节点句柄：shallowReactive，视图直接读取其可变字段；
 * 结构性变化（children/expanded）由模型层负责触发行投影 rebuild。
 */
export interface TreeNodeHandle<T> {
  readonly key: string;
  element: T;
  readonly depth: number;
  readonly parent: TreeNodeHandle<T> | null;
  readonly sectionId: string;
  hasChildren: boolean;
  /** null = 尚未加载（懒加载）；[] = 已加载且为空。 */
  children: TreeNodeHandle<T>[] | null;
  expanded: boolean;
  /** 结构查询进行中（对应旧实现的 aria-busy）。 */
  loading: boolean;
  /** 至少成功枚举过一次子项（对应旧实现的 loaded ref）。 */
  loaded: boolean;
  /** 分页数据源中是否仍有未加载子项。 */
  hasMore: boolean;
  loadedPages: number;
  /** rebuild 时回填：本节点在当前投影中的可见行数（含自身），供 sticky 推走与 DnD 反馈。 */
  subtreeRowCount: number;
}

export type TreeRow<T> =
  | { kind: "node"; key: string; node: TreeNodeHandle<T> }
  | { kind: "section-header"; key: string; sectionId: string }
  | { kind: "separator"; key: string; sectionId: string }
  | { kind: "load-more"; key: string; parentKey: string | null; sectionId: string; loading: boolean };

/** 分区：一个面板内多段独立森林（如「系统项区 + 分隔线 + 树区 + 本地文件夹区」）。 */
export interface TreeSection<T> {
  id: string;
  /** 渲染 section-header 行（内容由 #section-header slot 提供）。 */
  header?: boolean;
  separatorBefore?: boolean;
}

/** 行状态：由消费者按元素给出，基座只负责套用样式类与拦截交互。 */
export interface TreeRowState {
  active?: boolean;
  disabled?: boolean;
  /** 点击会选择 / 应用此节点；控制 hover 选择提示，不影响展开等其它交互。 */
  clickable?: boolean;
  /** 计数 0 之类的弱化态（整行灰字，但仍可交互）。 */
  muted?: boolean;
  /** 从投影中剔除（对应旧 emptyState="hide"）。 */
  hidden?: boolean;
}

export type TreeDropPosition = "before" | "inside" | "after";

export interface TreeDragOverReaction {
  accept: boolean;
  /** 反馈落点（缺省 = 命中扇区）；inside=整行高亮，before/after=插入线。 */
  position?: TreeDropPosition;
  /** 悬停同一节点 500ms 自动展开（学 abstractTree 的 autoExpand 定时器）。 */
  autoExpand?: boolean;
}

/**
 * DnD 控制器：消费者只提供判定与提交，基座负责手势/浮影/命中/落点反馈。
 * target = null 表示落在分区空白/根区域，语义由消费者裁决。
 */
export interface TreeDndController<T> {
  canDrag(element: T): boolean;
  /** 浮影文本；缺省用消费者行内容无从得知，故建议提供。 */
  getDragLabel?(element: T): string;
  onDragOver(source: T, target: T | null, sector: TreeDropPosition): boolean | TreeDragOverReaction;
  drop(source: T, target: T | null, position: TreeDropPosition): void | Promise<void>;
}
