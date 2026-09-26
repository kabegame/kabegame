<template>
  <!-- 桌面 ElDialog / 紧凑布局全宽 AndroidDrawer，共用同一份表单 -->
  <component :is="uiStore.isCompact ? AndroidDrawer : ElDialog" v-bind="shellProps" @update:model-value="modal.close">
    <template v-if="uiStore.isCompact" #header>
      <h3 class="m-0 text-base">{{ $t("gallery.webpageCollectTitle") }}</h3>
    </template>

    <el-form :model="form" label-position="top" class="px-1" @submit.prevent>
      <el-divider content-position="left">{{ $t("gallery.webpageSectionPage") }}</el-divider>
      <el-form-item v-if="urlVarDef" :label="varDisplayName(urlVarDef)" required :error="urlErrorText">
        <el-input v-model="form.url" :placeholder="varDescripts(urlVarDef) || 'https://'" clearable
          @input="urlError = null" @keyup.enter="handleSubmit" />
      </el-form-item>
      <PluginVarsForm v-model="form.vars" :plugin-vars="visibleVarDefs" />
      <div v-if="IS_ANDROID" class="mb-3 text-xs text-[var(--anime-text-secondary)]">
        {{ $t("gallery.webpageWebviewDesktopOnly") }}
      </div>

      <el-divider content-position="left">{{ $t("gallery.webpageSectionSaveTo") }}</el-divider>
      <el-form-item v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
        <el-input v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" clearable>
          <template #append>
            <el-button @click="selectOutputDir">
              <el-icon>
                <FolderOpened />
              </el-icon>
              {{ $t("common.chooseFolder") }}
            </el-button>
          </template>
        </el-input>
      </el-form-item>
      <el-form-item :label="$t('albums.outputAlbum')">
        <AlbumPickerField v-model="selectedOutputAlbumId" :album-tree="outputAlbumTree" :album-counts="albumCounts"
          allow-create :placeholder="$t('plugins.defaultGalleryOnly')" :picker-title="$t('albums.outputAlbum')"
          clearable />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <el-input v-model="newOutputAlbumName" :placeholder="$t('albums.placeholderName')" maxlength="50"
          show-word-limit />
      </el-form-item>
      <el-form-item v-if="isCreatingNewOutputAlbum" :label="$t('albums.parentAlbum')">
        <AlbumPickerField v-model="newOutputAlbumParentId" :album-tree="outputAlbumParentTree"
          :album-counts="albumCounts" :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')" />
      </el-form-item>

      <!-- Header 只对 V8 后端生效；WebView 的身份只来自浏览器会话 -->
      <template v-if="isV8">
        <el-divider content-position="left">{{ $t("plugins.advancedSettings") }}</el-divider>
        <el-form-item :label="$t('plugins.httpHeaders')">
          <HttpHeadersEditor v-model="headers" :show-hint="false" />
          <div class="mt-1 text-xs leading-normal text-[var(--anime-text-secondary)]">
            {{ $t("gallery.webpageHeadersHint") }}
          </div>
        </el-form-item>
      </template>

      <div v-if="uiStore.isCompact" class="flex justify-end gap-3 pt-2">
        <el-button type="primary" class="w-full" :loading="submitting" @click="handleSubmit">
          {{ $t("gallery.startCollect") }}
        </el-button>
      </div>
    </el-form>

    <template v-if="!uiStore.isCompact" #footer>
      <div class="flex justify-end gap-3">
        <el-button @click="modal.close()">{{ $t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ $t("gallery.startCollect") }}
        </el-button>
      </div>
    </template>
  </component>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import { ElDialog } from "@kabegame/element-plus";
