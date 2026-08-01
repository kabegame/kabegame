import { withInstall } from '@kabegame/element-plus/utils'
import Input from './src/input.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElInput: SFCWithInstall<typeof Input> = withInstall(Input)
export default ElInput

export * from './src/input.js'
export type { InputInstance } from './src/instance.js'
