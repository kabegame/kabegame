<template>
  <div class="crawler-container">
    <PageHeader title="爬虫测试" subtitle="通过本地代理加载网页进行初步测试" sticky />

    <template v-if="IS_ANDROID">
      <el-card class="crawler-card">
        <el-alert type="info" show-icon :closable="false">
          爬虫代理功能当前仅支持桌面端（Windows / macOS / Linux），安卓端后续适配。
        </el-alert>
      </el-card>
    </template>

    <template v-else>
      <el-card class="crawler-card">
        <div class="crawler-toolbar">
          <el-input
            v-model="inputUrl"
            placeholder="输入要测试的网址（如 https://example.com）"
            clearable
            class="crawler-url-input"
            @keyup.enter="openInIframe"
          />
          <el-button type="primary" :loading="loading" @click="openInIframe">
            打开
          </el-button>
        </div>
        <p v-if="!proxyBase && !loadError" class="crawler-hint">正在获取代理服务地址…</p>
        <p v-else-if="loadError" class="crawler-error">{{ loadError }}</p>
        <p v-else-if="proxyBase" class="crawler-hint">
          代理基地址：{{ proxyBase }} · 页面将通过 /proxy?url= 加载，与父页面同源便于后续爬虫脚本读 DOM。
        </p>
      </el-card>

      <div class="crawler-iframe-wrap">
        <iframe
          v-if="iframeSrc"
          ref="iframeEl"
          :src="iframeSrc"
          class="crawler-iframe"
          title="代理预览"
          @load="handleIframeLoad"
          @error="handleIframeError"
        />
        <div v-else class="crawler-iframe-placeholder">
          在上方输入网址并点击「打开」进行测试
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { IS_ANDROID } from "@kabegame/core/env";

const inputUrl = ref("");
const iframeSrc = ref("");
const proxyBase = ref("");
const loadError = ref("");
const loading = ref(false);
const iframeEl = ref<HTMLIFrameElement | null>(null);

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>) {
  // #region agent log
  fetch("http://127.0.0.1:7584/ingest/c0bebee6-485b-4fa2-aa0e-0bbc81e4acc7", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "be562c",
    },
    body: JSON.stringify({
      sessionId: "be562c",
      runId: "initial",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

async function ensureProxyBase() {
  if (proxyBase.value) return true;
  if (loadError.value) return false;
  try {
    const base = await invoke<string>("get_http_server_base_url");
    const trimmed = (base || "").trim();
    if (trimmed) {
      proxyBase.value = trimmed;
      debugLog("H4", "apps/main/src/views/Crawler.vue:74", "proxy base ready", {
        proxyBase: trimmed,
      });
      return true;
    }
    loadError.value = "未获取到代理服务地址";
    debugLog("H4", "apps/main/src/views/Crawler.vue:80", "proxy base empty", {});
    return false;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    debugLog("H4", "apps/main/src/views/Crawler.vue:84", "proxy base failed", {
      error: loadError.value,
    });
    return false;
  }
}

function openInIframe() {
  const url = inputUrl.value.trim();
  if (!url) return;
  loading.value = true;
  debugLog("H4", "apps/main/src/views/Crawler.vue:93", "open in iframe requested", {
    inputUrl: url,
    existingProxyBase: proxyBase.value || null,
  });
  ensureProxyBase().then((ok) => {
    loading.value = false;
    if (ok && proxyBase.value) {
      iframeSrc.value = `${proxyBase.value}/proxy?url=${encodeURIComponent(url)}`;
      debugLog("H4", "apps/main/src/views/Crawler.vue:100", "iframe src assigned", {
        targetUrl: url,
        iframeSrc: iframeSrc.value,
      });
    }
  });
}

function handleIframeLoad() {
  const frame = iframeEl.value;
  const doc = frame?.contentDocument;
  debugLog("H5", "apps/main/src/views/Crawler.vue:109", "iframe loaded", {
    iframeSrc: iframeSrc.value,
    title: doc?.title || "",
    bodySnippet: doc?.body?.innerText?.slice(0, 200) || "",
  });
}

function handleIframeError() {
  debugLog("H5", "apps/main/src/views/Crawler.vue:118", "iframe load error", {
    iframeSrc: iframeSrc.value,
  });
}

onMounted(() => {
  if (!IS_ANDROID) {
    void ensureProxyBase();
  }
});
</script>

<style lang="scss" scoped>
.crawler-container {
  padding: 0 20px 20px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.crawler-card {
  flex-shrink: 0;
  margin-bottom: 16px;

  .crawler-toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .crawler-url-input {
    flex: 1;
    min-width: 200px;
  }

  .crawler-hint {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--anime-text-secondary);
  }

  .crawler-error {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--el-color-danger);
  }
}

.crawler-iframe-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--anime-bg-card);
}

.crawler-iframe {
  width: 100%;
  height: 100%;
  min-height: 400px;
  border: none;
  display: block;
}

.crawler-iframe-placeholder {
  width: 100%;
  height: 400px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--anime-text-secondary);
  font-size: 14px;
}
</style>
