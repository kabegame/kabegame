/**
 * 收集面板与宿主对话框之间的约定。
 *
 * 面板只画正文，经 defineExpose 交出这几项；宿主（`CollectLocalDialog` / `CollectNetworkDialog`）
 * 画顶部的来源分段与底部按钮，主按钮的可用态、转圈与左侧提示都读当前面板。
 * 面板提交成功后 emit `done`，由宿主关闭对话框。面板每次打开都重新挂载，挂载即「打开」。
 */
export interface CollectPanelApi {
  submit: () => unknown;
  canSubmit: boolean;
  submitting: boolean;
  /** 底部左侧的说明（如「将导入 N 张」），没有时不显示 */
  hint?: string;
}
