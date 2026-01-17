<template>
  <div class="plugin-editor-root">
    <!-- Daemon 启动错误页面 -->
    <DaemonStartupError
      v-if="daemonError"
      :error="daemonError.error"
      :daemon-path="daemonError.daemon_path"
    />
    <template v-else>
    <FileDropOverlay ref="fileDropOverlayRef" />
    <div class="plugin-editor-header">
      <div class="header-left">
        <h1>插件编辑器</h1>
        <el-select v-model="editorTheme" class="theme-select" size="small" placeholder="主题">
          <el-option label="Monaco：浅色 (vs)" value="vs" />
          <el-option label="Monaco：深色 (vs-dark)" value="vs-dark" />
          <el-option label="Monaco：高对比黑 (hc-black)" value="hc-black" />
          <el-option label="Monaco：高对比白 (hc-light)" value="hc-light" />
          <el-option label="Kabegame：GitHub Dark" value="kabegame-github-dark" />
          <el-option label="Kabegame：GitHub Light" value="kabegame-github-light" />
          <el-option label="Kabegame：Dracula" value="kabegame-dracula" />
          <el-option label="Kabegame：Night Owl" value="kabegame-night-owl" />
          <el-option label="Kabegame：Solarized Dark" value="kabegame-solarized-dark" />
          <el-option label="Kabegame：Solarized Light" value="kabegame-solarized-light" />
        </el-select>
      </div>
      <div class="header-actions">
        <el-button class="settings-btn" @click="openQuickSettings">
          <el-icon>
            <Setting />
          </el-icon>
          设置
        </el-button>
        <el-button type="primary" :loading="isTesting" @click="runTest">测试</el-button>
        <el-dropdown split-button type="info" :loading="isImporting" @click="importFromFile" @command="onImportCommand"
          @visible-change="onImportDropdownVisibleChange">
          导入
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="import-file">从 .kgpg 文件导入…</el-dropdown-item>
              <el-dropdown-item divided disabled class="submenu-title">
                <span>已安装的插件</span>
                <el-icon v-if="isLoadingInstalledPlugins" class="is-loading">
                  <Loading />
                </el-icon>
              </el-dropdown-item>
              <template v-if="installedPlugins.length > 0">
                <el-dropdown-item v-for="p in installedPlugins" :key="p.id" :command="`import-plugin:${p.id}`">
                  <div class="plugin-option">
                    <img v-if="pluginIcons[p.id]" :src="pluginIcons[p.id]" class="plugin-option-icon" />
                    <el-icon v-else class="plugin-option-icon-placeholder">
                      <Grid />
                    </el-icon>
                    <span>{{ p.name }}</span>
                  </div>
                </el-dropdown-item>
              </template>
              <el-dropdown-item v-else disabled>
                <span class="no-plugins-hint">暂无已安装插件</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown split-button type="success" :loading="isExporting" @click="exportKgpgFile"
          @command="onExportCommand">
          导出
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="export-file">导出为 .kgpg 文件…</el-dropdown-item>
              <el-dropdown-item command="export-install">导出并安装到用户目录</el-dropdown-item>
              <el-dropdown-item command="export-folder">导出为文件夹…</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="plugin-editor-content">
      <div class="layout">
        <!-- 左侧插件信息编辑区 -->
        <div class="sidebar">
          <!-- 插件基本信息 -->
          <PluginInfoCard :plugin-id="draft.id" :manifest="draft.manifest" :icon-preview-url="iconPreviewUrl"
            @select-icon="selectIcon" @update:plugin-id="draft.id = $event"
            @update:manifest="draft.manifest = $event" />

          <!-- 配置信息 -->
          <PluginConfigCard :base-url="draft.config.baseUrl" @update:base-url="draft.config.baseUrl = $event" />

          <!-- 变量管理 -->
          <PluginVarsCard :vars="draft.config.var" :test-input-text="testInputText"
            :collapse-active-names="varCollapseActiveNames" @add-var="addVar" @remove-var="removeVar"
            @use-default-as-test-value="useDefaultAsTestValue" @clear-test-value="clearTestValue"
            @update:collapse-active-names="varCollapseActiveNames = $event" />
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
              <RhaiEditor v-model="draft.script" :markers="markers" :user-vars="editorUserVars"
                :base-url="draft.config.baseUrl" :theme="editorTheme" />
            </div>
          </el-card>

          <!-- 输出区 -->
          <ConsoleCard :console-text="consoleText" @clear="consoleText = ''" />
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
                @cancel-task="cancelTask" @confirm-task-dump="confirmTaskDump" />
            </div>
          </el-card>
      </div>
    </div>
  </div>

  <QuickSettingsDrawer />
  <TaskImagesDialog v-model="taskImagesDialogVisible" :task-id="taskImagesDialogTaskId" />
  <IconCropDialog v-model="iconCropDialogVisible" :src="iconCropSourceUrl" @confirm="onIconCropConfirm" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { DocumentCopy, Loading, Grid } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useDebounceFn } from "@vueuse/core";
