/// <reference path="./env.d.ts" />
import installer from './defaults'

export * from '@kabegame/element-plus/components'
export * from '@kabegame/element-plus/constants'
export * from '@kabegame/element-plus/directives'
export * from '@kabegame/element-plus/hooks'
export * from './make-installer'

export const install = installer.install
export const version = installer.version
export default installer

export { default as dayjs } from 'dayjs'
