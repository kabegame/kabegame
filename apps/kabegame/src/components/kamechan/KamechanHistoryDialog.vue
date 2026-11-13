<template>
  <Dialog v-model:open="open" :title="t('kamechan.historyTitle')" :width="640">
    <div class="kb-selectable flex max-h-[420px] flex-col gap-2 overflow-y-auto">
      <div v-if="messages.length === 0" class="py-6 text-center text-[13px] text-kb-fg-muted">
        {{ t("kamechan.historyEmpty") }}
      </div>
      <div
        v-for="message in messages"
        :key="message.id"
        class="box-border flex flex-col gap-1 rounded-kb-md border border-solid border-kb-line px-2.5 py-2 text-[12px]"
        :class="entryClass(message.type)"
      >
        <div class="flex min-w-0 items-baseline gap-2">
          <Tag :tone="tagTone(message.type)" size="sm">{{ message.type }}</Tag>
          <!-- 用 v-text：pre-wrap 下模板里换行缩进会变成首尾空格 -->
          <span class="min-w-0 flex-1 whitespace-pre-wrap break-words leading-[1.5] text-kb-fg" v-text="message.text" />
        </div>
        <div class="flex justify-end">
          <span class="text-[11px] text-kb-fg-subtle">{{ formatLogTime(message.time) }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <Button :disabled="messages.length === 0" @click="store.clearHistory()">
        {{ t("kamechan.historyClear") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import Button from "@/components/ui/Button.vue";
import Dialog from "@/components/ui/Dialog.vue";
import Tag from "@/components/ui/Tag.vue";
import { useKameMessageStore, type KameMessageType } from "@/stores/kameMessage";

const open = defineModel<boolean>("open", { default: false });

const { t, locale } = useI18n();
const store = useKameMessageStore();
const { history } = storeToRefs(store);

const messages = computed(() => [...history.value].reverse());

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

const formatLogTime = (timestamp: number) => {
  const loc = locale.value ?? "zh";
  return new Date(Number(timestamp || 0)).toLocaleString(toLocaleTag(loc));
};

const tagTone = (type: KameMessageType): "neutral" | "warning" | "danger" | "success" => {
  if (type === "error") return "danger";
  if (type === "info") return "neutral";
  return type;
};

/** 警告 / 错误条目铺一层淡底（同任务日志） */
const entryClass = (type: KameMessageType) => {
  if (type === "error") return "bg-[color-mix(in_srgb,var(--kb-danger)_6%,transparent)]";
  if (type === "warning") return "bg-[color-mix(in_srgb,var(--kb-warning)_8%,transparent)]";
  return "";
};
</script>
