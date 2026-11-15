# REA：材质对象的五个 pass 状态字段（P6d1，WPE 2.8.42 `wallpaper64.exe`）

> 只读静态分析，没有运行或附加 WPE。地址是镜像基址 `0x140000000` 下的虚拟地址。【确】= 汇编或伪代码直接看到；【推】= 由代码推出或依赖 D3D11 规则。
> 证据来自全量反汇编 `ignore/p4/rea/wp.asm` 的切片和前几轮的伪代码，本轮没有打开 REA 会话，所以没有新快照。切片存在 `ignore/p6/rea/layers/matstate/`（文件见文末）。

## 概括

**1. setter / getter 与字符串表**【确】
- 五个字段是材质类静态表（`0x1404e7fd0`，`FUN_1401577e0` 登记）里的五个描述符，类型 5，每个字段一个字节（`mat+0x1f0`–`+0x1f4`）。每个字段各有四个函数：JSON 读、JSON 写、原生 setter、原生 getter，查的是各自的一张函数内静态表 `vector<{std::string 名, uint8 值}>`（元素 0x28 字节，首次登记时懒初始化）。
- 五张表的**完整内容与顺序**：

  | 字段 | 偏移 | 表（按顺序：名 → 值） | 首项（非法值落到这里） | 缺键（材质构造清零） |
  |---|---|---|---|---|
  | `blending` | `+0x1f0` | normal 0、translucent 1、additive 2、alphatocoverage 3 | normal | normal |
  | `alphawriting` | `+0x1f1` | default 0、disabled 2、enabled 1 | default | default |
  | `depthtest` | `+0x1f2` | **disabled 1**、enabled 0 | **disabled** | enabled |
  | `depthwrite` | `+0x1f3` | **disabled 1**、enabled 0 | **disabled** | enabled |
  | `cullmode` | `+0x1f4` | normal 0、nocull 1 | normal | normal |

  `blending` **只有这四个**；设备里另有混合键 4（颜色写关），但那是设备的键，不是材质能写的值（`FUN_1401531c0` 的反查也只有这四个名字）。
- setter（`0x1401580f0` 等）：先 `strlen`，再逐项比长度、`memcmp`，**区分大小写、不去空白**；第一个相等的项取它的值；**一项都不等就取表的第一项**（`[表首 + 0x20]`），写进 `mat+偏移`。所以非法值不是统一「复位成 0」：`depthtest` / `depthwrite` 写错会变成 **disabled**。
- dll 一侧（rea-p6b-layout 6.2，类型 5 通用）：`undefined` / `null` 不写；字符串直接用；数字、布尔、对象先 `ToString`（`2` → `"2"`、`true` → `"true"`，都落到首项）。
- getter（`0x1401581d0` 等）：读当前字节，按值反查表，把匹配项的名字交给 dll，所以读出来总是表里的规范名（写 `"Additive"` 后读到 `"normal"`）。
- 材质加载时读 JSON 的是同一张表（`FUN_140154480` 开头 `FUN_1401730d0` 按 JSON 键调 `d+0x8`）：值不是 JSON 字符串时当空串，同样落到首项；`{user}` / `{script}` 写法不会建绑定，也落到首项。和 rea-p5-mesh 3.3 一致，编译期 `normalizeDepthKeys` 已经照做。

**2. 改值回调**【确】
- **没有改值回调**：描述符的回调槽 `d+0x28` 在节点分配时清零（`FUN_14015a000` 的 `0x14015a14a`），`FUN_1401577e0` 不写它，全 exe 对静态表 `0x1404e7fd0` 的引用只有登记、按名查（`0x140159900`）、列举（`0x140159a70`）和析构。setter 尾部「回调非空才调」的分支永远不进。不标脏、不建管线、不碰着色器。
- 当帧生效靠的是**每次绑定都现读字节**：材质绑定 `FUN_140155fc0` 末段（`0x140157160`–`0x14015726a`）按五个字节设设备状态位，解绑 `FUN_140157430` 按同样五个字节恢复；绘制前 `FUN_140099f60` 按设备状态位挑 D3D11 状态对象。脚本（帧内第 7 步）在渲染（第 8 步）之前，所以写入当帧就画出来。

