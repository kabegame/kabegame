export interface KbFilterDropdownOption {
  label: string
  value: string
  /** null/undefined 表示不显示；0 是有效计数。 */
  count?: number
}

export interface KbFilterDropdownProps {
  modelValue: string | null
  /** 缺省 [](纯 #panel 插槽用法不需要选项列表)。 */
  options?: KbFilterDropdownOption[]
  /** 内置 chip 的维度名称。 */
  chipLabel: string
  /**
   * 选中值的展示文案覆盖。options 惰性加载时 chip 无法从 options 反查 label,
   * 由调用侧直接给出;缺省回退 options 匹配项 label → modelValue 原文。
   */
  selectedLabel?: string
  /** chip 内维度名与值之间的小胶囊(如搜索维度的「元数据」)。 */
  badge?: string
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
