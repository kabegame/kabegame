<template>
  <template v-if="defs.length > 0">
    <el-divider content-position="left">{{ $t("plugins.pluginConfig") }}</el-divider>
    <PluginVarsForm v-model="formVars" :plugin-vars="visibleDefs" @var-change="onPluginVarChange" />
  </template>
</template>

<script setup lang="ts">
/**
 * 插件变量表单：v-model 是后端格式的 plugin config，内部持有 UI 格式（checkbox 数组等）。
 * 由父级以 `:key="taskConfigRevision"` 重建——只有外部写入才重建，用户编辑不触发循环。
 */
import { computed, ref, watch } from "vue";
import PluginVarsForm from "@kabegame/core/components/crawler/PluginVarsForm.vue";
import { usePluginStore } from "@/stores/plugins";
import {
  isRequired,
  normalizeVarsForUI,
  expandVarsForBackend,
  type PluginVarDef,
} from "@kabegame/core/utils/pluginVarForm";
import { matchesPluginVarWhen, withCoercedOptions } from "@kabegame/core/utils/pluginVarWhen";
import { trackEvent } from "@kabegame/core/track/umami";
import { IS_WEB } from "@kabegame/core/env";

const props = defineProps<{
  pluginId: string;
  modelValue: Record<string, any>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
}>();

const pluginStore = usePluginStore();

const defs = computed<PluginVarDef[]>(
  () => (pluginStore.plugins.find((p) => p.id === props.pluginId)?.config?.vars as PluginVarDef[] | undefined) ?? [],
);

/** 用户编辑的真实值（含当前被 `when` 隐藏的字段） */
const uiVars = ref<Record<string, any>>(normalizeVarsForUI(props.modelValue ?? {}, defs.value));

/** 只读的展示/提交值：选项级 `when` 让当前值不可选时回退，但不回写 store */
const effectiveVars = computed(() => withCoercedOptions(uiVars.value, defs.value));

/** 写回：用户手动改选时才落到 uiVars（进而 emit 到 store） */
const formVars = computed<Record<string, any>>({
  get: () => effectiveVars.value,
  set: (value) => {
    uiVars.value = value;
  },
});

/** `when` 只控制显隐，不改 store */
const visibleDefs = computed(() => defs.value.filter((d) => matchesPluginVarWhen(d.when, effectiveVars.value)));

watch(
  uiVars,
  () => {
    emit("update:modelValue", expandVarsForBackend(uiVars.value, defs.value));
  },
  { deep: true },
);

function summarizePluginVarValue(varDef: PluginVarDef, value: unknown): Record<string, unknown> {
  const type = String(varDef.type ?? "");
  if (Array.isArray(value)) {
    const primitiveValues = value
      .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .slice(0, 5)
      .map(String);
    return {
      has_value: value.length > 0,
      value_count: value.length,
      values: primitiveValues,
    };
  }
  if (typeof value === "boolean") {
    return { has_value: true, value };
  }
  if (type === "options" && (typeof value === "string" || typeof value === "number")) {
    return { has_value: String(value).trim() !== "", value: String(value) };
  }
  if (value === null || value === undefined) {
    return { has_value: false };
  }
  if (typeof value === "string") {
    return { has_value: value.trim() !== "", value_length: value.length };
  }
  return { has_value: true };
}

const lastPluginVarTrackSignature = new Map<string, string>();

function onPluginVarChange(varDef: PluginVarDef, value: unknown) {
  if (!IS_WEB) return;
  const summary = summarizePluginVarValue(varDef, value);
  const signature = JSON.stringify(summary);
  if (lastPluginVarTrackSignature.get(varDef.key) === signature) return;
  lastPluginVarTrackSignature.set(varDef.key, signature);
  trackEvent("gallery_import_param_change", {
    plugin_id: props.pluginId,
    key: varDef.key,
    type: varDef.type ?? "",
    ...summary,
  });
}

/** 首个未填的可见必填字段；无则返回 null */
function firstInvalidVar(): PluginVarDef | null {
  const values = effectiveVars.value;
  for (const varDef of visibleDefs.value) {
    if (!isRequired(varDef)) continue;
    const value = values[varDef.key];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      ((varDef.type === "list" || varDef.type === "checkbox") && Array.isArray(value) && value.length === 0)
    ) {
      return varDef;
    }
  }
  return null;
}

defineExpose({
  firstInvalidVar,
  visibleVarCount: () => visibleDefs.value.length,
});
</script>
