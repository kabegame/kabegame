<template>
  <!-- 桌面 Dialog / 紧凑布局全宽 AndroidDrawer，共用同一份表单；层级与 Android 返回栈由外壳自己接 -->
  <component :is="uiStore.isCompact ? AndroidDrawer : Dialog" v-bind="shellProps">
    <template v-if="uiStore.isCompact" #header>
      <h3 class="m-0 text-[17px] font-600 text-kb-fg">{{ $t("gallery.webpageCollectTitle") }}</h3>
    </template>

    <form class="flex flex-col gap-4" :class="uiStore.isCompact ? 'py-4' : ''" @submit.prevent>
      <SectionTitle>{{ $t("gallery.webpageSectionPage") }}</SectionTitle>
      <Field v-if="urlVarDef" :label="varDisplayName(urlVarDef)" required :error="urlErrorText">
        <Input
          ref="urlInputRef"
          v-model="form.url"
          :placeholder="varDescripts(urlVarDef) || 'https://'"
          clearable
          @update:model-value="urlError = null"
          @keyup.enter="handleSubmit"
        />
      </Field>
      <PluginVarsForm v-model="form.vars" :plugin-vars="visibleVarDefs" />

      <SectionTitle class="mt-1">{{ $t("gallery.webpageSectionSaveTo") }}</SectionTitle>
      <Field v-if="!uiStore.isCompact" :label="$t('plugins.outputDir')">
        <OutputDirSelect v-model="form.outputDir" :placeholder="$t('plugins.outputDirPlaceholder')" />
      </Field>
      <Field :label="$t('albums.outputAlbum')">
        <AlbumPicker
          v-model="selectedOutputAlbumId"
          :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
          expand-label-dirs
          allow-create
          :placeholder="$t('plugins.defaultGalleryOnly')"
          :picker-title="$t('albums.outputAlbum')"
          clearable
        />
      </Field>
      <Field v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" required>
        <Input v-model="newOutputAlbumName" :placeholder="$t('albums.placeholderName')" maxlength="50">
          <template #suffix>
            <span class="text-[11.5px] tabular-nums">{{ newOutputAlbumName.length }}/50</span>
          </template>
        </Input>
      </Field>
      <Field v-if="isCreatingNewOutputAlbum" :label="$t('albums.parentAlbum')">
        <AlbumPicker
          v-model="newOutputAlbumParentId"
          :scope="{ sections: ['normal'] }"
          :placeholder="$t('albums.selectParentAlbum')"
          :picker-title="$t('albums.parentAlbum')"
        />
      </Field>
      <div class="flex flex-wrap gap-x-6 gap-y-4">
        <Field class="min-w-56 flex-1" :label="$t('plugins.dryRun')">
          <label class="flex min-h-8 cursor-pointer items-center gap-2.5">
            <Switch v-model="isDryRun" />
            <span class="text-[12.5px] text-kb-fg-muted">{{ $t("plugins.dryRunDesc") }}</span>
          </label>
        </Field>
        <Field class="min-w-56 flex-1" :label="$t('plugins.retryOnFail')">
          <div class="flex min-h-8 items-center">
            <RetryCountField v-model="retryCount" />
          </div>
        </Field>
      </div>

      <!-- Header 只对 V8 后端生效；WebView 的身份只来自浏览器会话 -->
      <template v-if="isV8">
        <SectionTitle class="mt-1">{{ $t("plugins.advancedSettings") }}</SectionTitle>
        <Field :label="$t('plugins.httpHeaders')" :description="$t('gallery.webpageHeadersHint')">
          <HttpHeadersEditor v-model="headers" :show-hint="false" />
        </Field>
      </template>

      <Button
        v-if="uiStore.isCompact"
        variant="primary"
        class="mt-2 w-full"
        :disabled="submitting"
        @click="handleSubmit"
      >
        <Spinner v-if="submitting" :size="14" />
        {{ $t("gallery.startCollect") }}
      </Button>
    </form>

    <template v-if="!uiStore.isCompact" #footer>
      <Button @click="open = false">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="submitting" @click="handleSubmit">
        <Spinner v-if="submitting" :size="14" />
        {{ $t("gallery.startCollect") }}
      </Button>
    </template>
  </component>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import AndroidDrawer from "@/components/AndroidDrawer.vue";
