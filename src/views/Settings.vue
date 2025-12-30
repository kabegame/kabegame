<template>
  <div class="settings-container">
    <PageHeader title="设置" sticky />

    <StyledTabs v-model="activeTab" sticky>

      <el-tab-pane label="壁纸轮播" name="wallpaper">
        <el-card class="settings-card">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>壁纸轮播设置</span>
              <el-button circle size="small" @click="handleRefreshWallpaper" :loading="isRefreshingWallpaper">
                <el-icon>
                  <Refresh />
                </el-icon>
              </el-button>
            </div>
          </template>

          <el-form v-loading="loading" element-loading-text="" :model="settings" :label-width="labelWidth"
            @submit.prevent>

            <el-form-item label="启用壁纸轮播">
              <div class="form-item-content">
                <el-switch v-model="settings.wallpaperRotationEnabled" :disabled="isRotationToggleLoading"
                  :loading="isRotationToggleLoading" @change="handleWallpaperRotationEnabledChange" />
                <div class="setting-description">自动从指定画册中轮播更换桌面壁纸</div>
              </div>
            </el-form-item>

            <el-form-item :label="settings.wallpaperRotationEnabled ? '选择画册' : '选择壁纸'">
              <div class="form-item-content">
                <el-button type="primary" @click="handleNavigateToSelection">
                  <template v-if="settings.wallpaperRotationEnabled">
                    {{ selectedAlbumName || '前往画册页面' }}
                  </template>
                  <template v-else>
                    前往画廊选择壁纸
                  </template>
                </el-button>
                <div class="setting-description">
                  <template v-if="settings.wallpaperRotationEnabled">
                    {{ selectedAlbumName ? `当前选择：${selectedAlbumName}` : '点击按钮前往画册页面选择用于轮播的画册' }}
                  </template>
                  <template v-else>
                    <div>
                      点击按钮前往画廊页面选择单张壁纸
                      <template v-if="currentWallpaperName">
                        <br />
                        当前壁纸：{{ currentWallpaperName }}
                        <el-button text size="small" class="path-button" @click="handleRevealCurrentWallpaper">
                          <el-icon>
                            <FolderOpened />
                          </el-icon>
                          定位
                        </el-button>
                      </template>
                    </div>
                  </template>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="轮播间隔" v-if="settings.wallpaperRotationEnabled">
              <div class="form-item-content">
                <el-input-number v-model="settings.wallpaperRotationIntervalMinutes" :min="1" :max="1440" :step="10"
                  @change="handleWallpaperRotationIntervalChange" />
                <div class="setting-description">壁纸更换间隔（分钟，1-1440）</div>
              </div>
            </el-form-item>

            <el-form-item label="轮播模式" v-if="settings.wallpaperRotationEnabled">
              <div class="form-item-content">
                <el-radio-group v-model="settings.wallpaperRotationMode" @change="handleWallpaperRotationModeChange">
                  <el-radio label="random">随机</el-radio>
                  <el-radio label="sequential">顺序</el-radio>
                </el-radio-group>
                <div class="setting-description">随机模式：每次随机选择；顺序模式：按顺序依次更换</div>
              </div>
            </el-form-item>

            <el-form-item label="壁纸显示方式">
              <div class="form-item-content">
                <el-select v-model="settings.wallpaperRotationStyle" placeholder="请选择显示方式" style="width: 100%"
                  :disabled="isModeSwitching || isStyleApplying" @change="handleWallpaperRotationStyleChange">
                  <!-- 窗口模式：显示所有样式 -->
                  <template v-if="settings.wallpaperMode === 'window'">
                    <el-option label="填充" value="fill">
                      <span>填充 - 保持宽高比，填满屏幕（可能裁剪）</span>
                    </el-option>
                    <el-option label="适应" value="fit">
                      <span>适应 - 保持宽高比，完整显示（可能有黑边）</span>
                    </el-option>
                    <el-option label="拉伸" value="stretch">
                      <span>拉伸 - 拉伸填满屏幕（可能变形）</span>
                    </el-option>
                    <el-option label="居中" value="center">
                      <span>居中 - 原始大小居中显示</span>
                    </el-option>
                    <el-option label="平铺" value="tile">
                      <span>平铺 - 重复平铺显示</span>
                    </el-option>
                  </template>
                  <!-- 原生模式：根据系统支持显示样式 -->
                  <template v-else>
                    <el-option v-if="nativeWallpaperStyles.includes('fill')" label="填充" value="fill">
                      <span>填充 - 保持宽高比，填满屏幕（可能裁剪）</span>
                    </el-option>
                    <el-option v-if="nativeWallpaperStyles.includes('fit')" label="适应" value="fit">
                      <span>适应 - 保持宽高比，完整显示（可能有黑边）</span>
                    </el-option>
                    <el-option v-if="nativeWallpaperStyles.includes('stretch')" label="拉伸" value="stretch">
                      <span>拉伸 - 拉伸填满屏幕（可能变形）</span>
                    </el-option>
                    <el-option v-if="nativeWallpaperStyles.includes('center')" label="居中" value="center">
                      <span>居中 - 原始大小居中显示</span>
                    </el-option>
                    <el-option v-if="nativeWallpaperStyles.includes('tile')" label="平铺" value="tile">
                      <span>平铺 - 重复平铺显示</span>
                    </el-option>
                  </template>
                </el-select>
                <div class="setting-description">
                  <template v-if="settings.wallpaperMode === 'native'">
                    原生模式：根据系统支持显示可用样式（单张壁纸/轮播均生效）
                  </template>
                  <template v-else>
                    窗口模式：支持所有显示方式（单张壁纸/轮播均生效）
                  </template>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="过渡效果">
              <div class="form-item-content">
                <el-select v-model="settings.wallpaperRotationTransition" placeholder="请选择过渡效果" style="width: 100%"
                  :disabled="isModeSwitching || isTransitionApplying || !settings.wallpaperRotationEnabled"
                  @change="handleWallpaperRotationTransitionChange">
                  <!-- 原生模式：只支持无过渡和淡入淡出 -->
                  <template v-if="settings.wallpaperMode === 'native'">
                    <el-option label="无过渡" value="none" />
                    <el-option label="淡入淡出" value="fade" />
                  </template>
                  <!-- 窗口模式：支持所有过渡效果 -->
                  <template v-else>
                    <el-option label="无过渡" value="none" />
                    <el-option label="淡入淡出（推荐）" value="fade" />
                    <el-option label="滑动切换" value="slide" />
                    <el-option label="缩放淡入" value="zoom" />
                  </template>
                </el-select>
                <div class="setting-description">
                  <template v-if="!settings.wallpaperRotationEnabled">
                    未启用轮播时：过渡效果不会生效（仅轮播支持过渡预览）
                  </template>
                  <template v-if="settings.wallpaperMode === 'native'">
                    原生模式：仅支持无过渡和淡入淡出（受系统限制）<br />
                    无过渡：应用不会额外触发/预览过渡，但 Windows 本身在切换壁纸时可能仍会有系统级淡入动画
                  </template>
                  <template v-else>
                    窗口模式：过渡效果完全由应用渲染（支持淡入淡出/滑动/缩放）
                  </template>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="壁纸模式">
              <div class="form-item-content" :class="{ 'wallpaper-mode-switching-container': isModeSwitching }">
                <el-radio-group v-model="settings.wallpaperMode" @change="handleWallpaperModeChange"
                  :disabled="isModeSwitching" :class="{ 'wallpaper-mode-switching': isModeSwitching }">
                  <el-radio label="native">原生模式</el-radio>
                  <el-radio label="window">窗口模式（类似 Wallpaper Engine）</el-radio>
                </el-radio-group>
                <div class="setting-description">
                  原生模式：使用 Windows 原生壁纸设置，性能好但功能有限<br />
                  窗口模式：使用窗口句柄显示，更灵活，可实现动画等效果
                </div>
              </div>
            </el-form-item>

            <el-form-item label="Wallpaper Engine 目录">
              <div class="form-item-content">
                <el-input v-model="settings.wallpaperEngineDir"
                  placeholder="用于“导出并自动导入到 WE”（建议选择 WE 安装目录或 projects/myprojects）" clearable
                  @clear="handleClearWallpaperEngineDir">
                  <template #append>
                    <el-button @click="handleChooseWallpaperEngineDir">
                      <el-icon>
                        <FolderOpened />
                      </el-icon>
                      选择
                    </el-button>
                  </template>
                </el-input>

                <div class="setting-description">
                  自动导入会写入：<b>projects\\myprojects</b>（找不到该目录会提示你重新选择）
                  <span v-if="wallpaperEngineMyprojectsDir">
                    ，当前识别为：
                    <el-button text size="small" class="path-button" @click="handleOpenWallpaperEngineMyprojectsDir">
                      <el-icon>
                        <FolderOpened />
                      </el-icon>
                      <span class="path-text">{{ wallpaperEngineMyprojectsDir }}</span>
                    </el-button>
                  </span>
                </div>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="下载设置" name="download">
        <el-card class="settings-card">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>下载设置</span>
              <el-button circle size="small" @click="handleRefreshDownload" :loading="isRefreshingDownload">
                <el-icon>
                  <Refresh />
                </el-icon>
              </el-button>
            </div>
          </template>

          <el-form v-loading="loading" element-loading-text="" :model="settings" :label-width="labelWidth"
            @submit.prevent>
            <el-form-item label="最大并发下载量">
              <div class="form-item-content">
                <el-input-number v-model="settings.maxConcurrentDownloads" :min="1" :max="10"
                  @change="handleMaxConcurrentChange" />
                <div class="setting-description">同时下载的图片数量（1-10）</div>
              </div>
            </el-form-item>

            <el-form-item label="网络失效重试次数">
              <div class="form-item-content">
                <el-input-number v-model="settings.networkRetryCount" :min="0" :max="10"
                  @change="handleNetworkRetryCountChange" />
                <div class="setting-description">下载图片遇到网络错误/超时等情况时，额外重试的次数（0-10）</div>
              </div>
            </el-form-item>

            <el-form-item label="自动去重">
              <div class="form-item-content">
                <el-switch v-model="settings.autoDeduplicate" @change="handleAutoDeduplicateChange" />
                <div class="setting-description">根据文件哈希值自动跳过重复图片，避免在画廊中重复添加相同文件</div>
              </div>
            </el-form-item>

            <el-form-item label="默认下载目录">
              <div class="form-item-content">
                <el-input v-model="settings.defaultDownloadDir" placeholder="留空使用默认目录，或输入自定义路径" clearable
                  @clear="handleClearDefaultDownloadDir">
                  <template #append>
                    <el-button @click="handleChooseDefaultDownloadDir">
                      <el-icon>
                        <FolderOpened />
                      </el-icon>
                      选择
                    </el-button>
                  </template>
                </el-input>

                <div class="setting-description">
                  生效路径：
                  <el-button text size="small" @click="handleOpenEffectiveDownloadDir" class="path-button">
                    <el-icon>
                      <FolderOpened />
                    </el-icon>
                    <span class="path-text">{{ effectiveDownloadDir || '（未知）' }}</span>
                  </el-button>
                </div>

                <div class="setting-description">
                  未在任务里指定输出目录时，将下载到该目录；文件会按插件分文件夹保存。
                  <span v-if="settings.defaultDownloadDir">
                    <el-button link type="warning" @click="handleClearDefaultDownloadDir">恢复默认</el-button>
                  </span>
                </div>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="应用设置" name="app">
        <el-card class="settings-card">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>应用设置</span>
              <el-button circle size="small" @click="handleRefreshApp" :loading="isRefreshingApp">
                <el-icon>
                  <Refresh />
                </el-icon>
              </el-button>
            </div>
          </template>

          <el-form v-loading="loading" element-loading-text="" :model="settings" :label-width="labelWidth"
            @submit.prevent>
            <el-form-item label="开机启动">
              <div class="form-item-content">
                <el-switch v-model="settings.autoLaunch" @change="handleAutoLaunchChange" />
                <div class="setting-description">应用启动时自动运行</div>
              </div>
            </el-form-item>

            <el-form-item label="恢复上次标签页">
              <div class="form-item-content">
                <el-switch v-model="settings.restoreLastTab" @change="handleRestoreLastTabChange" />
                <div class="setting-description">应用启动时自动恢复到上次访问的标签页</div>
              </div>
            </el-form-item>

            <el-form-item label="图片点击行为">
              <div class="form-item-content">
                <el-radio-group v-model="settings.imageClickAction" @change="handleImageClickActionChange">
                  <el-radio label="preview">应用内预览</el-radio>
                  <el-radio label="open">系统默认打开</el-radio>
                </el-radio-group>
                <div class="setting-description">左键点击图片时的行为</div>
              </div>
            </el-form-item>

            <el-form-item label="图片宽高比匹配窗口">
              <div class="form-item-content">
                <el-switch v-model="settings.galleryImageAspectRatioMatchWindow"
                  @change="handleGalleryImageAspectRatioMatchWindowChange" />
                <div class="setting-description">画廊图片的宽高比是否与窗口宽高比相同</div>
              </div>
            </el-form-item>

            <el-form-item label="每次加载数量">
              <div class="form-item-content">
                <el-input-number v-model="settings.galleryPageSize" :min="10" :max="200" :step="10"
                  @change="handleGalleryPageSizeChange" />
                <div class="setting-description">画廊"加载更多"时的加载张数（10-200）</div>
              </div>
            </el-form-item>

            <el-form-item label="清理应用数据">
              <div class="form-item-content">
                <el-button type="danger" @click="handleClearUserData" :loading="isClearingData">
                  <el-icon>
                    <Delete />
                  </el-icon>
                  清理所有用户数据
                </el-button>
                <div class="setting-description">
                  将删除所有图片、画册、任务、设置、插件配置等用户数据，应用将自动重启。此操作不可恢复，请谨慎使用。
                </div>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

    </StyledTabs>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated, computed } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useRouter } from "vue-router";
