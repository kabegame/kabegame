<template>
  <div class="gallery-page">
    <!-- 顶部工具栏 -->
    <PageHeader title="画廊" sticky>
      <template #left>
        <el-select :model-value="filterPluginId" @update:model-value="filterPluginId = $event" placeholder="筛选源"
          clearable style="width: 150px" popper-class="crawl-plugin-select-dropdown">
          <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
            <div class="plugin-option">
              <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]" class="plugin-option-icon" />
              <el-icon v-else class="plugin-option-icon-placeholder">
                <Grid />
              </el-icon>
              <span>{{ plugin.name }}</span>
            </div>
          </el-option>
        </el-select>
        <el-button :type="showFavoritesOnly ? 'primary' : 'default'" @click="showFavoritesOnly = !showFavoritesOnly"
          circle>
          <el-icon>
            <Star />
          </el-icon>
        </el-button>
        <el-button @click="loadImages(true, { forceReload: true })" circle>
          <el-icon>
            <Refresh />
          </el-icon>
        </el-button>
        <el-tooltip content="去重：仅从画廊移除，不删除源文件" placement="bottom">
          <el-button @click="handleDedupeByHash" :loading="dedupeLoading" :disabled="dedupeLoading">
            <el-icon>
              <Filter />
            </el-icon>
            去重
          </el-button>
        </el-tooltip>
      </template>
      <el-badge v-if="activeRunningTasksCount > 0" :value="activeRunningTasksCount" :max="99" class="tasks-badge">
        <el-button @click="showTasksDrawer = true" class="tasks-drawer-trigger" circle type="primary">
          <el-icon>
            <List />
          </el-icon>
        </el-button>
      </el-badge>
      <el-button v-else @click="showTasksDrawer = true" class="tasks-drawer-trigger" circle type="primary">
        <el-icon>
          <List />
        </el-icon>
      </el-button>
      <el-button type="primary" @click="showCrawlerDialog = true" class="add-task-btn">
        <el-icon>
          <Plus />
        </el-icon>
        导入
      </el-button>
    </PageHeader>

    <GalleryView ref="galleryViewRef" class="gallery-container" mode="gallery" :images="displayedImages"
      :image-url-map="imageSrcMap" :image-click-action="imageClickAction" :columns="galleryColumns"
      :aspect-ratio-match-window="galleryImageAspectRatioMatchWindow" :window-aspect-ratio="windowAspectRatio"
      :allow-select="true" :enable-context-menu="true" :show-load-more-button="true" :has-more="crawlerStore.hasMore"
      :loading-more="isLoadingMore" :can-move-item="true" :is-blocked="isBlockingOverlayOpen"
      @container-mounted="(el: HTMLElement) => setGalleryContainerEl(el)"
      @adjust-columns="(delta: number) => throttledAdjustColumns(delta)" @scroll-stable="loadImageUrls()"
      @load-more="loadMoreImages" @image-dbl-click="(img: any) => handleImageDblClick(img)"
      @context-command="(payload: any) => handleGridContextCommand(payload)"
      @move="(img: any, dir: any) => handleImageMove(img, dir)">
      <template #before-grid>
        <div v-if="showSkeleton" class="loading-skeleton">
          <div class="skeleton-grid">
            <div v-for="i in 20" :key="i" class="skeleton-item">
              <el-skeleton :rows="0" animated>
                <template #template>
                  <el-skeleton-item variant="image" style="width: 100%; height: 200px;" />
                </template>
              </el-skeleton>
            </div>
          </div>
        </div>

        <div v-else-if="displayedImages.length === 0 && !crawlerStore.hasMore" class="empty fade-in">
          <el-empty description="还没有收藏呢~">
            <el-button type="primary" @click="showCrawlerDialog = true">
              <el-icon>
                <Plus />
              </el-icon>
              开始导入
            </el-button>
          </el-empty>
        </div>
      </template>

      <template #overlays>
        <!-- 任务列表抽屉 -->
        <TaskDrawer v-model="showTasksDrawer" :tasks="runningTasks" />

        <!-- 图片详情对话框 -->
        <ImageDetailDialog v-model="showImageDetail" :image="selectedImage" />

        <!-- 加入画册对话框 -->
        <el-dialog v-model="showAlbumDialog" title="加入画册" width="420px">
          <el-form label-width="80px">
            <el-form-item label="选择画册">
              <el-select v-model="selectedAlbumId" placeholder="请选择已有画册" style="width: 100%">
                <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="新建画册">
              <el-input v-model="newAlbumName" placeholder="输入新画册名称（可选）" />
            </el-form-item>
            <div style="color: var(--anime-text-muted); font-size: 12px; padding-left: 80px;">
              如果同时选择已有画册和新建名称，将优先创建新画册。
            </div>
          </el-form>
          <template #footer>
            <el-button @click="showAlbumDialog = false">取消</el-button>
            <el-button type="primary" @click="confirmAddToAlbum">确定</el-button>
          </template>
        </el-dialog>

        <!-- 收集对话框 -->
        <el-dialog v-model="showCrawlerDialog" title="开始导入图片" width="600px" :close-on-click-modal="false"
          class="crawl-dialog" :show-close="true">
          <el-form :model="form" ref="formRef" label-width="100px" class="crawl-form">
            <el-form-item label="运行配置">
              <el-select v-model="selectedRunConfigId" placeholder="选择配置（可选）" style="width: 100%" clearable
                popper-class="run-config-select-dropdown">
                <el-option v-for="cfg in runConfigs" :key="cfg.id" :label="cfg.name" :value="cfg.id">
                  <div class="run-config-option">
                    <div class="run-config-info">
                      <div class="name">
                        <el-tag v-if="configCompatibilityStatus[cfg.id]?.versionCompatible === false" type="danger"
                          size="small" style="margin-right: 6px;">
                          不兼容
                        </el-tag>
                        <el-tag v-else-if="configCompatibilityStatus[cfg.id]?.contentCompatible === false"
                          type="warning" size="small" style="margin-right: 6px;">
                          不兼容
                        </el-tag>
                        {{ cfg.name }}
                        <span v-if="cfg.description" class="desc"> - {{ cfg.description }}</span>
                      </div>
                    </div>
                    <div class="run-config-actions">
                      <el-button type="primary" link size="small" @click.stop="loadConfigToForm(cfg.id)">
                        载入
                      </el-button>
                      <el-button type="danger" link size="small" @click.stop="confirmDeleteRunConfig(cfg.id)">
                        删除
                      </el-button>
                    </div>
                  </div>
                </el-option>
              </el-select>
              <div class="config-hint">
                兼容的配置：可直接选择并一键运行（表单会锁定）；不兼容的配置：会在此处提示，且只能“载入到表单”后手动编辑运行
              </div>
            </el-form-item>
            <el-form-item label="选择源">
              <el-select v-model="form.pluginId" :disabled="!!selectedRunConfigId" placeholder="请选择源"
                style="width: 100%" popper-class="crawl-plugin-select-dropdown">
                <el-option v-for="plugin in enabledPlugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
                  <div class="plugin-option">
                    <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]" class="plugin-option-icon" />
                    <el-icon v-else class="plugin-option-icon-placeholder">
                      <Grid />
                    </el-icon>
                    <span>{{ plugin.name }}</span>
                  </div>
                </el-option>
              </el-select>
            </el-form-item>
            <el-form-item label="输出目录">
              <el-input v-model="form.outputDir" :disabled="!!selectedRunConfigId" placeholder="留空使用默认目录，或输入自定义路径"
                clearable>
                <template #append>
                  <el-button @click="selectOutputDir" :disabled="!!selectedRunConfigId">
                    <el-icon>
                      <FolderOpened />
                    </el-icon>
                    选择
                  </el-button>
                </template>
              </el-input>
            </el-form-item>

            <!-- 插件变量配置 -->
            <template v-if="pluginVars.length > 0">
              <el-divider content-position="left">插件配置</el-divider>
              <el-form-item v-for="varDef in pluginVars" :key="varDef.key" :label="varDef.name"
                :prop="`vars.${varDef.key}`" :required="isRequired(varDef)" :rules="getValidationRules(varDef)">
                <el-input-number v-if="varDef.type === 'int' || varDef.type === 'float'" v-model="form.vars[varDef.key]"
                  :min="varDef.min !== undefined ? varDef.min : undefined"
                  :max="varDef.max !== undefined ? varDef.max : undefined" :disabled="!!selectedRunConfigId"
                  :placeholder="varDef.descripts || `请输入${varDef.name}`" style="width: 100%" />
                <el-select v-else-if="varDef.type === 'options'" v-model="form.vars[varDef.key]"
                  :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%"
                  :disabled="!!selectedRunConfigId">
                  <el-option v-for="option in varDef.options" :key="optionValue(option)" :label="optionLabel(option)"
                    :value="optionValue(option)" />
                </el-select>
                <el-switch v-else-if="varDef.type === 'boolean'" v-model="form.vars[varDef.key]" />
                <el-select v-else-if="varDef.type === 'list'" v-model="form.vars[varDef.key]" multiple
                  :placeholder="varDef.descripts || `请选择${varDef.name}`" style="width: 100%"
                  :disabled="!!selectedRunConfigId">
                  <el-option v-for="option in varDef.options" :key="optionValue(option)" :label="optionLabel(option)"
                    :value="optionValue(option)" />
                </el-select>
                <el-checkbox-group v-else-if="varDef.type === 'checkbox'" v-model="form.vars[varDef.key]"
                  :disabled="!!selectedRunConfigId">
                  <el-checkbox v-for="option in (varDef.options || [])" :key="optionValue(option)"
                    :label="optionValue(option)">
                    {{ optionLabel(option) }}
                  </el-checkbox>
                </el-checkbox-group>
                <el-input v-else-if="varDef.type === 'file'" v-model="form.vars[varDef.key]"
                  :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable :disabled="!!selectedRunConfigId">
                  <template #append>
                    <el-button @click="() => selectFile(varDef.key)" :disabled="!!selectedRunConfigId">
                      <el-icon>
                        <FolderOpened />
                      </el-icon>
                      选择文件
                    </el-button>
                  </template>
                </el-input>
                <el-input v-else-if="varDef.type === 'path' || varDef.type === 'folder'" v-model="form.vars[varDef.key]"
                  :placeholder="varDef.descripts || `请选择${varDef.name}`" clearable :disabled="!!selectedRunConfigId">
                  <template #append>
                    <el-button @click="() => selectFolder(varDef.key)" :disabled="!!selectedRunConfigId">
                      <el-icon>
                        <FolderOpened />
                      </el-icon>
                      选择
                    </el-button>
                  </template>
                </el-input>
                <el-input v-else v-model="form.vars[varDef.key]" :placeholder="varDef.descripts || `请输入${varDef.name}`"
                  style="width: 100%" :disabled="!!selectedRunConfigId" />
                <div v-if="varDef.descripts">
                  {{ varDef.descripts }}
                </div>
              </el-form-item>
            </template>

            <el-divider content-position="left">保存为配置（可选）</el-divider>
            <el-form-item>
              <el-checkbox v-model="saveAsConfig" :disabled="!!selectedRunConfigId">保存为配置（下次再使用啦）</el-checkbox>
            </el-form-item>
            <el-form-item label="配置名称" v-if="saveAsConfig">
              <el-input v-model="configName" placeholder="请输入配置名称" />
            </el-form-item>
            <el-form-item label="配置描述" v-if="saveAsConfig">
              <el-input v-model="configDescription" placeholder="可选：配置说明" />
            </el-form-item>
          </el-form>

          <template #footer>
            <el-button @click="showCrawlerDialog = false">关闭</el-button>
            <el-button type="primary" @click="handleStartCrawl" :loading="isCrawling"
              :disabled="!selectedRunConfigId && !form.pluginId">
              开始收集
            </el-button>
          </template>
        </el-dialog>
      </template>
    </GalleryView>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, watch, nextTick, ref as createRef, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus, FolderOpened } from "@element-plus/icons-vue";
