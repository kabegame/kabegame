import { withInstall } from '@kabegame/element-plus/utils'
import Text from './src/text.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElText: SFCWithInstall<typeof Text> = withInstall(Text)
export default ElText

export * from './src/text.js'
