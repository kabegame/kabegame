import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Descriptions from './src/description.vue'
import DescriptionsItem from './src/description-item.js'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElDescriptions: SFCWithInstall<typeof Descriptions> & {
  DescriptionsItem: typeof DescriptionsItem
} = withInstall(Descriptions, {
  DescriptionsItem,
})

export const ElDescriptionsItem: SFCWithInstall<typeof DescriptionsItem> =
  withNoopInstall(DescriptionsItem)

export default ElDescriptions

export * from './src/description.js'
export * from './src/description-item.js'
