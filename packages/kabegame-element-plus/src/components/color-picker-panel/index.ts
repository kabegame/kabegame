import { withInstall } from '@kabegame/element-plus/utils'
import ColorPickerPanel from './src/color-picker-panel.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElColorPickerPanel: SFCWithInstall<typeof ColorPickerPanel> =
  withInstall(ColorPickerPanel)
export default ElColorPickerPanel

export * from './src/color-picker-panel.js'
