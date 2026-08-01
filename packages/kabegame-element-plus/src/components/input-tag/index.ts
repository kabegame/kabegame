import { withInstall } from '@kabegame/element-plus/utils'
import InputTag from './src/input-tag.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElInputTag: SFCWithInstall<typeof InputTag> = withInstall(InputTag)
export default ElInputTag

export * from './src/input-tag.js'
export type { InputTagInstance } from './src/instance.js'
