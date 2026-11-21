# P6a2 — 声音的 `mintime` / `maxtime` 绑属性、挂脚本（就地写，下一次排期生效）

起因：myprojects `3798696286`（Hades Asylum Depths）的咆哮声是 `random` 模式，`mintime` / `maxtime` 绑在两个滑块上（缺省 15 / 45 秒），
我们报 `sound:binding:mintime; sound:binding:maxtime`，整张退回预览图。

## 总体设计思路

P6a 当时读到这两个键「没有改值回调」（rea-p6a-sound 1.2），语料里又是 0 张，就把绑属性、挂脚本一律照报。之后的逆向补上了缺的一环：WPE 写字段
一律走描述符的类型化 setter，setter 最后才调改值回调，没有回调的字段照样被写进去，下一次读到的就是新值（rea-p10-keyframes 第 4 条；
rea-p12-runtime：用户属性面板的排队改值、字段脚本、脚本赋值、属性关键帧都是这样，P12 实测）。而 `random` 模式只在每次开始播放（`P`）时读
这两个字段，算出 `T = u·(maxtime − mintime) + mintime + 时长`（rea-p6a 2.1，静态确认）。所以 WPE 的行为是：**加载时取当前值；运行中改了，
正在进行的这次等待不变，下一次排期用新值**。`loop` / `single` 不读它们，改了没有可见效果。

我们照这个语义把它们做成和 `volume` 同一类的就地目标：编译期登记 `{ kind: "sound", field: "mintime" | "maxtime" }`，值写进
`SceneState.sounds`；排期器在 `P` 的 `random` 分支**当场**从状态里读，而不是用编译期的常量。读法是给排期器注入一个读当前状态的函数，
不再「推」：WPE 的 `P` 读字段那一刻是什么就用什么，脚本先写 `mintime` 再 `play()` 也能读到新值，不用在每条写入路径上同步。

三种写入方（用户属性、字段脚本、属性关键帧）都经 `targetOf` / 绑定表落到同一个目标，所以一起支持；能力表不再报
`sound:binding:mintime` / `maxtime`。`playbackmode` / `startsilent` / `spatialization` 维持照报：语料仍是 0 张，运行中改它们 WPE 的效果
（重排、开始时机）更绕，这一步不碰。

关键决策：
- **读而不是推**：`volume` 要推（WPE 的回调 `V` 当场改增益），`mintime` / `maxtime` 没有回调、只在 `P` 时读，注入读函数最贴近 WPE，也不用改
  宿主里三处推音量的路径（只要让它们只对 `volume` 推）。
- **排期器签名去掉这两个键**：它们变成运行中的状态，不再是「声音表」的一部分。否则改过滑块后，别的原因触发的重编译会因为编译期取到的新值
  和旧排期器不同而重建排期器、打断正在播的声音。
- **取值规则不变**：仍是 `soundVolume`（数字、非空数字串、布尔 1 / 0；不合法时编译取缺省 1 / 5、就地写不改值，同 WPE 的 float 解析器不收时
  不写字段）。`maxtime < mintime` 照公式算（WPE 不检查）。

## 现状锚点

**a. 编译期取一次常量，只给 `volume` 登记目标**（`compile/sounds.ts` `compileSound`）
```ts
const value = (key: string) => resolveValue(object[key] as SceneValue | undefined, properties);
const volume = bindings.bind(object.volume as SceneValue | undefined, properties, {
  kind: "sound",
  object: index,
  field: "volume",
});
return {
  ...
  mintime: floatOf(value("mintime"), 1),   // 现状：按当前属性取一次，之后不变
  maxtime: floatOf(value("maxtime"), 5),
  ...
};
```

**b. 能力表**（`compile/features.ts`）
```ts
/** 声音对象上 WPE 没有回调、运行时改了不生效的键（rea 1.2）：绑了属性或挂了脚本报 `sound:binding:<键>`（语料 0 个）。 */
const SOUND_UNBOUND_KEYS = ["playbackmode", "mintime", "maxtime", "startsilent", "spatialization"];   // 现状：含 mintime / maxtime
```

**c. 目标类型与字段脚本**（`compile/bindings.ts`、`compile/scripts.ts` `targetOf`）
```ts
| { kind: "sound"; object: number; field: "volume" }          // 现状：只有 volume
...
if (owner.kind === "layer" && sound && path === `objects/${owner.object}/volume`)
  return { kind: "sound", object: owner.object, field: "volume" };   // 现状：只认 volume
```

**d. 状态**（`render/state.ts`）
```ts
readonly sounds = new Map<number, { volume: number }>();   // 现状：只存 volume
...
if (target.kind === "sound") {
  const sound = this.sounds.get(target.object);
  const value = soundVolume(conditioned(binding, raw));
  if (sound && value !== undefined) sound.volume = value;   // 现状：只写 volume
  return "applied";
}
```
`script/stateWrite.ts` 读回同样只取 `.volume`。

