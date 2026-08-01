import { withInstall } from '@kabegame/element-plus/utils'
import Alert from './src/alert.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElAlert: SFCWithInstall<typeof Alert> = withInstall(Alert)
export default ElAlert

export * from './src/alert.js'
export type { AlertInstance } from './src/instance.js'
