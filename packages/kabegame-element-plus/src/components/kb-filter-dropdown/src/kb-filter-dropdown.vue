<template>
  <el-tooltip
    :visible="visible"
    trigger="click"
    effect="light"
    placement="bottom-start"
    :fallback-placements="['bottom-start', 'top-start', 'bottom-end', 'top-end']"
    :disabled="disabled || chipAction === 'toggle'"
    :show-arrow="false"
    :hide-after="0"
    :popper-class="ns.e('popper')"
    :teleported="true"
    pure
    @update:visible="handleVisibleChange"
    @show="focusPanel"
  >
    <template #content>
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

          <div :class="ns.e('body')">
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

                <button
                  v-for="(option, index) in filteredOptions"
                  :key="option.value"
                  type="button"
                  role="option"
                  :class="[
                    ...optionClasses(index + optionIndexOffset, modelValue === option.value),
                    ns.is('zero', option.count === 0),
                  ]"
                  :aria-selected="modelValue === option.value"
                  :data-kb-filter-index="index + optionIndexOffset"
                  @mouseenter="highlightedIndex = index + optionIndexOffset"
                  @click="selectValue(option.value)"
                >
                  <span :class="ns.e('option-label')">{{ option.label }}</span>
                  <span
                    v-if="option.count != null"
                    :class="[ns.e('count'), ns.is('negated', negated)]"
                  >
                    {{ formatCount(option.count) }}
                  </span>
                </button>
              </div>

              <div v-if="filteredOptions.length === 0" :class="ns.e('empty')">
                {{ emptyText }}
              </div>
            </template>
          </div>
        </template>
      </div>
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
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElIcon } from '@kabegame/element-plus/components/icon'
import { ElInput } from '@kabegame/element-plus/components/input'
import { ElTooltip } from '@kabegame/element-plus/components/tooltip'
import { useNamespace } from '@kabegame/element-plus/hooks'
import {
  ArrowDown,
  Close,
  Loading,
  Search,
} from '@kabegame/element-plus-icons'

import type { InputInstance } from '@kabegame/element-plus/components/input'
import type {
  KbFilterDropdownOption,
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
  icon(): unknown
  panel(props: KbFilterDropdownPanelSlotProps): unknown
}>()

const ns = useNamespace('kb-filter-dropdown')
const visible = ref(false)
const query = ref('')
const highlightedIndex = ref(0)
const panelRef = ref<HTMLElement>()
const searchInputRef = ref<InputInstance>()

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
  if (nextVisible) {
    query.value = ''
    syncHighlightToSelection()
    emit('open')
  } else {
    emit('close')
  }
}

/**
 * dropdown 档什么都不做——开合由 el-tooltip 的 click trigger 负责，这里再插一手
 * 会和它打架（一次点击开了又关）。toggle 档 tooltip 是 disabled 的，点击只到这里。
 */
function handleChipClick(event: Event) {
  if (props.disabled || props.chipAction !== 'toggle') return
  // 空格键要拦下来，否则翻值的同时页面还滚一屏。
  event.preventDefault()
  emit('toggle')
}

function close() {
  if (!visible.value) return
  visible.value = false
  emit('close')
}

function focusPanel() {
  nextTick(() => {
    if (slots.panel) panelRef.value?.focus()
    else if (props.searchable) searchInputRef.value?.focus()
    else panelRef.value?.focus()
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
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveHighlight(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveHighlight(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    selectValue(navigableValues.value[highlightedIndex.value] ?? null)
  }
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
