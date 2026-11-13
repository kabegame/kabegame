<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :type="as === 'button' && !asChild ? type : undefined"
    :class="[BASE, VARIANTS[variant], SIZES[size]]"
  >
    <slot />
  </Primitive>
</template>

<script setup lang="ts">
/**
 * 新界面的按钮（样式取 tokens.css）。图标直接放进默认插槽，尺寸由 size 统一给（[&_svg]）。
 * 可以当 Reka 触发器的 as-child 子元素：DropdownMenuTrigger / Tooltip 会把属性与事件合到这里。
 *
 * 样式表写在 .vue 里而不是 .ts：UnoCSS 默认只扫描 .vue 等模板文件，.ts 里的类名不会生成。
 */
import { Primitive, type PrimitiveProps } from "reka-ui";

type Variant = "primary" | "danger" | "outline" | "ghost" | "ghost-danger";
type Size = "sm" | "md" | "icon" | "icon-sm" | "icon-xs";

withDefaults(
  defineProps<
    PrimitiveProps & {
      /** primary：墨色实心主操作；danger：危险色实心（确认删除）；outline：细边框次操作；ghost：只有悬停底色（工具按钮）；
       *  ghost-danger：同 ghost，悬停转危险色（删除、卸载） */
      variant?: Variant;
      size?: Size;
      type?: "button" | "submit" | "reset";
    }
  >(),
  { as: "button", variant: "outline", size: "md", type: "button" },
);

// 仓库没有 Tailwind 式 reset：button 自带边框、内边距与字体，这里逐项归零。
// 边框按变体给（border-0 / border），不放进 BASE：同一元素上 border-0 与 border 谁赢取决于生成顺序。
const BASE =
  "relative box-border inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none " +
  "py-0 [font-family:inherit] font-500 leading-none cursor-pointer outline-none " +
  "transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.97] " +
  "focus-visible:ring-2 focus-visible:ring-kb-ring disabled:pointer-events-none disabled:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

const VARIANTS: Record<Variant, string> = {
  primary:
    "border-0 bg-kb-primary text-kb-primary-fg shadow-kb-sm hover:bg-kb-primary-hover data-[state=open]:bg-kb-primary-hover",
  danger: "border-0 bg-kb-danger text-white shadow-kb-sm hover:bg-[color-mix(in_srgb,var(--kb-danger)_86%,black)]",
  outline:
    "bg-transparent text-kb-fg border border-solid border-kb-line-strong hover:bg-kb-hover data-[state=open]:bg-kb-hover",
  ghost:
    "border-0 bg-transparent text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg data-[state=open]:bg-kb-hover data-[state=open]:text-kb-fg",
  "ghost-danger":
    "border-0 bg-transparent text-kb-fg-muted hover:bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)] hover:text-kb-danger",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] rounded-kb-md [&_svg]:size-3.5",
  md: "h-8 px-3 text-[13px] rounded-kb-md [&_svg]:size-4",
  icon: "size-8 px-0 rounded-kb-md [&_svg]:size-[18px]",
  "icon-sm": "size-7 px-0 rounded-kb-md [&_svg]:size-4",
  "icon-xs": "size-5 px-0 rounded-kb-sm [&_svg]:size-3.5",
};
</script>
