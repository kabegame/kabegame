import { invoke } from '@tauri-apps/api/core'

/** 选文件夹结果：Android 有 uri（及可选 path），桌面为 path */
export interface PickFolderResult {
  uri?: string
  path?: string
}

/**
 * 打开系统文件夹选择器。
 * - Android: SAF 选目录，返回 { uri, path? }
 * - 桌面: 原生目录对话框，返回 { path }
 */
export async function pickFolder(): Promise<PickFolderResult | null> {
  const result = await invoke<PickFolderResult>('plugin:picker|pickFolder')
  if (result?.uri ?? result?.path) return result
  return null
}

/**
 * 打开系统图片选择器（多选）。
 * 仅 Android：使用 PickMultipleVisualMedia，返回 content:// URI 列表。
 */
export async function pickImages(): Promise<string[] | null> {
  const result = await invoke<{ uris: string[] }>('plugin:picker|pickImages')
  return result?.uris?.length ? result.uris : null
}

/**
 * 打开文件选择器选择 .kgpg 插件文件。
 * 仅 Android：将 content:// URI 复制到应用私有目录后返回可读路径。
 */
export async function pickKgpgFile(): Promise<string | null> {
  const result = await invoke<{ path: string }>('plugin:picker|pickKgpgFile')
  return result?.path ?? null
}
