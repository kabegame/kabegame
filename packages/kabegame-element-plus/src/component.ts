import { ElAffix } from '@kabegame/element-plus/components/affix'
import { ElAlert } from '@kabegame/element-plus/components/alert'
import { ElAutocomplete } from '@kabegame/element-plus/components/autocomplete'
import { ElAvatar, ElAvatarGroup } from '@kabegame/element-plus/components/avatar'
import { ElBacktop } from '@kabegame/element-plus/components/backtop'
import { ElBadge } from '@kabegame/element-plus/components/badge'
import {
  ElBreadcrumb,
  ElBreadcrumbItem,
} from '@kabegame/element-plus/components/breadcrumb'
import { ElButton, ElButtonGroup } from '@kabegame/element-plus/components/button'
import { ElCalendar } from '@kabegame/element-plus/components/calendar'
import { ElCard } from '@kabegame/element-plus/components/card'
import { ElCarousel, ElCarouselItem } from '@kabegame/element-plus/components/carousel'
import { ElCascader } from '@kabegame/element-plus/components/cascader'
import { ElCascaderPanel } from '@kabegame/element-plus/components/cascader-panel'
import { ElCheckTag } from '@kabegame/element-plus/components/check-tag'
import {
  ElCheckbox,
  ElCheckboxButton,
  ElCheckboxGroup,
} from '@kabegame/element-plus/components/checkbox'
import { ElCol } from '@kabegame/element-plus/components/col'
import { ElCollapse, ElCollapseItem } from '@kabegame/element-plus/components/collapse'
import { ElCollapseTransition } from '@kabegame/element-plus/components/collapse-transition'
import { ElColorPickerPanel } from '@kabegame/element-plus/components/color-picker-panel'
import { ElColorPicker } from '@kabegame/element-plus/components/color-picker'
import { ElConfigProvider } from '@kabegame/element-plus/components/config-provider'
import {
  ElAside,
  ElContainer,
  ElFooter,
  ElHeader,
  ElMain,
} from '@kabegame/element-plus/components/container'
import { ElDatePicker } from '@kabegame/element-plus/components/date-picker'
import { ElDatePickerPanel } from '@kabegame/element-plus/components/date-picker-panel'
import {
  ElDescriptions,
  ElDescriptionsItem,
} from '@kabegame/element-plus/components/descriptions'
import { ElDialog } from '@kabegame/element-plus/components/dialog'
import { ElDivider } from '@kabegame/element-plus/components/divider'
import { ElDrawer } from '@kabegame/element-plus/components/drawer'
import {
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
} from '@kabegame/element-plus/components/dropdown'
import { ElEmpty } from '@kabegame/element-plus/components/empty'
import { ElForm, ElFormItem } from '@kabegame/element-plus/components/form'
import { ElIcon } from '@kabegame/element-plus/components/icon'
import { ElImage } from '@kabegame/element-plus/components/image'
import { ElImageViewer } from '@kabegame/element-plus/components/image-viewer'
import { ElInput } from '@kabegame/element-plus/components/input'
import { ElInputNumber } from '@kabegame/element-plus/components/input-number'
import { ElInputTag } from '@kabegame/element-plus/components/input-tag'
import { ElInputOtp } from '@kabegame/element-plus/components/input-otp'
import { ElLink } from '@kabegame/element-plus/components/link'
import {
  ElMenu,
  ElMenuItem,
  ElMenuItemGroup,
  ElSubMenu,
} from '@kabegame/element-plus/components/menu'
import { ElPageHeader } from '@kabegame/element-plus/components/page-header'
import { ElPagination } from '@kabegame/element-plus/components/pagination'
import { ElPopconfirm } from '@kabegame/element-plus/components/popconfirm'
import { ElPopover } from '@kabegame/element-plus/components/popover'
import { ElPopper } from '@kabegame/element-plus/components/popper'
import { ElProgress } from '@kabegame/element-plus/components/progress'
import {
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
} from '@kabegame/element-plus/components/radio'
import { ElRate } from '@kabegame/element-plus/components/rate'
import { ElResult } from '@kabegame/element-plus/components/result'
import { ElRow } from '@kabegame/element-plus/components/row'
import { ElScrollbar } from '@kabegame/element-plus/components/scrollbar'
import {
  ElOption,
  ElOptionGroup,
  ElSelect,
} from '@kabegame/element-plus/components/select'
import { ElSelectV2 } from '@kabegame/element-plus/components/select-v2'
import { ElSkeleton, ElSkeletonItem } from '@kabegame/element-plus/components/skeleton'
import { ElSlider } from '@kabegame/element-plus/components/slider'
import { ElSpace } from '@kabegame/element-plus/components/space'
import { ElStatistic } from '@kabegame/element-plus/components/statistic'
import { ElCountdown } from '@kabegame/element-plus/components/countdown'
import { ElStep, ElSteps } from '@kabegame/element-plus/components/steps'
import { ElSwitch } from '@kabegame/element-plus/components/switch'
import { ElTable, ElTableColumn } from '@kabegame/element-plus/components/table'
import { ElAutoResizer, ElTableV2 } from '@kabegame/element-plus/components/table-v2'
import { KbTab } from '@kabegame/element-plus/components/kb-tab'
import { ElTag } from '@kabegame/element-plus/components/tag'
import { ElText } from '@kabegame/element-plus/components/text'
import { ElTimePicker } from '@kabegame/element-plus/components/time-picker'
import { ElTimeSelect } from '@kabegame/element-plus/components/time-select'
import { ElTimeline, ElTimelineItem } from '@kabegame/element-plus/components/timeline'
import { ElTooltip } from '@kabegame/element-plus/components/tooltip'
import { ElTransfer } from '@kabegame/element-plus/components/transfer'
import { ElTree } from '@kabegame/element-plus/components/tree'
import { ElTreeSelect } from '@kabegame/element-plus/components/tree-select'
import { ElTreeV2 } from '@kabegame/element-plus/components/tree-v2'
import { ElUpload } from '@kabegame/element-plus/components/upload'
import { ElWatermark } from '@kabegame/element-plus/components/watermark'
import { ElTour, ElTourStep } from '@kabegame/element-plus/components/tour'
import { ElAnchor, ElAnchorLink } from '@kabegame/element-plus/components/anchor'
import { ElSegmented } from '@kabegame/element-plus/components/segmented'
import { ElMention } from '@kabegame/element-plus/components/mention'
import { ElSplitter, ElSplitterPanel } from '@kabegame/element-plus/components/splitter'

