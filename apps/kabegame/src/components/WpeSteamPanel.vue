<template>
  <div class="flex flex-col gap-3">
    <p class="m-0 text-[12.5px] leading-[1.6] text-kb-fg-muted">{{ $t("gallery.wpeSteamDesc") }}</p>

    <template v-if="!status">
      <Skeleton class="h-3.5 w-1/3" />
      <Skeleton class="h-[148px] w-full" />
    </template>

    <!-- 设置里已有别的 WPE 目录：不需要下载，只给说明 -->
    <Alert v-else-if="hasOtherEngine" :tone="status.engineValid ? 'info' : 'warning'">
      <div>{{ status.engineValid ? $t("gallery.wpeSteamExisting") : $t("gallery.wpeSteamExistingInvalid") }}</div>
      <div class="mt-1 break-all text-[12px] text-kb-fg-subtle">{{ status.engineDir }}</div>
    </Alert>

    <template v-else>
      <div class="flex flex-wrap gap-1.5">
        <span :class="[CHIP_CLASS, status.managedInstall ? CHIP_PLAIN : CHIP_MUTED]">
          {{
            status.managedInstall
              ? $t("gallery.wpeSteamInstalled", { build: status.managedInstall.buildId })
              : $t("gallery.wpeSteamNotInstalled")
          }}
        </span>
      </div>

      <!-- 已就绪 -->
      <div v-if="readyAccount" :class="BOX_CLASS" class="flex items-center gap-2 text-[13px] text-kb-fg">
        <CircleCheck class="size-4 shrink-0 text-kb-accent" />
        <span>{{ $t("gallery.wpeSteamLoggedIn", { account: readyAccount }) }}</span>
        <Button variant="ghost" size="sm" class="ml-auto" @click="startLoginMode">
          {{ $t("gallery.wpeSteamSwitchAccount") }}
        </Button>
      </div>

      <!-- 有未过期的已存登录：先问要不要复用 -->
      <div v-else-if="mode === 'reuse' && reusable" :class="BOX_CLASS" class="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" :disabled="verifying" @click="reuseSession">
          <Spinner v-if="verifying" :size="14" />
          {{ $t("gallery.wpeSteamContinueAs", { account: reusable.account }) }}
        </Button>
        <span class="text-[12px] text-kb-fg-subtle">
          {{
            verifying
              ? $t("gallery.wpeSteamVerifying")
              : $t("gallery.wpeSteamValidUntil", { date: formatDate(reusable.expiresAt) })
          }}
        </span>
        <Button variant="ghost" size="sm" class="ml-auto" :disabled="verifying" @click="startLoginMode">
          {{ $t("gallery.wpeSteamSwitchAccount") }}
        </Button>
      </div>

      <!-- 登录 -->
      <div v-else :class="BOX_CLASS" class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <SegmentedControl v-model="tab" :options="tabOptions" size="sm" class="max-w-[280px] flex-1" />
          <Button v-if="backAccount" variant="ghost" size="sm" class="ml-auto" @click="backToPrevious">
            <ArrowLeft />
            {{ $t("gallery.wpeSteamBackTo", { account: backAccount }) }}
          </Button>
        </div>

        <!-- 扫码 -->
        <div v-if="tab === 'qr'" class="flex flex-col items-center gap-2.5 text-center">
          <div
            class="grid size-[168px] shrink-0 place-items-center overflow-hidden rounded-kb-md border border-solid border-kb-line bg-white"
          >
            <img v-if="qrUrl" :src="qrUrl" alt="" class="size-full object-contain" />
            <Spinner v-else :size="18" />
          </div>
          <div class="flex flex-col items-center gap-2 text-[12.5px] leading-[1.6] text-kb-fg-muted">
            <span>{{ scanned ? $t("gallery.wpeSteamQrScanned") : $t("gallery.wpeSteamQrHint") }}</span>
            <Button v-if="loginError" variant="ghost" size="sm" @click="startQr">
              <RefreshCw />
              {{ $t("gallery.wpeSteamQrRetry") }}
            </Button>
          </div>
        </div>

        <!-- 账号密码 -->
        <div v-else class="mx-auto flex w-full max-w-[360px] flex-col items-center gap-2 text-center">
          <template v-if="!login">
            <Input
              v-model="account"
              size="sm"
              class="w-full"
              :placeholder="$t('gallery.wpeSteamAccount')"
              autocomplete="username"
              @keydown.enter="submitPassword"
            />
            <Input
              v-model="password"
              size="sm"
              class="w-full"
              type="password"
              :placeholder="$t('gallery.wpeSteamPassword')"
              autocomplete="current-password"
              @keydown.enter="submitPassword"
            />
            <div class="mt-0.5 flex flex-col items-center gap-1.5">
              <Button
                variant="primary"
                size="sm"
                class="min-w-[120px]"
                :disabled="busy || !account.trim() || !password"
                @click="submitPassword"
              >
                <Spinner v-if="busy" :size="14" />
                {{ $t("gallery.wpeSteamLogin") }}
              </Button>
              <span class="text-[12px] text-kb-fg-subtle">{{ $t("gallery.wpeSteamPasswordNote") }}</span>
            </div>
          </template>
          <template v-else>
            <!-- 能在手机上点确认 / 点邮件链接时只提示这一步（后台照常轮询，确认后自动变成已登录），验证码收进链接里 -->
            <span v-if="canConfirmOnPhone" class="text-[12.5px] text-kb-fg-muted">
              {{ $t("gallery.wpeSteamConfirmOnPhone") }}
            </span>
            <span v-else-if="canConfirmByEmailLink" class="text-[12.5px] text-kb-fg-muted">
              {{ $t("gallery.wpeSteamConfirmEmailLink") }}
            </span>
            <Button v-if="codeKind && !showCodeInput" variant="ghost" size="sm" @click="useCode = true">
              {{ codeKind === "emailCode" ? $t("gallery.wpeSteamUseEmailCode") : $t("gallery.wpeSteamUseDeviceCode") }}
            </Button>
            <template v-if="showCodeInput">
              <span v-if="codeKind === 'emailCode' && login.emailHint" class="text-[12px] text-kb-fg-subtle">
                {{ $t("gallery.wpeSteamEmailCodeHint", { hint: login.emailHint }) }}
              </span>
              <div class="flex items-center justify-center gap-2">
                <Input
                  v-model="code"
                  size="sm"
                  class="max-w-[180px]"
                  :placeholder="
                    codeKind === 'emailCode' ? $t('gallery.wpeSteamEmailCode') : $t('gallery.wpeSteamDeviceCode')
                  "
                  autocomplete="one-time-code"
                  @keydown.enter="submitCode"
                />
                <Button variant="primary" size="sm" :disabled="busy || !code.trim()" @click="submitCode">
                  <Spinner v-if="busy" :size="14" />
                  {{ $t("gallery.wpeSteamSubmitCode") }}
                </Button>
              </div>
            </template>
            <Button variant="ghost" size="sm" @click="resetPasswordLogin">
              {{ $t("gallery.wpeSteamSwitchAccount") }}
            </Button>
          </template>
        </div>

        <Alert v-if="loginError" tone="danger">{{ loginError }}</Alert>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 壁纸导入对话框「从 Steam」来源的面板：登录 Steam，准备好拉取 Wallpaper Engine 的账号。
 *
 * 只在选中「从 Steam」时挂载：挂载即读状态，有未过期的登录就先问要不要复用，否则直接进登录（缺省扫码）；
 * 卸载时放弃进行中的登录。登录分步完成（扫码 / 账号密码 + Steam Guard），每一步一次后端调用；token 由后端
 * 存进插件数据的私有区，这里只拿到账号名。已登录的账号由对话框持有（`v-model:account`），来回切换来源不丢。
 * 设置里已有别的 WPE 目录时不下载，只显示说明，并经 `v-model:blocked` 告诉对话框不能提交。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowLeft, CircleCheck, RefreshCw } from "@lucide/vue";
