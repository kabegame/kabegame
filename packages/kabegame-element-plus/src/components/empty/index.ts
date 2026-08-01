import { withInstall } from '@kabegame/element-plus/utils'
import Empty from './src/empty.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElEmpty: SFCWithInstall<typeof Empty> = withInstall(Empty)
export default ElEmpty

export * from './src/empty.js'
export type { EmptyInstance } from './src/instance.js'
