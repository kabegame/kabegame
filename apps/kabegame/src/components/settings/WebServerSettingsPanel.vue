<template>
  <section
    class="relative w-full overflow-hidden rounded-[18px] border border-[color-mix(in_srgb,var(--anime-primary)_26%,transparent)] bg-[color-mix(in_srgb,var(--anime-bg-card,#1c1c28)_88%,transparent)] px-6 py-[22px] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--anime-primary)_8%,transparent)]"
    :class="enabled ? '!border-[color-mix(in_srgb,#22d3ee_40%,transparent)]' : ''"
  >
    <div class="relative z-1 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <span
          class="h-3 w-3 rounded-full bg-[var(--anime-text-muted)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--anime-text-muted)_18%,transparent)]"
          :class="enabled ? '!bg-[#22d3ee] !shadow-[0_0_0_4px_color-mix(in_srgb,#22d3ee_22%,transparent)]' : ''"
        ></span>
        <div class="flex flex-col gap-0.5">
          <span class="text-[18px] font-700 tracking-[0.02em] text-[var(--anime-text-primary)]">
            {{ $t("settings.webServerSectionTitle") }}
          </span>
          <span class="font-mono text-[12px] text-[var(--anime-text-muted)]">
            {{ enabled ? $t("settings.webServerRunning") : $t("settings.webServerStopped") }}
          </span>
        </div>
      </div>
      <el-switch size="large" :model-value="enabled" :loading="toggling" :before-change="onBeforeToggle" />
    </div>

    <p class="relative z-1 mb-0 mt-3 text-[12px] leading-[1.6] text-[var(--anime-text-muted)]">
      {{ $t("settings.webServerDesc") }}
    </p>

    <div class="relative z-1 mt-4 flex flex-col gap-4">
      <div class="grid min-w-0 gap-2 md:grid-cols-2">
        <button
          v-for="endpoint in endpoints"
          :key="endpoint.key"
          type="button"
          class="flex min-w-0 items-center gap-2.5 rounded-[10px] border border-[color-mix(in_srgb,var(--anime-primary)_22%,transparent)] bg-[color-mix(in_srgb,var(--anime-primary)_8%,transparent)] px-3 py-2 text-left transition-colors hover:border-[color-mix(in_srgb,var(--anime-primary)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--anime-primary)_14%,transparent)]"
          @click="copyText(endpoint.url)"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-[11px] text-[var(--anime-primary)]">{{ endpoint.label }}</span>
            <span class="break-all font-mono text-[13px] text-[var(--anime-text-primary)]">{{ endpoint.url }}</span>
            <span class="text-[11px] leading-[1.5] text-[var(--anime-text-muted)]">{{ endpoint.desc }}</span>
          </span>
          <el-icon class="shrink-0 text-[14px] text-[var(--anime-text-muted)]"><DocumentCopy /></el-icon>
        </button>
        <p v-if="lanAccess && !lanIp" class="col-span-full m-0 text-[11px] text-[var(--anime-warning,#e6a23c)]">
          {{ $t("settings.webServerLanIpUnknown") }}
        </p>
      </div>

      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-[var(--anime-text-muted)]">{{ $t("settings.webServerPort") }}</span>
          <KbNumber
            v-model="localPort"
            type="int"
            class="!w-[140px]"
            :min="1024"
            :max="65535"
            :disabled="enabled || toggling || portSaving"
            @change="onPortChange"
          />
        </div>
        <p v-if="enabled" class="m-0 text-[11px] text-[var(--anime-warning,#e6a23c)]">
          {{ $t("settings.webServerRuntimeSettingsDisabledHint") }}
        </p>
        <div
          class="flex items-center justify-between gap-3 border-t border-[color-mix(in_srgb,var(--anime-primary)_15%,transparent)] pt-3"
        >
          <div class="min-w-0">
            <div class="text-[13px] text-[var(--anime-text-primary)]">{{ $t("settings.webServerLanAccess") }}</div>
            <p class="m-0 mt-1 max-w-[320px] text-[11px] leading-[1.5] text-[var(--anime-warning,#e6a23c)]">
              {{ $t("settings.webServerLanAccessDesc") }}
            </p>
          </div>
          <el-switch
            :model-value="lanAccess"
            :loading="lanToggling"
            :disabled="enabled || toggling || lanToggling"
            :before-change="onBeforeLanToggle"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@/api/rpc";
