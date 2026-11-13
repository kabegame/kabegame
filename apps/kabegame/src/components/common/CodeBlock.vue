<template>
  <div class="relative" :class="singleLine ? 'm-0' : 'my-2'">
    <!-- kb-selectable：全局 body 是 user-select:none，代码/路径要能划词部分复制 -->
    <pre
      class="code-block kb-selectable m-0 box-border overflow-x-auto rounded-kb-md border border-solid border-kb-line bg-kb-fill-lighter pl-3 pr-10"
      :class="singleLine ? 'py-1.75' : 'py-3'"
    ><code>{{ code }}</code></pre>
    <!-- 单行时垂直居中，多行时贴右上角 -->
    <div class="absolute right-1.5" :class="singleLine ? 'top-1/2 -translate-y-1/2' : 'top-1.5'">
      <Tooltip :content="copied ? t('common.copied') : t('gallery.imageDetailCopy')">
        <Button variant="ghost" size="icon-sm" :aria-label="t('gallery.imageDetailCopy')" @click="handleCopy">
          <Check v-if="copied" />
          <Copy v-else />
        </Button>
      </Tooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, Copy } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import { IS_WEB } from "@/env";

const { t } = useI18n();
const props = defineProps<{
  code: string;
  /** 单行紧凑形态（工具栏那条 PathQL 路径）：不留上下外边距、复制图标垂直居中。 */
  singleLine?: boolean;
}>();

const copied = ref(false);

const handleCopy = async () => {
  try {
    if (!IS_WEB) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(props.code);
    } else {
      await navigator.clipboard.writeText(props.code);
    }
    copied.value = true;
    kameMessage.success(t("common.copySuccess"));
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (error) {
    console.error("复制失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
};
</script>

<style scoped>
.code-block code {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--kb-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
</style>
