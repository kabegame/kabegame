/**
 * lucide 没有的「实心」变体：同一个线性图标加 fill="currentColor"。
 * 用在需要表达开 / 关两态的地方（收藏 / 已收藏）。
 */
import { h, type FunctionalComponent } from "vue";
import { Star } from "@lucide/vue";

export const StarFilled: FunctionalComponent = (_props, { attrs }) => h(Star, { ...attrs, fill: "currentColor" });
StarFilled.displayName = "StarFilled";
