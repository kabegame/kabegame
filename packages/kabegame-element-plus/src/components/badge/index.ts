import { withInstall } from '@kabegame/element-plus/utils'
import Badge from './src/badge.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElBadge: SFCWithInstall<typeof Badge> = withInstall(Badge)
export default ElBadge

export * from './src/badge.js'
export type { BadgeInstance } from './src/instance.js'
