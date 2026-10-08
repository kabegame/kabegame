<template>
  <div class="mcp-panel">
    <div
      v-if="!enabled"
      class="rounded-xl border border-[color-mix(in_srgb,var(--anime-warning,#e6a23c)_35%,transparent)] bg-[color-mix(in_srgb,var(--anime-warning,#e6a23c)_8%,transparent)] px-4 py-3 text-[12px] text-[var(--anime-text-muted)]"
    >
      {{ $t("settings.mcpRequiresWebServer") }}
    </div>

    <!-- ── 能力矩阵 ── -->
    <section class="mcp-block">
      <header class="mcp-block__head">
        <div class="mcp-block__titles">
          <h3 class="mcp-block__title">{{ $t("settings.mcpCapabilities") }}</h3>
          <p class="mcp-block__desc">{{ $t("settings.mcpCapabilitiesDesc") }}</p>
        </div>
        <div class="mcp-block__actions">
          <button type="button" class="mcp-ghost-btn" @click="setAll(true)">
            {{ $t("settings.mcpSelectAll") }}
          </button>
          <button type="button" class="mcp-ghost-btn" @click="setAll(false)">
            {{ $t("settings.mcpClearAll") }}
          </button>
        </div>
      </header>

      <div v-loading="capsLoading" class="mcp-matrix">
        <article v-for="cat in groupedCapabilities" :key="cat.category" class="mcp-cat">
          <div class="mcp-cat__head">
            <el-checkbox
              class="mcp-cat__check"
              :model-value="cat.checked"
              :indeterminate="cat.indeterminate"
              @change="(v) => setCaps(cat.allIds, v === true)"
            >
              <span class="mcp-cat__name">{{ t(`mcp.category.${cat.category}`) }}</span>
            </el-checkbox>
            <span class="mcp-cat__count">{{ cat.enabledCount }}/{{ cat.total }}</span>
          </div>
          <div v-for="grp in cat.kinds" :key="grp.kind" class="mcp-kind">
            <el-checkbox
              class="mcp-kind__check"
              :model-value="grp.checked"
              :indeterminate="grp.indeterminate"
              @change="(v) => setCaps(grp.ids, v === true)"
            >
              <span class="mcp-kind__tag" :class="`is-${grp.kind}`">
                {{ t(`mcp.kind.${grp.kind}`) }}
              </span>
            </el-checkbox>
            <ul class="mcp-caplist">
              <li
                v-for="cap in grp.caps"
                :key="cap.id"
                class="mcp-cap"
                :class="{ 'is-on': !disabledSet.has(cap.id) }"
                @click="setCaps([cap.id], disabledSet.has(cap.id))"
              >
                <el-checkbox
                  :model-value="!disabledSet.has(cap.id)"
                  @click.stop
                  @change="(v) => setCaps([cap.id], v === true)"
                />
                <div class="mcp-cap__text">
                  <span class="mcp-cap__name">{{ t(`mcp.cap.${cap.id}.name`) }}</span>
                  <span class="mcp-cap__desc">{{ t(`mcp.cap.${cap.id}.desc`) }}</span>
                </div>
              </li>
            </ul>
          </div>
        </article>
      </div>
    </section>

    <!-- ── 连接命令 ── -->
    <section class="mcp-block">
      <header class="mcp-block__head">
        <div class="mcp-block__titles">
          <h3 class="mcp-block__title">{{ $t("settings.mcpConnectTitle") }}</h3>
          <p class="mcp-block__desc">{{ $t("settings.mcpConnectDesc") }}</p>
        </div>
      </header>
      <div class="mcp-connect">
        <div v-for="cmd in connectCommands" :key="cmd.key" class="mcp-connect__card">
          <div class="mcp-connect__head">
            <span class="mcp-connect__name">{{ cmd.title }}</span>
            <span class="mcp-connect__hint">{{ cmd.desc }}</span>
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
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import CodeBlock from "@/components/common/CodeBlock.vue";

interface McpCapability {
  id: string;
  category: string;
  kind: "read" | "write";
  tool: string | null;
  name_key: string;
  desc_key: string;
}

const { t } = useI18n();

const { settingValue: enabledValue } = useSettingKeyState("webServerEnabled");
const { settingValue: portValue } = useSettingKeyState("webServerPort");
const { settingValue: disabledValue, set: setDisabledValue } = useSettingKeyState("mcpDisabledCapabilities");

const enabled = computed(() => enabledValue.value === true);
const port = computed(() => (typeof portValue.value === "number" ? portValue.value : 7490));
const disabledSet = computed(() => new Set(disabledValue.value ?? []));

