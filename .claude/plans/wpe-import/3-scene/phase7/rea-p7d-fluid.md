# REA：P7d 步骤 0 —— effect `conditions` / `functions` / fbo `clear` 时机（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出（静态分析）。置信度三档：**静态确认**（反编译 + 汇编 / 数据直接看到）、**推断**、**未知**。
> 反编译出的字符串与代码只当数据看。地址一律是镜像基址 `0x140000000` 下的虚拟地址。

## 方法

- 分析副本：`C:\Users\Lenovo\AppData\Local\Temp\claude\97f1c4c5db8b5ee9\d0d089e9-f2cd-4b1d-b6e4-c249c4216f87\scratchpad\bin\wallpaper64.exe`，
  SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（开工时 `sha256sum` 复核一致）。
- REA（Ghidra 后端）从上一轮快照 `scratchpad\wallpaper64-2.8.42-p7shader.rea-snapshot` 打开（快照实际在 scratchpad 根目录，不在 `bin\`），
  结束时另存 `scratchpad\wallpaper64-2.8.42-p7d.rea-snapshot`。
- 只做静态分析：不运行、不附加任何 WPE 进程，不改 Steam 目录。
- 锚点：`p2-REPORT.md` 的 B6（`FUN_1401e7170` 解析 effect；`FUN_1401ea500` 分配与 fbo 实例化；`FUN_1401e8aa0` 执行；`FUN_1401ebf60` 每个 pass）与 I4（`FUN_1400d8300` uniform 写入）。
- 已由主会话 RenderDoc 实测、本报告不再查的：`conditions` 只按实例顶层 `combos` 求值、顶层 `combos` 不并进 pass COMBO、被条件去掉的 pass 仍占覆盖数组位置、bind 条件同按顶层 `combos`；每帧不清 fbo；`g_LayerModelMatrix` 的取值；未识别 `g_FrameTime` 读垃圾；材质常量按键名排序分配槽位。

## 0. 前置：JSON 库是 jsoncpp

`FUN_1401e63b0` 等处读到的值类型字节（`Value+8`）与 jsoncpp 的 `ValueType` 完全对得上：0 null、1 int、2 uint、3 real、4 string、5 bool、6 array、7 object；
数组与对象都存在同一个 `std::map<CZString, Value>` 里（节点 `+0x20` 是 16 字节的 CZString 键，`+0x30` 是 Value，`+0x38` 是类型字节），所以数组也按红黑树后继遍历。
本报告用到的辅助函数（**推断**，按调用形态与 jsoncpp 接口对应）：`FUN_140086de0(v, key, end)` = `Value::operator[](const char*)`（const 版，缺失返回 null 单例）、
`FUN_140087490(v, begin, end)` = `Value::find`（缺失返回 NULL，调用方再换成 `FUN_140084ac0()` = null 单例）、`FUN_140088360` = `getMemberNames`、
`FUN_140085ee0` = `asInt`、`FUN_140085cc0` = `asString`、`FUN_140086300` = `asBool`、`FUN_1400863a0` = `size`、`FUN_140086540` = `operator[](ArrayIndex)`。
键比较走 CZString（长度 + `memcmp`），**区分大小写**。

字符串常量（`read_bytes 0x1404906d0`，**静态确认**）：`0x1404906d8 "op"`、`0x1404906dc "ge"`、`0x1404906e0 "gt"`、`0x140490724 "fbos"`、`0x140490730 "conditions"`、`0x140490748 "le"`、`0x14049074c "lt"`、`0x140490750 "effects"`。

## 1. `conditions` 的求值规则

### 结论

1. **求值函数只有一个：`FUN_1401e63b0(conditions, combos)`**，返回 bool；effect 加载函数 `FUN_1401e7170` 里调用三处，分别对 fbo（`0x1401e73f2` 附近，反编译行「`uVar18 = get(fbo,"conditions"); cVar9 = FUN_1401e63b0(uVar18, uVar16)`」）、pass（`0x1401e79e5` 附近）、bind（`0x1401e7eb9` 附近）。
   第二个参数 `uVar16` 是 `param_4["combos"]`，`param_4` 是 scene.json 里该 effect 实例的 JSON（`param_4 == 0` 时换成 null 单例）。**静态确认**。
2. **`conditions` 必须是数组**：`if (type(conditions) != 6 /*array*/) return 1;` —— 缺省（null）、写成对象 `{"X":1}`、写成数字 / 字符串，一律**恒为真**。**静态确认**。
3. **数组元素只看对象**：元素类型不是 7（object）就跳过（不影响结果）。对每个对象元素，取 `getMemberNames()` 逐键比较。
   **数组里的多个对象之间是「与」，一个对象里的多个键之间也是「与」**：每个键不满足就把累计值置 false，一个对象处理完累计值为 false 立刻 `return 0`；全部元素都过才 `return 1`。没有「或」。**静态确认**。
4. **左值（combo 当前值）**：只有 `combos` 是对象（类型 7）时才查；`combos[name]` 为 int / uint 取 `(int)`，real 取 `(int)` 截断，**其它类型（缺失 = null、bool、string、对象）一律当 0**。
   也就是：顶层 `combos` 里没有这个名字 → 当 0；`combos` 里写 `true` → 也当 0（不是 1）；`combos` 里写成绑定用户属性的对象形式 → 当 0（`combos` 不经属性框架展开，见下文「补：实例 JSON 怎样落到 effect 对象」；WPE 会不会真写出这种 combos 为**未知**）。不取着色器注解缺省。**静态确认**（类型分支）。
5. **右值（条件里写的值）**两种写法：
   - 数：int / uint 直接比，real 截断成 int 比；**相等才过**。
   - 对象 `{"value": v, "op": "ge"}`：`value` 是数（类型 1..3）就 `asInt`，否则当 0；`op` 只有是字符串且**长度恰好为 2** 时才识别：
     `"ge"` → `combo >= v`；`"gt"` → `combo > v`；`"le"` → `combo <= v`；`"lt"` → `combo < v`；**其它（含 `"eq"`、`"ne"`、缺 `op`、大写 `"GE"`）一律按相等**。
   - 其它类型（string、bool、null、数组）：这个键被忽略（视为满足）。**静态确认**。
   - 所以 gizmos 风格的 `{"op":"ge","value":1}` 在 conditions 里**认**；但没有 `"ne"`、没有「或」。
6. **名字比较区分大小写**（jsoncpp `find` 走长度 + `memcmp`）。**静态确认**（`FUN_140087490` 的调用形态；其内部未单独反编译 → 区分大小写这一点按 jsoncpp 语义为**推断**，但 conditions 键名与 combos 键名都是原样传入 `find`，没有大小写归一的调用）。
7. **什么时候求值：只在 effect 加载时一次。** 三处调用都在加载函数 `FUN_1401e7170` 里，求值结果决定「这个 fbo / pass / bind 有没有被加进 effect 对象」，被去掉的条目根本不进对象，
   运行期（执行 `FUN_1401e8aa0` / 每 pass `FUN_1401ebf60`）不再看 `conditions`。`FUN_1401e7170` 的唯一调用方是 `FUN_1401e6f50`（图层「重建全部 effect」：先对旧 effect 逐个 `FUN_1401e6090` 释放，再按 `effects[]` 逐个 `FUN_1401e7170`）。
   所以只有触发 `FUN_1401e6f50` 的路径（加载、以及它的其它调用方，见下面「重建入口」）才会重新求值；可见性切换不会（见第 3 问）。**静态确认**（调用关系）。
8. **fbo 被条件去掉时**：fbo 定义向量（effect `+0xe8`，每项 0x50，名字在 `+0x28`）里就没有它，后面所有按名字查 fbo 的地方都查不到：
   - pass 的 `target` / `source`：初值 `uStack_188 = 0xffff`（两个字节都是 `0xff` = −1），按名字在 fbo 向量里线性查找，查不到保持 −1 —— **与没写 `target` / `source` 完全相同**（B6：`target` 缺省 = 当前合成链）。**静态确认**（反编译行 `uStack_188 = CONCAT62(...,0xffff)` 与随后的查找循环）。
   - bind：`local_1c0 = CONCAT44(index, 0xffffffff)`，按名字查，查不到 fbo 下标保持 −1 = 当前合成 RT（与 `"previous"` 同一条路）。**静态确认**。
   - bind 自己的 `conditions` 为假：整条 bind 不加进 pass（这个纹理槽保持材质里原来的纹理）。bind 还要求元素是对象、`name` 是字符串、`index` 是数，否则整条跳过。**静态确认**。
   - pass 的 `conditions` 为假：整个 pass 不加，但覆盖数组下标 `uVar35` 照常 +1（与主会话实测一致）。**静态确认**。
   - `functions` 里点名被去掉的 fbo：解析时查不到下标，**静默丢掉这一项**（见第 2 问）。**静态确认**。

### 证据

- `FUN_1401e7170` 反编译（全文存于 `scratchpad\p7d\rea\e7170.c`，1128 行）：
  ```c
  uVar16 = FUN_140086de0(param_4,"combos","");          // 实例顶层 combos
  plVar17 = FUN_140086de0(local_68,"fbos");              // effect.json 的 fbos，类型 6 或 7 都遍历
  ...
  uVar18 = FUN_140086de0(fbo,"conditions","");
  cVar9 = FUN_1401e63b0(uVar18,uVar16);
  if (cVar9 != '\0') { /* 解析 name/format/scale/fit/width/height/unique/clear/uvs，push 进 effect+0xe8 */ }
  ...
  for (uVar35 = 0; uVar35 < size(passes); uVar35++) {
    if (FUN_1401e63b0(get(pass,"conditions"), uVar16)) {
      覆盖 = (实例 passes 是数组) ? 实例passes[uVar35] : 空;   // 下标用 uVar35，不随被去掉的 pass 收缩
      ...
  ```
- `FUN_1401e63b0` 关键片段（类型 6 = 数组，7 = 对象）：
  ```c
  if ((char)param_1[1] != '\x06') return 1;              // conditions 不是数组 → 真
  for (元素 e : conditions) if (type(e) == 7) {
    acc = true;
    for (key : getMemberNames(e)) {
      combo = 0;
      if (type(combos) == 7) { v = find(combos,key) ?: null; combo = (type 1/2) ? (int)v : (type 3) ? (int)(double)v : 0; }
      c = find(e,key) ?: null;
      if (type c 1/2/3)  acc = (int)c == combo ? acc : false;
      else if (type c 7) { val = asInt(c["value"]) 或 0; op = (c["op"] 是字符串) ? asString : "";
        if (len==2 && op=="ge") ok = val <= combo; else if (=="gt") ok = val < combo;
        else if (=="le") ok = combo <= val; else if (=="lt") ok = combo < val; else ok = combo == val;
        acc = ok ? acc : false; }
      /* 其它类型：acc 不变 */
    }
    if (!acc) return 0;
  }
  return 1;
  ```
- 资产参照：WPE 自带 `assets/effects/fluidsimulation/effect.json` 是唯一用 `conditions` / `functions` 的 effect；用法全是 `[ { "LIGHTING": 1 } ]`、`[ { "RENDERING": 3 } ]` 这种单对象单键相等，没有用到 `op`。

### 置信度

- 第 1–3、5、7、8 条：**静态确认**。
- 第 4 条「combos 写成对象（绑定用户属性）时当 0」：类型分支是静态确认；但实例 JSON 到这里时用户属性绑定是否已被展开成数，**未知**（没追 `FUN_1401730d0` 与属性展开路径）。
- 第 6 条（区分大小写）：**推断**（按 jsoncpp `find` 语义；未反编译 `FUN_140087490` 内部）。

## 2. `functions`

### 结论

1. **解析位置**：`FUN_1401e7170` 尾部（反编译行 751 起，`get(effect,"functions")` → `getMemberNames`）。对每个成员名：
   - 值必须是对象（类型 7），否则跳过；
   - `action` 必须是字符串且**恰好等于 `"clear"`**（长度 5 + `memcmp`），否则整个 function 跳过 —— **只认 `clear`，没有别的 action**；
   - `fbos` 必须是数组（类型 6），否则跳过；数组元素是非空字符串时，在 effect 的 fbo 定义向量（`+0xe8`，已按 `conditions` 过滤）里按名字线性查下标，查到就 push 进 `vector<int>`；查不到（含被 `conditions` 去掉的 fbo）**静默丢弃**；
   - 下标向量非空才登记：push 一条 0x40 字节的记录到 effect 对象 `+0x100` 的向量（`FUN_1401f0ed0` / 就地构造）：`+0x00 int action（恒 0 = clear）`、`+0x08 std::string 函数名`、`+0x28 vector<int> fbo 下标`。
   **静态确认**（反编译行 834–1040；`memcmp(puVar15,"clear",5)`；`local_198[0] = 0`；`FUN_1401f0ed0(local_1d0 + 0x20, …)`）。
2. **脚本绑定**：`FUN_1401efca0` 给 effect 脚本类（`IEffectLayer` 一类，单例描述表 `DAT_1404e83e0`）登记属性与方法：
   属性 `visible`（对象偏移 `0x118`，getter `FUN_1401e1a90`、setter `FUN_1401e1b60`，另挂 `FUN_1401e6300`）、`name`（偏移 `0x120`）；
   方法 `getMaterial`（`FUN_1401ee0c0`）、`getMaterialCount`（`LAB_1401ee1a0`）、`setMaterialProperty`（`FUN_1401ee1d0`，两个参数）、
   **`executeMaterialFunction`（原生实现 `FUN_1401ee3a0`，一个字符串参数，参数类型码 `0x200`）**。字符串 `0x1404908f0 "executeMaterialFunction"` 的两处引用 `0x1401f00d8` / `0x1401f0156` 都在这个登记函数里。**静态确认**。
   这里的脚本对象就是 `FUN_1401e7170` 分配的 0x148 字节 effect 对象（vtable `PTR_FUN_1404905c0`）：加载时 `puVar15[0x23] = 1`（`+0x118` visible 初值 1）、`puVar15[0x24..0x27]` 是 `+0x120` 的 name 字符串，与登记的偏移一致。**静态确认**。
3. **按名字找 function**：`FUN_1401ee3a0` 在 `effect+0x100..+0x108` 里逐条比 `strlen(arg)` 与 `memcmp`（**区分大小写、精确匹配**），找不到**静默返回**（不报错、不打日志）。**静态确认**（汇编 `0x1401ee3d0..0x1401ee40c`）。
4. **执行 `clear` —— 有一个 WPE 自己的错位**：找到记录后循环 `i = 0 .. count(fbo下标) - 1`，但取 fbo 用的是**循环计数 `i`，不是记录里的 fbo 下标**：
   ```
   0x1401ee440: MOV RBX, [R14 + 0xe8]        ; fbo 定义向量首址
   0x1401ee447: MOVSXD RAX, EBP              ; EBP = 循环计数 i
   0x1401ee44a: LEA RDI, [RAX + RAX*4] ; ADD RDI, RDI   ; RDI = i*10 → 字节偏移 i*0x50
   0x1401ee451: MOV RCX, [RBX + RDI*8]       ; fbos[i].rt  ← 用 i，没读 [RSI+0x28] 里的下标
   ...
   0x1401ee472..0x1401ee48b: MOVSS [RBX+RDI*8+0x14/0x18/0x1c/0x20] ; fbos[i] 的 clear 色 r g b a
   0x1401ee49a: CALL [RAX + 0x118]           ; device->setClearColor(r,g,b,a)
   0x1401ee4aa: MOV DL,1 ; XOR R8D,R8D ; CALL [RAX + 0x120]   ; device->clear(1, 0)：只清颜色（推断：1 = 颜色位）
   0x1401ee4ea..0x1401ee4fe: RCX = ([RSI+0x30]-[RSI+0x28])>>2 ; CMP i, RCX ; JC     ; 下标向量只用来数个数
   ```
   每次先把 `fbos[i].rt` 压进 RT 栈（`rt[1]+0x50` 处 `+8` 后写入）、调 `rt->vtbl+0x48` 绑定，清完弹栈、恢复上一个 RT（栈顶为空则调 `rt->vtbl+0x50` 解绑）。
   **后果**：`clear` 清的是 effect fbo 列表（按 `conditions` 过滤后的顺序）里**前 N 个** fbo，N = 该 function 点名且查到的 fbo 个数；清色取**那个槽位自己的** `clear` 色。
   以 WPE 自带 `fluidsimulation`（fbos 顺序 0 `_rt_SmokeVelocity1`、1 `_rt_SmokeVelocity2`、2/3 Pressure、4 Divergence、5 Curl、6 `_rt_SmokeDye1`、7 `_rt_SmokeDye2`、8 `_rt_SmokeNormal`（条件 `LIGHTING`））为例：
   `clearVelocity`（下标 [0,1]）碰巧清对；**`clearDye`（下标 [6,7]）实际清的也是槽 0、1（速度场），染料 fbo 一个都没清**。**静态确认**（汇编逐条）。
5. **清成什么色**：槽位 fbo 的 `clear` 色（fbo 条目 `+0x14/+0x18/+0x1c/+0x20` 四个 float）；fbo 没写 `clear` 时这四个 float 是加载时的初值 **0,0,0,0**（`local_114 = 0; local_10c = 0;`），executeMaterialFunction 不看 fbo 的 clear 标志位，照样清成 0。**静态确认**。
   顺带（**静态确认**，反编译行 244–320）：fbo 的 `clear` 字符串**必须解析出 4 个数**才置 clear 标志位（`LAB_1401e7771: local_e0 = 2`），只写 3 个数时颜色存了前 3 个分量、但标志位不置 → 创建 / resize 时不清（B6 写的 `"r g b [a]"` 里 a 可省，应更正为 4 个分量都要写）。
6. **`swap` 之后清的是哪个实体**：fbo 条目 `+0x00` 是 RT 指针，`clear` 直接读 `fbos[i]+0x00` 的**当前**指针；所以若 `swap` 交换的是条目里的 RT 指针，清的就是 swap 之后此刻挂在第 i 个槽位上的实体（见第 3 问对 `swap` 的核对）。
7. **调用方（xrefs 全列）**：`FUN_1401ee3a0` 的全部引用为 `0x1401f016c` / `0x1401f017a`（脚本登记 `FUN_1401efca0` 里把函数指针写进方法描述 `+0x30`）、`0x1404b8efc` / `0x1404b8f30`（`.rdata`，不在任何函数里，推断为异常 / 展开表）、`0x1404fe6dc`（`.pdata`）。
   **没有任何直接 `CALL`**：只能经脚本引擎按方法描述间接调用。另外在 `0x1401dc000–0x1401f2000`（effect 相关代码段）按字节搜 `8B ?? 08 01 00 00`（读 `+0x108`），只命中 `FUN_1401e7170`（登记）与 `FUN_1401ee3a0`（执行）两处 → 属性变化、可见性切换、加载、编辑器路径都**不**执行 functions。
   **静态确认**（xrefs）；「整个程序没有别的读 `+0x100` 向量的地方」限于上述地址段，段外为**推断**。

### 置信度

- 第 1–5、7 条：**静态确认**。第 4 条的错位是汇编逐条读出来的，不是反编译误读；建议主会话用 RenderDoc 抓 `clearDye` 前后的 `_rt_SmokeDye*` 再印证一次（脚本里调 `executeMaterialFunction('clearDye')` 后染料不消失、速度场被清）。
- 第 6 条：依赖第 3 问 `swap` 的实现，见下。

## 3. fbo 的 `clear` 时机，以及 `swap` 在可见性切换后是否复位

### 结论

1. **fbo 的清屏不止「创建 / resize 后」，而是 `FUN_1401ea500` 每跑一次就清一次**：`FUN_1401ea500` 遍历图层上**全部** effect（`layer[0x61..0x62]`，不看 effect 是否可见）的全部 fbo 条目：
   条目 RT 为空 → 先按名字查 RT 池（`FUN_1401ab410`），没有再创建（`FUN_1401aadb0`）；RT 已存在 → `FUN_140161f40(rt, w, h)`（尺寸没变时什么都不做，变了才重建）。
   **两条路最后都落到同一个 `TEST byte [fbo+0x48], 2`**（`0x1401eba1a: JMP 0x1401eba2c` 与 resize 路径的 `0x1401eba28` 都汇到 `0x1401eba2c`），标志位有 clear 就压栈绑定该 RT、`setClearColor(fbo+0x14..+0x20)`、`clear(1, 0)`、弹栈。
   所以 B6「创建 / resize 后立即清」应更正为「**每次重建 effect 资源（`FUN_1401ea500`）都清，不论是否新建、不论尺寸是否变化，也不论该 effect 是否可见**」。**静态确认**（汇编 `0x1401eba2c..0x1401ebadf`）。
2. **可见性切换会触发重建，因而会再清**：effect 脚本类的 `visible` 属性描述（`FUN_1401efca0`，描述 `+0x58`）挂了 `FUN_1401e6300`。它对图层上所有**可见**（`effect+0x118 & 1`）effect 求
   `Σ(compose 计数 effect+0x140 + 1)` 与 `Σ(pass 数)`，跟图层缓存（`layer+0x320` / `layer+0x324`）不同才更新缓存并调 `layer->vtbl+0x110`。
   图层子类（vtable `0x1404911a8`）的 `+0x110` 是 `FUN_1402065e0`：`layer+0x328` 的「正在重载 effect」标志为 0 时，调 `vtbl+0xb0`（按图层尺寸定合成 RT 尺寸）、**`vtbl+0xb8` = `FUN_1401ea500`**（`0x1404911a8 + 0xb8 = 0x140491260` 存的就是 `0x1401ea500`）、`vtbl+0xc0`。
   - 一个有 pass 的 effect 由可见变不可见、再变回可见，两次都会让上面的计数变化 → 两次 `FUN_1401ea500` → 图层上所有带 clear 标志的 fbo（含其它 effect 的、含不可见 effect 的）都被清两次。
   - 把 `visible` 设成它已有的值不会触发（计数不变）。
   **静态确认**：`FUN_1401e6300` 与 `FUN_1402065e0` 的反编译、vtable 槽位读数。
   **静态确认**：属性描述 `+0x58`（即属性子记录 `+0x28`）是「写入后回调」，`visible` 的两个写入口都无条件调用它：
   JSON 写入口 `FUN_1401e1a90`（接受 bool 或 `{"value": bool, …}`，后者经 `FUN_1401a4db0` 登记用户属性绑定）末尾 `if (*(code **)(param_2 + 0x28) != 0) (*(param_2 + 0x28))(obj, desc)`；
   原生写入口 `LAB_1401e1c60`（手工反汇编：`test r8,r8; jz ret; movsxd r10,[rdx+4]; … cmp byte [r8],0; cmove …; mov [r10+rcx],r9d; mov rax,[rdx+0x28]; test rax,rax; jz ret; jmp rax`）同样尾调用。
   读入口是 `LAB_1401e1c90`（`movzx ecx, byte [rax+rcx]; and cl,1; mov [r8],cl; ret`）。
   **推断**：脚本 `effect.visible = …` 走的是原生写入口 `+0x48`、用户属性变化走 JSON 写入口 —— 但两条都调回调，结论不受影响。
   - `FUN_1401ea500` 也被 effect 重载（`FUN_1401e6f50` 末尾调 `vtbl+0x110`）与尺寸变化等路径调用，这些路径同样会清。
   - 只核对了 vtable `0x1404911a8` 这一个图层子类的 `+0x110`；另外两个也登记了 `FUN_1401ea500` 的 vtable（`0x140491a08` / `0x140491dc8` 处）未逐个核对，**未知**。
3. **`swap` 不交换 RT，而是改写 pass 定义里的 fbo 下标**（`FUN_1401ebf60` 的 `command == 2` 分支）：pass 条目 0x30 字节，`+0x00` command、`+0x08` 材质、`+0x10` target 下标（字节）、`+0x11` source 下标（字节）、`+0x14` 标志（bit1 compose）、`+0x18..+0x20` bind 向量（每项 `{int fbo下标, int 槽位}`）。
   swap pass 要求自己的 source、target 都 ≥ 0（都查到了 fbo），否则什么都不做；然后对 effect 的**全部非 swap pass**（从第 0 个到最后一个，不只是后面的）把 `target`、`source`、每个 bind 的 fbo 下标里的 A ↔ B 互换。
   fbo 条目（名字 → RT 指针）**从不交换**。**静态确认**。
   - 所以第 2 问第 6 条的答案：`executeMaterialFunction` 的 `clear` 读的是 fbo 条目里的 RT，名字与实体的对应**永远是初始的那一个**；「swap 之后名字对应的实体」与「初始实体」是同一个东西，变的是各 pass 读写哪个 fbo。（再叠加第 2 问第 4 条的错位：实际清的是条目 0..N−1。）
4. **swap 在可见性切换后不复位**：`FUN_1401ea500` 只碰 fbo 条目与合成 RT，不读写 effect 的 pass 向量（`+0xd0/+0xd8`；在它的反编译与汇编里都没有这两个偏移）。
   effect 不可见期间它的 pass（含 swap）不执行（`FUN_1401e8aa0`：`if ((*(byte *)(effect + 0x118) & 1) != 0)` 才对该 effect 逐 pass 调 `FUN_1401ebf60`），所以 swap 的奇偶在隐藏期间冻结、重新可见后接着用；但 fbo 内容会因为重建被清（第 2 条）。
   只有重载 effect（`FUN_1401e6f50` 释放旧 effect、`FUN_1401e7170` 从 JSON 重建 pass 向量）才把下标复位到 JSON 原样。**静态确认**（偏移检索 + 执行函数的可见性判断）。

### 证据

- `FUN_1401ea500` 汇编（`scratchpad\p7d\rea\ea500.asm`）：
  ```
  0x1401eb9c7: CALL 0x1401ab410        ; 按名字在 RT 池里找
  0x1401eba0b: CALL 0x1401aadb0        ; 找不到就创建
  0x1401eba14: MOV [RCX], RAX ; INC dword [RAX+0x2c] ; JMP 0x1401eba2c
  0x1401eba23: CALL 0x140161f40        ; 已有 RT：按尺寸 resize（同尺寸为空操作）
  0x1401eba2c: TEST byte ptr [RCX + 0x48], 0x2   ; ← 两条路汇合，clear 标志
  0x1401eba30: JZ 0x1401ebadf
  0x1401eba68..0x1401eba7a: MOVSS [RDX+0x20/0x1c/0x18/0x14]   ; clear 色
  0x1401eba85: CALL [RAX + 0x118]      ; setClearColor
  0x1401eba95: MOV DL,1 ; CALL [RAX + 0x120]     ; clear(1, 0)
  ```
- `FUN_140161f40`：`if (w != rt.w || h != rt.h) { 更新尺寸; rt->vtbl+0x40(); ... }` —— 同尺寸不重建。
- `FUN_1401e6300`：
  ```c
  for (e : layer->effects) if (*(byte*)(e+0x118) & 1) { n4 += *(int*)(e+0x140) + 1; n5 += pass数(e); }
  if (layer[100] == n4 && layer+0x324 == n5) return;
  更新缓存; layer->vtbl[0x110](layer);
  ```
- `FUN_1402065e0`（图层 `vtbl+0x110`）：`if (layer[0x65]) return; … vtbl+0xb0(…); vtbl+0xb8(layer); vtbl+0xc0(layer);`
- `FUN_1401ebf60` swap 分支：
  ```c
  if (cmd == 2) {
    if (pass.source < 0 || pass.target < 0) return;
    for (p : effect.passes) if (p.cmd != 2) {
      p.source ↔ (A,B) 互换; p.target ↔ (A,B) 互换;
      for (b : p.binds) b.fbo ↔ (A,B) 互换;
    }
    return;
  }
  ```
- `FUN_1401e8aa0`（反编译行 781–831）：遍历 `layer[0x61..0x62]`，`(*(byte *)(e + 0x118) & 1) != 0` 才执行该 effect 的 pass。

### 置信度

- 第 1、3、4 条：**静态确认**。
- 第 2 条：触发链（写入口 → `FUN_1401e6300` → `vtbl+0x110` → `FUN_1402065e0` → `vtbl+0xb8` = `FUN_1401ea500`）**静态确认**；脚本具体走哪个写入口为**推断**（两个都调回调）；其它两个图层子类的 `+0x110` 为**未知**。

### 补：effect 重建入口（第 1 问第 7 条引用）

`FUN_1401e6f50`（释放旧 effect → 按 `effects[]` 逐个 `FUN_1401e7170` → 清「正在重载」标志 → `vtbl+0x110`）是图层基类 vtable（`0x140490488`）槽 `+0x40` 的实现（`0x1404904c8` 存 `0x1401e6f50`）。
直接调用它的三处：`FUN_1401fbae0`（`0x1401fcbd8`，4400 字节，是图层子类 vtable `0x1404911a8` 的同一槽 `+0x40`，即子类的「从 JSON 加载」覆盖，末尾调基类）、`FUN_140256df0`（`0x140256df9`，27 字节包装）、`FUN_14025fac0`（`0x14025fadf`，36 字节包装）。
**静态确认**：这三处与 vtable 槽位。**未知**：槽 `+0x40` 在场景加载之外（例如编辑器改图层、属性变化）是否会被再次调用 —— 没有追 `+0x40` 的虚调用方。若会，则 `conditions` 会随之重新求值、swap 下标随之复位。

### 补：实例 JSON 怎样落到 effect 对象（第 1 问第 4 条的旁证）

`FUN_1401e7170` 在解析 fbos 之前调 `FUN_1401730d0(scene+0x1708, effect, 实例JSON)`：遍历实例 JSON 的每个键，按名字向 effect 对象的属性表要描述（`effect->vtbl+0x20(name)`），有且未带标志 2 就调描述 `+8` 的 JSON 写入口。
effect 脚本类的属性表里只有 `visible` 与 `name`（见第 2 问第 2 条），所以实例的 `visible`（含 `{"user": …, "value": …}` 绑定）走这里；**`combos` 不是 effect 对象的属性，不经这条路，也就没有用户属性绑定的展开** —— `combos` 里若出现对象值，`FUN_1401e63b0` 一律当 0。
**静态确认**（`FUN_1401730d0` 反编译）；「WPE 的 scene.json 是否会出现绑定用户属性的 combos」本报告没查，**未知**。

## 4. （可选）超过 48 个 float 的材质常量 —— 只查到一半

### 结论

1. **槽位分配在 48 处截断**：`FUN_1400d5070` 尾部（反编译行 1254–1280）按材质常量 map（`param_1[4]`，`std::map`，键名排序）顺序遍历：
   ```c
   bVar37 = 0;
   for (node = map.begin(); node != end && bVar37 < 0x30; ++node) {
     node->slot (+0x45, byte) = bVar37;
     bVar37 += node->size (+0x44, 以 float 计);
   }
   ```
   - 起点 < 48 的键都拿到槽位；**起点 < 48 但跨过 48 的那个键照样拿到槽位**（例如起点 47、4 分量 → 占 47..50），它之后的键这一轮**不再赋值**。**静态确认**。
2. **截断之后的键的槽位值**：这一轮不写 `+0x45`，保留节点里原有的值。节点来自 `FUN_1400d39f0`（两张 map 的合并）：新建节点时 `MOV qword [RDI+0x40], 0` 把 `+0x40..+0x47` 清零，随后 `MOV byte [R15+0x45], CL` 拷源节点的 `+0x45`。源节点最初的值没追到。
   **推断**：多半是 0，即超出的键与排序后第一个键共用槽位 0（写进去会互相覆盖）。**未知**：确切值。
3. 同一函数中段（反编译行 624–650）另有一张**不截断**的「键 → 累计偏移」表（`FUN_1400ddcb0(&local_1e8, 键)`，偏移一直累加），交给 `FUN_1400dccd0` 做各着色器阶段的重映射；两张表在 48 之后会对不上。**静态确认**（存在两种算法）；它们各自给谁用**未知**。
4. **上传是否越界读到 pass 对象 `+0x120` 之后**：**未知**（没找到按 `+0x45` 取槽位上传的那段代码；`0x1400c8000–0x1400e4000` 里 `movzx r, byte [r+0x45]` 的命中有 `FUN_1400d39f0`、`FUN_1400d5070` ×2、`FUN_1400dccd0`、`FUN_1400dfe50`、`FUN_1400e1c00`，后两个可能是运行期使用方，未反编译）。

### 置信度

第 1、3 条**静态确认**；第 2 条**推断**；第 4 条**未知**。

## 对实现的影响

1. **`conditions` 求值器照抄 `FUN_1401e63b0`**：只认数组；元素只认对象；对象内、数组间全是「与」；左值取实例**顶层** `combos`，缺失 / bool / 字符串 / 对象一律 0，real 截断；右值是数就相等，是 `{value, op}` 就认 `ge/gt/le/lt`、其它一律相等；名字区分大小写。`conditions` 写成对象时恒真（不要「好心」当单元素数组）。
2. **只在加载（effect 重建）时求值一次**，被去掉的 fbo / pass / bind 不进 bundle；`target` / `source` 指向被去掉的 fbo 等同没写（当前合成链），bind 指向被去掉的 fbo 等同 `previous`（当前合成 RT）；被去掉的 pass 仍占实例 `passes` 覆盖下标。
3. **fbo 的 `clear` 要 4 个分量才生效**；生效的 fbo 除了创建时清，**每次图层 effect 资源重建都清**（含 effect 可见性真的发生变化时，且清的是该图层上所有带 clear 的 fbo，包括别的 effect 的）。每帧不清（主会话实测）。
4. **`swap` 是改写 pass 图的下标（全部非 swap pass 的 target / source / bind），不是交换纹理**；状态跨帧保留、可见性切换不复位、只有 effect 重载才复位；effect 隐藏期间 swap 不执行（奇偶冻结）。我们若用「交换两个纹理句柄」实现，效果等价的前提是：名字 → 句柄的映射在 functions / 其它按名字查 fbo 的地方也跟着用「当前」句柄 —— 而 WPE 的 functions 清的是**条目本身**的 RT（条目从不交换）。两种实现在 `clear` 只清 A、B 之一时会不一样；`fluidsimulation` 的两个 function 都成对清，所以不受影响。
5. **`executeMaterialFunction` 要复刻 WPE 的错位**才能与 WPE 画面一致：按名字找到 function 后，清的是 fbo 列表（条件过滤后）里**前 N 个**槽位（N = 点名且查到的 fbo 数），清色取该槽位自己的 `clear` 色（没写 `clear` 就是 0）。对 `fluidsimulation`：`clearDye` 实际清的是两个速度场、染料不清。建议先用 RenderDoc 印证再决定是否照抄（见「仍未知」）。function 名找不到静默忽略；`action` 只认 `"clear"`。
6. `executeMaterialFunction` 只有脚本能调；属性变化、可见性切换、加载都不会执行 functions。

## 仍未知

- 实测印证第 2 问第 4 条的错位（在 WPE 里让脚本调 `clearDye`，抓帧看 `_rt_SmokeDye*` 与 `_rt_SmokeVelocity*`）。
- 图层基类 vtable 槽 `+0x40`（`FUN_1401e6f50`，重载 effect）在加载之外是否还会被调用（编辑器、属性变化）；若会，`conditions` 重新求值、swap 复位。
- 另外两个图层子类（`0x140491a08` / `0x140491dc8` 处登记了 `FUN_1401ea500` 的 vtable）的 `+0x110` 是否同样走到 `FUN_1401ea500`。
- WPE scene.json 的 `combos` 是否可能写成绑定用户属性的对象（若可能，按本报告它在 `conditions` 里当 0）。
- `executeMaterialFunction` 的脚本参数是否在进入 `FUN_1401ee3a0` 前做过类型转换（参数类型码 `0x200`，推断为字符串）。
- 第 4 问：截断之后的键的确切槽位值、上传是否越界。
- `FUN_1401e6090`（effect 释放）是否把共享（非 unique）fbo 的 RT 归还池子后、下次按名字重新拿到同一 RT（影响重载后 fbo 内容是否保留）；未看。

## 函数与地址索引

| 地址 | 作用 | 本报告用途 |
|---|---|---|
| `FUN_1401e6f50` | 图层基类 vtable `+0x40`：释放旧 effect、按 `effects[]` 逐个加载、调 `vtbl+0x110` | 重建入口 |
| `FUN_1401e7170` | effect 加载：fbos / passes / bind / functions 解析与 `conditions` 过滤 | 第 1、2 问 |
| `FUN_1401e63b0` | `conditions` 求值器 | 第 1 问 |
| `FUN_1401730d0` | 把实例 JSON 的键按属性表写进 effect 对象（`visible` / `name`） | 第 1 问旁证 |
| `FUN_1401efca0` | effect 脚本类登记：`visible`(`0x118`) / `name`(`0x120`) / `getMaterial` / `getMaterialCount` / `setMaterialProperty` / `executeMaterialFunction` | 第 2 问 |
| `FUN_1401ee3a0` | `executeMaterialFunction` 原生实现（按循环计数取 fbo 的错位在 `0x1401ee440..0x1401ee451`） | 第 2 问 |
| `FUN_1401e1a90` / `LAB_1401e1c60` / `LAB_1401e1c90` | `visible` 的 JSON 写入口 / 原生写入口 / 读入口（两个写入口都尾调 `desc+0x58`） | 第 3 问 |
| `FUN_1401e6300` | `visible` 写入后回调：重算可见 effect 计数，变了就 `layer->vtbl+0x110` | 第 3 问 |
| `FUN_1402065e0` | 图层子类（vtable `0x1404911a8`）`+0x110`：调 `+0xb0`、`+0xb8`（= `FUN_1401ea500`）、`+0xc0` | 第 3 问 |
| `FUN_1401ea500` | 图层 `vtbl+0xb8`：合成 RT 与全部 effect 的 fbo 实例化 / resize，**每次都按 clear 标志清**（`0x1401eba2c`） | 第 3 问 |
| `FUN_140161f40` | RT resize（同尺寸空操作） | 第 3 问 |
| `FUN_1401e8aa0` | 图层 effect 执行：只执行可见 effect 的 pass | 第 3 问 |
| `FUN_1401ebf60` | 单个 pass 执行；`command == 2`（swap）改写全部非 swap pass 的下标 | 第 3 问 |
| `FUN_1400d5070` | 材质常量槽位分配（尾部 48 截断） | 第 4 问 |
| `FUN_1400d39f0` | 材质常量 map 合并（拷 `+0x44/+0x45`） | 第 4 问 |
| `0x1404906d8..0x14049074c` | `"op" "ge" "gt" "fbos" "conditions" "le" "lt"` | 第 1 问 |
| `0x1404908f0` | `"executeMaterialFunction"` | 第 2 问 |
| `0x140490488` / `0x1404911a8` | 图层基类 / 子类 vtable（`+0x40` 加载、`+0xb8` 资源重建、`+0x110` effect 变化回调） | 第 1、3 问 |

effect 对象（0x148 字节，vtable `PTR_FUN_1404905c0`）已知偏移：`+0xc8` 所属图层、`+0xd0..+0xd8` pass 向量（0x30/项）、`+0xe8..+0xf0` fbo 向量（0x50/项）、`+0x100..+0x108` functions 向量（0x40/项）、`+0x118` visible（bit0）、`+0x120` name、`+0x140` compose 计数、`+0x144` 最后一个 compose pass 的下标（推断）。
fbo 条目（0x50）：`+0x00` RT 指针、`+0x14..+0x20` clear 色 rgba、`+0x28` 名字、`+0x48` 标志（bit0 unique、bit1 clear、bit2 uvs repeat）—— 这几项**静态确认**（执行 / 实例化代码直接读）；`+0x08` 格式、`+0x0c` scale、`+0x0e` width、`+0x10` height、`+0x12` fit 按加载时局部变量的排列**推断**（缺省 width / height / fit 为 `0xffff`）。
pass 条目（0x30）：`+0x00` command（0 绘制 / 1 copy / 2 swap）、`+0x08` 材质、`+0x10` target（字节）、`+0x11` source（字节）、`+0x14` 标志（bit1 compose）、`+0x18..+0x20` bind 向量（`{int fbo, int 槽位}`）。
