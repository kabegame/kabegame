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
 * - **运行中重排**（P6b 1e）：每次加载的图集留在实例上，`relayouter()` 给出绑定这次加载的重排器，经 `SceneRenderer.load` → `GpuScene.build`
 *   的 `relayout` 交给渲染器，渲染器在 `sync` 里对排版字段变了的层调它（帧循环里，同步）。先放旧排版的字形引用再排（同 WPE「先放旧、
 *   再排新」）；缺字体时把引用加回去、返回 null（旧排版照画），后台读字体，读完调 `onReady(对象)`，宿主把这一层重新标脏（暂停时补画
 *   一帧），下一帧补上（WPE 同步读，第一次出现新回退字时我们晚一到几帧，1e 已定 4）。
 *   重排器绑定加载代数：更新的加载一开始（`prepare` 开头加代数）或宿主销毁之后，旧场景的重排器不再动图集（返回 null），读完字体的回调
 *   也丢掉——旧场景在新场景建好之前还在画，不能把字形排进新加载的图集（装箱顺序要和 WPE 一样）。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneFontFile } from "../compile/texts";
import { SceneRenderError } from "../render/errors";
import type { SceneReporter } from "../report";
import { loadWpefont, wpefontLoadError, type Wpefont } from "../wpefont";
import { TextAtlases } from "./atlas";
import type { TextFields } from "./fields";
import { SYSTEM_FONT_PREFIX, TextFonts, type FontPath } from "./fonts";
import { layoutText, releaseTextLayout, retainTextLayout, type TextLayout } from "./layout";

/**
 * 运行中重排一层（P6b 1e，`GpuScene.build` 的 `relayout`）：按新字段重排 `object`。先放旧排版的字形引用再排（同 WPE「先放旧、再排新」）；
 * 缺字体时把引用加回去、返回 null（旧排版照画），后台读字体，读完由宿主把这一层重新标脏。重排器过期（有更新的加载、宿主已销毁）时同样
 * 返回 null、不动图集。
 */
export interface TextRelayouter {
  relayout(object: number, fields: TextFields, previous: TextLayout): TextLayout | null;
}

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
  /**
   * 运行中重排缺的字体读完了（P6b 1e）：`object` 这一层可以再排一次。宿主把它重新标脏（`SceneState.touchText`），暂停时补画一帧。
   * 只在发起重排的那次加载仍是最新、宿主没销毁时调。
   */
  onReady?: (object: number) => void;
}

/** 一次加载：代数与这次新建的图集（运行中重排排进同一套图集）。 */
interface TextLoad {
  generation: number;
  atlases: TextAtlases;
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
  /** 加载代数（P6b 1e）：每次 `prepare` 开头加一，`dispose` 也加；重排器与读字体的回调比它，过期就不做事。 */
  private generation = 0;
  /** 最近一次排完的加载（`prepare` 成功返回时记下），`relayouter()` 绑它；更新的加载开始时清掉。 */
  private current: TextLoad | null = null;
  private disposed = false;

  constructor(private readonly options: SceneTextsOptions) {}

  /**
   * 排好 bundle 里的全部文本层（按 `objects` 顺序），返回 `objects` 下标 → 排版结果；没有文本层时返回空表、不碰 wasm。
   * `cancelled` 在每个 await 之后问一次（宿主的加载代数变了），为真时返回 null。
   * 开头加加载代数：之前加载的重排器从这一刻起过期（P6b 1e）。
   */
  async prepare(
    bundle: Pick<SceneBundle, "layers">,
    sources: TextFontSources,
    cancelled: () => boolean = () => false,
  ): Promise<Map<number, TextLayout> | null> {
    const generation = ++this.generation;
    this.current = null;
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
    // 排完才记：读字体的 await 期间有更新的加载开始时，代数已经不是这一次的
    if (generation === this.generation && !this.disposed) this.current = { generation, atlases };
    this.options.report?.debug(
      `场景文本：${layers.length} 层，图集 ${atlases.all().length} 组，用时 ${Math.round(performance.now() - started)} ms`,
    );
    return layouts;
  }

  /**
   * 最近一次加载的重排器（P6b 1e，交给 `GpuScene.build` 的 `relayout`）：排进这次加载的图集。绑定加载代数，而不是让渲染器直接调
   * `SceneTexts`：重编译时旧场景在新场景建好之前还在画，它的重排不能落进新加载的图集。没有排完的加载（没有文本层、被取代、出错）时为 null。
   */
  relayouter(): TextRelayouter | null {
    const load = this.current;
    if (!load) return null;
    return { relayout: (object, fields, previous) => this.relayoutIn(load, object, fields, previous) };
  }

  /**
   * 重排一层（`TextRelayouter.relayout`）：过期（有更新的加载、已销毁）返回 null、不动图集。否则先放旧排版的引用再排；排版出错、或缺字体
   * （`layoutText` 不碰图集）时把引用加回去、返回 null。缺字体时后台读，读完（这次加载仍是最新、没销毁）调 `onReady(object)`。
   */
  private relayoutIn(load: TextLoad, object: number, fields: TextFields, previous: TextLayout): TextLayout | null {
    const fonts = this.fonts;
    if (this.disposed || !fonts || load.generation !== this.generation) return null;
    releaseTextLayout(previous);
    let layout: TextLayout;
    try {
      layout = layoutText(fields, fonts, load.atlases);
    } catch (error) {
      retainTextLayout(previous);
      this.options.report?.warn(`场景文本重排失败（对象 ${object}）：`, error);
      return null;
    }
    if (!layout.missingFonts.length) return layout;
    retainTextLayout(previous);
    // 读取器的抛错 `TextFonts.load` 已当读不到，这里的拒绝回调只兜底
    fonts.load(layout.missingFonts).then(
      () => {
        if (this.disposed || load.generation !== this.generation) return;
        this.options.onReady?.(object);
      },
      () => {},
    );
    return null;
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

  /** 释放 face 与字体字节（宿主销毁时）；wasm 实例是全宿主共用的，不在这里丢。之后重排器不再工作、读完字体的回调不再调（P6b 1e）。 */
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.current = null;
    this.fonts?.dispose();
    this.fonts = null;
    this.locations.clear();
  }
}
