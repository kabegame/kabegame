<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('kamechan.historyTitle')"
    width="640px"
    :append-to-body="true"
    class="kamechan-history-dialog"
    @update:model-value="$event || emit('close')"
  >
    <div class="kamechan-history-list">
      <div v-if="messages.length === 0" class="kamechan-history-empty">
        {{ t("kamechan.historyEmpty") }}
      </div>
      <div
        v-for="message in messages"
        :key="message.id"
        class="kamechan-history-entry"
        :class="`is-${message.type}`"
      >
        <div class="kamechan-history-main">
          <el-tag :type="tagType(message.type)" size="small">{{ message.type }}</el-tag>
          <span class="kamechan-history-text">{{ message.text }}</span>
        </div>
        <div class="kamechan-history-time-row">
          <span class="kamechan-history-time">{{ formatLogTime(message.time) }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button :disabled="messages.length === 0" @click="store.clearHistory()">
        {{ t("kamechan.historyClear") }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import { useKameMessageStore, type KameMessageType } from "@kabegame/core/stores/kameMessage";

defineProps<{ open: boolean; zIndex: number }>();
const emit = defineEmits<{ close: [] }>();

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

const tagType = (type: KameMessageType): "info" | "warning" | "danger" | "success" => {
  if (type === "error") return "danger";
  return type;
};
</script>

<style scoped lang="scss">
.kamechan-history-list {
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: text;
  -webkit-user-select: text;
}

.kamechan-history-empty {
  text-align: center;
  color: var(--anime-text-secondary);
  padding: 24px 0;
}

.kamechan-history-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--anime-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
}

.kamechan-history-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.kamechan-history-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  line-height: 1.5;
  white-space: pre-wrap;
}

.kamechan-history-time-row {
  display: flex;
  justify-content: flex-end;
}

.kamechan-history-time {
  color: var(--anime-text-secondary);
  font-size: 11px;
}

.kamechan-history-entry.is-warning {
  background: rgba(245, 158, 11, 0.08);
}

.kamechan-history-entry.is-error {
  background: rgba(239, 68, 68, 0.08);
}
</style>
