import type { Directive } from "vue";

export type CornerBadgeValue =
  number | boolean | null | undefined | { count?: number | null; dot?: boolean; max?: number };

const badgeText = (count: number, max = 99): string | null => {
  const normalizedCount = Math.floor(count);
  if (!Number.isFinite(normalizedCount) || normalizedCount <= 0) return null;

  const normalizedMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 99;
  return normalizedCount > normalizedMax ? `${normalizedMax}+` : String(normalizedCount);
};

const apply = (el: HTMLElement, value: CornerBadgeValue) => {
  let text: string | null = null;
  let dot = false;

  if (typeof value === "number") {
    text = badgeText(value);
  } else if (value === true) {
    dot = true;
  } else if (value && typeof value === "object") {
    if (typeof value.count === "number") text = badgeText(value.count, value.max);
    dot = text === null && value.dot === true;
  }

  const show = text !== null || dot;
  el.classList.toggle("kb-corner-badge--show", show);
  el.classList.toggle("kb-corner-badge--dot", dot);
  if (show) el.setAttribute("data-kb-badge", text ?? "");
  else el.removeAttribute("data-kb-badge");
};

/** 在任意不占用 `::after` 的宿主右上角显示数字或圆点角标。 */
export const vCornerBadge: Directive<HTMLElement, CornerBadgeValue> = {
  mounted(el, binding) {
    el.classList.add("kb-corner-badge");
    apply(el, binding.value);
  },
  updated(el, binding) {
    apply(el, binding.value);
  },
  unmounted(el) {
    el.classList.remove("kb-corner-badge", "kb-corner-badge--dot", "kb-corner-badge--show");
    el.removeAttribute("data-kb-badge");
  },
};