import type { Plugin } from 'vue'

export default [
  ElAffix,
  ElAlert,
  ElAutocomplete,
  ElAutoResizer,
  ElAvatar,
  ElAvatarGroup,
  ElBacktop,
  ElBadge,
  ElBreadcrumb,
  ElBreadcrumbItem,
  ElButton,
  ElButtonGroup,
  ElCalendar,
  ElCard,
  ElCarousel,
  ElCarouselItem,
  ElCascader,
  ElCascaderPanel,
  ElCheckTag,
  ElCheckbox,
  ElCheckboxButton,
  ElCheckboxGroup,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElCollapseTransition,
  ElColorPickerPanel,
  ElColorPicker,
  ElConfigProvider,
  ElContainer,
  ElAside,
  ElFooter,
  ElHeader,
  ElMain,
  ElDatePicker,
  ElDatePickerPanel,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElIcon,
  ElImage,
  ElImageViewer,
  ElInput,
  ElInputNumber,
  ElInputTag,
  ElInputOtp,
  ElLink,
  ElMenu,
  ElMenuItem,
  ElMenuItemGroup,
  ElSubMenu,
  ElPageHeader,
  ElPagination,
  ElPopconfirm,
  ElPopover,
  ElPopper,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElRate,
  ElResult,
  ElRow,
  ElScrollbar,
  ElSelect,
  ElOption,
  ElOptionGroup,
  ElSelectV2,
  ElSkeleton,
  ElSkeletonItem,
  ElSlider,
  ElSpace,
  ElStatistic,
  ElCountdown,
  ElSteps,
  ElStep,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTableV2,
  KbTab,
  ElTag,
  ElText,
  ElTimePicker,
  ElTimeSelect,
  ElTimeline,
  ElTimelineItem,
  ElTooltip,
  ElTransfer,
  ElTree,
  ElTreeSelect,
  ElTreeV2,
  ElUpload,
  ElWatermark,
  ElTour,
  ElTourStep,
  ElAnchor,
  ElAnchorLink,
  ElSegmented,
  ElMention,
  ElSplitter,
  ElSplitterPanel,
] as Plugin[]
