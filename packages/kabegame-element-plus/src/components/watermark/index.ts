import { withInstall } from '@kabegame/element-plus/utils'
import Watermark from './src/watermark.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElWatermark: SFCWithInstall<typeof Watermark> =
  withInstall(Watermark)
export default ElWatermark

export * from './src/watermark.js'
