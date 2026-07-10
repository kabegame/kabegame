import { presetWind3, defineConfig } from 'unocss'

export default defineConfig({
  presets: [
    presetWind3(),
  ],
  theme: {
    // 显式声明响应式断点。md=768px 与 COMPACT_BREAKPOINT 对齐，用于紧凑/宽屏 CSS 切换。
    breakpoints: {
      sm: '480px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
    },
  },
  shortcuts: [
    // 仅紧凑布局可见（< md）/ 仅宽屏可见（>= md）。与 useUiStore().isCompact 视觉对齐。
    ['compact-only', 'md:hidden'],
    ['wide-only', 'hidden md:block'],
    // ImageContent 媒体层：绝对定位铺满容器并 contain 缩放（App.vue 背景形态以 .ic-img 选择器覆写）
    ['ic-img', 'absolute top-0 left-0 w-full h-full object-contain will-change-[contents,opacity] [-webkit-tap-highlight-color:transparent]'],
  ],
  rules: [
    // Drawer 最大宽度规则（所有平台统一使用 500px，使用 !important 确保优先级）
    ['drawer-max-width', { 'max-width': '500px !important' }],
  ],
})
