<template>
  <!-- dialog 档 tooltip 只当外壳：disabled 的 tooltip 收到 visible=true 会立刻回发
       update:visible=false(useModelToggle)，把刚打开的对话框关掉，所以恒给 false。 -->
  <el-tooltip
    :visible="isDialog ? false : visible"
    trigger="click"
    effect="light"
    placement="bottom-start"
    :fallback-placements="['bottom-start', 'top-start', 'bottom-end', 'top-end']"
    :disabled="disabled || chipAction === 'toggle' || isDialog"
    :show-arrow="false"
    :hide-after="0"
    :popper-class="ns.e('popper')"
    :teleported="true"
    :click-outside-ignore="clickOutsideIgnore"
    pure
    @update:visible="handleVisibleChange"
    @show="focusPanel"
  >
    <template #content>
      <ReusePanel v-if="!isDialog" />
    </template>

    <span
      :class="[
        ns.b(),
        ns.is('open', visible),
        ns.is('disabled', disabled),
        ns.is('selected', isActive),
      ]"
      :aria-disabled="disabled"
    >
      <!-- 面板只写一份：popover 档放进 tooltip 弹层，dialog 档放进对话框主体。
           DefineTemplate 自身不渲染，放在这里是为了让组件保持单根，attrs 照常透传。 -->
      <DefinePanel>
        <div
          ref="panelRef"
          :class="[ns.e('panel'), ns.is('custom', !!$slots.panel)]"
          :tabindex="$slots.panel || searchable ? -1 : 0"
          @keydown="handlePanelKeydown"
        >
          <slot v-if="$slots.panel" name="panel" :close="close" />
        
          <template v-else>
            <div v-if="searchable" :class="ns.e('search')">
              <el-input
                ref="searchInputRef"
                v-model="query"
                :placeholder="searchPlaceholder"
                clearable
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
            </div>

            <div :class="[ns.e('body'), ns.is('expanded', expandedValue !== null)]">
              <div v-if="loading" :class="ns.e('loading')">
                <el-icon :class="[ns.e('loading-icon'), ns.is('loading')]">
                  <Loading />
                </el-icon>
              </div>

              <template v-else>
                <div :class="ns.e('list')" role="listbox">
                  <button
                    v-if="clearable"
                    type="button"
                    role="option"
                    :class="optionClasses(0, modelValue === null)"
                    :aria-selected="modelValue === null"
                    data-kb-filter-index="0"
                    @mouseenter="highlightedIndex = 0"
                    @click="selectValue(null)"
                  >
                    <span :class="ns.e('option-label')">{{ anyLabel }}</span>
                    <span
                      v-if="anyCount != null"
                      :class="[ns.e('count'), ns.is('negated', negated)]"
                    >
                      {{ formatCount(anyCount) }}
                    </span>
                  </button>

                  <template
                    v-for="(option, index) in filteredOptions"
                    :key="option.value"
                  >
                    <button
                      type="button"
                      role="option"
                      :class="[
                        ...optionClasses(index + optionIndexOffset, modelValue === option.value),
                        ns.is('zero', option.count === 0),
                        ns.is('expandable', !!option.expandable),
                      ]"
                      :aria-selected="modelValue === option.value"
                      :aria-expanded="option.expandable ? expandedValue === option.value : undefined"
                      :data-kb-filter-index="index + optionIndexOffset"
                      @mouseenter="highlightedIndex = index + optionIndexOffset"
                      @click="activateOption(option)"
                    >
                      <span :class="ns.e('option-label')">{{ option.label }}</span>
                      <span
                        v-if="option.count != null"
                        :class="[ns.e('count'), ns.is('negated', negated)]"
                      >
                        {{ formatCount(option.count) }}
                      </span>
                      <el-icon
                        v-if="option.expandable"
                        :class="[
                          ns.e('option-arrow'),
                          ns.is('expanded', expandedValue === option.value),
                        ]"
                      >
                        <ArrowRight />
                      </el-icon>
                    </button>
                    <!-- 展开区：内容由调用侧给；close 让它在完成选择后关掉整个下拉 -->
                    <div
                      v-if="option.expandable && expandedValue === option.value"
                      :class="ns.e('option-panel')"
                      role="group"
                      :aria-label="option.label"
                    >
                      <slot name="option-panel" :option="option" :close="close" />
                    </div>
                  </template>
                </div>

                <div v-if="filteredOptions.length === 0" :class="ns.e('empty')">
                  {{ emptyText }}
                </div>
              </template>
            </div>
          </template>
        </div>
      </DefinePanel>
      <slot name="trigger" :open="visible" :selected="selectedOption">
        <span
          :class="[ns.e('chip'), ns.is('icon-only', chipDisplay === 'icon')]"
          role="button"
          :title="title"
          :tabindex="disabled ? -1 : 0"
          :aria-expanded="chipAction === 'toggle' ? undefined : visible"
          :aria-label="chipLabel"
          @click="handleChipClick"
          @keydown.enter="handleChipClick"
          @keydown.space="handleChipClick"
        >
          <span v-if="$slots.icon" :class="ns.e('chip-icon')">
            <slot name="icon" />
          </span>
          <template v-if="chipDisplay !== 'icon'">
            <span v-if="chipDisplay === 'full'" :class="ns.e('chip-label')">
              {{ chipLabel }}
            </span>
            <span v-if="badge" :class="ns.e('chip-badge')">{{ badge }}</span>
            <span :class="ns.e('chip-value')">{{ selectedLabel }}</span>
          </template>
          <button
            v-if="isActive"
            type="button"
            :class="ns.e('clear')"
            :aria-label="anyLabel"
            :disabled="disabled"
            @keydown.stop
            @click.stop="clearSelection"
          >
            <el-icon><Close /></el-icon>
          </button>
          <el-icon
            v-else-if="chipDisplay !== 'icon'"
            :class="ns.e('arrow')"
          >
            <ArrowDown />
          </el-icon>
        </span>
      </slot>
      <el-dialog
        v-if="isDialog"
        :model-value="visible"
        :title="chipLabel"
        :class="ns.e('dialog')"
        :body-class="ns.e('dialog-body')"
        width="min(92vw, 480px)"
        align-center
        append-to-body
        @update:model-value="handleVisibleChange"
        @opened="focusPanel"
      >
        <ReusePanel />
      </el-dialog>
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, unref, watch } from 'vue'
import { createReusableTemplate } from '@vueuse/core'
import { ElDialog } from '@kabegame/element-plus/components/dialog'
import { ElIcon } from '@kabegame/element-plus/components/icon'
import { ElInput } from '@kabegame/element-plus/components/input'
import { ElTooltip } from '@kabegame/element-plus/components/tooltip'
import { useNamespace } from '@kabegame/element-plus/hooks'
import {
  ArrowDown,
  ArrowRight,
  Close,
  Loading,
  Search,
} from '@kabegame/element-plus-icons'

