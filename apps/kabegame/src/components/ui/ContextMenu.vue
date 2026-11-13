<template>
  <ContextMenuRoot v-model:open="open" :modal="modal">
    <ContextMenuTrigger as-child :disabled="disabled">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent
        :collision-padding="8"
        class="kb-menu-panel"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
      >
        <slot name="menu" />
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<script setup lang="ts">
/**
 * 右键菜单：默认插槽是触发区域（as-child，右键 / Android 长按打开），#menu 是菜单项
 * （MenuItem / MenuSeparator / MenuSub / MenuCheckboxItem / MenuRadioGroup / MenuLabel）。
 *
 *   <ContextMenu>
 *     <div class="card">…</div>
 *     <template #menu><MenuItem @select="copy"><Copy />复制</MenuItem></template>
 *   </ContextMenu>
 *
 * 没有 DOM 事件可用、要在某个坐标打开时（iframe 转发的右键），对触发区域派发一个带 clientX / clientY 的
 * `contextmenu` MouseEvent 即可。
 */
import { ContextMenuContent, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from "reka-ui";
import { useModalBack } from "@/composables/useModalBack";
import { useLayerZIndex, keepOpenOnToast } from "./layer";

withDefaults(defineProps<{ disabled?: boolean; modal?: boolean }>(), { modal: true });

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);
</script>
