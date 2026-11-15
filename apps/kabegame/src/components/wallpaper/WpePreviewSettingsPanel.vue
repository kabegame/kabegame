<template>
  <!-- 侧栏里和下面的属性面板分高度：按内容高、最多占一半，超出在面板内滚动（属性面板 fill，拿剩下的） -->
  <CollapsibleDrawerPanel
    v-if="fields.length"
    class="wpe-preview-settings-panel max-h-1/2"
    storage-key="kabegame-image-detail-wpe-preview-settings-open"
    :toggle-aria-label="t('gallery.wpePreviewSettingsTitle')"
  >
    <template #title>{{ t("gallery.wpePreviewSettingsTitle") }}</template>
    <template #trailing>
      <Button v-if="anyModified" variant="ghost" size="sm" @click="resetAll">
        <RotateCcw />
        <span>{{ t("gallery.wpePreviewSettingsResetAll") }}</span>
      </Button>
    </template>
    <!-- 细滚动条留着：面板被压到一半时要看得出下面还有 -->
    <div class="flex min-h-0 flex-auto flex-col overflow-y-auto px-3 pb-3 pt-0.5 [scrollbar-width:thin]">
      <section class="flex flex-none flex-col overflow-hidden rounded-kb-md border border-solid border-kb-line p-1">
        <WpeSettingsFields
          :fields="fields"
          :values="shownValues"
          :follow-available="followAvailable"
          :modified="modified"
          variant="panel"
          @update="onUpdate"
          @reset="onReset"
        />
      </section>
    </div>
  </CollapsibleDrawerPanel>
</template>

<script setup lang="ts">
import { computed, toRef } from "vue";
import { useI18n } from "@kabegame/i18n";
import { RotateCcw } from "@lucide/vue";
import { Button } from "@/components/ui";
import { IS_WINDOWS } from "@/env";
import CollapsibleDrawerPanel from "@/components/common/CollapsibleDrawerPanel.vue";
import { useWpeFollowAvailable } from "@/composables/useWpeFollowAvailable";
import { useWpePreviewSettings, type WpePreviewSettingKey } from "@/composables/useWpePreviewSettings";
import { wpePreviewFieldsFor, type WpeSettingKey } from "@/utils/wpeSettings";
import WpeSettingsFields from "./WpeSettingsFields.vue";

/**
 * 预览右栏的「预览设置」：这张壁纸只给预览（与应用背景）用的一套设置，存在 metadata 的 `previewSettings`，
 * 与桌面的全局「壁纸设置」互不影响；作者的用户属性在下面的「壁纸属性」面板，预览与桌面共用。
 * 暂停不存：值由预览弹窗传进来（`paused`，和右键菜单 / 工具条的暂停是同一个内存状态），改动经 `update:paused` 交回去。
 */
const props = defineProps<{
  imageId: string;
  imageType?: string | null;
  paused?: boolean;
}>();
const emit = defineEmits<{ "update:paused": [paused: boolean] }>();

const { t } = useI18n();
const followAvailable = useWpeFollowAvailable();
const { values, modified, anyModified, set, reset, resetAll } = useWpePreviewSettings(toRef(props, "imageId"));

const fields = computed(() => wpePreviewFieldsFor(props.imageType, IS_WINDOWS));
const shownValues = computed(() => ({ ...values.value, paused: props.paused === true }));

function onUpdate(key: WpeSettingKey, value: boolean | number | string) {
  if (key === "paused") emit("update:paused", value === true);
  else set(key as WpePreviewSettingKey, value);
}
function onReset(key: WpeSettingKey) {
  if (key !== "paused") reset(key as WpePreviewSettingKey);
}
</script>