import { Button, Dialog, Field, Input, Spinner, Switch, useForm } from "@/components/ui";
import OutputDirSelect from "@/components/crawler/OutputDirSelect.vue";
import PluginVarsForm from "@/components/crawler/PluginVarsForm.vue";
import HttpHeadersEditor from "@/components/crawler/HttpHeadersEditor.vue";
import RetryCountField from "@/components/crawler/RetryCountField.vue";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import SectionTitle from "@/components/ui/SectionTitle.vue";
import { useUiStore } from "@/stores/ui";
import { IS_WEB } from "@/env";
import { trackEvent } from "@/track/umami";
import { kameMessage } from "@/utils/kameMessage";
import { visibleVarDefs as resolveVisibleVarDefs } from "@/utils/pluginVarWhen";
import { expandVarsForBackend, normalizeVarsForUI, type PluginVarDef } from "@/utils/pluginVarForm";
import { usePluginStore } from "@/stores/plugins";
import { WEBPAGE_PLUGIN_ID } from "@/stores/plugins";
import { HIDDEN_ALBUM_ID, createAlbum } from "@/services/albums";
import { enqueueTask } from "@/composables/useCrawlTaskLauncher";
import { validateWebpageUrl, type WebpageUrlError } from "@/utils/webpageCollect";
import type { WebpageCollectInitialConfig } from "@/stores/collectDialogs";

const props = defineProps<{
  modelValue: boolean;
  initialConfig?: WebpageCollectInitialConfig;
}>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

const { t } = useI18n();
const { varDisplayName, varDescripts } = usePluginConfigI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

/** 插件变量（PluginVarsForm 里的 Field）注册进这个表单，提交时一起校验必填等 */
const formApi = useForm();

// AndroidDrawer 不传 z-index：由它自己占栈位（层级与 Android 返回键）；Dialog 自己取号、接返回栈
const shellProps = computed(() =>
  uiStore.isCompact
    ? {
        modelValue: open.value,
        showCloseButton: true,
        "onUpdate:modelValue": (v: boolean) => (open.value = v),
      }
    : {
        open: open.value,
        title: t("gallery.webpageCollectTitle"),
        width: 600,
        "onUpdate:open": (v: boolean) => (open.value = v),
      },
);

/** 字段定义来自内置插件 `webpage.config.vars`（URL / 后端 / Cookie / UA），不在前端另写一套 */
const varDefs = computed<PluginVarDef[]>(() => {
  const plugin = pluginStore.plugins.find((p) => p.id === WEBPAGE_PLUGIN_ID);
  return ((plugin?.config?.vars as PluginVarDef[] | undefined) ?? []).map((def) => ({ ...def }));
});
const urlVarDef = computed(() => varDefs.value.find((def) => def.key === "url"));
const visibleVarDefs = computed(() =>
  resolveVisibleVarDefs(varDefs.value, form.value.vars).filter((def) => def.key !== "url"),
);

const form = ref({ url: "", outputDir: "", vars: {} as Record<string, any> });
/** Host Header 草稿：本次打开期间切到 WebView 再切回仍保留，但 WebView 提交时强制为空 */
const headers = ref<Record<string, string>>({});
const urlError = ref<WebpageUrlError | null>(null);
const urlInputRef = ref<InstanceType<typeof Input> | null>(null);
const submitting = ref(false);
const isDryRun = ref(false);
const retryCount = ref(0);

const isV8 = computed(() => form.value.vars.backend !== "webview");
const urlErrorText = computed(() => (urlError.value ? t(`gallery.webpageUrlError.${urlError.value}`) : ""));

const selectedOutputAlbumId = ref<string | null>(null);
const newOutputAlbumName = ref("");
const newOutputAlbumParentId = ref<string | null>(null);
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");