import { useCrawlerStore, type ImageInfo, type RunConfig } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { usePluginStore } from "@/stores/plugins";
import { open } from "@tauri-apps/plugin-dialog";
import PageHeader from "@/components/common/PageHeader.vue";
import TaskDrawer from "@/components/TaskDrawer.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import GalleryView from "@/components/GalleryView.vue";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const albumStore = useAlbumStore();

// 收藏画册的固定ID（与后端保持一致）
const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";

const loading = ref(false);
const showSkeleton = ref(false); // 控制是否显示骨架屏（延迟300ms显示）
const skeletonTimer = ref<ReturnType<typeof setTimeout> | null>(null); // 骨架屏延迟定时器
const isLoadingMore = ref(false); // 标志：正在加载更多图片
const dedupeProcessing = ref(false); // 正在执行“按哈希去重”本体
const dedupeWaitingDownloads = ref(false); // 需要等待下载队列空闲后才结束 loading
const dedupeLoading = computed(() => dedupeProcessing.value || dedupeWaitingDownloads.value);
const filterPluginId = ref<string | null>(null);
const showFavoritesOnly = ref(false);
const showCrawlerDialog = ref(false);
const showTasksDrawer = ref(false);
const showImageDetail = ref(false);
const galleryContainerRef = ref<HTMLElement | null>(null);
const galleryViewRef = ref<any>(null);
const showAlbumDialog = ref(false);

const setGalleryContainerEl = (el: HTMLElement) => {
  galleryContainerRef.value = el;
};
const selectedAlbumId = ref<string>("");
const newAlbumName = ref<string>("");
const pendingAlbumImages = ref<ImageInfo[]>([]);
const selectedImage = ref<ImageInfo | null>(null);
const imageClickAction = ref<"preview" | "open">("preview");
const galleryColumns = ref<number>(0); // 0 表示自动（auto-fill），其他值表示固定列数
const galleryImageAspectRatioMatchWindow = ref<boolean>(false); // 图片宽高比是否与窗口相同
const windowAspectRatio = ref<number>(16 / 9); // 窗口宽高比
const plugins = computed(() => pluginStore.plugins);
const isCrawling = computed(() => crawlerStore.isCrawling);
const enabledPlugins = computed(() => pluginStore.plugins.filter((p) => p.enabled));
const runConfigs = computed(() => crawlerStore.runConfigs);
const tasks = computed(() => crawlerStore.tasks);

// 正在运行的任务（包括 running 和 failed 状态，不包括 pending，因为 pending 任务都是无效的）
const runningTasks = computed(() => {
  // 显示所有任务（包括运行中、失败和已完成的任务）
  return tasks.value.filter(task =>
    task.status === 'running' ||
    task.status === 'failed' ||
    task.status === 'completed'
  );
});

// 真正正在运行中的任务数量（仅用于右上角徽章显示）
const activeRunningTasksCount = computed(() => {
  return tasks.value.filter(task => task.status === 'running').length;
});

const form = ref({
  pluginId: "",
  outputDir: "",
  vars: {} as Record<string, any>,
  url: "",
});
const selectedRunConfigId = ref<string | null>(null);
const saveAsConfig = ref(false);
const configName = ref("");
const configDescription = ref("");

const formRef = ref();

type VarOption = string | { name: string; variable: string };
const pluginVars = ref<PluginVarDef[]>([]);
const albums = computed(() => albumStore.albums);

// 判断配置项是否必填（没有 default 值则为必填）
const isRequired = (varDef: { default?: any }) => {
  return varDef.default === undefined || varDef.default === null;
};

type PluginVarDef = { key: string; type: string; name: string; descripts?: string; default?: any; options?: VarOption[]; min?: number; max?: number };

const optionLabel = (opt: VarOption) => (typeof opt === "string" ? opt : opt.name);
const optionValue = (opt: VarOption) => (typeof opt === "string" ? opt : opt.variable);

// 将 UI 表单中的 vars（checkbox 在 UI 层使用 string[]）转换为后端/脚本需要的对象：
// 例如 { foo: ["a","b"] } -> { foo: { a: true, b: true } }
const expandVarsForBackend = (uiVars: Record<string, any>, defs: PluginVarDef[]) => {
  const expanded: Record<string, any> = { ...uiVars };
  for (const def of defs) {
    if (def.type !== "checkbox") continue;
    const options = def.options || [];
    const optionVars = options.map(optionValue);
    const selected = Array.isArray(uiVars[def.key]) ? (uiVars[def.key] as string[]) : [];
    const obj: Record<string, boolean> = {};
    for (const v of optionVars) obj[v] = selected.includes(v);
    expanded[def.key] = obj;
  }
  return expanded;
};

// 将后端保存/运行配置中的 checkbox 值聚合回 UI 用的 foo: string[]
// - 格式：foo: { a: true, b: false }（脚本中用 foo.a/foo.b）
const normalizeVarsForUI = (rawVars: Record<string, any>, defs: PluginVarDef[]) => {
  const normalized: Record<string, any> = {};
  for (const def of defs) {
    if (def.type === "checkbox") {
      const options = def.options || [];
      const optionVars = options.map(optionValue);
      // foo 是对象（{a:true,b:false}）
      const raw = rawVars[def.key];
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        normalized[def.key] = optionVars.filter((v) => raw?.[v] === true);
        continue;
      }
      // default: 支持数组（["a","b"]）或对象（{a:true,b:false}）
      const d = def.default;
      if (Array.isArray(d)) {
        normalized[def.key] = d;
      } else if (d && typeof d === "object") {
        normalized[def.key] = optionVars.filter((v) => (d as any)[v] === true);
      } else {
        normalized[def.key] = [];
      }
      continue;
    }

    if (rawVars[def.key] !== undefined) {
      normalized[def.key] = rawVars[def.key];
    } else if (def.default !== undefined) {
      normalized[def.key] = def.default;
    }
  }
  return normalized;
};

// 获取验证规则
const getValidationRules = (varDef: PluginVarDef) => {
  if (!isRequired(varDef)) {
    return [];
  }

  // 根据类型返回不同的验证规则
  if (varDef.type === 'list' || varDef.type === 'checkbox') {
    return [
      {
        required: true,
        message: `请选择${varDef.name}`,
        trigger: 'change',
        validator: (_rule: any, value: any, callback: any) => {
          if (!value || (Array.isArray(value) && value.length === 0)) {
            callback(new Error(`请选择${varDef.name}`));
          } else {
            callback();
          }
        }
      }
    ];
  } else if (varDef.type === 'boolean') {
    // boolean 类型总是有值（true/false），不需要验证
    return [];
  } else {
    return [
      {
        required: true,
        message: `请输入${varDef.name}`,
        trigger: varDef.type === 'options' ? 'change' : 'blur',
        validator: (_rule: any, value: any, callback: any) => {
          if (value === undefined || value === null || value === '') {
            callback(new Error(`请输入${varDef.name}`));
            return;
          }
          // 对于 int 和 float 类型，验证 min/max
          if ((varDef.type === 'int' || varDef.type === 'float') && typeof value === 'number') {
            const varDefWithMinMax = varDef as PluginVarDef;
            if (varDefWithMinMax.min !== undefined && value < varDefWithMinMax.min) {
              callback(new Error(`${varDef.name}不能小于 ${varDefWithMinMax.min}`));
              return;
            }
            if (varDefWithMinMax.max !== undefined && value > varDefWithMinMax.max) {
              callback(new Error(`${varDef.name}不能大于 ${varDefWithMinMax.max}`));
              return;
            }
          }
          callback();
        }
      }
    ];
  }
};

// 不再需要过滤，因为后端已经支持按 plugin_id 查询
// 使用独立的本地图片列表，避免直接修改 store 的 images 导致的重新渲染
// 使用 shallowRef 减少深度响应式追踪，提高性能
const displayedImages = shallowRef<ImageInfo[]>([]);

// 图片 URL 映射，存储每个图片的缩略图和原图 URL
// 使用 shallowRef 减少深度响应式追踪，避免每次更新都触发重新渲染
const imageSrcMap = createRef<Record<string, { thumbnail?: string; original?: string }>>({});
// 已经加载过 URL 的图片 ID，用于快速跳过重复加载
const loadedImageIds = new Set<string>();

// 存储所有创建的 Blob URL，用于在组件卸载时释放内存
const blobUrls = new Set<string>();

// 插件图标映射，存储每个插件的图标 URL
const pluginIcons = ref<Record<string, string>>({});

// 当有弹窗/抽屉等覆盖层时，画廊不应接收鼠标/键盘事件
const isBlockingOverlayOpen = () => {
  // 本页面自身的弹窗/抽屉
  if (
    showCrawlerDialog.value ||
    showTasksDrawer.value ||
    showAlbumDialog.value ||
    showImageDetail.value
  ) {
    return true;
  }

  // Element Plus 的 Dialog/Drawer/MessageBox 等通常会创建 el-overlay（teleport 到 body）
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(".el-overlay"));
  return overlays.some((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
};

// 将本地文件路径转换为 Blob URL（比 base64 更高效）
async function getImageUrl(localPath: string): Promise<string> {
  if (!localPath) return "";
  try {
    // 移除 Windows 长路径前缀 \\?\（如果存在）
    let normalizedPath = localPath.trimStart().replace(/^\\\\\?\\/, "");

    // 读取文件二进制数据
    const fileData = await readFile(normalizedPath);

    // 根据文件扩展名确定 MIME 类型
    const ext = normalizedPath.split('.').pop()?.toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    else if (ext === "gif") mimeType = "image/gif";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "bmp") mimeType = "image/bmp";

    // 创建 Blob 对象
    const blob = new Blob([fileData], { type: mimeType });

    // 创建 Blob URL
    const blobUrl = URL.createObjectURL(blob);

    // 记录 Blob URL，以便后续释放
    blobUrls.add(blobUrl);

    return blobUrl;
  } catch (error) {
    console.error("Failed to load image file:", error, localPath);
    return "";
  }
}

