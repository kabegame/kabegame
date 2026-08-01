import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Collapse from './src/collapse.vue'
import CollapseItem from './src/collapse-item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCollapse: SFCWithInstall<typeof Collapse> & {
  CollapseItem: typeof CollapseItem
} = withInstall(Collapse, {
  CollapseItem,
})
export default ElCollapse
export const ElCollapseItem: SFCWithInstall<typeof CollapseItem> =
  withNoopInstall(CollapseItem)

export * from './src/collapse.js'
export * from './src/collapse-item.js'
export * from './src/constants.js'
export type { CollapseInstance, CollapseItemInstance } from './src/instance.js'
