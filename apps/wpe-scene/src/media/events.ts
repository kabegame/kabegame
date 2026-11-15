/**
 * 媒体回调的事件对象（P11c，rea-p11-media 第 3 节）：在脚本的 realm 里建的普通对象（原型是 `Object.prototype`，不是 d.ts 里那几个类的实例），
 * 键的插入顺序照 `scenescript64.dll`；颜色是 realm 的 `Vec3`（分量 `r / 255` 的单精度）；`position` / `duration` 是单精度；
 * 每个脚本每次调用各建一个新对象（`ScriptRuntime.mediaEvent` 对每个接收者调一次 `makeEvent`）。
 */
import type { MediaCallback, ScriptRealm, ScriptRuntime } from "../script/runtime";
import type { MediaCallbacks, ThumbnailInfo } from "./scene";
import type { MediaProps, Rgb } from "./types";

type EventRealm = Pick<ScriptRealm, "global" | "prototypes">;

function plainObject(realm: EventRealm): Record<string, unknown> {
  return new (realm.global.Object as ObjectConstructor)() as Record<string, unknown>;
}

/** 一个颜色 → realm 的 `Vec3(r / 255, g / 255, b / 255)`（float32 除法，两个都是 f32 精确数，`fround` 一次等价）。 */
function colorVector(realm: EventRealm, color: Rgb): unknown {
  const Vec3 = (realm.prototypes.Vec3 as { constructor: new (...values: number[]) => unknown }).constructor;
  return new Vec3(Math.fround(color[0] / 255), Math.fround(color[1] / 255), Math.fround(color[2] / 255));
}

export function statusEvent(realm: EventRealm, enabled: boolean): unknown {
  const event = plainObject(realm);
  event.enabled = enabled;
  return event;
}

export function playbackEvent(realm: EventRealm, state: number): unknown {
  const event = plainObject(realm);
  event.state = state;
  return event;
}

/** 键序：title, artist, albumArtist, albumTitle, subTitle, genres, contentType。 */
export function propertiesEvent(realm: EventRealm, props: MediaProps): unknown {
  const event = plainObject(realm);
  event.title = props.title;
  event.artist = props.artist;
  event.albumArtist = props.albumArtist;
  event.albumTitle = props.albumTitle;
  event.subTitle = props.subTitle;
  event.genres = props.genres;
  event.contentType = props.contentType;
  return event;
}

/** 键序：hasThumbnail, primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor（颜色顺序同消息的 `colors`）。 */
export function thumbnailEvent(realm: EventRealm, info: ThumbnailInfo): unknown {
  const event = plainObject(realm);
  const [primary, secondary, tertiary, text, highContrast] = info.colors;
  event.hasThumbnail = info.hasThumbnail;
  event.primaryColor = colorVector(realm, primary);
  event.secondaryColor = colorVector(realm, secondary);
  event.tertiaryColor = colorVector(realm, tertiary);
  event.textColor = colorVector(realm, text);
  event.highContrastColor = colorVector(realm, highContrast);
  return event;
}

export function timelineEvent(realm: EventRealm, position: number, duration: number): unknown {
  const event = plainObject(realm);
  event.position = Math.fround(position);
  event.duration = Math.fround(duration);
  return event;
}

/** 五个回调接到脚本运行时：每个回调发给全部已 `init` 且导出它的脚本。没有运行时（场景没有脚本）时全是空操作。 */
export function scriptMediaCallbacks(runtime: Pick<ScriptRuntime, "mediaEvent"> | null | undefined): MediaCallbacks {
  const send = (callback: MediaCallback, make: (realm: ScriptRealm) => unknown) => runtime?.mediaEvent(callback, make);
  return {
    status: (enabled) => send("mediaStatusChanged", (realm) => statusEvent(realm, enabled)),
    playback: (state) => send("mediaPlaybackChanged", (realm) => playbackEvent(realm, state)),
    properties: (props) => send("mediaPropertiesChanged", (realm) => propertiesEvent(realm, props)),
    thumbnail: (info) => send("mediaThumbnailChanged", (realm) => thumbnailEvent(realm, info)),
    timeline: (position, duration) => send("mediaTimelineChanged", (realm) => timelineEvent(realm, position, duration)),
  };
}