// 加载图片 URL（可选传入待加载的图片列表）；只加载缺失的图片
const loadImageUrls = async (targetImages?: ImageInfo[]) => {
  const source = targetImages ?? displayedImages.value;
  const visibleIds = getVisibleImageIds();
  const visibleSet = new Set(visibleIds);

  // 只获取还没有加载的图片
  const imagesToLoad = source.filter(img => {
    if (loadedImageIds.has(img.id)) return false;
    const existing = imageSrcMap.value[img.id];
    // 如果图片已经加载过（有 thumbnail 或 original），则跳过
    return !existing || (!existing.thumbnail && !existing.original);
  });

  // 可见图片优先加载
  imagesToLoad.sort((a, b) => {
    const av = visibleSet.has(a.id) ? 0 : 1;
    const bv = visibleSet.has(b.id) ? 0 : 1;
    if (av !== bv) return av - bv;
    return 0;
  });

  if (imagesToLoad.length === 0) {
    return;
  }

  // 优先加载前20张（可见区域），并行加载以加快速度
  const priorityImages = imagesToLoad.slice(0, 20);
  const remainingImages = imagesToLoad.slice(20);

  // 并行加载优先图片，每加载完一张立即更新，不等待所有图片加载完成
  const priorityPromises = priorityImages.map(async (image) => {
    // 再次检查，避免重复处理
    if (imageSrcMap.value[image.id]?.thumbnail || imageSrcMap.value[image.id]?.original) {
      return;
    }

    // 异步读取文件并转换为 Blob URL
    try {
      const thumbnailUrl = image.thumbnailPath ? await getImageUrl(image.thumbnailPath) : "";
      const originalUrl = await getImageUrl(image.localPath);

      // 检查图片是否仍然存在（可能在异步操作期间被删除）
      const imageStillExists = displayedImages.value.some(img => img.id === image.id);
      if (!imageStillExists) {
        return;
      }

      const imageData = {
        thumbnail: thumbnailUrl || originalUrl || undefined,
        original: originalUrl || undefined,
      };

      // 立即更新，不等待其他图片
      // 使用 Object.assign 确保触发响应式更新
      imageSrcMap.value = { ...imageSrcMap.value, [image.id]: imageData };
      loadedImageIds.add(image.id);
    } catch (error) {
      console.error("Failed to load image:", error, image);
    }
  });

  // 不等待所有优先图片加载完成，让它们并行加载并在完成后立即更新
  // 这样用户可以看到图片逐步出现，而不是等待所有图片加载完成
  Promise.all(priorityPromises).catch(() => {
    // 忽略错误，已经在单个 promise 中处理了
  });

  // 剩余的图片在后台处理，批量更新以减少重新渲染
  if (remainingImages.length > 0) {
    const remainingUpdates: Record<string, { thumbnail?: string; original?: string }> = {};
    let processedCount = 0;
    const BATCH_SIZE = 10; // 每处理 10 张图片批量更新一次

    // 使用 requestIdleCallback 或 setTimeout 在空闲时处理
    const processRemaining = async (index = 0) => {
      if (index >= remainingImages.length) {
        // 处理完所有图片后，批量更新剩余的
        if (Object.keys(remainingUpdates).length > 0) {
          imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
          Object.keys(remainingUpdates).forEach((id) => loadedImageIds.add(id));
        }
        return;
      }

      const image = remainingImages[index];
      // 再次检查，避免重复处理
      if (loadedImageIds.has(image.id) || imageSrcMap.value[image.id]?.thumbnail || imageSrcMap.value[image.id]?.original) {
        // 已处理，继续下一个
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => processRemaining(index + 1), { timeout: 2000 });
        } else {
          setTimeout(() => processRemaining(index + 1), 50);
        }
        return;
      }

      // 异步读取文件并转换为 Blob URL
      try {
        const thumbnailUrl = image.thumbnailPath ? await getImageUrl(image.thumbnailPath) : "";
        const originalUrl = await getImageUrl(image.localPath);

        // 检查图片是否仍然存在（可能在异步操作期间被删除）
        const imageStillExists = displayedImages.value.some(img => img.id === image.id);
        if (imageStillExists) {
          remainingUpdates[image.id] = {
            thumbnail: thumbnailUrl || originalUrl || undefined,
            original: originalUrl || undefined,
          };
          processedCount++;

          // 每处理 BATCH_SIZE 张图片，批量更新一次
          if (processedCount % BATCH_SIZE === 0) {
            imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
            // 清空已更新的项
            Object.keys(remainingUpdates).forEach(key => delete remainingUpdates[key]);
          }
        }
      } catch (error) {
        console.error("Failed to load image:", error, image);
      }

      // 继续处理下一个
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => processRemaining(index + 1), { timeout: 2000 });
      } else {
        setTimeout(() => processRemaining(index + 1), 50);
      }
    };

    // 使用 requestIdleCallback 如果可用，否则使用 setTimeout
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => processRemaining(0), { timeout: 2000 });
    } else {
      setTimeout(() => processRemaining(0), 100);
    }
  }
};

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

const openAddToAlbumDialog = async (images: ImageInfo[]) => {
  pendingAlbumImages.value = images;
  if (albums.value.length === 0) {
    await albumStore.loadAlbums();
  }
  if (!selectedAlbumId.value && albums.value.length > 0) {
    selectedAlbumId.value = albums.value[0].id;
  }
  newAlbumName.value = "";
  showAlbumDialog.value = true;
};

// 配置兼容性检查结果类型
interface ConfigCompatibility {
  versionCompatible: boolean; // 第一步：插件是否存在
  contentCompatible: boolean; // 第二步：配置内容是否符合
  versionReason?: string;
  contentErrors: string[]; // 内容不兼容的具体错误
  warnings: string[]; // 警告信息（如字段已删除但不算严重错误）
}

// 验证单个变量值
const validateVarValue = (value: any, varDef: PluginVarDef): { valid: boolean; error?: string } => {
  switch (varDef.type) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { valid: false, error: "值必须是整数" };
      }
      if (varDef.min !== undefined && value < varDef.min) {
        return { valid: false, error: `值不能小于 ${varDef.min}` };
      }
      if (varDef.max !== undefined && value > varDef.max) {
        return { valid: false, error: `值不能大于 ${varDef.max}` };
      }
      break;
    case "float":
      if (typeof value !== "number") {
        return { valid: false, error: "值必须是数字" };
      }
      if (varDef.min !== undefined && value < varDef.min) {
        return { valid: false, error: `值不能小于 ${varDef.min}` };
      }
      if (varDef.max !== undefined && value > varDef.max) {
        return { valid: false, error: `值不能大于 ${varDef.max}` };
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return { valid: false, error: "值必须是布尔值" };
      }
      break;
    case "options":
      if (varDef.options && Array.isArray(varDef.options)) {
        const validValues = varDef.options.map(opt =>
          typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
        );
        if (!validValues.includes(value)) {
          return { valid: false, error: `值不在有效选项中` };
        }
      }
      break;
    case "checkbox":
      if (!Array.isArray(value)) {
        return { valid: false, error: "值必须是数组" };
      }
      if (varDef.options && Array.isArray(varDef.options)) {
        const validValues = varDef.options.map(opt =>
          typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
        );
        const invalidValues = value.filter(v => !validValues.includes(v));
        if (invalidValues.length > 0) {
          return { valid: false, error: `包含无效选项` };
        }
      }
      break;
    case "list":
      if (!Array.isArray(value)) {
        return { valid: false, error: "值必须是数组" };
      }
      break;
  }
  return { valid: true };
};

// 检查配置兼容性（两步验证）
const checkConfigCompatibility = async (config: RunConfig): Promise<ConfigCompatibility> => {
  const result: ConfigCompatibility = {
    versionCompatible: true,
    contentCompatible: true,
    contentErrors: [],
    warnings: []
  };

  // 第一步：检查插件是否存在（版本检查）
  const pluginExists = plugins.value.some(p => p.id === config.pluginId);
  if (!pluginExists) {
    result.versionCompatible = false;
    result.versionReason = "插件不存在";
    result.contentCompatible = false;
    return result;
  }

  try {
    // 加载插件变量定义
    const vars = await invoke<Array<PluginVarDef> | null>("get_plugin_vars", {
      pluginId: config.pluginId,
    });

    if (!vars || vars.length === 0) {
      // 插件没有变量定义，配置总是兼容的
      return result;
    }

    const varDefMap = new Map(vars.map(def => [def.key, def]));
    const userConfig = config.userConfig || {};

    // 第二步：验证配置内容
    for (const [key, value] of Object.entries(userConfig)) {
      const varDef = varDefMap.get(key);

      if (!varDef) {
        // 字段已删除，记录为警告
        result.warnings.push(`字段 "${key}" 已在新版本中删除`);
        continue;
      }

      // 验证字段值
      const validation = validateVarValue(value, varDef);
      if (!validation.valid) {
        result.contentCompatible = false;
        result.contentErrors.push(`${varDef.name} (${key}): ${validation.error}`);
      }
    }

    // 检查是否有新增的必填字段且没有默认值
    for (const varDef of vars) {
      if (!(varDef.key in userConfig)) {
        if (isRequired(varDef) && varDef.default === undefined) {
          result.contentCompatible = false;
          result.contentErrors.push(`缺少必填字段: ${varDef.name} (${varDef.key})`);
        }
      }
    }

  } catch (error) {
    console.error("检查配置兼容性失败:", error);
    result.contentCompatible = false;
    result.contentErrors.push("验证过程出错");
  }

  return result;
};

// 智能匹配配置到表单（尽量匹配能匹配的字段）
const smartMatchConfigToForm = async (config: RunConfig): Promise<{ success: boolean; message?: string }> => {
  // 检查插件是否存在
  const pluginExists = plugins.value.some(p => p.id === config.pluginId);
  if (!pluginExists) {
    return { success: false, message: "插件不存在，无法载入配置" };
  }

  // 加载插件变量定义
  await loadPluginVars(config.pluginId);

  const userConfig = config.userConfig || {};
  const matchedVars: Record<string, any> = {};
  const varDefMap = new Map(pluginVars.value.map(def => [def.key, def]));

  // 尝试匹配每个配置字段
  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);

    if (!varDef) {
      // 字段已删除，跳过
      continue;
    }

    // 验证值是否有效
    const validation = validateVarValue(value, varDef);
    if (validation.valid) {
      // 值有效，直接使用
      matchedVars[key] = value;
    } else {
      // 值无效，使用默认值（如果有）
      if (varDef.default !== undefined) {
        matchedVars[key] = varDef.default;
      }
    }
  }

  // 填充缺失字段的默认值
  for (const varDef of pluginVars.value) {
    if (!(varDef.key in matchedVars)) {
      if (varDef.default !== undefined) {
        matchedVars[varDef.key] = varDef.default;
      }
    }
  }

  // 转换为 UI 格式
  const cfgUiVars = normalizeVarsForUI(matchedVars, pluginVars.value as PluginVarDef[]);

  // 更新表单
  form.value.pluginId = config.pluginId;
  form.value.outputDir = config.outputDir || "";
  form.value.vars = cfgUiVars;

  // 取消选择配置，允许用户编辑
  selectedRunConfigId.value = null;

  return { success: true };
};

// 配置兼容性状态（用于UI显示）
const configCompatibilityStatus = ref<Record<string, ConfigCompatibility>>({});

// 配置兼容性缓存（用于避免重复计算）
const configCompatibilityCache = ref<Map<string, ConfigCompatibility>>(new Map());

// 获取配置兼容性（带缓存）
const getConfigCompatibility = async (configId: string): Promise<ConfigCompatibility> => {
  if (configCompatibilityCache.value.has(configId)) {
    return configCompatibilityCache.value.get(configId)!;
  }

  const config = runConfigs.value.find(c => c.id === configId);
  if (!config) {
    return {
      versionCompatible: false,
      contentCompatible: false,
      versionReason: "配置不存在",
      contentErrors: [],
      warnings: []
    };
  }

  const compatibility = await checkConfigCompatibility(config);
  configCompatibilityCache.value.set(configId, compatibility);
  // 更新UI状态
  configCompatibilityStatus.value[configId] = compatibility;
  return compatibility;
};

// 清除兼容性缓存
const clearCompatibilityCache = () => {
  configCompatibilityCache.value.clear();
  configCompatibilityStatus.value = {};
};

// 批量检查所有配置的兼容性（用于UI显示）
const checkAllConfigsCompatibility = async () => {
  if (runConfigs.value.length === 0) {
    configCompatibilityStatus.value = {};
    return;
  }

  const status: Record<string, ConfigCompatibility> = {};
  const promises = runConfigs.value.map(async (config) => {
    const compatibility = await getConfigCompatibility(config.id);
    status[config.id] = compatibility;
  });
  await Promise.all(promises);
  // 一次性更新所有状态，确保响应式更新
  configCompatibilityStatus.value = { ...status };
};

// 监听配置列表和插件列表变化，重新检查兼容性
watch(
  () => {
    // 关键：不要只依赖数组引用（否则 push/unshift 不会触发），而是依赖“结构化签名”
    const cfgSig = runConfigs.value.map((c) => ({
      id: c.id,
      pluginId: c.pluginId,
      // userConfig 的变化也可能导致兼容性变化；这里用 JSON 字符串作为轻量签名
      userConfigSig: JSON.stringify(c.userConfig || {}),
    }));
    const pluginSig = plugins.value.map((p) => `${p.id}:${p.version}:${p.enabled}`);
    return { cfgSig, pluginSig };
  },
  async () => {
    // 插件列表变化（尤其是版本更新）会影响 vars 定义/默认值，但如果当前 pluginId 不变，
    // `watch(form.pluginId)` 不会触发，导致导入弹窗仍展示旧 vars。
    // 因此：当导入弹窗打开时，插件列表变更也要强制 reload 一次当前 plugin 的 vars + 保存配置。
    if (showCrawlerDialog.value && form.value.pluginId) {
      await loadPluginVars(form.value.pluginId);
    }
    clearCompatibilityCache();
    await checkAllConfigsCompatibility();
  },
  { immediate: true }
);

