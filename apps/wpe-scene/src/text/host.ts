/**
 * 宿主主线程上的文本准备（P6b 1d）：`SceneHost` 持有一个 `SceneTexts`，每次加载在建 GPU 资源之前把 bundle 里的文本层全部排好，结果
 * （每层的 `TextLayout`，网格与它所在的图集）经 `SceneRenderer.load` → `GpuScene.build` 的 `texts` 交给渲染器。
 *
 * - **跨重编译保留**（同声音播放器）：`wpefont` 的实例（`loadWpefont`，全宿主一份）与 `TextFonts`（读过的字体字节、按「字体 + 字号」
 *   的 face 列表）。字体字节按位置缓存，同一张场景重编译不再读文件。
 * - **每次加载新建图集**（`TextAtlases`）：WPE 每次加载也是新的，装箱顺序、那 1 个像素才和 WPE 一样（1c）。
 * - **按对象顺序排**（WPE 的图集按场景里的对象顺序填）：一个对象缺字体（主字体或回退链里的）时 `layoutText` 不碰图集、返回
 *   `missingFonts`，读完再排这个对象，直到不缺，然后才排下一个。每轮至少读进一个字体，字体个数有限（主字体、arial、回退链 8 个），
 *   轮数有上限。
 * - **字体读取**（`fonts.ts` 的位置约定）：
 *   - 主字体的引擎路径：编译期按场景的资源查找顺序定好的位置（`SceneText.font.location`：散文件整读，`scene.pkg` 条目按区间读）；
 *     编译期哪里都没找到的读不到，排版换 arial（同 WPE）；
 *   - `system:<名字>`（名字是 WPE 在 `%WINDIR%\Fonts` 下的文件名）：按 `wpe_scene_target` 交来的 `systemFonts` 表读本机文件。表由后端
 *     按平台解析（`wallpaper/wpe_scene_host.rs`：Windows 是 `%WINDIR%\Fonts\<名字>`，macOS / Linux 换成同款或接近的本机字体），
 *     和宿主 `file:` 闸门放行的是同一批文件；表里没有的名字读不到（同 WPE 的「文件不在就跳过」），不再去猜目录。
 *     没有表时（Node 单测、dev 探针）才按 `fontsDir`，缺省 `C:\Windows\Fonts`，拼 `<目录>\<名字>`；
 *   - 其余引擎路径（回退链里的 `fonts/TwemojiMozilla.ttf`）：依次试 WPE 的 `assets` 目录（`sceneAssets`）。
 * - **失败**：wasm 不在或实例化失败、排版中 wasm 出错，抛 `SceneRenderError(["text:engine"])`，宿主照常退回预览图。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneFontFile } from "../compile/texts";
import { SceneRenderError } from "../render/errors";
import type { SceneReporter } from "../report";
import { loadWpefont, wpefontLoadError, type Wpefont } from "../wpefont";
import { TextAtlases } from "./atlas";
import { SYSTEM_FONT_PREFIX, TextFonts, type FontPath } from "./fonts";
import { layoutText, type TextLayout } from "./layout";

/** 没有 `systemFonts` 表（Node 单测、dev 探针）也没给 `fontsDir` 时的系统字体目录（Windows 的缺省安装位置）。 */
export const DEFAULT_SYSTEM_FONTS_DIR = "C:\\Windows\\Fonts";

/** 一个对象「缺字体 → 读 → 重排」的轮数上限：每轮至少读进一个字体，主字体、arial 与回退链加起来不到 16 个。 */
const MAX_FONT_ROUNDS = 16;

/** 这次加载的字体来源：场景的 WPE `assets` 目录（回退链的引擎路径），系统字体表或目录。 */
export interface TextFontSources {
  sceneAssets: readonly string[];
  /**
   * 系统字体表：名字（`system:` 后面那段，原样）→ 本机文件路径，`wpe_scene_target` 的 `systemFonts`（后端按平台解析）。
   * 有表时 `system:` 只查表，查不到当读不到。
   */
  systemFonts?: Record<string, string> | null;
  /** 没有 `systemFonts` 时的系统字体目录（Node 单测、dev 探针用）；缺省 `DEFAULT_SYSTEM_FONTS_DIR`。 */
  fontsDir?: string | null;
}

export interface SceneTextsOptions {
  reader: SceneReader;
  report?: Pick<SceneReporter, "debug" | "warn">;
  /** 取 wasm 引擎；缺省 `loadWpefont`（单测注入 Node 里编好的实例）。 */
  engine?: () => Promise<Wpefont | null>;
}