import type { InputInstance } from '@kabegame/element-plus/components/input'
import { kbFilterDropdownContextKey } from './kb-filter-dropdown'
import type {
  KbFilterDropdownOption,
  KbFilterDropdownOptionPanelSlotProps,
  KbFilterDropdownPanelSlotProps,
  KbFilterDropdownProps,
  KbFilterDropdownTriggerSlotProps,
} from './kb-filter-dropdown'

defineOptions({ name: 'KbFilterDropdown' })

const props = withDefaults(defineProps<KbFilterDropdownProps>(), {
  options: () => [],
  chipDisplay: 'full',
  chipAction: 'dropdown',
  searchable: false,
  loading: false,
  negated: false,
  disabled: false,
  clearable: true,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string | null): void
  (event: 'open'): void
  (event: 'close'): void
  /** 仅 `chipAction="toggle"`：chip 被点/回车/空格，值怎么翻由调用侧决定。 */
  (event: 'toggle'): void
}>()

const slots = defineSlots<{
  trigger(props: KbFilterDropdownTriggerSlotProps): unknown
  icon?(): unknown
  panel?(props: KbFilterDropdownPanelSlotProps): unknown
  /** 可展开选项（`expandable`）的展开区，只在内置列表形态下渲染。 */
  'option-panel'?(props: KbFilterDropdownOptionPanelSlotProps): unknown
}>()

const ns = useNamespace('kb-filter-dropdown')
const [DefinePanel, ReusePanel] = createReusableTemplate()
const context = inject(kbFilterDropdownContextKey, {})
const isDialog = computed(() => unref(context.panelMode) === 'dialog')
const visible = ref(false)
const query = ref('')
const highlightedIndex = ref(0)
/** 当前展开的可展开选项；同一时间至多一个。 */
const expandedValue = ref<string | null>(null)
const panelRef = ref<HTMLElement>()
const searchInputRef = ref<InputInstance>()

/**
 * 开合的副作用统一挂在 visible 上，而不是散在各个改它的入口里：应用经
 * `bindVisible` 接管的返回栈(安卓返回键)会直接把它置 false，同样要发 close。
 * sync 保持与原先「改值即发事件」一致的时序。
 */
watch(
  visible,
  (open) => {
    if (open) {
      query.value = ''
      // 面板重新打开时收起
      expandedValue.value = null
      syncHighlightToSelection()
      emit('open')
    } else {
      emit('close')
    }
  },
  { flush: 'sync' }
)
context.bindVisible?.(visible)

const selectedOption = computed(
  () => props.options.find((option) => option.value === props.modelValue) ?? null
)
const hasSelection = computed(() => props.modelValue !== null)
/** 必选模式没有「已选/未选」之分：不进高亮态、不出清除徽章。 */
const isActive = computed(() => props.clearable && hasSelection.value)
const selectedLabel = computed(() =>
  hasSelection.value
    ? props.selectedLabel ?? selectedOption.value?.label ?? props.modelValue
    : props.anyLabel ?? ''
)
/** 必选模式没有「任意」行，选项索引不再整体后移一位。 */
const optionIndexOffset = computed(() => (props.clearable ? 1 : 0))
const filteredOptions = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (!normalizedQuery) return props.options

  return props.options.filter((option) =>
    option.label.toLocaleLowerCase().includes(normalizedQuery)
  )
})
const navigableValues = computed<(string | null)[]>(() =>
  props.clearable
    ? [null, ...filteredOptions.value.map((option) => option.value)]
    : filteredOptions.value.map((option) => option.value)
)