import { FolderOpened, Refresh, Delete } from "@element-plus/icons-vue";
import PageHeader from "@/components/common/PageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";

const labelWidth = "180px";

interface Album {
  id: string;
  name: string;
  createdAt: number;
}

const loading = ref(true);
const settings = ref({
  autoLaunch: false,
  maxConcurrentDownloads: 3,
  networkRetryCount: 2,
  imageClickAction: "preview" as "preview" | "open",
  galleryImageAspectRatioMatchWindow: false,
  galleryPageSize: 50,
  autoDeduplicate: false,
  defaultDownloadDir: null as string | null,
  wallpaperEngineDir: null as string | null,
  wallpaperRotationEnabled: false,
  wallpaperRotationAlbumId: null as string | null,
  wallpaperRotationIntervalMinutes: 60,
  wallpaperRotationMode: "random" as "random" | "sequential",
  wallpaperRotationStyle: "fill" as "fill" | "fit" | "stretch" | "center" | "tile",
  wallpaperRotationTransition: "none" as "none" | "fade" | "slide" | "zoom",
  wallpaperMode: "native" as "native" | "window",
  restoreLastTab: false,
  lastTabPath: null as string | null,
});

const defaultImagesDir = ref<string>("");
const effectiveDownloadDir = ref<string>("");
const albums = ref<Album[]>([]);
const activeTab = ref<string>("wallpaper");
const wallpaperEngineMyprojectsDir = ref<string>("");
const currentWallpaperPath = ref<string | null>(null);

