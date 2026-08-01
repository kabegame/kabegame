import { withInstall } from '@kabegame/element-plus/utils'
import Drawer from './src/drawer.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElDrawer: SFCWithInstall<typeof Drawer> = withInstall(Drawer)
export default ElDrawer

export * from './src/drawer.js'
