import { withInstall } from '@kabegame/element-plus/utils'
import Divider from './src/divider.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElDivider: SFCWithInstall<typeof Divider> = withInstall(Divider)
export default ElDivider

export * from './src/divider.js'