**e. 排期器读编译期常量**（`audio/scheduler.ts` `start()` 的 random 分支）
```ts
const wait = this.random() * (this.sound.maxtime - this.sound.mintime) + this.sound.mintime;   // 现状：this.sound 是编译期的声音表
```

**f. 排期器签名含这两个键**（`audio/sceneSounds.ts`）
```ts
return JSON.stringify([files, sound.mode, sound.mintime, sound.maxtime, sound.startSilent]);   // 现状
```

**g. 宿主**（`host.ts`）：`writeScript` 对 `target.kind === "sound"` 一律当音量推给排期器；`pushSoundVolume`（关键帧）、`syncSoundVolumes`
（属性就地写之后）只推音量；`new SceneSounds(this.soundPlayer, Math.random, onFailed)`。

## 点 1 — 目标与编译（`compile/bindings.ts`、`compile/sounds.ts`、`compile/scripts.ts`、`compile/features.ts`）

- **修改** `bindings.ts`：
```ts
/** 声音对象的就地字段（P6a 步骤 1 的 volume；P6a2 的 mintime / maxtime）。 */
export type SoundField = "volume" | "mintime" | "maxtime";   // 新增
| { kind: "sound"; object: number; field: SoundField }      // 修改
```
  注释补：`mintime` / `maxtime` 没有改值回调，`random` 模式在开始播放时现读（rea-p6a 2.1 + rea-p10 第 4 条）。
- **修改** `sounds.ts` `compileSound`：`mintime` / `maxtime` 同 `volume` 经 `bindings.bind` 登记目标，返回值仍按 `floatOf(…, 1 / 5)` 取。
  `soundVolume` 的文档改成「`volume` / `mintime` / `maxtime` 共用的 float 取值」（名字不改，免得牵动调用方）。文件头与 `compileSound` 的注释同步。
- **修改** `scripts.ts` `targetOf`：`objects/<i>/volume|mintime|maxtime` → `{ kind: "sound", field }`；`fieldType` 不变（sound 都是 float）。注释同步。
  属性关键帧（P10a）经同一个函数取目标，自动支持。
- **修改** `features.ts`：`SOUND_UNBOUND_KEYS` 去掉 `mintime` / `maxtime`，注释与 `checkSoundFeatures` 的文档同步（剩下三个键仍照报）。

## 点 2 — 状态（`render/state.ts`、`script/stateWrite.ts`）

- **修改** `sounds` 的值类型为 `{ volume: number; mintime: number; maxtime: number }`（可导出 `SoundValues`），起始值取编译期的 `SceneSound`
  （`fromBundle` 两处、`install` 的 `slice.sound` 一处）。
- **修改** 写入：`sound[target.field] = value`（取值规则不变）。
- **修改** `stateWrite.ts` 读回：取 `state.sounds.get(object)?.[target.field]`。

## 点 3 — 排期器现读（`audio/scheduler.ts`、`audio/sceneSounds.ts`）

- **新增** `SoundScheduler` 构造参数（可选，放最后）：`timing?: () => { mintime: number; maxtime: number } | undefined`。
- **修改** `start()` 的 random 分支：
```ts
// mintime / maxtime 没有改值回调，WPE 在 P 里现读字段（rea-p6a 2.1）：属性、脚本、关键帧写过的值在下一次排期生效，正在等的这次不变
const { mintime, maxtime } = this.timing?.() ?? this.sound;
const wait = this.random() * (maxtime - mintime) + mintime;
```
- **修改** `sceneSounds.ts`：
  - `soundKey` 去掉 `mintime` / `maxtime`（注释说明：它们是运行中的状态）；文件头「重编译」一条同步。
  - `SceneSounds` 构造多一个可选参数 `timingOf?: (object: number) => { mintime: number; maxtime: number } | undefined`，建排期器时传
    `() => timingOf?.(sound.object)`。

## 点 4 — 宿主（`host.ts`）

- **修改** `new SceneSounds(…)` 传 `timingOf`：读 `this.drawnState?.sounds.get(object)`（同 `pushSoundVolume` 的状态来源）。
- **修改** `writeScript` 的 `target.kind === "sound"` 分支只在 `target.field === "volume"` 时推音量；`pushSoundVolume` 的调用方（关键帧）
  已按对象推，保持只推音量即可（写 `mintime` 时推一次音量是无害的空操作，不必区分，但注释写明 timing 不用推）。

## 点 5 — 测试

- `compile/sounds.test.ts`：`mintime` / `maxtime` 绑属性时登记目标、编译值取当前属性、不合法取缺省；能力表不再报这两个，`playbackmode` /
  `startsilent` 仍报；字段脚本挂在 `mintime` 上时 `targetOf` 给 sound 目标、不报 `sound:binding:mintime`。