const currentWallpaperName = computed(() => {
  if (!currentWallpaperPath.value) return null;
  const p = currentWallpaperPath.value.replace(/\\/g, "/");
  return p.split("/").pop() || currentWallpaperPath.value;
});

const isModeSwitching = ref(false);
const nativeWallpaperStyles = ref<string[]>([]); // 系统原生模式支持的样式列表
const router = useRouter();
const isStyleApplying = ref(false);
const isTransitionApplying = ref(false);
const isRefreshingWallpaper = ref(false);
const isRotationToggleLoading = ref(false);
const isRefreshingDownload = ref(false);
const isRefreshingApp = ref(false);
const isClearingData = ref(false);

// 计算当前选中的画册名称
const selectedAlbumName = computed(() => {
  // 约定：空字符串表示“全画廊轮播”
  if (settings.value.wallpaperRotationAlbumId === "") return "全画廊";
  if (!settings.value.wallpaperRotationAlbumId) return null;
  const album = albums.value.find((a) => a.id === settings.value.wallpaperRotationAlbumId);
  return album ? album.name : null;
});

const loadSettings = async () => {
  try {
    const loadedSettings = await invoke<{
      autoLaunch: boolean;
      maxConcurrentDownloads: number;
      networkRetryCount?: number;
      imageClickAction: string;
      galleryImageAspectRatioMatchWindow: boolean;
      galleryPageSize: number;
      autoDeduplicate?: boolean;
      defaultDownloadDir?: string | null;
      wallpaperEngineDir?: string | null;
      wallpaperRotationEnabled?: boolean;
      wallpaperRotationAlbumId?: string | null;
      wallpaperRotationIntervalMinutes?: number;
      wallpaperRotationMode?: string;
      wallpaperRotationStyle?: string;
      wallpaperRotationTransition?: string;
      wallpaperMode?: string;
      restoreLastTab?: boolean;
      lastTabPath?: string | null;
    }>("get_settings");
    settings.value = {
      ...loadedSettings,
      imageClickAction: loadedSettings.imageClickAction === "open" ? "open" : "preview",
      defaultDownloadDir: loadedSettings.defaultDownloadDir || null,
      autoDeduplicate: loadedSettings.autoDeduplicate ?? false,
      wallpaperEngineDir: loadedSettings.wallpaperEngineDir || null,
      networkRetryCount: typeof loadedSettings.networkRetryCount === "number" ? loadedSettings.networkRetryCount : 2,
      wallpaperRotationEnabled: loadedSettings.wallpaperRotationEnabled ?? false,
      wallpaperRotationAlbumId: loadedSettings.wallpaperRotationAlbumId || null,
      wallpaperRotationIntervalMinutes: loadedSettings.wallpaperRotationIntervalMinutes ?? 60,
      wallpaperRotationMode: (loadedSettings.wallpaperRotationMode === "sequential" ? "sequential" : "random") as "random" | "sequential",
      wallpaperRotationStyle: (loadedSettings.wallpaperRotationStyle || "fill") as "fill" | "fit" | "stretch" | "center" | "tile",
      wallpaperRotationTransition: (["none", "fade", "slide", "zoom"].includes(loadedSettings.wallpaperRotationTransition || "")
        ? loadedSettings.wallpaperRotationTransition
        : "none") as "none" | "fade" | "slide" | "zoom",
      wallpaperMode: (loadedSettings.wallpaperMode || "native") as "native" | "window",
      restoreLastTab: loadedSettings.restoreLastTab ?? false,
      lastTabPath: loadedSettings.lastTabPath || null,
    };

    defaultImagesDir.value = await invoke<string>("get_default_images_dir");
    effectiveDownloadDir.value = settings.value.defaultDownloadDir || defaultImagesDir.value;

    // 尝试解析 WE myprojects 目录（用于导出自动导入）
    try {
      const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
      wallpaperEngineMyprojectsDir.value = mp || "";
    } catch (e) {
      wallpaperEngineMyprojectsDir.value = "";
    }

    // 加载画册列表
    albums.value = await invoke<Album[]>("get_albums");

    // 加载当前壁纸（用于非轮播模式显示）
    try {
      currentWallpaperPath.value = await invoke<string | null>("get_current_wallpaper_path");
    } catch {
      currentWallpaperPath.value = null;
    }

    // 加载系统原生模式支持的样式列表
    try {
      nativeWallpaperStyles.value = await invoke<string[]>("get_native_wallpaper_styles");
    } catch (error) {
      console.error("获取原生模式支持的样式列表失败:", error);
      // 如果获取失败，使用默认值（所有样式）
      nativeWallpaperStyles.value = ["fill", "fit", "stretch", "center", "tile"];
    }
  } catch (error) {
    console.error("加载设置失败:", error);
  } finally {
    loading.value = false;
  }
};

