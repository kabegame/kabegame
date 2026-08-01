import { withInstall } from '@kabegame/element-plus/utils'
import Statistic from './src/statistic.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElStatistic: SFCWithInstall<typeof Statistic> =
  withInstall(Statistic)

export default ElStatistic
export * from './src/statistic.js'
