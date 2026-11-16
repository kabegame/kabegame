# REA：P12e 步骤 0 —— `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer` 的原生实现（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（没实测、某个库函数的身份按形态认定、后果靠 CRT 行为推）。
> - **未知**：查到某处为止，没有结论。
>
> 地址以 `0x140000000`（exe）/ `0x180000000`（`scenescript64.dll`）为基址。汇编、字符串只当数据看。
> 结构叫法沿用 [rea-p12-runtime](rea-p12-runtime.md) / [rea-p12c-script](rea-p12c-script.md)：**L** 图像层、**P** = `L+0x4b8` puppet 运行时、**O** 模型对象、**S** = `O+0x2d8` 模型骨骼运行时、**AL** 动画层（0x198 字节）、**K** = `AL+0xf8` 时钟（`K.flags` = `AL+0x104`）、**A** mdl 动画记录（0x158 字节）、`ctx` = 对象 `+0xc8`。

## 方法

- **分析副本**：同 rea-p12c（`ignore\p9\rea\wallpaper64.exe`、`ignore\p6\rea\layers\script\scenescript64.dll`）。没开 REA，用全量反汇编 `ignore\p4\rea\wp.asm` 与 dll 的 `methodcall_214a0.asm` / `host.asm`。
- **复用的脚本**：`ignore\p12\c\rea\` 的 `slice.py` `fn.py` `keys.py` `xr.py` `gall.py`、`dll\sl.py`。
- **本轮新存的汇编**（`ignore\p12\c\rea\asm\`）：`img_buildlayer_1401fcc20.asm`（图像层建层）、`model_buildlayer_1402230c0.asm`（模型建层）、`json_merge_140018100.asm`（两个 JSON 对象合并）、`pending_drain_14018b390.asm`（帧里的待删处理，尾调延后析构）、`deferred_delete_14017e790.asm`（`ctx+0x1478` 延后析构队列的排空）。已有的 `img_create_14020ea30.asm`、`img_destroylayer_14020ef80.asm`、`imgupd_post_1402001c0.asm`、`model_create_destroy_140226d00.asm`、`mdlupd_post_14021cd30.asm` 逐条重读。
- **沿用的结论**：rea-p12-runtime 1.4 / 3.x / 5 / 6.1；rea-p12c 第 1–3、5、7 节；rea-p6d-script 第 4.3、8.2 节（方法桩 `M` 的实参转换、`0x800` 返回 `null`、包装作废）；rea-p6d-layers 3.1（对象 id 分配器）、第 1 条第 5 点（待删处理 `FUN_14018b390` 在脚本之后、渲染之前）；rea-p6b-layout / rea-p8-layer（JSON setter 的取值规则）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | `createAnimationLayer` 第一参 | dll 方法桩按形参类型 `0x600`（字符串 \| 对象）转：**字符串**原样给 UTF-8；**对象**（含数组）`JSON::Stringify` 成文本；**其它**（数字、布尔、`null`、`undefined`、缺参数）放零值空串。exe 先查「第一参非空串、`P` 与 mdl 都在」，不过就不写返回槽 → JS 得 **`null`**。字符串：在 mdl 动画表（MDLA 顺序）里按名字**逐字节、区分大小写**找**第一个**同名的，找不到 `null`；找到的记录 id 为 0 也返回 `null`。对象：把文本解析成 JSON，当作一项 `animationlayers` 交给建层函数——`animation` 必须是**数字 id**（写名字串得 `null`）。数字第一参：`null`（不当下标）。 | 字符串匹配、门控、对象路径静态确认；`null` 由 rea-p6d-script 8.2 的返回规则推出（同 `getAnimationLayer` 找不到的实测） |
| 2 | 新层的初值与 `config` | 建层函数就是加载 `animationlayers` 用的 `FUN_1401fcc20`（模型 `FUN_1402230c0`），只多两步：**`config` 里没有 `blendin` 键就写 `true`，没有 `blendout` 键就写 `true`**（有这个键、哪怕值是 `false` / `null` / 数字，都不补）；字符串路径再写 `config.animation = 记录 id`。其余全照加载：`rate 1`、`blend 1`、`visible true`、`additive false`、`blendtime 0.5`、**`name` 空串**（不取动画名）；时钟按动画自己的模式（不强制 single）、`t = 0`、在播放；**非 single 的动画随后清掉 `blendout` 位**（同一函数，这条路径照样发生）。`config` 生效的键：描述符表的 8 个（`visible` `additive` `blendin` `blendout` `name` `rate` `blend` `blendtime`，JSON setter 规则：float 只收 JSON 数、bool 只收 JSON 布尔、`name` 只收字符串，`{user/script, value}` 取 `value` 并登记绑定）、`id`、`autosort`、`index`；`animation` 在字符串路径被覆盖。`config` 是字符串时按 JSON 文本解析（`'{"rate":2}'` 有效）。对象路径里 **`config` 的键覆盖第一参对象的同名键**，所以第一参对象里的 `blendin` / `blendout` 总被 `config`（缺省 `true`）盖掉。 | 静态确认（`JSON::Stringify` 的身份沿用 rea-p6d-script 8.2） |
| 3 | 插入位置、生效帧、id | 插入照 `FUN_1401fcc20`：缺省**追加到末尾**；`config.autosort === true` / `config.index` 走 rea-p12c 第 7 节的规则（含越界写）。脚本阶段在全部对象更新之后，所以**新层下一帧才第一次推进、采样、混合**（第一帧 `t = dt·rate`），本帧 `g_Bones` 不变；新层没有 `setFrame` 位，第一次推进就做播完检测。例外：在某个 puppet 更新里派发的回调（`animationEvent`、播完回调）给**排在后面的对象**建的层，同一帧就推进。对象 id：构造时分配一个、建层函数里 `config` 没有非 0 数字 `id` 再分配一个——**共享 id 计数器前进 2**（有 `id` 时前进 1、照用给的 id）。脚本侧拿到的包装按原生指针缓存，之后 `getAnimationLayer` 拿到的是同一个 JS 对象。 | 插入、时序、计数器静态确认；包装同一性推断 |
| 4 | `playSingleAnimation` | 调 `createAnimationLayer` 拿到层后**只做一件事**：`K.flags |= 0x8000000`；返回同一个层（或 `null`）。不改模式。帧尾按各自模式的「播完」删层：**loop = 第一次回绕**（负 `rate` 时第一次推进就成立）、**mirror = 第一次换向**（到 `D`）、**single = 到头**。删层那一帧顺序：采样混合（层仍参与本帧姿势）→ 全部事件 → 逐层播完回调（**先置 `0x10000000` 再调它的回调**，回调里层仍有效）→ 删层循环当场 `delete`。`delete` 里基类析构通知 dll，**包装立即作废**：同一帧之后的脚本读字段得 `undefined`、写被忽略、调方法返回 `undefined`、`isObjectValid` 为 `false`。隐藏或暂停的单次层永远不判播完、不删。 | 静态确认；作废后的行为沿用 rea-p6d-script 4.3 |
| 5 | `destroyAnimationLayer(x)` | 形参 `0xa08`：字符串 → 名字；Int32 → 下标；有效包装 → 指针；其它（非整数、无效包装、普通对象、缺参数）→ 空串 → `false`。**名字**：空串 `false`；删掉所有 `name` 全等的层（区分大小写）。**下标**：`0 ≤ i < 层数` 删那一层，否则 `false`。**对象**：层表里有这个指针就删、`true`，没有（别的 puppet 的层、已被删的层）`false`。删除 = 立即从层表摘掉（计数、`getAnimationLayer` 当场看不到），对象进 `ctx+0x1478`，**本帧全部脚本之后、渲染之前**析构，那时包装才作废（同一帧里还能读写、调方法，但层已不在表里，什么都不影响）。**图像层按名字删有缺陷**：循环缓存了旧的 `end`，**层表最后一个层的名字匹配时**会对同一个旧指针再匹配一次、按 −8 字节长度 `memmove`——**WPE 会崩溃**；模型对象每轮重读 `end`，没有这个问题。`createAnimationLayer` 建的层缺省名字为空，按名字删不掉。 | 匹配、返回值、时机静态确认；崩溃为推断（`memmove` 长度 `0xFFFFFFFFFFFFFFF8`） |
| 6 | 删层后的蒙皮 | 被删的层从删除后的下一次更新起就不在循环里，不再推进、不参与混合。全部删光（或剩下的都不可见）时走「一个可见层都没处理」的分支：局部矩阵**直接取静止来源矩阵**，语料下 `K = 单位`（rea-p12-runtime 6.1 / 6.2）；骨骼透明度（网格 bit2）、变形权重每帧复位，所以也回到静止值；**`g_BlendMap`（纹理通道）帧首不复位**，保持删层前最后写下的值。 | 静态确认（沿用 rea-p12-runtime、P12b1 / P12b2 的帧首复位规则） |
| 7 | 模型对象 | `0x140226d00` / `0x140227220` / `0x140227260` 与图像层逐指令同构，差别：门控换成「`S` 非空、mdl（`O+0x2e8`）非空且 `*mdl` 非空」；动画表取 `mdl+0xc0`（与 `P+0xc8` 同一份数据）；建层调 `FUN_1402230c0`（键与插入规则逐条相同，同样清非 single 的 `blendout`）；**按名字删每轮重读 `end`，没有图像层的崩溃**；模型或父链不可见时整个更新冻结，单次层不推进、不删。 | 静态确认 |

**对已有文档的更正 / 补充**：
- **rea-p12c 3.3「迟到的回调」**：播完回调循环（图像层 `0x1402002f6`、模型 `0x14021ce69`）**每调过一层的回调就把下标复位成 0**（`mov ebx, r15d` / `mov r9d, r13d`，这两个寄存器恒为 0），再 `++` 从下标 1 重新扫。已处理的层 `0x4000000` 已清，不会重复调；回调里删 / 插层导致的位移因此**不会**漏掉后面的层。只有「待处理的层被挤到下标 0」（例如下标 0 的层在自己的回调里删掉自己，后面那层移到 0）才漏到以后某一帧。
- **rea-p12c 第 1 条概括、3.3 与 attach-physics 4.5「按名字删所有同名层」**：模型成立；图像层在最后一层匹配时崩溃（第 5 节）。
- **rea-p12c 4.1「运行时 `createAnimationLayer` 的 `config` 里带 `{"script": …}`」**：入口确实会登记（`FUN_1401730d0` 照常建绑定），作用域与 `init` 仍没查（见「没查清的」）。

---

## 1. 方法桩怎么转实参（dll `M` `0x1816214a0`，静态确认）

方法表（rea-p12c 1.1）：`createAnimationLayer` / `playSingleAnimation` 形参 `0x600, 0x600`、返回 `0x800`；`destroyAnimationLayer` 形参 `0xa08`、返回 `2`。

```c
// 每个声明的形参各放一个值（缺的也放），exe 收到的 argc 恒等于声明的形参个数（create 恒为 2）
for (i = 0; i < 形参数; i++) {
    mask = 形参类型[i]; v = (i < JS 实参数) ? arg[i] : 缺;
    if (mask & 0x200 && v 是 String)              { 值 = UTF-8 拷贝; 码 = 0x200; }   // 0x1816215a4
    else if (mask & 2 && IsBoolean(v))            ...
    else if (mask & 8 && IsInt32(v))              { 值 = int; 码 = 8; }            // 有限、整数、不是 −0
    else if (mask & 4 && IsNumber(v))             ...
    else if (mask & 0x400 && IsObject(v) && (s = JSON::Stringify(v)))   // 0x181621958：数组也是对象
                                                  { 值 = UTF-8(s); 码 = 0x400; }
    ...
    else if (mask & 0x800 && IsObject(v) && U(v)) { 值 = 原生指针; 码 = 0x800; }  // U：包装未作废
    else /* 0x181621adb */ if (mask & 0x200)      { 值 = ""; 码 = 0x80000200; }   // 0x600、0xa08 都落到这里
}
ret = 0; native(obj, 形参数, 码[], 值[], &ret, &err);
// 返回 0x800：ret == 0 → null（0x181622f13），否则 W(ret)（按指针缓存的包装）
// 返回 2：ret 是一个字节，初值 0 → false
```
- `Stringify` 抛错（循环引用、BigInt）时也落到空串【静态确认分支；触发条件按 V8 语义】。
- 所以：`createAnimationLayer(5)` / `(true)` / `()` / `(null)` / `('')` 到 exe 都是空串 → `null`；`destroyAnimationLayer(1.5)` / `({})` / `(旧包装)` 都是空串 → `false`。

## 2. `createAnimationLayer`（图像层 `0x14020ea30`，静态确认）

```c
void IImageLayer_createAnimationLayer(L, int argc, u32* code, void** val, AL** ret, err) {
    const char* a0 = val[0];
    if (a0[0] == 0) return;                          // 0x14020ea4d：空串（含所有非字符串非对象）
    if (!L->P || !L->P->mdl /* P+8 */) return;       // 不是 puppet
    if (argc < 1) return;                            // 恒为 2，不会触发

    Json::Value config;                              // null
    if (argc > 1) parseJson(string(val[1]), config); // 0x140017840：不看 code[1]——字符串按 JSON 文本解析，
                                                     //   对象是 Stringify 的文本；空串 / 非 JSON 解析失败，config 保持 null
    if (!config.find("blendin"))  config["blendin"]  = true;   // 0x14020eb31：只看「有没有这个键」
    if (!config.find("blendout")) config["blendout"] = true;   // 0x14020ec2a
                                                     // operator[] 把 null 变成 object；config 若解析成数 / 串 / 数组，
                                                     //   find / operator[] 不查类型 → 未定义行为（推断：崩溃）

    if (code[0] & 0x200) {                           // 字符串：按名字找动画
        for (A = P->anims.begin /* P+0xc8 */; A != end; A += 0x158)
            if (A->name /* +8, std::string */ == a0) goto found;   // 0x14000d010：长度 == strlen 且 memcmp，区分大小写
        return;                                      // 找不到 → null
    found:
        if (A->id == 0) return;                      // 0x14020ed64：id 为 0 的动画按名字建不了
        config["animation"] = (Json::UInt64)A->id;   // 类型 2（uint），覆盖 config 里原有的 animation
        *ret = FUN_1401fcc20(L, config);             // 建层函数再按 id 找记录：取第一个同 id 的（两条动画 id 相同时可能不是按名字找到的那条）
    } else if (code[0] & 0x400) {                    // 对象（Stringify 文本）
        Json::Value item;                            // null
        parseJson(string(a0), item);
        mergeInto(item, config);                     // 0x140018100：两者都是 object 才合并；对 config 的每个键 item[k] = config[k]
        *ret = FUN_1401fcc20(L, item);               // item.animation 不是数 → 0 → null
    }
}
```
- 多个同名动画：取 mdl 动画表（MDLA 顺序）里**第一个**。名字含 `\0` 时按 C 串截断比较。
- `0x140017840` 返回「解析成功且是 array / object」，调用方不看返回值；解析失败时 `config` 停在 jsoncpp 已经填进去的部分（`'{"rate":2, x'` 可能留下 `rate`）【推断：jsoncpp `OurReader` 边解析边写】。
- `mergeInto` 方向：`rcx` = 第一参对象、`rdx` = `config`，遍历 `config` 的键写进第一参对象（`0x140018150`–`0x14001819c`）。所以 `createAnimationLayer({animation: 3, blendin: false})` 得到的层 `blendin` 为 `true`（`config` 缺省补的 `true` 覆盖了它）；要关淡入只能写在 `config` 里。

### 2.1 建层函数 `FUN_1401fcc20(L, json)`（重读，静态确认）

```c
AL* buildLayer(L, Json::Value& j) {
    a = j.find("animation"); if (!a || a->type ∉ {int, uint, real}) return 0;
    autosort = j.find("autosort"); index = j.find("index");
    id = a->asUInt64();
    for (A : P->anims) if (A->id == id) goto ok;     // 第一个同 id
    return 0;
ok:
    AL = new AL(ctx);        // FUN_14026c680：rate 1、blend 1、bits 1（visible）、name ""、blendtime 0.5、
                             //   K 清零、回调表空；FUN_1401a38f0(AL+8, null)：分配一个自动 id
    FUN_1401a38f0(AL+8, &j); // j.id 是非 0 数：照用（不查重）；否则再分配一个自动 id
    AL->anim = A;            // +0x128
    FUN_1401a8c10(A->mode /* +0x28 串 */, A->fps, A->length, &AL->K, random = 0, startpaused = 0);
    AL->K.events = A->events;                      // +0x120 的整表拷贝
    FUN_1401730d0(ctx+0x1708, AL, j);              // 逐键套描述符的 JSON setter（含绑定登记）
    if (!(AL->K.flags & 2 /*single*/)) AL->bits &= ~8;   // 0x1401fd068：清 blendout
    插入 P+0x3d0（rea-p12c 第 7 节：autosort === true / index 是数 / 追加）
    return AL;
}
```
- JSON setter（描述符 `+8`，每个字段一个；`0x1401a4b00` float、`0x14019bfa0` 等 bool、`0x1401a4bc0` string）：
  - float（`rate` `blend` `blendtime`）：JSON 类型 1–3 → `asFloat`；其它不写；
  - bool（`visible` `additive` `blendin` `blendout`）：只认 JSON 布尔（类型 5）；
  - string（`name`）：只认 JSON 字符串（rea-p6b-layout）；
  - 值是对象（类型 7）时取它的 `value` 按上面规则写，并经 `FUN_1401a4db0` 登记 `user` / `animation` / `script` 绑定；
  - 写完调描述符的改值回调（这 8 个都没有）。
- 由此 `config` 里的 JS 值经 `JSON.stringify` 再过 setter：`rate: NaN` / `Infinity` → JSON `null` → **不写**（和脚本写属性收 `NaN` 不同）；`rate: '2'` 不写；`visible: 1` 不写；`name: 5` 不写（`name` 只收串，和脚本写属性的 `ToString` 不同）；`undefined` 与函数被 `Stringify` 丢掉。
- **新层的初值**（字符串路径、`config` 为空）：

  | 字段 | 值 |
  |---|---|
  | `rate` / `blend` / `blendtime` | 1 / 1 / 0.5 |
  | `visible` / `additive` | `true` / `false` |
  | `blendin` | `true`（`config` 缺省补的） |
  | `blendout` | single 动画 `true`；loop / mirror `false`（补了又被清掉） |
  | `name` | `""` |
  | 时钟 | 动画自己的模式，`t = 0`，在播放（`isPlaying()` 为真），没有 `SETFRAME` 位 |
  | 事件 | 动画的 MDLA 事件表照拷，`animationEvent` 照常派发 |

## 3. 插入位置与生效帧（静态确认）

```text
帧函数 FUN_14017fa70
  对象更新 FUN_1401891a0：按对象表顺序调 +0x48
      图像层 FUN_1401fdf90 / 模型 FUN_14021c480：层循环（推进、播完检测、采样、混合）
        → 事件 animationEvent → 播完回调 → 删单次层 → 骨骼矩阵 / 蒙皮
  相机 …
  脚本 FUN_140171440（媒体、关键帧、计时器、update）     ← createAnimationLayer 通常在这里
  待删处理 FUN_14018b390 → 尾调 0x14017e790 排空 ctx+0x1478（destroyAnimationLayer 的层在这里析构）
  渲染（上传 g_Bones）
