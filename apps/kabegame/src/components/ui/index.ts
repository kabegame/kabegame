/**
 * 新界面组件（UI 重构）：行为与无障碍来自 reka-ui（无头原语），样式用 UnoCSS + tokens.css。
 * 逐步取代 @kabegame/element-plus；新写的界面优先从这里取。
 *
 * service / composable / util 这类 .ts 里只要提示或确认框时，直接从 "@/components/ui/toast"、
 * "@/components/ui/messageBox" 导入，不经过本文件（免得把全部组件拉进来）。
 */

// 按钮与小件
export { default as Button } from "./Button.vue";
export { default as CountBadge } from "./CountBadge.vue";
export { default as Spinner } from "./Spinner.vue";
export { default as Tag } from "./Tag.vue";
export { default as Tooltip } from "./Tooltip.vue";
export { default as HelpTip } from "./HelpTip.vue";

// 弹层
export { default as AlertDialog } from "./AlertDialog.vue";
export { default as Dialog } from "./Dialog.vue";
export { default as Popconfirm } from "./Popconfirm.vue";
export { default as Popover } from "./Popover.vue";
export { default as PopoverContent } from "./PopoverContent.vue";
export { default as Sheet } from "./Sheet.vue";
export { default as PickerSheet } from "./PickerSheet.vue";

// 菜单：下拉与右键共用菜单项（Reka 的菜单项不依赖根组件类型）
export { default as ContextMenu } from "./ContextMenu.vue";
export { default as DropdownMenu } from "./DropdownMenu.vue";
export { default as DropdownMenuContent } from "./DropdownMenuContent.vue";
export { default as DropdownMenuItem, default as MenuItem } from "./DropdownMenuItem.vue";
export { default as DropdownMenuSeparator, default as MenuSeparator } from "./DropdownMenuSeparator.vue";
export { default as MenuCheckboxItem } from "./MenuCheckboxItem.vue";
export { default as MenuLabel } from "./MenuLabel.vue";
export { default as MenuRadioGroup } from "./MenuRadioGroup.vue";
export { default as MenuSub } from "./MenuSub.vue";

// 表单
export { default as Autocomplete } from "./Autocomplete.vue";
export { default as Checkbox } from "./Checkbox.vue";
export { default as CheckboxGroup } from "./CheckboxGroup.vue";
export { default as ColorPickerPanel } from "./ColorPickerPanel.vue";
export { default as Combobox } from "./Combobox.vue";
export { default as DatePicker } from "./DatePicker.vue";
export { default as FilterDropdown, default as KbFilterDropdown } from "./FilterDropdown.vue";
export * from "./filterDropdown";
export { default as Field } from "./Field.vue";
export { useForm, type FormApi } from "./form";
export { default as Input } from "./Input.vue";
export { default as NumberField } from "./NumberField.vue";
export { default as RadioGroup } from "./RadioGroup.vue";
export { default as RangeSlider } from "./RangeSlider.vue";
export { default as SegmentedControl } from "./SegmentedControl.vue";
export { default as Select } from "./Select.vue";
export { default as Slider } from "./Slider.vue";
export { default as Switch } from "./Switch.vue";
export { default as Textarea } from "./Textarea.vue";
export { default as TimeField } from "./TimeField.vue";

// 展示
export { default as Alert } from "./Alert.vue";
export { default as DescriptionItem } from "./DescriptionItem.vue";
export { default as DescriptionList } from "./DescriptionList.vue";
export { default as Empty } from "./Empty.vue";
export { default as Lightbox } from "./Lightbox.vue";
export { default as Progress } from "./Progress.vue";
export { default as ScrollArea } from "./ScrollArea.vue";
export { default as SectionTitle } from "./SectionTitle.vue";
export { default as Separator } from "./Separator.vue";
export { default as Skeleton } from "./Skeleton.vue";
export { default as Tabs } from "./Tabs.vue";
export type { TabItem } from "./tabs";

// 反馈
export { default as Toaster } from "./Toaster.vue";
export { toast, type ToastOptions, type ToastType } from "./toast";
export { messageBox } from "./messageBox";
export { vLoading } from "./loading";

// 触发器 / 锚点没有样式，直接用 Reka 的：<DropdownMenuTrigger as-child><Button …/></DropdownMenuTrigger>
export { DialogTrigger, DropdownMenuTrigger, PopoverAnchor, PopoverTrigger } from "reka-ui";
