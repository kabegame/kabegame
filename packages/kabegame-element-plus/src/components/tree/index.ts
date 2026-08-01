import { withInstall } from '@kabegame/element-plus/utils'
import Tree from './src/tree.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElTree: SFCWithInstall<typeof Tree> = withInstall(Tree)

export default ElTree

export * from './src/tree.type.js'
export * from './src/instance.js'
export * from './src/tokens.js'
export * from './src/tree.js'
