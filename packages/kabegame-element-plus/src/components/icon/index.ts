import { withInstall } from '@kabegame/element-plus/utils'
import Icon from './src/icon.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElIcon: SFCWithInstall<typeof Icon> = withInstall(Icon)
export default ElIcon

export * from './src/icon.js'
