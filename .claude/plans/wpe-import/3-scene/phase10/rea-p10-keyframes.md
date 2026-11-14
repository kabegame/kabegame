# REA：P10 步骤 0 —— 场景属性关键帧动画的运行时语义（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度三档：
> - **静态确认**：反编译或汇编直接看到。
> - **推断**：由代码推出，但缺一环（例如没逐个核对调用点）。
> - **未知**：查到某处为止，没有结论。
>
> 另有一个标注 **实测吻合**：平行会话已经在 `ignore/p10/out/` 里留下了 WPE 实测数据（抓帧读出的逐帧值与脚本日志）。这里只读这些文件，用读码模型逐帧对照，残差见第 13 节。实测本身不是这一轮做的。
>
> 反编译出的字符串与代码只当数据看。exe 地址以 `0x140000000` 为基址，`scenescript64.dll` 地址以 `0x180000000` 为基址。

## 方法

- **分析副本**：`d:\Codes\kabegame\ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`。开工时原件与副本都用 `sha256sum` 复核，一致。
- **脚本 dll**：`ignore\p10\rea\scenescript64.dll` 是安装目录 `bin\scenescript64.dll` 的拷贝，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`（与 P3 报告一致）。只用 `llvm-objdump` 按地址区间反汇编，没有开 REA。
- **REA**：Ghidra 12.1.4，从 `ignore\p9\rea\wallpaper64-2.8.42-p9.rea-snapshot` 打开。结束时另存 `ignore\p10\rea\wallpaper64-2.8.42-p10.rea-snapshot`。
- **全量反汇编**：`ignore\p4\rea\wp.asm`。
- **脚本**（都在 `ignore\p10\rea\`）：
  - 从 `ignore\p9\rea\` 拷来、改成读 p9 副本的：`strs.py`、`xr.py`、`gall.py`、`grepfn.py`、`slice.py`、`fn.py`、`pe.py`、`rd.py`、`ptr.py`、`vtdump.py`。
  - 新写的：
    - `dpe.py` / `jt.py` / `dxref.py` / `dfind318.py` / `f32.py`：读 dll 的节、跳转表、字符串引用、`[reg+0x318]` 访问。
    - `ext2.py`：把 REA 批量反编译结果拆成文件。
    - `kfmodel.py`：按第 2–5 节的结论写的 float32 求值模型，对照 `p10-curves` 实测。
    - `kfmodel2.py`：同一模型对照 `p10-script` 里不受脚本控制的用例。
    - `kfdiag.py`：列出残差最大的帧。
    - `fpscalc.py`、`endcase.py`：算第 11 节和实测建议里的期望值。
    - `relchk.py`、`parchk.py`：只读 `ignore\p10\out\kf.json`，统计语料里 `relative`、联动、事件的写法。
- **汇编摘录**（`ignore\p10\rea\asm\`）：
  - exe：`frame_anim_1401722f0.asm`（每帧动画段）、`advance_1401a9f60.asm`（时钟推进）、`curve_1401a9bc0.asm`（整数帧求值）、`bind_create_1401a4db0.asm`（建绑定）、`bind_register_140175880.asm`（登记与联动）、`options_parse_1401a96b0.asm`、`options_flags_1401a8c10.asm`、`keyframes_parse_1401a8ce0.asm`、`events_parse_1401a9410.asm`、`wraploop_1401a98b0.asm`、`relative_1401a5380.asm`、`ianimation_methods_140170760.asm`、`ianimation_register_140177f70.asm`、`lookup_getanimation_14018db00.asm`、`dispatch_callback_140177ad0.asm`、`init_scope_140172830.asm`、`baseobj_desc_1401e05f0.asm`、`instoverride_desc_14024d940.asm`。
  - dll：`dll_callcallback_18164e4d0.asm`（CallCallback 与 `animationEvent` 分支）、`dll_scene_getanimation_181635ee0.asm`、`dll_obj_getanimation_18162bbe0.asm`。
  - 反编译：`dc\f_140175880.c`。
- **锚点**：
  - 动画绑定虚表 `0x14048df78`：只在构造（`FUN_1401a4db0`，`0x1401a5111`）和析构（`FUN_140170dd0`）里出现。它只有三个槽，第二槽 `0x14000ec40` 返回 0（绑定种类 = 动画）。每帧更新不在虚表里，而在脚本管理器的每帧函数里直接循环。
  - 求值函数从「按 0x1c 字节元素计数」的常量 `0x6db6db6db6db6db7` 找到：`FUN_1401a9bc0`。它和时钟推进 `FUN_1401a9f60` 的唯一调用者是 `FUN_140171440`。
  - `IAnimation` 的成员表：字符串 `frameCount`、`setFrame`、`getFrame`、`isPlaying` 的引用都在 `FUN_140177f70`。
  - `getAnimation`：exe 里没有这个字符串（只有 `getAnimationLayer` 等），它在 dll 里实现，经场景接口虚表 `0x14048ea50` 的 `+0x78` 槽调回 exe 的 `FUN_14018db00`。
  - `animationEvent`：回调编号 6，dll 的 CallCallback（引擎虚表槽 8，`0x18164e4d0`）按编号分派。
- **结构的叫法**（类没有 RTTI，名字按行为起）：
  - **P**：脚本与动画管理器，`R+0x1718`（R 是场景渲染器，见 p2-REPORT）。`P+0x68` 是动画绑定列表，`P+0x80` 是等父动画的列表，`P+0xd8` 是脚本绑定链表，`P+0x128` 是脚本引擎。
  - **B**：动画绑定，0x110 字节。
  - **K**：B 内嵌的时钟，`K = B+0x38`。
  - **C**：一条通道（`c0`–`c3` 之一），0x30 字节。前 0x18 是关键帧数组，后 0x18 是按整数帧缓存的值数组。
  - **关键帧**：0x1c 字节 `{int frame, float value, uint flags, float backX, backY, frontX, frontY}`。
  - **W**：脚本拿到的 `IAnimation` 包装对象，0xd8 字节，虚表 `0x14048dfa8`。
  - **描述符**：属性的反射描述符。下文的偏移相对描述符本体（等于 P3 报告里哈希节点偏移减 0x30）：`+0` 类型，`+4` 字段偏移，`+8` JSON setter，`+0x18` 类型化 setter，`+0x20` getter，`+0x28` 改值回调，`+0x30` 标志字节，`+0x38` 属性名（`std::string`）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | 每帧更新 | 每帧函数 `FUN_14017fa70` 在 `0x1401802e5` 调 `FUN_140171440(P, dt)`。它先派发媒体事件，再按登记顺序逐条处理动画绑定：推进时钟、求值、经类型化 setter 写字段（setter 尾调改值回调）、派发本条时钟跨过的 `animationEvent`。之后才是 `engine.Tick(dt)` 和 `update(value)`。粒子模拟和相机在更早的 `FUN_1401891a0`（`0x14017fd26`），渲染在之后（`0x14018031a`），属性面板排队的改值在渲染之后（`0x140180d0c`）。时间是每条时钟自己的 float32：`t += rate × dt`，`dt` 就是 `g_Frametime` 用的那个 dt（已含场景 rate 与暂停淡变），`rate` 来自 W，没有 W 时为 1。不读 `g_Time`。帧号是 `trunc(t / (1/fps))`，float32 除法。 | 静态确认；顺序实测吻合 |
| 2 | 插值 | 两级。先按**整数帧**求值并缓存：段内是三次贝塞尔，x 用二分法反解；再在相邻两个整数帧之间**线性插值**。切线 `x` 以「本段长度的一半」为单位，`y` 是值的绝对偏移；前控制点取左端关键帧的 `front`，后控制点取右端关键帧的 `back`。关掉的一侧切线按 (0, 0) 处理（控制点落在关键帧上），两侧都关就是线性。运行时不看 `enabled` 位。`flags & 4`（`step`）看段的**右端**关键帧：整段保持左端的值。二分：初值 t = 0，步长 0.999 每次先减半再走，`|x − f| < 0.01` 帧或 1000 次停。首帧之前取首帧值，末帧及之后取末帧值。公式与常数见第 2 节。 | 静态确认；实测吻合（残差 ≤ 0.0007 px，陡段 ≤ 0.02 px） |
| 3 | 模式 | `loop`：`t ≥ D` 时 `t = fmodf(t, D)`（D = length / fps），第 length 帧与第 0 帧之间不插值，回绕直接跳。`wraploop`：加载时删掉 `frame > length` 的关键帧，在 `length` 处补一个关键帧（没有就新建），值等于首帧值，后切线等于首帧前切线取反。`mirror`：`t ≥ D` 时置方向位 `0x80000000`，`t = D − fmodf(t, D)`；反向走到 `t ≤ 0` 时清位，`t = −fmodf(t, D)`；周期 2D。`single`：`t ≥ D` 时置 `0x40000000`（结束），`t = D`，停在第 length 帧附近的值。`random`（`4`）只置位，运行时没有读者。 | 静态确认；`random` 有界确认；loop / mirror / single / wraploop 实测吻合 |
| 4 | `startpaused` | 只置 `0x20000000`，时钟不走，但求值与写入**每帧照常**。所以显示的是第 0 帧的曲线值（首帧不在 0 时就是首帧值），不是 `value`。`value` 只在加载时写进字段、`init(value)` 收到的是它，第一帧动画就覆盖掉。`previewvalue` 在二进制里没有这个字符串，不读。 | 静态确认；实测吻合 |
| 5 | 边界与丢弃 | 丢弃条件：`options` 不是对象、`fps` 或 `length` 不是数、`fps ≤ 0`、`int(length) / fps ≤ 0`（所以 `length` 为 0 丢弃）。丢弃时不解析通道。另一条：通道数必须**正好等于**属性分量数（float 1、vec2 2、vec3 3、vec4 4），否则这条动画不写（没有通道的 `R` 也属此类）。不写时字段保持加载时的 `value`。`length` 和关键帧 `frame` 按 `asInt` 截断，`fps` 和事件 `frame` 按 `asFloat`。非整数 fps 照常。float32 下有个副作用：部分 fps（如 14.5、1.2）`single` 播完显示的是第 length−1 帧的值。 | 静态确认；丢弃两例、非整数 fps 实测吻合；末值怪癖为推断（float32 算术） |
| 6 | `smoothing` / `stiffness` 等 | `wallpaper64.exe` 和 `scenescript64.dll` 里都没有独立的 `smoothing`、`stiffness` 字符串（exe 只有粒子用的 `uvsmoothing`）。`lockangle`、`locklength`、`previewvalue` 在 exe 里也没有。`magic` 不在 exe 里。`options.children` 不读（exe 里唯一的 `children` 字符串只被粒子解析器引用）。 | 静态确认 |
| 7 | 联动与名字 | `options.parent.key` 是**同一个对象上另一个属性的属性名**（不是动画的 `name`）。找到父（父自己不能再有 parent）后，子**完全借用父的时钟**：父的时间、帧长、`1/fps`、模式、暂停状态、父的 W 的 `rate`。子自己的 `fps`、`length`、`mode`、`startpaused`、`events`、`rate` 运行时都不起作用；子的关键帧帧号按父的帧解读，超出父 length 的部分取不到。`children[]` 不读。名字：`thisObject.getAnimation(name)` 在本对象内找 `options.name == name` 或**属性名** == name 的动画；不带参数时用当前脚本所挂属性的属性名去找。`thisScene.getAnimation(name)` 在全场景找同样的两种名字，按登记顺序取第一个。找不到：`thisScene` 返回 `null`，对象上返回 `undefined`；`thisScene.getAnimation()` 不带参数返回一个固定根值（推断为 `undefined`；**实测是 `null`**，见 [p10-REPORT](p10-REPORT.md)）。同一条动画每次拿到同一个原生 W。 | 静态确认（exe + dll）；实测吻合；不带参数的 `thisScene` 为推断 |
| 8 | 事件 | 加载时只收 `name` 是字符串、`frame` 是数的事件，时间 = `asFloat(frame) × (1/fps)`。每帧推进时，正向收 `[t0, t1)` 内的事件，反向收 `(t1, t0]`；`loop` 回绕时再收 `[0, t')`。一帧跨过多个就按 `events` 数组顺序逐个派发，每轮都再触发。`AnimationEvent` 是**整个事件 JSON 对象**序列化（键按字母序、数字 8 位有效数字）再 `JSON.parse` 的结果，所以有 `frame`（原样）、`name`，以及作者写的任何别的键。回调是 `animationEvent(event, value)`，`value` 是接收脚本自己那个属性的当前值，返回值写回。接收者：动画所在对象（或 `general`）上导出了 `animationEvent` 的全部脚本，不是全场景。 | 静态确认（exe + dll）；实测吻合 |
| 9 | 与 `user`、`script` 并存 | 一帧内的写入顺序：动画 → `animationEvent` 的返回值 → `update` 的返回值 → 渲染 → 排队的用户改值。下一帧动画再写，覆盖脚本和用户的写入。`update(value)` 收到的是本帧动画刚写的值（dll 用描述符 getter 现读字段）。用户改值在有效动画的属性上不会出现在画面里。 | 静态确认；脚本部分实测吻合；用户部分推断（语料 0 处） |
| 10 | 通道到分量 | `c0`→x、`c1`→y、`c2`→z、`c3`→w，整个向量一次写入。只写描述符类型 1–4（vec2、vec3、vec4、float）；布尔、整数等其它类型的动画求值但不写。`angles` 的关键帧值是弧度，与 `scene.json` 的静态值同单位，setter 不换算。 | 静态确认；`angles`、`color`、effect vec3 实测吻合 |
| 11 | `IAnimation` | `fps` = `1 / (1/fps)`（float32，30 读出 29.999998）；`frameCount` = `length`（整数）；`duration` = `length / fps`；`name` = `options.name`；`rate` 是 W 上的 float，缺省 1，不钳制，负数倒放，0 冻结；`play` 在结束态时把时间归零，再清暂停与结束位；`pause` 置暂停位；`stop` 置暂停位、清结束位和 mirror 方向位、时间归零；`isPlaying` = 暂停位与结束位都没置；`getFrame` = `t × fps`（带小数）；`setFrame(f)` 只改时间 `t = f / fps`，不钳制、不清任何位、不立即写值。 | 静态确认；实测吻合 |
| 12 | 暂停、可见性、重载 | WPE 暂停：淡出期间 dt 按暂停淡变缩小，动画跟着减速；淡出完成后帧函数不再调用，动画冻结；恢复后从原处接着走。对象 `visible` 为假：照常推进、照常写值。属性改动不重载场景，动画时间不变；只有重新打开壁纸或改画质时整场重建，时间从 0 开始。 | 暂停为静态确认（引 rea-framework Q6）；可见性静态确认 + 实测吻合；重载静态确认 |

**对 Kabegame 的直接含义**（推断，供 P10a 子计划参考）：
- 求值分两步：整数帧上的贝塞尔值（可以预先算好或懒算后缓存），整数帧之间线性插值。照抄第 2 节和第 14 节就能逐位对上。
- 每条动画（有父的用父的）一个 float32 时钟，帧里排在粒子与相机之后、脚本 `update` 之前，和脚本写回同在渲染之前。
- 暂停的动画照样每帧写值。
- 有父的动画只是借父的时钟，`children` 不用解析。
- `getAnimation` 按 `options.name` 或属性名找；事件发给同一对象的脚本。

---

## 1. 每帧更新

### 结论（静态确认）

1. **入口**：
   - 每帧函数 `FUN_14017fa70(R, dt)` 在 `0x1401802e5` 调 `FUN_140171440(P = R+0x1718, dt)`。传进去的 dt 就是帧函数的参数（`0x14017fa73` 存到 `[rbp+0x1f8]`，`0x140180084` 取回）。
   - 这个 dt 由渲染循环算出：`dt = clamp(场景 rate × 暂停淡变 × 原始帧时间, 0.0001, 0.25)`（rea-framework Q2），也就是 `g_Frametime`。
   - `FUN_140171440` 整段受 `ctx+0x118 & 0xc000000` 门控，置位时什么都不做。P3 报告里 init 也受这一位推迟，含义没追。
2. **帧里的顺序**（地址先后，静态确认）：
   1. `0x14017fcca`：`g_Time`（`R+0x148`，double）`+= dt`。
   2. `0x14017fd26`：`FUN_1401891a0(scene, dt)`，对每个对象调虚函数 `+0x48`。粒子模拟、相机更新在这里（rea-framework、rea-p5-camera）。
   3. `0x14017fd50` 一带：正交投影乘 `general.zoom`（P3 报告 L2）。
   4. `0x1401802e5`：`FUN_140171440`：
      1. 媒体事件 14–18（`P+0x140` 队列）；
      2. `P+0x148` 队列（与本题无关）；
      3. **动画循环**（`0x140172325`–`0x140172723`），见下；
      4. `engine.Tick(dt)`（`P+0x128` 虚表 `+0x48`）与 `update`（回调 1），`0x140172746`–`0x14017276f`。
   5. `0x140180305`：泛光脏位 `FUN_140184020`；`0x14018031a` 起渲染。
   6. `0x140180d0c`：`FUN_1401830a0` 处理属性面板排队的改值（P3 报告 D 节）。
3. **动画循环**（`0x140172370` 起，逐条遍历 `P+0x68` 的绑定 B，顺序就是登记顺序）：
   ```c
   C = B->parent (B+0xb0) ? B->parent : B;             // 时钟的主人
   if (C->lastFrame (C+0x88) != ctx->frameNo (ctx+0x144)) {   // 每个时钟每帧只推进一次
       rate = C->wrapper (C+0xf8) ? *(float*)(C->wrapper + 0xd0) : 1.0f;
       FUN_1401a9f60(rate * dt, &C->clock (C+0x38), &events);     // mulss：float32
       C->lastFrame = ctx->frameNo;
   }
   t = C->t (C+0x3c); spf = C->spf (C+0x38); len = C->length (C+0x48);
   frac = fmodf(t, spf);
   fi = (int)(t / spf);                 // cvttss2si，截断
   m = min(fi, len - 1);  lo = (m > 0) ? m : 0;
   hi = min(lo + 1, len);
   if (B->valid (B+0x18)) {
       a = frac / spf;
       switch (B->desc->type) {          // 1 vec2 / 2 vec3 / 3 vec4 / 4 float，其它不写
         v[i] = sample(B->ch[i], lo) * (1 - a) + sample(B->ch[i], hi) * a;   // 每个通道
       }
       B->desc->typedSetter(B->object (B+8), B->desc, v);   // call [desc+0x18]
   }
   for (e : events) FUN_140177ad0(P, C->scope (C+0x108), C->object (C+8), 6, e.json);
   events.clear();
   ```
   - 通道与时钟分开取：通道永远是 B 自己的（`[rbx+0x20]`），时钟是 C 的（`rdi`）。
   - `ctx+0x144` 是每帧 `+1` 的帧计数（`0x14017fca7` 的 `inc dword ptr [rsi+0x154]`，`ctx = R+0x10`）。
4. **写字段走描述符的类型化 setter，setter 尾调改值回调**（静态确认）：
   - vec3：`0x1401a4530` 拷 12 字节到 `对象 + 描述符+4`，然后 `jmp [描述符+0x28]`（有回调才跳）。
   - float（例如 `rate` 的描述符）：`0x1401a49f0` 写 4 字节，然后同样跳改值回调。
   - `angles`：`0x1401df590` 调 `FUN_1401dd630(对象, &vec3)`（JSON setter `FUN_1401df2f0` 用的也是它），再调改值回调。
   - 所以动画每帧对渲染器的效果，等于「每帧调一次 setter」。例如 `origin` 的回调 `0x1401e0520` 作废变换缓存（P3 报告 I3）。
5. **时间推进**（静态确认）：
   - 每个时钟一个 float32 时间 `K+4`，加载时为 0（构造清零）。
   - 每帧加 `rate × dt`，`rate` 只来自时钟主人的 W；从没调过 `getAnimation` 的动画没有 W，rate 为 1。
   - 不用场景时间。`g_Time` 是 double 累加、432000 s 归零；动画时间各自 float32 累加、按 D 回绕。两者只差 float 舍入。
6. **帧号**：`t / spf`，`spf = 1.0f / fps`（float32）。不是 `t × fps`，两者在 float32 下可能差 1 ulp。

### 由此推出的帧内时序（推断，依据是地址先后）

- 粒子与相机在动画之前算，用的是**上一帧**的动画值。例如 `instanceoverride.count` / `alpha` 的动画、相机相关字段，晚一帧生效。
- `general.zoom` 在 `0x14017fd50` 读，也在动画之前，所以动画写的 zoom 晚一帧进投影。
- 图层 `origin` / `alpha` / effect 常量在渲染时才读，动画值当帧生效。
- 泛光参数的脏位在动画之后（`0x140180305`）消费，`bloomstrength` 的动画当帧生效。

---

## 2. 插值

### 结论（静态确认；实测吻合）

**加载**（`FUN_1401a8ce0`，每个 `cN` 数组逐个元素）：
- `value`、`frame` 都必须是数（JSON 类型 1–3），否则跳过这个关键帧。
- `frame = asInt(frame)`（截断）。必须大于上一个收下的帧号，初值 −1，所以负帧号和不递增的都跳过。
- `step` 是 `true`：`flags = 4`，不读切线，四个切线分量为 0。
- 否则：
  - `back` 是对象，且 `enabled` 不是 `false`（缺省或不是布尔都算开）：`flags |= 1`，读 `back.x`、`back.y`（是数才读，否则 0）。
  - `front` 同理：`flags |= 2`，读 `front.x`、`front.y`。
  - 关掉的一侧四个分量保持 0。
- `magic`、`lockangle`、`locklength` 不读（第 6 节）。

**整数帧求值**（`FUN_1401a9bc0(通道, 帧号 i)`）：
- 结果缓存在通道的值数组里（`C+0x18`），第一次要第 i 帧时把缓存扩到 i+1，补算所有缺的帧。关键帧运行时不会变，缓存永不作废。
- 通道没有关键帧（如 `"c0": []`）：返回 0.0。注意这时通道数照算，这条动画有效，会写 0（推断：语料 0 处）。
- 找段（`k[]` 是关键帧数组，n 个）：
  - `i ≤ k[0].frame`：取 `k[0].value`。首帧之前都是首帧值。
  - 找 `j`（1 ≤ j < n）使 `k[j−1].frame ≤ i < k[j].frame`：
    - `i == k[j−1].frame`：取 `k[j−1].value`。
    - `k[j].flags & 4`：取 `k[j−1].value`。`step` 看的是**右端**关键帧。
    - 否则走贝塞尔，见下。
  - 都不满足（`i ≥ k[n−1].frame`）：取 `k[n−1].value`。末帧及之后都是末帧值。
- 贝塞尔（`0x1401a9d24`–`0x1401a9eb9`，常数：0.5 在 `0x1404926c0`，1.0 在 `0x140492704`，3.0 在 `0x140492830`，0.999 在 `0x1404926fc`，double 0.01 在 `0x140492708`）：
  ```text
  左端 a = k[j−1]，右端 b = k[j]；f0 = a.frame，f1 = b.frame，F = (float)i
  h  = (float)(f1 − f0) × 0.5
  X1 = h × a.frontX + f0        X2 = h × b.backX + f1        // x 以半段长为单位
  Y1 = a.value + a.frontY       Y2 = b.value + b.backY       // y 是值的绝对偏移
  t = (float)((i − f0) / (f1 − f0))     // 整数除法，恒为 0（WPE 的写法，结果就是 t 从 0 开始）
  step = 0.999；iter = 0
  loop:
    s = 1 − t
    x = ((X1 × ((s × 3 × s) × t) + ((s × s) × s) × f0) + X2 × ((s × 3 × t) × t)) + ((t × t) × t) × f1
    if (double)|x − F| < 0.01: break                 // |x−F| 先在 float32 里算
    step = step × 0.5                                // 先减半
    t = (x > F) ? t − step : t + step
    if (++iter ≥ 1000) break
  t = min(t, 1)；if (t < 0) t = 0
  s = 1 − t
  y = ((Y1 × ((s × 3 × s) × t) + ((s × s) × s) × a.value) + Y2 × ((s × 3 × t) × t)) + ((t × t) × t) × b.value
  ```
  - 每一步都是 float32（`mulss` / `addss`），括号就是汇编的运算顺序。
  - 二分的步长依次是 0.4995、0.24975、…，t 最大只能到 0.999。
  - 运行时不看 `flags` 的 1、2 位。关掉的切线是 (0, 0)，控制点落在关键帧本身。
  - 两侧都关：`X1 = f0`、`X2 = f1`、`Y1 = a.value`、`Y2 = b.value`，x 和 y 是同一个 t 的同一个缓动，y 对 x 是线性的。所以就是线性插值，误差在「斜率 × 0.01 帧」以内（反解容差带来的）。
  - 语料最常见的 `back {x:−1, y:0}`、`front {x:1, y:0}`：两个控制点的 x 都在段中点，值等于两端值，是标准的缓入缓出。

**帧间插值**（`0x1401723d8`–`0x140172697`）：
```text
frac = fmodf(t, spf)；fi = trunc(t / spf)
m = min(fi, len − 1)；lo = (m > 0) ? m : 0；hi = min(lo + 1, len)
a = frac / spf
值 = sample(lo) × (1 − a) + sample(hi) × a
```
- 时间、`spf`、`len` 都取时钟主人（有父取父）。
- 整条曲线实际是「整数帧上的贝塞尔采样点连成的折线」。

**首帧之前、末帧之后**：
- 首帧不在 0：第 0 帧到首帧之间都是首帧值。
- 末帧小于 `length`：末帧到 `length` 之间都是末帧值。
- 末帧大于 `length`：只会采到第 0 到第 `length` 帧（`hi ≤ len`），第 `length` 帧的值按曲线算出（落在末段中间），之后的部分永远取不到。`loop` 下从这一点直接跳回第 0 帧。

### 证据

- 求值：`asm\curve_1401a9bc0.asm`。段查找在 `0x1401a9ca0`–`0x1401a9d05`，step 判断 `0x1401a9d18 test byte ptr [r10 + r11 + 0x8], 0x4`（`r11 = j × 0x1c`，即右端关键帧）。
- 帧间：`asm\frame_anim_1401722f0.asm` 的 `0x1401723d8`–`0x14017241b`。
- 实测：`kfmodel.py` 对照 `p10-curves` 的 16 条 `origin.x` 曲线，见第 13 节。两侧都开（`flat`、`flat20`、`slope`）、只开一侧（`oneside`）、三点混合（`three`）、首帧不在 0（`inner`）、末帧在 `length` 前（`tail`）都吻合。

---

## 3. 模式

### 结论（静态确认）

`options` 由 `FUN_1401a96b0` → `FUN_1401a8c10` 解析成时钟 K（`B+0x38`）：

| 字段 | 偏移 | 内容 |
|---|---|---|
| `spf` | `K+0`（`B+0x38`） | `1.0f / fps` |
| `t` | `K+4`（`B+0x3c`） | 当前时间，初值 0 |
| `D` | `K+8`（`B+0x40`） | `(float)(int)length / fps` |
| `flags` | `K+0xc`（`B+0x44`） | 见下 |
| `length` | `K+0x10`（`B+0x48`） | `asInt(length)` |
| 事件 | `K+0x18`（`B+0x50`） | 每个 0x28 字节：`{float time, std::string json}` |

`flags`：
- `mode` 字符串比较：`"mirror"` → 1，`"single"` → 2，其它或缺省 → 0（loop）。
- `random` 为真 → 4。
- `wraploop` 为真 → 0x10。
- `startpaused` 为真 → 0x20000000（暂停）。
- 运行时另用 0x40000000（`single` 播完）、0x80000000（`mirror` 正在反向）。

**推进**（`FUN_1401a9f60(d, K, events)`，`asm\advance_1401a9f60.asm`）：
```text
if (flags & 0x60000000) return                  // 暂停或已结束
if ((flags & 2) && t ≥ D) return                // single 已到头
if (D ≤ 0) return
if (flags & 0x80000000) d = −d                  // mirror 反向段
t1 = d + t
收事件（第 8 节）
t = t1
single：if (t1 ≥ D) { flags |= 0x40000000; t = D }
loop：
  if (t1 < 0) { t = fmodf(t1 + D, D)；收 (t, D] 的事件 }
  if (t ≥ D)  { t = fmodf(t, D)；     收 [0, t) 的事件 }
mirror：
  正向：if (t1 ≥ D) { r = fmodf(t1, D)；flags |= 0x80000000；t = D − r }
  反向：if (t1 ≤ 0) { t = −fmodf(t1, D)；flags &= ~0x80000000 }
```
- `fmodf` 是 `0x14041d0c0`（CRT 实现，结果符号随被除数）。
- **`loop`**：
  - 用 `fmodf`，一帧跨过多轮也只剩余数。
  - 第 `length` 帧和第 0 帧之间没有插值段。t 永远小于 D，帧号 `lo` 最多到 `length−1`，`[length−1, length)` 这一段在第 `length−1` 帧和第 `length` 帧的采样之间插值；下一刻回到第 0 帧。所以第 `length` 帧的值和第 0 帧的值不等时，画面在回绕处跳一下。
- **`wraploop`**（加载期，`FUN_1401a98b0(length, 通道)`，对每个通道）：
  1. 关键帧少于 2 个：不处理。
  2. 记下首帧的 `value`、`flags`、`frontX`、`frontY`。
  3. 从后往前删掉 `frame > length` 的关键帧，至少留 1 个。剩下少于 2 个就停。
  4. 末帧正好是 `length`：改它；否则在末尾追加 `{frame: length, 其它全 0}` 再改它。
  5. 改法：
     - `末帧.value = 首帧.value`；
     - 首帧 `flags & 2`（`front` 开）：`末帧.flags |= 1`，`末帧.backX = −首帧.frontX`，`末帧.backY = −首帧.frontY`；
     - 否则只清 `末帧.flags` 的 1 位，**`backX`、`backY` 保持原样**（运行时不看位，旧值照样生效）。
  - 效果：回绕处值连续，斜率按首帧的前切线镜像。
- **`mirror`**：
  - 往返周期 2D，正向到 D 时把超出部分反射回来。
  - 反向时 `rate × dt` 取负。
  - 反向到 0 时把超出部分反射，再转正向。
- **`single`**：
  - 播完 `t = D`，置 0x40000000。之后 `isPlaying()` 为假，时钟不再走。
  - 显示的值：`t = D` 代入帧间插值。多数 fps 下 `a ≈ 1`，就是第 `length` 帧的值；少数 fps 下 `a ≈ 0`，是第 `length−1` 帧的值（第 5 节）。
  - 再 `play()` 从 0 重新开始。
- **`random`**：只在 `FUN_1401a8c10` 置位。推进函数、每帧循环、`IAnimation` 方法都不读 `flags & 4`（`grepfn` 扫了 `0x140170000`–`0x140172800`、`0x1401a8000`–`0x1401ab000` 里所有 `+0x44` / `+0xc` 的访问）。结论：运行时无效。语料 0 处。

### 实测对照

- `tail`、`tailwrap`（wraploop、末帧 40 < length 60）、`wrapt`（wraploop、回绕段两端切线开）、`mirror`、`single`、`slow`（single、length 1800）都吻合（第 13 节）。

---

## 4. `startpaused`

### 结论（静态确认；实测吻合）

- `startpaused` 只置 `0x20000000`，推进函数第一行就返回，t 停在 0。
- 每帧循环**不看暂停位**，照样求值、写值（`0x14017241f` 只看 `B+0x18`）。所以显示的是 t = 0 的值：`lo = 0`、`a = 0`，即第 0 帧的采样。
  - 首帧在 0：首帧值。
  - 首帧不在 0：仍是首帧值（首帧之前取首帧值）。
- 属性的 `value` 只在加载时由 JSON setter 写进字段。第一帧（`FUN_140171440` 在渲染之前）动画就把它覆盖了，画面上看不到。
- `init(value)` 在场景构造完、第一帧之前调用（`FUN_140172830`），收到的是 `value`。
- `previewvalue`：exe 和 dll 都没有这个字符串，不读。
- 实测：`p10-curves` 的 `paused`（value.x 900，曲线 100→700）每帧都是 100；`ovrinit` 的 `init` 收到的是静态 `value`。

---

## 5. 边界与丢弃

### 结论（静态确认）

1. **整条丢弃**（`FUN_1401a96b0` / `FUN_1401a8c10` 返回 0，于是不解析通道、事件，也不做 wraploop）：
   - `options` 不是对象；
   - `length` 或 `fps` 不是数（JSON 类型 1–3）；
   - `fps ≤ 0`；
   - `(float)(int)length / fps ≤ 0`，包括 `length` 为 0、`length` 为负、`length` 在 (−1, 1) 之间（截断成 0）。
   - 丢弃后这条绑定照样登记（`FUN_140175880` 无条件调用），`getAnimation` 也能找到它。它的时钟 `D = 0`，推进函数直接返回。
2. **有效位 `B+0x18`**（`FUN_140175880` 登记时算，`dc\f_140175880.c` 的动画分支）：
   ```c
   need = (type == 1) ? 2 : (type == 2) ? 3 : (type == 3) ? 4 : 1;
   B->valid = (need == 通道数);
   ```
   - 通道数是 `c0`、`c1`… 连续存在的数组个数，数组空也算。
   - 不等就不写。字段保持加载时的值（`value`，或之后用户改的值）。
   - 时钟照走、事件照发（派发在 `B+0x18` 判断之后，不受它影响）。
   - 例：标量写成两个通道、`origin` 只给 `c0`、`3837699827` 的 `R` 只有 `options`。
3. **`relative`**（`FUN_1401a4db0`，`asm\relative_1401a5380.asm`）：
   - 只在属性的 `value` 是**字符串**、且至少有三段（或两段后跟空白）时生效。
   - 前三段依次加到 `c0`、`c1`、`c2` 每个关键帧的 `value` 上（`FUN_1401a89a0`：`asFloat(值) + 偏移`，float32 加法，存回 double）。`c3` 不加。
   - 然后删掉 `relative` 键。
   - 数字 `value`（标量）和两段字符串（vec2）**不换算**，`relative` 被忽略。语料 41 条全是三段字符串（`origin` 27、`angles` 10、`scale` 4，`relchk.py`），不受影响。
   - 用的是作者写的 `value`，不是用户属性套用后的值（首次 applyUserProperties 在加载之后，P3 报告 D 节）。
4. **非整数 fps**：照常。`spf = 1/fps`，`D = int(length)/fps`，帧号按 `t/spf`。实测 `fpsfrac`（0.9）、`frac09`、`frac12`、`frac145`、`frac75` 吻合。
5. **非整数帧号**：
   - 关键帧 `frame` 按 `asInt` 截断，截断后不严格递增的关键帧被丢掉。
   - 事件 `frame` 按 `asFloat`，可以带小数。
6. **`single` 播完的末值依赖 float32**（推断，由第 1、3 节的代码直接算出）：
   - `t = D` 时 `fi = trunc(D/spf)`，`a = fmodf(D, spf)/spf`。
   - fps 30 / length 60：`D/spf = 59.999996`，`fi = 59`，`a = 0.999997`，值约等于第 60 帧。
   - fps 14.5 / length 29：`D/spf = 29.0`，`fi = 29`，`lo = 28`、`hi = 29`，`a = 1.1e−7`，值约等于**第 28 帧**。
   - fps 1.2 / length 12 同理，停在第 11 帧。
   - `fpscalc.py` 列了语料里出现的几种 fps。语料 `2251857160` 的 `tolerance` 动画正是 fps 14.5、length 29、`single`。

---

## 6. `smoothing` / `stiffness` 与编辑器字段

### 结论（静态确认）

- `grep -a` 计数：
  - `smoothing`：`wallpaper64.exe` 1 处，是粒子 rope 的 `uvsmoothing`（`0x14048fc08`，只被粒子解析 `0x1401c0c9b` 引用，没有指向 `+2` 的引用）；`scenescript64.dll` 0 处。
  - `stiffness`：两者都是 0 处。
  - `previewvalue`、`lockangle`、`locklength`：两者都是 0 处。
  - `magic`：exe 0 处；dll 3 处，与动画无关。
- 加载和运行都用字符串字面量查 JSON 键（jsoncpp 的 `find(key, end)`），没有别的取键方式。所以这几个字段运行时不读。
- `options.children`：exe 唯一的 `children` 字符串（`0x1404900a8`）只被粒子解析器 `0x1401cfe16` 引用。动画不读。

---

## 7. 联动与名字

### 联动（静态确认；实测吻合）

`FUN_1401a4db0` 读 `options.parent.key`（字符串）存进 `B+0x90`。`FUN_140175880` 登记时：

- **B 没有 parent key**：
  1. 在「等父」列表 `P+0x80` 里找子 X：`X->object == B->object`，且 `X` 的 parent key 等于 **B 的属性名**（描述符 `+0x38`）。
  2. 找到就 `X->parent (X+0xb0) = B`，把 X 插进 B 的子集合（`B+0xb8`），从等父列表删掉。
  3. 把 B 追加到 `P+0x68`。
- **B 有 parent key**：
  1. 在 `P+0x68` 里找第一个 Y：Y 自己没有 parent key，`Y->object == B->object`，Y 的属性名等于 B 的 parent key。
  2. 找到就 `B->parent = Y`，B 进 Y 的子集合。
  3. 找不到就把 B 放进等父列表，等 Y 以后登记时认领。
  4. 不管找没找到，都把 B 追加到 `P+0x68`。

所以：
- parent key 是**属性名**，父必须在**同一个对象**上，父自己不能再有 parent（只有一层）。语料 35 条联动全是同一对象内的属性对（`parchk.py`），例如 effect 常量 `Aperture` → `Opacity`、`alpha` → `origin`、`instanceoverride.alpha` → `count`。
- 有父的 B 每帧用父的时钟（第 1 节的 `C = B->parent ?: B`）。父没有动画（父的属性不是关键帧值）时，子一直留在等父列表，用自己的时钟。
- 子自己的 `fps`、`length`、`mode`、`startpaused`、`events` 在运行时都不起作用：
  - 子的时钟从不推进，所以子的 `events` 永远不触发。
  - 子的关键帧帧号按父的帧解读，帧号上限是父的 `length`。
  - 速率取父的 W 的 `rate`。
- 子的 `wraploop` 例外：它在加载时就按子自己的 `length` 改过关键帧，这一步照做。
- 脚本对子动画调 `play` / `pause` / `stop` / `setFrame` / `rate`，改的是子自己的时钟，**画面不变**；`getFrame` 读的也是子自己（不走）的时间。这一条没有实测。
- `children[]` 不读，它只是编辑器记录。

实测（平行会话 `p10-script` 的 `link` / `link2`，第 13 节）：父 `startpaused` 期间子（自己不暂停）不动；父播放后子跟父的帧走，子的 `length 30` 不回绕，第 30 帧之后保持末值；父 loop、子 `startpaused` 时子照样动。

### 名字（静态确认：exe + dll；实测吻合）

**exe 侧查找** `FUN_14018db00(G, owner, name)`（场景接口 `0x14048ea50` 的 `+0x78` 槽）：
```c
for (B : ctx->animList)          // ctx+0x1770 .. +0x1778，就是 P+0x68
  if (owner == 0 || B->object->vfunc8() == owner)
    if (B->name == name || B->desc->name == name)    // options.name，或属性名
      return B->wrapper ?: (B->wrapper = new W{ B, rate = 1.0f });
return NULL;
```
- 匹配 `options.name` **或属性名**（如 `"origin"`、`"alpha"`、effect 常量名），按登记顺序取第一个。
- W 按绑定缓存，同一条动画每次拿到同一个原生对象，`rate` 跟着保留。JS 层每次包装出来的对象是否 `===` 没核对。

**dll 侧**：
- `thisScene.getAnimation`（本地回调 `0x181635ee0`）：
  - 参数个数 < 1 或第一个参数不是字符串：直接把返回值设成根值 `[isolate+0x378]`。按用法推断是 `undefined`（像 `SetUndefined()`）；**主会话实测（`p10-edge` 的 `byprop`）是 `null`**。为什么和下面「结果为空」用的 `+0x368` 一样是 `null`（偏移不同）没再追；事件串解析失败时（第 8 节）用的也是 `+0x378`，没实测。
  - 否则 `owner = 0`（`xor edx, edx`，`0x18163617b`），即全场景。
  - 结果为空时返回根值 `[isolate+0x368]`，实测是 `null`。
- 对象上的 `getAnimation`（`IObject`，本地回调 `0x18162bbe0`，由 `0x181652d1e` 起的原型登记挂上）：
  - `owner = 本对象的 vfunc8()`。
  - 有字符串参数且非空：用它。
  - 否则取引擎「当前正在执行的脚本」栈顶（`engine+0x500` 起的 deque，`+0x518` 是个数）的描述符属性名（`desc+0x38`），即**调用者所挂属性的属性名**。
  - 找不到时不设返回值，JS 拿到 `undefined`。
  - 栈为空（不在任何属性脚本的调用里）时名字是空串，会匹配 `options.name` 为空的第一条动画（推断，没有核对何时栈为空）。

**P10b 步骤 0 的补测**（[p10-REPORT](p10-REPORT.md)「P10b 补测」）：
- `vfunc8()` 的范围不是图层，是绑定的属主（同联动）：effect 常量上找到的是自己那条，图层与 effect 对象上都找不到 effect 常量的动画。派发作用域（第 8 节）仍是图层，两者不同。
- `thisScene.getAnimation('')` 取到第一条没写 `name` 的动画；模块顶层调用抛 `SyntaxError: getAnimation cannot be called from global scope.`。
- 动画与脚本的登记顺序：`general` 的字段 → 每个对象自己的字段 → 它的 effect（先 `visible`，再各 pass 的常量），同层按键名字母序。

实测（`names` 用例，脚本挂在没有动画的 `nameB.origin` 上）：`thisObject.getAnimation()` → `undefined`；`thisScene.getAnimation('kfname')` → 找到；`thisLayer.getAnimation('kfname')`（动画在别的层）→ `undefined`；`thisScene.getAnimation('nosuch')` → `null`；`getLayer('nameA').getAnimation()` → 找到 `nameA.origin` 的动画（因为调用者属性名是 `origin`）。全部与上面一致。

---

## 8. 事件

### 结论（静态确认：exe + dll；实测吻合）

**加载**（`FUN_1401a9410(events, spf, 输出)`）：
- 遍历 `options.events` 的元素（数组按下标顺序）。
- 只收 `name` 是字符串、`frame` 是数的元素。
- `time = asFloat(frame) × spf`（float32）。
- 存的不是名字，而是**整个元素**用 jsoncpp `writeString` 序列化的结果（`FUN_140004d00(…, 0)`：`commentStyle "None"`、`indentation ""`、`emitUTF8 true`、`precision 8`）。jsoncpp 对象按键名排序，所以串是 `{"frame":30,"name":"e"}` 这样的紧凑形式。
- 语料的事件还带编辑器留下的 `$$hashKey`，也会进这个串。

**推进时收集**（`FUN_1401a9f60`，t0 是推进前的时间，t1 = t0 + d）：
- `d > 0`：收 `t0 ≤ time < t1`。
- `d ≤ 0`：收 `t1 < time ≤ t0`（mirror 反向段、负 rate）。
- `loop` 回绕：先按上面收 `[t0, t1)`（t1 已超过 D），回绕后再收 `0 ≤ time < t'`；负向回绕收 `t' < time ≤ D`。
- `mirror` 反射：只收反射前的那段，反射回来的部分不检查。
- `single`：用未钳的 t1 比较，第 `length` 帧上的事件在越过 D 那一帧触发（`time` 正好等于 t1 时不触发）。
- 第 0 帧上的事件：第一帧推进时 `[0, t1)` 包含它，所以加载后第一帧就触发；`loop` 每次回绕再触发。
- `startpaused` 期间不推进，不触发。
- 收集顺序就是派发顺序：先按数组顺序收回绕前的，再收回绕后的。

**派发**（`0x1401726ad`–`0x14017271c`）：
- 每条绑定写完值后立即派发它的时钟本帧收到的事件，再处理下一条绑定。
- 每个事件调一次 `FUN_140177ad0(P, scope = C+0x108, object = C+8, 6, json)`。
- `FUN_140177ad0` 遍历全部脚本绑定 S，满足以下全部条件就调：
  - S 导出了 `animationEvent`（掩码 `S+0x40` 第 6 位）；
  - S 已 init（`S+0x44 == 2`）；
  - `scope == 0`，或 `S+0x48 == scope`，或 `S+8 == object`。
- `scope`（`B+0x108`）由 `FUN_140172830(P, x)` 在加载时设定，脚本绑定的 `S+0x48` 也由它设定，取值相同：
  - 对象的属性（含 effect 常量、`instanceoverride`）：对象加载完后 `FUN_14018ff60` 在 `0x14019094d` 以该对象调用，`scope` = 这个对象。
  - `general` 的属性：`0x1401874ab` 以场景对象调用。
  - 加载流程里另有三处以 0 调用（`0x14018747c`、`0x140187ea8`、`0x140187f82`），那时还没归属的绑定 `scope = 0`，事件发给全场景所有导出了 `animationEvent` 的脚本。哪些绑定会落到这里没逐个核对（推断：对象与 `general` 的都不会）。
  - 所以对象上的动画事件发给**同一对象上所有属性脚本**（例如挂在 `origin` 上和挂在某个 effect 常量上的脚本都收到），不发给别的对象。

**dll 侧**（CallCallback `0x18164e4d0`，回调编号 6 的分支 `0x18164eac2`）：
- 把 exe 传来的串 `NewFromUtf8` 后 `JSON.parse`（`0x180014a00`，`applyGeneralSettings` 分支 `0x18164e9e0` 用的是同一个函数），得到 `event`。解析失败时换成根值 `[isolate+0x378]`（推断为 `undefined`）。串由 jsoncpp 生成，正常不会失败。
- 第二个参数 `value` 由 `0x1816208e0` 用接收脚本**自己属性**的描述符 getter 现读。
- 以 `argc = 2` 调 `animationEvent(event, value)`。编辑器的模板也写成 `animationEvent(event, value)`（`ui/dist/scripts/scripts.js`）。
- 返回值写回接收脚本的属性（P3 报告 D 节：只有 `init`、`update`、`animationEvent` 写回）。

**`AnimationEvent` 的字段**：作者事件对象的全部键。`frame` 是作者写的数（原样，最多 8 位有效数字），不是按时间算的；`name` 是名字；另外还有 `$$hashKey` 之类的键。

实测（`ev`、`evn`、`evp`、`evother`）：
- `frame=15|name=e15` 在 runtime 0.5331 触发，第 45 帧在 1.5020，每轮都再触发。
- `single` 的第 60 帧事件在播完那一帧触发。
- 别的对象上导出了 `animationEvent` 的脚本一次也没收到。

---

## 9. 与 `user`、`script` 并存

### 结论

- **登记**：`FUN_1401a4db0` 对一个值依次建 `user`、`animation`、`script` 三种绑定（sample-gaps §3.4，复核无误）。三者互不知道对方。
- **一帧内谁最后写**（静态确认，地址先后）：
  1. 动画循环：动画写字段。
  2. 同一循环里：`animationEvent` 的返回值写回接收脚本的属性。
  3. `update`：返回值写回本属性。
  4. 渲染。
  5. 渲染后：排队的用户属性改值经用户绑定写字段。
  - 下一帧第 1 步动画再写，覆盖第 2–5 步的结果。
- **`update(value)` 收到的值**：dll 在回调时用描述符 getter 现读字段（`0x1816208e0` 的 `call [rdi+0x20]`），这时动画已经写过，所以是**本帧动画值**（静态确认）。实测 `ovr`：脚本每帧返回 x = 1500，下一帧收到的仍是动画值（100.635、117.097…），画面是 1500。
- **脚本写回之后**：只在本帧有效，下一帧动画覆盖（静态确认；实测吻合）。
- **`init(value)`**：收到静态 `value`，返回值写回后第一帧被动画覆盖（实测 `ovrinit`）。
- **用户改属性**（推断，语料 0 处）：
  - 用户绑定在渲染后写字段，下一帧渲染前动画就覆盖了，画面上看不到。
  - 动画本身不受影响：不改时间，也不重算 `relative`。
  - 动画无效（`B+0x18` 为假）时用户改值照常生效。

---

## 10. 通道到分量

### 结论（静态确认；实测吻合）

| 描述符类型 | 属性举例 | 需要的通道 | 写法 |
|---|---|---|---|
| 4 float | `alpha`、`brightness`、`zoom`、`bloomstrength`、effect 的 float 常量、`instanceoverride` 的 `alpha` / `count` / `size` / `speed` / `lifetime` / `brightness`（`0x14024d940` 里全是类型 4） | `c0` | 写 1 个 float |
| 1 vec2 | effect 的 vec2 常量 | `c0`、`c1` | 写 x、y |
| 2 vec3 | `origin`、`scale`、`angles`、`color`、effect 的 vec3 常量 | `c0`–`c2` | 写 x、y、z |
| 3 vec4 | effect 的 vec4 常量 | `c0`–`c3` | 写 x、y、z、w |
| 其它（整数、布尔、字符串…） | `visible` 等 | 1 | **不写** |

- 类型编号以动画循环的 switch 为准：4 是 float，1、2、3 是 vec2、vec3、vec4。P3 报告 I3 表里写的「类型 1–4 对应 float / vec2 / vec3 / vec4」顺序不对；它列的 setter 本身没错（`FUN_1401a4b00` 是 float，`rate` 的描述符就是类型 4 配它）。
- 通道数必须正好等于分量数（第 5 节），整个向量一次写入。没有「只写有通道的分量」这种情况。
- 布尔与整数类型的动画：有效位可能为真（需要 1 个通道），时钟照走、事件照发，但 switch 只认 1–4，不写字段。语料 0 处。
- `angles`：
  - 类型化 setter `0x1401df590` 把 vec3 原样交给 `FUN_1401dd630`，没有角度换算。JSON setter 也走 `FUN_1401dd630`。所以关键帧值和 `scene.json` 的静态值同单位，都是弧度。
  - 描述符标志 `+0x30 & 4`（P3 报告里的 `+0x60 |= 4`）只影响脚本：dll 读值时乘 57.29578（`0x1819a5128`），写回时乘 0.017453292。
  - 实测：`angles` 用例 z 0→3.14159，读出的旋转角是同一个数（弧度）。
- `color`：vec3，实测 r 0→1、g 恒 0.5、b 1→0 吻合。

---

## 11. `IAnimation` 的成员

### 登记（`FUN_140177f70`，属性表 `DAT_1404e8140`、方法表 `DAT_1404e8180`）

W 的布局：`W+0xc8` 指向绑定 B，`W+0xd0` 是 `rate`。W 由 `FUN_14018db00` 第一次查到时创建，存在 `B+0xf8`。

| 成员 | 类型 | 实现 | 语义 |
|---|---|---|---|
| `rate` | float，可写 | 字段 `W+0xd0`，setter `0x1401a49f0`（只拷 4 字节再调回调） | 缺省 1.0，不钳制。每帧 `t += rate × dt`。负数倒放，0 冻结（这时事件走「反向」分支，不会触发）。有父的动画用父的 W 的 `rate`。 |
| `fps` | float，只读 | `0x140170770`：`1.0f / B->spf` | float32 往返。fps 30 读出 29.999998，60 读出 59.999996，15 读出 14.999999；14.5、20、6、18 原样（`fpscalc.py`） |
| `frameCount` | int，只读 | `0x140170790`：`B->length` | 即 `asInt(length)` |
| `duration` | float，只读 | `0x1401707a0`：`B->D` | `(float)length / fps` |
| `name` | string，只读 | `0x1401707b0`：`B+0x68` | `options.name`，没有时为空串 |
| `play()` | 方法 | `0x1401707f0` | `if (flags & 0x40000000) t = 0；flags &= ~0x60000000` |
| `pause()` | 方法 | `0x140170820` | `flags |= 0x20000000` |
| `stop()` | 方法 | `0x140170830` | `flags |= 0x20000000；flags &= 0x3fffffff；t = 0`。同时清掉结束位和 mirror 方向位（sample-gaps 只写了清 0x40000000，这里补上 0x80000000） |
| `isPlaying()` | 方法 | `0x140170860` | `(flags & 0x60000000) == 0` |
| `getFrame()` | 方法 | `0x1401708a0` | `t / spf`，float32，带小数 |
| `setFrame(f)` | 方法 | `0x140170880` | `t = spf × f`，float32 |

`setFrame` 的细节（静态确认；实测吻合）：
- 不钳制，不改任何位，不写值。
- 值在下一次动画循环里才写。脚本多在 `update` 里调 `setFrame`，那时本帧的动画循环已经跑过，所以**下一帧**才看到。实测 `ctl`：11.6344 时 `setFrame(30)`，同一帧 value 仍是 100，下一帧变成第 30 帧的值。
- 暂停时同样下一帧生效（暂停的动画照样每帧写值）。
- `single` 播完后（结束位还在）`setFrame(x)`：时钟仍不走，但显示停在第 x 帧，`isPlaying()` 仍为假。
- 超出范围：
  - `t > D`：下一帧求值时 `lo` 钳在 `length−1`，`a` 取 `t` 对 `spf` 的余数，显示在第 `length−1` 与 `length` 帧之间。播放时下一次推进按模式回绕或结束。
  - `t < 0`：`lo = 0`、`hi = 1`，`a` 是负数，值在第 0、1 帧的连线上往外延伸不到一帧。`loop` 下一次推进会把它拉回 `[0, D)`。

其它实测（`ctl`、`ctls`）：`stop()` 后 `getFrame()` 立即为 0、下一帧显示第 0 帧；`single` 播完 `getFrame()` 为 60.000（`toFixed(3)`）、`isPlaying()` 为假，再 `play()` 从 0 开始。

---

## 12. 暂停、可见性、重载

### 结论

- **WPE 暂停**（静态确认，引 rea-framework Q6）：
  - 暂停开始后约 1/6 s 的淡出里，渲染循环把 dt 乘上逐渐变小的暂停淡变，动画跟着减速。
  - 淡变到 0 后不再调用帧函数，`FUN_140171440` 不跑，动画时间冻结，也不写值。
  - 恢复后第一帧 dt = 0.0001，之后约 0.77 s 淡回正常速度，动画从原处接着走，不补暂停时长。
- **对象不可见**（静态确认；实测吻合）：
  - 动画循环不看 `visible`，照常推进、写值、派发事件。
  - 实测 `hid`：隐藏 1 s 再显示，位置与同起点的 `link2` 完全一样，说明隐藏期间没有停。
- **重载**（静态确认）：
  - 属性改动不重载场景（P3 报告 I2），动画时间、W、缓存都保留。
  - 重新打开壁纸或改画质时整场重建：绑定重新创建，`t = 0`，W 重新创建（`rate` 回到 1），脚本重新加载。
  - 对 Kabegame：重编译时保留 realm 的做法下，动画时间也应保留。

---

## 13. 与平行会话实测的对照（只读，不是这一轮的实测）

数据：`ignore\p10\out\` 里的 `p10-curves-values.json`、`p10-script-values.json`、`p10-script2-log.txt`、`wpe-p10-script2-fps20-values.json`，工程在 `ignore\p10\proj\`，定义在 `ignore\p10\defs\p10.py`。WPE 测试窗口限 20 fps，每个文件 100 帧（场景时间约 13.4–18.6 s）。

做法：
- `kfmodel.py` / `kfmodel2.py` 按第 2–5 节实现（float32）。
- 时钟用实测行的 `time`（`g_Time`）近似：`loop` 取 `fmod`，`mirror` 取三角波，`single` 取 `min(time, D)`。
- 用 float64 的 `time` 代替逐帧 float32 累加，陡段会多出约 1e−6 s 的时间误差。

| 用例 | 内容 | 帧数 | 最大残差 | 说明 |
|---|---|---|---|---|
| `lin` | 两侧都关，(0,100)→(60,700) | 100 | 0.0005 px | |
| `flat` | 平切线 ±1 | 100 | 0.0007 px | |
| `flat20` | 平切线 ±20 | 100 | 0.0001 px | |
| `slope` | 斜切线 | 100 | 0.0001 px | |
| `oneside` | 只开首帧前切线 | 100 | 0.0214 px | 残差都在第 59–60 帧之间，那一段每帧约 600 px，属时钟近似误差 |
| `three` | 三点混合切线 | 100 | 0.0151 px | 同上，在陡段 |
| `inner` | 关键帧在 15、45 | 100 | 0.0013 px | |
| `tail` / `tailwrap` | 末帧 40 < 60，后者 wraploop | 100 | 0.0007 / 0.0011 px | |
| `mirror` / `single` / `slow` | 三种模式 | 100 | ≤ 0.0005 px | |
| `fpsfrac` | fps 0.9 | 100 | 0.0006 px | |
| `relative` | value.x 300 + 曲线 | 100 | 0.0003 px | |
| `paused` | startpaused | 100 | 0 | 每帧都是第 0 帧的值 100 |
| `onlyc0` | `origin` 只给 `c0` | 100 | 0 | 保持 `value` |
| `wrapt` | wraploop，回绕段两端切线开 | 100 | 0.0022 px | 验证切线取反规则 |
| `frac09` / `frac12` / `frac145` / `frac75` | 非整数 / 低 fps | 100 | ≤ 0.0006 px | |
| `alpha`（p10-script） | float 一通道 | 100 | 0 | |
| `kfa` / `kfv` | effect float / vec3 常量 | 100 | ≤ 0.00002 | |
| `alpha`、`kfa`（p10-curves） | 标量写成两个通道 | 100 | 0 | 保持 `value`（0.5 / 3） |

脚本日志里吻合的现象分别写在第 4、7、8、9、11、12 节。

---

## 14. 可以照抄的参考实现（TypeScript 写法，float32 用 `Math.fround`）

```ts
const f = Math.fround;

interface Key { frame: number; value: number; flags: number; bx: number; by: number; fx: number; fy: number }

// 加载：一个 cN 数组 → 关键帧（FUN_1401a8ce0）
function parseChannel(arr: unknown[]): Key[] {
  const out: Key[] = [];
  let last = -1;
  const on = (t: any) => !!t && typeof t === "object" && !Array.isArray(t) && t.enabled !== false;
  const num = (v: any) => (typeof v === "number" ? f(v) : 0);
  for (const k of arr as any[]) {
    if (typeof k?.value !== "number" || typeof k?.frame !== "number") continue;
    const frame = Math.trunc(k.frame);               // asInt
    if (frame <= last) continue;
    last = frame;
    const key: Key = { frame, value: f(k.value), flags: 0, bx: 0, by: 0, fx: 0, fy: 0 };
    if (k.step === true) key.flags = 4;
    else {
      if (on(k.back)) { key.flags |= 1; key.bx = num(k.back.x); key.by = num(k.back.y); }
      if (on(k.front)) { key.flags |= 2; key.fx = num(k.front.x); key.fy = num(k.front.y); }
    }
    out.push(key);
  }
  return out;
}

// wraploop（FUN_1401a98b0）
function wraploop(k: Key[], length: number): void {
  if (k.length < 2) return;
  const first = { ...k[0] };
  while (k[k.length - 1].frame > length && k.length > 1) k.pop();
  if (k.length < 2) return;
  if (k[k.length - 1].frame !== length) k.push({ frame: length, value: 0, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 });
  const last = k[k.length - 1];
  if (first.flags & 2) { last.flags |= 1; last.bx = -first.fx; last.by = -first.fy; }
  else last.flags &= ~1;                              // bx、by 保留
  last.value = first.value;
}

// 整数帧采样（FUN_1401a9bc0，可缓存）
function sample(k: Key[], i: number): number {
  const n = k.length;
  if (n === 0) return 0;
  if (i <= k[0].frame) return k[0].value;
  for (let j = 1; j < n; j++) {
    const a = k[j - 1], b = k[j];
    if (!(a.frame <= i && i < b.frame)) continue;
    if (a.frame === i || (b.flags & 4)) return a.value;
    const h = f(f(b.frame - a.frame) * 0.5);
    const X1 = f(f(h * a.fx) + a.frame), X2 = f(f(h * b.bx) + b.frame);
    const F = i;
    let t = 0, step = f(0.999);
    for (let it = 0; ; ) {
      const s = f(1 - t);
      const x = f(f(f(f(X1 * f(f(f(s * 3) * s) * t)) + f(f(f(s * s) * s) * a.frame)) + f(X2 * f(f(f(s * 3) * t) * t))) + f(f(f(t * t) * t) * b.frame));
      if (Math.abs(f(x - F)) < 0.01) break;
      step = f(step * 0.5);
      t = x > F ? f(t - step) : f(t + step);
      if (++it >= 1000) break;
    }
    t = Math.min(t, 1); if (t < 0) t = 0;
    const s = f(1 - t);
    const Y1 = f(a.value + a.fy), Y2 = f(b.value + b.by);
    return f(f(f(f(Y1 * f(f(f(s * 3) * s) * t)) + f(f(f(s * s) * s) * a.value)) + f(Y2 * f(f(f(s * 3) * t) * t))) + f(f(f(t * t) * t) * b.value));
  }
  return k[n - 1].value;
}

// 时钟（FUN_1401a8c10 + FUN_1401a9f60）
const PAUSED = 0x20000000, DONE = 0x40000000, BACK = 0x80000000;
interface Ev { time: number; json: string }
interface Clock { spf: number; t: number; D: number; flags: number; length: number; events: Ev[] }

function advance(K: Clock, d: number, out: Ev[]): void {
  const fl = K.flags >>> 0;
  if (fl & (PAUSED | DONE)) return;
  if ((fl & 2) && K.t >= K.D) return;
  if (K.D <= 0) return;
  if (fl & BACK) d = -d;
  const t0 = K.t, t1 = f(d + t0);
  if (d > 0) { for (const e of K.events) if (e.time >= t0 && e.time < t1) out.push(e); }
  else { for (const e of K.events) if (e.time > t1 && e.time <= t0) out.push(e); }
  K.t = t1;
  if (fl & 2) { if (t1 >= K.D) { K.flags = (K.flags | DONE) >>> 0; K.t = K.D; } return; }
  if (!(fl & 1)) {
    if (t1 < 0) {
      K.t = f(f(t1 + K.D) % K.D);
      if (K.t >= 0) for (const e of K.events) if (e.time > K.t && e.time <= K.D) out.push(e);
    }
    if (K.t >= K.D) {
      K.t = f(K.t % K.D);
      if (K.t < K.D) for (const e of K.events) if (e.time >= 0 && e.time < K.t) out.push(e);
    }
    return;
  }
  if (fl & BACK) { if (t1 <= 0) { K.t = -f(t1 % K.D); K.flags = (K.flags & ~BACK) >>> 0; } }
  else if (t1 >= K.D) { const r = f(t1 % K.D); K.flags = (K.flags | BACK) >>> 0; K.t = f(K.D - r); }
}

// 每帧（FUN_140171440 的动画段）；rate 取时钟主人的 W，没有就是 1
function frameValue(clock: Clock, channels: Key[][]): number[] {
  const { t, spf, length } = clock;
  const frac = f(t % spf);
  const fi = Math.trunc(f(t / spf));
  const m = Math.min(fi, length - 1);
  const lo = m > 0 ? m : 0;
  const hi = Math.min(lo + 1, length);
  const a = f(frac / spf);
  return channels.map((k) => f(f(sample(k, lo) * f(1 - a)) + f(sample(k, hi) * a)));
}
```

加载期的其它规则（第 3、5 节）：
- `spf = f(1 / fps)`，`D = f(Math.trunc(length) / fps)`，`length = Math.trunc(length)`。
- 丢弃条件按第 5 节第 1 条。
- `relative` 先于通道解析，按第 5 节第 3 条加到 JSON 上。
- 事件 `time = f(f(frame) * spf)`。

---

## 15. 未知 / 需要实测的点

1. **哪些绑定的事件作用域为 0**：加载流程里有三处以 0 调 `FUN_140172830`（第 8 节），对应哪些 JSON 段没逐一追。对象与 `general` 的绑定不会落到这里。
2. **`ctx+0x118 & 0xc000000` 门**：置位时整个 `FUN_140171440`（含动画）不跑。位的含义没追（P3 也只说「推迟」）。
3. **`general.zoom` 与粒子相关字段晚一帧**：由地址先后推出，没实测。
4. **子动画上的脚本控制、子的事件**：静态看无效、不触发，没实测。
5. **栈为空时 `thisObject.getAnimation()`**：名字为空串，推断会匹配第一条没有 `name` 的动画。没核对什么时候栈为空（例如光标回调里）。
6. **负 `rate` 在 `single` / `mirror` 下**：按代码 t 会无下限地变负（第 3、11 节），没实测。
7. **`single` 末值停在第 `length−1` 帧的 fps**：float32 算术推出，没实测。
8. **暂停淡变期间动画减速**：引 rea-framework，没对动画单独实测。
9. **dll 的 `0x180014a00` 是 `JSON.parse`**：依据是 `applyGeneralSettings` 分支同用它、实测事件对象字段吻合，没有符号。
10. **根值 `[isolate+0x378]`**：`thisScene.getAnimation()` 不带参数、事件串解析失败时用它。按用法推断是 `undefined`；V8 14 的根表顺序没核对，也可能是别的根值。

## 实测建议（主会话：wpe-renderdoc + kbp gen；优先覆盖上一节）

每条都用平行会话已有的写法：小图层，`origin.x` 或 `alpha` 写曲线，配 CLK 图层和脚本日志。期望值可以用 `ignore\p10\rea\kfmodel.py` 直接算。

1. **`single` 末值与 fps**：
   - 属性：`alpha`（float，一通道）。
   - 关键帧：(0, 0)、(29, 1)，两侧切线都关。
   - 选项：三条，分别是 `fps 14.5 / length 29`、`fps 1.2 / length 12`、`fps 30 / length 29`，都是 `single`。
   - 预期：播完后分别停在 0.96563（第 28 帧的采样）、0.91745（第 11 帧）、约 1.0（第 29 帧）（`endcase.py`）。
2. **`step`**：
   - 关键帧：(0, 0)、(30, 10, `step: true`)、(60, 20)，`loop`，fps 30。
   - 预期：第 0–29 帧恒 0；第 30 帧跳到 10；第 30–60 帧近似线性到 20（第 31 帧 10.332，第 45 帧 14.9998）。
   - 再加一条把 `step` 写在第一个关键帧上，预期不影响任何段。
3. **wraploop 的残留切线**：
   - 关键帧：首帧 (0, 100) 前切线关；末帧 (60, 700) 后切线开 `{x: −1, y: 300}`；`wraploop`、`loop`、`length 60`。
   - 预期：末帧的值改成 100，但后切线 (−1, 300) 仍生效。第 59 帧附近明显鼓出（和后切线关时比较）。
4. **子动画上的脚本与事件**：
   - 同一层：`origin`（父，loop 60）；`alpha`（子，`parent.key = "origin"`，自己的 `events` 在第 10 帧）。
   - `alpha` 的脚本：`update` 里 `thisObject.getAnimation()` 依次调 `pause()`、`setFrame(0)`、`rate = 0`，每帧记 `getFrame()`。
   - 预期：`alpha` 照父的时间变化，不受这些调用影响；`getFrame()` 一直是 0；第 10 帧的事件从不触发。
   - 另在 `origin` 的脚本里设 `rate = 2`，预期子跟着加速。
5. **按属性名查找**：
   - 脚本在没有动画的层上调 `thisScene.getAnimation('alpha')`，场景里有两层的 `alpha` 都带动画、都没写 `name`。
   - 预期：返回 `scene.json` 里先登记的那一条（`play()` 后哪层先动）。
   - `thisScene.getAnimation()` 不带参数，预期 `undefined`。
6. **事件的边界**：
   - `loop`、fps 30、length 60，事件在第 0、第 60、第 59.5 帧（带小数），外加一个自定义键 `{"frame": 30, "name": "x", "extra": 1.23456789012}`。
   - 预期：
     - 第 0 帧的事件在第一帧和每次回绕触发；
     - 第 60 帧的事件在回绕那一帧触发，和第 0 帧的同一帧、在它之前；
     - 第 59.5 帧的事件正常触发；
     - `event.extra` 是 1.2345679（8 位有效数字），`event.frame` 是 30。
   - 加一条 `mirror` 版本：预期第 15 帧的事件每个周期触发两次（正向一次，反向一次）。
7. **事件的接收者**：
   - 同一层两个脚本（一个在 `origin`，一个在 effect 常量上）都导出 `animationEvent(event, value)`，各自记 `value`。
   - 预期：两个都收到；`value` 分别是各自属性的当前值；effect 脚本返回一个新值，画面里那个常量当帧改变。
8. **`relative` 的值类型**：
   - `alpha`（标量）写 `relative: true`、`value: 0.5`；effect vec2 常量写两段字符串 `"10 20"` 加 `relative`。
   - 预期：两者都不加偏移，曲线按绝对值走。
9. **类型与通道数**：
   - `visible` 写成一通道关键帧（0 → 1）。预期：可见性不变。
   - effect vec2 常量只给 `c0`。预期：保持 `value`。
10. **关键帧解析细节**：
    - `frame` 写 10.7 和 10.2 的两个关键帧（截断成 10，后一个被丢掉）。
    - `back` 写成 `{"x": -1, "y": 50}`（没有 `enabled`），预期按开处理、y = 50 生效。
    - `"c0": []` 的标量，预期每帧写 0。
11. **晚一帧**：
    - `general.zoom` 写 `loop` 曲线；同一场景放一个 `instanceoverride.count` 曲线。
    - 读每帧投影与粒子数，和同帧图层 `origin` 曲线对比。
    - 预期：前两者比 `origin` 晚一帧。
12. **暂停连续性**：
    - 用 WPE 的 `-control pause` / `play`（rea-framework Q6，注意 `-playInWindow` 实例不受全局暂停影响，要用普通实例）。
    - 读暂停前后 `alpha` 曲线与 CLK。
    - 预期：曲线和 `g_Time` 同步减速、停住、恢复，没有跳变。
13. **负 `rate`**：
    - `single` 动画播到一半时脚本设 `rate = -1`。
    - 预期：倒退到第 0 帧后继续变负，值在第 0、1 帧的连线上往外延伸不到一帧，呈锯齿。`isPlaying()` 一直为真。

## 字段速查

**动画绑定 B（0x110 字节，构造在 `FUN_1401a4db0` 的 `0x1401a50db` 起）**

| 偏移 | 内容 |
|---|---|
| `+0` | 虚表 `0x14048df78` |
| `+8` | 目标对象（图层、材质、`instanceoverride` 等） |
| `+0x10` | 描述符 |
| `+0x18` | 有效位（通道数 == 分量数） |
| `+0x20` | 通道数组（每个 0x30） |
| `+0x38` | 时钟 K（见第 3 节） |
| `+0x50` | 事件数组（每个 0x28：`float time` + 事件 JSON 串） |
| `+0x68` | `options.name` |
| `+0x88` | 上次推进时的帧计数 |
| `+0x90` | `options.parent.key` |
| `+0xb0` | 父绑定 |
| `+0xb8` | 子集合（`unordered_set`，运行时没看到读者） |
| `+0xf8` | W |
| `+0x100` | 作用域已设定 |
| `+0x108` | 作用域（所属对象或场景，0 为全场景） |

**通道（0x30 字节）**：`+0` 关键帧 vector（每个 0x1c），`+0x18` 整数帧值缓存 vector（float）。

**关键帧（0x1c 字节）**：`+0` frame（int）、`+4` value、`+8` flags（1 back 开、2 front 开、4 step）、`+0xc` backX、`+0x10` backY、`+0x14` frontX、`+0x18` frontY。

**W（0xd8 字节，`FUN_14018db00` 创建）**：`+0` 虚表 `0x14048dfa8`，`+0xc8` 绑定 B，`+0xd0` `rate`。`+0x10`（场景上下文 `+0x1c88`）和 `+0x48`（`FUN_140153760` 初始化的表）的用途是推断，没追。