**3. `alphatocoverage` 与着色器变体**【确】
- **运行中切换不会重取着色器变体，只改混合 / A2C 状态。** 组合键 `ALPHATOCOVERAGE = 1`（`0x140154bc1`）和 `ADDITIVE = 1`（`0x140154c5a`）只在 `FUN_140154480` 里按**加载时**的 `+0x1f0` 拼进组合键表，随后 `FUN_1401a5c40`（`0x140154dd9`）按组合键取程序存进 `mat+0x1e0`。`FUN_140154480` 全 exe 只有两个调用点，都在材质创建 `FUN_1401515b0` 里（`0x140151970`、`0x1401519c2`）；`FUN_1401a5c40` 也只在这两个函数里调。setter 没有回调（第 2 条），绑定函数在主 pass 里（`ctx+0x12eb == 2`）直接跳到状态段，不碰 `+0x1e0`。
- 于是：
  - 加载时 normal、运行中写成 `alphatocoverage`：混合状态变成 A2C 开、混合关（与 P8 同一个混合对象），深度写不被强制关；**片元着色器还是原来那份，没有 `fwidth` 锐化**。
  - 加载时 `alphatocoverage`、运行中写成别的：A2C 关、按新模式混合（translucent / additive 还会强制关深度写），**着色器仍带锐化**，混合用的是锐化成近似 0 / 1 的 alpha。
  - `additive` 同理：运行中写成 additive 不会加 `ADDITIVE` 组合键（只影响 generic4 等的雾分支，hdr-macro-REPORT）。
- 绑定函数里另一处加 `ALPHATOCOVERAGE` 的代码（`0x1401564a4`，rea-p8-render 第 5 节提到的那处）只在**阴影 pass**（`ctx+0x12eb ≠ 2`）建投射变体时走，变体按模式缓存在 `mat+0x300`、只建一次，建好后不随脚本写入更新；puppet 裁切遮罩材质的那处（`0x14020ad1d`）是加载期派生。都不是主 pass 的运行时重选。

**4. `alphawriting`、深度、剔除的运行中状态**【确】
- `alphawriting`：规则和加载时完全一样（同一个绑定 / 解绑路径现读字节），即 rea-p8-render 4.4 的表：1 → 绑定时 `dev+0xd8(1, 1)`，2 → `(1, 0)`，0 → 不动；绑定前的写 alpha 位存进 `mat+0x1f8` bit4，解绑时（字节非 0）恢复。最后一个 effect 的上屏 pass 在绑定之后又被 `dev+0xd8(1, ctx+0x1c9 > 0)` 覆盖，`alphawriting` 对它无效。
- `depthtest` / `depthwrite`：绑定时置 `dev+0x24` 的 bit1（不测）/ bit0（不写），绘制前取 `dev+0xc0 + 8·(dev+0x24 | (混合 ∈ {translucent, additive}))`。深度模板状态对象在设备初始化 `FUN_140099050` 里**一次建好**（0：测+写 GREATER，1：测不写，2 / 3：不测），运行中只是换下标，从不现建。
- `cullmode`：nocull 时绑定 `dev+0xa8(0)` 置 `dev+0x25` bit1，光栅状态对象同样在 `FUN_140099050` 里预建 8 个，按 `dev+0x25` 取。
- 混合状态对象按键（`dev+0x28` 状态字 | 模式）**首次用到时建、之后缓存**在 `dev+0x140` 表里（`FUN_140099f60` 的 `0x14009a09e`–`0x14009a1f2`）。

**对 Kabegame 的直接含义**（【推】，细节见第 7 节）：脚本写这五个字段 = 改这个 pass 下一次绘制用的管线状态（混合、A2C、深度、剔除、写掩码），**程序（WGSL 模块与组合键）保持加载时那份**。运行中切到 `alphatocoverage` 时用该程序的 A2C 入口（`programs.ts` 的 `alphaToCoverage()`，本来就按程序懒建、与组合键无关），但不换成带 `ALPHATOCOVERAGE` 锐化的变体。

---

## 1. 静态描述符的布局【确】

`FUN_14015a000`（按名字 FNV-1a 插入哈希表）给每个键分配 0x88 字节节点并全部清零（`0x14015a0ec`–`0x14015a167`）。描述符 `d` = 节点 `+0x30`：