// 打开导入对话框时，兜底刷新一次（保证下拉打开时就能看到兼容性提示）
watch(showCrawlerDialog, async (open) => {
  if (!open) return;
  // 关键：用户可能刚在“源/插件”页刷新或更新了已安装源（.kgpg 内的 config.json/var 定义变更）
  // 但这里若 pluginId 没变，`watch(form.pluginId)` 不会触发，导致导入弹窗仍展示旧的变量/配置。
  // 因此弹窗打开时做一次“兜底同步”：
  // - 刷新已安装源列表（从文件系统重新读取 .kgpg）
  // - 重新加载当前选中源的变量定义 + 已保存用户配置
  // - 重新计算兼容性提示
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    // 刷新失败不应阻塞弹窗打开；兼容性/变量加载会按现有状态继续
    console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
  }

  if (form.value.pluginId) {
    await loadPluginVars(form.value.pluginId);
  }

  clearCompatibilityCache();
  await checkAllConfigsCompatibility();
});

// 删除运行配置（从下拉项直接删除）
const confirmDeleteRunConfig = async (configId: string) => {
  try {
    const cfg = runConfigs.value.find(c => c.id === configId);
    await ElMessageBox.confirm(
      `删除后无法通过该配置再次运行。已创建的任务不会受影响。确定删除${cfg ? `「${cfg.name}」` : "该配置"}吗？`,
      "删除配置",
      { type: "warning" }
    );
    await crawlerStore.deleteRunConfig(configId);
    if (selectedRunConfigId.value === configId) {
      selectedRunConfigId.value = null;
      // 保留表单内容，便于用户直接修改后保存/运行
    }
    clearCompatibilityCache();
    ElMessage.success("配置已删除");
  } catch (error) {
    if (error !== "cancel") {
      console.error("删除运行配置失败:", error);
      ElMessage.error("删除配置失败");
    }
  }
};

// 载入配置到表单（强制载入，即使不兼容）
const loadConfigToForm = async (configId: string) => {
  const config = runConfigs.value.find(c => c.id === configId);
  if (!config) {
    ElMessage.error("配置不存在");
    return;
  }

  // 检查兼容性
  const compatibility = await getConfigCompatibility(configId);

  // 如果版本不兼容，直接提示
  if (!compatibility.versionCompatible) {
    await ElMessageBox.alert(
      `该配置关联的插件不存在：${compatibility.versionReason || "未知错误"}\n无法载入配置。`,
      "插件缺失",
      { type: "error" }
    );
    return;
  }

  // 如果内容不兼容，提示用户但允许继续
  if (!compatibility.contentCompatible) {
    const errorMsg = compatibility.contentErrors.length > 0
      ? `配置内容与当前插件版本不兼容：\n${compatibility.contentErrors.join('\n')}`
      : "配置内容与当前插件版本不兼容";
    const warningMsg = compatibility.warnings.length > 0
      ? `\n\n警告：\n${compatibility.warnings.join('\n')}`
      : "";

    try {
      await ElMessageBox.confirm(
        `${errorMsg}${warningMsg}\n\n将尝试匹配可用的配置项，缺失的字段将使用默认值。是否继续？`,
        "配置不兼容",
        { type: "warning", confirmButtonText: "继续载入", cancelButtonText: "取消" }
      );
    } catch (error) {
      if (error === "cancel") {
        return;
      }
    }
  }

  // 智能匹配并载入配置
  const result = await smartMatchConfigToForm(config);
  if (result.success) {
    ElMessage.success("配置已载入，快乐玩耍吧！");
  } else {
    ElMessage.error(result.message || "载入配置失败");
  }
};

const confirmAddToAlbum = async () => {
  if (pendingAlbumImages.value.length === 0) {
    showAlbumDialog.value = false;
    return;
  }

  let albumId = selectedAlbumId.value;
  if (!albumId && newAlbumName.value.trim()) {
    const created = await albumStore.createAlbum(newAlbumName.value.trim());
    albumId = created.id;
    selectedAlbumId.value = albumId;
  }

  if (!albumId) {
    ElMessage.warning("请选择画册或输入新画册名称");
    return;
  }

  const ids = pendingAlbumImages.value.map(img => img.id);
  await albumStore.addImagesToAlbum(albumId, ids);
  ElMessage.success(`已加入画册（${ids.length} 张）`);
  showAlbumDialog.value = false;
  pendingAlbumImages.value = [];
};

// 获取视口内的图片ID（用于优先加载可见图片）
const getVisibleImageIds = (): string[] => {
  const container = galleryContainerRef.value;
  if (!container) return [];

  const containerRect = container.getBoundingClientRect();
  const items = container.querySelectorAll<HTMLElement>(".image-item");
  const visibleIds: string[] = [];

  items.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const isVisible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    if (isVisible) {
      const id = el.getAttribute("data-id");
      if (id) visibleIds.push(id);
    }
  });

  return visibleIds;
};

// 加载插件图标
const loadPluginIcons = async () => {
  for (const plugin of plugins.value) {
    if (pluginIcons.value[plugin.id]) {
      continue; // 已经加载过
    }
    try {
      const iconData = await invoke<number[] | null>("get_plugin_icon", {
        pluginId: plugin.id,
      });
      if (iconData && iconData.length > 0) {
        // 将数组转换为 Uint8Array，然后转换为 base64 data URL
        const bytes = new Uint8Array(iconData);
        const binaryString = Array.from(bytes)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        const base64 = btoa(binaryString);
        pluginIcons.value[plugin.id] = `data:image/png;base64,${base64}`;
      }
    } catch (error) {
      // 图标加载失败，忽略（插件可能没有图标）
      console.debug(`插件 ${plugin.id} 没有图标或加载失败`);
    }
  }
};




const handleOpenImagePath = async (localPath: string) => {
  try {
    await invoke("open_file_path", { filePath: localPath });
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error("打开文件失败");
  }
};

const handleImageDblClick = async (image: ImageInfo) => {
  // 预览功能已下沉到 ImageGrid，这里只处理 open 模式
  if (imageClickAction.value === 'open') {
    await handleOpenImagePath(image.localPath);
  }
  // preview 模式由 ImageGrid 内部处理
};

const handleGridContextCommand = async (payload: { command: string; image: ImageInfo; selectedImageIds: Set<string> }) => {
  const command = payload.command;
  const image = payload.image;
  const selectedSet = payload.selectedImageIds && payload.selectedImageIds.size > 0
    ? payload.selectedImageIds
    : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? displayedImages.value.filter(img => selectedSet.has(img.id))
    : [image];

  switch (command) {
    case 'detail':
      if (!isMultiSelect) {
        selectedImage.value = image;
        showImageDetail.value = true;
      }
      break;
    case 'favorite':
      try {
        // 仅支持普通（单张）收藏
        if (isMultiSelect) {
          ElMessage.warning("收藏仅支持单张图片");
          return;
        }

        const newFavorite = !(image.favorite ?? false);
        await invoke("toggle_image_favorite", {
          imageId: image.id,
          favorite: newFavorite,
        });

        ElMessage.success(newFavorite ? "已收藏" : "已取消收藏");

        // 清除收藏画册的缓存，确保下次查看时重新加载
        delete albumStore.albumImages[FAVORITE_ALBUM_ID];
        delete albumStore.albumPreviews[FAVORITE_ALBUM_ID];
        // 更新收藏画册计数
        const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID] || 0;
        albumStore.albumCounts[FAVORITE_ALBUM_ID] = Math.max(0, currentCount + (newFavorite ? 1 : -1));

        // 发出收藏状态变化事件，通知其他页面（如收藏画册详情页）更新
        window.dispatchEvent(
          new CustomEvent("favorite-status-changed", {
            detail: { imageIds: [image.id], favorite: newFavorite },
          })
        );

        // 重新加载图片以更新状态（保持当前滚动位置）
        await loadImages(true, { preserveScroll: true });
        galleryViewRef.value?.clearSelection?.();
      } catch (error) {
        console.error("切换收藏状态失败:", error);
        ElMessage.error("操作失败");
      }
      break;
    case 'copy':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }

      if (isMultiSelect) {
        // 批量复制（暂时只复制第一张，后续可以实现批量复制）
        await handleCopyImage(imagesToProcess[0]);
        ElMessage.success(`已复制 ${imagesToProcess.length} 张图片`);
      } else {
        await handleCopyImage(image);
      }
      break;
    case 'open':
      if (!isMultiSelect) {
        await handleOpenImagePath(image.localPath);
      }
      break;
    case 'openFolder':
      if (!isMultiSelect) {
        try {
          await invoke("open_file_folder", { filePath: image.localPath });
          ElMessage.success("已打开文件所在文件夹");
        } catch (error) {
          console.error("打开文件夹失败:", error);
          ElMessage.error("打开文件夹失败");
        }
      }
      break;
    case 'wallpaper':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }

      try {
        if (isMultiSelect) {
          // 多选：创建"桌面画册x"，添加到画册，开启轮播
          // 1. 找到下一个可用的"桌面画册x"名称
          await albumStore.loadAlbums();
          let albumName = "桌面画册1";
          let counter = 1;
          while (albums.value.some(a => a.name === albumName)) {
            counter++;
            albumName = `桌面画册${counter}`;
          }

          // 2. 创建画册
          const createdAlbum = await albumStore.createAlbum(albumName);

          // 3. 将选中的图片添加到画册
          const imageIds = imagesToProcess.map(img => img.id);
          await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);

          // 4. 获取当前设置
          const currentSettings = await invoke<{
            wallpaperRotationEnabled: boolean;
            wallpaperRotationAlbumId: string | null;
          }>("get_settings");

          // 5. 如果轮播未开启，开启它
          if (!currentSettings.wallpaperRotationEnabled) {
            await invoke("set_wallpaper_rotation_enabled", { enabled: true });
          }

          // 6. 设置轮播画册为新创建的画册
          await invoke("set_wallpaper_rotation_album_id", { albumId: createdAlbum.id });

          ElMessage.success(`已创建画册"${albumName}"并开启壁纸轮播（${imageIds.length} 张）`);
        } else {
          // 单选：直接设置壁纸
          await invoke("set_wallpaper", { filePath: image.localPath });
          ElMessage.success("壁纸设置成功");
        }

        galleryViewRef.value?.clearSelection?.();
      } catch (error) {
        console.error("设置壁纸失败:", error);
        ElMessage.error("设置壁纸失败: " + (error as Error).message);
      }
      break;
    case 'exportToWE':
    case 'exportToWEAuto':
      try {
        // 让用户输入工程名称
        const defaultName = isMultiSelect
          ? `Kabegame_Gallery_${imagesToProcess.length}_Images`
          : `Kabegame_${image.id}`;

        const { value: projectName } = await ElMessageBox.prompt(
          `请输入 WE 工程名称（留空使用默认名称）`,
          "导出到 Wallpaper Engine",
          {
            confirmButtonText: "导出",
            cancelButtonText: "取消",
            inputPlaceholder: defaultName,
            inputValidator: (value) => {
              if (value && value.trim().length > 64) {
                return "名称不能超过 64 个字符";
              }
              return true;
            },
          }
        ).catch(() => ({ value: null })); // 用户取消时返回 null

        if (projectName === null) break; // 用户取消

        let outputParentDir = "";
        if (command === "exportToWEAuto") {
          const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
          if (!mp) {
            ElMessage.warning("未配置 Wallpaper Engine 目录：请到 设置 -> 壁纸轮播 -> Wallpaper Engine 目录 先选择");
            break;
          }
          outputParentDir = mp;
        } else {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "选择导出目录（将自动创建 Wallpaper Engine 工程文件夹）",
          });
          if (!selected || Array.isArray(selected)) break;
          outputParentDir = selected;
        }

        // 使用用户输入的名称，如果为空则使用默认名称
        const finalName = projectName?.trim() || defaultName;

        const res = await invoke<{ projectDir: string; imageCount: number }>(
          "export_images_to_we_project",
          {
            imagePaths: imagesToProcess.map((img) => img.localPath),
            title: finalName,
            outputParentDir,
            options: null,
          }
        );
        ElMessage.success(`已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`);
        await invoke("open_file_path", { filePath: res.projectDir });
      } catch (error) {
        if (error !== "cancel") {
          console.error("导出 Wallpaper Engine 工程失败:", error);
          ElMessage.error("导出失败");
        }
      }
      break;
    case 'addToAlbum':
      // 仅当多选时右键多选的其中一个时才能批量操作
      if (isMultiSelect && !selectedSet.has(image.id)) {
        ElMessage.warning("请右键点击已选中的图片");
        return;
      }

      openAddToAlbumDialog(imagesToProcess);
      break;
    case 'remove':
      await handleBatchRemove(imagesToProcess);
      break;
    case 'delete':
      await handleBatchDelete(imagesToProcess);
      break;
  }
};

