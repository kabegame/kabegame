// 注册 vue 的全局 JSX 命名空间：本包的 .tsx（table-v2 / tabs / avatar）依赖
// JSX.IntrinsicElements，而本仓根 tsconfig 只设了 "jsx": "preserve"，不会自动引入。
/// <reference types="vue/jsx" />
import type { INSTALLED_KEY } from '@kabegame/element-plus/constants'
import type { ClassValue } from '@kabegame/element-plus/utils'
import type { Component, StyleValue } from 'vue'

// 上游此处还有 `declare global { const process }`；本仓根 devDependencies 已含 @types/node
// 提供 process 类型，重复声明会触发 "Cannot redeclare block-scoped variable"，故删去。
declare global {
  namespace JSX {
    interface IntrinsicAttributes {
      class?: ClassValue
      style?: StyleValue
    }
  }
}

declare module 'vue' {
  export interface App {
    [INSTALLED_KEY]?: boolean
  }

  export interface GlobalComponents {
    Component: (props: { is: Component | string }) => void
  }
}

export {}
