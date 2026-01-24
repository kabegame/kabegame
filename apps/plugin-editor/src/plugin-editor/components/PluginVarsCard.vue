<template>
  <el-card class="info-card" shadow="hover">
    <template #header>
      <div class="card-header">
        <div class="card-header-left">
          <el-icon class="header-icon">
            <List />
          </el-icon>
          <span>变量</span>
        </div>
        <el-button type="primary" size="small" class="add-var-btn" @click="$emit('add-var')">
          <el-icon>
            <Plus />
          </el-icon>
          添加变量
        </el-button>
      </div>
    </template>
    <div class="vars-container">
      <!-- 变量列表 -->
      <el-collapse :model-value="collapseActiveNames" @update:model-value="$emit('update:collapseActiveNames', $event)"
        class="var-collapse">
        <el-collapse-item v-for="(v, idx) in vars" :key="idx" :name="idx">
          <template #title>
            <div class="var-title">
              <span class="var-key">{{ v.key }}</span>
              <el-tag :type="getVarTypeTag(v.type)" size="small">{{ v.type }}</el-tag>
              <span v-if="v.name" class="var-name">{{ v.name }}</span>
              <el-button type="danger" text size="small" class="var-delete-btn" @click.stop="$emit('remove-var', idx)">
                删除
              </el-button>
            </div>
          </template>
          <div class="var-item-body">
            <el-form label-position="top" class="var-item-form">
              <el-row :gutter="12">
                <el-col :span="12">
                  <el-form-item label="键">
                    <el-input v-model="v.key" placeholder="var_key" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="类型">
                    <el-select :model-value="v.type" style="width: 100%"
                      @update:model-value="handleVarTypeChange(idx, $event)">
                      <el-option label="整数" value="int" />
                      <el-option label="浮点数" value="float" />
                      <el-option label="布尔值" value="boolean" />
                      <el-option label="选项" value="options" />
                      <el-option label="复选框" value="checkbox" />
                      <el-option label="列表" value="list" />
                      <el-option label="本地路径（文件/文件夹）" value="path" />
                    </el-select>
                  </el-form-item>
                </el-col>
              </el-row>

              <el-row :gutter="12">
                <el-col :span="12">
                  <el-form-item label="名称">
                    <el-input v-model="v.name" placeholder="变量名称" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="默认值">
                    <el-input-number v-if="v.type === 'int' || v.type === 'float'"
                      :model-value="readNumber(v.defaultText)" style="width: 100%"
                      @update:model-value="writeNumber(v, 'defaultText', $event)" />
                    <el-select v-else-if="v.type === 'boolean'" :model-value="readBoolean(v.defaultText)" clearable
                      placeholder="未设置" style="width: 100%"
                      @update:model-value="writeBoolean(v, 'defaultText', $event)">
                      <el-option label="true" :value="true" />
                      <el-option label="false" :value="false" />
                    </el-select>
                    <el-select v-else-if="v.type === 'options'" :model-value="readString(v.defaultText)" clearable
                      placeholder="未设置" style="width: 100%" @update:model-value="writeString(v, 'defaultText', $event)">
                      <el-option v-for="opt in readVarOptions(v)" :key="optionValue(opt)" :label="optionLabel(opt)"
                        :value="optionValue(opt)" />
                    </el-select>
                    <el-select v-else-if="v.type === 'list' || v.type === 'checkbox'"
                      :model-value="readStringArray(v.defaultText)" multiple clearable collapse-tags
                      collapse-tags-tooltip placeholder="未设置" style="width: 100%"
                      @update:model-value="writeStringArray(v, 'defaultText', $event)">
                      <el-option v-for="opt in readVarOptions(v)" :key="optionValue(opt)" :label="optionLabel(opt)"
                        :value="optionValue(opt)" />
                    </el-select>
                    <el-input v-else-if="v.type === 'path'" :model-value="readString(v.defaultText)" clearable
                      placeholder="未设置" @update:model-value="writeString(v, 'defaultText', $event)" />
                    <el-input v-else v-model="v.defaultText" placeholder='JSON，如: "value" 或 123' />
                  </el-form-item>
                </el-col>
              </el-row>

              <el-form-item label="说明">
                <el-input v-model="v.descripts" type="textarea" :rows="2" placeholder="变量说明" />
              </el-form-item>

              <el-form-item v-if="v.type === 'options' || v.type === 'checkbox' || v.type === 'list'" label="选项">
                <div class="options-editor">
                  <div v-for="(opt, optIdx) in optionItemsByVarIndex[idx]" :key="optIdx" class="option-row">
                    <el-input v-model="opt.name" placeholder="显示名（可选）" @input="commitOptionItems(idx)" />
                    <el-input v-model="opt.variable" placeholder="变量值（脚本里使用）" @input="commitOptionItems(idx)" />
                    <el-button type="danger" link @click="removeOptionItem(idx, optIdx)">删除</el-button>
                  </div>
                  <div class="option-actions">
                    <el-button size="small" @click="addOptionItem(idx)">添加选项</el-button>
                    <el-button size="small" @click="resetOptions(idx)">清空</el-button>
                  </div>
                  <div v-if="optionsParseErrorByVarIndex[idx]" class="parse-error">
                    {{ optionsParseErrorByVarIndex[idx] }}
                  </div>
                </div>
              </el-form-item>

              <el-form-item v-else-if="v.type === 'path'" label="可选扩展名（可选）">
                <el-select :model-value="readStringArray(v.optionsText)" multiple filterable allow-create
                  default-first-option clearable collapse-tags collapse-tags-tooltip placeholder="不填表示不限制"
                  style="width: 100%" @update:model-value="writeStringArray(v, 'optionsText', $event)" />
              </el-form-item>

              <el-row v-if="v.type === 'int' || v.type === 'float'" :gutter="12">
                <el-col :span="12">
                  <el-form-item label="最小值">
                    <el-input-number :model-value="readNumber(v.minText)" style="width: 100%"
                      @update:model-value="writeNumber(v, 'minText', $event)" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="最大值">
                    <el-input-number :model-value="readNumber(v.maxText)" style="width: 100%"
                      @update:model-value="writeNumber(v, 'maxText', $event)" />
                  </el-form-item>
                </el-col>
              </el-row>

              <el-divider content-position="left" class="var-divider">测试值</el-divider>
              <el-form-item>
                <PluginVarField :type="v.type" :model-value="testValues[idx]" :options="readVarOptions(v)"
                  :min="readNumber(v.minText)" :max="readNumber(v.maxText)"
                  :file-extensions="readFileExtensions(v.optionsText)" placeholder="不覆盖默认值" :allow-unset="true"
                  @update:model-value="setTestValue(idx, $event)" />
                <div class="test-value-actions">
                  <el-button size="small" text @click="$emit('use-default-as-test-value', idx)">
                    使用默认值
                  </el-button>
                  <el-button size="small" text @click="$emit('clear-test-value', idx)">
                    清空
                  </el-button>
                </div>
              </el-form-item>
            </el-form>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { List, Plus } from "@element-plus/icons-vue";
