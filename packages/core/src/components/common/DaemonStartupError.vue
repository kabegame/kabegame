<template>
  <div class="daemon-startup-error">
    <div class="error-content">
      <img src="/lost.png" alt="错误" class="error-image" />
      <h1 class="error-title">核心启动失败</h1>
      <p class="error-message">{{ error }}</p>
      <p v-if="daemonPath" class="error-hint">
        请检查 <code>{{ daemonPath }}</code> 能否正常启动
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  error: string;
  daemonPath?: string;
}>();
</script>

<style scoped lang="scss">
.daemon-startup-error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--anime-bg-main);
  padding: 20px;
}

.error-content {
  text-align: center;
  max-width: 600px;
}

.error-image {
  width: 200px;
  height: 200px;
  object-fit: contain;
  margin-bottom: 24px;
  opacity: 0.8;
}

.error-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--anime-primary);
  margin-bottom: 16px;
}

.error-message {
  font-size: 16px;
  color: var(--anime-text-primary);
  margin-bottom: 16px;
  line-height: 1.6;
}

.error-hint {
  font-size: 14px;
  color: var(--anime-text-secondary);
  margin-top: 16px;
  line-height: 1.6;

  code {
    background: var(--anime-bg-card);
    padding: 4px 8px;
    border-radius: 4px;
    font-family: "Courier New", monospace;
    color: var(--anime-primary);
    border: 1px solid var(--anime-border);
  }
}
</style>
