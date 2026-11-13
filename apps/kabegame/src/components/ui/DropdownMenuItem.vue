<template>
  <DropdownMenuItem
    :disabled="disabled"
    class="relative box-border flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-kb-md px-2.5 text-[13px] text-kb-fg outline-none transition-colors duration-100 data-[highlighted]:bg-kb-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-kb-fg-muted"
  >
    <slot />
  </DropdownMenuItem>
</template>

<script setup lang="ts">
/** 菜单项：图标放在文字前（自动定尺寸与次要色），选中用 @select。 */
import { DropdownMenuItem } from "reka-ui";

defineProps<{ disabled?: boolean }>();
</script>
