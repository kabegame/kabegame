import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Tour from './src/tour.vue'
import TourStep from './src/step.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElTour: SFCWithInstall<typeof Tour> & {
  TourStep: typeof TourStep
} = withInstall(Tour, {
  TourStep,
})
export const ElTourStep: SFCWithInstall<typeof TourStep> =
  withNoopInstall(TourStep)
export default ElTour

export * from './src/tour.js'
export * from './src/step.js'
export * from './src/content.js'
export type { TourMask, TourGap, TourBtnProps } from './src/types.js'