| `d+` | 节点 `+` | 含义 | 静态表里的值 |
|---|---|---|---|
| `0x00` | `0x30` | 类型 | 5（字符串） |
| `0x04` | `0x34` | 字段偏移 | `0x1f0`–`0x1f4` |
| `0x08` | `0x38` | JSON → 字段（`FUN_1401730d0` 调） | 见下表 |
| `0x10` | `0x40` | 字段 → JSON | 见下表 |
| `0x18` | `0x48` | 原生 setter（dll 写字段时调，rea-p6d1-xform 4.1 的「写」） | 见下表 |
| `0x20` | `0x50` | 原生 getter | 见下表 |
| `0x28` | `0x58` | 改值回调 | **0**（没人写） |
| `0x30` | `0x60` | 标志字节（bit1 = JSON 不读，`FUN_1401730d0`） | 0 |
| `0x38` | `0x68` | 名字 `std::string` | `blending` 等 |

| 字段 | JSON 读 | JSON 写 | setter | getter | 表首 / 表尾指针 | 懒初始化 |
|---|---|---|---|---|---|---|
| `blending` | `0x1401587d0` | `0x140158960` | `0x1401580f0` | `0x1401581d0` | `0x1404e9338` / `40` | `0x140157d42` |
| `alphawriting` | `0x140158b40` | `0x140158cd0` | `0x140158250` | `0x140158330` | `0x1404e9348` / `50` | `0x140157e70` |
| `depthtest` | `0x140158eb0` | `0x140159040` | `0x1401583b0` | `0x140158490` | `0x1404e9358` / `60` | `0x140157f66` |
| `depthwrite` | `0x140159220` | `0x1401593b0` | `0x140158510` | `0x1401585f0` | `0x1404e9368` / `70` | `0x140158024` |
| `cullmode` | `0x140159590` | `0x140159720` | `0x140158670` | `0x140158750` | `0x1404e9378` / `80` | `0x140157c84` |

- 表元素：`+0x00` `std::string`（`+0x10` 长度、`+0x18` 容量）、`+0x20` 值字节，步长 0x28。字符串常量：`normal` `0x140476fd0`、`translucent` `0x14048b500`、`additive` `0x14048b520`、`alphatocoverage` `0x14048b510`、`default` `0x140476ef8`、`disabled` `0x140476ea0`、`enabled` `0x140473fb0`、`nocull` `0x14048b52c`。
- `FUN_140153760`（登记前先对 `0x1404e7fd0` 调）只是建空哈希表（负载因子 1.0、8 桶），不继承任何描述符。

## 2. 写与读【确】

### 2.1 原生 setter（以 `blending` 的 `0x1401580f0` 为例，五个字段同构）
```
setter(mat, d, const char* s):
    if s != null:
        n = strlen(s)
        for e in 表:                                  // 按表顺序
            if e.len == n && (n == 0 || memcmp(e.str, s, n) == 0):   // n == 0 时表里没有空名，不会命中
                v = e.val; goto 写
        v = 表[0].val                                 // 一项都不等：取首项
    写: mat[d.offset] = v
    if d.callback: tailcall d.callback(mat, d)        // 静态表恒为空，不进
```
- `s == null` 时什么都不写（dll 对 `undefined` / `null` 本来就不调）。
- 比较是 `memcmp`：**区分大小写**，前后空白算字符。

### 2.2 原生 getter（`0x1401581d0` 等）
```
getter(mat, d, sink):
    v = mat[d.offset]
    for e in 表: if e.val == v && sink.ctx: sink.fn(sink.ctx, e.str, e.str + e.len)
```
字节只会是表里的值，每次恰好交出一个名字。

### 2.3 JSON 读（加载时，`0x1401587d0` 等）
- 值的 jsoncpp 类型是 4（字符串）才取串，否则当空串；查表同 2.1（找不到取首项），写字节，尾调回调（空）。
- 不读包装结构 `[r9]` 的绑定管理器，**不登记任何绑定**：`"blending": {"user": …}` / `{"script": …}` 都等于写了个非法值，落到首项，之后也不会随属性或脚本变。【确：函数体】
- 加载入口：`FUN_140154480` 第一行 `FUN_1401730d0(ctx+0x1708, mat, passJson)` 按 pass JSON 的键（jsoncpp 对象按键名排序）逐个 `mat->vt[0x20](键)`，命中描述符且标志没有 bit1 就调 `d+0x8`。

### 2.4 dll 的转换（rea-p6b-layout 6.2，dll `FUN_181620e10` 的类型 5 分支 `0x181621338`）
`undefined` / `null` → 不写；字符串 → 原样；其它 → `ToString`（失败不写）→ UTF-8 → `d+0x18`。读取走 `d+0x20`，返回 JS 字符串。

于是脚本可见的规则：

