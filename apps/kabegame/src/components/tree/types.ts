/**
 * VSCode 式树基座的公共类型（模型/视图分离 + 扁平行投影）。
 *
 * 设计对齐 vscode `src/vs/base/browser/ui/tree`：
 * - `TreeDataSource`  ≈ IAsyncDataSource（懒加载子项）
 * - `TreeNodeHandle`  ≈ ITreeNode（但为 shallowReactive 句柄，视图直接读）
 * - `TreeDndController` ≈ ITreeDragAndDrop（运输层为 pointer 状态机，见 useTreeDnd）
 *
 * 本模块对 app 其余部分零依赖（不 import stores / galleryPath），
 * 便于将来上提到共享包。
 */

/** 懒加载数据源：展开未加载节点时基座调用 getChildren 并管理 loading/loaded 态。 */
export interface TreeDataSource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  /** 可同步可异步；抛错视为空子集（由调用方决定是否在源内自行兜底）。 */
  getChildren(element: T): T[] | Promise<T[]>;
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
  /** getChildren 进行中（对应旧实现的 aria-busy）。 */
  loading: boolean;
  /** 至少成功枚举过一次子项（对应旧实现的 loaded ref）。 */
  loaded: boolean;
  /** rebuild 时回填：本节点在当前投影中的可见行数（含自身），供 sticky 推走与 DnD 反馈。 */
  subtreeRowCount: number;
}

export type TreeRow<T> =
  | { kind: "node"; key: string; node: TreeNodeHandle<T> }
  | { kind: "section-header"; key: string; sectionId: string }
  | { kind: "separator"; key: string; sectionId: string };

/** 分区：一个面板内多段独立森林（如「系统项区 + 分隔线 + 树区 + 本地文件夹区」）。 */
export interface TreeSection<T> {
  id: string;
  /** 渲染 section-header 行（内容由 #section-header slot 提供）。 */
  header?: boolean;
  separatorBefore?: boolean;
  roots: () => T[] | Promise<T[]>;
}

/** 行状态：由消费者按元素给出，基座只负责套用样式类与拦截交互。 */
export interface TreeRowState {
  active?: boolean;
  disabled?: boolean;
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
  onDragOver(
    source: T,
    target: T | null,
    sector: TreeDropPosition,
  ): boolean | TreeDragOverReaction;
  drop(source: T, target: T | null, position: TreeDropPosition): void | Promise<void>;
}
