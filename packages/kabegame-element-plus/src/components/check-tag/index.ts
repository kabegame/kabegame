import { withInstall } from '@kabegame/element-plus/utils'
import CheckTag from './src/check-tag.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCheckTag: SFCWithInstall<typeof CheckTag> = withInstall(CheckTag)
export default ElCheckTag

export * from './src/check-tag.js'
