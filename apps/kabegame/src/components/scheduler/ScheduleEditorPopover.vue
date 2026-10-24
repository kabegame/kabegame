<template>
  <el-popover v-model:visible="visible" :width="420" trigger="click" placement="bottom-start">
    <template #reference>
      <span class="inline-flex flex-none" @click.stop><slot /></span>
    </template>
    <div class="flex flex-col gap-4" @click.stop>
      <ScheduleSpecEditor v-model="draft" />
      <div class="flex justify-end gap-2">
        <el-button size="small" @click="visible = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" size="small" :loading="saving" @click="save">{{ t("common.save") }}</el-button>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { useModalBack } from "@/composables/useModalBack";
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
useModalBack(visible);

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
    ElMessage.success(t("common.save"));
  } catch (error) {
    console.error(error);
    ElMessage.error(t("common.operationFailed"));
  } finally {
    saving.value = false;
  }
}
</script>
