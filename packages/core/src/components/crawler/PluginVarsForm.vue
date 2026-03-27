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

type AnyVarDef = {
  key: string;
  type?: string;
  min?: number;
  max?: number;
  format?: string;
  dateMin?: string;
  dateMax?: string;
};

const props = defineProps<{
  pluginVars: AnyVarDef[];
  modelValue: Record<string, any>;
  varDisplayName: (varDef: AnyVarDef) => string;
  varDescripts: (varDef: AnyVarDef) => string;
  optionsForVar: (varDef: AnyVarDef) => (string | { name: string; variable: string })[];
  isRequired: (varDef: AnyVarDef) => boolean;
  getValidationRules: (varDef: AnyVarDef, displayName?: string) => any[];
  getFileExtensions: (varDef: AnyVarDef) => string[] | undefined;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, any>];
}>();

const updateVar = (key: string, value: any) => {
  emit("update:modelValue", {
    ...(props.modelValue ?? {}),
    [key]: value,
  });
};
</script>
