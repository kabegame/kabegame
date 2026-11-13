/**
 * 图像层的对齐 `alignment`（P8 步骤 3，`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 3」）：编译、状态、
 * 脚本共用的取值表。
 *
 * WPE 把它登记在图像层自己的属性表里（rea-p8-layer 2.1：类型 5 枚举，偏移 `+0x4b1`），文本、形状、粒子、模型、声音、灯、分组节点
 * 都不认它。JSON setter 与脚本写都按字符串逐项查表，查不到或不是字符串（含 `{user, value}`、数字）一律取第一项 `center`；脚本读返回
 * 名字（p8-REPORT 结论 6、`p8-par` 的 T：写数字 2 读回 `"center"`；`p8-align2` 的 U、N）。偏移本身见 `render/layout.ts` 的
 * `alignmentOffset`。
 */

/** 枚举表（WPE `0x1404e97f0`，rea-p8-layer 2.1）：下标就是 WPE 写进 `+0x4b1` 的值。 */
export const ALIGNMENTS = [
  "center",
  "top",
  "topright",
  "right",
  "bottomright",
  "bottom",
  "bottomleft",
  "left",
  "topleft",
] as const;

export type AlignmentName = (typeof ALIGNMENTS)[number];

/** 取值 → 下标：字符串逐项比较（区分大小写，同 WPE 的 `std::string` 比较），查不到或不是字符串为 0（`center`）。 */
export function alignmentIndex(value: unknown): number {
  if (typeof value !== "string") return 0;
  const index = (ALIGNMENTS as readonly string[]).indexOf(value);
  return index < 0 ? 0 : index;
}

/** 下标 → 名字（脚本读回，WPE `0x140212610`）；不在表里的按 `center`。 */
export function alignmentName(index: number | undefined): AlignmentName {
  return (index !== undefined && ALIGNMENTS[index]) || "center";
}