import RhaiEditor from "./components/RhaiEditor.vue";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import TaskImagesDialog from "./components/TaskImagesDialog.vue";
import IconCropDialog from "./components/IconCropDialog.vue";
import TaskDrawerContent from "@kabegame/core/components/task/TaskDrawerContent.vue";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";
import PluginInfoCard from "./components/PluginInfoCard.vue";
import PluginConfigCard from "./components/PluginConfigCard.vue";
import PluginVarsCard from "./components/PluginVarsCard.vue";
import ConsoleCard from "./components/ConsoleCard.vue";
import DaemonStartupError from "@kabegame/core/components/common/DaemonStartupError.vue";
import { useQuickSettingsDrawerStore } from "./stores/quick-settings-drawer";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useInstalledPluginsStore } from "@kabegame/core/stores/plugins";
import { useDaemonStatus } from "@kabegame/core/composables/useDaemonStatus";

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

type ImportResult = {
  pluginId: string;
  manifest: PluginManifest;
  config: { baseUrl?: string; var?: VarDefinition[] };
  script: string;
  iconRgbBase64?: string | null;
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
// 当前"输出面板"绑定的 taskId：只展示本次点击"测试"触发的任务日志
const activeConsoleTaskId = ref<string>("");
const isTesting = ref(false);
const isExporting = ref(false);
const isImporting = ref(false);
const isAutosaving = ref(false);
const autosaveDirty = ref(false);
const markers = ref<EditorMarker[]>([]);

// Daemon 状态管理
const { init: initDaemonStatus, daemonError } = useDaemonStatus();

// Icon 相关
const iconPreviewUrl = ref<string | null>(null);
const iconRgbBase64 = ref<string | null>(null);
const iconCropDialogVisible = ref(false);
const iconCropSourceUrl = ref<string>("");
let iconCropOwnedBlobUrl: string | null = null;

// 按变量索引保存测试值（JSON 文本）；不参与导出，只用于“测试”时注入 user_config
const testInputText = ref<string[]>([]);

type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  status: TaskStatus;
  progress: number;
  startTime?: number;
  endTime?: number;
  error?: string;
  rhaiDumpPresent?: boolean;
  rhaiDumpConfirmed?: boolean;
  rhaiDumpCreatedAt?: number;
};

const tasks = ref<ScriptTask[]>([]);
const lastProgressUpdateAt = new Map<string, number>();

const taskImagesDialogVisible = ref(false);
const taskImagesDialogTaskId = ref("");

// 仅对"本次点击测试发起的任务"弹出结束提示（避免重启恢复的历史任务也弹）
const pendingFinishPopup = new Set<string>();

const activeTasksCount = computed(
  () => tasks.value.filter((t) => t.status === "pending" || t.status === "running").length
);

const varCollapseActiveNames = ref<number[]>([]);

const editorUserVars = computed(() =>
  (draft.config.var || []).map((v) => ({
    key: v.key?.trim() || "",
    type: v.type,
    name: v.name,
    descripts: v.descripts,
    default: tryParseJson(v.defaultText),
  }))
);

let unlistenTaskStatus: (() => void) | null = null;
let unlistenTaskProgress: (() => void) | null = null;
let unlistenTaskError: (() => void) | null = null;
let unlistenTaskLog: (() => void) | null = null;

