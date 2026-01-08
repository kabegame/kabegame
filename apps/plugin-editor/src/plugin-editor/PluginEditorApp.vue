<template>
  <div class="plugin-editor-root">
    <div class="plugin-editor-header">
      <h1>插件编辑器</h1>
      <div class="header-actions">
        <el-button type="primary" :loading="isTesting" @click="runTest">测试</el-button>
        <el-button type="success" :loading="isExporting" @click="exportKgpg">导出 .kgpg</el-button>
      </div>
    </div>

    <div class="plugin-editor-content">
      <div class="layout">
        <!-- 左侧插件信息编辑区 -->
        <div class="sidebar">
          <!-- 插件基本信息 -->
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Document />
                </el-icon>
                <span>插件信息</span>
              </div>
            </template>
            <el-form label-width="80px">
              <el-form-item label="插件ID">
                <el-input v-model="draft.id" placeholder="my-plugin" />
              </el-form-item>
              <el-form-item label="名称">
                <el-input v-model="draft.manifest.name" placeholder="我的插件" />
              </el-form-item>
              <el-form-item label="版本">
                <el-input v-model="draft.manifest.version" placeholder="1.0.0" />
              </el-form-item>
              <el-form-item label="作者">
                <el-input v-model="draft.manifest.author" placeholder="Kabegame" />
              </el-form-item>
              <el-form-item label="描述">
                <el-input v-model="draft.manifest.description" type="textarea" :rows="3" placeholder="插件描述" />
              </el-form-item>
              <el-form-item label="图标">
                <div class="icon-picker" @click="selectIcon">
                  <img v-if="iconPreviewUrl" :src="iconPreviewUrl" class="icon-preview" />
                  <div v-else class="icon-placeholder">
                    <el-icon style="font-size: 32px; color: var(--anime-text-muted)">
                      <Picture />
                    </el-icon>
                  </div>
                </div>
              </el-form-item>
            </el-form>
          </el-card>

          <!-- 配置信息 -->
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Setting />
                </el-icon>
                <span>配置</span>
              </div>
            </template>
            <el-form label-width="80px">
              <el-form-item label="基础URL">
                <el-input v-model="draft.config.baseUrl" placeholder="https://example.com" />
              </el-form-item>
              <el-form-item>
                <template #label>
                  <span>变量</span>
                  <el-button text size="small" class="add-var-btn" @click="addVar">
                    <el-icon>
                      <Plus />
                    </el-icon>
                    添加
                  </el-button>
                </template>
                <el-collapse v-model="varCollapseActiveNames" class="var-collapse">
                  <el-collapse-item v-for="(v, idx) in draft.config.var" :key="idx" :name="idx">
                    <template #title>
                      <div class="var-title">
                        <span class="var-key">{{ v.key }}</span>
                        <el-tag :type="getVarTypeTag(v.type)" size="small">{{ v.type }}</el-tag>
                        <span v-if="v.name" class="var-name">{{ v.name }}</span>
                      </div>
                    </template>
                    <div>
                      <el-form-item label="键">
                        <el-input v-model="v.key" placeholder="var_key" />
                      </el-form-item>
                      <el-form-item label="类型">
                        <el-select v-model="v.type">
                          <el-option label="整数" value="int" />
                          <el-option label="浮点数" value="float" />
                          <el-option label="布尔值" value="boolean" />
                          <el-option label="选项" value="options" />
                          <el-option label="复选框" value="checkbox" />
                          <el-option label="列表" value="list" />
                        </el-select>
                      </el-form-item>
                      <el-form-item label="名称">
                        <el-input v-model="v.name" placeholder="变量名称" />
                      </el-form-item>
                      <el-form-item label="说明">
                        <el-input v-model="v.descripts" type="textarea" :rows="2" placeholder="变量说明" />
                      </el-form-item>
                      <el-form-item label="默认值">
                        <el-input v-model="v.defaultText" placeholder='JSON，如: "value" 或 123' />
                      </el-form-item>
                      <el-form-item v-if="v.type === 'options'" label="选项">
                        <el-input v-model="v.optionsText" type="textarea" :rows="3"
                          placeholder='JSON 数组，如: ["option1", "option2"] 或 [{"name": "选项1", "variable": "opt1"}]' />
                      </el-form-item>
                      <el-form-item v-if="v.type === 'int' || v.type === 'float'" label="最小值">
                        <el-input v-model="v.minText" placeholder="可选" />
                      </el-form-item>
                      <el-form-item v-if="v.type === 'int' || v.type === 'float'" label="最大值">
                        <el-input v-model="v.maxText" placeholder="可选" />
                      </el-form-item>
                      <el-form-item>
                        <el-button type="danger" size="small" @click="removeVar(idx)">删除</el-button>
                      </el-form-item>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </el-form-item>
            </el-form>
          </el-card>
        </div>

        <!-- 编辑器区域 -->
        <div class="editor-area">
          <el-card class="editor-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <DocumentCopy />
                </el-icon>
                <span>Rhai 脚本编辑器</span>
                <el-tag v-if="markers.length > 0" type="warning" size="small" class="marker-badge">
                  {{ markers.length }} 个问题
                </el-tag>
              </div>
            </template>
            <div class="editor-wrapper">
              <RhaiEditor v-model="draft.script" :markers="markers" />
            </div>
          </el-card>

          <!-- 输出区 -->
          <el-card class="console-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Monitor />
                </el-icon>
                <span>输出</span>
                <el-button v-if="consoleText" size="small" text @click="consoleText = ''" class="clear-btn">
                  <el-icon>
                    <Close />
                  </el-icon>
                  清空
                </el-button>
              </div>
            </template>
            <div class="console-wrapper">
              <pre class="console-body">{{ consoleText || "（空）" }}</pre>
            </div>
          </el-card>
        </div>

        <!-- 右侧固定任务/下载区域 -->
        <div class="task-area">
          <el-card class="task-card" shadow="hover">
            <template #header>
              <div class="card-header task-card-header">
                <el-icon class="header-icon">
                  <Monitor />
                </el-icon>
                <span>任务 / 下载</span>
                <div class="task-header-stats">
                  <el-tag size="small" type="warning">进行中: {{ activeTasksCount }}</el-tag>
                  <el-tag size="small" type="info">任务: {{ tasks.length }}</el-tag>
                </div>
              </div>
            </template>
            <div class="task-card-body">
              <TaskDrawerContent :tasks="tasks" :plugins="[]" :active="true" :enable-context-menu="false"
                @clear-finished-tasks="clearFinishedTasks" @open-task-images="openTaskImages" @delete-task="deleteTask"
                @cancel-task="cancelTask" />
            </div>
          </el-card>
        </div>
      </div>
    </div>
  </div>

  <TaskImagesDialog v-model="taskImagesDialogVisible" :task-id="taskImagesDialogTaskId" />
  <TaskDetailDialog v-model="taskDetailDialogVisible" :task-id="taskDetailDialogTaskId" @open-images="openTaskImages" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Document,
  Setting,
  DocumentCopy,
  Monitor,
  Close,
  Picture,
  Plus,
} from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useDebounceFn } from "@vueuse/core";
import RhaiEditor from "./components/RhaiEditor.vue";
import TaskImagesDialog from "./components/TaskImagesDialog.vue";
import TaskDetailDialog from "./components/TaskDetailDialog.vue";
import TaskDrawerContent from "@kabegame/core/components/task/TaskDrawerContent.vue";

