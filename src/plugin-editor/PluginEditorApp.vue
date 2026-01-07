<template>
  <div class="plugin-editor-root">
    <!-- 使用 PageHeader 组件 -->
    <PageHeader title="插件编辑器" subtitle="内存编辑 · Rhai 诊断/补全 · 导出为 .kgpg">
      <el-button :loading="isTesting" @click="runTest">
        <el-icon>
          <VideoPlay />
        </el-icon>
        测试
      </el-button>
      <el-button type="success" :loading="isRunning" @click="runReal">
        <el-icon>
          <Monitor />
        </el-icon>
        运行（任务）
      </el-button>
      <el-button type="primary" :loading="isExporting" @click="exportKgpg">
        <el-icon>
          <Download />
        </el-icon>
        导出 .kgpg
      </el-button>
    </PageHeader>

    <div class="plugin-editor-content">
      <div class="layout">
        <!-- 侧边栏 -->
        <div class="sidebar">
          <!-- 包信息卡片 -->
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Document />
                </el-icon>
                <span>包信息</span>
              </div>
            </template>
            <el-form label-width="90px" size="default">
              <!-- Icon 选择区域 -->
              <el-form-item label="图标">
                <div class="icon-picker" @click="selectIcon">
                  <div v-if="iconPreviewUrl" class="icon-preview">
                    <img :src="iconPreviewUrl" alt="插件图标" />
                    <div class="icon-overlay">
                      <el-icon>
                        <Picture />
                      </el-icon>
                      <span>更换</span>
                    </div>
                  </div>
                  <div v-else class="icon-placeholder">
                    <el-icon>
                      <Picture />
                    </el-icon>
                    <span>选择图标</span>
                  </div>
                </div>
                <div class="icon-hint">128×128 PNG/JPG</div>
              </el-form-item>

              <el-form-item label="插件ID">
                <el-input v-model="draft.id" placeholder="用于文件名：xxx.kgpg" clearable>
                  <template #prefix>
                    <el-icon>
                      <Key />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>

              <el-form-item label="名称">
                <el-input v-model="draft.manifest.name" clearable>
                  <template #prefix>
                    <el-icon>
                      <EditPen />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>

              <el-form-item label="版本">
                <el-input v-model="draft.manifest.version" clearable>
                  <template #prefix>
                    <el-icon>
                      <PriceTag />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>

              <el-form-item label="作者">
                <el-input v-model="draft.manifest.author" clearable>
                  <template #prefix>
                    <el-icon>
                      <User />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>

              <el-form-item label="描述">
                <el-input v-model="draft.manifest.description" type="textarea" :rows="3" clearable
                  placeholder="插件功能描述..." />
              </el-form-item>
            </el-form>
          </el-card>

          <!-- 配置卡片 -->
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Setting />
                </el-icon>
                <span>配置</span>
              </div>
            </template>
            <el-form label-width="90px" size="default">
              <el-form-item label="baseUrl">
                <el-input v-model="draft.config.baseUrl" placeholder="可选，基础URL" clearable>
                  <template #prefix>
                    <el-icon>
                      <Link />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>
            </el-form>
          </el-card>

          <!-- 变量卡片 -->
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <List />
                </el-icon>
                <span>变量（var）</span>
                <el-button size="small" type="primary" plain @click="addVar" class="add-var-btn">
                  <el-icon>
                    <Plus />
                  </el-icon>
                  新增
                </el-button>
              </div>
            </template>

            <el-empty v-if="draft.config.var.length === 0" description="暂无变量定义" :image-size="80" />

            <el-collapse v-else accordion class="var-collapse">
              <el-collapse-item v-for="(v, idx) in draft.config.var" :key="idx" :name="idx">
                <template #title>
                  <div class="var-title">
                    <el-tag :type="getVarTypeTag(v.type)" size="small">{{ v.type }}</el-tag>
                    <span class="var-key">{{ v.key || '未命名' }}</span>
                    <span v-if="v.name" class="var-name">{{ v.name }}</span>
                  </div>
                </template>
                <el-form label-width="90px" size="default">
                  <el-form-item label="key">
                    <el-input v-model="v.key" placeholder="变量键名" clearable />
                  </el-form-item>
                  <el-form-item label="type">
                    <el-select v-model="v.type" style="width: 100%" placeholder="选择类型">
                      <el-option label="int" value="int" />
                      <el-option label="float" value="float" />
                      <el-option label="options" value="options" />
                      <el-option label="checkbox" value="checkbox" />
                      <el-option label="boolean" value="boolean" />
                      <el-option label="list" value="list" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="name">
                    <el-input v-model="v.name" placeholder="显示名称" clearable />
                  </el-form-item>
                  <el-form-item label="descripts">
                    <el-input v-model="v.descripts" placeholder="描述说明" clearable />
                  </el-form-item>
                  <el-form-item label="default">
                    <el-input v-model="v.defaultText" placeholder='用 JSON 表达，例如 1 / "abc" / true' clearable />
                  </el-form-item>
                  <el-form-item v-if="v.type === 'int' || v.type === 'float'" label="min">
                    <el-input v-model="v.minText" placeholder="JSON number" clearable />
                  </el-form-item>
                  <el-form-item v-if="v.type === 'int' || v.type === 'float'" label="max">
                    <el-input v-model="v.maxText" placeholder="JSON number" clearable />
                  </el-form-item>
                  <el-form-item v-if="v.type === 'options' || v.type === 'checkbox'" label="options">
                    <el-input v-model="v.optionsText" type="textarea" :rows="3"
                      placeholder='JSON：["a","b"] 或 [{"name":"桌面","variable":"imgpc"}]' clearable />
                  </el-form-item>

                  <el-form-item>
                    <el-button type="danger" size="small" @click="removeVar(idx)">
                      <el-icon>
                        <Delete />
                      </el-icon>
                      删除变量
                    </el-button>
                  </el-form-item>
                </el-form>
              </el-collapse-item>
            </el-collapse>
          </el-card>

          <!-- 测试输入卡片 -->
          <el-card v-if="draft.config.var.length > 0" class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Tools />
                </el-icon>
                <span>测试输入</span>
              </div>
            </template>
            <el-form label-width="90px" size="default">
              <el-form-item v-for="(v, idx) in draft.config.var" :key="`test-${idx}`" :label="v.key || `var${idx}`">
                <el-input v-model="testInputText[v.key]" placeholder="JSON 值（留空=使用 default）" clearable />
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

          <!-- 输出 / 任务（右侧常驻） -->
          <el-card class="console-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon">
                  <Monitor />
                </el-icon>
                <span>输出 / 任务</span>
                <el-button v-if="consoleText" size="small" text @click="consoleText = ''" class="clear-btn">
                  <el-icon>
                    <Close />
                  </el-icon>
                  清空
                </el-button>
              </div>
            </template>
            <div class="console-wrapper">
              <el-tabs class="console-tabs">
                <el-tab-pane label="输出" name="output">
                  <pre class="console-body">{{ consoleText || "（空）" }}</pre>
                </el-tab-pane>
                <el-tab-pane :label="`任务(${activeTasksCount})`" name="tasks">
                  <TaskPanel :tasks="tasks" :active-downloads="activeDownloads" :active-tasks-count="activeTasksCount"
                    :finished-tasks-count="finishedTasksCount" @cancel-task="cancelTask"
                    @clear-finished="clearFinishedTasks" @refresh-downloads="refreshActiveDownloads" />
                </el-tab-pane>
              </el-tabs>
            </div>
          </el-card>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  VideoPlay,
  Download,
  Document,
  Key,
  EditPen,
  PriceTag,
  User,
  Setting,
  Link,
  List,
  Plus,
  Delete,
  Tools,
  DocumentCopy,
  Monitor,
  Close,
  Picture,
} from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useDebounceFn } from "@vueuse/core";
import RhaiEditor from "./components/RhaiEditor.vue";
import TaskPanel from "./components/TaskPanel.vue";
import PageHeader from "@/components/common/PageHeader.vue";

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
const isRunning = ref(false);
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

