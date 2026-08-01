import { computed, inject, unref } from 'vue'
import { buildProp } from '@kabegame/element-plus/utils'
import { componentSizes } from '@kabegame/element-plus/constants'

import type { InjectionKey, Ref } from 'vue'
import type { ComponentSize } from '@kabegame/element-plus/constants'

export const useSizeProp = buildProp({
  type: String,
  values: componentSizes,
  required: false,
} as const)

export const useSizeProps = {
  size: useSizeProp,
}

export interface SizeContext {
  size: Ref<ComponentSize>
}

export const SIZE_INJECTION_KEY: InjectionKey<SizeContext> = Symbol('size')

export const useGlobalSize = () => {
  const injectedSize = inject(SIZE_INJECTION_KEY, {} as SizeContext)

  return computed<ComponentSize>(() => {
    return unref(injectedSize.size) || ''
  })
}
