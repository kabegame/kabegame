import { withInstall } from '@kabegame/element-plus/utils'
import InputNumber from './src/input-number.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElInputNumber: SFCWithInstall<typeof InputNumber> =
  withInstall(InputNumber)

export default ElInputNumber
export * from './src/input-number.js'
