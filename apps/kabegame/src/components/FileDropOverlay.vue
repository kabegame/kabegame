<template>
  <Transition name="fade">
    <div v-if="visible" class="file-drop-overlay" :style="overlayStyle">
      <!-- 虚线框独立一层：inset 内缩，不受浮层自身 box-sizing 影响 -->
      <div class="drop-frame" />
      <div class="drop-body">
        <div class="drop-icon">
          <Upload :size="40" />
        </div>
        <div class="drop-text">
          {{ label }}
        </div>
        <div class="drop-hint">
          {{ hint || $t("common.releaseToImport") }}
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Upload } from "@lucide/vue";
import { useModal } from "@/composables/useModal";

const { t } = useI18n();
const fileDropModal = useModal();

const visible = ref(false);
const label = ref(t("common.dragDropText"));
const hint = ref<string | undefined>(undefined);
const overlayRect = ref<DOMRect | null>(null);

watch(visible, (v) => (v ? fileDropModal.open() : fileDropModal.close()));

const overlayStyle = computed(() => {
  const rect = overlayRect.value;
  return {
    zIndex: String(fileDropModal.zIndex.value),
    top: `${rect?.top ?? 0}px`,
    left: `${rect?.left ?? 0}px`,
    width: `${rect?.width ?? 0}px`,
    height: `${rect?.height ?? 0}px`,
  };
});

const show = (payload: { rect: DOMRect; label: string; hint?: string }) => {
  overlayRect.value = payload.rect;
  label.value = payload.label;
  hint.value = payload.hint;
  visible.value = true;
};

const hide = () => {
  visible.value = false;
};

defineExpose({
  show,
  hide,
});
</script>

<style lang="scss">
.file-drop-overlay {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  // 浮层永远不吃鼠标事件：拖放由 CEF 在 content 层处理，DOM 这边只是提示
  pointer-events: none;
  overflow: hidden;
}

// 虚线框贴着热区内缩一圈；蒙层只铺在框内，框外保持完全通透
.drop-frame {
  position: absolute;
  inset: 6px;
  border: 2px dashed var(--kb-accent);
  border-radius: var(--kb-radius-lg);
  // 「背景更透明」：只留一层极淡的主题色，不加 backdrop-filter——
  // 模糊会让底下的图看不清，反而破坏「能看见拖进哪里」的意图
  background: color-mix(in srgb, var(--kb-accent) 8%, transparent);
  opacity: 0.9;
}

.drop-body {
  position: relative;
  max-width: 80%;
  padding: 12px 20px;
  text-align: center;
  // 文字压在图片上也要读得清，给一层跟随主题的浅底
  border-radius: var(--kb-radius-lg);
  background: var(--kb-surface-raised);
  box-shadow: var(--kb-shadow-pop);
}

.drop-icon {
  display: flex;
  justify-content: center;
  color: var(--kb-accent);
  margin-bottom: 12px;
  line-height: 1;
}

.drop-text {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--kb-fg);
  margin-bottom: 4px;
}

.drop-hint {
  font-size: 13px;
  color: var(--kb-fg-muted);
}

// 热区很矮时（例如窄窗口下的画册头部）收敛排版，避免撑破
@media (max-height: 560px) {
  .drop-icon {
    display: none;
  }

  .drop-text {
    font-size: 15px;
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
