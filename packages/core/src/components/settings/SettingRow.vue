<template>
  <div class="setting-row">
    <div class="setting-meta">
      <div class="label">
        {{ label }}
        <template v-if="description">
          <el-tooltip v-if="!IS_ANDROID" :content="description" placement="top">
            <el-icon class="help-icon">
              <QuestionFilled />
            </el-icon>
          </el-tooltip>
          <el-icon
            v-else
            class="help-icon help-icon-clickable"
            @click="onAndroidHelpClick"
          >
            <QuestionFilled />
          </el-icon>
        </template>
      </div>
    </div>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { QuestionFilled } from "@element-plus/icons-vue";
import { IS_ANDROID } from "../../env";
import { showToast } from "vant";

const props = defineProps<{
  label: string;
  description?: string;
}>();

function onAndroidHelpClick() {
  if (!props.description) return;
  showToast({ message: props.description, duration: 3000 });
}
</script>

<style scoped lang="scss">
.setting-row {
  display: grid;
  grid-template-columns: 3fr 7fr;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
}

.setting-meta {
  justify-self: end;
  display: flex;
  justify-content: flex-end;
}

.label {
  font-weight: 600;
  color: var(--anime-text-primary);
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 6px;
}

.help-icon {
  color: var(--anime-text-muted);
  font-size: 14px;
  cursor: help;
  flex-shrink: 0;
}

.help-icon-clickable {
  cursor: pointer;
}

.setting-control {
  display: flex;
  justify-content: flex-start;
}

@media (max-width: 720px) {
  // .setting-row {
  //   grid-template-columns: 1fr;
  // }

  // .setting-meta {
  //   min-width: 0;
  //   width: 100%;
  //   justify-content: flex-start;
  // }

  // .setting-control {
  //   width: 100%;
  //   min-width: 0;
  //   justify-content: flex-end;
  // }
}
</style>