import { Alert, Button, Input, SegmentedControl, Skeleton, Spinner } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import { invoke } from "@/api";

interface SteamSession {
  account: string;
  steamId: string;
  /** refresh token 的过期时间（Unix 秒） */
  expiresAt: number;
}

interface SteamStatus {
  engineDir: string | null;
  engineValid: boolean;
  engineIsManaged: boolean;
  managedEngineDir: string | null;
  managedInstall: { buildId: string; updatedAt: number; files: number } | null;
  sessions: SteamSession[];
}

interface LoginStart {
  loginId: string;
  qrDataUrl: string | null;
  /** deviceConfirmation / deviceCode / emailCode / emailConfirmation / none */
  confirmations: string[];
  emailHint: string | null;
  pollIntervalMs: number;
}

type LoginPoll =
  { status: "pending"; scanned: boolean; qrDataUrl: string | null } | { status: "done"; session: SteamSession };

const readyAccount = defineModel<string | null>("account", { default: null });
/** 设置里已有别的 WPE 目录：不下载、不能提交 */
const blocked = defineModel<boolean>("blocked", { default: false });

const { t, locale } = useI18n();

const BOX_CLASS = "box-border rounded-kb-lg border border-solid border-kb-line-strong bg-kb-surface-raised px-3 py-2.5";
const CHIP_CLASS = "rounded-full px-2 text-[11px] leading-[18px]";
const CHIP_PLAIN = "bg-kb-fill text-kb-fg-muted";
const CHIP_MUTED = "bg-kb-fill-light text-kb-fg-subtle";