const endpoint = computed(() => `http://127.0.0.1:${port.value}/mcp`);

// ── 能力矩阵（capabilities 是后端元数据；启用/禁用是 mcpDisabledCapabilities 设置）──
const CATEGORY_ORDER = ["images", "albums", "tasks", "surf_records", "plugin"];
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
    ElMessage.error(t("settings.mcpCapabilitiesLoadFailed"));
  } finally {
    capsLoading.value = false;
  }
}

async function applyDisabled(list: string[]) {
  try {
    await setDisabledValue(list);
  } catch (e) {
    console.warn("[mcp] set disabled capabilities failed:", e);
    ElMessage.error(t("settings.mcpCapabilitiesSaveFailed"));
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

<style scoped lang="scss">
.mcp-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}

/* ── 区块通用 ── */
.mcp-block {
  border-radius: 16px;
  padding: 18px 20px;
  border: 1px solid var(--anime-border, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--anime-bg-card, #1c1c28) 70%, transparent);
}
.mcp-block__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.mcp-block__title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--anime-text-primary);
}
.mcp-block__desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--anime-text-muted);
}
.mcp-block__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.mcp-ghost-btn {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--anime-primary) 26%, transparent);
  background: transparent;
  color: var(--anime-primary);
  cursor: pointer;
  transition: all 0.2s;
}
.mcp-ghost-btn:hover {
  background: color-mix(in srgb, var(--anime-primary) 12%, transparent);
}

/* ── 能力矩阵 ── */
.mcp-matrix {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.mcp-cat {
  border-radius: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--anime-primary) 16%, transparent);
  background:
    radial-gradient(130% 100% at 0% 0%, color-mix(in srgb, var(--anime-primary) 10%, transparent) 0%, transparent 60%),
    color-mix(in srgb, var(--anime-bg-card, #1c1c28) 50%, transparent);
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.mcp-cat:hover {
  border-color: color-mix(in srgb, var(--anime-primary) 32%, transparent);
  box-shadow: 0 0 18px -10px color-mix(in srgb, var(--anime-primary) 45%, transparent);
}
.mcp-cat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--anime-border, rgba(255, 255, 255, 0.1));
}
.mcp-cat__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--anime-text-primary);
}
.mcp-cat__count {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--anime-text-muted);
}
.mcp-kind {
  margin-top: 6px;
}
.mcp-cat__check,
.mcp-kind__check {
  margin-right: 0;
  height: auto;
}
.mcp-cat__check :deep(.el-checkbox__label),
.mcp-kind__check :deep(.el-checkbox__label) {
  padding-left: 8px;
}
.mcp-kind__check {
  margin: 4px 0;
}
.mcp-kind__tag {
  display: inline-block;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 6px;
  margin: 0;
}
.mcp-kind__tag.is-read {
  color: #22d3ee;
  background: color-mix(in srgb, #22d3ee 14%, transparent);
}
.mcp-kind__tag.is-write {
  color: #f0abfc;
  background: color-mix(in srgb, #d946ef 16%, transparent);
}
.mcp-caplist {
  list-style: none;
  margin: 0;
  padding: 0;
}
.mcp-cap {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.mcp-cap:hover {
  background: color-mix(in srgb, var(--anime-primary) 8%, transparent);
}
.mcp-cap.is-on {
  background: color-mix(in srgb, var(--anime-primary) 6%, transparent);
}
.mcp-cap :deep(.el-checkbox) {
  height: auto;
  margin-top: 2px;
}
.mcp-cap__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.mcp-cap__name {
  font-size: 13px;
  line-height: 1.4;
  color: var(--anime-text-primary);
}
.mcp-cap__desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--anime-text-muted);
  word-break: break-word;
}

/* ── 连接命令 ── */
.mcp-connect {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px;
}
.mcp-connect__card {
  border-radius: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--anime-primary) 16%, transparent);
  background:
    radial-gradient(130% 100% at 0% 0%, color-mix(in srgb, var(--anime-primary) 10%, transparent) 0%, transparent 60%),
    color-mix(in srgb, var(--anime-bg-card, #1c1c28) 50%, transparent);
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.mcp-connect__card:hover {
  border-color: color-mix(in srgb, var(--anime-primary) 32%, transparent);
  box-shadow: 0 0 18px -10px color-mix(in srgb, var(--anime-primary) 45%, transparent);
}
.mcp-connect__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}
.mcp-connect__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--anime-text-primary);
}
.mcp-connect__hint {
  font-size: 11px;
  color: var(--anime-text-muted);
}
</style>
