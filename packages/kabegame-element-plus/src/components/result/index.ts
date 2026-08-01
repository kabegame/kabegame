import { withInstall } from '@kabegame/element-plus/utils'
import Result from './src/result.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElResult: SFCWithInstall<typeof Result> = withInstall(Result)

export default ElResult

export * from './src/result.js'
