import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Dropdown from './src/dropdown.vue'
import DropdownItem from './src/dropdown-item.vue'
import DropdownMenu from './src/dropdown-menu.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElDropdown: SFCWithInstall<typeof Dropdown> & {
  DropdownItem: typeof DropdownItem
  DropdownMenu: typeof DropdownMenu
} = withInstall(Dropdown, {
  DropdownItem,
  DropdownMenu,
})
export default ElDropdown
export const ElDropdownItem: SFCWithInstall<typeof DropdownItem> =
  withNoopInstall(DropdownItem)
export const ElDropdownMenu: SFCWithInstall<typeof DropdownMenu> =
  withNoopInstall(DropdownMenu)
export * from './src/dropdown.js'
export * from './src/instance.js'
export * from './src/tokens.js'
