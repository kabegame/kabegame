<template>
  <div class="debug-generate-images">
    <div class="row">
      <el-input-number
        v-model="count"
        :min="1"
        :max="1000000"
        :step="10000"
        controls-position="right"
      />
      <span class="hint">张</span>

      <el-input-number
        v-model="poolSize"
        :min="1"
        :max="5000"
        :step="100"
        controls-position="right"
      />
      <span class="hint">池大小</span>

      <el-input-number
        v-model="seed"
        :min="0"
        :max="9007199254740991"
        :step="1"
        controls-position="right"
        placeholder="seed(可选)"
      />
      <span class="hint">seed</span>

      <el-button type="warning" :loading="loading" @click="run">
        生成测试图片
      </el-button>
    </div>

    <div v-if="progress.total > 0" class="row progress-row">
      <el-progress
        :percentage="percentage"
        :stroke-width="10"
        :text-inside="true"
        status="warning"
      />
      <span class="progress-text">
        {{ progress.inserted.toLocaleString() }} /
        {{ progress.total.toLocaleString() }}
      </span>
    </div>

    <div class="tips">
      <div>说明：</div>
      <div>- 仅开发模式可见；会在 SQLite 里批量插入图片记录（id 唯一）。</div>
      <div>- 大数量可能需要较长时间，完成后请到画廊刷新/重新进入查看效果。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";

const count = ref<number>(200000);
const poolSize = ref<number>(2000);
const seed = ref<number | null>(null);

const loading = ref(false);
const progress = ref<{ inserted: number; total: number }>({ inserted: 0, total: 0 });
const percentage = computed(() => {
  if (!progress.value.total) return 0;
  return Math.min(
    100,
    Math.round((progress.value.inserted / progress.value.total) * 100)
  );
});

let unlisten: null | (() => void) = null;

onMounted(async () => {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<{ inserted: number; total: number }>(
      "debug-clone-images-progress",
      (event) => {
        progress.value = event.payload;
      }
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("监听 debug-clone-images-progress 失败:", e);
  }
});

onBeforeUnmount(() => {
  try {
    unlisten?.();
  } catch {
    // ignore
  } finally {
    unlisten = null;
  }
});

const run = async () => {
  const c = Math.floor(count.value || 0);
  const p = Math.floor(poolSize.value || 0);
  const s = seed.value === null ? null : Math.floor(seed.value || 0);

  if (c <= 0) {
    ElMessage.warning("请输入要生成的数量");
    return;
  }

  try {
    await ElMessageBox.confirm(
      `将生成 ${c.toLocaleString()} 条图片记录用于测试（仅写入数据库，不会复制文件）。\n\n继续？`,
      "确认生成测试数据",
      { type: "warning", confirmButtonText: "开始生成", cancelButtonText: "取消" }
    );
  } catch (e) {
    if (e !== "cancel") {
      // eslint-disable-next-line no-console
      console.error("确认弹窗失败:", e);
    }
    return;
  }

  loading.value = true;
  progress.value = { inserted: 0, total: c };
  try {
    const res = await invoke<{ inserted: number }>("debug_clone_images", {
      count: c,
      poolSize: p,
      seed: s === null ? undefined : s,
    });
    ElMessage.success(`已生成 ${res.inserted.toLocaleString()} 条测试图片记录`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("生成测试图片失败:", e);
    ElMessage.error("生成测试图片失败（请看控制台/后端日志）");
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped lang="scss">
.debug-generate-images {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.hint {
  opacity: 0.75;
  font-size: 12px;
}

.progress-row {
  width: 100%;
}

.progress-text {
  opacity: 0.75;
  font-size: 12px;
  white-space: nowrap;
}

.tips {
  opacity: 0.8;
  font-size: 12px;
  line-height: 1.5;
}
</style>


