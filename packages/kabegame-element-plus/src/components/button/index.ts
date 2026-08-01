import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Button from './src/button.vue'
import ButtonGroup from './src/button-group.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElButton: SFCWithInstall<typeof Button> & {
  ButtonGroup: typeof ButtonGroup
} = withInstall(Button, {
  ButtonGroup,
})
export const ElButtonGroup: SFCWithInstall<typeof ButtonGroup> =
  withNoopInstall(ButtonGroup)
export default ElButton

export * from './src/button.js'
export * from './src/constants.js'
export type { ButtonInstance, ButtonGroupInstance } from './src/instance.js'
