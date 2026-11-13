<template>
  <template v-if="pluginVars.length > 0">
    <!-- 非 dense 自动流：按声明顺序贪心填充，放不下就整体换行，不回填前面的空档 -->
    <div class="grid items-start gap-x-3 gap-y-4" :class="isCompact ? 'grid-cols-2' : 'grid-cols-4'">
      <Field
        v-for="varDef in pluginVars"
        :key="varDef.key"
        :label="varDisplayName(varDef)"
        :required="!ignoreRequired && isRequired(varDef)"
        :validator="
          () => varFieldError(varDef, (modelValue || {})[varDef.key], varDisplayName(varDef), { ignoreRequired })
        "
        :style="{ gridColumn: `span ${spanOf(varDef)}` }"
        class="min-w-0 transition-opacity duration-200 ease-out"
        :class="{ 'opacity-40': isIgnoredByWhen(varDef) }"
      >
        <!-- checkbox 型：全选与计数挤占字段高度，收进标签行右侧 -->
        <template v-if="varDef.type === 'checkbox'" #label-end>
          <button
            v-if="checkboxOptionValues(varDef).length > 1"
            type="button"
            class="ml-auto box-border inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-kb-sm border border-solid border-kb-line-strong bg-transparent px-1.5 text-[11.5px] font-500 leading-none text-kb-fg-muted [font-family:inherit] hover:border-kb-fg-subtle hover:text-kb-fg"
            @click="toggleAllCheckbox(varDef)"
          >
            <Check v-if="checkboxAllSelected(varDef)" class="size-3" />
            <Minus v-else-if="checkboxIndeterminate(varDef)" class="size-3" />
            {{ t("plugins.pluginVarSelectAll") }}
          </button>
          <span
            v-if="checkboxOptionValues(varDef).length > 0"
            class="shrink-0 text-[11px] tabular-nums text-kb-fg-subtle"
            :class="checkboxOptionValues(varDef).length > 1 ? '' : 'ml-auto'"
          >
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
          :placeholder="
            varDescripts(varDef) ||
            (varDef.type === 'options' || varDef.type === 'list' || varDef.type === 'checkbox' || varDef.type === 'date'
              ? `请选择${varDisplayName(varDef)}`
              : `请输入${varDisplayName(varDef)}`)
          "
          @update:model-value="(val) => updateVar(varDef, val)"
        />
      </Field>
    </div>

    <!-- 字段说明统一收到表单底部：逐字段渲染会把栅格行撑得参差不齐、纵向拉得很长 -->
    <div
      v-if="describedVars.length > 0"
      class="mt-4 flex flex-col gap-2 rounded-kb-md bg-kb-fill px-3 py-2.5 text-[12px] leading-[1.6]"
    >
      <!-- 走自然文本流而不是 flex：描述折行时回到左边缘，不会缩在右半边排成窄窄一条 -->
      <div v-for="varDef in describedVars" :key="varDef.key" class="min-w-0">
        <span class="mr-2 font-600 text-kb-fg">{{ varDisplayName(varDef) }}</span>
        <span class="text-kb-fg-muted">{{ varDescripts(varDef) }}</span>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue";
import PluginVar from "../plugin/var-fields/PluginVar.vue";
import { usePluginConfigI18n, useI18n } from "@kabegame/i18n";
import { filterVarOptionsByWhen, visibleVarDefs } from "../../utils/pluginVarWhen";
import { isRequired, varFieldError, type PluginVarDef } from "../../utils/pluginVarForm";
import { Check, Minus } from "@lucide/vue";
import Field from "@/components/ui/Field.vue";
import { useUiStore } from "../../stores/ui";

const props = withDefaults(
  defineProps<{
    pluginVars: PluginVarDef[];
    modelValue: Record<string, any>;
    /** 默认配置等总览场景不要求必填项有值：这里保存的是默认值，必填只在真正提交任务时校验。 */
    ignoreRequired?: boolean;
    /** 默认配置等总览场景可忽略选项级 `when`，展示插件声明的全部候选值。 */
    ignoreWhen?: boolean;
  }>(),
  {
    ignoreRequired: false,
    ignoreWhen: false,
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
const whenValues = computed(() => {
  const visible = new Set(visibleVarDefs(props.pluginVars, props.modelValue ?? {}).map((def) => def.key));
  return Object.fromEntries(Object.entries(props.modelValue ?? {}).filter(([key]) => visible.has(key)));
});

/** 总览模式下仍展示不满足 `when` 的字段，并用较低不透明度标明其当前处于非激活条件。 */
function isIgnoredByWhen(varDef: PluginVarDef): boolean {
  if (!props.ignoreWhen) return false;
  return !visibleVarDefs(props.pluginVars, props.modelValue ?? {}).some((def) => def.key === varDef.key);
}

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
  const filtered = props.ignoreWhen ? (varDef.options ?? []) : filterVarOptionsByWhen(varDef.options, whenValues.value);
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
