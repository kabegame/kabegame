<template>
  <div class="flex w-full flex-col gap-5">
    <Alert v-if="!enabled" tone="warning" :description="$t('settings.mcpRequiresWebServer')" />

    <!-- ── 能力矩阵 ── -->
    <section :class="BLOCK">
      <header class="mb-4 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="m-0 text-[15px] font-600 text-kb-fg">{{ $t("settings.mcpCapabilities") }}</h3>
          <p class="m-0 mt-1 text-[12px] text-kb-fg-muted">{{ $t("settings.mcpCapabilitiesDesc") }}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <Button size="sm" @click="setAll(true)">{{ $t("settings.mcpSelectAll") }}</Button>
          <Button size="sm" @click="setAll(false)">{{ $t("settings.mcpClearAll") }}</Button>
        </div>
      </header>

      <div v-loading="capsLoading" class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
        <article
          v-for="cat in groupedCapabilities"
          :key="cat.category"
          class="rounded-kb-md border border-solid border-kb-line px-3.5 py-3 transition-colors duration-150 hover:border-kb-line-strong"
        >
          <div class="mb-2 flex items-center justify-between border-0 border-b border-dashed border-kb-line pb-2">
            <Checkbox :model-value="tristate(cat)" @update:model-value="(v) => setCaps(cat.allIds, v === true)">
              <span class="text-[14px] font-600 text-kb-fg">{{ t(`mcp.category.${cat.category}`) }}</span>
            </Checkbox>
            <span class="font-mono text-[11px] text-kb-fg-muted">{{ cat.enabledCount }}/{{ cat.total }}</span>
          </div>
          <div v-for="grp in cat.kinds" :key="grp.kind" class="mt-1.5">
            <Checkbox
              class="my-1"
              :model-value="tristate(grp)"
              @update:model-value="(v) => setCaps(grp.ids, v === true)"
            >
              <!-- 读 / 写只用色调区分：写入类用警告色提醒它会改数据 -->
              <Tag size="sm" :tone="grp.kind === 'write' ? 'warning' : 'neutral'" class="uppercase tracking-[0.06em]">
                {{ t(`mcp.kind.${grp.kind}`) }}
              </Tag>
            </Checkbox>
            <ul class="m-0 list-none p-0">
              <!-- 整行可点；复选框自己的点击不再冒泡到行，免得切两次 -->
              <li
                v-for="cap in grp.caps"
                :key="cap.id"
                class="flex cursor-pointer items-start gap-2.5 rounded-kb-sm px-2 py-1.5 transition-colors duration-100 hover:bg-kb-hover"
                @click="setCaps([cap.id], disabledSet.has(cap.id))"
              >
                <Checkbox
                  :model-value="!disabledSet.has(cap.id)"
                  @click.stop
                  @update:model-value="(v) => setCaps([cap.id], v === true)"
                />
                <div class="flex min-w-0 flex-col gap-px">
                  <span class="text-[13px] leading-[1.4] text-kb-fg">{{ t(`mcp.cap.${cap.id}.name`) }}</span>
                  <span class="break-words text-[11px] leading-[1.4] text-kb-fg-muted">
                    {{ t(`mcp.cap.${cap.id}.desc`) }}
                  </span>
                </div>
              </li>
            </ul>
          </div>
        </article>
      </div>
    </section>

    <!-- ── 连接命令 ── -->
    <section :class="BLOCK">
      <header class="mb-4">
        <h3 class="m-0 text-[15px] font-600 text-kb-fg">{{ $t("settings.mcpConnectTitle") }}</h3>
        <p class="m-0 mt-1 text-[12px] text-kb-fg-muted">{{ $t("settings.mcpConnectDesc") }}</p>
      </header>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3.5">
        <div
          v-for="cmd in connectCommands"
          :key="cmd.key"
          class="rounded-kb-md border border-solid border-kb-line px-3.5 py-3 transition-colors duration-150 hover:border-kb-line-strong"
        >
          <div class="mb-2.5 flex flex-col gap-0.5">
            <span class="text-[13px] font-600 text-kb-fg">{{ cmd.title }}</span>
            <span class="text-[11px] text-kb-fg-muted">{{ cmd.desc }}</span>
          </div>
          <CodeBlock :code="cmd.code" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import CodeBlock from "@/components/common/CodeBlock.vue";
import { vLoading } from "@/components/ui/loading";
import Alert from "@/components/ui/Alert.vue";
import Button from "@/components/ui/Button.vue";
import Checkbox from "@/components/ui/Checkbox.vue";
import Tag from "@/components/ui/Tag.vue";

