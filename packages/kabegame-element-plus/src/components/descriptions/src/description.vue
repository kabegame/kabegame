<template>
  <div :class="descriptionKls">
    <div
      v-if="title || extra || $slots.title || $slots.extra"
      :class="ns.e('header')"
    >
      <div :class="ns.e('title')">
        <slot name="title">{{ title }}</slot>
      </div>
      <div :class="ns.e('extra')">
        <slot name="extra">{{ extra }}</slot>
      </div>
    </div>

    <div :class="ns.e('body')">
      <table :class="[ns.e('table'), ns.is('bordered', border)]">
        <tbody>
          <template v-for="(row, _index) in getRows()" :key="_index">
            <el-descriptions-row :row="row" />
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, provide, useSlots } from 'vue'
import { flattedChildren } from '@kabegame/element-plus/utils'
import { useNamespace } from '@kabegame/element-plus/hooks'
import { useFormSize } from '@kabegame/element-plus/components/form'
import ElDescriptionsRow from './descriptions-row.vue'
import { descriptionsKey } from './token.ts'
import { COMPONENT_NAME } from './constants.ts'

import type { DescriptionProps } from './description.ts'
import type { IDescriptionsInject } from './descriptions.type.ts'
import type { DescriptionItemVNode } from './description-item.ts'

defineOptions({
  name: 'ElDescriptions',
})

const props = withDefaults(defineProps<DescriptionProps>(), {
  column: 3,
  direction: 'horizontal',
  title: '',
  extra: '',
})

const ns = useNamespace('descriptions')

const descriptionsSize = useFormSize()

const slots = useSlots()

provide(descriptionsKey, props as IDescriptionsInject)

const descriptionKls = computed(() => [ns.b(), ns.m(descriptionsSize.value)])

const filledNode = (
  node: DescriptionItemVNode,
  span: number,
  count: number,
  isLast = false
) => {
  if (!node.props) {
    node.props = {}
  }
  if (span > count) {
    node.props.span = count
  }
  if (isLast) {
    // set the last span
    node.props.span = span
  }
  return node
}

const getRows = () => {
  if (!slots.default) return []

  const children = flattedChildren(slots.default()).filter(
    (node): node is DescriptionItemVNode =>
      (node as any)?.type?.name === COMPONENT_NAME
  )
  const rows: DescriptionItemVNode[][] = []
  let temp: DescriptionItemVNode[] = []
  let count = props.column
  let totalSpan = 0 // all spans number of item
  const rowspanTemp: number[] = [] // the number of row spans

  children.forEach((node, index) => {
    const span = node.props?.span || 1
    const rowspan = node.props?.rowspan || 1
    const rowNo = rows.length
    rowspanTemp[rowNo] ||= 0

    if (rowspan > 1) {
      for (let i = 1; i < rowspan; i++) {
        rowspanTemp[rowNo + i] ||= 0
        rowspanTemp[rowNo + i]++
        totalSpan++
      }
    }
    if (rowspanTemp[rowNo] > 0) {
      count -= rowspanTemp[rowNo]
      rowspanTemp[rowNo] = 0
    }
    if (index < children.length - 1) {
      totalSpan += span > count ? count : span
    }

    if (index === children.length - 1) {
      // calculate the last item span
      const lastSpan = props.column - (totalSpan % props.column)
      temp.push(filledNode(node, lastSpan, count, true))
      rows.push(temp)
      return
    }

    if (span < count) {
      count -= span
      temp.push(node)
    } else {
      temp.push(filledNode(node, span, count))
      rows.push(temp)
      count = props.column
      temp = []
    }
  })

  return rows
}
</script>
