<template>
  <DropdownMenuRoot :open="visible" :modal="true" @update:open="onOpenChange">
    <DropdownMenuPortal>
      <DropdownMenuContent
        :reference="anchor"
        side="bottom"
        align="start"
        :side-offset="2"
        :collision-padding="8"
        class="context-menu kb-menu-panel"
        :style="{ zIndex: layerZIndex }"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
        @close-auto-focus="onCloseAutoFocus"
      >
        <!-- 提供了 items 就按条目渲染，否则用插槽（插槽里放 MenuItem / MenuSeparator / MenuSub） -->
        <template v-if="items">
          <template v-for="(item, index) in items" :key="item.key ?? index">
            <MenuSeparator v-if="item.type === 'divider'" />
            <template v-else-if="getItemVisible(item)">
              <MenuSub v-if="item.children && item.children.length > 0" :disabled="item.disabled">
                <template #trigger>
                  <component :is="getIcon(item)" v-if="item.icon" />
                  <span class="min-w-0 truncate">{{ item.label }}</span>
                  <span v-if="item.suffix" class="pl-2 text-[11.5px] text-kb-fg-subtle">{{ item.suffix }}</span>
                </template>
                <template v-for="(child, childIndex) in item.children" :key="child.key ?? childIndex">
                  <MenuSeparator v-if="child.type === 'divider'" />
                  <KbMenuItem
                    v-else-if="getItemVisible(child)"
                    :disabled="child.disabled"
                    :danger="child.className === 'danger'"
                    :class="toneClass(child)"
                    @select="handleItemClick(child)"
                  >
                    <component :is="getIcon(child)" v-if="child.icon" />
                    <span class="min-w-0 truncate">{{ child.label }}</span>
                    <span v-if="child.suffix" class="ml-auto pl-4 text-[11.5px] text-kb-fg-subtle">
                      {{ child.suffix }}
                    </span>
                  </KbMenuItem>
                </template>
              </MenuSub>
              <KbMenuItem
                v-else
                :disabled="item.disabled"
                :danger="item.className === 'danger'"
                :class="toneClass(item)"
                @select="handleItemClick(item)"
              >
                <component :is="getIcon(item)" v-if="item.icon" />
                <span class="min-w-0 truncate">{{ item.label }}</span>
                <span v-if="item.suffix" class="ml-auto pl-4 text-[11.5px] text-kb-fg-subtle">{{ item.suffix }}</span>
              </KbMenuItem>
            </template>
          </template>
        </template>
        <slot v-else />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
/**
 * 按坐标打开的菜单（画廊 / 画册 / 任务的右键菜单，预览弹窗的菜单，壁纸 iframe 转发的右键）。
 * 调用方自己管开关与坐标（visible + position），菜单在 position 处按虚拟锚点定位、贴边时自动翻转；
 * 点外部、Esc、选中某项都发 close。外观与键盘行为同 ui 的下拉 / 右键菜单（Reka DropdownMenu）。
 *
 * 和 ui/ContextMenu 的区别：那个包一个触发区、由浏览器的 contextmenu 事件打开；这里不包触发区，
 * 适合「一个网格共用一个菜单、打开时才知道目标」的场合。
 */
import { computed, markRaw, toRaw, type Component } from "vue";
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot } from "reka-ui";
import { MenuItem as KbMenuItem, MenuSeparator, MenuSub } from "@/components/ui";
import { useLayerZIndex, keepOpenOnToast } from "@/components/ui/layer";

export interface MenuItem {
  key?: string; // 菜单项的唯一标识，用于隐藏控制
  type?: "item" | "divider";
  label?: string;
  icon?: Component;
  command?: string;
  visible?: boolean | (() => boolean);
  disabled?: boolean;
  /** "danger"：危险色；"warning"：警示色 */
  className?: string;
  suffix?: string;
  children?: MenuItem[];
  onClick?: () => void;
}

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  items?: MenuItem[]; // 可选的菜单项列表，如果提供则渲染 items，否则使用 slot
  /** 调用方的弹层栈层级；与新浮层的层级号取大者 */
  zIndex?: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  command: [command: string];
}>();

const open = computed(() => props.visible);
const counterZ = useLayerZIndex(open);
const layerZIndex = computed(() => Math.max(props.zIndex ?? 0, counterZ.value));

/** 虚拟锚点：一个落在 position 上的零尺寸矩形 */
const anchor = computed(() => {
  const { x, y } = props.position;
  return {
    getBoundingClientRect: () => ({ x, y, left: x, right: x, top: y, bottom: y, width: 0, height: 0 }) as DOMRect,
  };
});

function onOpenChange(value: boolean) {
  if (!value && props.visible) emit("close");
}

function onCloseAutoFocus(e: Event) {
  // 没有触发器可还焦点；菜单项打开的对话框自己处理焦点
  e.preventDefault();
}

/** Resolve icon for <component :is>; avoid reactive proxy when items come from reactive props. */
function getIcon(item: MenuItem): Component | undefined {
  const icon = item.icon;
  if (!icon) return undefined;
  return markRaw(toRaw(icon));
}

function toneClass(item: MenuItem): string {
  return item.className === "warning" ? "text-kb-warning [&_svg]:!text-kb-warning" : "";
}

const getItemVisible = (item: MenuItem) => {
  // 当 item 声明了 children，但 children 为空时，不渲染该 item（例如“更多”菜单没有任何子项）
  if (item.children && item.children.length === 0) return false;
  if (item.visible === undefined) return true;
  if (typeof item.visible === "boolean") return item.visible;
  try {
    return item.visible();
  } catch {
    return false;
  }
};

const handleItemClick = (item: MenuItem) => {
  if (item.disabled) return;
  if (item.onClick) item.onClick();
  if (item.command) emit("command", item.command);
  emit("close");
};
</script>
