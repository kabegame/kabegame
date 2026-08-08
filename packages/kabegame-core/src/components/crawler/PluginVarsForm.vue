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
        :class="{ 'plugin-vars-item--checkbox': varDef.type === 'checkbox' }"
      >
        <!-- checkbox 型：全选与计数挤占字段高度，收进 label 行右侧 -->
        <template v-if="varDef.type === 'checkbox'" #label>
          <span>{{ varDisplayName(varDef) }}</span>
          <button
            v-if="checkboxOptionValues(varDef).length > 1"
            type="button"
            class="plugin-vars-grid__select-all"
            :class="{ 'is-indeterminate': checkboxIndeterminate(varDef) }"
            @click.prevent.stop="toggleAllCheckbox(varDef)"
          >
            {{ checkboxAllSelected(varDef) ? "✓" : "–" }} {{ t("plugins.pluginVarSelectAll") }}
          </button>
          <span v-if="checkboxOptionValues(varDef).length > 0" class="plugin-vars-grid__count">
            {{ checkboxSelectedCount(varDef) }}/{{ checkboxOptionValues(varDef).length }}
          </span>
        </template>
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
import { usePluginConfigI18n, useI18n } from "@kabegame/i18n";
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
const { t } = useI18n();
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

/* ---- checkbox 型的全选/计数（渲染在 label 行，逻辑归表单层） ---- */

function checkboxOptionValues(varDef: PluginVarDef): string[] {
  return optionsForVar(varDef)
    .map((o) => (typeof o === "string" ? o : o.variable))
    .filter((v) => typeof v === "string" && v.trim() !== "");
}

function checkboxSelectedCount(varDef: PluginVarDef): number {
  const raw = (props.modelValue ?? {})[varDef.key];
  const sel = Array.isArray(raw) ? raw.map((x) => `${x}`) : [];
  return checkboxOptionValues(varDef).filter((v) => sel.includes(v)).length;
}

function checkboxAllSelected(varDef: PluginVarDef): boolean {
  const vals = checkboxOptionValues(varDef);
  return vals.length > 0 && checkboxSelectedCount(varDef) === vals.length;
}

function checkboxIndeterminate(varDef: PluginVarDef): boolean {
  const n = checkboxSelectedCount(varDef);
  return n > 0 && n < checkboxOptionValues(varDef).length;
}

function toggleAllCheckbox(varDef: PluginVarDef) {
  const vals = checkboxOptionValues(varDef);
  if (vals.length === 0) return;
  updateVar(varDef, checkboxAllSelected(varDef) ? [] : [...vals]);
}

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

  // checkbox 型的 label 行要在右侧放全选/计数：整行铺满并 flex 排布。
  // display: flex 下必填星号（label 的 ::before）仍是首个 flex item，不会换行。
  :deep(.plugin-vars-item--checkbox .el-form-item__label) {
    display: flex;
    align-items: center;
    width: 100%;
  }
}

.plugin-vars-grid__select-all {
  appearance: none;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px dashed color-mix(in srgb, var(--anime-secondary) 60%, transparent);
  border-radius: 6px;
  margin: 0 0 0 auto; /* 推到 label 行最右 */
  background: transparent;
  color: var(--anime-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.plugin-vars-grid__select-all:hover {
  color: var(--anime-primary);
  border-color: color-mix(in srgb, var(--anime-primary) 60%, transparent);
}
.plugin-vars-grid__select-all.is-indeterminate {
  border-style: solid;
}

.plugin-vars-grid__count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--anime-text-muted);
  font-variant-numeric: tabular-nums;
}

.plugin-vars-notes {
  display: flex;
  flex-direction: column;
  /* 项内可能折成多行，项间距要明显大于行距才分得开 */
  gap: 8px;
  padding: 10px 12px;
  border-left: 3px solid var(--anime-secondary);
  border-radius: 12px;
  margin-bottom: 18px;
  background: color-mix(in srgb, var(--anime-secondary) 8%, transparent);
  font-size: 12px;
  line-height: 1.6;
}

/* 走自然文本流而不是 flex：名称和描述首行仍并排，
   但描述折行时回到容器左边缘，不会缩在右半边排成窄窄一条 */
.plugin-vars-notes__item {
  min-width: 0;
}

.plugin-vars-notes__name {
  margin-right: 8px;
  color: var(--anime-text-secondary);
  font-weight: 600;
}

.plugin-vars-notes__text {
  min-width: 0;
  color: var(--anime-text-muted);
}
</style>
