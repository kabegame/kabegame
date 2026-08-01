import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Form from './src/form.vue'
import FormItem from './src/form-item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElForm: SFCWithInstall<typeof Form> & {
  FormItem: typeof FormItem
} = withInstall(Form, {
  FormItem,
})
export default ElForm
export const ElFormItem: SFCWithInstall<typeof FormItem> =
  withNoopInstall(FormItem)

export * from './src/form.js'
export * from './src/form-item.js'
export * from './src/types.js'
export * from './src/constants.js'
export * from './src/hooks/index.js'

export type FormInstance = InstanceType<typeof Form> & unknown
export type FormItemInstance = InstanceType<typeof FormItem> & unknown