type MonacoMarkerSeverity = 1 | 2 | 4 | 8;

type EditorMarker = {
  message: string;
  severity: MonacoMarkerSeverity;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type PluginManifest = {
  name: string;
  version: string;
  description: string;
  author: string;
};

type VarOption = string | { name: string; variable: string };

type VarDefinition = {
  key: string;
  type: "int" | "float" | "options" | "checkbox" | "boolean" | "list";
  name: string;
  descripts?: string;
  default?: unknown;
  options?: VarOption[];
  min?: unknown;
  max?: unknown;
};

type VarDraft = {
  key: string;
  type: VarDefinition["type"];
  name: string;
  descripts: string;
  defaultText: string;
  optionsText: string;
  minText: string;
  maxText: string;
};

type PluginConfig = {
  baseUrl?: string;
  var: VarDraft[];
};

const draft = reactive<{
  id: string;
  manifest: PluginManifest;
  config: PluginConfig;
  script: string;
}>({
  id: "my-plugin",
  manifest: {
    name: "我的插件",
    version: "1.0.0",
    description: "",
    author: "Kabegame",
  },
  config: {
    baseUrl: "",
    var: [],
  },
  script: `// 在这里编写 crawl.rhai\n// 提示：可在 config.json 的 var 中定义变量，并在脚本里直接使用变量名。\n`,
});

const consoleText = ref("");
const isTesting = ref(false);
const isExporting = ref(false);
const markers = ref<EditorMarker[]>([]);

// Icon 相关
const iconPreviewUrl = ref<string | null>(null);
const iconRgbBase64 = ref<string | null>(null);

// key -> JSON string
const testInputText = reactive<Record<string, string>>({});

type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  status: TaskStatus;
  progress: number;
  startTime?: number;
  endTime?: number;
  error?: string;
};

