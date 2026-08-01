import { withInstall } from '@kabegame/element-plus/utils'
import Affix from './src/affix.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElAffix: SFCWithInstall<typeof Affix> = withInstall(Affix)
export default ElAffix

export * from './src/affix.js'