type FavoriteStatusChangedDetail = { imageIds: string[]; favorite: boolean };

const applyFavoriteChangeToGalleryCache = (imageIds: string[], favorite: boolean) => {
  if (!imageIds || imageIds.length === 0) return;
  const idSet = new Set(imageIds);

  // “仅收藏”模式下，取消收藏应直接从列表移除
  if (showFavoritesOnly.value && !favorite) {
    displayedImages.value = displayedImages.value.filter((img) => !idSet.has(img.id));
    crawlerStore.images = [...displayedImages.value];
    galleryViewRef.value?.clearSelection?.();
    return;
  }

  // 就地更新 favorite 字段（避免全量刷新）
  let changed = false;
  const next = displayedImages.value.map((img) => {
    if (!idSet.has(img.id)) return img;
    if ((img.favorite ?? false) === favorite) return img;
    changed = true;
    return { ...img, favorite };
  });
  if (changed) {
    displayedImages.value = next;
    crawlerStore.images = [...next];
  }
};

// 批量移除图片（只删除缩略图和数据库记录，不删除原图）
const handleBatchRemove = async (imagesToProcess: ImageInfo[]) => {
  if (imagesToProcess.length === 0) return;

  try {
    const count = imagesToProcess.length;
    await ElMessageBox.confirm(
      `将从画廊移除，但保留原图文件。是否继续移除${count > 1 ? `这 ${count} 张图片` : '这张图片'}？`,
      "确认移除",
      { type: "warning" }
    );

    for (const img of imagesToProcess) {
      await crawlerStore.removeImage(img.id);
    }

    // 从 displayedImages 中移除已移除的图片
    displayedImages.value = displayedImages.value.filter(img => !imagesToProcess.some(remImg => remImg.id === img.id));

    // 清理 imageSrcMap 和 Blob URL
    for (const img of imagesToProcess) {
      const imageData = imageSrcMap.value[img.id];
      if (imageData) {
        if (imageData.thumbnail) {
          URL.revokeObjectURL(imageData.thumbnail);
        }
        if (imageData.original) {
          URL.revokeObjectURL(imageData.original);
        }
        delete imageSrcMap.value[img.id];
      }
    }

    galleryViewRef.value?.clearSelection?.();

    ElMessage.success(`${count > 1 ? `已移除 ${count} 张图片` : '已移除图片'}`);
  } catch (error) {
    if (error !== "cancel") {
      console.error("移除图片失败:", error);
      ElMessage.error("移除失败");
    }
  }
};

// 批量删除图片
const handleBatchDelete = async (imagesToProcess: ImageInfo[]) => {
  if (imagesToProcess.length === 0) return;

  try {
    const count = imagesToProcess.length;
    await ElMessageBox.confirm(
      `删除后将同时移除原图、缩略图及数据库记录，且无法恢复。是否继续删除${count > 1 ? `这 ${count} 张图片` : '这张图片'}？`,
      "确认删除",
      { type: "warning" }
    );

    for (const img of imagesToProcess) {
      await crawlerStore.deleteImage(img.id);
    }

    // 从 displayedImages 中移除已删除的图片
    displayedImages.value = displayedImages.value.filter(img => !imagesToProcess.some(delImg => delImg.id === img.id));

    // 清理 imageSrcMap 和 Blob URL
    for (const img of imagesToProcess) {
      const imageData = imageSrcMap.value[img.id];
      if (imageData) {
        if (imageData.thumbnail) {
          URL.revokeObjectURL(imageData.thumbnail);
          blobUrls.delete(imageData.thumbnail);
        }
        if (imageData.original) {
          URL.revokeObjectURL(imageData.original);
          blobUrls.delete(imageData.original);
        }
      }
      const { [img.id]: _, ...rest } = imageSrcMap.value;
      imageSrcMap.value = rest;
    }

    ElMessage.success(`已删除 ${count} 张图片`);
    galleryViewRef.value?.clearSelection?.();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error("删除失败");
    }
  }
};

// 批量从 UI 缓存里移除（用于后端批量去重后的同步）
const removeFromUiCacheByIds = (imageIds: string[]) => {
  if (!imageIds || imageIds.length === 0) return;
  const idSet = new Set(imageIds);

  // 从列表移除
  displayedImages.value = displayedImages.value.filter((img) => !idSet.has(img.id));

  // 清理 imageSrcMap / Blob URL / loaded set
  const nextMap: Record<string, { thumbnail?: string; original?: string }> = {
    ...imageSrcMap.value,
  };
  for (const id of imageIds) {
    const data = nextMap[id];
    if (data?.thumbnail) {
      URL.revokeObjectURL(data.thumbnail);
      blobUrls.delete(data.thumbnail);
    }
    if (data?.original) {
      URL.revokeObjectURL(data.original);
      blobUrls.delete(data.original);
    }
    delete nextMap[id];
    loadedImageIds.delete(id);
  }
  imageSrcMap.value = nextMap;

  galleryViewRef.value?.clearSelection?.();
};

// 画廊按 hash 去重（remove 而非 delete）
const handleDedupeByHash = async () => {
  if (dedupeLoading.value) return;

  try {
    await ElMessageBox.confirm(
      "去掉所有重复图片：仅从画廊移除，不会删除源文件。是否继续？",
      "确认去重",
      { type: "warning" }
    );

    dedupeProcessing.value = true;

    // 若当前有下载任务在跑，开启“强制去重模式”，直到下载队列空闲才自动结束
    const startRes = await invoke<{ willWaitUntilDownloadsEnd: boolean }>(
      "start_force_deduplicate"
    );
    dedupeWaitingDownloads.value = !!startRes?.willWaitUntilDownloadsEnd;

    const res = await invoke<{ removed: number; removedIds: string[] }>(
      "dedupe_gallery_by_hash"
    );
    const removedIds = res?.removedIds ?? [];

    if (removedIds.length > 0) {
      removeFromUiCacheByIds(removedIds);
      crawlerStore.applyRemovedImageIds(removedIds);
    }

    ElMessage.success(`已清理 ${res?.removed ?? removedIds.length} 个重复项（仅从画廊移除，源文件已保留）`);

    // 若当前已加载列表被清空，则自动刷新一次（避免停留在空状态）
    if (displayedImages.value.length === 0) {
      await loadImages(true);
      if (displayedImages.value.length === 0 && crawlerStore.hasMore) {
        await loadMoreImages();
      }
    }
  } catch (error) {
    if (error !== "cancel") {
      console.error("去重失败:", error);
      ElMessage.error("去重失败");
      // 兜底：出错时关闭强制去重，避免一直影响后续下载
      try {
        await invoke("stop_force_deduplicate");
      } catch {
        // ignore
      }
      dedupeWaitingDownloads.value = false;
    }
  } finally {
    dedupeProcessing.value = false;
  }
};

const handleCopyImage = async (image: ImageInfo) => {
  try {
    // 获取图片的 Blob URL
    const imageUrl = imageSrcMap.value[image.id]?.original || imageSrcMap.value[image.id]?.thumbnail;
    if (!imageUrl) {
      ElMessage.warning("图片尚未加载完成，请稍后再试");
      return;
    }

    // 从 Blob URL 获取 Blob
    const response = await fetch(imageUrl);
    let blob = await response.blob();

    // 如果 blob 类型是 image/jpeg，转换为 PNG（因为某些浏览器不支持 image/jpeg）
    if (blob.type === 'image/jpeg' || blob.type === 'image/jpg') {
      // 创建一个 canvas 来转换图片格式
      const img = new Image();
      img.src = imageUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('无法创建 canvas context');
      }
      ctx.drawImage(img, 0, 0);

      // 将 canvas 转换为 PNG blob
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('转换图片失败'));
          }
        }, 'image/png');
      });
    }

    // 使用 Clipboard API 复制图片
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob
      })
    ]);

    ElMessage.success("图片已复制到剪贴板");
  } catch (error) {
    console.error("复制图片失败:", error);
    ElMessage.error("复制图片失败");
  }
};


/**
 * 刷新列表并尽量复用已有项，避免全量图片重新加载。
 * @param reset 是否从第一页重置加载
 * @param opts.preserveScroll 是否保留当前滚动位置（用于 image-added 事件，避免回到顶部）
 * @param opts.forceReload 是否强制重新加载所有图片 URL（清除缓存）
 * @param opts.skipScrollReset 是否跳过滚动重置（用于 onActivated，由调用者自行恢复滚动位置）
 */
const refreshImagesPreserveCache = async (
  reset = true,
  opts: { preserveScroll?: boolean; forceReload?: boolean; skipScrollReset?: boolean } = {}
) => {
  loading.value = true;
  // 延迟300ms显示骨架屏，避免快速加载时的闪烁
  if (skeletonTimer.value) {
    clearTimeout(skeletonTimer.value);
  }
  skeletonTimer.value = setTimeout(() => {
    if (loading.value) {
      showSkeleton.value = true;
    }
  }, 300);
  try {
    const preserveScroll = opts.preserveScroll ?? false;
    const forceReload = opts.forceReload ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;
    const container = preserveScroll
      ? galleryContainerRef.value
      : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    // 如果强制重新加载，清除 URL 缓存并清空列表以触发重新挂载动画
    if (forceReload) {
      // 释放所有 Blob URL
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
      blobUrls.clear();
      imageSrcMap.value = {};
      loadedImageIds.clear();
      // 先清空列表，让 Vue 移除所有元素
      displayedImages.value = [];
      await nextTick();
    }

    // 记录旧的图片 ID，用于判断哪些是新增的
    const oldIds = forceReload ? new Set<string>() : new Set(displayedImages.value.map((img) => img.id));

    await crawlerStore.loadImages(reset, filterPluginId.value, showFavoritesOnly.value);

    // 使用新的图片数据（不复用旧引用，确保数据更新）
    displayedImages.value = [...crawlerStore.images];

    await nextTick();

    // 为需要加载的图片加载 URL
    const imagesToLoad = forceReload ? displayedImages.value : displayedImages.value.filter((img) => !oldIds.has(img.id));
    loadImageUrls(imagesToLoad);

    // 滚动处理：skipScrollReset 时跳过任何滚动操作（由调用者自行处理）
    if (!skipScrollReset) {
      if (preserveScroll && container) {
        container.scrollTop = prevScrollTop;
      } else if (reset) {
        const c = container ?? galleryContainerRef.value;
        if (c) c.scrollTop = 0;
      }
    }

    galleryViewRef.value?.clearSelection?.();
  } finally {
    loading.value = false;
    // 立即隐藏骨架屏
    showSkeleton.value = false;
    if (skeletonTimer.value) {
      clearTimeout(skeletonTimer.value);
      skeletonTimer.value = null;
    }
  }
};

/**
 * 仅增量获取最新一页图片并追加到末尾，避免全量刷新和旧图重载。
 * 
 * 重要规则：
 * - 当 hasMore=true（有加载更多按钮）时，不自动增长画廊，新图片藏在"加载更多"里
 * - 当 hasMore=false（没有更多了）时，画廊自动增长，且不会自动设置 hasMore=true
 * - 当画廊为空时，使用正常的分页加载初始化，而不是增量刷新
 * - hasMore 只在用户主动刷新时由分页逻辑设置，增量刷新不会让"加载更多"按钮出现
 */