const tasks = ref<ScriptTask[]>([]);
const lastProgressUpdateAt = new Map<string, number>();

const taskImagesDialogVisible = ref(false);
const taskImagesDialogTaskId = ref("");

const taskDetailDialogVisible = ref(false);
const taskDetailDialogTaskId = ref("");

// 仅对"本次点击测试发起的任务"弹出结束提示（避免重启恢复的历史任务也弹）
const pendingFinishPopup = new Set<string>();

const activeTasksCount = computed(
  () => tasks.value.filter((t) => t.status === "pending" || t.status === "running").length
);

const varCollapseActiveNames = ref<number[]>([]);

let unlistenTaskStatus: (() => void) | null = null;
let unlistenTaskProgress: (() => void) | null = null;
let unlistenTaskError: (() => void) | null = null;

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

/** 将 RGB24 raw bytes（base64）转换为 data URL 用于预览 */
function rgb24ToDataUrl(base64Rgb: string): string {
  // 解码 base64 为 Uint8Array
  const binaryStr = atob(base64Rgb);
  const len = binaryStr.length;
  const rgb = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    rgb[i] = binaryStr.charCodeAt(i);
  }

  // 创建 canvas 并绘制 RGBA 图像
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(128, 128);
  const data = imageData.data;

  // RGB24 → RGBA32
  for (let i = 0; i < 128 * 128; i++) {
    data[i * 4 + 0] = rgb[i * 3 + 0]; // R
    data[i * 4 + 1] = rgb[i * 3 + 1]; // G
    data[i * 4 + 2] = rgb[i * 3 + 2]; // B
    data[i * 4 + 3] = 255; // A
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/** 选择图标 */
async function selectIcon() {
  const selected = await open({
    title: "选择插件图标",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
    multiple: false,
  });

  if (!selected) return;

  const filePath = typeof selected === "string" ? selected : selected;

  try {
    // 调用后端处理图片
    const rgb24Base64 = await invoke<string>("plugin_editor_process_icon", {
      imagePath: filePath,
    });

    // 保存用于导出
    iconRgbBase64.value = rgb24Base64;

    // 转换为 data URL 用于预览
    iconPreviewUrl.value = rgb24ToDataUrl(rgb24Base64);

    ElMessage.success("图标已加载");
  } catch (e) {
    ElMessage.error(`加载图标失败：${String(e)}`);
  }
}

function addVar() {
  draft.config.var.push({
    key: `var_${draft.config.var.length + 1}`,
    type: "int",
    name: "变量",
    descripts: "",
    defaultText: "",
    optionsText: "",
    minText: "",
    maxText: "",
  });
  varCollapseActiveNames.value.push(draft.config.var.length - 1);
}

function removeVar(idx: number) {
  draft.config.var.splice(idx, 1);
}

function clearFinishedTasks() {
  void (async () => {
    try {
      const cleared = await invoke<number>("clear_finished_tasks");
      consoleText.value = `已清除 ${cleared} 个已结束任务`;
    } catch (e) {
      ElMessage.error(`清除失败：${String(e)}`);
    } finally {
      await loadTasksFromBackend();
    }
  })();
}

async function cancelTask(taskId: string) {
  // 测试任务：只做本地取消（不保证能中断后端脚本执行）
  const idxLocal = tasks.value.findIndex((t) => t.id === taskId);
  if (idxLocal !== -1 && (tasks.value[idxLocal].status === "pending" || tasks.value[idxLocal].status === "running")) {
    tasks.value[idxLocal] = {
      ...tasks.value[idxLocal],
      status: "canceled",
      endTime: Date.now(),
      error: "Task canceled",
    };
    // 同时尝试通知后端取消（若该 taskId 参与 download_queue，会尽快停止后续下载）
    try {
      await invoke("cancel_task", { taskId });
    } catch {
      // ignore
    }
    return;
  }

  try {
    await invoke("cancel_task", { taskId });
  } catch (e) {
    ElMessage.error(`取消失败：${String(e)}`);
  }
}

function openTaskImages(taskId: string) {
  taskImagesDialogTaskId.value = taskId;
  taskImagesDialogVisible.value = true;
}

async function deleteTask(taskId: string) {
  try {
    await ElMessageBox.confirm("确定要删除这个任务吗？（不会删除图片，只解除关联）", "确认删除", { type: "warning" });
  } catch {
    return;
  }
  try {
    await invoke("delete_task", { taskId });
    ElMessage.success("任务已删除");
  } catch (e) {
    ElMessage.error(`删除失败：${String(e)}`);
  } finally {
    await loadTasksFromBackend();
  }
}

async function loadTasksFromBackend() {
  try {
    const all = await invoke<any[]>("get_all_tasks");
    if (Array.isArray(all)) {
      tasks.value = all.map((t) => ({
        id: String(t.id),
        pluginId: String(t.pluginId || t.plugin_id || "unknown"),
        status: (t.status as TaskStatus) || "pending",
        progress: Number(t.progress ?? 0),
        startTime: t.startTime ?? t.start_time,
        endTime: t.endTime ?? t.end_time,
        error: t.error ?? undefined,
      }));
    }
  } catch {
    // ignore
  }
}

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function buildConfigForBackend(): { config: { baseUrl?: string; var?: VarDefinition[] } } {
  const vars: VarDefinition[] = draft.config.var.map((v) => {
    const def: VarDefinition = {
      key: v.key.trim(),
      type: v.type,
      name: v.name,
      descripts: v.descripts?.trim() || undefined,
    };
    const d = tryParseJson(v.defaultText);
    const min = tryParseJson(v.minText);
    const max = tryParseJson(v.maxText);
    const opts = tryParseJson(v.optionsText);

    if (d !== undefined) def.default = d;
    if (min !== undefined) def.min = min;
    if (max !== undefined) def.max = max;
    if (Array.isArray(opts)) def.options = opts as VarOption[];
    return def;
  });

  const baseUrl = draft.config.baseUrl?.trim();
  return {
    config: {
      baseUrl: baseUrl || undefined,
      var: vars.length ? vars : undefined,
    },
  };
}

function buildUserConfigForBackend(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of draft.config.var) {
    const key = v.key.trim();
    if (!key) continue;
    const val = tryParseJson(testInputText[key] ?? "");
    if (val !== undefined) out[key] = val;
  }
  return out;
}

