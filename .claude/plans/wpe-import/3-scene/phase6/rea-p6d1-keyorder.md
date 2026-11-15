> 逆向原始记录，代理写的，exe 地址按 Ghidra（基址 `0x140000000`），dll 地址按 `0x180000000`。没有新的 WPE 实测；核对用的是已有的 `ignore/p6/d0/out/p6d1-round2.log`（`S0`、`S7keys`、`S7ca keys`、`S7tr keys`）。范围：脚本拿到的材质对象（`effect.getMaterial(i)`、材质常量脚本的 `thisObject`）`Object.keys` 的键顺序。材质对象的其余部分见 `rea-p6d1-xform.md` 第 4 节，命名沿用它。

# WPE 2.8.42 材质对象的键顺序静态逆向

**概括**
1. **顺序由什么决定**：三层叠起来。
   - exe 枚举 `vt+0x10`（`0x140159a70`）往一个 vector 里 `push_back` 描述符：**先按链表顺序列类静态表**（5 个 pass 状态字段），**再按链表顺序列实例表**（材质常量）。两张都是 MSVC `std::unordered_map`，「链表顺序」就是它的迭代顺序，不是桶顺序。【确：`0x140159a9a`–`0x140159be0` 静态表，`0x140159be6`–`0x140159d13` 实例表，都是 `rbx = [rbx]` 沿 `_Next` 走】
   - dll 包装 `W`（`0x181652380`）**按 vector 正序**逐个 `Template::SetNativeDataProperty`，自己不排序、不换容器。【确：`0x181652ac3` 调 `vt+0x10`，`0x181652ae4`–`0x181652b8e` 循环 `add r12, 8`】
   - 模板实例化时 V8（dll 内嵌 **14.7.173.21**，串在文件偏移 `0x17eb4c0`）的 `ConfigureInstance` 用 `AccessorInfo::AppendUnique` **从后往前**收集访问器（同名留后者），再按收集顺序装到对象上；之后才装模板 `property_list`（方法与 `getAnimation`）。所以 **JS 顺序 = 整个 vector 倒过来**，`getAnimation` 在最后。【推：V8 源码 `api-natives.cc` / `objects.cc` 的 `AppendUniqueCallbacks`；dll 里没定位这段。五个状态字段与四组常量的实测都和「倒过来」逐个吻合，见第 5 节】
2. **实例表的容器与散列**：就是 MSVC `std::unordered_map<std::string, 描述符>`，未改的 STL 代码。【确】
   - 散列 = MSVC `std::hash<std::string>` = **FNV-1a 64 位**：初值 `0xcbf29ce484222325`，素数 `0x100000001b3`，逐字节 `h ^= b; h *= P`（mod 2⁶⁴），**不折叠大小写、不混入长度**，字节是 `std::string` 原样（UTF-8）。【确：`0x14015ac66`–`0x14015aca2`】
   - 初始 **8 桶**、掩码 7、`max_load_factor = 1.0f`。【确：材质构造 `FUN_1401515b0` → `0x140153760`，`0x1401537a1`–`0x1401537ad`】
   - 桶号 `h & mask`。插入：**空桶 → 追加到整条链表尾；非空桶 → 插在该桶第一个节点之前**（成为桶首）。【确：`_Find_last` = `0x1400110a0`；插入 `0x14015ae3e`–`0x14015ae89`】
   - 扩容：插入前 `float(size+1) / float(桶数) > 1.0f`（严格大于，即第 9 个键）时扩容。目标 `need = max(8, ceil((size+1)/1.0))`；桶数 < `need` 时，桶数 < 512 且 `8×桶数 ≥ need` 取 `8×桶数`，否则取 `need`；再上取到 2 的幂（8 → 64 → 512 → 1024 → 2048 …）。【确：`_Rehash_for_1` = `0x14015ba50`，`ceilf` = `roundss …, 0xa`】
   - 扩容重排（`_Forced_rehash` = `0x14015bb90`）：清空桶表，**按当前链表从头到尾**逐个节点：所在新桶为空就原地占住；不空就把它**挪到该桶首**（桶第一个节点之前）。扩容完再给待插入的新键重新找位置（同上规则）。【确：`0x14015bc40`–`0x14015bdb8`】
   - 类静态表（`0x1404e7fd0`）同一个容器、同一套插入（`0x14015a000`），登记顺序 `blending, alphawriting, depthtest, depthwrite, cullmode`，链表结果 `blending, alphawriting, cullmode, depthtest, depthwrite`（`cullmode` 与 `depthtest` 同在桶 2，插在它前面）。【确】
