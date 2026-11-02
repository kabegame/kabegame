/**
 * WPE 网页壁纸与场景宿主的 `file:` iframe 共用的 sandbox：
 * - `allow-same-origin` 必须有，否则页面变成 opaque origin，`localStorage` 抛错、`fetch(file:)` 与 Tauri IPC 都不可用；
 * - 不给 top-navigation / popups / modals / downloads：壁纸页面不需要导航父窗口、弹窗或下载，
 *   `alert` 在壁纸里也不该出现。
 */
export const WEB_SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock allow-forms";
