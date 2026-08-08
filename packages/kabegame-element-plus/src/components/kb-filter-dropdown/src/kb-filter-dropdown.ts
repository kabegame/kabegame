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
   * chip 的原生 tooltip。`value` / `icon` 档把维度名(乃至取值)从 chip 上收走,
   * 全靠这里补回来,所以必须是**显式 prop**:根节点是 el-tooltip,fallthrough 的
   * `title` 会被它吞掉,落不到 chip 上。
   */
  title?: string
  /**
   * chip 的信息密度。图标已经表明是哪个维度,所以窄场景可以把维度名(乃至取值)
   * 收进 tooltip,由调用侧用 `title` 给出完整文案。
   *
   * - `full`(默认):图标 + 维度名 + 徽章 + 取值。高级查询条件行用这档——那里
   *   一行只有几颗 chip、也没有工具条那种横向压力。
   * - `value`:图标 + 徽章 + 取值,维度名进 tooltip。画廊单行工具条的默认档。
   * - `icon`:只留图标(清除徽章仍在),维度名与取值都进 tooltip。「精简显示」。
   */
  chipDisplay?: 'full' | 'value' | 'icon'
  /**
   * 点 chip 干什么。
   *
   * - `dropdown`(默认):开面板选值。
   * - `toggle`:不开面板,直接 emit `toggle` 让调用侧翻值。用于二值维度(升序/降序)
   *   ——为了从两个选项里挑一个而先弹一层面板,是白多一次点击。此档下 `options`
   *   不参与渲染,chip 上的取值文案由 `selectedLabel` 给。
   */
  chipAction?: 'dropdown' | 'toggle'
  /**
   * 选中值的展示文案覆盖。options 惰性加载时 chip 无法从 options 反查 label,
   * 由调用侧直接给出;缺省回退 options 匹配项 label → modelValue 原文。
   */
  selectedLabel?: string
  /** chip 内维度名与值之间的小胶囊(如搜索维度的「元数据」)。 */
  badge?: string
  /** 「任意」行/未选中态的文案。必选模式(clearable=false)下不需要。 */
  anyLabel?: string
  anyCount?: number
  /**
   * 值可否清空。默认 true(过滤维度语义:有「任意」行 + 选中后 chip 带清除徽章)。
   * 置 false 变成必选的单选器(排序、每页条数这类恒有值的场景):不渲染「任意」行、
   * 不出清除徽章、chip 也不进选中高亮态——恒有值时高亮不构成对比,只会满行发亮。
   */
  clearable?: boolean
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
