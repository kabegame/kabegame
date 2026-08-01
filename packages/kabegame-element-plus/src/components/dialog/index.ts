import { withInstall } from '@kabegame/element-plus/utils'
import Dialog from './src/dialog.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElDialog: SFCWithInstall<typeof Dialog> = withInstall(Dialog)
export default ElDialog

export * from './src/use-dialog.js'
export * from './src/dialog.js'
export * from './src/constants.js'
