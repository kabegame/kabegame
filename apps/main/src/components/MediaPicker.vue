<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    :size="IS_ANDROID ? 'auto' : '400px'"
    :direction="IS_ANDROID ? 'btt' : 'rtl'"
    :close-on-click-modal="true"
    :with-header="!IS_ANDROID"
    class="media-picker-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="media-picker-content">
      <div class="picker-options">
        <div
          class="picker-option"
          @click="handleSelect('image')"
        >
          <div class="option-icon">
            <el-icon :size="32">
              <Picture />
            </el-icon>
          </div>
          <div class="option-content">
            <div class="option-title">选择图片</div>
            <div class="option-desc">从手机相册选择一张或多张图片</div>
          </div>
          <el-icon class="option-arrow">
            <ArrowRight />
          </el-icon>
        </div>

        <div
          class="picker-option"
          @click="handleSelect('folder')"
        >
          <div class="option-icon">
            <el-icon :size="32">
              <FolderOpened />
            </el-icon>
          </div>
          <div class="option-content">
            <div class="option-title">选择文件夹</div>
            <div class="option-desc">选择一个包含图片的文件夹</div>
          </div>
          <el-icon class="option-arrow">
            <ArrowRight />
          </el-icon>
        </div>

        <div
          class="picker-option"
          @click="handleSelect('archive')"
        >
          <div class="option-icon">
            <el-icon :size="32">
              <Box />
            </el-icon>
          </div>
          <div class="option-content">
            <div class="option-title">选择压缩文件</div>
            <div class="option-desc">支持 .zip、.rar、.7z、.tar、.gz、.bz2、.xz 等格式</div>
          </div>
          <el-icon class="option-arrow">
            <ArrowRight />
          </el-icon>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { Picture, FolderOpened, ArrowRight, Box } from "@element-plus/icons-vue";
import { ElDrawer, ElIcon } from "element-plus";
import { IS_ANDROID } from "@kabegame/core/env";
import { watch, ref } from "vue";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";
import { pickFolder, type PickFolderResult } from "tauri-plugin-picker-api";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: "选择导入方式",
});

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", type: "image" | "folder" | "archive", payload?: PickFolderResult): void;
}>();

const modalStackStore = useModalStackStore();
const modalStackId = ref<string | null>(null);

watch(
  () => props.modelValue,
  (val) => {
    if (val && IS_ANDROID) {
      modalStackId.value = modalStackStore.push(() => {
        emit("update:modelValue", false);
      });
    } else if (!val && modalStackId.value) {
      modalStackStore.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

// 受控：仅通过 modelValue 控制显示；选择时发 select，由父组件关闭
// 移动端选文件夹时在此调用 picker 插件并带上结果
const handleSelect = async (type: "image" | "folder" | "archive") => {
  if (type === "folder") {
    const result = await pickFolder();
    if (result?.uri ?? result?.path) {
      emit("select", "folder", result);
    }
    return;
  }
  emit("select", type);
};
</script>

<style lang="scss" scoped>
.media-picker-drawer {
  :deep(.el-drawer__header) {
    margin-bottom: 20px;
    padding: 20px 20px 0;
  }

  :deep(.el-drawer__body) {
    padding: 20px;
  }

  // 安卓下底部弹出时的特殊样式
  &:deep(.el-drawer.btt) {
    .el-drawer__body {
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    }
  }
}

.media-picker-content {
  width: 100%;
}

.picker-options {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--anime-bg-card);
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;

  &:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 107, 157, 0.1) 0%,
      rgba(167, 139, 250, 0.1) 100%
    );
    border-color: var(--anime-primary);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(255, 107, 157, 0.15);
  }

  &:active {
    transform: translateY(0);
  }
}

.option-icon {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    rgba(255, 107, 157, 0.15) 0%,
    rgba(167, 139, 250, 0.15) 100%
  );
  border-radius: 12px;
  color: var(--anime-primary);
}

.option-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--anime-text-primary);
  line-height: 1.4;
}

.option-desc {
  font-size: 13px;
  color: var(--anime-text-secondary);
  line-height: 1.4;
}

.option-arrow {
  flex-shrink: 0;
  color: var(--anime-text-secondary);
  transition: transform 0.2s ease;
}

.picker-option:hover .option-arrow {
  transform: translateX(4px);
  color: var(--anime-primary);
}
</style>