function resetForm() {
  form.value = {
    url: "",
    outputDir: "",
    vars: normalizeVarsForUI(
      {},
      varDefs.value.filter((def) => def.key !== "url"),
    ),
  };
  headers.value = {};
  urlError.value = null;
  selectedOutputAlbumId.value = null;
  isDryRun.value = false;
  retryCount.value = 0;
  newOutputAlbumName.value = "";
  newOutputAlbumParentId.value = null;
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      // 每次打开都从空白开始：取消后不残留上次未提交的数据
      resetForm();
      if (props.initialConfig) {
        const { url, ...userVars } = props.initialConfig.userConfig ?? {};
        form.value.url = typeof url === "string" ? url : "";
        form.value.outputDir = props.initialConfig.outputDir ?? "";
        form.value.vars = normalizeVarsForUI(
          userVars,
          varDefs.value.filter((def) => def.key !== "url"),
        );
        headers.value = { ...(props.initialConfig.httpHeaders ?? {}) };
        selectedOutputAlbumId.value = props.initialConfig.outputAlbumId ?? null;
        isDryRun.value = props.initialConfig.isDryRun ?? false;
        retryCount.value = props.initialConfig.retryCount ?? 0;
      }
      // 重置草稿会让各字段的校验结果变化、被记成「改过」；等这一轮 watcher 跑完再清，免得一打开就标红
      void nextTick(() => formApi.reset());
    }
  },
  { immediate: true },
);

/** 现场创建画册；失败返回 null（不创建任务） */
async function resolveOutputAlbumId(): Promise<string | undefined | null> {
  if (selectedOutputAlbumId.value !== "__create_new__") return selectedOutputAlbumId.value || undefined;
  const name = newOutputAlbumName.value.trim();
  if (!name) {
    kameMessage.warning(t("albums.enterAlbumNameFirst"));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const album = await createAlbum(name, { parentId, reload: false });
    return album.id;
  } catch (error) {
    console.error("创建画册失败:", error);
    kameMessage.error(t("albums.createAlbumFailed"));
    return null;
  }
}

async function handleSubmit() {
  if (submitting.value) return;
  const checked = validateWebpageUrl(form.value.url);
  urlError.value = checked.ok ? null : checked.error;
  // 地址与插件变量一起检查，两边的错误同时显示
  const varsOk = formApi.validate();
  // 地址错了就把焦点送回地址框并滚回去：它在最上面，从底部按钮提交时可能不在视野里（已聚焦时 focus 不滚动）
  if (!checked.ok) {
    urlInputRef.value?.focus?.();
    (urlInputRef.value?.$el as HTMLElement | undefined)?.scrollIntoView?.({ block: "center" });
  }
  if (!checked.ok || !varsOk) return;
  submitting.value = true;
  try {
    const outputAlbumId = await resolveOutputAlbumId();
    if (outputAlbumId === null) return;

    // 只提交当前可见的变量（切到 WebView 后 Cookie / UA 开关不入任务参数）
    const visibleKeys = new Set(visibleVarDefs.value.map((def) => def.key));
    const visibleVars = Object.fromEntries(Object.entries(form.value.vars).filter(([key]) => visibleKeys.has(key)));
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
      isDryRun: isDryRun.value,
      retryCount: retryCount.value,
      triggerSource: "manual",
    });
    if (!added) {
      kameMessage.error(t("gallery.webpageTaskFailed"));
      return;
    }
    if (IS_WEB) {
      // 只上报布尔 / 计数，不含 URL、Header 名值或页面内容
      trackEvent("gallery_import_start", {
        source: "webpage",
        backend: userConfig.backend,
        has_output_dir: !!form.value.outputDir,
        output_album: selectedOutputAlbumId.value
          ? selectedOutputAlbumId.value === "__create_new__"
            ? "new"
            : "existing"
          : "none",
        has_http_headers: Object.keys(httpHeaders).length > 0,
        http_header_count: Object.keys(httpHeaders).length,
        inject_surf_cookie: userConfig.injectSurfCookie === true,
        inject_cef_ua: userConfig.injectCefUserAgent === true,
      });
    }
    kameMessage.success(t("gallery.webpageTaskAdded"));
    open.value = false;
  } finally {
    submitting.value = false;
  }
}

// 供单测驱动表单与提交（组件对外只通过 v-model 使用）
defineExpose({ form, headers, urlError, visibleVarDefs, handleSubmit });
</script>
