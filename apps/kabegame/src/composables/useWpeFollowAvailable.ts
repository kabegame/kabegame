import { readonly, ref, type Ref } from "vue";
import { invoke } from "@/api";
import { IS_ANDROID, IS_WEB } from "@/env";
import { kbEvent$ } from "@/services/kbEvents/eventSource";

/**
 * 「跟随 WPE」这一档能不能用：后端 `get_wpe_follow_available`（只有 Windows、且 WPE 安装目录里有 `config.json`）。
 * 全应用一份，第一次用到时读，之后 WPE 安装目录（`wpeEngineDir`）变了再读。Android / Web 没有这条命令，恒为 false。
 */
const available = ref(false);
let started = false;

function refresh() {
  void invoke<boolean>("get_wpe_follow_available").then(
    (value) => {
      available.value = value === true;
    },
    () => {
      available.value = false;
    },
  );
}

export function useWpeFollowAvailable(): Readonly<Ref<boolean>> {
  if (!started && !IS_ANDROID && !IS_WEB) {
    started = true;
    refresh();
    kbEvent$<{ changes?: Record<string, unknown> }>("setting-change").subscribe((event) => {
      if (Object.prototype.hasOwnProperty.call(event.payload.changes ?? event.payload, "wpeEngineDir")) refresh();
    });
  }
  return readonly(available);
}
