import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Carousel from './src/carousel.vue'
import CarouselItem from './src/carousel-item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCarousel: SFCWithInstall<typeof Carousel> & {
  CarouselItem: typeof CarouselItem
} = withInstall(Carousel, {
  CarouselItem,
})

export default ElCarousel

export const ElCarouselItem: SFCWithInstall<typeof CarouselItem> =
  withNoopInstall(CarouselItem)

export * from './src/carousel.js'
export * from './src/carousel-item.js'
export * from './src/constants.js'

export type { CarouselInstance, CarouselItemInstance } from './src/instance.js'