const refreshLatestIncremental = async () => {
  try {
    // 如果画廊为空，使用正常的分页加载初始化（确保 store 状态正确同步）
    if (displayedImages.value.length === 0) {
      await loadImages(true);
      return;
    }

    // 如果还有更多未加载（hasMore=true），不自动增长画廊
    // 新下载的图片会藏在"加载更多"按钮里
    if (crawlerStore.hasMore) {
      return;
    }

    // hasMore=false 时，画廊自动增长
    // 获取足够多的图片以包含所有新增的（不限于 pageSize）
    const existingIds = new Set(displayedImages.value.map((img) => img.id));

    // 使用较大的 pageSize 来获取所有可能的新图片
    // 但不要超过合理范围，避免一次加载太多
    const fetchSize = Math.max(crawlerStore.pageSize, displayedImages.value.length + 100);
    const result = await invoke<{
      images: ImageInfo[];
      total: number;
      page: number;
      pageSize: number;
    }>("get_images_paginated", {
      page: 0,
      pageSize: fetchSize,
      pluginId: filterPluginId.value || null,
    });

    const newOnes = result.images.filter((img) => !existingIds.has(img.id));

    // 更新 hasMore：只在确定已拿到全部数据时将其关闭，避免遗留的 true 导致按钮出现
    const totalAfterAdd = displayedImages.value.length + newOnes.length;
    if (totalAfterAdd >= result.total) {
      crawlerStore.hasMore = false;
    }

    if (newOnes.length === 0) return;

    // 将新增图片追加到列表末尾
    displayedImages.value = [...displayedImages.value, ...newOnes];

    // 同步 crawlerStore 状态，保持与 displayedImages 一致
    crawlerStore.images = [...displayedImages.value];
    crawlerStore.totalImages = result.total;
    // 计算正确的 currentPage（基于当前显示数量）
    crawlerStore.currentPage = Math.ceil(displayedImages.value.length / crawlerStore.pageSize);

    // 加载新增图片的 URL
    await loadImageUrls(newOnes);

  } catch (error) {
    console.error("增量刷新最新图片失败:", error);
  }
};

// 兼容旧调用：保留原函数名
const loadImages = refreshImagesPreserveCache;

// 加载更多图片（手动加载）
// 直接基于 displayedImages 的长度计算下一页，不依赖 crawlerStore.currentPage
// 避免 displayedImages 和 crawlerStore.images 不同步导致的问题
const loadMoreImages = async () => {
  if (!crawlerStore.hasMore || isLoadingMore.value) {
    return;
  }

  isLoadingMore.value = true; // 设置标志，防止 watch 触发
  const container = galleryContainerRef.value;
  if (!container) {
    isLoadingMore.value = false;
    return;
  }

  // 记录加载前的滚动位置
  const prevScrollTop = container.scrollTop;

  try {
    // 计算下一页的页码（基于当前显示的图片数量）
    const nextPage = Math.floor(displayedImages.value.length / crawlerStore.pageSize);

    // 直接从后端获取下一页，不依赖 crawlerStore.loadImages
    const result = await invoke<{
      images: ImageInfo[];
      total: number;
      page: number;
      pageSize: number;
    }>("get_images_paginated", {
      page: nextPage,
      pageSize: crawlerStore.pageSize,
      pluginId: filterPluginId.value || null,
      favoritesOnly: showFavoritesOnly.value || null,
    });

    // 过滤出新图片（避免重复，因为增量刷新可能已经添加了部分图片）
    const existingIds = new Set(displayedImages.value.map(img => img.id));
    const newImages = result.images.filter(img => !existingIds.has(img.id));

    if (newImages.length > 0) {
      // 创建新数组引用，确保 Vue 能够检测到变化（特别是 transition-group）
      displayedImages.value = [...displayedImages.value, ...newImages];

      // 等待 DOM 更新完成
      await nextTick();

      // 恢复滚动位置：保持用户原来的滚动位置
      // 使用延迟策略，确保动画和图片加载完成后恢复
      setTimeout(() => {
        if (container) {
          container.scrollTop = prevScrollTop;
        }
      }, 100);

      // 仅为新增的图片加载 URL，避免触发旧图重新加载
      await loadImageUrls(newImages);
      galleryViewRef.value?.clearSelection?.();
    }

    // 更新 hasMore：基于当前显示数量与总数比较
    const totalDisplayed = displayedImages.value.length;
    crawlerStore.hasMore = totalDisplayed < result.total;

    // 同步 crawlerStore 状态，保持一致性
    crawlerStore.images = [...displayedImages.value];
    crawlerStore.currentPage = nextPage + 1;
    crawlerStore.totalImages = result.total;
  } catch (error) {
    console.error("加载更多图片失败:", error);
    ElMessage.error("加载失败");
  } finally {
    // 延迟重置标志，确保 watch 不会立即触发
    setTimeout(() => {
      isLoadingMore.value = false;
    }, 100);
  }
};

const selectOutputDir = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
    });

    if (selected && typeof selected === "string") {
      form.value.outputDir = selected;
    }
  } catch (error) {
    console.error("选择目录失败:", error);
  }
};

const selectFolder = async (varKey: string) => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
    });

    if (selected && typeof selected === "string") {
      form.value.vars[varKey] = selected;
    }
  } catch (error) {
    console.error("选择目录失败:", error);
    ElMessage.error("选择目录失败");
  }
};

const selectFile = async (varKey: string) => {
  try {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "图片",
          extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
        },
      ],
    });

    if (selected && typeof selected === "string") {
      form.value.vars[varKey] = selected;
    }
  } catch (error) {
    console.error("选择文件失败:", error);
    ElMessage.error("选择文件失败");
  }
};

const handleStartCrawl = async () => {
  try {
    // 若选择了运行配置，直接运行配置
    if (selectedRunConfigId.value) {
      await crawlerStore.runConfig(selectedRunConfigId.value);
      showCrawlerDialog.value = false;
      return;
    }

    if (!form.value.pluginId) {
      ElMessage.warning("请选择源");
      return;
    }

    // 验证表单
    if (formRef.value) {
      try {
        await formRef.value.validate();
      } catch (error) {
        ElMessage.warning("请填写所有必填项");
        return;
      }
    }

    // 手动验证必填的插件配置项
    for (const varDef of pluginVars.value) {
      if (isRequired(varDef)) {
        const value = form.value.vars[varDef.key];
        if (value === undefined || value === null || value === '' ||
          ((varDef.type === 'list' || varDef.type === 'checkbox') && Array.isArray(value) && value.length === 0)) {
          ElMessage.warning(`请填写必填项：${varDef.name}`);
          return;
        }
      }
    }

    // 运行/保存配置时，userConfig 统一传对象（至少是 {}），避免“预设保存后 userConfig 为空导致后端未注入变量”
    const backendVars =
      pluginVars.value.length > 0
        ? expandVarsForBackend(form.value.vars, pluginVars.value as PluginVarDef[])
        : undefined;

    // 保存用户配置（如果有变量定义）
    if (pluginVars.value.length > 0 && backendVars && Object.keys(backendVars).length > 0) {
      await invoke("save_plugin_config", {
        pluginId: form.value.pluginId,
        config: backendVars,
      });
    }

    // 可选：保存为运行配置（不影响本次直接运行）
    if (saveAsConfig.value) {
      if (!configName.value.trim()) {
        ElMessage.warning("请输入配置名称");
        return;
      }
      await crawlerStore.addRunConfig({
        name: configName.value.trim(),
        description: configDescription.value?.trim() || undefined,
        pluginId: form.value.pluginId,
        url: "",
        outputDir: form.value.outputDir || undefined,
        userConfig: backendVars,
      });
    }

    // 添加任务（异步执行，不等待完成）
    crawlerStore.addTask(
      form.value.pluginId,
      "",
      form.value.outputDir || undefined,
      backendVars
    ).catch(error => {
      // 这里的错误是任务初始化失败，由 watch 监听来处理任务状态变化时的错误显示
      console.error("任务执行失败:", error);
    });

    // 重置表单
    form.value.outputDir = "";
    saveAsConfig.value = false;
    configName.value = "";
    configDescription.value = "";
    // 关闭对话框
    showCrawlerDialog.value = false;
  } catch (error) {
    console.error("添加任务失败:", error);
    // 只处理添加任务时的错误（如保存配置失败），执行错误由 watch 处理
    ElMessage.error(error instanceof Error ? error.message : "添加任务失败");
  }
};

const loadPluginVars = async (pluginId: string) => {
  try {
    const vars = await invoke<Array<{ key: string; type: string; name: string; descripts?: string; default?: any; options?: VarOption[] }> | null>("get_plugin_vars", {
      pluginId,
    });
    pluginVars.value = vars || [];

    // DEV 调试：确认后端实际返回的 var 定义是否已更新（排查“插件已更新但导入仍旧配置”）
    if (import.meta.env.DEV) {
      console.info("[loadPluginVars] get_plugin_vars result:", {
        pluginId,
        vars: pluginVars.value,
      });
    }

    // 加载已保存的用户配置
    const savedConfig = await invoke<Record<string, any>>("load_plugin_config", {
      pluginId,
    });

    if (import.meta.env.DEV) {
      console.info("[loadPluginVars] load_plugin_config result:", {
        pluginId,
        savedConfig,
      });
    }

    // 将保存的配置聚合为 UI 表单模型（checkbox: foo -> ["a","b"]），并补默认值
    form.value.vars = normalizeVarsForUI(savedConfig || {}, pluginVars.value as PluginVarDef[]);
  } catch (error) {
    console.error("加载插件变量失败:", error);
    pluginVars.value = [];
  }
};

// 监听插件选择变化
watch(() => form.value.pluginId, (newPluginId) => {
  if (newPluginId) {
    loadPluginVars(newPluginId);
  } else {
    pluginVars.value = [];
    form.value.vars = {};
  }
});

watch(selectedRunConfigId, async (cfgId) => {
  if (!cfgId) {
    // 取消选择配置，保持当前表单，不自动清空
    return;
  }

  const cfg = runConfigs.value.find(c => c.id === cfgId);
  if (!cfg) {
    await ElMessageBox.alert("运行配置不存在，请重新选择", "配置无效", { type: "warning" });
    selectedRunConfigId.value = null;
    return;
  }

  // 先检查已缓存的兼容性状态（快速检查）
  const cachedCompatibility = configCompatibilityStatus.value[cfgId];
  if (cachedCompatibility) {
    // 如果已知不兼容：禁止“一键使用”，但允许“载入到表单”
    if (!cachedCompatibility.versionCompatible || !cachedCompatibility.contentCompatible) {
      const id = cfgId;
      // 先清空选择，避免表单被锁定、也避免用户误触“一键使用配置”
      selectedRunConfigId.value = null;
      await loadConfigToForm(id);
      return;
    }
  }

  // 检查兼容性（确保获取最新状态）
  const compatibility = await getConfigCompatibility(cfgId);

  // 第一步：检查版本兼容性（插件是否存在）
  if (!compatibility.versionCompatible) {
    await ElMessageBox.alert(
      `该配置关联的插件不存在：${compatibility.versionReason || "未知错误"}\n无法使用该配置。`,
      "插件缺失",
      { type: "error" }
    );
    selectedRunConfigId.value = null;
    form.value.pluginId = "";
    form.value.outputDir = "";
    form.value.vars = {};
    return;
  }

  // 第二步：检查内容兼容性
  if (!compatibility.contentCompatible) {
    const id = cfgId;
    selectedRunConfigId.value = null;
    await loadConfigToForm(id);
    return;
  }

  // 选择现有配置时，不允许继续勾选"保存为配置"
  saveAsConfig.value = false;
  configName.value = "";
  configDescription.value = "";

  // 先写入配置字段
  form.value.pluginId = cfg.pluginId;
  form.value.outputDir = cfg.outputDir || "";
  form.value.vars = {};

  // 加载插件变量定义（异步），用于校验必填项是否满足
  await loadPluginVars(cfg.pluginId);

  // 智能匹配配置项
  const userConfig = cfg.userConfig || {};
  const matchedVars: Record<string, any> = {};
  const varDefMap = new Map(pluginVars.value.map(def => [def.key, def]));

  // 尝试匹配每个配置字段
  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);

    if (!varDef) {
      // 字段已删除，跳过
      continue;
    }

    // 验证值是否有效
    const validation = validateVarValue(value, varDef);
    if (validation.valid) {
      // 值有效，直接使用
      matchedVars[key] = value;
    } else {
      // 值无效，使用默认值（如果有）
      if (varDef.default !== undefined) {
        matchedVars[key] = varDef.default;
      }
    }
  }

  // 填充缺失字段的默认值
  for (const varDef of pluginVars.value) {
    if (!(varDef.key in matchedVars)) {
      if (varDef.default !== undefined) {
        matchedVars[varDef.key] = varDef.default;
      }
    }
  }

  // 转换为 UI 格式
  const cfgUiVars = normalizeVarsForUI(matchedVars, pluginVars.value as PluginVarDef[]);

  // 检查必填项
  const missingRequired = pluginVars.value.filter((varDef) => {
    if (!isRequired(varDef)) return false;
    const value = cfgUiVars[varDef.key];
    if (value === undefined || value === null || value === "") return true;
    if ((varDef.type === "list" || varDef.type === "checkbox") && Array.isArray(value) && value.length === 0) return true;
    return false;
  });

  if (missingRequired.length > 0) {
    const names = missingRequired.map(v => v.name).join("、");
    await ElMessageBox.alert(`该配置缺少必填项：${names}。请检查配置变量。`, "配置不完整", { type: "warning" });
    selectedRunConfigId.value = null;
    // 保留表单内容方便用户直接修正
    return;
  }

  // 使用配置中的变量覆盖 loadPluginVars 填充的默认值
  form.value.vars = { ...form.value.vars, ...cfgUiVars };
});