const status = ref<SteamStatus | null>(null);
/** 设置里有 WPE 目录、且不是 Kabegame 管理的那份：不下载 */
const hasOtherEngine = computed(() => !!status.value?.engineDir && !status.value.engineIsManaged);
const reusable = computed(() => status.value?.sessions[0] ?? null);

const mode = ref<"reuse" | "login">("reuse");
const tab = ref<"qr" | "password">("qr");
const tabOptions = computed(() => [
  { label: t("gallery.wpeSteamTabQr"), value: "qr" as const },
  { label: t("gallery.wpeSteamTabPassword"), value: "password" as const },
]);

const verifying = ref(false);
const busy = ref(false);
const login = ref<LoginStart | null>(null);
const qrUrl = ref<string | null>(null);
const scanned = ref(false);
const loginError = ref<string | null>(null);
const account = ref("");
const password = ref("");
const code = ref("");
/**
 * 用户要做什么完全看 Steam 返回的 `confirmations`（按账号的 Steam Guard 设置给）：
 * 能在手机上点确认（deviceConfirmation）或点邮件链接（emailConfirmation）时只提示这一步，
 * 后台照常轮询、确认后自动变成已登录；验证码（deviceCode / emailCode）是备选，点「改用…验证码」才出输入框。
 * 只有验证码这一种方式时直接显示输入框。
 */
const codeKind = computed<"emailCode" | "deviceCode" | null>(() => {
  const confirmations = login.value?.confirmations ?? [];
  if (confirmations.includes("deviceCode")) return "deviceCode";
  if (confirmations.includes("emailCode")) return "emailCode";
  return null;
});
const canConfirmOnPhone = computed(() => !!login.value?.confirmations.includes("deviceConfirmation"));
const canConfirmByEmailLink = computed(() => !!login.value?.confirmations.includes("emailConfirmation"));
const useCode = ref(false);
const showCodeInput = computed(
  () => !!codeKind.value && (useCode.value || (!canConfirmOnPhone.value && !canConfirmByEmailLink.value)),
);

let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** 每次开始新的登录 +1；旧登录的轮询回来时作废 */
let loginSeq = 0;
let unmounted = false;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 按应用语言显示日期（i18n 的 `zhtw` → BCP 47 的 `zh-TW`），不跟 CEF 的系统区域。 */
function formatDate(seconds: number): string {
  const lang = String(locale.value);
  return new Date(seconds * 1000).toLocaleDateString(lang === "zhtw" ? "zh-TW" : lang);
}

async function loadStatus() {
  try {
    status.value = await invoke<SteamStatus>("wpe_steam_status");
  } catch (error) {
    console.error("[WPE Steam] 读取状态失败:", error);
    status.value = {
      engineDir: null,
      engineValid: false,
      engineIsManaged: false,
      managedEngineDir: null,
      managedInstall: null,
      sessions: [],
    };
  }
  blocked.value = hasOtherEngine.value;
}

function stopLogin() {
  loginSeq++;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  const current = login.value;
  login.value = null;
  qrUrl.value = null;
  scanned.value = false;
  code.value = "";
  useCode.value = false;
  if (current) void invoke("wpe_steam_login_cancel", { loginId: current.loginId }).catch(() => {});
}

function schedulePoll(seq: number, delay: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void pollOnce(seq), delay);
}