const checkScript = useDebounceFn(async () => {
  try {
    const diags = await invoke<EditorMarker[]>("plugin_editor_check_rhai", {
      script: draft.script,
    });
    markers.value = diags;
  } catch (e) {
    // 后端检查失败时不打断编辑体验：只清空 marker
    markers.value = [];
  }
}, 400);

watch(
  () => draft.script,
  () => {
    void checkScript();
  },
  { immediate: true }
);

async function runTest() {
  isTesting.value = true;
  consoleText.value = "";

  try {
    const { config } = buildConfigForBackend();

    const userConfig = buildUserConfigForBackend();

    // 与 main 一致：合并落库 + 入队（状态/进度由后端事件驱动）
    const pluginId = draft.id.trim() || "plugin-editor-test";
    const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingFinishPopup.add(taskId);

    const startTime = Date.now();

    // 先将任务添加到本地列表，避免后端事件到达时因找不到任务而创建 pluginId: "unknown" 的条目
    tasks.value.unshift({
      id: taskId,
      pluginId,
      status: "pending",
      progress: 0,
      startTime,
    });

    await invoke("start_task", {
      task: {
        id: taskId,
        pluginId,
        outputDir: null,
        userConfig,
        outputAlbumId: null,
        status: "pending",
        progress: 0,
        deletedCount: 0,
        startTime: Date.now(),
        endTime: null,
        error: null,
      },
      manifest: draft.manifest,
      config,
      script: draft.script,
      iconRgbBase64: iconRgbBase64.value,
    });

    consoleText.value = `任务已加入队列：${taskId}`;
  } catch (e) {
    consoleText.value = String(e);
    ElMessage.error(`测试失败：${String(e)}`);
  } finally {
    isTesting.value = false;
  }
}