3. **插入顺序**：材质加载 `FUN_140154480` 在 `0x1401553b6`–`0x140155544` **按中序遍历程序的合并常量表**（程序 `+0x20`），对每一项 `operator[](材质键)` 插进实例表。【确】
   - 合并常量表是 **`std::map<std::string, 条目>`**（红黑树，节点 0xb0 字节，`+0x19` 是 `_Isnil`，键在 `+0x20`），比较器 `0x140038c30` = `std::string::compare`：`memcmp`（无符号字节，`0x140420ff0`）比公共长度，相等时短的在前。所以**插入顺序 = 材质键按 UTF-8 字节序**（ASCII 下大写 < 下划线 < 小写，空格最小，`center` < `center_falloff`）。【确】
   - 键就是注解 `"material"` 的原串（`FUN_1401636a0` 在 `0x1401639ae`–`0x1401639be` 取成员的字符串写进条目 `+0x48`，`FUN_1400dab40` 在 `0x1400dbe44` 用它做 `operator[]` 的键）。uniform 名（`g_TintColor`）只用来查反射，**不参与排序**。【确】
   - 只含进了反射的：行里没有 `sampler`、注解里 `material` 是字符串、名字在本阶段编译结果的反射里（`0x1400dbe07`–`0x1400dbe34`：查到、标志 `&2`、位置 ≠ −1）。chromaticaberration `MODE 0` 不读 `u_Direction`，被编译器删掉，所以不登记。【确：代码路径；`&2` = 「被使用」为【推】，与 `vector-constant-REPORT` 2.1 同】
   - 两阶段：每阶段一张同类型的 `std::map`，`FUN_1400d39f0(out, a, b)` 先拷 `a` 再把 `b` 逐项按键插入（`0x1400d3b10` 起），`FUN_1400d5070` 调两次（`0x1400d5e6e`、`0x1400d5e7e`）得 顶点 ∪ 几何 ∪ 片元，搬进程序 `+0x20`。**合并方向只决定同键时留哪一条（类型 / 槽位 / 标志），不影响顺序**：结果仍按键排序。【确】
   - 顺带：`FUN_1400d5070` 尾部按同一个中序累加类型分配常量槽位（`0x1400d5ef4`–`0x1400d5f64`），所以 `mat+0x120` 起的常量存储也是按材质键字节序排的。【确】
4. **复刻**：`ignore/p6/rea/layers/keyorder/keyorder.py`（`check` 子命令）按上面三条从着色器文件算顺序，**四组全部等于实测**，五个状态字段的顺序也一致（第 5 节）。没有调任何参数。扩容路径（≥ 9 个键）没有实测，另用照汇编逐指针写的参考实现 `msvc_hash_ref.py` 对拍 200 组随机键集（含 8 / 9 / 64 / 65 / 512 / 513 等边界）一致；第 6 节的 TS 版（`keyorder_ts.ts`，Deno 跑）与之对拍 300 组 + 四组实测也一致。扩容建议补一组实测（第 8 节）。

**为什么之前的假设凑不出来**：散列与 `unordered_map` 的模型本身是对的，错在两头：插入顺序不是声明顺序而是**材质键的字节序**（`std::map` 中序）；而且 V8 装访问器时**又整体倒了一次**。两处一改，同一个 FNV-1a / 8 桶 / 桶首插入模型就全对上了。

