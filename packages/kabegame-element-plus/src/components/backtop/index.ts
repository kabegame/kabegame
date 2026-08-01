import { withInstall } from '@kabegame/element-plus/utils'
import Backtop from './src/backtop.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElBacktop: SFCWithInstall<typeof Backtop> = withInstall(Backtop)
export default ElBacktop

export * from './src/backtop.js'
export type { BacktopInstance } from './src/instance.js'