async function exportKgpg() {
  if (!draft.id.trim()) {
    ElMessage.error("请填写插件ID");
    return;
  }

  isExporting.value = true;
  try {
    const path = await save({
      title: "导出插件包（.kgpg）",
      defaultPath: `${draft.id.trim()}.kgpg`,
      filters: [{ name: "Kabegame Plugin", extensions: ["kgpg"] }],
    });
    if (!path) return;

    const { config } = buildConfigForBackend();
    await invoke("plugin_editor_export_kgpg", {
      outputPath: path,
      pluginId: draft.id.trim(),
      manifest: draft.manifest,
      config,
      script: draft.script,
      iconRgbBase64: iconRgbBase64.value,
    });
    ElMessage.success("导出成功");
  } catch (e) {
    ElMessage.error(`导出失败：${String(e)}`);
  } finally {
    isExporting.value = false;
  }
}

onMounted(async () => {
  // 关闭确认退出
  try {
    const win = getCurrentWebviewWindow();
    await win.onCloseRequested(async (event) => {
      // 阻止默认关闭行为
      event.preventDefault();
      try {
        await ElMessageBox.confirm("确定要退出插件编辑器吗？所做更改不会保存", "确认退出", {
          type: "warning",
          confirmButtonText: "退出",
          cancelButtonText: "取消",
        });
        // 用户确认退出：优先让后端直接退出整个进程，避免前端 close/destroy 在此事件里失效或循环触发
        try {
          await invoke("plugin_editor_exit_app");
          return;
        } catch (e) {
          console.error("[plugin-editor] invoke(plugin_editor_exit_app) 失败，将尝试关闭窗口：", e);
        }

        // 兜底：尝试关闭窗口（不同平台 / 不同 Tauri API 版本可能表现不同）
        try {
          await win.close();
        } catch (e) {
          console.error("[plugin-editor] win.close() 失败：", e);
        }
      } catch {
        // 用户取消：不做任何操作（窗口保持打开）
      }
    });
  } catch {
    // 非 Tauri 环境忽略
  }

  // 任务事件监听（复用主程序事件协议）
  unlistenTaskStatus = await listen<{
    taskId: string;
    status: TaskStatus;
    startTime?: number;
    endTime?: number;
    error?: string;
  }>("task-status", (event) => {
    const idx = tasks.value.findIndex((t) => t.id === event.payload.taskId);
    if (idx === -1) {
      tasks.value.unshift({
        id: event.payload.taskId,
        pluginId: "unknown",
        status: event.payload.status,
        progress: event.payload.status === "completed" ? 100 : 0,
        startTime: event.payload.startTime,
        endTime: event.payload.endTime,
        error: event.payload.error,
      });
    } else {
      const cur = tasks.value[idx];
      tasks.value[idx] = {
        ...cur,
        status: event.payload.status,
        startTime: event.payload.startTime ?? cur.startTime,
        endTime: event.payload.endTime ?? cur.endTime,
        error: event.payload.error ?? cur.error,
        progress: event.payload.status === "completed" ? 100 : cur.progress ?? 0,
      };
    }

    // 结束弹窗：仅对本次点击"测试"发起的任务提示一次
    if (
      (event.payload.status === "completed" ||
        event.payload.status === "failed" ||
        event.payload.status === "canceled") &&
      pendingFinishPopup.has(event.payload.taskId)
    ) {
      pendingFinishPopup.delete(event.payload.taskId);
      const msg =
        event.payload.status === "completed"
          ? "任务已完成"
          : event.payload.status === "canceled"
            ? "任务已取消"
            : "任务已失败";
      if (event.payload.status === "completed") {
        void ElMessage.success(msg);
      } else if (event.payload.status === "canceled") {
        void ElMessage.warning(msg);
      } else {
        void ElMessage.error(msg);
      }
    }
  });

  unlistenTaskProgress = await listen<{ taskId: string; progress: number }>(
    "task-progress",
    (event) => {
      const idx = tasks.value.findIndex((t) => t.id === event.payload.taskId);
      if (idx === -1) {
        tasks.value.unshift({
          id: event.payload.taskId,
          pluginId: "unknown",
          status: "running",
          progress: event.payload.progress,
          startTime: Date.now(),
        });
        return;
      }
      const cur = tasks.value[idx];
      const newProgress = event.payload.progress;
      if (newProgress <= (cur.progress ?? 0)) return;

      const now = Date.now();
      const lastAt = lastProgressUpdateAt.get(event.payload.taskId) ?? 0;
      if (newProgress < 100 && now - lastAt < 100) return;
      lastProgressUpdateAt.set(event.payload.taskId, now);

      tasks.value[idx] = { ...cur, progress: newProgress };
    }
  );

  unlistenTaskError = await listen<{ taskId: string; error: string }>(
    "task-error",
    (event) => {
      const idx = tasks.value.findIndex((t) => t.id === event.payload.taskId);
      if (idx === -1) {
        const isCanceled = String(event.payload.error || "").includes("Task canceled");
        tasks.value.unshift({
          id: event.payload.taskId,
          pluginId: "unknown",
          status: isCanceled ? "canceled" : "failed",
          progress: 0,
          startTime: Date.now(),
          endTime: Date.now(),
          error: event.payload.error,
        });
        return;
      }
      const cur = tasks.value[idx];
      const isCanceled = String(event.payload.error || "").includes("Task canceled");
      tasks.value[idx] = {
        ...cur,
        status: isCanceled ? "canceled" : "failed",
        error: event.payload.error,
        endTime: Date.now(),
      };
    }
  );

  // 启动时恢复历史任务（与 main 一致：任务持久化在 SQLite）
  await loadTasksFromBackend();
});