// 导入（已安装列表）- 使用共用 store
const installedPluginsStore = useInstalledPluginsStore();
const installedPlugins = computed(() => installedPluginsStore.plugins);
const isLoadingInstalledPlugins = computed(() => installedPluginsStore.isLoading);
const pluginIcons = computed(() => installedPluginsStore.icons);

// 文件拖拽提示层引用
const fileDropOverlayRef = ref<InstanceType<typeof FileDropOverlay> | null>(null);

// 编辑器主题（不持久化）
const editorTheme = ref<string>("kabegame-github-dark");
let fileDropUnlisten: (() => void) | null = null;
let autosaveIntervalTimer: number | null = null;

const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("plugin-editor");


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

function detectMime(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  let mimeType = "image/jpeg";
  if (ext === "png") mimeType = "image/png";
  else if (ext === "gif") mimeType = "image/gif";
  else if (ext === "webp") mimeType = "image/webp";
  else if (ext === "bmp") mimeType = "image/bmp";
  return mimeType;
}

async function pathToBlobUrl(path: string): Promise<string> {
  const p = (path || "").trim();
  if (!p) return "";
  // 移除 Windows 长路径前缀 \\?\
  const normalizedPath = p.trimStart().replace(/^\\\\\?\\/, "").trim();
  if (!normalizedPath) return "";
  const fileData = await readFile(normalizedPath);
  if (!fileData || fileData.length === 0) return "";
  const blob = new Blob([fileData], { type: detectMime(normalizedPath) });
  if (blob.size === 0) return "";
  return URL.createObjectURL(blob);
}

function blobToBase64Bytes(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取 blob 失败"));
    reader.onload = () => {
      const s = String(reader.result || "");
      const idx = s.indexOf("base64,");
      if (idx < 0) return reject(new Error("base64 解析失败"));
      resolve(s.slice(idx + "base64,".length));
    };
    reader.readAsDataURL(blob);
  });
}

function cleanupIconCropSource() {
  iconCropSourceUrl.value = "";
  if (iconCropOwnedBlobUrl) {
    try {
      URL.revokeObjectURL(iconCropOwnedBlobUrl);
    } catch {
      // ignore
    }
    iconCropOwnedBlobUrl = null;
  }
}

watch(iconCropDialogVisible, (v) => {
  if (!v) cleanupIconCropSource();
});

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
    cleanupIconCropSource();
    const url = await pathToBlobUrl(filePath);
    if (!url) {
      ElMessage.error("读取图片失败");
      return;
    }
    iconCropOwnedBlobUrl = url;
    iconCropSourceUrl.value = url;
    iconCropDialogVisible.value = true;
  } catch (e) {
    ElMessage.error(`加载图标失败：${String(e)}`);
  }
}

async function onIconCropConfirm(blob: Blob) {
  try {
    const b64 = await blobToBase64Bytes(blob);
    const rgb24Base64 = await invoke<string>("plugin_editor_process_icon_bytes", {
      imageBytesBase64: b64,
    });
    iconRgbBase64.value = rgb24Base64;
    iconPreviewUrl.value = rgb24ToDataUrl(rgb24Base64);
    iconCropDialogVisible.value = false;
    ElMessage.success("图标已裁剪");
  } catch (e) {
    ElMessage.error(`处理裁剪图标失败：${String(e)}`);
  }
}

