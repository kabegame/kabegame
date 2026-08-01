import { withInstall } from '@kabegame/element-plus/utils'
import KbTabComp from './src/kb-tab.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

/**
 * kabegame 自己的分段式胶囊 tab，取代上游的 ElTabs/ElTabPane。
 * 只管 tab 头本身，内容由调用方按 v-model 自行 v-if/v-show 切换 ——
 * 上游那套 tab-pane 插槽会把内容的生命周期绑死在 tab 组件上，
 * 我们几处调用要么内容很重要懒加载，要么根本不是「面板」语义。
 */
export const KbTab: SFCWithInstall<typeof KbTabComp> = withInstall(KbTabComp)
export default KbTab

export * from './src/kb-tab'
