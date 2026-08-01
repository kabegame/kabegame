import { withInstall } from '@kabegame/element-plus/utils'
import Col from './src/col.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCol: SFCWithInstall<typeof Col> = withInstall(Col)
export default ElCol

export * from './src/col.js'