**元数据**
- 目标：`ignore/p9/rea/wallpaper64.exe`、`ignore/p10/rea/scenescript64.dll`（与 `rea-p6d1-xform` 同一份）；只读，没运行、没附加 WPE。读了本机 WPE 的 `assets/effects/{tint,transform,chromaticaberration,pulse,fire,lightshafts,watercaustics}` 与 `assets/shaders/common*.h`。
- 方法：**没用 REA**（`wp.asm` 切片足够，没开二进制，没有快照）。exe 用 `ignore/p4/rea/wp.asm` 切片；dll 用 `ignore/p6/rea/layers/script/wrap_52380b.asm`（`rea-p6d-script` 已切好）。
- 工作目录 `ignore/p6/rea/layers/keyorder/`：
  - 汇编切片：`enum_140159a70.asm`（枚举）、`inst_14015ac40.asm`（实例表 `operator[]`）、`findlast_1400110a0.asm`、`rehash1_14015ba50.asm`、`rehash2_14015bb90.asm`、`mapidx_1400ddb60.asm`（`std::map::operator[]`）、`merge_1400d39f0.asm`、`prog_1400d5070.asm`、`parse_1400dab40.asm`、`uline_1401636a0.asm`。描述符建表沿用 `../xform/matdesc_1401553a0.asm`，材质构造沿用 `../xform/matctor_140153760.asm`，静态表登记沿用 `../xform/matreg_1401577c0.asm`。
  - 脚本：`slice.py` / `fn.py` / `pe.py` / `rd.py` / `vtdump.py`（拷自 `xform`）；新写 `h.py`（算 FNV 与桶号）、`cstr.py`（读 exe 字符串）、`rf.py`（读 float 常量）、`v8ver.py`（找 dll 的 V8 版本串）、**`keyorder.py`**（复刻与核对）、**`msvc_hash_ref.py`**（逐指针参考实现 + 对拍）、`predict.py`（扩容用例的预期）、`low32.py`（核对第 6.2 节的 32 位算法）、`gen_cases.py` + `keyorder_ts.ts`（第 6.1 节 TS 版对拍）。
- 标记：【确】汇编直接看到；【推】由代码或外部源码推出。

---

## 1. 枚举：`vt+0x10` = `0x140159a70`【确】
```
enumerate(mat, vec):                                    // vec: std::vector<描述符*>
  vec.reserve(mat.inst.size + STATIC.size)              // 0x140159a8c–0x140159a9a（[mat+0x58] + [0x1404e7fe0]）
  for (n = STATIC.head->_Next; n != STATIC.head; n = n->_Next)   // 静态表 0x1404e7fd8
      vec.push_back(&n->value)                          // 节点 +0x30
  for (n = mat.inst.head->_Next; n != mat.inst.head; n = n->_Next) // 实例表 [mat+0x50]
      vec.push_back(&n->value)
```
- 节点布局（`std::_List_node<pair<const string, 描述符>>`，0x88 字节）：`+0 _Next`、`+8 _Prev`、`+0x10` 键串、`+0x30` 描述符（名字串在描述符 `+0x38`，即节点 `+0x68`）。
- 实例表（`mat+0x48` 起）：`+0x48 max_load_factor`（float）、`+0x50` 链表头、`+0x58` 元素数、`+0x60` 桶向量（每桶 `[lo, hi]` 两个指针，空桶都指向链表头）、`+0x78 _Mask`、`+0x80 _Maxidx`。

## 2. 实例表：MSVC `std::unordered_map`【确】