function toJsonText(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function applyImportResult(res: ImportResult) {
  draft.id = res.pluginId || "my-plugin";
  draft.manifest = {
    name: res.manifest?.name ?? "",
    version: res.manifest?.version ?? "",
    description: res.manifest?.description ?? "",
    author: res.manifest?.author ?? "",
  };

  const baseUrl = res.config?.baseUrl ?? "";
  const vars = (res.config?.var ?? []).map((v) => ({
    key: v.key ?? "",
    type: v.type as VarDefinition["type"],
    name: v.name ?? "",
    descripts: (v.descripts as any) ?? "",
    defaultText: toJsonText(v.default),
    optionsText: toJsonText(v.options),
    minText: toJsonText(v.min),
    maxText: toJsonText(v.max),
  }));

  draft.config = {
    baseUrl,
    var: vars,
  };
  draft.script = res.script ?? "";

  // reset UI-only state
  testInputText.value = vars.map(() => "");
  varCollapseActiveNames.value = [];
  markers.value = [];

  // icon
  const b64 = res.iconRgbBase64 ?? null;
  iconRgbBase64.value = b64;
  iconPreviewUrl.value = b64 ? rgb24ToDataUrl(b64) : null;
}

async function autosaveNow(_reason: string) {
  if (isAutosaving.value) return;
  isAutosaving.value = true;
  try {
    const { config } = buildConfigForBackend();
    await invoke<string>("plugin_editor_autosave_save", {
      pluginId: draft.id.trim(),
      manifest: draft.manifest,
      config,
      script: draft.script,
      iconRgbBase64: iconRgbBase64.value,
    });
    autosaveDirty.value = false;
  } catch {
    // ignore
  } finally {
    isAutosaving.value = false;
  }
}

const scheduleAutosave = useDebounceFn(() => {
  if (!autosaveDirty.value) return;
  void autosaveNow("debounced");
}, 800);

watch(
  () => [draft.id, draft.manifest, draft.config, draft.script, iconRgbBase64.value],
  () => {
    autosaveDirty.value = true;
    scheduleAutosave();
  },
  { deep: true }
);

async function refreshInstalledPlugins() {
  await installedPluginsStore.loadPlugins("plugin_editor_list_installed_plugins");
}

/** 确认覆盖当前工作区弹窗 */
async function confirmImportOverwrite(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      "导入将覆盖当前编辑器中的所有内容（包括脚本、配置、图标等）。\n确定要继续吗？",
      "覆盖确认",
      { type: "warning", confirmButtonText: "继续导入", cancelButtonText: "取消" }
    );
    return true;
  } catch {
    return false;
  }
}

/** 导入下拉菜单可见性变化时刷新已安装插件列表 */
function onImportDropdownVisibleChange(visible: boolean) {
  if (visible) {
    void refreshInstalledPlugins();
  }
}

async function doImportInstalled(id: string) {
  isImporting.value = true;
  try {
    const res = await invoke<ImportResult>("plugin_editor_import_installed", { pluginId: id });
    applyImportResult(res);
    ElMessage.success(`已导入：${id}`);
    await autosaveNow("import-installed");
  } catch (e) {
    ElMessage.error(`导入失败：${String(e)}`);
  } finally {
    isImporting.value = false;
  }
}

async function importKgpgByPath(filePath: string, skipConfirm = false) {
  if (!skipConfirm && !(await confirmImportOverwrite())) return;

  isImporting.value = true;
  try {
    const res = await invoke<ImportResult>("plugin_editor_import_kgpg", { filePath });
    applyImportResult(res);
    ElMessage.success("导入成功");
    await autosaveNow("import-file");
  } catch (e) {
    ElMessage.error(`导入失败：${String(e)}`);
  } finally {
    isImporting.value = false;
  }
}

async function importFromFile() {
  if (!(await confirmImportOverwrite())) return;

  const selected = await open({
    title: "导入插件包（.kgpg）",
    filters: [{ name: "Kabegame Plugin", extensions: ["kgpg"] }],
    multiple: false,
  });
  if (!selected) return;
  const filePath = typeof selected === "string" ? selected : selected;
  await importKgpgByPath(filePath, true); // 已经确认过了
}

async function onImportCommand(cmd: string) {
  if (cmd === "import-file") {
    await importFromFile();
  } else if (cmd.startsWith("import-plugin:")) {
    const pluginId = cmd.slice("import-plugin:".length);
    if (pluginId) {
      if (!(await confirmImportOverwrite())) return;
      await doImportInstalled(pluginId);
    }
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
  testInputText.value.push("");
}

function removeVar(idx: number) {
  draft.config.var.splice(idx, 1);
  testInputText.value.splice(idx, 1);
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
        rhaiDumpPresent: Boolean(t.rhaiDumpPresent ?? t.rhai_dump_present),
        rhaiDumpConfirmed: Boolean(t.rhaiDumpConfirmed ?? t.rhai_dump_confirmed),
        rhaiDumpCreatedAt: t.rhaiDumpCreatedAt ?? t.rhai_dump_created_at,
      }));
    }
  } catch {
    // ignore
  }
}

