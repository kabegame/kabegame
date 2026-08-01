import { withInstall } from '@kabegame/element-plus/utils'
import Slider from './src/slider.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElSlider: SFCWithInstall<typeof Slider> = withInstall(Slider)
export default ElSlider

export * from './src/slider.js'
export * from './src/constants.js'
