/**
 * 声音对象 → bundle 的声音表（P6a 步骤 1）。声音对象不画东西：在 `layers` 里仍是一个没有 pass 的图层（层级、名字、`getLayer` 照旧），
 * 这里只把它的文件与播放字段解析成纯数据，播放在宿主（`audio/`）里按 WPE 的规则排期。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase6/rea-p6a-sound.md` 第 1 节（键表与缺省值、文件读取）与 `p6-REPORT.md`
 * 「P6a 声音语义的实测核对」（实测，冲突时以它为准）。能力检查在 `features.ts` 的 `checkSoundFeatures`。
 */
import type { BindingCollector } from "./bindings";
import type { SceneFs } from "./fs";
import { resolveValue, type SceneObject, type SceneScalar, type SceneValue } from "./model";

/** WPE 的三种播放模式（枚举表 `0x1404e9760`：0 loop、1 random、2 single），缺省 loop。 */
export const SOUND_MODES = ["loop", "single", "random"] as const;
export type SoundMode = (typeof SOUND_MODES)[number];

/**
 * WPE 读得出的格式（`mediaextensions64.dll` 里 SFML 的读取器只有 WAV、OGG Vorbis、FLAC、MP3，rea 第 6 节）。扩展名不分大小写
 * （语料有 `A Rusty Dream.MP3`）；值是 Blob 的 MIME 类型（pkg 条目读成 Blob 时用）。
 */
export const SOUND_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp3: "audio/mpeg",
};

export interface SceneSoundFile {
  /** scene.json 里写的相对路径。 */
  path: string;
  /** 同 `SceneFile.location`：要读的真实文件与内容起点（散文件是它本身，pkg 条目是 scene.pkg 加偏移）。 */
  location: { path: string; offset: number };
  /** pkg 条目的长度；散文件为 null（直接用 file: 地址）。 */
  size: number | null;
}

export interface SceneSound {
  /** `objects` 下标（稳定键）；同一对象在 `layers` 里仍有一个没有 pass 的图层。 */
  object: number;
  /** 解析得到的文件；找不到的、扩展名不是 wav / ogg / flac / mp3 的不进表（WPE 读不出就从列表删掉、不报错，rea 1.3）。 */
  files: SceneSoundFile[];
  mode: SoundMode;
  /** 缺省 1。 */
  mintime: number;
  /** 缺省 5。 */
  maxtime: number;
  startSilent: boolean;
  /** 缺省 1，不钳制（增益在乘积上钳，见 `audio/scheduler.ts`）；绑用户属性时是解析后的值。 */
  volume: number;
}

/**
 * `volume` 的取值，编译与就地写共用（「就地 = 重编译」靠它）：数字原样；非空字符串整串解析成有限数；布尔按 1 / 0（条件绑定
 * `{user: {name, condition}}` 的值是布尔，同 `instanceScalar`）。不合法时返回 undefined：编译取缺省 1，就地写不改值（WPE 的 float
 * 解析器不收时不写字段）。
 */
export function soundVolume(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 布尔键（`startsilent`、`spatialization`）：WPE 的解析器只认 JSON 布尔或 `{value: 布尔}`（rea 1.2，`0x1401e1a9d`），其余为假。 */
export function soundFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    return inner === true;
  }
  return false;
}

/** `playbackmode` 的取值；不是三种之一时取缺省 loop（能力表另报 `sound:playbackmode:<值>`）。 */
export function soundMode(value: unknown): SoundMode {
  return SOUND_MODES.includes(value as SoundMode) ? (value as SoundMode) : "loop";
}

/** `sound` 键里的文件名：字符串或字符串数组（rea 1.1，`0x1401f5a22` 起），别的元素跳过。 */
export function soundNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((name): name is string => typeof name === "string" && name !== "");
}

/** 扩展名是不是 WPE 读得出的格式（不分大小写）。 */
export function soundExtension(path: string): string | null {
  const match = /\.([^./\\]+)$/.exec(path);
  const ext = match ? match[1].toLowerCase() : "";
  return ext in SOUND_TYPES ? ext : null;
}

/** float 键（`mintime` / `maxtime`）：数字或 `{user, value}`，解析不出来取缺省。 */
function floatOf(value: SceneScalar | undefined, fallback: number): number {
  return soundVolume(value) ?? fallback;
}

/**
 * 解析一个声音对象（`isSoundObject` 为真）。`volume` 登记成就地目标 `{ kind: "sound" }`（`SceneState.sounds`，排期器每帧读）；
 * 其余字段 WPE 没有回调（rea 1.2），绑了属性时按当前属性取一次（能力表报 `sound:binding:<键>`）。
 * 文件按场景的资源查找顺序定位（项目 → scene.pkg → assets）；路径非法、找不到、格式不对的都跳过。
 */
export async function compileSound(
  index: number,
  object: SceneObject,
  fs: SceneFs,
  properties: Record<string, SceneScalar>,
  bindings: BindingCollector,
): Promise<SceneSound> {
  const files: SceneSoundFile[] = [];
  for (const name of soundNames(object.sound)) {
    if (!soundExtension(name)) continue;
    let file: Awaited<ReturnType<SceneFs["resolve"]>> = null;
    try {
      file = await fs.resolve(name);
    } catch {
      // 越界、绝对路径等：WPE 打不开，同样从列表里删掉
      file = null;
    }
    if (file) files.push({ path: name, location: { ...file.location }, size: file.size });
  }
  const value = (key: string) => resolveValue(object[key] as SceneValue | undefined, properties);
  const volume = bindings.bind(object.volume as SceneValue | undefined, properties, {
    kind: "sound",
    object: index,
    field: "volume",
  });
  return {
    object: index,
    files,
    mode: soundMode(value("playbackmode")),
    mintime: floatOf(value("mintime"), 1),
    maxtime: floatOf(value("maxtime"), 5),
    startSilent: soundFlag(object.startsilent) || value("startsilent") === true,
    volume: soundVolume(volume) ?? 1,
  };
}