import PluginVarField from "@kabegame/core/components/plugin/var-fields/PluginVarField.vue";

type VarOption = string | { name: string; variable: string };

type VarDraft = {
  key: string;
  type:
  | "int"
  | "float"
  | "options"
  | "checkbox"
  | "boolean"
  | "list"
  | "path"
  | "file_or_folder"
  | "file"
  | "folder";
  name: string;
  descripts: string;
  defaultText: string;
  optionsText: string;
  minText: string;
  maxText: string;
};

const props = defineProps<{
  vars: VarDraft[];
  testValues: unknown[];
  collapseActiveNames: number[];
}>();

defineEmits<{
  "add-var": [];
  "remove-var": [idx: number];
  "use-default-as-test-value": [idx: number];
  "clear-test-value": [idx: number];
  "update:collapseActiveNames": [value: number[]];
}>();

type OptionItem = { name: string; variable: string };

const optionItemsByVarIndex = ref<OptionItem[][]>([]);
const optionsParseErrorByVarIndex = ref<string[]>([]);
const lastOptionsTextByVarIndex = ref<string[]>([]);

watch(
  () => props.vars.map((v) => v.optionsText),
  (texts) => {
    optionItemsByVarIndex.value = optionItemsByVarIndex.value.slice(0, texts.length);
    optionsParseErrorByVarIndex.value = optionsParseErrorByVarIndex.value.slice(0, texts.length);
    lastOptionsTextByVarIndex.value = lastOptionsTextByVarIndex.value.slice(0, texts.length);

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? "";
      if (lastOptionsTextByVarIndex.value[i] === text) continue;
      const { items, error } = parseOptionsTextToItems(text);
      optionItemsByVarIndex.value[i] = items;
      optionsParseErrorByVarIndex.value[i] = error || "";
      lastOptionsTextByVarIndex.value[i] = text;
    }
  },
  { immediate: true }
);