watch(
  [() => props.modelValue, filteredOptions],
  () => {
    if (visible.value) syncHighlightToSelection()
  },
  { flush: 'post' }
)

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  }
)

function handleVisibleChange(nextVisible: boolean) {
  if (props.disabled && nextVisible) return
  if (visible.value === nextVisible) return

  visible.value = nextVisible
}

/**
 * popover 档的 dropdown 什么都不做——开合由 el-tooltip 的 click trigger 负责，这里
 * 再插一手会和它打架（一次点击开了又关）。toggle 档与 dialog 档 tooltip 是 disabled
 * 的，点击只到这里。
 */
function handleChipClick(event: Event) {
  if (props.disabled) return
  if (props.chipAction === 'toggle') {
    // 空格键要拦下来，否则翻值的同时页面还滚一屏。
    event.preventDefault()
    emit('toggle')
  } else if (isDialog.value) {
    event.preventDefault()
    handleVisibleChange(true)
  }
}

function close() {
  visible.value = false
}

/**
 * 面板出现后把焦点收进来，键盘能直接导航、Escape 能关。
 * tooltip 的 `show` 是 after-enter 才发的，比 `open` 晚一个过渡：自定义面板若在
 * `open` 里自己聚焦了输入框，这里再 focus 容器就会把它顶掉（表现为「刚聚焦就失焦」），
 * 所以焦点已经在面板里就不抢。
 */
function focusPanel() {
  nextTick(() => {
    const panel = panelRef.value
    if (!panel) return
    if (panel.contains(document.activeElement)) return
    if (!slots.panel && props.searchable) searchInputRef.value?.focus()
    else panel.focus()
  })
}

function syncHighlightToSelection() {
  const index = navigableValues.value.findIndex(
    (value) => value === props.modelValue
  )
  highlightedIndex.value = index >= 0 ? index : 0
}

function moveHighlight(offset: number) {
  const length = navigableValues.value.length
  if (length === 0) return

  highlightedIndex.value =
    (highlightedIndex.value + offset + length) % length
  nextTick(() => {
    panelRef.value
      ?.querySelector<HTMLElement>(
        `[data-kb-filter-index="${highlightedIndex.value}"]`
      )
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function handlePanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }

  if (slots.panel || props.loading) return
  // 展开区里的按键（取色面板的输入框等）归面板内容自己，不当成列表导航
  if (isInsideOptionPanel(event.target)) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveHighlight(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveHighlight(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateHighlighted()
  } else if (event.key === ' ' && event.target === panelRef.value) {
    // 空格只在焦点落在面板容器上时接管：焦点在选项按钮上由原生 click 处理，在搜索框里是输入
    const option = highlightedOption()
    if (!option?.expandable) return
    event.preventDefault()
    toggleExpanded(option.value)
  }
}

function isInsideOptionPanel(target: EventTarget | null) {
  return (
    target instanceof Element && !!target.closest(`.${ns.e('option-panel')}`)
  )
}

/** 键盘高亮的那一行对应的选项；高亮在「任意」行或列表为空时为 null。 */
function highlightedOption(): KbFilterDropdownOption | null {
  const value = navigableValues.value[highlightedIndex.value] ?? null
  if (value === null) return null
  return filteredOptions.value.find((option) => option.value === value) ?? null
}

function activateHighlighted() {
  const option = highlightedOption()
  if (option) activateOption(option)
  else selectValue(navigableValues.value[highlightedIndex.value] ?? null)
}

/** 可展开的选项只切换展开，不选中、不关闭；其余选项选中并关闭。 */
function activateOption(option: KbFilterDropdownOption) {
  if (option.expandable) toggleExpanded(option.value)
  else selectValue(option.value)
}

function toggleExpanded(value: string) {
  expandedValue.value = expandedValue.value === value ? null : value
  if (expandedValue.value === null) return
  // 展开区可能落在滚动区之外，带进视野
  nextTick(() => {
    panelRef.value
      ?.querySelector<HTMLElement>(`.${ns.e('option-panel')}`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function selectValue(value: string | null) {
  emit('update:modelValue', value)
  close()
}

function clearSelection(event: MouseEvent) {
  event.preventDefault()
  emit('update:modelValue', null)
  close()
}

function formatCount(count: number) {
  const formatted = count.toLocaleString('en-US')
  return props.negated ? `−${formatted}` : formatted
}

function optionClasses(index: number, selected: boolean) {
  return [
    ns.e('option'),
    ns.is('selected', selected),
    ns.is('highlighted', highlightedIndex.value === index),
  ]
}
</script>