async function confirmTaskDump(taskId: string) {
  try {
    await invoke("confirm_task_rhai_dump", { taskId });
    const idx = tasks.value.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      tasks.value[idx] = { ...tasks.value[idx], rhaiDumpConfirmed: true };
    }
    ElMessage.success("已确认");
  } catch (e) {
    ElMessage.error(`确认失败：${String(e)}`);
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
  for (const [idx, v] of draft.config.var.entries()) {
    const key = v.key.trim();
    if (!key) continue;
    const raw = (testInputText.value[idx] ?? "").trim();
    if (!raw) continue;
    const val = tryParseJson(raw);
    if (val === undefined) {
      throw new Error(`测试值 JSON 解析失败：${key}\n请输入合法 JSON，例如 "abc" / 123 / true / ["a","b"]`);
    }
    out[key] = val;
  }
  return out;
}

function useDefaultAsTestValue(idx: number) {
  const v = draft.config.var[idx];
  if (!v) return;
  const t = (v.defaultText ?? "").trim();
  testInputText.value[idx] = t;
}

function clearTestValue(idx: number) {
  testInputText.value[idx] = "";
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
    activeConsoleTaskId.value = taskId;
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
  } catch (e) {
    consoleText.value = String(e);
    ElMessage.error(`测试失败：${String(e)}`);
  } finally {
    isTesting.value = false;
  }
}

async function exportKgpgFile() {
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
    await autosaveNow("export-file");
  } catch (e) {
    ElMessage.error(`导出失败：${String(e)}`);
  } finally {
    isExporting.value = false;
  }
}

async function exportInstall() {
  if (!draft.id.trim()) {
    ElMessage.error("请填写插件ID");
    return;
  }
  isExporting.value = true;
  try {
    const { config } = buildConfigForBackend();
    try {
      await invoke("plugin_editor_export_install", {
        overwrite: false,
        pluginId: draft.id.trim(),
        manifest: draft.manifest,
        config,
        script: draft.script,
        iconRgbBase64: iconRgbBase64.value,
      });
    } catch (e) {
      if (String(e).includes("PLUGIN_EXISTS")) {
        try {
          await ElMessageBox.confirm(`用户插件目录已存在同名插件：${draft.id.trim()}.kgpg\n是否覆盖？`, "覆盖确认", {
            type: "warning",
            confirmButtonText: "覆盖",
            cancelButtonText: "取消",
          });
        } catch {
          return;
        }
        await invoke("plugin_editor_export_install", {
          overwrite: true,
          pluginId: draft.id.trim(),
          manifest: draft.manifest,
          config,
          script: draft.script,
          iconRgbBase64: iconRgbBase64.value,
        });
      } else {
        throw e;
      }
    }

    ElMessage.success("已安装到用户目录");
    await refreshInstalledPlugins();
    await autosaveNow("export-install");
  } catch (e) {
    ElMessage.error(`安装失败：${String(e)}`);
  } finally {
    isExporting.value = false;
  }
}

async function exportFolder() {
  if (!draft.id.trim()) {
    ElMessage.error("请填写插件ID");
    return;
  }
  isExporting.value = true;
  try {
    const selected = await open({
      title: "选择导出目录（将创建子文件夹）",
      directory: true,
      multiple: false,
    });
    if (!selected) return;
    const baseDir = typeof selected === "string" ? selected : selected;
    const outputDir = `${baseDir}\\${draft.id.trim()}`;
    const { config } = buildConfigForBackend();
    await invoke("plugin_editor_export_folder", {
      outputDir,
      manifest: draft.manifest,
      config,
      script: draft.script,
      iconRgbBase64: iconRgbBase64.value,
    });
    ElMessage.success("已导出为文件夹");
    await autosaveNow("export-folder");
  } catch (e) {
    ElMessage.error(`导出失败：${String(e)}`);
  } finally {
    isExporting.value = false;
  }
}

async function onExportCommand(cmd: "export-file" | "export-install" | "export-folder") {
  if (cmd === "export-file") {
    await exportKgpgFile();
  } else if (cmd === "export-install") {
    await exportInstall();
  } else if (cmd === "export-folder") {
    await exportFolder();
  }
}

