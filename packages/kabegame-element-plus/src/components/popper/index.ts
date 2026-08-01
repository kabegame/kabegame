import { withInstall } from '@kabegame/element-plus/utils'
import Popper from './src/popper.vue'
import ElPopperArrow from './src/arrow.vue'
import ElPopperTrigger from './src/trigger.vue'
import ElPopperContent from './src/content.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export { ElPopperArrow, ElPopperTrigger, ElPopperContent }

export const ElPopper: SFCWithInstall<typeof Popper> = withInstall(Popper)
export default ElPopper

export * from './src/popper.js'
export * from './src/trigger.js'
export * from './src/content.js'
export * from './src/arrow.js'
export * from './src/constants.js'

export type { Placement, Options } from '@popperjs/core'
