import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Radio from './src/radio.vue'
import RadioButton from './src/radio-button.vue'
import RadioGroup from './src/radio-group.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElRadio: SFCWithInstall<typeof Radio> & {
  RadioButton: typeof RadioButton
  RadioGroup: typeof RadioGroup
} = withInstall(Radio, {
  RadioButton,
  RadioGroup,
})
export default ElRadio
export const ElRadioGroup: SFCWithInstall<typeof RadioGroup> =
  withNoopInstall(RadioGroup)
export const ElRadioButton: SFCWithInstall<typeof RadioButton> =
  withNoopInstall(RadioButton)

export * from './src/radio.js'
export * from './src/radio-group.js'
export * from './src/radio-button.js'
export * from './src/constants.js'
