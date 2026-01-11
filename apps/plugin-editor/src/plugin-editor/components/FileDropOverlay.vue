<template>
  <Transition name="fade">
    <div v-if="isDragging" class="file-drop-overlay">
      <div class="drop-zone">
        <div class="drop-icon">
          <el-icon :size="64">
            <Upload />
          </el-icon>
        </div>
        <div class="drop-text">
          {{ dropText }}
        </div>
        <div class="drop-hint">松开鼠标以导入</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Upload } from "@element-plus/icons-vue";

const isDragging = ref(false);
const dropText = ref("拖入 .kgpg 文件");

const show = (text?: string) => {
  if (text) dropText.value = text;
  isDragging.value = true;
};
const hide = () => {
  isDragging.value = false;
};

defineExpose({ show, hide });
</script>

<style lang="scss">
.file-drop-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(255, 107, 157, 0.15) 0%, rgba(167, 139, 250, 0.15) 100%);
  backdrop-filter: blur(12px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.drop-zone {
  position: relative;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 240, 245, 0.95) 100%);
  border: 3px dashed;
  border-color: var(--anime-primary);
  border-radius: 20px;
  padding: 48px 64px;
  text-align: center;
  box-shadow: 0 8px 32px rgba(255, 107, 157, 0.2), 0 0 0 1px rgba(255, 107, 157, 0.1) inset;
  animation: pulse 2s ease-in-out infinite;
  backdrop-filter: blur(10px);

  &::before {
    content: "";
    position: absolute;
    top: -3px;
    left: -3px;
    right: -3px;
    bottom: -3px;
    background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
    border-radius: 20px;
    z-index: -1;
    opacity: 0.3;
    animation: borderPulse 2s ease-in-out infinite;
  }
}

.drop-icon {
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 24px;
}

.drop-text {
  font-size: 24px;
  font-weight: 600;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 12px;
}

.drop-hint {
  font-size: 16px;
  color: var(--anime-text-secondary);
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: 0 8px 32px rgba(255, 107, 157, 0.2), 0 0 0 1px rgba(255, 107, 157, 0.1) inset;
  }

  50% {
    transform: scale(1.02);
    box-shadow: 0 12px 40px rgba(255, 107, 157, 0.35), 0 0 0 1px rgba(255, 107, 157, 0.2) inset;
  }
}

@keyframes borderPulse {
  0%,
  100% {
    opacity: 0.6;
  }
  50% {
    opacity: 0.8;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