import { useI18n } from "@kabegame/i18n";
import { DocumentCopy } from "@kabegame/element-plus-icons";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import KbNumber from "@/components/common/form/KbNumber.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { kameMessage as ElMessage } from "@/utils/kameMessage";

const { t } = useI18n();
const { settingValue: enabledValue, set: setEnabledValue } = useSettingKeyState("webServerEnabled");
const { settingValue: portValue, set: setPortValue } = useSettingKeyState("webServerPort");
const { settingValue: lanValue, set: setLanValue } = useSettingKeyState("webServerLanAccess");

const enabled = computed(() => enabledValue.value === true);
const port = computed(() => (typeof portValue.value === "number" ? portValue.value : 7490));
const lanAccess = computed(() => lanValue.value === true);
// 开启局域网访问时探测本机局域网 IP；探测不到则仍显示回环地址并提示
const lanIp = ref<string | null>(null);
watch(
  lanAccess,
  async (on) => {
    if (!on) return;
    try {
      lanIp.value = await invoke<string | null>("get_web_server_lan_ip");
    } catch (e) {
      console.warn("[web-server] get lan ip failed:", e);
      lanIp.value = null;
    }
  },
  { immediate: true },
);
/** 服务器地址：粘贴到「Kabegame 服务器」插件的服务器地址；MCP 只给本机客户端用 */
const endpoints = computed(() => {
  const host = lanAccess.value && lanIp.value ? lanIp.value : "127.0.0.1";
  return [
    {
      key: "server",
      label: t("settings.webServerBaseUrl"),
      desc: t("settings.webServerBaseUrlDesc"),
      url: `http://${host}:${port.value}`,
    },
    {
      key: "mcp",
      label: t("settings.webServerMcpUrl"),
      desc: t("settings.webServerMcpUrlDesc"),
      url: `http://127.0.0.1:${port.value}/mcp`,
    },
  ];
});

const toggling = ref(false);
async function onBeforeToggle(): Promise<boolean> {
  toggling.value = true;
  try {
    return await setEnabledValue(!enabled.value);
  } catch {
    ElMessage.error(t("settings.webServerPortInUse"));
    return false;
  } finally {
    toggling.value = false;
  }
}

const localPort = ref<number | string | undefined>(port.value);
watch(
  port,
  (value) => {
    localPort.value = value;
  },
  { immediate: true },
);
const portSaving = ref(false);
async function onPortChange(value: number | undefined) {
  // 开启过程中和运行中都不允许改端口，避免 bind 与端口保存并发。
  if (toggling.value || enabled.value) {
    localPort.value = port.value;
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    localPort.value = port.value;
    return;
  }
  const next = Math.trunc(value);
  localPort.value = next;
  if (next < 1024 || next > 65535 || next === port.value) return;
  portSaving.value = true;
  try {
    await setPortValue(next);
  } catch {
    ElMessage.error(t("settings.webServerPortInUse"));
    localPort.value = port.value;
  } finally {
    portSaving.value = false;
  }
}

const lanToggling = ref(false);
async function onBeforeLanToggle(): Promise<boolean> {
  if (toggling.value || enabled.value) return false;
  lanToggling.value = true;
  try {
    return await setLanValue(!lanAccess.value);
  } catch {
    ElMessage.error(t("common.operationFailed"));
    return false;
  } finally {
    lanToggling.value = false;
  }
}

async function copyText(text: string) {
  try {
    await writeText(text);
    ElMessage.success(t("common.copySuccess"));
  } catch {
    ElMessage.error(t("common.copyFailed"));
  }
}
</script>