- `render/state` 相关测试：就地写 `mintime` / `maxtime`、不合法值不改；`stateWrite` 读回。
- `audio/scheduler.test.ts`：random 模式在等待中改 timing，当前等待长度不变、下一次用新值；没有 `timing` 时用声音表的值；`maxtime < mintime`
  照公式。
- `audio/sceneSounds.test.ts`：只差 `mintime` / `maxtime` 的新声音表保留排期器；`timingOf` 传到排期器。
- `host` 相关测试（若有声音写入用例）：脚本写 `mintime` 不调 `setVolume`。

## 点 6 — 文档

- `cocs/wpe/WPE_SCENE.md`「声音（P6a）」：`mintime` / `maxtime` 绑属性 / 脚本 / 关键帧就地写、下一次排期生效；照报键只剩三个。
- `cocs/README.md` 声音一条补一句。
- `versions/latest/changelog.md`、`versions/latest/regression.md`。

## 验证（验收方做）

- 单测、tsc、Prettier；变异：random 分支仍读 `this.sound`、`soundKey` 仍含两个键、能力表仍报、`targetOf` 不认 `mintime`、状态写入写错字段。
- **WPE 反向验证**（会出声，先征得用户同意）：`ignore/p6/defs/p6a.py` 加工程 `p6a-delay`：
  - 声音 D：`random`、一个 0.5 s 的 1000 Hz 文件，`mintime` / `maxtime` 绑属性 `dmin` / `dmax`（初值 1 / 1，周期 1.5 s）；
  - 声音 S：`random`、一个 0.5 s 的 1500 Hz 文件，`mintime` / `maxtime` 挂字段脚本（`engine.runtime` 过了 8 s 返回 3，否则 1）；
  - WPE 里开窗、`rec.py` 回环录 25 s，约 8 s 时 `apply_properties` 把 `dmin` / `dmax` 改成 3；`ana_segs.py` 切段，预期两路的间隔都从 1.5 s
    变成 3.5 s，且跨过改值时刻的那一段仍是 1.5 s（正在等的不变）。
- 我们这边同一个工程导入 dev，预览里用同样的录音与分析对照；再看 `3798696286` 的预览不再退回，强制渲染下列全剩下的不支持项。

## 实施记录（2026-11-21）

- **实现**：sonnet 执行代理在独立工作树 `ignore/p6/d1/wt`（基点 `a7e1fac5`）按点 1–5 实现；验收方挪正了 `render/state.ts` 里夹在导入之间的
  `SoundValues` / `soundValuesOf`，改准 `sounds` 字段与 `targetOf` 的注释。合并进主树时只有 `features.ts` 期间被别人提交过（P4i），三方合并无冲突，
  其余 12 个文件主树与基点相同、直接拷。
- **偏差**：点 5 的宿主用例（脚本写 `mintime` 不调 `setVolume`）没写，宿主层没有现成的声音测试脚手架；宿主接 `timingOf` 由下面的真机录音兜住。
- **单测**：tsc 通过；18 个相关测试文件 486 个用例全过（主树合并后重跑同样全过）。
- **变异**（`ignore/p6/a4/mutate.py`，按原字节还原）：random 分支读编译期常量、签名仍含两键、`SceneSounds` 不传 `timingOf`、能力表仍报、
  `targetOf` 不认两键、编译期不登记 `mintime`、状态写错字段、脚本读回固定读 `volume` 8 种检出；「宿主不给 `timingOf`」单测没抓到，真机录音兜住。
- **WPE 反向验证**（`ignore/p6/defs/p6a.py` 的 `p6a-delay`，640×360 测试窗口；WPE 自己的探针频谱按运行时间、外加回环录音）：
  - S（字段脚本，8.0027 s 切到 3）：开始 … 6.15、7.66、**9.26**、12.81、16.26 …，间隔 1.50、**1.60**、3.55、3.45 …；
  - D（属性，约 14–15 s `apply_properties`）：开始 … 12.26、13.91、**15.31**、18.91、22.41 …，间隔 1.65、**1.40**、3.60、3.50 …；
  - 结论同读码：正在等的这次不变，下一次开始时读新值。
- **Kabegame 真机**（`p6a-delay` 导入为 16221；宿主产物重建进 `target-dev`——dev 现在用 `CARGO_TARGET_DIR=target-dev`；屏外宿主不跑帧循环、
  宿主音量 0，临时把 `host_open` 建的 iframe 挪进主窗口右下角 48×27、从主窗口推 `kabegame:wpe-volume` 0.5，测完 `host_close`）：
  属性在运行 8.35 s 改、脚本在 8.0152 s 切，回环录音两路同步：开始 … 5.92、**7.42**、10.92、14.46 …，间隔 1.50、**1.50**、3.50、3.54 …，与 WPE 同。
- **目标壁纸**：myprojects `3798696286` 全量编译（`exhaustive`）不支持项为空。
