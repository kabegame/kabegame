import { withInstall } from '@kabegame/element-plus/utils'
import Card from './src/card.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCard: SFCWithInstall<typeof Card> = withInstall(Card)
export default ElCard

export * from './src/card.js'
export type { CardInstance } from './src/instance.js'