### 2.1 插入 `0x14015ac40`（`try_emplace`，描述符建表 `0x1401553f2` 调它）
```
h = FNV1a64(key)                                         // 初值 0xcbf29ce484222325，素数 0x100000001b3
(before, dup) = _Find_last(key, h)                       // 0x1400110a0
if dup: return dup
if float(size+1) / float(_Maxidx) > max_load_factor:     // 0x14015ad51–0x14015ada7，comiss，严格大于
    _Rehash_for_1()                                      // 0x14015ba50
    (before, _) = 重新找位置（同 _Find_last，0x14015adb5–0x14015ae37）
新节点插在 before 之前；size++                           // 0x14015ae3e–0x14015ae55
b = h & _Mask
if 桶 b 空:            lo[b] = hi[b] = 新节点             // 0x14015ae6b–0x14015ae89
elif lo[b] == before:  lo[b] = 新节点
elif hi[b] == 旧 before->_Prev: hi[b] = 新节点           // 只有多值容器会走到
```
`_Find_last(key, h)`：`b = h & _Mask`；`hi[b]` 是链表头（空桶）→ `before = 链表头`（即**追加到链表尾**）；否则从 `hi[b]` 沿 `_Prev` 往回比到 `lo[b]`，键相等返回该节点，比完没找到 → `before = lo[b]`（**插到桶首**）。比较是「长度相等且 `memcmp` 为 0」，区分大小写。

### 2.2 扩容
```
_Rehash_for_1():                                          // 0x14015ba50
  need = max(8, (size_t)ceilf(float(size+1) / max_load_factor))
  nb = _Maxidx
  if nb < need: nb = (nb < 512 && 8*nb >= need) ? 8*nb : need
  _Forced_rehash(nb)
_Forced_rehash(nb):                                       // 0x14015bb90
  nb = 1 << (bsr((nb-1) | 1) + 1)                         // 上取 2 的幂
  桶向量重设为 2*nb 项、全指向链表头；_Mask = nb-1；_Maxidx = nb
  for x in 链表（从头到尾，先记下 x->_Next）:
      b = FNV1a64(x.key) & _Mask
      if 桶 b 空: lo[b] = hi[b] = x                       // 原地不动
      else:       把 x 从链表摘下、插到 lo[b] 之前；lo[b] = x   // 0x14015bd6f–0x14015bd90
```
（`0x14015bc9b` / `0x14015bd20` 起的「与 `hi` 或桶内某节点键相等」分支只给多值容器用，唯一键走不到。）

### 2.3 初始化【确】
材质构造 `FUN_1401515b0` 在 `0x140151622` 调 `0x140153760(mat+0x48)`：建两个空 `unordered_map`（第一个就是实例表），各 `max_load_factor = 1.0f`（`0x3f800000`）、`_Mask = 7`、`_Maxidx = 8`、桶向量 16 项。类静态表 `0x1404e7fd0` 在 `0x1401577ee` 用同一个函数建。

## 3. 插入顺序：合并常量表是 `std::map`【确】

### 3.1 描述符建表遍历的是红黑树中序（`0x1401553a8`–`0x140155544`）
```
prog = [mat+0x1e0]; root = [prog+0x20]                   // std::map 的头节点
for (n = root->_Left /*最左*/; !n->_Isnil; n = 中序后继(n))   // 后继：0x1401554fc–0x140155540
    d = &inst.try_emplace(n.条目.材质键)->value           // 键串在节点 +0x88（条目 +0x48）
    d.名字 = 同一个串；d.偏移 = 0x120 + 4*槽位；d.类型按条目类型 …（见 rea-p6d1-xform 4.2）
```

### 3.2 每阶段一张 `std::map`，键 = 注解 `material` 原串
- `FUN_1400dab40` 对每条 uniform 行调 `FUN_1401636a0` 解析：`0x140163805` 行里有 `sampler` 跳过；`0x14016382a` 找成员 `"material"`，`0x140163877` 要求是字符串（rapidjson `0x400`）；uniform 名（第一个 `;` 往回到空格）写进条目 `+0x28`；`0x1401639ae`–`0x1401639be` 把 `material` 的字符串写进条目 `+0x48`。
- 回到 `FUN_1400dab40`：`0x1400dbdc6`–`0x1400dbdf1` 对 uniform 名做 FNV 查本阶段反射（`0x1400dfa90`），`0x1400dbe13`–`0x1400dbe34` 要求查到、`[+0x40] & 2`、位置 ≠ −1，然后 `0x1400dbe44` 以条目 `+0x48`（材质键）调 `std::map::operator[]`（`0x1400ddb60`）并整条覆盖写入。
- `0x1400ddb60` 是标准 `std::map<std::string, …>::operator[]`：节点 0xb0 字节，比较器 `0x140038c30` 是 `basic_string::compare`（`memcmp` 公共长度，`0x140420ff0` 是 CRT `memcmp`，`cmp`/`sbb` 按无符号字节；相等时短者小）。