type ActiveDownloadInfo = {
  url: string;
  plugin_id: string;
  task_id: string;
  state: string;
  start_time: number;
};

const tasks = ref<ScriptTask[]>([]);
const activeDownloads = ref<ActiveDownloadInfo[]>([]);
const lastProgressUpdateAt = new Map<string, number>();

const activeTasksCount = computed(
  () => tasks.value.filter((t) => t.status === "pending" || t.status === "running").length
);
const finishedTasksCount = computed(
  () => tasks.value.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "canceled").length
);

let unlistenTaskStatus: (() => void) | null = null;
let unlistenTaskProgress: (() => void) | null = null;
let unlistenTaskError: (() => void) | null = null;
let activeDownloadsTimer: number | null = null;

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
}

async function refreshActiveDownloads() {
  try {
    const list = await invoke<ActiveDownloadInfo[]>("get_active_downloads");
    activeDownloads.value = list ?? [];
  } catch {
    activeDownloads.value = [];
  }
}

function startActiveDownloadsPolling() {
  if (activeDownloadsTimer != null) return;
  activeDownloadsTimer = window.setInterval(() => {
    void refreshActiveDownloads();
  }, 600);
}

function stopActiveDownloadsPolling() {
  if (activeDownloadsTimer != null) {
    window.clearInterval(activeDownloadsTimer);
    activeDownloadsTimer = null;
  }
}

function clearFinishedTasks() {
  tasks.value = tasks.value.filter((t) => t.status === "pending" || t.status === "running");
}

