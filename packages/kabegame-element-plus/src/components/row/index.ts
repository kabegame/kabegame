import { withInstall } from '@kabegame/element-plus/utils'
import Row from './src/row.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElRow: SFCWithInstall<typeof Row> = withInstall(Row)
export default ElRow

export * from './src/row.js'
export * from './src/constants.js'
