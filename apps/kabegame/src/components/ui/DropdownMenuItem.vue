<template>
  <DropdownMenuItem
    :disabled="disabled"
    class="kb-menu-item"
    :class="danger ? 'text-kb-danger [&_svg]:text-kb-danger' : ''"
  >
    <slot />
    <span v-if="shortcut" class="ml-auto pl-4 text-[11.5px] tracking-wide text-kb-fg-subtle">{{ shortcut }}</span>
  </DropdownMenuItem>
</template>

<script setup lang="ts">
/**
 * 菜单项：图标放在文字前（自动定尺寸与次要色），选中用 @select。
 * 下拉菜单与右键菜单共用（Reka 的菜单项不依赖根组件类型），从 "@/components/ui" 也可以按 MenuItem 导入。
 */
import { DropdownMenuItem } from "reka-ui";

defineProps<{
  disabled?: boolean;
  /** 危险操作（删除）：文字与图标用危险色 */
  danger?: boolean;
  /** 右侧的快捷键提示 */
  shortcut?: string;
}>();
</script>
