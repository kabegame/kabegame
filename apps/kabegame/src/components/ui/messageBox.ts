/**
 * 确认框门面（取代 ElMessageBox，界面重构 P9 起是自己的实现，渲染在 MessageBoxHost.vue，App.vue 挂一份）。
 * 调用方式沿用 ElMessageBox：
 *   await messageBox.confirm(text, title, { confirmButtonText, cancelButtonText, distinguishCancelAndClose })
 *   const { value } = await messageBox.prompt(text, title, { inputValue, inputValidator })
 *   await messageBox.alert(text, title)；messageBox.close()
 *
 * 结果约定（同 ElMessageBox）：
 * - confirm：点确定 resolve `"confirm"`；点取消 reject `"cancel"`；Esc / 返回键 / ×（以及 close()）reject
 *   `"close"`，没开 distinguishCancelAndClose 时也报 `"cancel"`。
 * - prompt：点确定 resolve `{ value, action: "confirm" }`，其余同 confirm；inputValidator 返回 true 才放行，
 *   返回字符串就显示成错误、留在框里。
 * - alert：只有一个按钮，怎么关都 resolve `"confirm"`（不会抛，调用方不必 catch）。
 *
 * 同时只显示一个，后来的排队。`type` / `center` / `customClass` 照收不报错，但不改变外观（中性风格不分类型配图标）。
 */
import { shallowReactive } from "vue";

export type MessageBoxAction = "confirm" | "cancel" | "close";
export type MessageBoxKind = "confirm" | "alert" | "prompt";

export interface MessageBoxOptions {
  confirmButtonText?: string;
  cancelButtonText?: string;
  /** confirm / prompt 是否显示取消按钮，默认显示 */
  showCancelButton?: boolean;
  /** Esc / 返回键 / × 报 "close" 而不是 "cancel" */
  distinguishCancelAndClose?: boolean;
  /** 正文按 HTML 渲染（经 DOMPurify 清洗）；调用方仍要自己转义插进去的用户数据 */
  dangerouslyUseHTMLString?: boolean;
  /** 确定按钮用危险色 */
  danger?: boolean;
  inputValue?: string;
  inputPlaceholder?: string;
  /** 返回 true 放行；返回字符串作为错误文字；返回 false 显示 inputErrorMessage */
  inputValidator?: (value: string) => boolean | string;
  inputErrorMessage?: string;
  // 以下兼容 ElMessageBox 的调用，不改变外观
  type?: "success" | "info" | "warning" | "error" | "";
  center?: boolean;
  customClass?: string;
}

export interface MessageBoxPromptResult {
  value: string;
  action: "confirm";
}

export interface MessageBoxRequest {
  id: number;
  kind: MessageBoxKind;
  message: string;
  title: string;
  options: MessageBoxOptions;
  settle: (action: MessageBoxAction, value?: string) => void;
}

/** 排队中的请求，第一个是正在显示的那个 */
export const messageBoxQueue = shallowReactive<MessageBoxRequest[]>([]);

let seq = 0;

function textOf(message: unknown): string {
  if (message == null) return "";
  return typeof message === "string" ? message : String(message);
}

function open(kind: MessageBoxKind, message: unknown, title: unknown, options: MessageBoxOptions = {}) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++seq;
    const request: MessageBoxRequest = {
      id,
      kind,
      message: textOf(message),
      title: textOf(title),
      options,
      settle(action, value) {
        const index = messageBoxQueue.findIndex((r) => r.id === id);
        if (index === -1) return; // 已经结束过
        messageBoxQueue.splice(index, 1);
        if (kind === "alert") resolve("confirm");
        else if (action === "confirm") resolve(kind === "prompt" ? { value: value ?? "", action } : action);
        else reject(action === "close" && !options.distinguishCancelAndClose ? "cancel" : action);
      },
    };
    messageBoxQueue.push(request);
  });
}

type Args = [message: unknown, title?: unknown, options?: MessageBoxOptions];

/** 第二个参数可以直接给选项（同 ElMessageBox 的重载） */
function normalize([message, title, options]: Args): [unknown, unknown, MessageBoxOptions | undefined] {
  if (title && typeof title === "object") return [message, "", title as MessageBoxOptions];
  return [message, title, options];
}

export const messageBox = {
  confirm(...args: Args): Promise<MessageBoxAction> {
    const [m, t, o] = normalize(args);
    return open("confirm", m, t, o) as Promise<MessageBoxAction>;
  },
  alert(...args: Args): Promise<MessageBoxAction> {
    const [m, t, o] = normalize(args);
    return open("alert", m, t, o) as Promise<MessageBoxAction>;
  },
  prompt(...args: Args): Promise<MessageBoxPromptResult> {
    const [m, t, o] = normalize(args);
    return open("prompt", m, t, o) as Promise<MessageBoxPromptResult>;
  },
  /** 关掉正在显示与排队中的全部确认框（按 Esc 处理） */
  close(): void {
    for (const request of [...messageBoxQueue]) request.settle("close");
  },
};