onBeforeUnmount(() => {
  try {
    unlistenTaskStatus?.();
    unlistenTaskProgress?.();
    unlistenTaskError?.();
  } catch {
    // ignore
  }
});
</script>

<style scoped lang="scss">
.plugin-editor-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 16px;
  background: var(--anime-bg-main);
}

.plugin-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--anime-border);
  margin-bottom: 16px;

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--anime-text-primary);
  }

  .header-actions {
    display: flex;
    gap: 12px;
  }
}

.plugin-editor-content {
  flex: 1;
  overflow: hidden;
}

.layout {
  display: grid;
  grid-template-columns: 400px 1fr 400px;
  gap: 16px;
  height: 100%;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding-right: 8px;
}

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
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
  color: var(--anime-text-primary);

  .header-icon {
    font-size: 18px;
    color: var(--anime-primary);
  }

  .add-var-btn {
    margin-left: auto;
  }

  .clear-btn {
    margin-left: auto;
  }

  .marker-badge {
    margin-left: auto;
  }
}

.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  .task-header-stats {
    display: flex;
    gap: 8px;
  }
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

/* 编辑器区域 */
.editor-area {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
}

.editor-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  // 移除悬浮时的运动效果
  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
    flex-shrink: 0;
  }

  :deep(.el-card__body) {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}

.editor-wrapper {
  flex: 1;
  min-height: 0;
  overflow: visible;
}

.console-card {
  height: 250px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;

  // 移除悬浮时的运动效果
  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 12px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
  }

  :deep(.el-card__body) {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}

.console-wrapper {
  flex: 1;
  overflow: auto;
  padding: 16px 20px;
}

.console-body {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--anime-text-primary);
  background: rgba(0, 0, 0, 0.02);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--anime-border);
}

/* 任务区域 */
.task-area {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.task-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
    flex-shrink: 0;
  }

  :deep(.el-card__body) {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}

.task-card-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
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

/* 空状态优化 */
:deep(.el-empty__description) {
  color: var(--anime-text-muted);
}

/* Icon 选择器 */
.icon-picker {
  width: 80px;
  height: 80px;
  border: 2px dashed var(--anime-border);
  border-radius: 12px;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.3s ease;
  position: relative;

  &:hover {
    border-color: var(--anime-primary);
    background: rgba(255, 107, 157, 0.05);
  }
}

.icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.02);
}

.icon-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
