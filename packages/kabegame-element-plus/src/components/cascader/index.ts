import { withInstall } from '@kabegame/element-plus/utils'
import Cascader from './src/cascader.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCascader: SFCWithInstall<typeof Cascader> = withInstall(Cascader)

export default ElCascader

export * from './src/cascader.js'
export * from './src/instances.js'