const handleRevealCurrentWallpaper = async () => {
  try {
    if (!currentWallpaperPath.value) return;
    await invoke("open_file_path", { filePath: currentWallpaperPath.value });
  } catch (e) {
    console.error("定位当前壁纸失败:", e);
    ElMessage.error("定位失败");
  }
};

const refreshWallpaperEngineMyprojectsDir = async () => {
  try {
    const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
    wallpaperEngineMyprojectsDir.value = mp || "";
  } catch (e) {
    wallpaperEngineMyprojectsDir.value = "";
  }
};

const handleChooseWallpaperEngineDir = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Wallpaper Engine 目录（建议选择安装目录或 projects/myprojects）",
    });
    if (!selected || Array.isArray(selected)) return;
    settings.value.wallpaperEngineDir = selected;
    await invoke("set_wallpaper_engine_dir", { dir: selected });
    await refreshWallpaperEngineMyprojectsDir();
    if (!wallpaperEngineMyprojectsDir.value) {
      ElMessage.warning("未识别到 projects/myprojects，请换一个目录（比如 WE 安装目录或 projects 目录）");
    } else {
      ElMessage.success("Wallpaper Engine 目录已保存");
    }
  } catch (e) {
    console.error("保存 Wallpaper Engine 目录失败:", e);
    ElMessage.error("保存失败");
  }
};

