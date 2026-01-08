<template>
  <el-button type="danger" :loading="loading" @click="handleClear">
    <el-icon><Delete /></el-icon>
    清理所有用户数据
  </el-button>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";

const loading = ref(false);

const handleClear = async () => {
  try {
    await ElMessageBox.confirm(
      "此操作将删除所有用户数据，包括：\n" +
        "• 所有图片和缩略图\n" +
        "• 所有画册\n" +
        "• 所有任务记录\n" +
        "• 所有设置\n" +
        "• 所有插件配置\n\n" +
        "应用将在清理完成后自动重启。\n\n" +
        "此操作不可恢复，请谨慎操作！",
      "确认清理用户数据",
      {
        type: "warning",
        confirmButtonText: "我已知晓，继续清理",
        cancelButtonText: "取消",
        dangerouslyUseHTMLString: false,
      }
    );

    await ElMessageBox.confirm(
      "请再次确认：\n\n您确定要清理所有用户数据吗？\n清理后应用将自动重启，所有数据将无法恢复！",
      "最终确认",
      {
        type: "error",
        confirmButtonText: "确定清理",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      }
    );

    loading.value = true;
    await invoke("clear_user_data");
    ElMessage.success("数据清理完成，应用即将重启...");
  } catch (e) {
    // 用户取消时 element-plus 会 throw "cancel"
    if (e !== "cancel") {
      // eslint-disable-next-line no-console
      console.error("清理数据失败:", e);
      ElMessage.error("清理数据失败");
    }
  } finally {
    loading.value = false;
  }
};
</script>


