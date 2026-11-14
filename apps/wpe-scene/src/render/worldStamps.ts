/**
 * WPE 世界矩阵缓存的影子（步骤 6b，B1）：纯 TS，不碰 GPU。
 *
 * WPE 的世界矩阵函数（`FUN_1401850a0` / `FUN_140185040`，clip-morph-attach 6(2)，`p12-lag` 16 条预测实测）给每个对象记一个「戳」（帧号）
 * 与一份缓存矩阵，跨帧保留。挂点对象要求自己的戳等于本帧号，所以更新循环里每帧重算（戳 = 本帧号）；渲染时被写过的祖先先画、重算后戳也是
 * 本帧号，`本帧号 ≥ 本帧号` 判成缓存有效，挂点的子对象就沿用了更新阶段的值（祖先的变换是上一帧的，姿势是本帧的），子孙随之滞后。
 * 不挂点的对象更新阶段命中的戳是上一帧，渲染时父重算成本帧号，`上一帧 < 本帧号` 就重算，没有滞后。
 *
 * 规则（逐条照读码）：
 * - 命中 ⇔ 戳 ≠ 0 且（没有挂点 ‖ 戳 == 本帧号）且（没有父 ‖（戳 ≥ 父.戳 且 父链有效(父, 自己有挂点)））；
 * - 父链有效(P, 子有挂点) ⇔ P.戳 ≠ 0 且（!子有挂点 ‖ P.戳 == 本帧号）且（P 没有父 ‖（P.戳 ≥ 祖父.戳 且 父链有效(祖父, P 有挂点)））；
 * - 命中返回缓存、不改戳；不命中按 `W = 父的求值 · ((Pose·Att) · L)` 现算（父也走这条规则递归），戳记成本帧号。
 *
 * 乘法顺序与 `worldMatrixOf`（`layout.ts`）逐步相同，所以没有写入时它的值和现算逐字节相同。父对象不在表里时当根；环在编译期已断开，
 * 递归按走过的节点兜底。
 */
import { layerLocalMatrix, type LayerTransform } from "./layout";
import { identity, multiply, type Mat4 } from "./math";

type StampLayer = Pick<LayerTransform, "origin" | "angles" | "scale" | "parent">;

export class WorldStamps {
  private frameNo = 0;
  /** 戳（帧号）：没有记录等于 0（没算过 / 写过）。 */
  private readonly stamps = new Map<number, number>();
  private readonly cache = new Map<number, Mat4>();

  /** 当前帧号（更新阶段开头加一）；从 1 起，0 留给「没算过 / 写过」。 */
  get frame(): number {
    return this.frameNo;
  }

  nextFrame(): void {
    this.frameNo++;
  }

  /** 对象的当前戳（测试与诊断用）。 */
  stampOf(object: number): number {
    return this.stamps.get(object) ?? 0;
  }

  /** 变换写入：戳清 0（WPE 描述符回调 `0x1401e0520`）。 */
  invalidate(objects: Iterable<number>): void {
    for (const object of objects) this.stamps.set(object, 0);
  }

  evaluate(
    object: number,
    layers: ReadonlyMap<number, StampLayer>,
    /** 对象的挂点 ≥ 0（`GpuScene.attachments.has`）。 */
    attached: (object: number) => boolean,
    /** 同 `worldMatrixOf` 的钩子：挂点对象返回 `Pose[骨骼] · Att`，否则 null。 */
    attach: (object: number) => Mat4 | null,
  ): Mat4 {
    return this.eval(object, layers, attached, attach, new Set());
  }

  /** 父对象在表里才算有父（不在表里当根，同 `worldMatrixOf`）。 */
  private parentOf(object: number, layers: ReadonlyMap<number, StampLayer>): number | null {
    const parent = layers.get(object)?.parent ?? null;
    return parent !== null && layers.has(parent) ? parent : null;
  }

  private chainValid(
    parent: number,
    childAttached: boolean,
    layers: ReadonlyMap<number, StampLayer>,
    attached: (object: number) => boolean,
    seen: Set<number>,
  ): boolean {
    const stamp = this.stampOf(parent);
    if (stamp === 0) return false;
    if (childAttached && stamp !== this.frameNo) return false;
    if (seen.has(parent)) return true; // 环的兜底
    seen.add(parent);
    const grand = this.parentOf(parent, layers);
    if (grand === null) return true;
    return stamp >= this.stampOf(grand) && this.chainValid(grand, attached(parent), layers, attached, seen);
  }

  private hit(object: number, layers: ReadonlyMap<number, StampLayer>, attached: (object: number) => boolean): boolean {
    const stamp = this.stampOf(object);
    if (stamp === 0) return false;
    const own = attached(object);
    if (own && stamp !== this.frameNo) return false;
    const parent = this.parentOf(object, layers);
    if (parent === null) return true;
    return stamp >= this.stampOf(parent) && this.chainValid(parent, own, layers, attached, new Set([object]));
  }

  private eval(
    object: number,
    layers: ReadonlyMap<number, StampLayer>,
    attached: (object: number) => boolean,
    attach: (object: number) => Mat4 | null,
    visiting: Set<number>,
  ): Mat4 {
    const layer = layers.get(object);
    if (!layer) return identity();
    const cached = this.cache.get(object);
    if (cached && this.hit(object, layers, attached)) return cached;
    visiting.add(object);
    const parent = this.parentOf(object, layers);
    const parentWorld =
      parent !== null && !visiting.has(parent) ? this.eval(parent, layers, attached, attach, visiting) : null;
    const own = layerLocalMatrix(layer);
    const pre = attach(object);
    const local = pre ? multiply(pre, own) : own;
    const world = parentWorld ? multiply(parentWorld, local) : local;
    this.cache.set(object, world);
    this.stamps.set(object, this.frameNo);
    visiting.delete(object);
    return world;
  }
}