### 3.3 三阶段合并
`FUN_1400d5070`：`0x1400d5e6e` `FUN_1400d39f0(t, 顶点表, 几何表)`，`0x1400d5e7e` `FUN_1400d39f0(t2, t, 片元表)`，`0x1400d5e83`–`0x1400d5ecc` 把结果换进程序 `+0x20`。`FUN_1400d39f0(out, a, b)`：`0x1400d3a3f`–`0x1400d3b0c` 复制 `a` 的整棵树，`0x1400d3b10` 起中序遍历 `b`、用同一比较器（内联 `memcmp`，`0x1400d3bdd`）逐个按键插入。结果仍是按键排序的 `std::map`。

## 4. dll 与 V8

### 4.1 包装 `W`（`0x181652380`）建模板【确】
```
helper = E+0x400                                          // 只是分配 / 释放 vector 的助手
v = helper.alloc(); obj->vt[0x10](v)                      // 0x181652ab5、0x181652ac3
for d in v（正序，0x181652ae4–0x181652b8e）:
    tpl.SetNativeDataProperty(String(d+0x38), 0x18162b990, (d+0x30 & 2) ? null : 0x18162bae0,
                              External(d, 3), (d+0x30 & 2) ? ReadOnly : None)   // 0x18000a810
helper.free(v)
for m in obj->vt[0x18] 的方法表（正序）: tpl.Set(名字, FunctionTemplate)        // 0x181652bf0–0x181652ca3（材质为空）
tpl.Set("getAnimation", FunctionTemplate(0x18162bbe0))   // 0x181652d19–0x181652d2e
inst = tpl.NewInstance(context)                          // 0x181652d43
```

### 4.2 V8 14.7 的装法【推】
- `SetNativeDataProperty` 把 `AccessorInfo` 追加到模板的 `property_accessors` 列表；`Template::Set` 追加到 `property_list`。
- `ConfigureInstance`：先 `AccessorInfo::AppendUnique` 收集访问器——`AppendUniqueCallbacks` 的循环是 `for (i = n-1; i >= 0; i--)`（注释「从后往前，让同名的后者优先」），已收过的名字跳过——再按收集到的顺序 `JSObject::SetAccessor`；然后按 `property_list` 的顺序装数据属性（方法、`getAnimation`）。
- 对象的字符串键按创建顺序枚举，所以 `Object.keys` = vector 倒序去重 + 方法 + `getAnimation`。
- 依据：V8 源码（本机没有 dll 的符号，没在 dll 里定位这段）；dll 的循环是正序（4.1），而实测里状态字段排在常量之后、五个状态字段恰是静态表链表的倒序，与此吻合。

### 4.3 边角【推】
- **同名**：材质键恰好是 `blending` 等状态名时，vector 里实例那条在后，V8 先收到它、静态那条被跳过：JS 里只有一个属性、走常量描述符，位置在常量那一段；而 `setMaterialProperty` / `constantshadervalues` 按 `vt+0x20` 先查静态表，拿到的是状态字段。语料里没见过这种键。
- **数字样的键**（`"0"`、`"12"`）：V8 把数组下标样的键按数值升序排在所有字符串键之前，不按上面的顺序。语料里没见过。

