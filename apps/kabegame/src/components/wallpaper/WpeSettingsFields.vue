<template>
  <template v-for="key in fields" :key="key">
    <!-- 设置页：每项一行 SettingRow（标签 + 说明 + 控件） -->
    <SettingRow v-if="variant === 'settings'" :label="labelOf(key)" :description="descriptionOf(key)">
      <WpeSettingControl
        :setting-key="key"
        :values="values"
        :follow-available="followAvailable"
        :variant="variant"
        :disabled="isDisabled(key)"
        @update="(k, v) => emit('update', k, v)"
      />
    </SettingRow>
    <!-- 预览侧栏：同作者属性面板的条目样式；开关同一行，其余放在标签下方（侧栏窄） -->
    <div
      v-else
      class="flex gap-2 rounded-kb-sm px-2.5 py-2 hover:bg-kb-hover"
      :class="isInline(key) ? 'items-center' : 'flex-col'"
      :data-testid="`wpe-setting-${key}`"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <span class="min-w-0 flex-1 text-[13px] leading-[1.5] text-kb-fg">{{ labelOf(key) }}</span>
        <Tooltip v-if="modified?.[key]" :content="t('gallery.wpePropsReset')">
          <Button
            variant="ghost"
            size="icon-xs"
            class="flex-none"
            :aria-label="t('gallery.wpePropsReset')"
            @click="emit('reset', key)"
          >
            <RotateCcw />
          </Button>
        </Tooltip>
      </div>
      <div :class="isInline(key) ? 'flex flex-none items-center' : 'min-w-0'">
        <WpeSettingControl
          :setting-key="key"
          :values="values"
          :follow-available="followAvailable"
          :variant="variant"
          :disabled="isDisabled(key)"
          @update="(k, v) => emit('update', k, v)"
        />
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { RotateCcw } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import SettingRow from "@/components/settings/SettingRow.vue";
import { WPE_SETTING_LABEL_KEYS, type WpeSettingKey, type WpeSettingValues } from "@/utils/wpeSettings";
import WpeSettingControl from "./WpeSettingControl.vue";

/**
 * WPE 设置字段组：暂停、音量、视频倍速、媒体集成、场景后处理 / 反射 / 阴影。纯视图，不读写任何存储：
 * 调用方给要显示的字段（`utils/wpeSettings.ts` 的 `wpeSettingFieldsFor`）与当前值，改动经 `update` 报出去，
 * 由调用方写进自己的数据源——设置页写全局「壁纸设置」，预览写这张壁纸的「预览设置」（暂停由预览弹窗特殊处理成内存状态）。
 */
const props = withDefaults(
  defineProps<{
    fields: readonly WpeSettingKey[];
    values: WpeSettingValues;
    followAvailable: boolean;
    variant?: "settings" | "panel";
    /** 预览侧栏用：改过的字段显示单项重置 */
    modified?: Partial<Record<WpeSettingKey, boolean>>;
    disabled?: boolean;
    disabledKeys?: readonly WpeSettingKey[];
  }>(),
  { variant: "panel", modified: undefined, disabled: false, disabledKeys: () => [] },
);
const emit = defineEmits<{
  update: [key: WpeSettingKey, value: boolean | number | string];
  reset: [key: WpeSettingKey];
}>();

const { t } = useI18n();

function labelOf(key: WpeSettingKey): string {
  return t(WPE_SETTING_LABEL_KEYS[key]);
}
function descriptionOf(key: WpeSettingKey): string {
  return t(`${WPE_SETTING_LABEL_KEYS[key]}Desc`);
}
function isInline(key: WpeSettingKey): boolean {
  return key === "paused" || key === "mediaIntegration";
}
function isDisabled(key: WpeSettingKey): boolean {
  return props.disabled || props.disabledKeys.includes(key);
}
</script>
