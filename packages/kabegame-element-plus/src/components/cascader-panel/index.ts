import { withInstall } from '@kabegame/element-plus/utils'
import CascaderPanel from './src/index.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCascaderPanel: SFCWithInstall<typeof CascaderPanel> =
  withInstall(CascaderPanel)

export default ElCascaderPanel
export * from './src/types.js'
export * from './src/config.js'
export * from './src/instance.js'