const handleClearWallpaperEngineDir = async () => {
  try {
    settings.value.wallpaperEngineDir = null;
    await invoke("set_wallpaper_engine_dir", { dir: null });
    wallpaperEngineMyprojectsDir.value = "";
  } catch (e) {
    console.error("清空 Wallpaper Engine 目录失败:", e);
    ElMessage.error("操作失败");
  }
};

const handleOpenWallpaperEngineMyprojectsDir = async () => {
  try {
    if (!wallpaperEngineMyprojectsDir.value) return;
    await invoke("open_file_path", { filePath: wallpaperEngineMyprojectsDir.value });
  } catch (e) {
    console.error("打开 myprojects 目录失败:", e);
    ElMessage.error("打开失败");
  }
};

const handleAutoLaunchChange = async (value: boolean) => {
  try {
    await invoke("set_auto_launch", { enabled: value });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleRestoreLastTabChange = async (value: boolean) => {
  try {
    await invoke("set_restore_last_tab", { enabled: value });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleMaxConcurrentChange = async (value: number) => {
  try {
    await invoke("set_max_concurrent_downloads", { count: value });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleNetworkRetryCountChange = async (value: number) => {
  try {
    await invoke("set_network_retry_count", { count: value });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleImageClickActionChange = async (value: string) => {
  try {
    await invoke("set_image_click_action", { action: value });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleGalleryImageAspectRatioMatchWindowChange = async () => {
  try {
    await invoke("set_gallery_image_aspect_ratio_match_window", { enabled: settings.value.galleryImageAspectRatioMatchWindow });
  } catch (error) {
    console.error("保存设置失败:", error);
    ElMessage.error("保存设置失败");
  }
};

const handleGalleryPageSizeChange = async (value: number) => {
  try {
    await invoke("set_gallery_page_size", { size: value });
  } catch (error) {
    console.error("保存设置失败:", error);
    ElMessage.error("保存设置失败");
  }
};

const handleAutoDeduplicateChange = async (value: boolean) => {
  try {
    await invoke("set_auto_deduplicate", { enabled: value });
  } catch (error) {
    console.error("保存设置失败:", error);
    ElMessage.error("保存设置失败");
  }
};

const handleChooseDefaultDownloadDir = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择默认下载目录",
    });
    if (!selected || Array.isArray(selected)) return;
    settings.value.defaultDownloadDir = selected;
    await invoke("set_default_download_dir", { dir: selected });
    effectiveDownloadDir.value = selected;
  } catch (error) {
    console.error("保存默认下载目录失败:", error);
    ElMessage.error("保存失败");
  }
};

const handleClearDefaultDownloadDir = async () => {
  try {
    settings.value.defaultDownloadDir = null;
    await invoke("set_default_download_dir", { dir: null });
    effectiveDownloadDir.value = defaultImagesDir.value;
  } catch (error) {
    console.error("清空默认下载目录失败:", error);
    ElMessage.error("操作失败");
  }
};

const handleOpenEffectiveDownloadDir = async () => {
  try {
    const path = effectiveDownloadDir.value || settings.value.defaultDownloadDir || defaultImagesDir.value;
    if (!path) return;
    await invoke("open_file_path", { filePath: path });
  } catch (error) {
    console.error("打开目录失败:", error);
    ElMessage.error("打开目录失败");
  }
};

const handleWallpaperRotationEnabledChange = async (value: boolean) => {
  if (isRotationToggleLoading.value) return;
  isRotationToggleLoading.value = true;
  try {
    if (value) {
      // 1) 仅落盘开启（不启动线程）
      await invoke("set_wallpaper_rotation_enabled", { enabled: true });

      // 2) 由后端根据"上次画册ID -> 失败回落到画廊"逻辑启动轮播线程
      const res = await invoke<{
        started: boolean;
        source: "album" | "gallery";
        albumId?: string | null;
      }>("start_wallpaper_rotation");

      if (!res?.started) {
        throw new Error("轮播线程未能启动");
      }

      // 3) 等待状态变为 "running"
      let status = await invoke<string>("get_wallpaper_rotator_status");
      let retries = 0;
      while (status !== "running" && retries < 20) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await invoke<string>("get_wallpaper_rotator_status");
        retries++;
      }

      // 4) 重新拉一次设置，让 UI 同步后端回落结果（比如回落到画廊会把 albumId 写成空字符串）
      await loadSettings();

      ElMessage.success(res.source === "album" ? "已开启轮播：画册" : "已开启轮播：画廊");
    } else {
      // 关闭：仅停止轮播线程（window 模式下壁纸窗口保持显示）
      await invoke("set_wallpaper_rotation_enabled", { enabled: false });

      // 等待状态变为 "idle"
      let status = await invoke<string>("get_wallpaper_rotator_status");
      let retries = 0;
      while (status !== "idle" && retries < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await invoke<string>("get_wallpaper_rotator_status");
        retries++;
      }

      ElMessage.info("壁纸轮播已禁用");
    }
  } catch (error) {
    console.error(error);
    // 回滚 UI，并确保后端状态关闭
    settings.value.wallpaperRotationEnabled = false;
    try {
      await invoke("set_wallpaper_rotation_enabled", { enabled: false });
    } catch (e) {
      console.warn("回滚轮播开关失败:", e);
    }
    ElMessage.error(`操作失败：${(error as any)?.message || String(error)}`);
  } finally {
    isRotationToggleLoading.value = false;
  }
};

const handleNavigateToSelection = () => {
  if (settings.value.wallpaperRotationEnabled) {
    // 轮播模式：若为“全画廊轮播”则跳转画廊，否则跳转画册
    if (settings.value.wallpaperRotationAlbumId === "") {
      router.push("/gallery");
    } else {
      router.push("/albums");
    }
  } else {
    // 非轮播模式：跳转到画廊页面
    router.push("/gallery");
  }
};

const handleWallpaperRotationIntervalChange = async (minutes: number) => {
  try {
    await invoke("set_wallpaper_rotation_interval_minutes", { minutes });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleWallpaperRotationModeChange = async (mode: string) => {
  try {
    await invoke("set_wallpaper_rotation_mode", { mode });
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  }
};

const handleWallpaperRotationStyleChange = async (style: string) => {
  if (isModeSwitching.value) return;
  isStyleApplying.value = true;
  try {
    // 等待后端应用完成事件，避免原生模式下 invoke 阻塞导致页面卡顿
    const waitForApply = new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      const unlistenFn = await listen<{ success: boolean; style: string; error?: string }>(
        "wallpaper-style-apply-complete",
        (event) => {
          if (event.payload.style === style) {
            unlistenFn();
            resolve({ success: event.payload.success, error: event.payload.error });
          }
        }
      );
    });

    // 触发保存 + 后台应用（命令会立即返回）
    await invoke("set_wallpaper_style", { style });

    const result = await waitForApply;
    if (!result.success) {
      ElMessage.error(result.error || "应用样式失败");
    }
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  } finally {
    isStyleApplying.value = false;
  }
};

const handleWallpaperRotationTransitionChange = async (transition: string) => {
  if (!settings.value.wallpaperRotationEnabled) {
    // 单张壁纸模式不支持过渡效果（后端会拒绝），前端直接提示并不调用
    ElMessage.info("未启用轮播：过渡效果不会生效");
    return;
  }
  if (isModeSwitching.value) return;
  isTransitionApplying.value = true;
  try {
    const waitForApply = new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      const unlistenFn = await listen<{ success: boolean; transition: string; error?: string }>(
        "wallpaper-transition-apply-complete",
        (event) => {
          if (event.payload.transition === transition) {
            unlistenFn();
            resolve({ success: event.payload.success, error: event.payload.error });
          }
        }
      );
    });

    await invoke("set_wallpaper_rotation_transition", { transition });

    const result = await waitForApply;
    if (!result.success) {
      ElMessage.error(result.error || "应用过渡效果失败");
    }
  } catch (error) {
    ElMessage.error("保存设置失败");
    console.error(error);
  } finally {
    isTransitionApplying.value = false;
  }
};

const handleWallpaperModeChange = async (mode: string) => {
  // 设置切换状态
  isModeSwitching.value = true;

  try {
    // 如果切换到原生模式，检查当前样式和过渡效果是否支持
    if (mode === "native") {
      // 检查样式是否支持
      if (nativeWallpaperStyles.value.length > 0 && !nativeWallpaperStyles.value.includes(settings.value.wallpaperRotationStyle)) {
        // 自动切换到原生模式支持的样式（优先使用 fill，如果没有则使用第一个支持的样式）
        const newStyle = nativeWallpaperStyles.value.includes("fill") ? "fill" : nativeWallpaperStyles.value[0];
        settings.value.wallpaperRotationStyle = newStyle as any;
        // 保存新的样式设置
        try {
          await invoke("set_wallpaper_style", { style: newStyle });
        } catch (e) {
          console.warn("自动切换样式失败:", e);
        }
      }

      // 检查过渡效果是否支持
      // 只有轮播启用时才需要同步/保存 transition（否则后端会拒绝）
      if (settings.value.wallpaperRotationEnabled) {
        const unsupportedTransitions = ["slide", "zoom"];
        if (unsupportedTransitions.includes(settings.value.wallpaperRotationTransition)) {
          // 自动切换到原生模式支持的过渡效果
          // 使用 none（原生模式的默认值），因为它是原生模式最基础的选项
          const newTransition = "none";
          settings.value.wallpaperRotationTransition = newTransition;
          // 保存新的过渡效果设置
          try {
            await invoke("set_wallpaper_rotation_transition", { transition: newTransition });
          } catch (e) {
            console.warn("自动切换过渡效果失败:", e);
          }
        }
      } else {
        // 非轮播场景：仅本地修正为原生可用值，避免 UI 残留不可用选项
        const unsupportedTransitions = ["slide", "zoom"];
        if (unsupportedTransitions.includes(settings.value.wallpaperRotationTransition)) {
          settings.value.wallpaperRotationTransition = "none";
        }
      }
    }

    // 创建一个 Promise 来等待切换完成事件
    const waitForSwitchComplete = new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      const unlistenFn = await listen<{ success: boolean; mode: string; error?: string }>(
        "wallpaper-mode-switch-complete",
        (event) => {
          // 检查是否是当前切换的模式
          if (event.payload.mode === mode) {
            unlistenFn();
            resolve({
              success: event.payload.success,
              error: event.payload.error,
            });
          }
        }
      );
    });

    // 启动切换（不等待完成）
    await invoke("set_wallpaper_mode", { mode });

    // 等待切换完成事件
    const result = await waitForSwitchComplete;

    if (result.success) {
      ElMessage.success("壁纸模式已切换");
    } else {
      ElMessage.error(result.error || "切换模式失败");
    }
  } catch (error) {
    console.error(error);
    ElMessage.error("切换模式失败");
  } finally {
    isModeSwitching.value = false;
  }
};

const handleRefreshWallpaper = async () => {
  isRefreshingWallpaper.value = true;
  try {
    await loadSettings();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshingWallpaper.value = false;
  }
};

const handleRefreshDownload = async () => {
  isRefreshingDownload.value = true;
  try {
    await loadSettings();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshingDownload.value = false;
  }
};

const handleRefreshApp = async () => {
  isRefreshingApp.value = true;
  try {
    await loadSettings();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshingApp.value = false;
  }
};

// 清理用户数据（双重确认）
const handleClearUserData = async () => {
  try {
    // 第一次确认
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

    // 第二次确认
    await ElMessageBox.confirm(
      "请再次确认：\n\n" +
      "您确定要清理所有用户数据吗？\n" +
      "清理后应用将自动重启，所有数据将无法恢复！",
      "最终确认",
      {
        type: "error",
        confirmButtonText: "确定清理",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      }
    );

    // 执行清理
    isClearingData.value = true;
    try {
      await invoke("clear_user_data");
      ElMessage.success("数据清理完成，应用即将重启...");
    } catch (error) {
      console.error("清理数据失败:", error);
      ElMessage.error("清理数据失败: " + (error as Error).message);
      isClearingData.value = false;
    }
  } catch (error) {
    // 用户取消操作
    if (error !== "cancel") {
      console.error("清理数据确认失败:", error);
    }
  }
};

onMounted(() => {
  loadSettings();
});

// 组件激活时（keep-alive 缓存后重新显示）重新加载设置
onActivated(() => {
  loadSettings();
});

</script>

<style scoped lang="scss">
// 切换模式时的鼠标加载态
.wallpaper-mode-switching {
  cursor: wait !important;

  :deep(.el-radio) {
    cursor: wait !important;

    .el-radio__label {
      cursor: wait !important;
    }
  }
}

.settings-container {
  width: 100%;
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  /* 隐藏滚动条 */
  scrollbar-width: none;
  /* Firefox */
  -ms-overflow-style: none;
  /* IE and Edge */

  &::-webkit-scrollbar {
    display: none;
    /* Chrome, Safari, Opera */
  }
}

.wallpaper-actual-alert {
  width: 100%;
}

.settings-card {
  background: var(--anime-bg-card);
  border-radius: 16px;
  box-shadow: var(--anime-shadow);
  transition: none !important;

  &:hover {
    transform: none !important;
    box-shadow: var(--anime-shadow) !important;
  }
}

.form-item-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-description {
  font-size: 12px;
  color: var(--anime-text-muted);
  margin-top: 0;
}

.path-button {
  padding: 0;
  margin-left: 6px;
  max-width: 100%;
  justify-content: flex-start;
}

.path-text {
  margin-left: 6px;
  max-width: 560px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}

/* 确保 switch 有平滑的过渡动画 */
:deep(.el-switch) {
  transition: all 0.3s ease;
}

:deep(.el-switch__core) {
  transition: all 0.3s ease;
}

:deep(.el-switch__action) {
  transition: all 0.3s ease;
}

/* 移除 input-number 的边框 */
:deep(.el-input-number) {
  border: none !important;

  .el-input__wrapper {
    border: none !important;
    box-shadow: none !important;
  }

  &:hover .el-input__wrapper {
    border: none !important;
    box-shadow: none !important;
  }

  &.is-controls-right {
    border: none !important;

    &:hover {
      border: none !important;
    }
  }

  .el-input-number__increase,
  .el-input-number__decrease {
    border: none !important;
  }

  &:hover .el-input-number__increase,
  &:hover .el-input-number__decrease {
    border: none !important;
  }
}

.loading-placeholder {
  padding: 20px;
  text-align: center;
  color: var(--anime-text-secondary);
}

// 切换模式时的鼠标加载态
.wallpaper-mode-switching-container {
  cursor: wait !important;
}

.wallpaper-mode-switching {
  cursor: wait !important;

  :deep(.el-radio) {
    cursor: wait !important;

    .el-radio__label {
      cursor: wait !important;
    }

    .el-radio__input {
      cursor: wait !important;
    }
  }
}
</style>