// 监听筛选插件ID变化，重新加载图片
watch(filterPluginId, () => {
  loadImages(true);
});

// 监听仅显示收藏变化，重新加载图片
watch(showFavoritesOnly, () => {
  loadImages(true);
  galleryViewRef.value?.clearSelection?.();
});

// 处理图片拖拽排序
const handleImageReorder = async (newOrder: ImageInfo[]) => {
  try {
    // 计算新的 order 值（间隔 1000）
    const imageOrders: [string, number][] = newOrder.map((img, index) => [
      img.id,
      (index + 1) * 1000,
    ]);

    await invoke("update_images_order", { imageOrders });

    // 更新本地显示顺序
    displayedImages.value = newOrder;

    // 同时更新 store 中的顺序
    const newStoreOrder = newOrder.map(img =>
      crawlerStore.images.find(i => i.id === img.id) || img
    );
    crawlerStore.images = newStoreOrder;

    ElMessage.success("顺序已更新");
  } catch (error) {
    console.error("更新图片顺序失败:", error);
    ElMessage.error("更新顺序失败");
  }
};

// 处理箭头移动
const handleImageMove = async (image: ImageInfo, direction: "up" | "down" | "left" | "right") => {
  const currentIndex = displayedImages.value.findIndex(img => img.id === image.id);
  if (currentIndex === -1) return;

  // 计算实际列数（用于计算上下移动的目标）
  let columns = galleryColumns.value;
  if (columns === 0) {
    // 对于 auto-fill，从 DOM 计算实际列数
    const gridElement = document.querySelector('.image-grid');
    if (gridElement && gridElement.children.length > 0) {
      // 收集所有元素的 top 位置，找出第一行的 top 值
      const positions: Array<{ top: number; index: number }> = [];
      for (let i = 0; i < gridElement.children.length; i++) {
        const child = gridElement.children[i] as HTMLElement;
        const rect = child.getBoundingClientRect();
        positions.push({ top: rect.top, index: i });
      }

      // 找到第一行的 top 值（最小的 top 值）
      if (positions.length > 0) {
        const firstRowTop = Math.min(...positions.map(p => p.top));
        // 计算第一行有多少个元素（top 值相近的元素）
        const firstRowCount = positions.filter(p => Math.abs(p.top - firstRowTop) < 10).length;
        if (firstRowCount > 0) {
          columns = firstRowCount;
        }
      }

      // 如果还是计算失败，使用第一个元素的方法作为回退
      if ((columns === 0 || columns === 1) && gridElement.firstElementChild) {
        const firstChild = gridElement.firstElementChild as HTMLElement;
        const firstRect = firstChild.getBoundingClientRect();
        let cols = 1;
        // 遍历所有子元素，找到有多少个和第一个元素在同一行
        for (let i = 1; i < gridElement.children.length; i++) {
          const child = gridElement.children[i] as HTMLElement;
          const childRect = child.getBoundingClientRect();
          // 使用更宽松的阈值
          if (Math.abs(childRect.top - firstRect.top) < 15) {
            cols++;
          } else {
            break; // 遇到下一行就停止
          }
        }
        if (cols > columns) {
          columns = cols;
        }
      }
    }

    // 最后的回退：如果还是计算失败，使用估算值
    if (columns === 0 || columns === 1) {
      const estimatedCols = Math.ceil(Math.sqrt(displayedImages.value.length));
      if (estimatedCols > 1 && displayedImages.value.length > estimatedCols) {
        columns = estimatedCols;
      } else if (displayedImages.value.length > 1) {
        // 如果有多张图片，至少有2列
        columns = Math.min(4, Math.max(2, Math.floor(displayedImages.value.length / 2)));
      } else {
        columns = 1;
      }
    }
  }

  let targetIndex = -1;

  switch (direction) {
    case "up":
      // 向上移动：和上一行的同一列交换
      // 当前列号 = currentIndex % columns
      // 上一行同一列 = (Math.floor(currentIndex / columns) - 1) * columns + (currentIndex % columns)
      // 简化：currentIndex - columns
      targetIndex = currentIndex - columns;
      break;
    case "down":
      // 向下移动：和下一行的同一列交换
      // 当前列号 = currentIndex % columns
      // 下一行同一列 = (Math.floor(currentIndex / columns) + 1) * columns + (currentIndex % columns)
      // 简化：currentIndex + columns
      targetIndex = currentIndex + columns;
      break;
    case "left":
      targetIndex = currentIndex - 1;
      break;
    case "right":
      targetIndex = currentIndex + 1;
      break;
  }

  // 检查目标索引是否有效
  if (targetIndex < 0 || targetIndex >= displayedImages.value.length) {
    return;
  }

  // 验证上下移动时是否在同一列
  if (direction === "up" || direction === "down") {
    const currentCol = currentIndex % columns;
    const targetCol = targetIndex % columns;
    if (currentCol !== targetCol) {
      // 如果列号不匹配，说明计算错误，不执行交换
      console.warn(`列号不匹配: currentCol=${currentCol}, targetCol=${targetCol}, currentIndex=${currentIndex}, targetIndex=${targetIndex}, columns=${columns}`);
      return;
    }
  }

  // 创建新的顺序数组：交换两个位置
  const newOrder = [...displayedImages.value];
  const temp = newOrder[currentIndex];
  newOrder[currentIndex] = newOrder[targetIndex];
  newOrder[targetIndex] = temp;

  // 调用 reorder 处理函数
  await handleImageReorder(newOrder);
};

// 监听图片列表变化，加载图片 URL
// 监听整个数组，但使用 shallow 模式减少深度追踪
// 当图片列表变化时（包括 filter 等情况），自动加载新图片的 URL
let imageListWatch: (() => void) | null = null;

// 可控 immediate，避免加载更多后立刻对全量列表触发 loadImageUrls
const setupImageListWatch = (immediate = true) => {
  if (imageListWatch) {
    imageListWatch(); // 停止之前的 watch
  }
  imageListWatch = watch(() => displayedImages.value, () => {
    // 如果正在加载更多，不触发 loadImageUrls（由 loadMoreImages 自己处理）
    if (isLoadingMore.value) {
      return;
    }

    // 图片列表变化时，加载新图片的 URL
    // loadImageUrls 内部会检查并跳过已加载的图片，所以可以安全地重复调用
    loadImageUrls();
  }, { immediate });
};

setupImageListWatch();

// 监听插件列表变化，加载新插件的图标
watch(plugins, () => {
  loadPluginIcons();
}, { deep: true });

// 记录已经显示过弹窗的任务ID，避免重复弹窗
const shownErrorTasks = new Set<string>();

// 监听任务状态变化，在失败时弹窗显示错误（仅作为兜底，主要通过事件触发）
watch(tasks, (newTasks, oldTasks) => {
  if (!oldTasks || oldTasks.length === 0) return;

  // 检查是否有新失败的任务
  newTasks.forEach(task => {
    const oldTask = oldTasks.find(t => t.id === task.id);
    if (oldTask && oldTask.status !== 'failed' && task.status === 'failed') {
      // 如果已经通过事件显示过弹窗，不再显示
      if (shownErrorTasks.has(task.id)) {
        return;
      }

      // 标记为已显示
      shownErrorTasks.add(task.id);

      // 任务失败，弹窗显示错误（仅作为兜底，如果事件没有触发）
      const pluginName = getPluginName(task.pluginId);

      // 如果进度为0%或错误信息包含"Script execution error"，说明脚本执行出错，使用弹窗显示详细错误信息
      if (task.progress === 0 || (task.error && task.error.includes("Script execution error"))) {
        // 使用 nextTick 确保在下一个事件循环中显示弹窗，避免阻塞
        nextTick(() => {
          ElMessageBox.alert(
            `脚本执行出错：\n${task.error || '未知错误'}`,
            `${pluginName} 执行失败`,
            {
              type: 'error',
              confirmButtonText: '确定',
            }
          ).catch(() => {
            // 用户可能关闭了弹窗，忽略错误
          });
        });
      } else {
        // 其他错误使用消息提示
        ElMessage.error(`${pluginName} 执行失败: ${task.error || '未知错误'}`);
      }
    }
  });
}, { deep: true });
// 加载设置
const loadSettings = async () => {
  try {
    const settings = await invoke<{
      imageClickAction: string;
      galleryColumns: number;
      galleryImageAspectRatioMatchWindow: boolean;
      galleryPageSize: number;
    }>("get_settings");
    imageClickAction.value = (settings.imageClickAction === "open" ? "open" : "preview") as "preview" | "open";
    galleryColumns.value = settings.galleryColumns || 0;
    galleryImageAspectRatioMatchWindow.value = settings.galleryImageAspectRatioMatchWindow || false;
    if (settings.galleryPageSize && settings.galleryPageSize > 0) {
      crawlerStore.setPageSize(settings.galleryPageSize);
    }
  } catch (error) {
    console.error("加载设置失败:", error);
  }
};

// 更新窗口宽高比
const updateWindowAspectRatio = () => {
  windowAspectRatio.value = window.innerWidth / window.innerHeight;
};

// 监听窗口大小变化
const handleResize = () => {
  updateWindowAspectRatio();
};

// 调整列数的函数
const adjustColumns = (delta: number) => {
  if (delta > 0) {
    // 增加列数（最大 10 列）
    if (galleryColumns.value === 0) {
      // 如果当前是自动，设置为 5 列
      galleryColumns.value = 5;
    } else if (galleryColumns.value < 10) {
      galleryColumns.value++;
    }
  } else {
    // 减少列数（最小 1 列，0 表示自动）
    if (galleryColumns.value > 1) {
      galleryColumns.value--;
    } else if (galleryColumns.value === 1) {
      // 从 1 列变为自动
      galleryColumns.value = 0;
    }
  }
  // 保存设置
  invoke("set_gallery_columns", { columns: galleryColumns.value }).catch((error) => {
    console.error("保存列数设置失败:", error);
  });
};

// 节流函数
const throttle = <T extends (...args: any[]) => any>(func: T, delay: number): T => {
  let lastCall = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      return func(...args);
    }
  }) as T;
};

// 节流后的调整列数函数（100ms 节流）
const throttledAdjustColumns = throttle(adjustColumns, 100);

