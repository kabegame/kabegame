<template>
  <Popover v-model:open="visible">
    <PopoverTrigger as-child>
      <span class="inline-flex flex-none" @click.stop><slot /></span>
    </PopoverTrigger>
    <PopoverContent align="start" :width="420">
      <div class="flex flex-col gap-4 p-2.5" @click.stop>
        <ScheduleSpecEditor v-model="draft" />
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="visible = false">{{ t("common.cancel") }}</Button>
          <Button variant="primary" size="sm" :disabled="saving" @click="save">
            <Spinner v-if="saving" :size="14" />
            {{ t("common.save") }}
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner } from "@/components/ui";
import { useCrawlerStore, type RunConfig, type ScheduleSpec } from "@/stores/crawler";
import ScheduleSpecEditor from "./ScheduleSpecEditor.vue";
import { cloneScheduleSpec } from "@/utils/scheduleText";

const props = defineProps<{ config: RunConfig }>();
const emit = defineEmits<{ updated: [config: RunConfig] }>();
const { t } = useI18n();
const crawlerStore = useCrawlerStore();
const visible = ref(false);
const saving = ref(false);
const draft = ref<ScheduleSpec | null>(props.config.scheduleSpec ? cloneScheduleSpec(props.config.scheduleSpec) : null);

watch(visible, (open) => {
  if (open) draft.value = props.config.scheduleSpec ? cloneScheduleSpec(props.config.scheduleSpec) : null;
});

async function save() {
  saving.value = true;
  try {
    const config = await crawlerStore.updateRunConfig({
      ...props.config,
      scheduleEnabled: draft.value != null,
      scheduleSpec: draft.value ? cloneScheduleSpec(draft.value) : undefined,
      // 规则变了，旧的计划时间作废：置空后由调度器按新规则重算
      schedulePlannedAt: undefined,
    });
    emit("updated", config);
    visible.value = false;
    kameMessage.success(t("common.save"));
  } catch (error) {
    console.error(error);
    kameMessage.error(t("common.operationFailed"));
  } finally {
    saving.value = false;
  }
}
</script>
