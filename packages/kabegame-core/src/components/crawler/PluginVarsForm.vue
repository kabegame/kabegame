<template>
  <template v-if="pluginVars.length > 0">
    <el-form-item
      v-for="varDef in pluginVars"
      :key="varDef.key"
      :label="varDisplayName(varDef)"
      :prop="`vars.${varDef.key}`"
      :required="isRequired(varDef)"
      :rules="getValidationRules(varDef, varDisplayName(varDef))"
    >
      <PluginVarField
        :type="varDef.type"
        :model-value="(modelValue || {})[varDef.key]"
        :options="optionsForVar(varDef)"
        :min="typeof varDef.min === 'number' && !isNaN(varDef.min) ? varDef.min : undefined"
        :max="typeof varDef.max === 'number' && !isNaN(varDef.max) ? varDef.max : undefined"
        :file-extensions="getFileExtensions(varDef)"
        :date-format="typeof varDef.format === 'string' && varDef.format.trim() !== '' ? varDef.format : undefined"
        :date-min="typeof varDef.dateMin === 'string' && varDef.dateMin.trim() !== '' ? varDef.dateMin : undefined"
        :date-max="typeof varDef.dateMax === 'string' && varDef.dateMax.trim() !== '' ? varDef.dateMax : undefined"
        :allow-unset="!isRequired(varDef)"
        @update:model-value="(val) => updateVar(varDef.key, val)"
      />
      <div v-if="varDescripts(varDef)">
        {{ varDescripts(varDef) }}
      </div>
    </el-form-item>
  </template>
</template>

<script setup lang="ts">
import PluginVarField from "../plugin/var-fields/PluginVarField.vue";
import { usePluginConfigI18n } from "@kabegame/i18n";
import { filterVarOptionsByWhen } from "../../utils/pluginVarWhen";
import { usePluginConfig, type PluginVarDef } from "@/composables/usePluginConfig";

const props = defineProps<{
  pluginVars: PluginVarDef[];
  modelValue: Record<string, any>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
}>();

const { varDisplayName, varDescripts, optionDisplayName } = usePluginConfigI18n();
const { isRequired, getValidationRules } = usePluginConfig();

const optionsForVar = (varDef: PluginVarDef): (string | { name: string; variable: string })[] => {
  const filtered = filterVarOptionsByWhen(varDef.options, props.modelValue ?? {});
  return filtered.map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );
};

const getFileExtensions = (varDef: PluginVarDef): string[] | undefined => {
  const opts = varDef.options;
  if (!Array.isArray(opts)) return undefined;
  const exts = opts
    .map((o) => (typeof o === "string" ? o : o.variable))
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? exts : undefined;
};

const updateVar = (key: string, value: any) => {
  emit("update:modelValue", {
    ...(props.modelValue ?? {}),
    [key]: value,
  });
};
</script>
