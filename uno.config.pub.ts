import { presetWind3, defineConfig } from 'unocss'

export default defineConfig({
  presets: [
    presetWind3(),
  ],
  rules: [
    // Drawer 最大宽度规则（所有平台统一使用 500px，使用 !important 确保优先级）
    ['drawer-max-width', { 'max-width': '500px !important' }],
  ],
})