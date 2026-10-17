import type { Directive } from 'vue'

export type CornerBadgeValue =
  | number
  | boolean
  | null
  | undefined
  | { count?: number | null; dot?: boolean; max?: number }

const badgeText = (count: number, max = 99): string | null => {
  const normalizedCount = Math.floor(count)
  if (!Number.isFinite(normalizedCount) || normalizedCount <= 0) return null

  const normalizedMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 99
  return normalizedCount > normalizedMax
    ? `${normalizedMax}+`
    : String(normalizedCount)
}

const apply = (el: HTMLElement, value: CornerBadgeValue) => {
  let text: string | null = null
  let dot = false

  if (typeof value === 'number') {
    text = badgeText(value)
  } else if (value === true) {
    dot = true
  } else if (value && typeof value === 'object') {
    if (typeof value.count === 'number') text = badgeText(value.count, value.max)
    dot = text === null && value.dot === true
  }

  const show = text !== null || dot
  // 宿主有 :class 绑定时，Vue patch 会整体重写 className，把 mounted 加的类冲掉；
  // 每次都补回来（updated 在 patch 之后执行）
  el.classList.add('kb-corner-badge')
  el.classList.toggle('kb-corner-badge--show', show)
  el.classList.toggle('kb-corner-badge--dot', dot)
  if (show) el.setAttribute('data-kb-badge', text ?? '')
  else el.removeAttribute('data-kb-badge')
}

/**
 * 在任意不占用 `::after` 的宿主右上角显示数字或圆点角标，外观与 `el-badge` 一致
 * （样式见 theme-chalk `kb-corner-badge.scss`）。
 *
 * 用宿主伪元素绘制、不插入子节点，避免干扰 Vue 对宿主内容的 patch；
 * 放在组件库里是为了让 `KbTab` 等自有组件与业务侧共用同一份实现。
 */
export const vCornerBadge: Directive<HTMLElement, CornerBadgeValue> = {
  mounted(el, binding) {
    apply(el, binding.value)
  },
  updated(el, binding) {
    apply(el, binding.value)
  },
  unmounted(el) {
    el.classList.remove(
      'kb-corner-badge',
      'kb-corner-badge--dot',
      'kb-corner-badge--show'
    )
    el.removeAttribute('data-kb-badge')
  },
}

export default vCornerBadge
