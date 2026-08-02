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
