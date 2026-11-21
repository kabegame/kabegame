/**
 * 场景快捷方式属性（`usershortcut`，P11d）的值格式，面板编辑器 `WpeShortcutField.vue` 读写。
 *
 * 存在图片 metadata `userProperties` 里的原值是 `<类型>:<路径>[|<参数>]`，只有本机面板写，后端同一份规则解析（`wpe::user_props`）：
 * - 类型 `file`（文件，路径与参数在**第一个** `|` 处拆）、`directory`（文件夹）、`web`（网址）、`cmd`（命令，整条命令行放在路径里，
 *   后端在第一个空格处拆成程序与参数）；
 * - 空串表示没配（清空）；
 * - `web` 原样存，不补协议：面板边输入边保存，保存时补会把正在输入的值改掉。打开时由后端补 `https://`（没写协议的都补），
 *   给场景脚本看的网址照 WPE 面板保存时的规则补（`wpe::user_props::wpe_web_url`）。
 *
 * 类型名与前缀按第一个 `:` 拆（路径里的盘符冒号不受影响：`file:C:\a.exe|-x` 的类型是 `file`）。
 */

export type WpeShortcutKind = "file" | "directory" | "web" | "cmd";

export const WPE_SHORTCUT_KINDS: readonly WpeShortcutKind[] = ["file", "directory", "web", "cmd"];

export interface WpeShortcutParts {
  kind: WpeShortcutKind;
  /** 文件 / 文件夹路径、网址、整条命令行 */
  path: string;
  /** 只有 `file` 类型有 */
  args: string;
}

/** 把原值拆成各字段；空值、格式不对、类型不认识时是空的 `file`。 */
export function parseWpeShortcut(value: unknown): WpeShortcutParts {
  const empty: WpeShortcutParts = { kind: "file", path: "", args: "" };
  if (typeof value !== "string") return empty;
  const colon = value.indexOf(":");
  if (colon < 0) return empty;
  const kind = value.slice(0, colon) as WpeShortcutKind;
  if (!WPE_SHORTCUT_KINDS.includes(kind)) return empty;
  const rest = value.slice(colon + 1);
  if (kind !== "file") return { kind, path: rest, args: "" };
  const bar = rest.indexOf("|");
  return bar < 0 ? { kind, path: rest, args: "" } : { kind, path: rest.slice(0, bar), args: rest.slice(bar + 1) };
}

/**
 * 各字段拼回原值：路径（去首尾空白）为空时是空串（= 没配）；只有 `file` 带参数（去首尾空白，空则不写 `|`）。
 * `cmd` 的参数写在命令行里，`directory` / `web` 没有参数。
 */
export function composeWpeShortcut(kind: WpeShortcutKind, path: string, args: string): string {
  const target = path.trim();
  if (!target) return "";
  const extra = kind === "file" ? args.trim() : "";
  return extra ? `${kind}:${target}|${extra}` : `${kind}:${target}`;
}