| 写入 | `blending` 读回 | `depthtest` 读回 |
|---|---|---|
| `'translucent'` / `'disabled'` | translucent | disabled |
| `'Translucent'`、`' additive'`、`'yes'` | normal | **disabled** |
| `2`、`true`、`{}`（ToString 后不在表里） | normal | **disabled** |
| `null`、`undefined` | 不变 | 不变 |

## 3. 生效路径：绑定与解绑【确】

### 3.1 绑定 `FUN_140155fc0` 末段（`0x140157157`–`0x14015726a`，主 pass 一进函数就跳到这里）
```
if mat+0x1f8 & 1: 重传常量块（这是材质常量的脏位，与本节无关）
b = mat[0x1f0];  if b in {1, 2, 3}: dev->vt[0x128](b)       // dev+0x26 = 混合模式；normal 不调
if mat[0x1f2] == 1: dev->vt[0xc8](0)                        // dev+0x24 |= 2：不测深度
if mat[0x1f3] == 1: dev->vt[0xd0](0)                        // dev+0x24 |= 1：不写深度
if mat[0x1f4] == 1: dev->vt[0xa8](0)                        // dev+0x25 |= 2：不剔除
a = mat[0x1f1];  if a in {1, 2}:
    mat+0x1f8 bit4 = dev->vt[0xe0]()                        // 记下当前写 alpha 位
    dev->vt[0xd8](1, a == 1)
```
设备虚表 `0x140485b90`：`+0xa8` = `0x14009af50`（`+0x25` bit1 = !x）、`+0xc8` = `0x14009afb0`（`+0x24` bit1 = !x）、`+0xd0` = `0x14009afd0`（`+0x24` bit0 = !x）、`+0xd8` = `0x14009aff0`、`+0xe0` = `0x14009b030`、`+0x128` = `0x14009b1f0`（`+0x26` = x）。

### 3.2 解绑 `FUN_140157430`（`0x1401574b5`–`0x140157568`）
`blending ≠ 0` → `vt[0x128](0)`；`depthtest == 1` → `vt[0xc8](1)`；`depthwrite == 1` → `vt[0xd0](1)`；`cullmode ≠ 0` → `vt[0xa8](1)`；`alphawriting ≠ 0` → `vt[0xd8](1, 保存的 bit4)`。

### 3.3 绘制前选状态对象 `FUN_140099f60`
- 深度模板：下标 `dev+0x24 | (dev+0x26 ∉ {0, 3} ? 1 : 0)`，取 `dev+0xc0[下标]`，变了才 `OMSetDepthStencilState`。
- 光栅：下标 `dev+0x25`，取 `dev+0xe8[下标]`，变了才 `RSSetState`。
- 混合：键 = `dev+0x28` 状态字 | (写颜色 ? `dev+0x26` : 4)；`dev+0x140[键]` 为空时按键填 `D3D11_BLEND_DESC` 调 `CreateBlendState` 并存回（`0x14009a0ab`–`0x14009a1f2`），之后命中缓存；变了才 `OMSetBlendState`。各模式的描述见 rea-p8-render 4.1。

### 3.4 状态对象是预建的（`FUN_140099050`，设备初始化）
| 表 | 下标 | 内容 |
|---|---|---|
| 深度模板 `dev+0xc0` | 0 / 1 / 2 / 3 | 测 + 写全部 + GREATER / 测、不写 / 不测（DepthEnable 0）/ 同 2（`0x14009909d`–`0x1400990f9`） |
| 光栅 `dev+0xe8` | 0 / 1 / 2 / 3 | SOLID、FrontCounterClockwise 1、DepthClip 1，剔除 BACK / FRONT / NONE / 同 2（`0x140099100`–`0x1400991a7`） |
| 光栅 `dev+0x108` | 4 / 5 / 6 / 7 | SlopeScaledDepthBias −4，剔除 NONE / FRONT / NONE / 同 6（阴影 pass 用，P13d 已实测「材质缺省剔除时实际不剔」） |

运行中改 `depthtest` / `depthwrite` / `cullmode` 只换下标，不会现建对象；混合对象第一次碰到新键时建一次。

## 4. `alphatocoverage`：加载期定变体，运行期只改状态【确】

