import { withInstall, withInstallDirective } from '@kabegame/element-plus/utils'
import Popover from './src/popover.vue'
import PopoverDirective, { VPopover } from './src/directive.js'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElPopoverDirective: SFCWithInstall<typeof PopoverDirective> =
  withInstallDirective(PopoverDirective, VPopover)

export const ElPopover: SFCWithInstall<typeof Popover> & {
  directive: typeof ElPopoverDirective
} = withInstall(Popover, {
  directive: ElPopoverDirective,
})
export default ElPopover

export * from './src/popover.js'