async function cancelTask(taskId: string) {
  try {
    await invoke("cancel_task", { taskId });
  } catch (e) {
    ElMessage.error(`取消失败：${String(e)}`);
  }
}

function removeVar(idx: number) {
  draft.config.var.splice(idx, 1);
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
    const res = await invoke<{ logs: string[]; downloadedUrls: string[] }>("plugin_editor_test_rhai", {
      script: draft.script,
      varDefs: config.var ?? [],
      userConfig,
    });

    const lines: string[] = [];
    lines.push(...(res.logs || []));
    if ((res.downloadedUrls || []).length) {
      lines.push("");
      lines.push(`[download_image] 共 ${res.downloadedUrls.length} 个 URL：`);
      for (const u of res.downloadedUrls) lines.push(`- ${u}`);
    }
    consoleText.value = lines.join("\n");
  } catch (e) {
    consoleText.value = String(e);
    ElMessage.error(`测试失败：${String(e)}`);
  } finally {
    isTesting.value = false;
  }
}

async function runReal() {
  if (!draft.id.trim()) {
    ElMessage.error("请先填写插件ID（用于任务识别）");
    return;
  }
  isRunning.value = true;
  try {
    const { config } = buildConfigForBackend();
    const userConfig = buildUserConfigForBackend();
    const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tasks.value.unshift({
      id: taskId,
      pluginId: draft.id.trim(),
      status: "pending",
      progress: 0,
      startTime: Date.now(),
    });
    startActiveDownloadsPolling();
    await invoke("plugin_editor_run_task", {
      pluginId: draft.id.trim(),
      taskId,
      manifest: draft.manifest,
      config,
      script: draft.script,
      iconRgbBase64: iconRgbBase64.value,
      userConfig,
      // outputDir/outputAlbumId 目前由后端 settings 默认值兜底；之后可加 UI 选择
    });
    ElMessage.success("任务已加入队列");
  } catch (e) {
    ElMessage.error(`运行失败：${String(e)}`);
  } finally {
    isRunning.value = false;
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
  // 关闭确认退出（本窗口不常驻托盘）
  try {
    const win = getCurrentWebviewWindow();
    let exiting = false;
    await win.onCloseRequested(async (event) => {
      if (exiting) return;
      event.preventDefault();
      try {
        await ElMessageBox.confirm("确定要退出插件编辑器吗？", "确认退出", {
          type: "warning",
          confirmButtonText: "退出",
          cancelButtonText: "取消",
        });
        exiting = true;
        await win.close();
      } catch {
        // 用户取消
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
    if (idx === -1) return;
    const cur = tasks.value[idx];
    tasks.value[idx] = {
      ...cur,
      status: event.payload.status,
      startTime: event.payload.startTime ?? cur.startTime,
      endTime: event.payload.endTime ?? cur.endTime,
      error: event.payload.error ?? cur.error,
      progress: event.payload.status === "completed" ? 100 : cur.progress ?? 0,
    };
    if (event.payload.status === "completed" || event.payload.status === "failed" || event.payload.status === "canceled") {
      if (activeTasksCount.value === 0) stopActiveDownloadsPolling();
    }
  });

  unlistenTaskProgress = await listen<{ taskId: string; progress: number }>(
    "task-progress",
    (event) => {
      const idx = tasks.value.findIndex((t) => t.id === event.payload.taskId);
      if (idx === -1) return;
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
      if (idx === -1) return;
      const cur = tasks.value[idx];
      const isCanceled = String(event.payload.error || "").includes("Task canceled");
      tasks.value[idx] = {
        ...cur,
        status: isCanceled ? "canceled" : "failed",
        error: event.payload.error,
        endTime: Date.now(),
      };
      if (activeTasksCount.value === 0) stopActiveDownloadsPolling();
    }
  );
});

onBeforeUnmount(() => {
  try {
    unlistenTaskStatus?.();
    unlistenTaskProgress?.();
    unlistenTaskError?.();
  } catch { }
  stopActiveDownloadsPolling();
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

.plugin-editor-content {
  flex: 1;
  overflow: hidden;
  margin-top: 16px;
}

.layout {
  display: grid;
  grid-template-columns: 400px 1fr;
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
  overflow: hidden;
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

.console-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.console-tabs .el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--anime-text-muted);

  .el-icon {
    font-size: 24px;
  }

  span {
    font-size: 11px;
  }
}

.icon-preview {
  width: 100%;
  height: 100%;
  position: relative;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .icon-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.2s ease;
    color: #fff;

    .el-icon {
      font-size: 20px;
    }

    span {
      font-size: 11px;
    }
  }

  &:hover .icon-overlay {
    opacity: 1;
  }
}

.icon-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--anime-text-muted);
}

.task-badge {
  margin-left: 8px;
}
</style>