1. **组合键只在材质加载时拼**：`FUN_140154480`（伪代码 `ignore/p11/rea/tex/dc/f_140154480.c` 第 366–401 行）
   - `0x140154bc1`：`mat[0x1f0] == 3` → 组合键表加 `ALPHATOCOVERAGE = 1`；
   - `0x140154c5a`：`mat[0x1f0] == 2` → 加 `ADDITIVE = 1`；
   - `0x140154dd9`：`FUN_1401a5c40(ctx+0x15a8, 着色器名, {组合键, 纹理})` 取程序，存 `mat+0x1e0`。
   这时的 `mat[0x1f0]` 是 `FUN_1401730d0` 刚从 JSON 读进来的值。
2. **只在材质创建时跑**：`FUN_140154480` 的调用点只有 `0x140151970`、`0x1401519c2`（都在 `FUN_1401515b0`）；`FUN_1401a5c40` 的调用点只有 `0x140151a83`（`FUN_1401515b0`）和 `0x140154dd9`。effect pass 的材质由 `FUN_1401e7170` 的 `0x1401e7b04` 经 `FUN_140150770` 新建（每次新建一份，登记名带 `_instance_`），不是按名共享的缓存（`FUN_14014ff70` 才是），所以脚本写一个 effect 的材质不会连带别的图层。
3. **绑定时主 pass 不碰程序**：`FUN_140155fc0` 开头 `while (ctx+0x12eb != 2)` 才进变体分支；主 pass 与反射 pass 都是 2（rea-p13-passes），直接到 3.1 的状态段。
4. **变体分支（阴影 pass）**：`ctx+0x12eb == 0` 时按模式在 `mat+0x300` 缓存一个投射变体（`materials/util/shadowcaster.json` 或注解指定的着色器），建的那一刻 `mat[0x1f0] == 3` 才加 `ALPHATOCOVERAGE` 并把变体的 `+0x1f0` 置 3（伪代码 `ignore/p5/rea/mesh/bindmat_140155fc0.c` 第 260–280 行）。只建一次，之后脚本改 `blending` 不影响阴影 pass。（rea-p8-render 5.4 把 `0x1401564a4` 和 `0x140154bc1` 并列为「绑定时加组合键」，前者其实只属于这个分支。）
5. **puppet 裁切遮罩**（`0x14020ad1d`）：建 `clippingmaskimage4.json` 派生材质时按基础材质的 `blending == 3` 加组合键，加载期。

**结论**：主 pass 的程序（与它的 `ALPHATOCOVERAGE` / `ADDITIVE` 组合键）在材质的整个生命周期里不变；运行中写 `blending` 只改 `dev+0x26`，即混合描述（A2C 开关、BlendEnable、混合因子）与「translucent / additive 强制不写深度」。

## 5. `alphawriting` 的写掩码【确】

和加载时的规则相同（同一段绑定代码现读字节），rea-p8-render 4.4 的表原样适用：

| 绘制 | `default` | `enabled` | `disabled` |
|---|---|---|---|
| 直接上屏的图层（基础材质） | 7 | 0xF | 7 |
| 合成 RT 的基础 pass、effect 中间 pass | 0xF | 0xF | 7 |
| 最后一个 effect 的上屏 pass | 7 | 7（被覆盖） | 7（被覆盖） |

脚本能写到的 effect 材质，实际只在中间 pass 上起作用：`disabled` 把 0xF 改成 7（alpha 保留目标原值），`enabled` 与缺省相同。

## 6. 哪个材质的字段管哪次绘制【确：代码；推：可达性】

- **effect 中间 pass**（画进合成 RT / fbo）：五个字段全用这个 pass 自己的材质。合成 RT、fbo 不挂深度（rea-p5-mesh 3.1），`depthtest` / `depthwrite` 在画面上看不出来，只体现在 RenderDoc 的深度模板状态上。
- **最后一个 effect 的上屏 pass**（`FUN_1401ebf60`，伪代码 `ignore/p5/rea/modelflags/f_1401ebf60.c` 第 171–181、327–342 行）：
  - 绑定前先存下 effect 材质的 `+0x1f0` / `+0x1f2` / `+0x1f3`，再调图层虚函数 `+0x108` = `FUN_140209160`：**直接改写 effect 材质的字节**，`+0x1f0` = (cbm == 31 ? 2 : 基础材质 `+0x1f0`)，`+0x1f2` / `+0x1f3` = 基础材质的值；
  - 绑定、画、解绑之后**恢复**存下的三个字节。
  - 所以这个 pass 上脚本写的 `blending` / `depthtest` / `depthwrite` **对上屏无效**（但读回的是脚本写的值）；`cullmode` 用它自己的；`alphawriting` 被 `vt[0xd8](1, ctx+0x1c9 > 0)` 覆盖。