```
- 脚本阶段建的层：本帧的骨骼矩阵已经算完，**下一帧的对象更新才第一次推进**（`t = dt·rate`，权重按 `blendin` 从 `t / min(D/2, blendtime)` 起）。
- `animationEvent` / 播完回调在某个 puppet 的更新里同步派发：给**对象表里排在后面**的 puppet 建的层，同一帧就会被那个 puppet 的更新推进；给自己或排在前面的建，下一帧。
- 新层插进层表后才参与「顺序」相关的一切：采样混合顺序、`getAnimationLayer(下标)`、播完回调的扫描顺序。
- 第一次推进照常做播完检测（`old` 没有 `0x62000000` 中的任何一位），所以 `rate` 很大或 `D` 很短时第一帧就可能「播完」。
- **对象 id**（`FUN_1401a38f0`，rea-p6d-layers 3.1）：两次调用各从 `ctx+0x1c88` 的计数器 `++` 起找第一个没占用的数。`config` 没有 `id` 时一次建层计数器前进 2，会推后之后 `thisScene.createLayer` 新图层的自动 id。动画层的 `id` 脚本读不到（属性表里没有）。

## 4. `playSingleAnimation`（图像层 `0x14020ef40`、模型 `0x140227220`，静态确认）

```c
void playSingleAnimation(L, argc, code, val, AL** ret, err) {
    createAnimationLayer(L, argc, code, val, ret, err);
    if (*ret) (*ret)->K.flags |= 0x8000000;        // 0x14020ef67
}
```

帧内（图像层 `0x1401fed50` 起、`0x1402001de` 起；模型同构）：
```c
anyEnded = false;
for (i = 0; i < count(P+0x3d0); i++) {
    AL = P+0x3d0[i];
    if (!(AL->bits & 1)) continue;                 // 隐藏：不推进、不检测 → 单次层永远不删
    old = K.flags; t0 = K.t;
    FUN_1401a9f60(dt * AL->rate, &K, &events);
    if (!(old & 0x62000000)) {                     // 暂停 / 已结束 / setFrame 当帧：不检测
        ended = single ? (K.flags & 0x40000000)    // 刚到头
              : mirror ? ((old ^ K.flags) >> 31)   // 第一次换向
              :          (t0 > K.t);               // 第一次回绕（负 rate：每次推进都成立）
        if (ended) { K.flags |= 0x4000000; anyEnded = true; }
    }
    K.flags &= ~0x2000000;
    w = FUN_14026c8b0(AL); 采样、混合 ...          // 播完的这一帧层仍参与本帧姿势
}
for (e : events) animationEvent(L, e);              // 0x140200201
if (anyEnded) {
    for (i = 0; i < count(P+0x3d0); i++) {          // 每轮重读层数
        AL = P+0x3d0[i];
        if (!(K.flags & 0x4000000)) continue;
        K.flags &= ~0x4000000;
        if (K.flags & 0x8000000) K.flags |= 0x10000000;    // 先标删，再调回调
        if (!AL->callbacks.empty()) {
            CallEndedCallbacks(AL->callbacks);      // FUN_140177bf0 → 引擎槽 12
            i = 0;                                  // 0x1402002f6 / 0x14021ce69：复位，++ 后从 1 重扫
        }
    }
    for (i = 0; i < count(P+0x3d0); i++)
        if (P+0x3d0[i]->K.flags & 0x10000000) {
            delete P+0x3d0[i];                      // 0x140200371：虚析构，当场释放
            P+0x3d0.erase(i); i--;
        }
}
```
- **「播完」随模式**：loop 动画用 `playSingleAnimation`，第一次回绕就删；mirror 第一次到 `D` 换向就删；single 到头删。删层那一帧采样用的是推进**之后**的 `t`：loop 回绕后的 `t` 很小，这一帧画的是开头附近的姿势（loop 的 `blendout` 已清，`blendin` 早淡完，权重满），下一帧层没了，姿势跳回其余层 / 静止姿势；single 到头时 `blendout` 还在，`t = D` 时权重为 0，衔接平滑。
- **回调与删层同帧**：带 `0x8000000` 的层播完那一帧，先调它的 `addEndedCallback`（回调里层完好：可读 `getFrame()`、`isObjectValid` 为真），回调返回后马上删。回调里 `play()` / `setFrame()` 救不回来（`0x10000000` 已置）。回调里 `destroyAnimationLayer(这层对象)`：层先从表里摘掉、进 `ctx+0x1478`，删层循环看不到它，于是它延后到帧尾析构（不会重复释放）。
- **删后的包装**：析构链 `FUN_14026c7e0` → 引擎槽 13 释放回调结构 → `FUN_140176f70(…, AL, 0)` 给动画层字段脚本发 `destroy` → 基类析构 `0x1401a3b60` 调包装登记的监听，dll 把包装从序号表删掉。之后（rea-p6d-script 4.3）：字段读 `undefined`、字段写忽略、方法（含 `addEndedCallback`、`play`）不调、返回 `undefined`、`engine.isObjectValid(层)` 为 `false`，都不抛错；作 `0x800` 参数（`destroyAnimationLayer(旧层)`）转换失败 → `false`。单次层在对象更新里析构，**本帧的脚本已经看到作废**。

## 5. `destroyAnimationLayer`（图像层 `0x14020ef80`，静态确认）

```c
void destroyAnimationLayer(L, argc, code, val, bool* ret /* 初值 false */, err) {
    if (!L->P || !L->P->mdl) return;
    if (code[0] & 0x200) {                          // 名字（含 dll 给的空串）
        s = val[0]; if (!s[0]) return;              // 空串 → false
        it = begin; END = end;                      // ← 图像层只取一次（0x14020efd9）
        while (it != END) {
            if ((*it)->name == s) {                 // 区分大小写
                ctx+0x1478.push_back(*it);          // 延后析构
                memmove(it, it + 1, cur_end - (it + 1));   // cur_end 是当前的 end
                cur_end -= 1; *ret = true;          // it 不前进
            } else it++;
        }
    } else if (code[0] & 8) {                       // Int32 下标
        i = *(int*)val[0];
        if (i < 0 || i >= count) return;            // false
        ctx+0x1478.push_back(layers[i]); erase(i); *ret = true;
    } else if (code[0] & 0x800) {                   // 包装
        p = val[0]; if (!p) return;
        for (it : layers) if (*it == p) { push; erase(it); *ret = true; break; }   // 只删第一个（也只可能有一个）
    }
}
```
- **图像层的缺陷**：循环条件比的是开始时的 `END`。每删一个，表尾多出一个没被清掉的旧槽（内容是原来的最后一个层指针），循环会继续检查这些旧槽：
  - 原表最后一个层**不**匹配：旧槽里是它，不匹配，循环正常走完；结果正确。
  - 原表最后一个层**匹配**：它被删后（`memmove` 长度 0），`it` 停在同一槽、`it != END`，同一个指针再匹配一次：再 `push_back`（重复）、`memmove` 长度 = `cur_end − (it + 1)` = **−8**，即 `0xFFFFFFFFFFFFFFF8` 字节 → 访问越界【推断：WPE 崩溃；即使侥幸没崩，延后队列里同一指针两次，帧尾重复 `delete`】。
  - 所以「只有一个层、按它的名字删」「删 `createAnimationLayer` 后又改了名的层」这类最常见的写法都会触发。
- 模型（`0x140227260`）：循环条件每轮读 `[S+0x80]`（`0x14022733d`），按名字删所有同名层，没有缺陷。
- **时机**：从层表摘掉是当场的（`getAnimationLayerCount()` 立刻少、按名字 / 下标拿不到）；对象在本帧 `FUN_14018b390` 末尾（全部脚本之后、渲染之前，**每帧都排空**，`Pd` 为空时也尾调）析构，那时包装作废、字段脚本收 `destroy`。同一帧里旧包装照常可读写、调方法，但层已不在表里，对姿势没有任何影响；本帧之后作废，规则同第 4 节。
- 在 `animationEvent` / 播完回调里删（对象更新阶段）：同样延后到本帧脚本之后；本帧的脚本仍能读这个包装。
- 返回值：删掉至少一个为 `true`，否则 `false`；没有 `P` / mdl 时 `false`。

## 6. 删层对蒙皮的影响（静态确认，沿用 rea-p12-runtime）

- 删除后的那次更新起，层不在 `P+0x3d0` 里，循环不碰它：不推进、不收事件、不检测播完、不参与混合与标量轨道。
- 第一个**可见**层的来源是静止 SoA，之后是上一层的结果（rea-p12-runtime 5.2）；删掉第一层后，原来的第二层改成从静止姿势混合（`blend < 1` 时姿势会变）。
- 一个可见层都没有（全删光或剩下的都隐藏）：`r14 & 1 == 0`，局部矩阵直接取 `P+0x50[i]`（空就是 MDLS 局部矩阵），不经分解（rea-p12-runtime 6.1）。语料静止姿势 = 绑定姿势，`K = 单位`。
- 标量：骨骼透明度在网格 bit2 时每帧先置 1、变形权重每帧复位（P12b1），所以也回到静止；纹理通道 `g_BlendMap`（P12b2-2）帧首不复位，**保持删层前最后的值**。
- 删层那一帧本身（单次层）：层已经参与了这一帧的姿势（第 4 节），差别从下一帧开始。

## 7. 模型对象（`model_create_destroy_140226d00.asm`、`model_buildlayer_1402230c0.asm`，静态确认）

| 项 | 图像层 | 模型 |
|---|---|---|
| 门控 | `P && P->mdl` | `S (O+0x2d8) && mdl (O+0x2e8) && *mdl` |
| 动画表 | `P+0xc8` | `mdl+0xc0`（同一份数据） |
| 建层 | `FUN_1401fcc20`，插 `P+0x3d0` | `FUN_1402230c0`，插 `S+0x78`；`animation` / `autosort` / `index` 三个键、`0x14026c680` 构造、`0x1401730d0` 套用、清非 single 的 `blendout`（`0x140223551`）逐条相同 |
| `config` 补 `blendin` / `blendout`、对象路径合并 | 同 | 同 |
| `playSingleAnimation` | `or [AL+0x104], 0x8000000` | 同（`0x140227247`） |
| 按名字删 | 缓存 `end`，最后一层匹配时崩溃 | 每轮重读 `end`，正确 |
| 下标 / 对象删 | 同 | 同 |
| 更新门 | 不看可见性（静态 puppet——第一个网格没有 `a_BlendIndices`——整段不跑） | 对象或父链不可见时整段冻结：单次层不推进、不删，事件、回调不发 |
| 播完回调循环的复位 | `i = 0`（`0x1402002f6`） | 同（`0x14021ce69`） |

- 图像层的另一个边界：静态 puppet（P 在、mdl 在，但第一个网格没有蒙皮属性）过得了 `createAnimationLayer` 的门，层会建出来、计数加一，但每帧更新整段跳过，永远不推进、不删【静态确认：两处门不同】。

---

## 对实现的含义

### 数据
- **动画来源**：`createAnimationLayer(名字)` 能引用 mdl 里任何一条动画，`layerDefs` 现在只转换 `animationlayers` 用到的（`used`）。脚本里用到这三个方法的场景要把该 puppet 的**全部** MDLA 动画转好（名字、id、模式、帧数据、事件、透明度 / 变形 / 通道轨道），名字查找在运行时按 MDLA 顺序取第一个、逐字节比较。可以只在 `scriptApi` 扫到这三个方法时多转。
- **层的身份**：现在 `SceneState.animationLayers` 与 `IAnimationLayer` 包装都按 `<对象>:<层下标>` 记，运行时插入 / 删除会让下标漂移。改成每层一个稳定 id（运行时分配，编译期层用 `entry` 起始），状态、包装缓存、字段脚本目标（`animation-layer`）都按它找；层表（顺序）另存。重编译时保留：运行时建的层（含它们的时钟、字段、回调）、删过的编译期层、顺序，同 P10 / P12c 的接回。
- 现有 `PuppetLayerDef.bindings`（用户属性）只属于编译期层。运行时层的 `config` 里出现 `{user|script|animation: …}` 时语料 0 处，取 `value`、绑定照报或忽略（见「没查清的」）。

### `createAnimationLayer(animation, config)`
```ts
createAnimationLayer(a0: unknown, cfg: unknown): IAnimationLayer | null {
  if (!puppet) return null;                                   // 非 puppet；WPE 对静态 puppet 也建（语料 0，可照报）
  const text0 = typeof a0 === "string" ? a0 : isObject(a0) ? tryStringify(a0) ?? "" : "";
  if (text0 === "") return null;
  let config: Json = typeof cfg === "string" ? parseJsonLoose(cfg) : isObject(cfg) ? roundtrip(cfg) : null;
  if (config !== null && !isPlainJsonObject(config)) return null;   // WPE 未定义行为（数 / 串 / 数组），按失败处理（有意不同）
  config ??= {};
  if (!("blendin" in config)) config.blendin = true;          // 只看键在不在
  if (!("blendout" in config)) config.blendout = true;
  let item: Json;
  if (typeof a0 === "string") {
    const anim = animations.find((x) => x.name === a0);       // 第一个、区分大小写
    if (!anim || anim.id === 0) return null;
    item = { ...config, animation: anim.id };
  } else {
    item = roundtrip(a0);                                     // JSON.parse(JSON.stringify(a0))
    if (!isPlainJsonObject(item)) return null;
    Object.assign(item, config);                              // config 覆盖第一参
  }
  return buildLayer(item);                                    // 与加载 animationlayers 同一个函数
}
function buildLayer(j): Layer | null {
  if (typeof j.animation !== "number") return null;
  const anim = animations.find((x) => x.id === toUInt64(j.animation)); if (!anim) return null;
  const L = { rate: 1, blend: 1, visible: true, additive: false, blendin: false, blendout: false, blendtime: 0.5, name: "",
              clock: new AnimationClock(anim.mode, anim.fps, anim.length), events: anim.events, callbacks: [] };
  applyJsonSetters(L, j);    // float：typeof number（JSON 里没有 NaN）→ f32；bool：typeof boolean；name：typeof string；
                             // 对象取 .value 同规则
  if (anim.mode !== SINGLE) L.blendout = false;
  insert(L, j.autosort, j.index);                             // rea-p12c 第 7 节；越界的两种情况：autosort 插开头、index 追加（有意不同）
  idAllocator.skip(typeof j.id === "number" && j.id ? 1 : 2); // 只在实现 createLayer 的自动 id 时需要
  return L;
}
```
- 生效：脚本阶段插进表，下一帧 `frame` 才推进；在 `puppetHooks` 的回调里建时，按对象顺序决定当帧是否推进（我们的 `ScenePuppets.frame` 按对象顺序逐个 puppet 推进再派发，只要回调里的写入直接进运行时就自然一致）。
- 返回的包装与之后 `getAnimationLayer` 拿到的是同一个对象（按层 id 缓存）。

### `playSingleAnimation`
- 同上建层，层上记 `single = true`（`0x8000000`）。
- `ScenePuppets.frame` 的派发段改成：事件 → 回调循环（清 `ENDED`；`single` 的先标 `doomed` 再调回调；调过回调后 `i = 0` 再 `++`，照 WPE 从 1 重扫）→ 删 `doomed` 的层（从表里摘掉、释放、包装作废）。删层在派发之后、蒙皮之前，所以这一帧姿势仍含这层。

### `destroyAnimationLayer`
```ts
destroyAnimationLayer(x: unknown): boolean {
  if (!puppet) return false;
  let hit: Layer[] = [];
  if (typeof x === "string") { if (x === "") return false; hit = layers.filter((l) => l.name === x); }   // 有意不同：WPE 图像层最后一层匹配时崩溃，我们照删
  else if (isInt32(x)) { if (x >= 0 && x < layers.length) hit = [layers[x]]; }
  else if (isValidLayerWrapper(x)) { const l = layerOf(x); if (layers.includes(l)) hit = [l]; }
  else return false;   // 1.5、{}、作废的包装
  for (const l of hit) { remove(l); pendingDestroy.push(l); }
  return hit.length > 0;
}
```
- `pendingDestroy` 在本帧全部脚本之后、渲染之前统一释放并作废包装（同 P6d3a `destroyLayer` 的帧尾），被删的层若有字段脚本同时收 `destroy`（语料 0）。
- 图像层按名字删在最后一层匹配时 WPE 崩溃：我们照「删所有同名层」做，记为有意不同；可以记一条 warn 方便对照。

### 作废的包装
- 读字段 `undefined`、写忽略、方法返回 `undefined`、不抛错；`engine.isObjectValid` 为 `false`。复用 P6d3a 图层包装的作废机制，不另写一套。

### 蒙皮
- 不用改：层表空或全隐藏时已有「直接取静止来源矩阵」的分支；`g_BlendMap` 本来就不复位。

### 模型
- 同一套，层表换成模型运行时的；按名字删不涉及 WPE 的缺陷。模型不可见时 `frame` 已整段跳过，单次层自然不删。

## 建议实测

> 全部在测试工程里做，用 `[kbp]` 日志；**不要**在共享 WPE 上跑「按名字删最后一层」的图像层用例（预测崩溃），要验证就只在模型对象上做，或让匹配的层不在最后。

1. **初值与名字**（puppet 图像层，`init` 里）：`const l = thisLayer.createAnimationLayer('<loop 动画名>')`；打印 `l === null`、`l.name`（预期 `""`）、`rate` `blend` `visible` `additive` `blendin`（`true`）`blendout`（`false`）`blendtime`、`isPlaying()`、`getAnimationLayerCount()` 增 1、`thisLayer.getAnimationLayer(count − 1) === l`（同一对象）。对 single 动画再建一个：`blendout` 预期 `true`。
2. **查找规则**：大小写不同的名字、不存在的名字、`5`、`true`、`''`、`null`、`{animation: '<名字>'}`、`{animation: <id>}` 各一次，打印是否 `null`（预期只有最后一个非 `null`）；mdl 里有同名动画时，看建出来的 `frameCount` 是哪一条的。
3. **`config` 的覆盖方向**：`createAnimationLayer({animation: <id>, blendin: false})` → 预期 `blendin === true`；`createAnimationLayer({animation: <id>}, {blendin: false})` → `false`；`createAnimationLayer('<名字>', '{"rate":2,"name":"x"}')` → `rate 2`、`name 'x'`；`{rate: NaN}`、`{name: 5}` → `rate 1`、`name ''`。
4. **插入**：`config` 带 `{index: 0}` / `{autosort: true}`（puppet 已有一个非加法层）时，`getAnimationLayer(0)` 是谁。
5. **生效帧**（RenderDoc，`g_Bones`）：在 `update` 里于某一帧建层，抓建层那一帧与下一帧：预期建层帧不变、下一帧起有贡献（`blendin` 从 `dt / min(D/2, 0.5)` 起淡入）。
6. **单次层**：loop 动画 `playSingleAnimation`，`addEndedCallback` 里打印 `getFrame()`、`engine.isObjectValid(l)`；之后每帧在 `update` 里打印 `typeof l.rate`、`l.play()` 的返回值、`engine.isObjectValid(l)`、`getAnimationLayerCount()`。预期：回调恰一次、在第一次回绕那一帧；回调里有效；**同一帧**的 `update` 里已作废（`undefined`、`false`）、计数已减。mirror 动画同测（第一次到 `D`）。
7. **`destroyAnimationLayer` 的时机**：建两层 A、B（B 在最后），`update` 里 `destroyAnimationLayer(0)`（删 A），同一帧打印 `A.getFrame()`、`engine.isObjectValid(A)`（预期仍有效）、`getAnimationLayerCount()`（预期已减）；下一帧再打印（预期作废）。再测 `destroyAnimationLayer(A)`（对象）、`destroyAnimationLayer(-1)` / `(99)` / `(1.5)`（预期 `false`）、`destroyAnimationLayer(A)` 第二次（`false`）。
8. **按名字删**：只在模型对象上，或保证匹配层不在最后：`[A(name 'x'), B(name 'y')]` 删 `'x'` → `true`、剩 B。
9. **回调循环复位**（可选）：两层同帧回绕、都有回调，A 的回调里 `destroyAnimationLayer(A)`（对象）：预期 B 的回调本帧不调、要等以后某一帧有层回绕时才调（下标 0 漏扫）；换成 B 先回绕则都在本帧调。

## 没查清的

1. **图像层按名字删的后果**：静态看是 `memmove` 长度 −8 与重复入队；没实测 WPE 是否被 SEH 兜住（不建议在共享 WPE 上测）。
2. **运行时 `config` 里的绑定**：`{user: …}` 会登记用户属性绑定（加载期之外的登记是否被属性面板的后续改值驱动、`{script: …}` 的作用域与 `init` 时机）都没追；语料 0 处。
3. **`config` 解析成非对象**（`'5'`、`'"s"'`、`'[1]'`）：jsoncpp 的 `find` / `operator[]` 不查类型，按读码会把标量当 map 指针用，后果未实测。
4. **`asUInt64` 的越界**：对象路径里 `animation` 是负数或 ≥ 2⁶⁴ 的浮点时 jsoncpp 的断言是否编进了 release（`0x1402cb964` 带文件名与行号，像 `_wassert`），没核对。
5. **id 分配器**：构造时那一个自动 id 在第二次分配后是否仍占在「已用」集合里没读完（`0x1401a3a40` 之后的哈希表插入），只确认计数器各 `++` 一次。
6. **包装同一性**：`createAnimationLayer` 返回的包装与之后 `getAnimationLayer` 拿到的是同一个 JS 对象，依据是 `W` 按指针缓存（rea-p6d-script 第 6 节），没实测。
7. **静态 puppet 上建层**：WPE 会建、不推进；`getAnimationLayerCount()` 会因此变大，实测没覆盖。

## 实测（2026-11-16，WPE 2.8.42）

工程 `ignore/p12/e/proj/p12-create`（生成脚本 `ignore/p12/e/defs/p12e.py`，`kbp gen p12e --data ignore/p12/e --defs ignore/p12/e/defs`），日志 `ignore/p12/e/logs/step0.log`（本次运行的全部 `[kbp]` 行，545 行），抓帧 `A:\p12e\step0\`。WPE 全程没崩、没有别的报错。建议实测 1–4、6–9 全部和上面的读码一致：

| 用例 | 实测 |
|---|---|
| 1 初值 | 名字 `""`、rate 1、blend 1、visible 真、additive 假、`blendin` 真、`blendout` 只在 single 动画为真、blendtime 0.5、在播放、`getFrame()` 0；计数加一；`getAnimationLayer(count − 1) === l` 为真（包装同一）；`getAnimationLayer('')` 为 `null`。`IAnimationLayer.id` 读得 `undefined`。 |
| 2 查找 | `'loopa'` / `'LOOPA'` / 不存在 / `5` / `0` / `true` / `''` / `null` / `undefined` / 不带参数 / `{animation: 'loopA'}` / `{animation: '900'}` / `{animation: 12345}` 都是 `null`；`{animation: 900}`、`{animation: 900.5}`（取整）成功；`'dup'` 取 MDLA 里第一条（frameCount 10）；对象第一参里的 `name` / `rate` 生效。 |
| 3 config | 第一参对象写 `blendin: false` 被缺省 `true` 盖掉；`config` 的 `blendin: false`、`rate: 2` 盖过第一参；`'{"rate":2,"name":"x"}'` 文本生效；`rate: NaN`、`name: 5`、`rate: '3'`、`blend: true`、`visible: 0`、`additive: 'yes'` 都不写；`visible: false` / `additive: true` / `blend 0.5` / `blendtime 2` 生效；single 动画 `blendout: false` 生效，loop 动画 `blendout: true` 被清掉；`config` 为数字 `5` 同缺省。 |
| 4 插入 | `index: 0` 插到 0、`index: 2` 插到 2；`index: -3` 与 `999` 都插在最后一层之前（下标 = 层数 − 1）；`autosort: true` 插在末尾两个加法层之前。 |
| 生效帧 | `update` 第 3 帧建的层当帧 `getFrame()` 0，下一帧 = 下一帧的 `dt × fps`（只推进一次）。 |
| 6 单次层 | single（D 1.5 s）：到头那一帧调回调（层有效、`getFrame()` 15、计数未减、0 个参数），同一帧 `update` 里已作废（读 `undefined`、`isObjectValid` 假）、计数已减。loop：第一次回绕那一帧（回调里 `getFrame()` 0.29），mirror：第一次换向那一帧（19.7）。隐藏的层不推进、永不删；暂停的层不删；回调里 `play()` + `setFrame(0)` 救不回来；`playSingleAnimation({animation: 902}, {name})` 没有回调也照删。 |
| 7 destroy | `destroyAnimationLayer(0)` → `true`、计数立即减、`getAnimationLayer(0)` 是下一层、按名字找不到；同一帧旧包装可读（`getFrame()` 有值、有效），下一帧作废。按对象删成功；同一帧再删同一对象、`-1`、`99`、`1.5`、`''`、`'zzz'`、`{}`、已作废的包装、`null`、`'1'` 都是 `false`。 |
| 8 按名字 | `[B, D, x, x, tail]` 删 `'X'` → `false`；删 `'x'` → `true`，两个相邻的 `x` 都删掉，剩 `[B, D, tail]`；同一帧包装可读、下一帧作废。（最后一层不匹配，没碰崩溃组合。） |
| 9 回调循环 | cb1（A 的回调里删 A）：A 回调后 B 的回调本轮漏掉，下一次回绕（4 s）才调，之后每 2 s 一次；cb2（不删）：A、B 每次同帧都调。 |

g_Bones 的生效帧与删层后的姿势留给实现后的整帧对照。
