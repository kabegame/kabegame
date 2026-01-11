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
                    <el-select v-model="v.type" style="width: 100%">
                      <el-option label="整数" value="int" />
                      <el-option label="浮点数" value="float" />
                      <el-option label="布尔值" value="boolean" />
                      <el-option label="选项" value="options" />
                      <el-option label="复选框" value="checkbox" />
                      <el-option label="列表" value="list" />
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
                    <el-input v-model="v.defaultText" placeholder='JSON，如: "value" 或 123' />
                  </el-form-item>
                </el-col>
              </el-row>

              <el-form-item label="说明">
                <el-input v-model="v.descripts" type="textarea" :rows="2" placeholder="变量说明" />
              </el-form-item>

              <el-form-item v-if="v.type === 'options' || v.type === 'checkbox' || v.type === 'list'" label="选项">
                <el-input v-model="v.optionsText" type="textarea" :rows="3"
                  placeholder='JSON 数组，如: ["option1","option2"] 或 [{"name":"选项1","variable":"opt1"}]' />
              </el-form-item>

              <el-row v-if="v.type === 'int' || v.type === 'float'" :gutter="12">
                <el-col :span="12">
                  <el-form-item label="最小值">
                    <el-input v-model="v.minText" placeholder="可选（JSON 数字）" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="最大值">
                    <el-input v-model="v.maxText" placeholder="可选（JSON 数字）" />
                  </el-form-item>
                </el-col>
              </el-row>

              <el-divider content-position="left" class="var-divider">测试值</el-divider>
              <el-form-item>
                <el-input v-model="testInputText[idx]"
                  placeholder='留空表示不覆盖默认值；填写 JSON，例如: "abc" / 123 / true / ["a","b"]' clearable />
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
import { List, Plus } from "@element-plus/icons-vue";

type VarDraft = {
  key: string;
  type: "int" | "float" | "options" | "checkbox" | "boolean" | "list";
  name: string;
  descripts: string;
  defaultText: string;
  optionsText: string;
  minText: string;
  maxText: string;
};

defineProps<{
  vars: VarDraft[];
  testInputText: string[];
  collapseActiveNames: number[];
}>();

defineEmits<{
  "add-var": [];
  "remove-var": [idx: number];
  "use-default-as-test-value": [idx: number];
  "clear-test-value": [idx: number];
  "update:collapseActiveNames": [value: number[]];
}>();

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
</style>