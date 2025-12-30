<template>
  <div class="plugins-container">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>插件配置</span>
          <el-button type="primary" @click="showAddDialog = true">
            <el-icon><Plus /></el-icon>
            添加插件
          </el-button>
        </div>
      </template>

      <el-table :data="plugins" style="width: 100%" empty-text="暂无插件">
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="description" label="描述" show-overflow-tooltip />
        <el-table-column prop="baseUrl" label="基础URL" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-switch
              v-model="row.enabled"
              @change="handleTogglePlugin(row)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 添加/编辑对话框 -->
    <el-dialog
      v-model="showAddDialog"
      :title="editingPlugin ? '编辑插件' : '添加插件'"
      width="600px"
    >
      <el-form :model="pluginForm" label-width="100px" ref="formRef">
        <el-form-item label="名称" required>
          <el-input v-model="pluginForm.name" placeholder="插件名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="pluginForm.description"
            type="textarea"
            :rows="2"
            placeholder="插件描述"
          />
        </el-form-item>
        <el-form-item label="基础URL" required>
          <el-input v-model="pluginForm.baseUrl" placeholder="https://example.com" />
        </el-form-item>
        <el-form-item label="图片选择器" required>
          <el-input v-model="pluginForm.selector.imageSelector" placeholder="img" />
        </el-form-item>
        <el-form-item label="下一页选择器">
          <el-input v-model="pluginForm.selector.nextPageSelector" placeholder="a.next" />
        </el-form-item>
        <el-form-item label="标题选择器">
          <el-input v-model="pluginForm.selector.titleSelector" placeholder="h1.title" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="pluginForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus } from "@element-plus/icons-vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import { useRouter } from "vue-router";

const pluginStore = usePluginStore();
const router = useRouter();

const plugins = computed(() => pluginStore.plugins);
const showAddDialog = ref(false);
const editingPlugin = ref<Plugin | null>(null);
const formRef = ref();

const pluginForm = reactive({
  name: "",
  description: "",
  baseUrl: "",
  enabled: true,
  selector: {
    imageSelector: "",
    nextPageSelector: "",
    titleSelector: "",
  },
});

const handleSave = async () => {
  if (!pluginForm.name || !pluginForm.baseUrl || !pluginForm.selector.imageSelector) {
    ElMessage.warning("请填写必填项");
    return;
  }

  try {
    if (editingPlugin.value) {
      await pluginStore.updatePlugin(editingPlugin.value.id, pluginForm);
      ElMessage.success("插件已更新");
    } else {
      // 后端插件来源为 .kgpg 导入/商店安装/浏览器安装，不支持通过表单“创建新插件”
      ElMessage.info("请前往「源」页面导入/安装插件");
      router.push("/plugin-browser");
      return;
    }
    showAddDialog.value = false;
    resetForm();
  } catch (error) {
    ElMessage.error("保存失败");
  }
};

const handleEdit = (plugin: Plugin) => {
  editingPlugin.value = plugin;
  pluginForm.name = plugin.name;
  pluginForm.description = plugin.description;
  pluginForm.baseUrl = plugin.baseUrl;
  pluginForm.enabled = plugin.enabled;
  pluginForm.selector = {
    imageSelector: plugin.selector?.imageSelector || "",
    nextPageSelector: plugin.selector?.nextPageSelector || "",
    titleSelector: plugin.selector?.titleSelector || "",
  };
  showAddDialog.value = true;
};

const handleDelete = async (plugin: Plugin) => {
  try {
    await ElMessageBox.confirm(`确定要删除插件 "${plugin.name}" 吗？`, "确认删除", {
      type: "warning",
    });
    await pluginStore.deletePlugin(plugin.id);
    ElMessage.success("插件已删除");
  } catch (error) {
    // 用户取消
  }
};

const handleTogglePlugin = async (plugin: Plugin) => {
  try {
    await pluginStore.updatePlugin(plugin.id, { enabled: plugin.enabled });
  } catch (error) {
    ElMessage.error("更新失败");
    plugin.enabled = !plugin.enabled; // 回滚
  }
};

const resetForm = () => {
  editingPlugin.value = null;
  pluginForm.name = "";
  pluginForm.description = "";
  pluginForm.baseUrl = "";
  pluginForm.enabled = true;
  pluginForm.selector = {
    imageSelector: "",
    nextPageSelector: "",
    titleSelector: "",
  };
};

onMounted(async () => {
  await pluginStore.loadPlugins();
});
</script>

<style scoped lang="scss">
.plugins-container {
  max-width: 1200px;
  margin: 0 auto;

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
}
</style>

