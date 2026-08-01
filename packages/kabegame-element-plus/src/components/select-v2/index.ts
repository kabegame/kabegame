import { withInstall } from '@kabegame/element-plus/utils'
import Select from './src/select.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElSelectV2: SFCWithInstall<typeof Select> = withInstall(Select)
export default ElSelectV2

export * from './src/token.js'