## 5. 复刻与核对【确：算出 = 实测】
`python -X utf8 -I ignore/p6/rea/layers/keyorder/keyorder.py check`。「被登记的键」由脚本自己从着色器取：极简预处理（`#include`、`#if` 系列、COMBO 缺省值 + pass 组合键），声明之外的活动代码里出现了 uniform 名就算进反射（近似 fxc 的死代码删除；本节四组够用）。

| 组 | 合并表中序（插入顺序） | 桶（8 桶） | 实例表链表 | JS（倒序 + 状态 + getAnimation） | 实测 |
|---|---|---|---|---|---|
| tint | `alpha, color` | 3, 0 | `alpha, color` | `color, alpha, …` | 同 |
| transform | `angle, offset, scale` | 0, 2, 1 | `angle, offset, scale` | `scale, offset, angle, …` | 同 |
| chromatic `MODE 1` | `…center, …center_falloff, …direction, …strength` | 5, 0, 5, 5 | `strength, direction, center, center_falloff` | `center_falloff, center, direction, strength, …` | 同 |
| chromatic `MODE 0` | `…center, …center_falloff, …strength` | 5, 0, 5 | `strength, center, center_falloff` | `center_falloff, center, strength, …` | 同 |
| 静态表 | 登记 `blending, alphawriting, depthtest, depthwrite, cullmode` | 0, 1, 2, 5, 2 | `blending, alphawriting, cullmode, depthtest, depthwrite` | `depthwrite, depthtest, cullmode, alphawriting, blending` | 同 |

（chromatic 的键都带 `ui_editor_properties_` 前缀；`MODE 1` 第 3 步 `direction` 落在非空的桶 5，插到桶首 `center` 之前，第 4 步 `strength` 再插到 `direction` 之前。）

## 6. 移植到 TS

### 6.1 算法
```ts
// 输入：这个 pass 被 WPE 登记的材质键（= 合并常量表的键：顶点 ∪ 几何 ∪ 片元里、进了反射的、注解 material 为字符串的非 sampler uniform）。
// 现有代码里就是 materialSlots(program.uniforms) 中 slot.material && slot.used 的那些键（script/api.ts materialConstants）。
const STATIC = ["blending", "alphawriting", "depthtest", "depthwrite", "cullmode"]; // 登记顺序

function bucketHash(key: string): number {        // FNV-1a 64 的低 32 位（桶掩码不超过 32 位时足够，见 6.2）
  let h = 0x84222325;
  for (const b of new TextEncoder().encode(key)) h = Math.imul(h ^ b, 0x1b3) >>> 0;
  return h;
}

function msvcListOrder(insertOrder: string[]): string[] {
  let nb = 8;                                      // 桶数；mask = nb - 1；max_load_factor = 1
  const list: string[] = [];
  const lo = new Map<number, string>();            // 桶 -> 桶首键（只需桶首；桶尾只有多值容器用）
  const hash = new Map<string, number>();
  const place = (key: string) => {                 // 空桶追加到表尾，非空桶插到桶首之前
    const b = hash.get(key)! & (nb - 1);
    const first = lo.get(b);
    if (first === undefined) list.push(key);
    else list.splice(list.indexOf(first), 0, key);
    lo.set(b, key);
  };
  for (const key of insertOrder) {
    if (hash.has(key)) continue;
    hash.set(key, bucketHash(key));
    if ((list.length + 1) / nb > 1) {              // 严格大于才扩容
      const need = Math.max(8, list.length + 1);   // ceil((size+1)/1.0)
      let n = nb < need ? (nb < 512 && nb * 8 >= need ? nb * 8 : need) : nb;
      nb = 1; while (nb < n) nb <<= 1;
      const old = list.splice(0);                  // 按旧链表顺序重排：空桶原地，非空桶挪到桶首
      lo.clear();
      for (const k of old) place(k);
    }
    place(key);
  }
  return list;
}

const utf8Less = (a: string, b: string) => {       // std::string::compare：无符号字节，前缀短者小
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

function materialObjectKeys(materialKeys: Iterable<string>): string[] {
  const inst = msvcListOrder([...new Set(materialKeys)].sort(utf8Less));
  const vec = [...msvcListOrder(STATIC), ...inst]; // = ["blending","alphawriting","cullmode","depthtest","depthwrite", ...inst]
  const out: string[] = [], seen = new Set<string>();
  for (let i = vec.length - 1; i >= 0; i--) if (!seen.has(vec[i])) { seen.add(vec[i]); out.push(vec[i]); }
  return [...out, "getAnimation"];                  // 材质没有方法表
}
```
- 上面这段原样放在 `ignore/p6/rea/layers/keyorder/keyorder_ts.ts`，`deno run --allow-read keyorder_ts.ts cases.json` 跑过：与 Python 参考（`gen_cases.py` 生成的 300 组随机键集，含 9 / 65 / 513 等扩容边界和非 ASCII 键）及四组实测全部一致。
- 扩容时「按旧链表从头到尾逐个 `place`」与 `_Forced_rehash` 等价：处理到 `x` 时它前面都是已处理过的节点，挪动只往前插，后面未处理部分的相对顺序不变（与逐指针实现对拍一致）。
- 静态表的链表是常量 `blending, alphawriting, cullmode, depthtest, depthwrite`，可以直接写死；JS 尾部恒为 `depthwrite, depthtest, cullmode, alphawriting, blending, getAnimation`。
- 我们的 `define` 若按 `Object.defineProperty` 逐个定义，按 `materialObjectKeys` 的结果顺序定义即可（常量与状态字段要交错的只有 4.3 的同名边角）。