- **合成 RT 的基础 pass**（`FUN_140207b50`）：绑定后 `vt[0x128](0)`，混合恒为 normal（A2C 关），其余字段照基础材质。
- **passthrough 上屏**（`0x10` 路径）：混合 = cbm 31 ? 2 : 图层虚函数 `+0x120` = `FUN_1402091d0`（读基础材质 `+0x1f0`），每帧现读（rea-p8-render 2.3）。
- **脚本能写到哪些材质**：`effect.getMaterial(i)` = effect pass 材质。基础材质只能经它的常量上挂的字段脚本的 `thisObject` 写到（rea-p6d-script：材质常量脚本的 `thisObject` 就是这个材质的包装）【推：是否真有图像层基础材质的常量脚本没查】。写到的话，影响直接上屏、上屏 pass 借用和 passthrough 上屏。
- **材质重建**：材质只在 `FUN_1401515b0` 里建，新材质从 JSON 读字段；effect / 图层被重建时脚本写过的状态丢失。正常运行中没找到重建 effect 材质的路径【推】。

## 7. 对 Kabegame 的含义【推】

1. **写入规则**：五张表照第 1 节（含顺序，首项是非法值的落点，`depthtest` / `depthwrite` 落到 disabled）；`null` / `undefined` 不写，其它 `ToString`；区分大小写、不去空白。读回给规范名。和编译期的 `normalizeDepthKeys` 共用一份表最好。
2. **就地写，不重编译**：写入改 pass 的状态字段，下一次画这个 pass 时按新值选管线（混合、A2C、深度测试 / 写、剔除、写掩码）。**不改程序**：组合键（`ALPHATOCOVERAGE`、`ADDITIVE`）在编译期按 JSON 定死，运行中切换不重编、不换变体。
3. **运行中切到 `alphatocoverage`**：用这个程序的 A2C 入口（`program.alphaToCoverage()`：按程序懒建、与组合键无关，丢弃 alpha < 0.5 + 2⁻¹²），程序本身没有锐化；切离时回到普通入口，程序仍带锐化（如果加载时是 A2C）。
4. **深度写**：translucent / additive 强制不写深度，要按当前的 `blending` 现算（`graph.ts` 的 `rasterState` 已经这么算，只要让它读运行时值）。
5. **上屏 pass 借基础材质**：最后一个 effect 的上屏 pass 的混合与深度取基础材质的当前值（effect 材质上的脚本写入对它无效），剔除取自己的；合成 RT 的基础 pass 混合恒为 normal。现有的「上屏借基础材质」逻辑若在编译期取值，要改成读运行时状态（基础材质被脚本写到时才有区别）。
6. **重编译重放**：WPE 的字节随材质存活，我们重编译后要把这五个字段的写入和常量写入一起重放。
7. **阴影 pass**（P13）：投射变体在第一次阴影绑定时按当时的 `blending` 定，之后不变；运行中改 `blending` 不影响阴影投射。

---

## 8. 建议的 WPE 实测

> 都用 `wpe-renderdoc` 抓帧（连续若干帧，覆盖切换前、切换当帧、切换后）。脚本挂在图层上，用帧计数器 `i` 定切换时刻并 `console.log` 读回值（`log_since` 取）。
>
> **共用结构（M1–M3、M7）**：
> - 图层：256×256 纯黑不透明。
> - effect 0（被测）：两个 pass，都不写 `target`。pass 0 是工程自带的直通拷贝（采样 `g_Texture0` 原样输出），pass 1 是探针。
> - effect 1：单 pass 直通拷贝，当上屏 pass，保证探针不是上屏 pass（上屏 pass 的混合借基础材质，见第 6 节）。
> - 为什么要 pass 0：合成 RT 两张交替写、从不清（rea-p8-render 2.3、4.4）。探针若紧跟基础 pass，它的目标装的是**上一帧**探针的输出，「这一帧没覆盖」和「上一帧覆盖了」分不清。加一个拷贝 pass 后，基础 pass → RT a，拷贝 → RT b，探针 → RT a，探针的目标正好是本帧基础 pass 写的黑图。抓帧时先核对探针那次 draw 的 RTV 与基础 pass 的是同一个资源。
> - 「探针着色器」：输出 `vec4(1, 0, 0, u_alpha)`（`u_alpha` 是材质常量 `"material": "probe_alpha"`），末尾照抄 `genericimage4.frag` 第 223 行的 `#if ALPHATOCOVERAGE` 锐化块，另加 `#if ADDITIVE gl_FragColor.g = 1.0; #endif`。

