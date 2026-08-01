<template>
  <template v-if="pluginVars.length > 0">
    <div class="plugin-vars-grid" :class="{ 'plugin-vars-grid--compact': isCompact }">
      <el-form-item
        v-for="varDef in pluginVars"
        :key="varDef.key"
        :label="varDisplayName(varDef)"
        :prop="`vars.${varDef.key}`"
        :required="isRequired(varDef)"
        :rules="getValidationRules(varDef, varDisplayName(varDef))"
        :style="{ gridColumn: `span ${spanOf(varDef)}` }"
      >
        <PluginVar
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
      </el-form-item>
    </div>

    <!-- 字段说明统一收到表单底部：逐字段渲染会把栅格行撑得参差不齐、纵向拉得很长 -->
    <div v-if="describedVars.length > 0" class="plugin-vars-notes">
      <div v-for="varDef in describedVars" :key="varDef.key" class="plugin-vars-notes__item">
        <span class="plugin-vars-notes__name">{{ varDisplayName(varDef) }}</span>
        <span class="plugin-vars-notes__text">{{ varDescripts(varDef) }}</span>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue";
import PluginVar from "../plugin/var-fields/PluginVar.vue";
import { usePluginConfigI18n } from "@kabegame/i18n";
import { filterVarOptionsByWhen } from "../../utils/pluginVarWhen";
import { isRequired, getValidationRules, type PluginVarDef } from "../../utils/pluginVarForm";
import { useUiStore } from "../../stores/ui";

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
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

/** 读 width 并 clamp：非 1~4 整数一律当 4（含未设置） */
function widthOf(v: PluginVarDef): number {
  const w = Number(v.width);
  return Number.isInteger(w) && w >= 1 && w <= 4 ? w : 4;
}

/** 桌面四列直接用 width；紧凑端两列，span = ceil(width/2)：1、2 → 半行，3、4 → 整行 */
function spanOf(v: PluginVarDef): number {
  const w = widthOf(v);
  return isCompact.value ? Math.ceil(w / 2) : w;
}

/** 底部说明区只列出「当前可见且有描述」的字段，顺序与表单一致 */
const describedVars = computed(() => props.pluginVars.filter((v) => varDescripts(v)));

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
// 非 dense 自动流：按声明顺序贪心填充，放不下就整体换行，不回填前面的空档
.plugin-vars-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  column-gap: 12px;
  align-items: start;

  &--compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  // 行距沿用 el-form-item 自带的 margin-bottom，容器只负责列间距
  :deep(.el-form-item) {
    min-width: 0;
  }
}

.plugin-vars-notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-left: 3px solid var(--anime-secondary);
  border-radius: 12px;
  margin-bottom: 18px;
  background: color-mix(in srgb, var(--anime-secondary) 8%, transparent);
  font-size: 12px;
  line-height: 1.6;
}

.plugin-vars-notes__item {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.plugin-vars-notes__name {
  flex: none;
  color: var(--anime-text-secondary);
  font-weight: 600;
}

.plugin-vars-notes__text {
  min-width: 0;
  color: var(--anime-text-muted);
}
</style>
