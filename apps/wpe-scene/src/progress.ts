/**
 * 场景加载进度（壁纸显示重构步骤 2，`.claude/plans/wpe-import/phase-wallpaper-refactor.md`）：宿主只在**首次加载**时按阶段上报，
 * 经 postMessage 交给父页面（`WpeSceneView`），总百分比与动画由应用页按自己的权重换算（`wpeSceneProgress.ts`），宿主不关心权重。
 * 重编译（改属性、改设置）时旧画面一直在画，不报。
 *
 * 阶段（顺序即加载顺序）：
 * - `compile`：Worker 编译，`done / total` 是已处理对象的权重（每个对象 1 + 它的 effect 数，读完 scene.json 就知道总数）；
 * - `decode`：主线程解 PNG / JPG 的 mip（有缓存时瞬间完成）；
 * - `gpu`：准备渲染。编译、解码完就进入（`0 / 1`，不记分段点）：文本排版、声音、脚本 `init`、取设备期间没有计数；建 GPU 场景时
 *   `done / total` 是已建好的着色器程序；之后的管线、粒子预热、排版是同步的，发不出消息；
 * - `frame`：首帧（等 GPU 交完第一帧、等视频出第一帧），报一次 `0 / 1`、出来时 `1 / 1`。
 * 开头的「宿主启动、拉属性、等设置」没有消息，应用页从挂上 iframe 到第一条消息之间自己算 `page` 阶段。
 *
 * 字面量在应用页另写一份（`apps/kabegame/src/components/wallpaper/wpeSceneProgress.ts`），测试比对，同 `sceneStyle.ts`。
 */

export const SCENE_PROGRESS_MESSAGE = "kabegame:wpe-scene-progress";

export type SceneProgressStage = "compile" | "decode" | "gpu" | "frame";

export interface SceneProgressMessage {
  type: typeof SCENE_PROGRESS_MESSAGE;
  stage: SceneProgressStage;
  done: number;
  total: number;
}

export type SceneProgressSink = (stage: SceneProgressStage, done: number, total: number) => void;

/** 同一阶段的两条消息至少隔这么久（阶段的最后一条 `done >= total` 照发）：对象多的场景编译时每个对象一条，不值得都发。 */
export const SCENE_PROGRESS_INTERVAL_MS = 100;

/** 发给父页面；不在 iframe 里（测试、dev 直接打开）时不发。 */
export function postSceneProgress(stage: SceneProgressStage, done: number, total: number): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const message: SceneProgressMessage = { type: SCENE_PROGRESS_MESSAGE, stage, done, total };
  window.parent.postMessage(message, "*");
}

/** 日志分段的名字：每个时间点开始的那一段叫什么。 */
const SEGMENT_LABELS: Record<SceneProgressStage, string> = {
  compile: "编译",
  decode: "解码",
  gpu: "建 GPU 场景",
  frame: "首帧",
};

/**
 * 一次加载的进度与分段计时。`report` 节流后交给 `sink`（`sink` 为 null 时只计时：重编译、测试），并在每个阶段第一次报的时刻
 * 记一个分段点；宿主另用 `mark` 记阶段之外的分段点（准备、取设备）。`summary` 给「开始渲染」日志用。
 */
export class SceneLoadProgress {
  private readonly marks: { label: string; at: number }[];
  /** 已经记过分段点的阶段 */
  private readonly marked = new Set<SceneProgressStage>();
  private last: { stage: SceneProgressStage; at: number } | null = null;

  constructor(
    private readonly sink: SceneProgressSink | null,
    private readonly now: () => number = () => performance.now(),
    firstLabel = "等目标与设置",
  ) {
    this.marks = [{ label: firstLabel, at: this.now() }];
  }

  /** 记一个分段点：从这一刻起的一段叫 `label`；和上一个分段点同名时不记。 */
  mark(label: string): void {
    if (this.marks[this.marks.length - 1].label === label) return;
    this.marks.push({ label, at: this.now() });
  }

  /**
   * `mark: false`：只报进度、不记分段点（提前进入某个阶段：进度条要动，日志仍按实际开始的时刻分段）；这个阶段第一次带分段点的
   * 报告才记。
   */
  report(stage: SceneProgressStage, done: number, total: number, options: { mark?: boolean } = {}): void {
    const at = this.now();
    if (options.mark !== false && !this.marked.has(stage)) {
      this.marked.add(stage);
      this.mark(SEGMENT_LABELS[stage]);
    }
    const changed = this.last?.stage !== stage;
    if (!changed && done < total && at - this.last!.at < SCENE_PROGRESS_INTERVAL_MS) return;
    this.last = { stage, at };
    this.sink?.(stage, done, total);
  }

  /** 各段用时：「等目标与设置 12 ms、编译 340 ms、…」，最后一段到现在为止。 */
  summary(): string {
    const end = this.now();
    return this.marks
      .map((mark, index) => {
        const next = this.marks[index + 1]?.at ?? end;
        return `${mark.label} ${Math.round(next - mark.at)} ms`;
      })
      .join("、");
  }
}
