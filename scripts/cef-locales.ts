/**
 * CEF locale 白名单 —— kabegame 支持的 UI 语言(单一来源)。
 *
 * CEF 的 locale 装的是 Chromium **自身**的 UI 文案(右键菜单、错误页、下载条等),
 * 与 app 的 Vue i18n(packages/kabegame-i18n)无关。自编发行版带全量 228 个 locale
 * 共 ~52MB,而应用只可能显示下面这 5 种,其余纯属体积。
 *
 * 同一份白名单有两种排布,取决于平台如何组织 CEF 运行时:
 * - Linux/Windows:扁平的 `locales/<locale>.pak`,**连字符**命名(`zh-CN.pak`)
 * - macOS:framework 内 `Resources/<locale>.lproj/locale.pak`,**下划线**命名(`zh_CN.lproj`)
 *
 * 裁剪落在两处,共用本文件:
 * 1. `scripts/build-chromium.ts` 的 `exportCefRuntime()` —— 导出期源头就不导出,
 *    于是 `bin/{platform}/{arch}/cef-build-{dev,prod}` 本身就是瘦的。
 * 2. `scripts/plugins/os-plugin.ts` 的 Linux/Windows 收集 —— 打包期再按白名单挑一次。
 *    对自编导出目录是幂等的重复工作,但能给「CEF_PATH 指向未经裁剪的目录」兜底。
 *    macOS 没有第 2 步:framework 由 Tauri `macOS.frameworks` 整目录拷进 .app,
 *    没有逐文件收集的环节,所以完全依赖第 1 步。
 */

export interface CefLocale {
  /** Linux/Windows 扁平 locales/ 下的 pak 文件名。 */
  readonly pak: string;
  /** macOS framework Resources/ 下的 .lproj 目录名(不含后缀)。 */
  readonly lproj: string;
}

/**
 * 白名单本体。`en` 必留 —— CEF 匹配不到系统语言时回退它,缺失会启动报错。
 * 其余四项对应 packages/kabegame-i18n 的 ja / ko / zh / zhtw。
 */
export const CEF_LOCALE_ENTRIES: readonly CefLocale[] = [
  { pak: "en-US.pak", lproj: "en" },
  { pak: "ja.pak", lproj: "ja" },
  { pak: "ko.pak", lproj: "ko" },
  { pak: "zh-CN.pak", lproj: "zh_CN" },
  { pak: "zh-TW.pak", lproj: "zh_TW" },
];

/** Linux/Windows:`locales/` 下要保留的 pak 文件名。 */
export const CEF_LOCALE_PAKS: readonly string[] = CEF_LOCALE_ENTRIES.map(
  (l) => l.pak,
);

/** CEF 必需的回退 locale(Linux/Windows 形态),缺失时收集/导出应硬报错。 */
export const CEF_FALLBACK_PAK = "en-US.pak";

/**
 * macOS:framework `Resources/` 下要保留的 `.lproj` 目录名。
 *
 * 除基础 locale 外一并保留 `_FEMININE` / `_MASCULINE` / `_NEUTER` —— 那是 Chromium
 * 性别化翻译的差分包,实测各只有 18 字节的空 pak,零体积,留着免得运行时按性别
 * 取文案时落空。
 */
export const MACOS_CEF_LOCALE_LPROJ: ReadonlySet<string> = new Set(
  CEF_LOCALE_ENTRIES.flatMap(({ lproj }) => [
    `${lproj}.lproj`,
    `${lproj}_FEMININE.lproj`,
    `${lproj}_MASCULINE.lproj`,
    `${lproj}_NEUTER.lproj`,
  ]),
);

/** macOS 回退 locale 的 `.lproj` 目录名。 */
export const MACOS_CEF_FALLBACK_LPROJ = "en.lproj";

/**
 * 该条目是否要从 CEF 运行时里剔除。
 * 只认 `.lproj` 后缀,其余条目(icudtl.dat、*.pak、Info.plist、Libraries/ 等)一律保留。
 */
export function isDroppedMacOSLproj(name: string): boolean {
  return name.endsWith(".lproj") && !MACOS_CEF_LOCALE_LPROJ.has(name);
}

/**
 * 该条目是否要从扁平 `locales/` 里剔除。
 * 只认 `.pak`,`locales/` 下的其他文件(某些 distrib 有 `*.pak.info`)一律保留。
 */
export function isDroppedLocalePak(name: string): boolean {
  return name.endsWith(".pak") && !CEF_LOCALE_PAKS.includes(name);
}