### 6.2 散列只要低 32 位
桶号是 `h & mask`；乘法与异或的低 k 位只依赖操作数的低 k 位，所以 FNV-1a 64 的低 32 位 = 以 `0x84222325`（初值低 32 位）为初值、乘 `0x1b3`（素数低 32 位）的 32 位 FNV，TS 里用 `Math.imul` 即可，不需要 BigInt。`low32.py` 用 20000 个随机串（含非 ASCII）核对一致。桶数到 2³² 之前都够用。

## 7. 未查清 / 未实测
1. V8 那一步没在 dll 里逐指令确认（4.2 的【推】），依据是 V8 源码与实测吻合。
2. **扩容路径没有实测**：四组都不超过 8 个键。读码完整、参考实现对拍一致，但最好补一组。
3. 「进反射」用文本出现近似；真实是 fxc 优化后的反射。函数里写了、但调用被 `#if` 掉或结果没用到的 uniform，近似会误判为「用到」。移植时用翻译器的 `used`（现有 `slot.used`），不要用文本近似。
4. 4.3 的两个边角没实测。

## 8. 建议的实测（扩容）
同 `p6d1-round2` 的做法：一个图层挂一个 effect，脚本 `init` 里 `console.error('[kbp]', Object.keys(thisLayer.getEffect(0).getMaterial(0)).join(','))`。缺省 COMBO 下的预期（`predict.py`）：
- `effects/fire`（9 个键，第 9 个触发 8 → 64 桶；`phasescale` 声明了但没用到、不登记）：
  `threshold,scale,feather,smoothness,speed,distortion,colorstart,colorend,alpha,depthwrite,depthtest,cullmode,alphawriting,blending,getAnimation`
  （不扩容的话会是 `scale,feather,smoothness,speed,threshold,…`，开头就能区分。）
- `effects/pulse`（9 个键；音频那几个常量在 `AUDIOPROCESSING` 缺省下不登记）：
  `tintlow,power,noisespeed,noiseamount,bounds,phase,speed,tinthigh,amount,depthwrite,…,getAnimation`（不扩容对照 `power,tintlow,…`）。
- `effects/lightshafts`（12 个键）：
  `rayspeed,rayscale,rayfeather,point1,point0,colorwintensity,raysmoothness,colorwexponent,point3,colorend,point2,colorastart,depthwrite,…,getAnimation`。
