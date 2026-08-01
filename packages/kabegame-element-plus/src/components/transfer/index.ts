import { withInstall } from '@kabegame/element-plus/utils'
import Transfer from './src/transfer.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElTransfer: SFCWithInstall<typeof Transfer> = withInstall(Transfer)
export default ElTransfer

export * from './src/transfer.js'