**M1 运行中切到 `alphatocoverage`（判定着色器变不变，最关键）**
- 探针材质 `blending: normal`，`probe_alpha = 0.5002`。
- 脚本：`i == 60` 时 `thisLayer.getEffect(0).getMaterial(1).blending = 'alphatocoverage'`，并打印读回。
- 对照工程 M1c：探针材质加载时就写 `alphatocoverage`，不挂脚本。
- 看探针那次 draw：
  - 像素着色器的 ResourceId 与反汇编：**预测切换前后是同一个，没有 `deriv_rtx` / `deriv_rty`**；M1c 是另一个、带 `fwidth` 锐化。
  - OM：切换后（第 60 帧起，当帧生效）`AlphaToCoverageEnable` TRUE、`BlendEnable` FALSE、写掩码 0xF。
  - 画面：常数 alpha 的 `fwidth` 为 0，锐化变体得 `saturate(0.0002 / 1e-4 + 0.5) = 1` → 覆盖 → **红**；无锐化 0.5002 < 0.5 + 2⁻¹² → 不覆盖 → **黑**。预测 M1 切换前红（normal 直接写）、切换后黑，M1c 红。若 WPE 运行中重取变体，M1 切换后仍是红。

**M2 运行中切离 `alphatocoverage`（像素上最好判）**
- 探针材质加载时 `alphatocoverage`、`probe_alpha = 0.3`，`i == 60` 时写 `translucent`。
- 预测：像素着色器不变（仍带锐化）；OM 变成 `BlendEnable` TRUE、SRC_ALPHA / INV_SRC_ALPHA、A2C FALSE。锐化后 alpha = 0 → 黑不变；若重取变体（无锐化）会是 0.3 红叠黑 = (77, 0, 0)。`probe_alpha = 0.7` 再跑一次：预测纯红 (255, 0, 0)，重取变体则 (179, 0, 0)。

**M3 `ADDITIVE` 组合键**（可并进 M1 工程，另加一个同结构的探针 effect）
- `probe_alpha = 1`，加载时 normal、运行中写 `additive`：预测 (255, 0, 0)（没有 `ADDITIVE`，绿通道不加），像素着色器不变；对照加载时 additive 为 (255, 255, 0)。

**M4 字符串规则（只看日志）**
- 在 `init` 里对五个字段依次写、立即读回并打印：`'translucent'`、`'Translucent'`、`' additive'`、`'yes'`、`2`、`true`、`{}`、`null`、`undefined`；`depthtest` / `depthwrite` 加 `'enabled'`、`'ENABLED'`，`cullmode` 加 `'back'`，`alphawriting` 加 `'enabled'`、`'disabled'`。
- 预测：合法串原样；大小写不符、带空白、数字、布尔、对象 → `blending` normal、`alphawriting` default、`depthtest` / `depthwrite` **disabled**、`cullmode` normal；`null` / `undefined` 保持上一个值；`typeof` 都是 `string`。

**M5 上屏 pass 借基础材质**
- 图层 `scale.x = -1`（镜像），一个单 pass effect（上屏 pass），其材质 `cullmode: normal`、`blending: normal`。脚本 `i == 60` 时对 `getMaterial(0)` 写 `blending = 'additive'`、`cullmode = 'nocull'`、`depthtest = 'disabled'`。
- 预测：切换前镜像图层被剔掉（看不见），切换后**看得见**（剔除用 effect 自己的）；上屏 draw 的 OM 仍是基础材质的混合（BlendEnable FALSE），深度模板状态仍是基础材质的；读回 `blending` 是 `'additive'`。

**M6 深度 / 剔除状态对象是预建的**
- 在 M1 / M5 的抓帧里，对比切换前后那次 draw 的深度模板、光栅状态的 ResourceId：预测只在帧里已有的几个对象之间切换（同一帧别的 draw 用的同一个 ID），不会出现新对象；混合状态对象第一次用到新键时出现一个新 ID，之后的帧复用。

**M7 `alphawriting` 运行中**
- 共用结构，探针 `blending: normal`、`probe_alpha = 0.25`，脚本在 `i == 60` / `i == 90` 时对探针材质写 `'disabled'` / `'enabled'`。预测那次 draw 的写掩码 0xF → 7 → 0xF；读探针目标（RT a）的 alpha：`disabled` 期间保持基础 pass 本帧写的 1（255），其余时候 0.25（64）。