import { FolderOpened } from "@kabegame/element-plus-icons";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import PluginVarsForm from "@kabegame/core/components/crawler/PluginVarsForm.vue";
import HttpHeadersEditor from "@kabegame/core/components/crawler/HttpHeadersEditor.vue";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { matchesPluginVarWhen } from "@kabegame/core/utils/pluginVarWhen";
import {
  expandVarsForBackend,
  normalizeVarsForUI,
  optionValue,
  type PluginVarDef,
} from "@kabegame/core/utils/pluginVarForm";
import { usePluginStore } from "@/stores/plugins";
import { WEBPAGE_PLUGIN_ID } from "@kabegame/core/stores/plugins";
import { useAlbumStore, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { enqueueTask } from "@/composables/useCrawlTaskLauncher";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { validateWebpageUrl, type WebpageUrlError } from "@/utils/webpageCollect";
import { open } from "@tauri-apps/plugin-dialog";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

const { t } = useI18n();
const { varDisplayName, varDescripts } = usePluginConfigI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();
const albumStore = useAlbumStore();
const { albumCounts } = storeToRefs(albumStore);

const modal = useModal({ onClose: () => emit("update:modelValue", false) });

const shellProps = computed(() =>
  uiStore.isCompact
    ? { modelValue: modal.isOpen.value, zIndex: modal.zIndex.value, showCloseButton: true }
    : {
        modelValue: modal.isOpen.value,
        zIndex: modal.zIndex.value,
        title: t("gallery.webpageCollectTitle"),
        width: "600px",
        alignCenter: true,
        showClose: true,
      },
);

/** 字段定义来自内置插件 `webpage.config.vars`（URL / 后端 / Cookie / UA），不在前端另写一套 */
const varDefs = computed<PluginVarDef[]>(() => {
  const plugin = pluginStore.plugins.find((p) => p.id === WEBPAGE_PLUGIN_ID);
  const defs = ((plugin?.config?.vars as PluginVarDef[] | undefined) ?? []).map((def) => ({ ...def }));
  if (!IS_ANDROID) return defs;
  // Android 无 CEF / 畅游：只保留 V8 后端，去掉依赖浏览器的注入开关
  return defs
    .filter((def) => def.key !== "injectSurfCookie" && def.key !== "injectCefUserAgent")
    .map((def) =>
      def.key === "backend"
        ? { ...def, options: (def.options ?? []).filter((opt) => optionValue(opt) !== "webview") }
        : def,
    );
});
const urlVarDef = computed(() => varDefs.value.find((def) => def.key === "url"));
const visibleVarDefs = computed(() =>
  varDefs.value.filter((def) => def.key !== "url" && matchesPluginVarWhen(def.when, form.value.vars)),
);

const form = ref({ url: "", outputDir: "", vars: {} as Record<string, any> });
/** Host Header 草稿：本次打开期间切到 WebView 再切回仍保留，但 WebView 提交时强制为空 */
const headers = ref<Record<string, string>>({});
const urlError = ref<WebpageUrlError | null>(null);
const submitting = ref(false);

const isV8 = computed(() => form.value.vars.backend !== "webview");
const urlErrorText = computed(() => (urlError.value ? t(`gallery.webpageUrlError.${urlError.value}`) : ""));

const outputAlbumTree = computed(() => albumStore.getAlbumTreeExcluding([HIDDEN_ALBUM_ID]));
const outputAlbumParentTree = computed(() => albumStore.getAlbumTreeExcluding([FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID]));
const selectedOutputAlbumId = ref<string | null>(null);
const newOutputAlbumName = ref("");
const newOutputAlbumParentId = ref<string | null>(null);
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");

function resetForm() {
  form.value = {
    url: "",
    outputDir: "",
    vars: normalizeVarsForUI({}, varDefs.value.filter((def) => def.key !== "url")),
  };
  headers.value = {};
  urlError.value = null;
  selectedOutputAlbumId.value = null;
  newOutputAlbumName.value = "";
  newOutputAlbumParentId.value = null;
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      // 每次打开都从空白开始：取消后不残留上次未提交的数据
      resetForm();
      void albumStore.loadAlbums().catch((e) => console.error("加载画册列表失败:", e));
      modal.open();
    } else {
      modal.close();
    }
  },
  { immediate: true },
);

async function selectOutputDir() {
  if (await guardDesktopOnly("openLocal")) return;
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") form.value.outputDir = selected;
  } catch (error) {
    console.error("选择目录失败:", error);
  }
}

/** 现场创建画册；失败返回 null（不创建任务） */
async function resolveOutputAlbumId(): Promise<string | undefined | null> {
  if (selectedOutputAlbumId.value !== "__create_new__") return selectedOutputAlbumId.value || undefined;
  const name = newOutputAlbumName.value.trim();
  if (!name) {
    ElMessage.warning(t("albums.enterAlbumNameFirst"));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const album = await albumStore.createAlbum(name, { parentId, reload: false });
    return album.id;
  } catch (error) {
    console.error("创建画册失败:", error);
    ElMessage.error(t("albums.createAlbumFailed"));
    return null;
  }
}

async function handleSubmit() {
  if (submitting.value) return;
  const checked = validateWebpageUrl(form.value.url);
  if (!checked.ok) {
    urlError.value = checked.error;
    return;
  }
  submitting.value = true;
  try {
    const outputAlbumId = await resolveOutputAlbumId();
    if (outputAlbumId === null) return;

    // 只提交当前可见的变量（切到 WebView 后 Cookie / UA 开关不入任务参数）
    const visibleKeys = new Set(visibleVarDefs.value.map((def) => def.key));
    const visibleVars = Object.fromEntries(
      Object.entries(form.value.vars).filter(([key]) => visibleKeys.has(key)),
    );
    const userConfig: Record<string, any> = {
      ...expandVarsForBackend(visibleVars, visibleVarDefs.value),
      url: checked.url,
    };
    const httpHeaders = isV8.value ? headers.value : {};
    const added = await enqueueTask({
      pluginId: WEBPAGE_PLUGIN_ID,
      outputDir: uiStore.isCompact ? undefined : form.value.outputDir || undefined,
      userConfig,
      outputAlbumId,
      httpHeaders,
      triggerSource: "manual",
    });
    if (!added) {
      ElMessage.error(t("gallery.webpageTaskFailed"));
      return;
    }
    if (IS_WEB) {
      // 只上报布尔 / 计数，不含 URL、Header 名值或页面内容
      trackEvent("gallery_import_start", {
        source: "webpage",
        backend: userConfig.backend,
        has_output_dir: !!form.value.outputDir,
        output_album: selectedOutputAlbumId.value
          ? selectedOutputAlbumId.value === "__create_new__" ? "new" : "existing"
          : "none",
        has_http_headers: Object.keys(httpHeaders).length > 0,
        http_header_count: Object.keys(httpHeaders).length,
        inject_surf_cookie: userConfig.injectSurfCookie === true,
        inject_cef_ua: userConfig.injectCefUserAgent === true,
      });
    }
    ElMessage.success(t("gallery.webpageTaskAdded"));
    modal.close();
  } finally {
    submitting.value = false;
  }
}

// 供单测驱动表单与提交（组件对外只通过 v-model 使用）
defineExpose({ form, headers, urlError, visibleVarDefs, handleSubmit });
</script>
