<template>
  <section
    class="box-border w-full rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-5 py-[18px]"
  >
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <!-- 运行状态点：运行中成功色，停止时灰 -->
        <span
          class="size-2.5 shrink-0 rounded-full"
          :class="
            enabled
              ? 'bg-kb-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--kb-success)_18%,transparent)]'
              : 'bg-kb-fg-subtle shadow-[0_0_0_4px_var(--kb-fill)]'
          "
        ></span>
        <div class="flex flex-col gap-0.5">
          <span class="text-[15px] font-600 text-kb-fg">
            {{ $t("settings.webServerSectionTitle") }}
          </span>
          <span class="font-mono text-[12px] text-kb-fg-muted">
            {{ enabled ? $t("settings.webServerRunning") : $t("settings.webServerStopped") }}
          </span>
        </div>
      </div>
      <!-- 开关不乐观切换：写入成功后由设置值带过来 -->
      <Switch :model-value="enabled" :disabled="toggling" @update:model-value="onToggle" />
    </div>

    <p class="mb-0 mt-3 text-[12px] leading-[1.6] text-kb-fg-muted">
      {{ $t("settings.webServerDesc") }}
    </p>

    <div class="mt-4 flex flex-col gap-4">
      <div class="grid min-w-0 gap-2 md:grid-cols-2">
        <button
          v-for="endpoint in endpoints"
          :key="endpoint.key"
          type="button"
          class="m-0 box-border flex min-w-0 cursor-pointer items-center gap-2.5 rounded-kb-md border border-solid border-kb-line bg-kb-fill-lighter px-3 py-2 text-left [font-family:inherit] outline-none transition-colors duration-150 hover:border-kb-line-strong hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring"
          @click="copyText(endpoint.url)"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-[11px] font-500 text-kb-fg-muted">{{ endpoint.label }}</span>
            <span class="break-all font-mono text-[13px] text-kb-fg">{{ endpoint.url }}</span>
            <span class="text-[11px] leading-[1.5] text-kb-fg-muted">{{ endpoint.desc }}</span>
          </span>
          <Copy class="size-3.5 shrink-0 text-kb-fg-subtle" />
        </button>
        <p v-if="lanAccess && !lanIp" class="col-span-full m-0 text-[11px] text-kb-warning">
          {{ $t("settings.webServerLanIpUnknown") }}
        </p>
      </div>

      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-kb-fg-muted">{{ $t("settings.webServerPort") }}</span>
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
        <p v-if="enabled" class="m-0 text-[11px] text-kb-warning">
          {{ $t("settings.webServerRuntimeSettingsDisabledHint") }}
        </p>
        <div class="flex items-center justify-between gap-3 border-0 border-t border-solid border-kb-line pt-3">
          <div class="min-w-0">
            <div class="text-[13px] text-kb-fg">{{ $t("settings.webServerLanAccess") }}</div>
            <p class="m-0 mt-1 max-w-[320px] text-[11px] leading-[1.5] text-kb-warning">
              {{ $t("settings.webServerLanAccessDesc") }}
            </p>
          </div>
          <Switch
            :model-value="lanAccess"
            :disabled="enabled || toggling || lanToggling"
            @update:model-value="onLanToggle"
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
import { Copy } from "@lucide/vue";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import KbNumber from "@/components/common/form/KbNumber.vue";
import Switch from "@/components/ui/Switch.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { kameMessage } from "@/utils/kameMessage";

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
/** 返回是否写入成功（测试据此断言）；开关的显示值始终跟随设置 */
async function onToggle(): Promise<boolean> {
  if (toggling.value) return false;
  toggling.value = true;
  try {
    return await setEnabledValue(!enabled.value);
  } catch {
    kameMessage.error(t("settings.webServerPortInUse"));
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
    kameMessage.error(t("settings.webServerPortInUse"));
    localPort.value = port.value;
  } finally {
    portSaving.value = false;
  }
}

const lanToggling = ref(false);
async function onLanToggle(): Promise<boolean> {
  if (toggling.value || enabled.value || lanToggling.value) return false;
  lanToggling.value = true;
  try {
    return await setLanValue(!lanAccess.value);
  } catch {
    kameMessage.error(t("common.operationFailed"));
    return false;
  } finally {
    lanToggling.value = false;
  }
}

async function copyText(text: string) {
  try {
    await writeText(text);
    kameMessage.success(t("common.copySuccess"));
  } catch {
    kameMessage.error(t("common.copyFailed"));
  }
}
</script>
