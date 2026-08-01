import { withInstall } from '@kabegame/element-plus/utils'
import PageHeader from './src/page-header.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElPageHeader: SFCWithInstall<typeof PageHeader> =
  withInstall(PageHeader)
export default ElPageHeader

export * from './src/page-header.js'