## 未查清

- 图像层基础材质有没有能被脚本拿到的入口（常量上挂字段脚本的 `thisObject` 之外）；如果没有，第 6 节「上屏借基础材质」对脚本写入就只是 M5 那种「写了不生效」。
- 正常运行中有没有重建 effect 材质的路径（`FUN_1401e7170` 的调用者没逐个查）。
- 单采样下运行中打开 A2C、着色器不锐化时的覆盖规则，按 P13d 的实测（alpha ≥ 0.5 + 2⁻¹² 硬阈值）推断，M1 会顺带验证。

## 文件与地址索引

切片（`ignore/p6/rea/layers/matstate/`）：
- `reg_tail_140157c5c.asm`：登记尾部、五张表的懒初始化、五组 setter / getter。
- `json_1401587d0.asm`：五组 JSON 读 / 写。
- `reg_14015a000.asm`：节点分配与清零。
- `bind_tail_140157150.asm`、`unbind_140157430.asm`：绑定末段、解绑。
- `borrow_140209160.asm`：上屏 pass 借基础材质字节。
- `enum2str_1401531c0.asm`：`blending` 枚举 → 名字。
- `dev_140098ea0.asm`：设备构造与 `FUN_140099050` 预建状态对象。
- `matcache_14014ff00.asm`：`FUN_14014ff70`（按名共享）与 `FUN_140150770`（逐实例新建）。
- `derived_14020ab20.asm`：puppet 裁切遮罩材质的组合键。
- 另引：`ignore/p6/rea/layers/xform/matreg_1401577c0.asm`（登记前半）、`ignore/p8/rea/render/asm/blendstate_140099f60.asm`、`devstate_14009af50.asm`、`ignore/p5/rea/mesh/bindmat_140155fc0.c`、`ignore/p5/rea/modelflags/f_1401ebf60.c`、`ignore/p11/rea/tex/dc/f_140154480.c`、`ignore/p6/rea/layers/exe/dec-script/functions/0x1401730d0.c`。

| 地址 | 作用 |
|---|---|
| `FUN_1401577e0`（`0x1401577ee`–`0x140157c6e`） | 静态表登记五个描述符 |
| `0x140157c84` / `0x140157d42` / `0x140157e70` / `0x140157f66` / `0x140158024` | 五张字符串表的懒初始化（cullmode / blending / alphawriting / depthtest / depthwrite） |
| `FUN_14015a000` | 按名插入节点，节点清零（回调槽 `+0x58` 为 0） |
| `0x1401580f0` 等（见 1 节表） | 原生 setter：查表、找不到取首项、写字节 |
| `0x1401581d0` 等 | 原生 getter：按值反查名字 |
| `0x1401587d0` 等 | JSON 读：非字符串当空串，不登记绑定 |
| `FUN_1401730d0` | 按 JSON 键调描述符的 JSON 读 |
| `FUN_140154480`（`0x140154bc1`、`0x140154c5a`、`0x140154dd9`） | 加载期组合键 `ALPHATOCOVERAGE` / `ADDITIVE`、取程序 |
| `FUN_1401515b0`（`0x140151970`、`0x1401519c2`、`0x140151a83`） | 材质创建，`FUN_140154480` / `FUN_1401a5c40` 的全部调用者 |
| `FUN_140155fc0`（`0x140157157`–`0x14015726a`；阴影变体 `0x1401564a4`） | 绑定：现读五个字节设设备状态 |
| `FUN_140157430` | 解绑：按五个字节恢复 |
| `FUN_140099f60` | 绘制前选深度模板 / 光栅 / 混合状态对象（混合懒建缓存） |
| `FUN_140099050` | 设备初始化：预建深度模板 4 槽、光栅 8 槽 |
| `FUN_1401ebf60`（第 171–181、327–342 行） | 上屏 pass：借基础材质字节、画完恢复 |
| `FUN_140209160`（图像层虚表 `0x1404911a8` `+0x108`） | 把基础材质的 `blending` / `depthtest` / `depthwrite` 写进 effect 材质 |
| `FUN_1402091d0`（同表 `+0x120`） | 读基础材质 `blending`（passthrough 上屏） |
| `FUN_140150770` / `FUN_14014ff70` | effect / 图层材质逐实例新建 / 按名共享 |
