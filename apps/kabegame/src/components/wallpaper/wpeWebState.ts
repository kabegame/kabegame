/**
 * 网页壁纸（`x-wpe/web`）与场景宿主的属性：父页面 → 垫片的 `postMessage` 协议与增量计算（2026-11-21 起由父页面推送，
 * `.claude/plans/wpe-import/2-web/phase-9-parent-delivery.md`）。父页面一侧是 `useWpeStateDelivery`（`WpeWallpaperContent`、
 * `WpeSceneView` 用），垫片 `src-tauri/kabegame/src/webview_js/wpe_shim.js` 是不经打包的纯脚本，按同样的字面量另写一份；
 * `wpeWebVolume.test.ts` 读垫片源码跑一遍，两边不一致就失败。
 *
 * 照 WPE（宿主推送，`2-web/API.md` §4.8；`kbweb-reload` 实测）：
 * - 父页面新建的 iframe 第一次真实文档加载之后推**整份**；
 * - 之后的变化只推**增量**：用户属性只含值变了的键（页面没有整份替换的接口，作者删掉的键不推），通用属性有变化就整份；
 * - 页面自己导航（reload、改地址、前进后退）出来的文档**不重推**，只发一条不带属性的「就绪」增量（垫片据此补调
 *   `setPaused(true)`、拿到目录列表回答随机文件请求，页面的属性回调一个都不触发）。
 *
 * 垫片只认 `isTrusted` 且来自父窗口的消息；把属性交给页面时顶层键按名字排序（WPE 的 jsoncpp 用 std::map）。
 */

/** 父页面 → 垫片：属性（整份、增量或就绪）。 */
export const WPE_STATE_MESSAGE = "kabegame:wpe-state";

/** 一条用户属性：`{ type, value }`；没写 `type` 的工程属性只有 `value`；场景的快捷方式另带 `isbound` / `commandtype` / `file`。 */
export interface WpeUserProperty {
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** 通用属性（`applyGeneralProperties`）：WPE 语言码与解析后的帧率。 */
export interface WpeWebGeneral {
  language: string;
  fps: number;
  [key: string]: unknown;
}

/** 一个 `directory` 属性：`fetchall`（缺省）按增删回调，`ondemand` 只供随机取文件。 */
export interface WpeWebDirectory {
  mode: string;
  files: string[];
}

/** 后端 `wpe_web_get_state` 的返回。 */
export interface WpeWebState {
  imageId: string;
  user: Record<string, WpeUserProperty>;
  general: WpeWebGeneral;
  directories: Record<string, WpeWebDirectory>;
}

export interface WpeDirectoryChange {
  added: string[];
  removed: string[];
}

export type WpeStateMessage =
  | { type: typeof WPE_STATE_MESSAGE; full: true; state: WpeWebState }
  | {
      type: typeof WPE_STATE_MESSAGE;
      full: false;
      /** 值变了的键；没有变化为 null */
      user: Record<string, WpeUserProperty> | null;
      /** 有变化时整份；没有变化为 null */
      general: WpeWebGeneral | null;
      /** 最新整份：垫片回答 `wallpaperRequestRandomFileForProperty` 用 */
      directories: Record<string, WpeWebDirectory>;
      /** `fetchall` 目录的文件增删（垫片调 `userDirectoryFilesRemoved` / `userDirectoryFilesAddedOrChanged`） */
      directoryChanges: Record<string, WpeDirectoryChange>;
    };

export function fullStateMessage(state: WpeWebState): WpeStateMessage {
  return { type: WPE_STATE_MESSAGE, full: true, state };
}

/** 页面自己导航出来的文档：不带任何属性，只告诉垫片已就绪（见文件头）。 */
export function readyStateMessage(directories: Record<string, WpeWebDirectory>): WpeStateMessage {
  return { type: WPE_STATE_MESSAGE, full: false, user: null, general: null, directories, directoryChanges: {} };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 用户属性里值变了的键（WPE 的 `applyUserProperties` 只带变化的键）。作者删掉的键页面无从撤销，不推；例外是没有默认值的
 * `file` / `directory` 重置后键会消失，页面仍需收到空路径以撤销旧选择。没有变化返回 null。
 */
export function changedUserProperties(
  prev: Record<string, WpeUserProperty>,
  next: Record<string, WpeUserProperty>,
): Record<string, WpeUserProperty> | null {
  let out: Record<string, WpeUserProperty> | null = null;
  for (const [key, value] of Object.entries(next)) {
    if (!same(prev[key], value)) (out ??= {})[key] = value;
  }
  for (const [key, value] of Object.entries(prev)) {
    if (!(key in next) && (value.type === "file" || value.type === "directory")) {
      (out ??= {})[key] = { type: value.type, value: "" };
    }
  }
  return out;
}

function fetchallFiles(directories: Record<string, WpeWebDirectory> | null | undefined, key: string): string[] {
  const directory = directories?.[key];
  return directory && directory.mode !== "ondemand" ? directory.files : [];
}

/** `fetchall` 目录的文件增删（`ondemand` 当作没有文件）；`prev` 为 null 时全部算新增（整份投递）。 */
export function directoryChanges(
  prev: Record<string, WpeWebDirectory> | null,
  next: Record<string, WpeWebDirectory>,
): Record<string, WpeDirectoryChange> {
  const out: Record<string, WpeDirectoryChange> = {};
  for (const key of new Set([...Object.keys(prev ?? {}), ...Object.keys(next)])) {
    const before = new Set(fetchallFiles(prev, key));
    const after = fetchallFiles(next, key);
    const afterSet = new Set(after);
    const removed = [...before].filter((file) => !afterSet.has(file));
    const added = after.filter((file) => !before.has(file));
    if (removed.length || added.length) out[key] = { added, removed };
  }
  return out;
}

/** 两份状态之间的增量消息；什么都没变（含目录列表）时返回 null。 */
export function stateDelta(prev: WpeWebState, next: WpeWebState): WpeStateMessage | null {
  const user = changedUserProperties(prev.user, next.user);
  const general = same(prev.general, next.general) ? null : next.general;
  const changes = directoryChanges(prev.directories, next.directories);
  if (!user && !general && !Object.keys(changes).length && same(prev.directories, next.directories)) return null;
  return {
    type: WPE_STATE_MESSAGE,
    full: false,
    user,
    general,
    directories: next.directories,
    directoryChanges: changes,
  };
}
