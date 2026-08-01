// This component is ported from https://github.com/radix-ui/primitives/tree/main/packages/react/roving-focus
// with some modification for Vue
import ElRovingFocusGroup from './src/roving-focus-group.vue'
import ElRovingFocusItem from './src/roving-focus-item.vue'

export { ElRovingFocusGroup, ElRovingFocusItem }

export * from './src/tokens.js'
export * from './src/utils.js'

export {
  ROVING_FOCUS_COLLECTION_INJECTION_KEY,
  ROVING_FOCUS_ITEM_COLLECTION_INJECTION_KEY,
} from './src/roving-focus-group.js'

export default ElRovingFocusGroup
