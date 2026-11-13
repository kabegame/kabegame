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
    // 新界面的设计 token（值在 apps/kabegame/src/styles/tokens.css）：text-kb-fg、bg-kb-hover、
    // border-kb-line、rounded-kb-md、shadow-kb-pop……颜色是 CSS 变量，透明度修饰（/50）不生效。
    colors: {
      kb: {
        fg: { DEFAULT: 'var(--kb-fg)', muted: 'var(--kb-fg-muted)', subtle: 'var(--kb-fg-subtle)' },
        surface: { DEFAULT: 'var(--kb-surface)', raised: 'var(--kb-surface-raised)' },
        bg: { DEFAULT: 'var(--kb-bg)', sidebar: 'var(--kb-bg-sidebar)' },
        glass: { DEFAULT: 'var(--kb-glass)', strong: 'var(--kb-glass-strong)' },
        fill: {
          DEFAULT: 'var(--kb-fill)',
          light: 'var(--kb-fill-light)',
          lighter: 'var(--kb-fill-lighter)',
          dark: 'var(--kb-fill-dark)',
        },
        hover: 'var(--kb-hover)',
        pressed: 'var(--kb-pressed)',
        line: { DEFAULT: 'var(--kb-line)', strong: 'var(--kb-line-strong)' },
        primary: { DEFAULT: 'var(--kb-primary)', hover: 'var(--kb-primary-hover)', fg: 'var(--kb-primary-fg)' },
        accent: 'var(--kb-accent)',
        danger: 'var(--kb-danger)',
        success: 'var(--kb-success)',
        warning: 'var(--kb-warning)',
        ring: 'var(--kb-ring)',
      },
    },
    borderRadius: {
      'kb-sm': 'var(--kb-radius-sm)',
      'kb-md': 'var(--kb-radius-md)',
      'kb-lg': 'var(--kb-radius-lg)',
    },
    boxShadow: {
      'kb-sm': 'var(--kb-shadow-sm)',
      'kb-md': 'var(--kb-shadow-md)',
      'kb-lg': 'var(--kb-shadow-lg)',
      'kb-pop': 'var(--kb-shadow-pop)',
    },
  },
  shortcuts: [
    // 仅紧凑布局可见（< md）/ 仅宽屏可见（>= md）。与 useUiStore().isCompact 视觉对齐。
    ['compact-only', 'md:hidden'],
    ['wide-only', 'hidden md:block'],
    // ImageContent 媒体层：绝对定位铺满容器并 contain 缩放（App.vue 背景形态以 .ic-img 选择器覆写）
    ['ic-img', 'absolute top-0 left-0 w-full h-full object-contain will-change-[contents,opacity] [-webkit-tap-highlight-color:transparent]'],
    // 插件详情工作台（PluginDetailContent 1a 三栏）复用的四组合，避免在模板里重复写长串
    ['kb-chip', 'inline-flex items-center h-5 px-1.75 rounded-8px text-12px font-500'],
    ['kb-card', 'rounded-12px bg-white border border-solid border-[var(--anime-border)]'],
    ['kb-grad', 'bg-gradient-to-r from-[var(--anime-primary)] to-[var(--anime-secondary)]'],
    // 全局 body 是 user-select:none(桌面 app 观感);需要让用户能划词复制的地方
    // (路径、日志、原生元数据、亀ちゃん历史)统一挂这个类表达豁免，别各写各的 CSS。
    ['kb-selectable', 'select-text cursor-text [-webkit-touch-callout:default]'],
    // 新界面组件（apps/kabegame/src/components/ui/）共用的几组外观：菜单面板（下拉 / 右键 / 子菜单 /
    // 选择框 / 组合框的弹出层）、菜单项、输入类控件的外框（输入框、选择框、数字框、组合框）。
    // 层级不在这里：浮层的 z-index 由 compat.ts 的 useLayerZIndex 在打开时给（混用期与 EP 同一计数器）。
    [
      'kb-menu-panel',
      'box-border min-w-[184px] overflow-hidden rounded-kb-lg bg-kb-surface-raised p-1 text-kb-fg shadow-kb-pop outline-none origin-[var(--reka-popper-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]',
    ],
    [
      'kb-menu-item',
      'relative box-border flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-kb-md px-2.5 text-[13px] text-kb-fg outline-none transition-colors duration-100 data-[highlighted]:bg-kb-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-kb-fg-muted',
    ],
    [
      'kb-control',
      'box-border flex w-full items-center rounded-kb-md border border-solid border-kb-line-strong bg-kb-surface-raised text-[13px] text-kb-fg transition-[border-color,box-shadow] duration-150 hover:border-kb-fg-subtle focus-within:border-kb-fg-muted focus-within:ring-2 focus-within:ring-kb-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[invalid]:border-kb-danger',
    ],
  ],
  rules: [
    // Drawer 最大宽度规则（所有平台统一使用 500px，使用 !important 确保优先级）
    ['drawer-max-width', { 'max-width': '500px !important' }],
  ],
})
