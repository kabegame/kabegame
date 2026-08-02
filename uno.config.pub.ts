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
    // 后台任务专用卡片：结构共用（外框/密度），底色与边框色由各卡片按任务类型着色（粉=整理、紫=同步、蓝=更新）。
    ['busy-task-card', 'relative rounded-[11px] border border-solid px-3 py-2.5 flex flex-col gap-2'],
    ['busy-task-cancel', 'appearance-none border-0 bg-transparent h-5 w-5 shrink-0 grid place-items-center rounded-full cursor-pointer text-[var(--anime-secondary-light)] transition-colors hover:text-[var(--anime-danger)]'],
    // 后台任务渐变进度条：轨道浅紫、填充粉→紫渐变，对齐设计稿
    ['busy-bar-track', 'h-[5px] rounded-[3px] bg-[rgba(167,139,250,0.22)] overflow-hidden'],
    ['busy-bar-fill', 'block h-full rounded-[3px] bg-gradient-to-r from-[#ff6b9d] to-[#a78bfa] transition-[width] duration-300'],
    // 插件详情工作台（PluginDetailContent 1a 三栏）复用的四组合，避免在模板里重复写长串
    ['kb-chip', 'inline-flex items-center h-5 px-1.75 rounded-8px text-12px font-500'],
    ['kb-card', 'rounded-12px bg-white border border-solid border-[var(--anime-border)]'],
    ['kb-grad', 'bg-gradient-to-r from-[var(--anime-primary)] to-[var(--anime-secondary)]'],
    // 全局 body 是 user-select:none(桌面 app 观感);需要让用户能划词复制的地方
    // (路径、日志、原生元数据、亀ちゃん历史)统一挂这个类表达豁免，别各写各的 CSS。
    ['kb-selectable', 'select-text cursor-text [-webkit-touch-callout:default]'],
  ],
  rules: [
    // Drawer 最大宽度规则（所有平台统一使用 500px，使用 !important 确保优先级）
    ['drawer-max-width', { 'max-width': '500px !important' }],
  ],
})
