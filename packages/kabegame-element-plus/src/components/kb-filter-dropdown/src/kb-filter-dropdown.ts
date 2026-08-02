export interface KbFilterDropdownOption {
  label: string
  value: string
  /** null/undefined 表示不显示；0 是有效计数。 */
  count?: number
}

export interface KbFilterDropdownProps {
  modelValue: string | null
  options: KbFilterDropdownOption[]
  /** 内置 chip 的维度名称。 */
  chipLabel: string
  /**
   * 选中值的展示文案覆盖。options 惰性加载时 chip 无法从 options 反查 label,
   * 由调用侧直接给出;缺省回退 options 匹配项 label → modelValue 原文。
   */
  selectedLabel?: string
  anyLabel: string
  anyCount?: number
  searchable?: boolean
  searchPlaceholder?: string
  emptyText?: string
  loading?: boolean
  negated?: boolean
  disabled?: boolean
}

export interface KbFilterDropdownTriggerSlotProps {
  open: boolean
  selected: KbFilterDropdownOption | null
}

export interface KbFilterDropdownPanelSlotProps {
  close: () => void
}
