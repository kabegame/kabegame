import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Steps from './src/steps.vue'
import Step from './src/item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElSteps: SFCWithInstall<typeof Steps> & {
  Step: typeof Step
} = withInstall(Steps, {
  Step,
})
export default ElSteps
export const ElStep: SFCWithInstall<typeof Step> = withNoopInstall(Step)

export * from './src/item.js'
export * from './src/steps.js'
export * from './src/tokens.js'