function parseJson(text: string): unknown | undefined {
  const t = `${text ?? ""}`.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function readNumber(text: string): number | undefined {
  const v = parseJson(text);
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

function readBoolean(text: string): boolean | undefined {
  const v = parseJson(text);
  return typeof v === "boolean" ? v : undefined;
}

function readString(text: string): string | undefined {
  const v = parseJson(text);
  return typeof v === "string" ? v : undefined;
}

function readStringArray(text: string): string[] {
  const v = parseJson(text);
  if (!Array.isArray(v)) return [];
  return v.map((x) => `${x}`).map((s) => s.trim()).filter((s) => s !== "");
}

function writeNumber(v: VarDraft, field: "defaultText" | "minText" | "maxText", val: unknown) {
  if (typeof val !== "number" || Number.isNaN(val)) {
    v[field] = "";
    return;
  }
  v[field] = JSON.stringify(val);
}

function writeBoolean(v: VarDraft, field: "defaultText", val: unknown) {
  if (val === undefined || val === null) {
    v[field] = "";
    return;
  }
  v[field] = JSON.stringify(Boolean(val));
}

function writeString(v: VarDraft, field: "defaultText", val: unknown) {
  const s = typeof val === "string" ? val : "";
  if (s.trim() === "") {
    v[field] = "";
    return;
  }
  v[field] = JSON.stringify(s);
}

function writeStringArray(v: VarDraft, field: "defaultText" | "optionsText", val: unknown) {
  const arr = Array.isArray(val) ? (val as unknown[]) : [];
  const cleaned = arr.map((x) => `${x}`).map((s) => s.trim()).filter((s) => s !== "");
  if (cleaned.length === 0) {
    v[field] = "";
    return;
  }
  v[field] = JSON.stringify(cleaned);
}

function optionLabel(opt: VarOption): string {
  return typeof opt === "string" ? opt : opt.name;
}

function optionValue(opt: VarOption): string {
  return typeof opt === "string" ? opt : opt.variable;
}

function parseOptionsTextToItems(text: string): { items: OptionItem[]; error?: string } {
  const t = `${text ?? ""}`.trim();
  if (!t) return { items: [] };
  try {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) return { items: [], error: "选项不是 JSON 数组" };

    const items: OptionItem[] = [];
    for (const it of v) {
      if (typeof it === "string") {
        items.push({ name: it, variable: it });
      } else if (it && typeof it === "object") {
        const name = typeof (it as any).name === "string" ? (it as any).name : "";
        const variable = typeof (it as any).variable === "string" ? (it as any).variable : "";
        items.push({ name, variable });
      }
    }
    return { items };
  } catch {
    return { items: [], error: "选项 JSON 解析失败（已忽略，点击“清空”可重置）" };
  }
}

function commitOptionItems(varIdx: number) {
  const v = props.vars[varIdx];
  if (!v) return;
  const items = optionItemsByVarIndex.value[varIdx] || [];
  const cleaned = items
    .map((it) => ({ name: `${it.name ?? ""}`.trim(), variable: `${it.variable ?? ""}`.trim() }))
    .filter((it) => it.name !== "" || it.variable !== "");

  if (cleaned.length === 0) {
    v.optionsText = "";
    lastOptionsTextByVarIndex.value[varIdx] = "";
    optionsParseErrorByVarIndex.value[varIdx] = "";
    return;
  }

  const useStringsOnly = cleaned.every((it) => it.variable !== "" && it.name === it.variable);
  const payload = useStringsOnly ? cleaned.map((it) => it.variable) : cleaned.map((it) => ({ name: it.name || it.variable, variable: it.variable || it.name }));
  const json = JSON.stringify(payload);
  v.optionsText = json;
  lastOptionsTextByVarIndex.value[varIdx] = json;
  optionsParseErrorByVarIndex.value[varIdx] = "";
}

function addOptionItem(varIdx: number) {
  if (!optionItemsByVarIndex.value[varIdx]) optionItemsByVarIndex.value[varIdx] = [];
  optionItemsByVarIndex.value[varIdx].push({ name: "", variable: "" });
  commitOptionItems(varIdx);
}

function removeOptionItem(varIdx: number, optIdx: number) {
  optionItemsByVarIndex.value[varIdx]?.splice(optIdx, 1);
  commitOptionItems(varIdx);
}

function resetOptions(varIdx: number) {
  optionItemsByVarIndex.value[varIdx] = [];
  commitOptionItems(varIdx);
}

function readVarOptions(v: VarDraft): VarOption[] {
  const parsed = parseJson(v.optionsText);
  if (!Array.isArray(parsed)) return [];
  const out: VarOption[] = [];
  for (const it of parsed) {
    if (typeof it === "string") out.push(it);
    else if (it && typeof it === "object") {
      const name = typeof (it as any).name === "string" ? (it as any).name : "";
      const variable = typeof (it as any).variable === "string" ? (it as any).variable : "";
      if (name || variable) out.push({ name: name || variable, variable: variable || name });
    }
  }
  return out;
}

function readFileExtensions(optionsText: string): string[] | undefined {
  const exts = readStringArray(optionsText)
    .map((s) => s.replace(/^\./, "").toLowerCase())
    .filter((s) => s !== "");
  return exts.length > 0 ? exts : undefined;
}

function setTestValue(varIdx: number, val: unknown) {
  (props.testValues as unknown[])[varIdx] = val;
}

function handleVarTypeChange(varIdx: number, newType: VarDraft["type"]) {
  const v = props.vars[varIdx];
  if (!v) return;
  if (v.type === newType) return;

  v.type = newType;
  v.defaultText = "";
  v.optionsText = "";
  v.minText = "";
  v.maxText = "";

  optionItemsByVarIndex.value[varIdx] = [];
  optionsParseErrorByVarIndex.value[varIdx] = "";
  lastOptionsTextByVarIndex.value[varIdx] = "";
  setTestValue(varIdx, undefined);
}

function getVarTypeTag(type: string): "success" | "warning" | "info" | "danger" {
  switch (type) {
    case "int":
    case "float":
      return "success";
    case "options":
    case "checkbox":
      return "warning";
    case "boolean":
      return "info";
    case "list":
      return "danger";
    case "path":
      return "info";
    default:
      return "info";
  }
}

// 暴露函数给父组件（如果需要）
defineExpose({
  getVarTypeTag,
});
</script>

<style scoped lang="scss">
.info-card {
  flex-shrink: 0;

  // 移除悬浮时的运动效果
  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
  }

  :deep(.el-card__body) {
    padding: 20px;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-weight: 600;
  font-size: 15px;
  color: var(--anime-text-primary);

  .card-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-icon {
    font-size: 18px;
    color: var(--anime-primary);
  }

  .add-var-btn {
    flex-shrink: 0;
  }
}

/* 变量容器 */
.vars-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 变量折叠面板 */
.var-collapse {
  :deep(.el-collapse-item__header) {
    padding: 12px 0;
    font-weight: 500;
  }

  :deep(.el-collapse-item__content) {
    padding: 16px 0;
  }
}

.var-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;

  .var-key {
    font-weight: 600;
    color: var(--anime-text-primary);
  }

  .var-name {
    color: var(--anime-text-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* 表单样式优化 */
:deep(.el-form-item) {
  margin-bottom: 18px;
}

:deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--anime-text-primary);
}

:deep(.el-input__wrapper) {
  border-radius: 8px;
  transition: all 0.3s ease;
}

:deep(.el-textarea__inner) {
  border-radius: 8px;
  font-family: inherit;
}

:deep(.el-select .el-input__wrapper) {
  border-radius: 8px;
}

:deep(.el-collapse-item__header) {
  border-radius: 8px;
  transition: all 0.3s ease;

  &:hover {
    background: rgba(255, 107, 157, 0.05);
  }
}

.options-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.option-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 10px;
  align-items: center;
}

.option-actions {
  display: flex;
  gap: 8px;
}

.parse-error {
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 18px;
}
</style>
