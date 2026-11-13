<template>
  <ContextMenuRoot v-model:open="open" :modal="modal">
    <ContextMenuTrigger as-child :disabled="disabled" @contextmenu.capture="onContextMenuCapture">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal :to="portalTo">
      <ContextMenuContent
        :collision-padding="8"
        class="kb-menu-panel"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
        @close-auto-focus="(e: Event) => keepFocusForForeign(e, portalTo)"
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
import { ref } from "vue";
import { ContextMenuContent, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from "reka-ui";
import { useModalBack } from "@/composables/useModalBack";
import {
  foreignPortalTarget,
  keepFocusForForeign,
  keepOpenOnForeign,
  useLayerZIndex,
  usePauseForeignTraps,
} from "./compat";

withDefaults(defineProps<{ disabled?: boolean; modal?: boolean }>(), { modal: true });

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删

// TODO:[REF_UI] P9 删：右键点在 EP 对话框里时菜单挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
function onContextMenuCapture(e: Event) {
  portalTo.value = foreignPortalTarget(e.target instanceof Element ? e.target : null);
}
</script>
