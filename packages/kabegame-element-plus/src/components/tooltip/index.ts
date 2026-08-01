import { withInstall } from '@kabegame/element-plus/utils'
import Tooltip from './src/tooltip.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElTooltip: SFCWithInstall<typeof Tooltip> = withInstall(Tooltip)
export * from './src/tooltip.js'
export * from './src/trigger.js'
export * from './src/content.js'
export * from './src/constants.js'
export default ElTooltip