onMounted(async () => {
  await loadSettings();
  // 加载任务
  await crawlerStore.loadTasks();
  await pluginStore.loadPlugins();
  await crawlerStore.loadRunConfigs();
  // 确保在配置和插件都加载完成后检查兼容性
  await checkAllConfigsCompatibility();
  await loadPluginIcons(); // 加载插件图标
  await loadImages(true);

  // 初始化窗口宽高比
  updateWindowAspectRatio();

  // 添加窗口大小变化监听
  window.addEventListener('resize', handleResize);

  // 记录已经显示过弹窗的任务ID，避免重复弹窗
  const shownErrorTasks = new Set<string>();

  // 监听任务错误显示事件
  const errorDisplayHandler = ((event: CustomEvent<{ taskId: string; pluginId: string; error: string }>) => {
    const { taskId, pluginId, error } = event.detail;

    // 如果已经显示过弹窗，不再显示
    if (shownErrorTasks.has(taskId)) {
      return;
    }

    // 标记为已显示
    shownErrorTasks.add(taskId);

    const pluginName = getPluginName(pluginId);

    // 使用 nextTick 确保在下一个事件循环中显示弹窗
    nextTick(() => {
      ElMessageBox.alert(
        `脚本执行出错：\n${error || '未知错误'}`,
        `${pluginName} 执行失败`,
        {
          type: 'error',
          confirmButtonText: '确定',
        }
      ).catch(() => {
        // 用户可能关闭了弹窗，忽略错误
      });
    });
  }) as EventListener;

  window.addEventListener('task-error-display', errorDisplayHandler);

  // 保存处理器引用以便在卸载时移除
  (window as any).__taskErrorDisplayHandler = errorDisplayHandler;

  // 监听图片添加事件，实时同步画廊（仅增量刷新，避免全量图片重新加载）
  const { listen } = await import("@tauri-apps/api/event");
  let imageAddedRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
  const unlistenImageAdded = await listen<{ taskId: string; imageId: string }>(
    "image-added",
    async () => {
      // 防抖：500ms 内多次触发只执行一次刷新
      if (imageAddedRefreshTimeout) {
        clearTimeout(imageAddedRefreshTimeout);
      }
      imageAddedRefreshTimeout = setTimeout(async () => {
        await refreshLatestIncremental();
        imageAddedRefreshTimeout = null;
      }, 200);
    }
  );

  // 保存监听器引用以便在卸载时移除
  (window as any).__imageAddedUnlisten = unlistenImageAdded;

  // 监听后端通知：强制去重等待下载结束 -> 下载队列空闲
  const unlistenForceDedupeEnded = await listen("force-dedupe-ended", async () => {
    if (dedupeWaitingDownloads.value) {
      dedupeWaitingDownloads.value = false;
    }
  });
  (window as any).__forceDedupeEndedUnlisten = unlistenForceDedupeEnded;

  // 监听“收藏状态变化”（来自画册/其它页面对收藏画册的增删）
  const favoriteChangedHandler = ((event: Event) => {
    const ce = event as CustomEvent<FavoriteStatusChangedDetail>;
    const detail = ce.detail;
    if (!detail || !Array.isArray(detail.imageIds)) return;
    applyFavoriteChangeToGalleryCache(detail.imageIds, !!detail.favorite);
  }) as EventListener;
  window.addEventListener("favorite-status-changed", favoriteChangedHandler);
  (window as any).__favoriteStatusChangedHandler = favoriteChangedHandler;
});

// 在开发环境中监控组件更新，帮助调试重新渲染问题
// 开发期调试日志已移除，保持生产干净输出

// 组件激活时（keep-alive 缓存后重新显示）
onActivated(async () => {
  // 重新加载设置，确保使用最新的 pageSize 等配置
  const previousPageSize = crawlerStore.pageSize;
  await loadSettings();
  const newPageSize = crawlerStore.pageSize;

  // 如果图片列表为空，需要重新加载
  if (displayedImages.value.length === 0) {
    await loadImages(true);
    return;
  }

  // 检查 pageSize 是否发生变化，如果变化了需要重新加载图片
  if (previousPageSize !== newPageSize) {
    // pageSize 已变化，重新加载图片以使用新的 pageSize
    await loadImages(true);
    return;
  }

  // 检查并重新加载缺失的图片 URL
  // 统计缺失 URL 的图片数量
  let missingCount = 0;
  const imagesToReload: ImageInfo[] = [];

  for (const img of displayedImages.value) {
    const imageData = imageSrcMap.value[img.id];
    if (!imageData || (!imageData.thumbnail && !imageData.original)) {
      missingCount++;
      imagesToReload.push(img);
    } else {
      // 检查 Blob URL 是否仍然有效（在 blobUrls Set 中）
      const hasValidThumbnail = imageData.thumbnail && blobUrls.has(imageData.thumbnail);
      const hasValidOriginal = imageData.original && blobUrls.has(imageData.original);

      if (!hasValidThumbnail && !hasValidOriginal) {
        // Blob URL 已失效，需要重新加载
        missingCount++;
        imagesToReload.push(img);
        // 清理无效的条目
        delete imageSrcMap.value[img.id];
        loadedImageIds.delete(img.id);
      }
    }
  }

  // 如果缺失的图片数量较多（超过 10%），重新加载所有缺失的 URL
  if (missingCount > 0) {
    if (missingCount > displayedImages.value.length * 0.1) {
      // 缺失较多，重新加载所有缺失的图片 URL
      loadImageUrls(imagesToReload);
    } else {
      // 缺失较少，只加载缺失的部分
      loadImageUrls(imagesToReload);
    }
  }

});

// 组件停用时（keep-alive 缓存，但不清理 Blob URL）
onDeactivated(() => {
  // keep-alive 缓存时不清理 Blob URL，保持图片 URL 有效
  // 只移除事件监听器（如果需要的话）
});

// 组件真正卸载时（不是 keep-alive 缓存）
onUnmounted(() => {
  // 清理骨架屏定时器
  if (skeletonTimer.value) {
    clearTimeout(skeletonTimer.value);
    skeletonTimer.value = null;
  }
  // 移除窗口大小变化监听
  window.removeEventListener('resize', handleResize);

  // 释放所有 Blob URL，避免内存泄漏（只在真正卸载时清理）
  blobUrls.forEach(url => {
    URL.revokeObjectURL(url);
  });
  blobUrls.clear();
  imageSrcMap.value = {};
  loadedImageIds.clear();

  // 移除任务错误显示事件监听
  const handler = (window as any).__taskErrorDisplayHandler;
  if (handler) {
    window.removeEventListener('task-error-display', handler);
    delete (window as any).__taskErrorDisplayHandler;
  }

  // 移除图片添加事件监听
  const imageAddedUnlisten = (window as any).__imageAddedUnlisten;
  if (imageAddedUnlisten) {
    imageAddedUnlisten();
    delete (window as any).__imageAddedUnlisten;
  }

  // 移除强制去重结束事件监听
  const forceDedupeEndedUnlisten = (window as any).__forceDedupeEndedUnlisten;
  if (forceDedupeEndedUnlisten) {
    forceDedupeEndedUnlisten();
    delete (window as any).__forceDedupeEndedUnlisten;
  }

  // 移除收藏状态变化监听
  const favoriteChangedHandler = (window as any).__favoriteStatusChangedHandler;
  if (favoriteChangedHandler) {
    window.removeEventListener("favorite-status-changed", favoriteChangedHandler);
    delete (window as any).__favoriteStatusChangedHandler;
  }
});
</script>

<style lang="scss">
.gallery-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.gallery-container {
  width: 100%;
  flex: 1;
  padding: 20px;
  overflow-y: auto;

  /* 按住空格进入“拖拽滚动模式” */
  &.drag-scroll-ready {
    cursor: grab;
  }

  /* 正在拖拽滚动 */
  &.drag-scroll-active {
    cursor: grabbing;
    user-select: none;
  }

  .gallery-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding: 12px 16px;
    background: var(--anime-bg-card);
    border-radius: 12px;
    box-shadow: var(--anime-shadow);

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .add-task-btn {
      box-shadow: var(--anime-shadow);

      &:hover {
        transform: translateY(-2px);
        box-shadow: var(--anime-shadow-hover);
      }
    }

    .tasks-drawer-trigger {
      box-shadow: var(--anime-shadow);
      transition: all 0.3s ease;

      &:hover {
        transform: translateY(-2px);
        box-shadow: var(--anime-shadow-hover);
      }
    }

    .tasks-badge {
      display: block;

      /* 自定义 badge 数字样式：红色背景圆形 */
      :deep(.el-badge__content) {
        background-color: #f56c6c !important;
        border-color: #f56c6c !important;
        color: #fff !important;
        border-radius: 50% !important;
        min-width: 20px !important;
        height: 20px !important;
        line-height: 20px !important;
        padding: 0 6px !important;
        font-size: 12px !important;
        font-weight: 500 !important;
      }
    }
  }

  .load-more-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 32px 0;
    margin-top: 24px;
  }

  .context-menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9998;
  }

  .context-menu {
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--el-border-radius-base);
    box-shadow: var(--el-box-shadow-light);
    padding: 4px 0;
    min-width: 120px;

    .context-menu-item {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--el-text-color-primary);
      font-size: 14px;
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--el-fill-color-light);
      }

      .el-icon {
        margin-right: 8px;
      }
    }

    .context-menu-divider {
      height: 1px;
      background-color: var(--el-border-color-lighter);
      margin: 4px 0;
    }
  }

  /* 图片路径 tooltip 样式 */
  :deep(.image-path-tooltip) {
    max-width: 400px;
    padding: 8px 12px;
  }

  .tooltip-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    line-height: 1.4;
  }

  .tooltip-line {
    word-break: break-all;
    font-size: 12px;
  }

  .loading-skeleton {
    padding: 20px;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px;
    width: 100%;
  }

  .skeleton-item {
    border: 2px solid var(--anime-border);
    border-radius: 16px;
    overflow: hidden;
    background: var(--anime-bg-card);
    box-shadow: var(--anime-shadow);
    padding: 0;
  }

  .empty {
    padding: 40px;
    text-align: center;
  }

  .fade-in {
    animation: fadeIn 0.4s ease-in-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .crawl-form {
    margin-bottom: 20px;

    :deep(.el-form-item__label) {
      color: var(--anime-text-primary);
      font-weight: 500;
    }
  }

  .progress-text {
    font-size: 12px;
    color: var(--anime-text-secondary);
    margin-top: 5px;
    display: block;
    font-weight: 500;
  }

  h3 {
    color: var(--anime-text-primary);
    font-weight: 600;
    margin-bottom: 16px;
  }

  .var-description {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .plugin-option-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .plugin-option-icon-placeholder {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    color: var(--anime-text-secondary);
  }

  /* 图片预览样式 */
  .image-preview-wrapper {
    width: 100%;
    height: 100%;
    cursor: pointer;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }
}

/* Dialog 样式需要全局作用域才能正确应用 */
</style>

<style lang="scss">
.crawl-dialog.el-dialog {
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin-top: 5vh !important;
  margin-bottom: 5vh !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    max-height: none !important;
  }

  .el-dialog__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);
  }
}

/* "开始导入图片"->"选择导入源"下拉框：下拉面板是 teleport 到 body 的，所以必须用全局样式 */
.crawl-plugin-select-dropdown {
  .el-select-dropdown__item {
    padding: 8px 12px;
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
    /* 控制 el-icon 的 svg 大小 */
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--anime-text-secondary);
  }

  .plugin-option span {
    line-height: 1.2;
    color: var(--anime-text-primary);
  }
}

.run-config-select-dropdown {
  .el-select-dropdown__item {
    padding: 6px 12px;
    min-height: 40px;
  }

  .run-config-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 32px;
    width: 100%;
  }

  .run-config-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;

    .name {
      font-weight: 600;
      color: var(--el-text-color-primary);
      line-height: 1.4;
      display: flex;
      align-items: center;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .incompatible-badge {
        color: var(--el-color-warning);
        font-weight: 600;
        margin-right: 4px;
      }

      .incompatible-reason {
        margin-top: 4px;
        font-size: 12px;
      }

      .error-text {
        color: var(--el-color-error);
      }

      .warning-text {
        color: var(--el-color-warning);
      }

      .desc {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        font-weight: normal;
        margin-left: 4px;
      }
    }
  }

  .run-config-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    align-self: flex-start;
    padding-top: 2px;
  }
}

/* 图片路径 tooltip 样式 */
:deep(.image-path-tooltip) {
  max-width: 400px;
  padding: 8px 12px;
}

.tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.4;
}

.tooltip-line {
  word-break: break-all;
  font-size: 12px;
}
</style>
