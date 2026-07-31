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
        :placeholder="varDescripts(varDef) ||
          (varDef.type === 'options' ||
            varDef.type === 'list' ||
            varDef.type === 'checkbox' ||
            varDef.type === 'date'
            ? `请选择${varDisplayName(varDef)}`
            : `请输入${varDisplayName(varDef)}`)
        "
        :allow-unset="allowUnsetAll || !isRequired(varDef)"
        @update:model-value="(val) => updateVar(varDef, val)"
      />
      <div v-if="varDescripts(varDef)" class="var-desc">
        {{ varDescripts(varDef) }}
      </div>
    </el-form-item>
  </template>
</template>

<script setup lang="ts">
import PluginVarField from "../plugin/var-fields/PluginVarField.vue";
import { usePluginConfigI18n } from "@kabegame/i18n";
import { filterVarOptionsByWhen } from "../../utils/pluginVarWhen";
import { isRequired, getValidationRules, type PluginVarDef } from "../../utils/pluginVarForm";

const props = withDefaults(
  defineProps<{
    pluginVars: PluginVarDef[];
    modelValue: Record<string, any>;
    allowUnsetAll?: boolean;
  }>(),
  {
    allowUnsetAll: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
  "var-change": [varDef: PluginVarDef, value: unknown];
}>();

const { varDisplayName, varDescripts, optionDisplayName } = usePluginConfigI18n();

const optionsForVar = (varDef: PluginVarDef): (string | { name: string; variable: string })[] => {
  const filtered = filterVarOptionsByWhen(varDef.options, props.modelValue ?? {});
  return filtered.map((opt) =>
    typeof opt === "string" ? opt : { name: optionDisplayName(opt), variable: opt.variable },
  );
};

const getFileExtensions = (varDef: PluginVarDef): string[] | undefined => {
  const opts = varDef.options;
  if (!Array.isArray(opts) || opts.length === 0) return undefined;
  const exts = opts
    .map((o) => (typeof o === "string" ? o : o.variable))
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? exts : undefined;
};

const updateVar = (varDef: PluginVarDef, value: any) => {
  emit("update:modelValue", {
    ...(props.modelValue ?? {}),
    [varDef.key]: value,
  });
  emit("var-change", varDef, value);
};
</script>

<style scoped lang="scss">
.var-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