interface McpCapability {
  id: string;
  category: string;
  kind: "read" | "write";
  tool: string | null;
  name_key: string;
  desc_key: string;
}

const { t } = useI18n();

/** 区块外框（能力矩阵、连接命令） */
const BLOCK = "box-border rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-5 py-[18px]";

/** 全选 / 部分 / 全不选 → 复选框的三态 */
const tristate = (g: { checked: boolean; indeterminate: boolean }) =>
  g.checked ? true : g.indeterminate ? ("indeterminate" as const) : false;

const { settingValue: enabledValue } = useSettingKeyState("webServerEnabled");
const { settingValue: portValue } = useSettingKeyState("webServerPort");
const { settingValue: disabledValue, set: setDisabledValue } = useSettingKeyState("mcpDisabledCapabilities");

const enabled = computed(() => enabledValue.value === true);
const port = computed(() => (typeof portValue.value === "number" ? portValue.value : 7490));
const disabledSet = computed(() => new Set(disabledValue.value ?? []));

const endpoint = computed(() => `http://127.0.0.1:${port.value}/mcp`);

// ── 能力矩阵（capabilities 是后端元数据；启用/禁用是 mcpDisabledCapabilities 设置）──
const CATEGORY_ORDER = ["images", "albums", "tasks", "surf_records", "color_buckets", "plugin"];
const capabilities = ref<McpCapability[]>([]);
const capsLoading = ref(false);

const groupedCapabilities = computed(() => {
  const byCat = new Map<string, { read: McpCapability[]; write: McpCapability[] }>();
  for (const cap of capabilities.value) {
    if (!byCat.has(cap.category)) byCat.set(cap.category, { read: [], write: [] });
    byCat.get(cap.category)![cap.kind].push(cap);
  }
  const disabled = disabledSet.value;
  const enabledIn = (caps: McpCapability[]) => caps.filter((c) => !disabled.has(c.id)).length;
  const order = [
    ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];
  return order.map((category) => {
    const grp = byCat.get(category)!;
    const kinds = (["read", "write"] as const)
      .filter((kind) => grp[kind].length > 0)
      .map((kind) => {
        const caps = grp[kind];
        const enabled = enabledIn(caps);
        return {
          kind,
          caps,
          ids: caps.map((c) => c.id),
          checked: enabled === caps.length,
          indeterminate: enabled > 0 && enabled < caps.length,
        };
      });
    const all = [...grp.read, ...grp.write];
    const enabled = enabledIn(all);
    return {
      category,
      kinds,
      allIds: all.map((c) => c.id),
      total: all.length,
      enabledCount: enabled,
      checked: enabled === all.length,
      indeterminate: enabled > 0 && enabled < all.length,
    };
  });
});

async function loadCaps() {
  capsLoading.value = true;
  try {
    capabilities.value = await invoke<McpCapability[]>("get_mcp_capabilities");
  } catch (e) {
    console.warn("[mcp] load capabilities failed:", e);
    kameMessage.error(t("settings.mcpCapabilitiesLoadFailed"));
  } finally {
    capsLoading.value = false;
  }
}

async function applyDisabled(list: string[]) {
  try {
    await setDisabledValue(list);
  } catch (e) {
    console.warn("[mcp] set disabled capabilities failed:", e);
    kameMessage.error(t("settings.mcpCapabilitiesSaveFailed"));
  }
}

// 范围勾选：单项、读/写子区、整个大类共用；enabledTarget=true 表示启用（移出禁用集）
function setCaps(ids: string[], enabledTarget: boolean) {
  const next = new Set(disabledSet.value);
  for (const id of ids) {
    if (enabledTarget) next.delete(id);
    else next.add(id);
  }
  void applyDisabled([...next]);
}

function setAll(enabledTarget: boolean) {
  void applyDisabled(enabledTarget ? [] : capabilities.value.map((c) => c.id));
}

// ── 连接命令 ──
const connectCommands = computed(() => [
  {
    key: "claude-code",
    title: t("settings.mcpConnectClaudeCode"),
    desc: t("settings.mcpConnectClaudeCodeDesc"),
    code: `claude mcp add --transport http kabegame ${endpoint.value}`,
  },
  {
    key: "codex",
    title: t("settings.mcpConnectCodex"),
    desc: t("settings.mcpConnectCodexDesc"),
    code: `[mcp_servers.kabegame]\nurl = "${endpoint.value}"`,
  },
  {
    key: "claude-desktop",
    title: t("settings.mcpConnectClaudeDesktop"),
    desc: t("settings.mcpConnectClaudeDesktopDesc"),
    code: `KABEGAME_MCP_ENDPOINT=${endpoint.value}`,
  },
]);

void loadCaps();
</script>
