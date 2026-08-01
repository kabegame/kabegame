import { withInstall } from '@kabegame/element-plus/utils'
import Scrollbar from './src/scrollbar.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElScrollbar: SFCWithInstall<typeof Scrollbar> =
  withInstall(Scrollbar)
export default ElScrollbar

export * from './src/util.js'
export * from './src/scrollbar.js'
export * from './src/thumb.js'
export * from './src/constants.js'