onMounted(async () => {
  // 初始化 daemon 状态
  await initDaemonStatus();

  // 初始化 settings store（与主程序共用 settings.json）
  try {
    const settingsStore = useSettingsStore();
    await settingsStore.init();
  } catch {
    // ignore
  }

  // 启动时尝试恢复 autosave（固定 temp 路径）
  try {
    const restored = await invoke<ImportResult | null>("plugin_editor_autosave_load");
    if (restored) {
      applyImportResult(restored);
      ElMessage.success("已恢复上次未关闭的工作区（autosave）");
    }
  } catch {
    // ignore
  }

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

  // 任务日志：后端将 Rhai 的 print/debug 等输出通过 task-log 推送到前端
  unlistenTaskLog = await listen<{
    taskId: string;
    level: string;
    message: string;
    ts: number;
  }>("task-log", (event) => {
    if (activeConsoleTaskId.value && event.payload.taskId !== activeConsoleTaskId.value) return;
    const level = String(event.payload.level || "").trim();
    const prefix = level ? `[${level}] ` : "";
    const msg = `${prefix}${String(event.payload.message ?? "")}`.trimEnd();
    if (!msg) return;
    consoleText.value = consoleText.value ? `${consoleText.value}\n${msg}` : msg;
  });

  // 启动时恢复历史任务（与 main 一致：任务持久化在 SQLite）
  await loadTasksFromBackend();

  // 加载已安装插件列表（用于导入下拉）
  await refreshInstalledPlugins();

  // 注册文件拖拽导入（仅支持 .kgpg）
  try {
    const currentWindow = getCurrentWebviewWindow();
    fileDropUnlisten = await currentWindow.onDragDropEvent(async (event) => {
      if (event.payload.type === "enter") {
        const paths = event.payload.paths ?? [];
        const hasKgpg = paths.some((p) => String(p).toLowerCase().endsWith(".kgpg"));
        fileDropOverlayRef.value?.show(hasKgpg ? "拖入 .kgpg 以导入" : "仅支持 .kgpg 文件");
      } else if (event.payload.type === "drop") {
        fileDropOverlayRef.value?.hide();
        const paths = (event.payload.paths ?? []).filter((p) => String(p).toLowerCase().endsWith(".kgpg"));
        if (paths.length === 0) {
          ElMessage.warning("没有找到可导入的 .kgpg 文件");
          return;
        }
        if (paths.length > 1) {
          ElMessage.warning("一次只支持导入 1 个 .kgpg，将使用第一个");
        }
        // 拖拽导入也需要确认覆盖
        await importKgpgByPath(paths[0], false);
      } else if (event.payload.type === "leave") {
        fileDropOverlayRef.value?.hide();
      }
    });
  } catch {
    // ignore
  }

  // 定时 autosave（固定位置）
  autosaveIntervalTimer = window.setInterval(() => {
    if (!autosaveDirty.value) return;
    void autosaveNow("interval");
  }, 30_000);
});

onBeforeUnmount(() => {
  try {
    unlistenTaskStatus?.();
    unlistenTaskProgress?.();
    unlistenTaskError?.();
    unlistenTaskLog?.();
    fileDropUnlisten?.();
  } catch {
    // ignore
  }

  // 其他情况退出：尽力保存一次（不阻塞）
  try {
    void autosaveNow("unmount");
  } catch {
    // ignore
  }

  if (autosaveIntervalTimer) {
    window.clearInterval(autosaveIntervalTimer);
    autosaveIntervalTimer = null;
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

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: var(--anime-text-primary);
      white-space: nowrap;
    }

    .theme-select {
      width: 240px;
    }
  }

  .header-actions {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .settings-btn {
    flex-shrink: 0;
  }
}

/* 导入下拉菜单样式 */
.submenu-title {
  font-weight: 600;
  color: var(--anime-text-secondary);
  font-size: 12px;
  cursor: default !important;

  :deep(.el-icon) {
    margin-left: 8px;
  }
}

.plugin-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.plugin-option-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
  flex-shrink: 0;
  border-radius: 4px;
}

.plugin-option-icon-placeholder {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--anime-text-secondary);
}

.no-plugins-hint {
  color: var(--anime-text-muted);
  font-style: italic;
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

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-weight: 600;
  font-size: 15px;
  color: var(--anime-text-primary);

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

/* 空状态优化 */
:deep(.el-empty__description) {
  color: var(--anime-text-muted);
}
</style>
