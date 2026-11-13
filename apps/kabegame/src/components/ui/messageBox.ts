/**
 * 确认框门面（取代直接调 ElMessageBox）：签名与 ElMessageBox 完全相同，调用处只换导入。
 *   await messageBox.confirm(text, title, { type: "warning", confirmButtonText, cancelButtonText })
 *   messageBox.alert / messageBox.prompt / messageBox.close
 *
 * TODO:[REF_UI] P9 内部换成 Reka AlertDialog（签名不变，调用处不动），届时删掉 withForeignFocus 与 EP 导入。
 * 现在仍用 ElMessageBox：确认框是模态层，EP 对话框还很多时换成 Reka 会让两套焦点陷阱互相抢。
 * 从新对话框（Reka）里弹出时，withForeignFocus 让新对话框的焦点陷阱在确认框存在期间暂停。
 */
import { ElMessageBox } from "@kabegame/element-plus";
import { withForeignFocus } from "./compat";

type MessageBoxApi = Pick<typeof ElMessageBox, "confirm" | "alert" | "prompt" | "close">;
type AnyBox = (...args: unknown[]) => Promise<unknown>;

/** 包一层：参数原样转给 EP（它有好几个重载，按「任意参数」转发，类型由 MessageBoxApi 对外保证） */
const wrap = <K extends "confirm" | "alert" | "prompt">(kind: K) =>
  ((...args: unknown[]) => withForeignFocus(() => (ElMessageBox[kind] as AnyBox)(...args))) as MessageBoxApi[K];

export const messageBox: MessageBoxApi = {
  confirm: wrap("confirm"),
  alert: wrap("alert"),
  prompt: wrap("prompt"),
  close: () => ElMessageBox.close(),
};
