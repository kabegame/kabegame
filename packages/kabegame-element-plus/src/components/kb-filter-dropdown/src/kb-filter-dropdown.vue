<template>
  <el-tooltip
    :visible="visible"
    trigger="click"
    effect="light"
    placement="bottom-start"
    :fallback-placements="['bottom-start', 'top-start', 'bottom-end', 'top-end']"
    :disabled="disabled"
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
        :class="ns.e('panel')"
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
                    ...optionClasses(index + 1, modelValue === option.value),
                    ns.is('zero', option.count === 0),
                  ]"
                  :aria-selected="modelValue === option.value"
                  :data-kb-filter-index="index + 1"
                  @mouseenter="highlightedIndex = index + 1"
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
        ns.is('selected', hasSelection),
      ]"
      :aria-disabled="disabled"
    >
      <slot name="trigger" :open="visible" :selected="selectedOption">
        <span
          :class="ns.e('chip')"
          role="button"
          :tabindex="disabled ? -1 : 0"
          :aria-expanded="visible"
        >
          <span v-if="$slots.icon" :class="ns.e('chip-icon')">
            <slot name="icon" />
          </span>
          <span :class="ns.e('chip-label')">{{ chipLabel }}</span>
          <span :class="ns.e('chip-value')">{{ selectedLabel }}</span>
          <button
            v-if="hasSelection"
            type="button"
            :class="ns.e('clear')"
            :aria-label="anyLabel"
            :disabled="disabled"
            @keydown.stop
            @click.stop="clearSelection"
          >
            <el-icon><Close /></el-icon>
          </button>
          <el-icon v-else :class="ns.e('arrow')"><ArrowDown /></el-icon>
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
  searchable: false,
  loading: false,
  negated: false,
  disabled: false,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string | null): void
  (event: 'open'): void
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
const selectedLabel = computed(() =>
  hasSelection.value
    ? props.selectedLabel ?? selectedOption.value?.label ?? props.modelValue
    : props.anyLabel
)
const filteredOptions = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (!normalizedQuery) return props.options

  return props.options.filter((option) =>
    option.label.toLocaleLowerCase().includes(normalizedQuery)
  )
})
const navigableValues = computed<(string | null)[]>(() => [
  null,
  ...filteredOptions.value.map((option) => option.value),
])

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
  }
}

function close() {
  visible.value = false
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