async function pollOnce(seq: number) {
  const current = login.value;
  if (!current || seq !== loginSeq) return;
  try {
    const result = await invoke<LoginPoll>("wpe_steam_login_poll", { loginId: current.loginId });
    if (seq !== loginSeq) return;
    if (result.status === "done") {
      login.value = null;
      readyAccount.value = result.session.account;
      previousReady.value = null;
      loginError.value = null;
      void loadStatus();
      return;
    }
    scanned.value = result.scanned;
    if (result.qrDataUrl) qrUrl.value = result.qrDataUrl;
    schedulePoll(seq, current.pollIntervalMs);
  } catch (error) {
    if (seq !== loginSeq) return;
    loginError.value = errorText(error);
  }
}

async function startQr() {
  stopLogin();
  loginError.value = null;
  const seq = loginSeq;
  try {
    const start = await invoke<LoginStart>("wpe_steam_login_qr");
    if (seq !== loginSeq) {
      void invoke("wpe_steam_login_cancel", { loginId: start.loginId }).catch(() => {});
      return;
    }
    login.value = start;
    qrUrl.value = start.qrDataUrl;
    schedulePoll(seq, start.pollIntervalMs);
  } catch (error) {
    if (seq === loginSeq) loginError.value = errorText(error);
  }
}

async function submitPassword() {
  if (busy.value || !account.value.trim() || !password.value) return;
  stopLogin();
  loginError.value = null;
  busy.value = true;
  const seq = loginSeq;
  try {
    const start = await invoke<LoginStart>("wpe_steam_login_credentials", {
      account: account.value.trim(),
      password: password.value,
    });
    if (seq !== loginSeq) {
      void invoke("wpe_steam_login_cancel", { loginId: start.loginId }).catch(() => {});
      return;
    }
    login.value = start;
    // 手机确认与「不需要确认」都靠轮询拿结果；要验证码时也照常轮询，提交后自然转成功
    schedulePoll(seq, start.pollIntervalMs);
  } catch (error) {
    if (seq === loginSeq) loginError.value = errorText(error);
  } finally {
    password.value = "";
    busy.value = false;
  }
}

async function submitCode() {
  const current = login.value;
  if (!current || !codeKind.value || busy.value || !code.value.trim()) return;
  busy.value = true;
  loginError.value = null;
  try {
    await invoke("wpe_steam_login_submit_code", {
      loginId: current.loginId,
      code: code.value.trim(),
      kind: codeKind.value,
    });
    schedulePoll(loginSeq, 200);
  } catch (error) {
    loginError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}

function resetPasswordLogin() {
  stopLogin();
  loginError.value = null;
}

async function reuseSession() {
  const session = reusable.value;
  if (!session || verifying.value) return;
  verifying.value = true;
  try {
    await invoke("wpe_steam_verify_session", { account: session.account });
    if (!unmounted) readyAccount.value = session.account;
  } catch (error) {
    kameMessage.warning(`${t("gallery.wpeSteamSessionInvalid")}：${errorText(error)}`);
    await loadStatus();
    if (!unmounted) startLoginMode();
  } finally {
    verifying.value = false;
  }
}

/** 点「换个账号」之前已登录（验证过）的账号；返回时直接恢复，不用再验证 */
const previousReady = ref<string | null>(null);
/** 登录表单里「返回使用 <账号>」的目标：之前已登录的账号，否则是未过期的已存登录 */
const backAccount = computed(() => previousReady.value ?? reusable.value?.account ?? null);

/** 换个账号 / 复用失败：清掉已就绪的账号，进登录 */
function startLoginMode() {
  previousReady.value = readyAccount.value;
  readyAccount.value = null;
  mode.value = "login";
  loginError.value = null;
  if (tab.value === "qr") void startQr();
}

/** 登录成功之前反悔：放弃进行中的登录，回到原来的账号（验证过的直接恢复，否则回到「以 … 继续」） */
function backToPrevious() {
  stopLogin();
  loginError.value = null;
  if (previousReady.value) {
    readyAccount.value = previousReady.value;
    previousReady.value = null;
  } else {
    mode.value = "reuse";
  }
}

watch(tab, (next) => {
  stopLogin();
  loginError.value = null;
  if (mode.value === "login" && !readyAccount.value && next === "qr") void startQr();
});

onMounted(async () => {
  await loadStatus();
  if (unmounted || readyAccount.value || hasOtherEngine.value) return;
  mode.value = reusable.value ? "reuse" : "login";
  if (mode.value === "login" && tab.value === "qr") void startQr();
});

onBeforeUnmount(() => {
  unmounted = true;
  stopLogin();
});
</script>