/** 路径拼接：沿用 `compile/fs.ts` 的写法（根是 Windows 路径时用反斜杠）。 */
function joinPath(root: string, rel: string): string {
  const separator = /^[a-z]:/i.test(root) || root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]$/, "") + separator + rel.replace(/[\\/]/g, separator);
}

export class SceneTexts {
  private fonts: TextFonts | null = null;
  /** 当前 bundle 里主字体的位置（编译期定的，`fontPath` → 文件）。 */
  private readonly locations = new Map<FontPath, SceneFontFile>();
  private sources: TextFontSources = { sceneAssets: [] };

  constructor(private readonly options: SceneTextsOptions) {}

  /**
   * 排好 bundle 里的全部文本层（按 `objects` 顺序），返回 `objects` 下标 → 排版结果；没有文本层时返回空表、不碰 wasm。
   * `cancelled` 在每个 await 之后问一次（宿主的加载代数变了），为真时返回 null。
   */
  async prepare(
    bundle: Pick<SceneBundle, "layers">,
    sources: TextFontSources,
    cancelled: () => boolean = () => false,
  ): Promise<Map<number, TextLayout> | null> {
    const layouts = new Map<number, TextLayout>();
    const layers = bundle.layers.filter((layer) => layer.text);
    if (!layers.length) return layouts;
    const fonts = await this.ensureFonts();
    if (cancelled()) return null;
    this.sources = sources;
    for (const layer of layers) {
      const font = layer.text!.font;
      if (!font.path.startsWith(SYSTEM_FONT_PREFIX)) this.locations.set(font.path, font);
    }
    const started = performance.now();
    const atlases = new TextAtlases();
    try {
      for (const layer of layers) {
        const fields = layer.text!.fields;
        let layout = layoutText(fields, fonts, atlases);
        for (let round = 0; layout.missingFonts.length && round < MAX_FONT_ROUNDS; round++) {
          await fonts.load(layout.missingFonts);
          if (cancelled()) return null;
          layout = layoutText(fields, fonts, atlases);
        }
        // 读过的字体不会再缺（读不到的记成 null），走到这里说明轮数上限不够，按排不出处理
        if (layout.missingFonts.length)
          throw new Error(`字体读了 ${MAX_FONT_ROUNDS} 轮仍缺：${layout.missingFonts.join(", ")}`);
        layouts.set(layer.object, layout);
      }
    } catch (error) {
      this.options.report?.warn("场景文本排版失败：", error);
      throw new SceneRenderError(["text:engine"]);
    }
    this.options.report?.debug(
      `场景文本：${layers.length} 层，图集 ${atlases.all().length} 组，用时 ${Math.round(performance.now() - started)} ms`,
    );
    return layouts;
  }

  /** wasm 引擎与字体缓存：第一次用时建，之后跨重编译保留。wasm 不在或实例化失败抛 `text:engine`。 */
  private async ensureFonts(): Promise<TextFonts> {
    if (this.fonts) return this.fonts;
    const engine = await (this.options.engine ?? loadWpefont)();
    if (!engine) {
      this.options.report?.warn(`场景文本不可用：${wpefontLoadError() ?? "wpefont 加载失败"}`);
      throw new SceneRenderError(["text:engine"]);
    }
    this.fonts = new TextFonts(engine, (path) => this.readFont(path));
    return this.fonts;
  }

  /** 字体读取器（`TextFonts` 调；读不到返回 null，`TextFonts.load` 另把抛错当读不到）。 */
  private async readFont(path: FontPath): Promise<Uint8Array | null> {
    const reader = this.options.reader;
    if (path.startsWith(SYSTEM_FONT_PREFIX)) {
      const name = path.slice(SYSTEM_FONT_PREFIX.length);
      const table = this.sources.systemFonts;
      // 后端解析好的本机文件；表里没有就是本机没有，不回落到目录
      if (table) return Object.hasOwn(table, name) ? reader.readWhole(table[name]) : null;
      return reader.readWhole(joinPath(this.sources.fontsDir || DEFAULT_SYSTEM_FONTS_DIR, name));
    }
    const file = this.locations.get(path);
    if (file) {
      const location = file.location;
      if (!location) return null;
      return file.size === null
        ? reader.readWhole(location.path)
        : reader.readRange(location.path, location.offset, location.offset + file.size);
    }
    // 回退链里的引擎路径（Twemoji）：WPE 的 assets
    for (const root of this.sources.sceneAssets) {
      try {
        return await reader.readWhole(joinPath(root, path));
      } catch {
        // 这个根里没有，试下一个
      }
    }
    return null;
  }

  /** 释放 face 与字体字节（宿主销毁时）；wasm 实例是全宿主共用的，不在这里丢。 */
  dispose(): void {
    this.fonts?.dispose();
    this.fonts = null;
    this.locations.clear();
  }
}
