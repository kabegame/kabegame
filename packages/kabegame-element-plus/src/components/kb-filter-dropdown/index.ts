import { withInstall } from '@kabegame/element-plus/utils'
import KbFilterDropdownComp from './src/kb-filter-dropdown.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const KbFilterDropdown: SFCWithInstall<typeof KbFilterDropdownComp> =
  withInstall(KbFilterDropdownComp)
export default KbFilterDropdown

export * from './src/kb-filter-dropdown'
