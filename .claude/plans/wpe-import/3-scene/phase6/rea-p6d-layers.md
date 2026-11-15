> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。P6d 步骤 0c 实测核对后以报告为准。范围是 exe 侧：宿主接口里建层、删层、排序、取层、初始配置的实现，场景对象表与帧内生效点，层级（父子、世界矩阵）与 effect / 材质的脚本方法。`scenescript64.dll` 侧（JS 参数怎么转成 JSON、资产句柄、`__workshopId`、`solidlayer` 缺省、对象包装与 `isObjectValid`）见并行的 `rea-p6d-script.md`，重叠处以那份为准；本文标「dll 侧」的只是顺带看到。

# WPE 2.8.42 场景脚本的动态图层、排序、层级与 effect 访问（exe 侧静态逆向）

**概括**
1. **建层：** 宿主接口 `+0x30`（`FUN_14018ba00`）只收 **JSON 文本**：先查对象数（场景对象表已有 2048 个就返回空），用 jsoncpp 解析，成功就交给**加载场景用的同一个对象工厂** `FUN_14018ff60`，返回新对象指针（解析失败返回空）。字符串路径、资产句柄、配置对象三种形态都由 dll 先变成 JSON 文本（dll 侧；`createLayer` 的 dll 回调只调了虚表 `+0x30` 和 `+0x90` 两个槽，若后者也是宿主接口，它是「场景是不是正交」，dll 拿它在 `solidlayer.json` 与 `solidlayer_depthtest.json` 之间选【推】）。工厂按键定类型：`model` → 模型，`particle` → 粒子，`image` → 图像层，`sprite`，`text`，`light`，`sound`，`camera`，`shape`，都没有 → 空的基础对象（分组节点）。**工厂不认路径前缀、不补缺省模型**，没有类型键就是分组节点。模型文件读不到时：`FUN_1400d3f80` 返回空串、解析失败，图层照样建出来、返回非空，只是没有模型（不画，【推】）。exe 里没有任何 `models/workshop/` 路径改写（【确，有界】：exe 的 ASCII / UTF-16 串）。【确】
2. **身份与位置：** 新对象 `push_back` 到场景对象表 `G+0x158` 的**末尾**（画在最上面、下标最大）。id 不是「最大 id + 1」：配置里有非 0 的数字 `id` 就**照用（不查重）**，否则取一个渲染器级计数器（`ctx+0x1c88`，effect、动画层等也用它）`+1` 起第一个没被用过的整数。`name` 缺省为空串。父对象只看配置里的 `parent`（按 id 当场查，查不到就没有父）。`getLayerCount` / `enumerateLayers` / `getLayerIndex` / `getLayer(下标)` 看的都是 `G+0x158`：**全部对象**（图像、文本、粒子、sprite、模型、灯、声音、相机、形状、分组节点，含子对象），场景加载时的顺序就是 `objects` 数组的顺序。差别：`getLayerCount` / `enumerateLayers` 剔掉待删对象，`getLayerIndex` 与 `getLayer(下标)` 用原始下标（后者对待删对象返回空）。【确】
3. **资源与当帧：** 建层是同步的：模型 JSON（`FUN_1401fd330`）、纹理（`FUN_14014d500` 当场读 `materials/<名>.tex`）都在调用里读完，粒子在加载函数里预热。**绘制列表就是 `G+0x158` 本身**，渲染（帧内第 8 步）时现读，没有每帧重建的另一张表，也没有「首帧未就绪」的门。所以在 `init`、`update`、计时器、光标回调里建的图层**当帧就画**。【确：绘制遍历；「没有就绪门」是【确，有界】：`FUN_14018aac0`、`FUN_140206430`、`FUN_1401e8aa0` 只看可见性与视锥】但它这一帧**没有跑过自己的每帧更新**（`+0x48` 在第 2 步，早于脚本），关键帧动画也要到下一帧的第 7 步才求值（在 `update` 里建的）；命中测试下一帧才看得到它。【推，按帧内顺序】
4. **新对象上的脚本与属性：** 配置里的 `script` / `user` / `animation` 字段在加载函数里照常登记（`FUN_1401730d0` → `FUN_1401a4db0` → `FUN_140175880`，同场景加载）。脚本模块在登记时当场编译求值；工厂末尾 `FUN_140172830(SM, 新对象)` 把这些条目绑到新对象并**当场调 `init`**（运行期加载计数 `ctx+0x183c` 为 0），也就是 **`createLayer` 返回之前，新图层脚本的 `init` 已经跑完**。在 `update` 里建的图层，它的脚本条目追加在脚本链表尾部，**同一轮 `update` 派发会走到它**，所以当帧就收到第一次 `update`。`{user}` 绑定会登记，但建层时有没有立刻套用当前的属性值没查清。【确；用户属性取值未查清】
5. **`destroyLayer`：** 宿主 `+0x28`（`FUN_14018b730`）只做标记：对象在 `G+0x158` 里就塞进待删集合 `G+0x210`、返回真（已标记过的也返回真），不在就返回假。**任何对象都能删**（`scene.json` 里的、灯、相机、声音、`thisLayer` 自己），没有类型或来源的检查。真正删除在帧函数里**所有脚本（含 `update`、计时器）之后、渲染之前**（`FUN_14018b390` → `FUN_1401909c0`），所以被删的图层**这一帧就不画了**，但它的脚本这一帧排在后面的仍会收到 `update`。删除时：从全部场景表与悬停 / 按下集合里摘掉，析构；析构里**子对象不删，只是取消父子关系，而且不保持世界变换**；挂在它上面的脚本先收 `destroy` 回调再卸载模块；通知 dll 引擎（`E` 虚函数 `+0x68`）。id 不回收。【确】
6. **`sortLayer(layer, index)`：** 宿主 `+0x38`（`FUN_14018bbd0`）：在 `G+0x158` 里先删掉它，再在**删除后的表**里把它插到下标 `index`，所以 `index` 就是它的**最终下标**；`index` 按无符号 32 位与表长比较，越界（含负数）钳到末尾。然后让反射表、半透明排序表、相机表按新顺序重排（灯表不动）。和 `getLayerIndex` 是同一张表、同一套下标。音频条的 `sortLayer(bar, getLayerIndex(thisLayer))` 把 bar 放在 `thisLayer` 的**正前面**（画在它下面），63 根按建的先后排在 `thisLayer` 之下。父子关系、子对象表都不跟着变。【确】
7. **`getInitialLayerConfig`：** 每个对象构造时把交给工厂的 JSON **原样拷一份**存在 `O+0x1b0`；宿主 `+0x48`（`FUN_14018c5c0`）拷出这份、删掉 `id` 键、序列化成文本交给 dll。所以返回的是**加载时的配置原文**（带 `script`、`user`、`animation`、`effects`、`parent` 等，不带 `id`，不反映运行中的改动）；对新建的图层返回的是建它时 dll 送来的那份 JSON（同样去掉 `id`）。【确；删键函数是 jsoncpp 的 `removeMember` 为【推】】
8. **层级：** `getLayerByID` = `G+0x158` 里第一个 `O+8 == id` 的对象（待删返回空）。`getParent` 直接返回 `O+0x180`；`getChildren` 返回子对象表 `O+0x198` 的拷贝，顺序是挂上去时按场景表顺序定的位置，之后 `sortLayer` 不改它。`setParent(parent, [attachment], [adjust])`：`adjust` 为真时反算本地变换让世界变换保持，否则只换父、本地字段不动（画面会跳）；标脏后下次取矩阵重算；组深度超过上限时**取消父子关系**并报「Invalid parent configuration.」。`getTransformMatrix` 返回对象虚函数 `+0x80` 的**世界矩阵**：含父链（与挂点）、图像层的 `alignment` 偏移、文本层的文字框中心偏移；不含视差、不含文本 `anchor`（虚函数 `+0xa8`）。【确】
9. **effect 访问：** `getEffect(下标)` 取图层 effect 表 `O+0x308` 的第几个（越界返回空）；`getEffect(名字)` 按 effect 的 **`name` 字段**（场景 JSON effect 条目的 `name`，`effect+0x120`）**区分大小写**比较，**多个同名时取最后一个**，空串返回空。`getEffectCount` = effect 表长。`getMaterialCount` = 这个 effect 的 pass 数；`getMaterial(下标)` = 第几个 pass 的材质；`getMaterial(名字)` 按材质的一个字符串（`material+0x200`，【推】材质文件名）**不区分大小写**比较，最后一个匹配的胜出，空串匹配全部（即最后一个 pass）。`setMaterialProperty(名字, 值)` 对**全部 pass 的材质**各自按名字找属性描述符、用描述符的 setter 写（和材质常量的 JSON / 脚本写入同一套描述符），类型必须对上（向量维数不同不写，数字对 int 截断、带角度标志的乘 π/180），找不到静默跳过。`executeMaterialFunction` 只记下：按名字找 effect 的 `functions` 条目，对其中列出的 fbo 立即设渲染目标、视口并清屏。【确；材质字符串的含义【推】】
10. **时机：** 建、排、删在调用当下改 `G+0x158`（删是标记）；渲染（第 8 步）现读这张表，所以建与排当帧生效、删在当帧渲染前生效。命中测试（P6c，第 6 步）正交场景直接遍历 `G+0x158`（下标从开头算好、每次重读表头，新加的这一帧遍历不到），透视场景每次现拷一份再排序，所以下一帧就跟上建、删、排。待删标记不挡命中：标记之后同一帧剩下的命中派发与 `update` 仍会发给它。【确】

**元数据**
- 目标：`wallpaper64.exe` 2.8.42，副本 `ignore/p6/rea/layers/exe/wallpaper64.exe`（拷自 `ignore/p9/rea/wallpaper64.exe`），开工时核对 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，一致。没运行、没附加 WPE，没写 Steam / WPE 目录；只读了 WPE 的 `assets/models/util/solidlayer*.json` 与 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`。
- 方法：**REA 用上了。** REA 6.9.0 / Ghidra 12.1.4。按约定把 `ignore/p12/rea/mdl/wallpaper64-2.8.42-p12-mdl.rea-snapshot` 拷成 `wp-layers-work.rea-snapshot` 再带它打开，被拒（`evidence_integrity_mismatch`：分析配置摘要快照 `bb0af088…`、当前 `b119a543…`，和 P6c 那次一样），改为不带快照打开；打开后第一个反编译请求即返回（没有超时，会话没被别人切走）。用 `decompile_all` 按地址区间导出伪代码，`procedure_pseudo_code`、`procedure_callers` 补单个函数；拿不准的地方（`sortLayer` 的下标钳制、命中循环的表头读取、几个小槽函数）用 `ignore/p4/rea/wp.asm` 切片核对。结束时另存 `ignore/p6/rea/layers/exe/wallpaper64-2.8.42-p6d.rea-snapshot`（364 KB，38 条 Evidence）并 `close_binary`。注意：Ghidra checkpoint 模式在本机关闭，快照不含 Ghidra 程序库。
- dll 侧槽号：只读看了并行代理 `ignore/p6/rea/layers/script/cb_*.asm` 里各回调调用的宿主虚表偏移，用来核对第 1 节的槽表（`createLayer` → `+0x30` 与 `+0x90`、`destroyLayer` → `+0x28`、`sortLayer` → `+0x38`、`getLayerIndex` → `+0x40`、`getInitialLayerConfig` → `+0x48`、`getLayerByID` → `+0x10`、`getLayerCount` / `enumerateLayers` → `+0x20`、`registerAsset` 不调宿主），别的没读。
- 工作文件 `ignore/p6/rea/layers/exe/`：
  - 反编译（REA `decompile_all`，`<目录>/functions/<地址>.c`）：`dec-iface`（宿主接口 `0x14018b540`–`0x14018f900`）、`dec-scene`（场景构造、工厂、命中、绘制、删除，`0x140186c00`–`0x140191000`）、`dec-frame`（帧函数与渲染入口 `0x14017e000`–`0x140186c00`）、`dec-base`（基类构造 / 加载 / 析构 / 父子 / 描述符与方法表登记 `0x1401dd400`–`0x1401e2400`）、`dec-find`（场景子接口 `0x140196600`–`0x140198a00`）、`dec-script`（脚本管理器 `0x140171000`–`0x140179000`）、`dec-eff`（effect 方法与描述符 `0x1401ed000`–`0x1401f1a00`）、`dec-img`（图像层绘制）。
  - 汇编切片：`factory_14018ff60.asm`、`iface_layers_14018b540.asm`（宿主 `+0x08`–`+0x48`）、`destroy_obj_1401909c0.asm`、`pending_destroy_14018b390.asm`、`draw_list_14018aac0.asm`、`sub_find_1401966d0.asm`。
  - 脚本：沿用 P6c 的 `xr.py` / `slice.py` / `fn.py` / `grepfn.py` / `strs.py` / `wstrs.py` / `rd.py` / `vtdump.py` / `leastr.py` / `wsat.py`；新增 `before.py`（列某些地址前 N 条指令）；正则文件 `pat_*.txt`。
- 标记：【确】伪代码 / 汇编直接看到；【推】由代码推出；【确，有界】在注明范围内搜过。

**命名**（沿用 rea-p6c-dispatch）
- `R` 渲染器、`G = *R` 场景、`ctx = R+0x10 = *(G+0xd8)`、`H = G+0x48` 宿主接口（虚表 `0x14048ea50`）。`H` 里的偏移 = `G` 偏移 − `0x48`（例如 `H+0x110` 就是 `G+0x158`）。
- `D = G+0x50`：场景子接口（虚表 `0x14048ea08`，`ctx+0x1510` 指向它），按名字 / id / 下标找对象。
- `SM = ctx+0x1708`（= `R+0x1718`）：脚本管理器。`SM+0xd8` 脚本条目链表（`std::list`），`SM+0x68` 关键帧动画绑定表，`SM+0x98` 用户属性绑定表，`SM+0x134`（= `ctx+0x183c`）场景加载计数，`SM+0x138` 「有待 `init` 的条目」。
- 场景对象表（`G` 偏移）：
  - `G+0x158` **对象表**（`std::vector`，全部对象，绘制顺序）；
  - `G+0x170` + 集合 `G+0x188`：带 `O+0x120` bit8 的对象（工厂给粒子、灯置这一位），`(G+0xe0 & 0x1008) == 0x1000` 时从主循环拿出来、排序后放到最后画（【推】排序半透明组）；
  - `G+0x1c8` 反射表（平面反射 pass 画的对象）、`G+0x1e0` 灯、`G+0x1f8` 相机；
  - `G+0x210` **待删集合**（`unordered_set`，元素数 `G+0x220`）；
  - `G+0x250` 透视透明排序的每帧拷贝、`G+0x268` 透视命中的每帧拷贝、`G+0x280` 悬停集合、`G+0x2c0` 按下集合（P6c）。
- 对象字段：`O+8` **id**（int64）、`O+0x10` = `ctx+0x1c88`（id 分配器）、`O+0xc8` = `ctx`、`O+0xd0` 世界矩阵的有效标记、`O+0xe0` 世界矩阵缓存、`O+0x120` 标志（bit0 `visible`、bit1 由组画、bit2 是组合层组、bit8 见上、bit13 `solid`、bit14 `disablepropagation`）、`O+0x128` `origin`、`O+0x134` `scale`、`O+0x140` `angles`、`O+0x180` 父、`O+0x188` 父 id、`O+0x190` 挂点下标、`O+0x198..+0x1a8` 子对象表、**`O+0x1b0` 初始 JSON**（`Json::Value`）、`O+0x1d8` `name`（`std::string`）、`O+0x1f8` 依赖集合、图像层 `O+0x308..+0x310` effect 表。
- effect：`+0xd0..+0xd8` pass 表（步长 0x30，`+8` 是材质）、`+0x100..+0x108` `functions` 表（步长 0x40）、`+0x118` `visible`、**`+0x120` `name`**。

---

## 1. 宿主接口里的图层相关槽（`H` 虚表 `0x14048ea50`）【确，dll 调用方取自 cb_*.asm】

| 槽 | exe 函数 | 作用 | dll 调用方 |
|---|---|---|---|
| `+0x08` | `0x14018b540` → `D` 虚表 `[0]` `FUN_1401966d0` | 按名字找：`G+0x158` 里第一个 `name` 全等的；它在待删集合里就返回空（**不再往后找**） | `getLayer(字符串)`【推】 |
| `+0x10` | → `D` 虚表 `[1]` `FUN_140196840` | 按 id 找：第一个 `O+8 == id` 的；待删返回空 | `getLayerByID` |
| `+0x18` | → `D` 虚表 `[2]` `FUN_140196980` | 按下标取 `G+0x158[i]`（u32，越界返回空）；待删返回空 | `getLayer(数字)`【推】 |
| `+0x20` | `FUN_14018b570` | 无输出数组时返回 `表长 − 待删数`；有时按顺序拷出非待删对象 | `getLayerCount`、`enumerateLayers` |
| `+0x28` | `FUN_14018b730` | 标记删除（第 5 节） | `destroyLayer` |
| `+0x30` | `FUN_14018ba00` | 解析 JSON 文本 → 工厂（第 2 节） | `createLayer` |
| `+0x38` | `FUN_14018bbd0` | 移动下标（第 6 节） | `sortLayer` |
| `+0x40` | `0x14018c580` | 在 `G+0x158` 里线性找，返回下标，找不到 −1（**不看待删**） | `getLayerIndex` |
| `+0x48` | `FUN_14018c5c0` | 初始 JSON 去掉 `id` 后序列化（第 7 节） | `getInitialLayerConfig` |
| `+0x50` / `+0x60` | `FUN_14018c720` / `FUN_14018d8b0` | 建 `MDLV0011` 模型数据 / 引用计数减到 0 时释放（`ctx+0x1c00`） | `createModelData` / `destroyModelData`【推】 |
| `+0x90` | `0x1401853a0` | `G+0xe0` bit3（正交） | `createLayer` 选 `solidlayer` 版本【推：dll 回调调了某虚表的 `+0x90`，没核对对象就是 `H`】 |

另：`D` 虚表 `[3]` `FUN_140196ac0(类型, 值)` 是通用的「图层参数解析」：`0x200` 字符串 → 先按名字、找不到再 `strtol(…, 10)` 当 id；`8` 整数 → 下标；`0x800` 对象 → 必须在 `G+0x158` 里；结果是待删对象时返回空。`setParent` 用它解析父对象（第 9 节）；dll 的 `String|Number|ILayer` 参数是否也走它归 dll 侧。

`H` 其余槽顺带分类：`+0x58` 跳到 `ctx+0x1a60` 的 `FUN_1401d6400`（模型数据相关【推】）、`+0x78` `getAnimation`（rea-p10）、`+0x80` / `+0x88` `ctx+0x74` / `ctx+0x84`、`+0x98` `userProperties`、`+0xa0` 按参数返回 `ctx+0x2c0/0x2c8/0x2d0`、`+0xa8` / `+0xb0` / `+0xc0` 光标（P6c）、`+0xb8` 三个 float 取值、`+0xc8`–`+0xe8` 一组带键名的存储读写（大小上限 100000，【推】`localStorage`）、`+0xf0` `openUserShortcut`、`+0xf8` 场景析构、`+0x138` 透视射线。**没有 `registerAsset` 相关的槽**（【确，有界】：`+0x08`–`+0x140` 全部看过；dll 的 `registerAsset` 回调也不调宿主）。exe 侧唯一与预加载有关的是场景 `general.precache` 数组：加载时对其中 `materials…` 开头的项预载材质进 `ctx+0x1630` 缓存（场景构造 `0x140187d15` 一带）；d.ts 说 `registerAsset(file, true)` 是「在壁纸加载时预载材质」，【推】编辑器把它写进 `precache`。

## 2. 建层（第 1 题）

### 2.1 宿主 `+0x30`：`FUN_14018ba00(H, const char* json)`【确】
```c
if (G->objects.size_bytes() > 0x3fff) return 0;      // ≥ 2048 个对象（含待删的）就失败
Json::Value v;  std::string s(json);
if (!Json::Reader().parse(s, v)) return 0;            // FUN_140017840
return FUN_14018ff60(G, &v);                          // 与加载场景同一个工厂
```
- 参数是文本，不是 JS 值。所以字符串路径、`registerAsset` 句柄、配置对象、`getInitialLayerConfig` 的结果都是 dll 先拼 / 序列化成 JSON 文本再送来（dll 侧）。
- 工厂的另一个调用者只有场景构造 `FUN_140186c90`（`procedure_callers`）。

### 2.2 工厂 `FUN_14018ff60(G, json)`：按键定类型【确】
按以下顺序判断，命中第一个就建：

| 条件 | 类型 | 大小 / 虚表 | 额外 |
|---|---|---|---|
| `model` 是数字 / 字符串 / 对象 | 模型（类型 5） | 800 / `0x140491338` | `O+0x120 \|= 0x800` |
| `particle` 是字符串 | 粒子 | 0x960 / `0x1404915b0` | `\|= 0x100` |
| `image` 是字符串 | 图像层 | 0x4d0 / `FUN_1401fac50` | |
| `sprite` 是字符串 | sprite | `FUN_140256560` | |
| 有 `text` 键 | 文本层 | `FUN_140256ae0` | |
| `light` 是字符串 | 灯 | 0x3a0 / `0x140491c38` | 进灯表 `G+0x1e0`，`\|= 0x100` |
| `sound` 不为 null | 声音 | 800 / `0x140490ae8` | **清 `visible` 位** |
| `camera` 是字符串 | 相机 | 0x360 / `0x140490980` | 进相机表 `G+0x1f8` |
| `shape` 是字符串 | 形状 | 0x460 / `0x140491d10` | |
| 都没有 | 基础对象（分组节点） | 0x2c0 / `0x14048ec88` | |

之后（同一函数尾部）：
```c
O->vt[0x40](O, json);                       // 加载：字段、模型、材质、effect、脚本登记……
G->objects.push_back(O);                    // G+0x158，末尾
flags = O->vt[0x58]();
if (前五种类型 && json["reflected"] 不是 false && !(flags & 8)) G->reflect.push_back(O);   // G+0x1c8
if (flags & 0x1000) G->flags_e0 |= 0x20000;
FUN_140172830(SM, O);                       // 绑定脚本并当场 init（第 5 节）
if (O->flags120 & 0x100) { G->sorted.push_back(O); G->sortedSet.insert(O); }            // G+0x170 / G+0x188
return O;
```
- **建得出全部类型**：图像、文本、粒子、sprite、模型、灯、声音、相机、形状、分组节点。
- **缺键补什么：** exe 不补。没有类型键的配置（例如只有 `origin`、`name`）建出的是**分组节点**，什么都不画。`models/util/solidlayer.json`（`{"material": "materials/util/solidlayer.json", "solidlayer": true}`）与 `solidlayer_depthtest.json` 只出现在 dll 里（`0x1819a3140` / `0x1819a3168`），由 dll 在缺类型键时补成 `image`、按宿主 `+0x90`（正交）选版本【推，dll 侧为准】。
- `G+0x158` 里的对象只经工厂进入（【确，有界】：通用 `push_back` `FUN_14019e140` 的 14 个调用点只有工厂里那处写 `G+0x158`）。

### 2.3 文件找不到时【确，结果【推】】
- 图像层加载 `FUN_1401fbae0` 先调 `FUN_1401fd330`：取 `O+0x1b0["image"]`，经文件系统 `ctx+0x1898` 读成字符串（`FUN_1400d3f80`：打开失败返回**空串**，不抛、不记日志），再 jsoncpp 解析进模型 JSON。空串解析失败，模型 JSON 为空 → 没有材质，图层建出来但不画【推】。`createLayer` 仍返回非空对象。
- 纹理同理：`FUN_14014d500` 打开 `materials/<名>.tex`，打不开就返回假。

## 3. 新对象的身份与位置（第 2 题）

### 3.1 id：`FUN_1401a38f0(&O->id, json)`【确】
```c
if (json 是对象 && json["id"] 是数字 && asUInt64(json["id"]) != 0) {
    O->id = asUInt64(json["id"]);  alloc->used.insert(O->id);   // 不查重
    return;
}
do { ++alloc->counter; } while (alloc->used.contains(alloc->counter));   // 0xfffffffffffffffe 时清空集合、从 0 再来
O->id = alloc->counter;
```
- 分配器 `alloc = ctx+0x1c88`（`{counter, used 集合}`），在渲染器构造 `0x14017d4db` 清零，【推】场景重载不清。
- 同一个分配器还给场景对象本身（`FUN_140186c90` 开头 `FUN_1401a38f0(G+8, 0)`）、effect（`FUN_1401e7170`）、相机、动画层、粒子子系统等发号（`procedure_callers` 13 处）。所以新图层的 id 是「计数器之后第一个没被占的整数」，**不是最大 id + 1**，可能填进场景 id 的空隙。具体是几，要看加载期发出的自动 id 有多少，静态定不了（见建议实测 T5）。
- 配置里写了 `id` 就照用：克隆时 `getInitialLayerConfig` 已经去掉了 `id`，所以克隆拿新号；手写 `id` 与已有对象相同时两者同号，`getLayerByID` 返回表里靠前的那个。
- 删对象不回收 id（根析构里没有从 `used` 删除，【推，有界】）。

### 3.2 `name`、父、位置【确】
- `name`（`O+0x1d8`）由根描述符表的 `name` 字段从 JSON 读，构造时是空串；配置没写就是空串。
- 父：基类加载 `FUN_1401de470` 读 `parent`（数字）存 `O+0x188`，当场用 `D` 虚表 `[1]`（按 id，待删返回空）找父对象；找到且组深度够就挂上（`FUN_1401dda60`），否则没有父。场景加载完还有一遍「按 `O+0x188` 补挂」与「成环就断」的后处理（`FUN_140186c90` `0x140187fb0` 一带），**`createLayer` 不跑这一遍**，所以新层的父只能是当时已存在的对象。配置没有 `parent` 就是根。
- 插入位置：`G+0x158` 末尾（第 2.2 节）。没有按父对象插到父旁边。

### 3.3 `getLayerCount` / `enumerateLayers` / `getLayerIndex` 看哪张表【确】
- 都是 `G+0x158`：全部对象，含灯、相机、声音、形状、分组节点和子对象，不含场景本身。场景加载时按 `objects` 数组逐个调工厂（非对象元素跳过），所以**加载完时下标 = `objects` 下标**；Kabegame 现在 `getLayerIndex` 返回 `objects` 下标，在建、排、删之前是对的。
- 差别（待删对象）：

| API | 表 | 待删对象 |
|---|---|---|
| `getLayerCount` | `G+0x158` | 不计 |
| `enumerateLayers` | `G+0x158` | 跳过（后面的前移） |
| `getLayer(下标)` | `G+0x158` 原始下标 | 返回空，下标不前移 |
| `getLayer(名字)` | 第一个同名的 | 第一个同名的是待删就返回空 |
| `getLayerByID` | 第一个同 id 的 | 返回空 |
| `getLayerIndex` | `G+0x158` 原始下标 | **照常返回下标** |

## 4. 资源与当帧（第 3 题）

### 4.1 同步加载【确；着色器编译【推】】
- 模型 JSON：`FUN_1401fd330` → `FUN_1400d3f80` 在调用线程读文件。
- 纹理：`FUN_14014d500`（纹理管理器）缓存没命中就当场经 `ctx+0x1898` 打开、整个读进内存、`FUN_14015e580` 解析，存缓存。没看到队列或工作线程。
- 粒子：加载函数 `FUN_14022feb0` 里预热（rea-p4c-sim 1.3 / rea-p4d-rope）。
- 着色器编译走材质加载，同属这条同步调用链【推】。所以运行中 `createLayer` 一个新模型可能卡一帧，但返回时资源已就绪。

### 4.2 帧内顺序与当帧画不画【确】
帧函数 `FUN_14017fa70`（在 rea-p6c 5.1 的表上补全）：

| 顺序 | 动作 | 与本节的关系 |
|---|---|---|
| 2 | `FUN_1401891a0`：对 `G+0x158` 每个对象调 `+0x48`（每帧更新），再从相机表**倒序**取第一个自身与父链可见的相机 | 新层下一帧才第一次 `+0x48` |
| 6 | 光标命中与派发 `FUN_140189e10` | 第 10 节 |
| 7 | `FUN_140171440`：媒体 → 关键帧动画 → `animationEvent` → 计时器 → `update`（`FUN_140177ad0(SM, 0, 0, 1)`） | 常见的建 / 删 / 排点 |
| 7.5 | **`FUN_14018b390`：处理待删集合** | 删在这里生效 |
| 7.6 | `G+0xe0` bit31 时 `FUN_140184020`、`FUN_140190c80` | |
| 8 | 渲染：`FUN_140183550` → `FUN_14018aac0(G, pass)`，遍历 `G+0x158`（反射 pass 用 `G+0x1c8`） | 新层当帧画 |

- `FUN_14018aac0` 对表里每个对象：跳过 `O+0x120 & 2`（由组画）、`vt+0x68()` 不可见的，其余 `vt+0x50()` 画。没有别的「就绪」判断；图像层的 `FUN_140206430` → `FUN_1401e8aa0` 开头只看可见性和视锥。世界矩阵是取用时按 `O+0xd0` 现算的（`FUN_1401850a0`），不依赖每帧更新。所以**在 `update` 里建的层当帧就画**，用的是加载时的状态加上脚本刚写的字段。
- 透视场景开了透明排序时（`(G+0xe0 & 0x3000) == 0x2000`），每帧把 `G+0x158` 拷到 `G+0x250` 再稳定排序；新层同样当帧进排序。
- 新层第一帧**没跑 `+0x48`**：图像层的每帧更新（纹理动画、puppet、视频等）、粒子的模拟步进都从下一帧开始；第一帧画的是加载 / 预热完的状态【推】。
- 关键帧动画：绑定登记在 `SM+0x68`（`FUN_140175880` 第三类），第 7 步里在 `update` **之前**求值。在 `update` 里建的层，动画下一帧才第一次写字段，当帧画的是 JSON 的 `value`；在光标回调（第 6 步）里建的，当帧第 7 步就求值【推，按顺序】。
- 命中测试：第 10 节。

## 5. 新对象上的脚本与属性（第 4 题）

### 5.1 登记【确】
- 基类加载 `FUN_1401de470` 第一句 `FUN_1401730d0(SM, O, json)`：遍历 JSON 的每个键，按 `O->vt[0x20](键)` 找字段描述符，调描述符的 JSON setter。字段值是对象时由 `FUN_1401a4db0` 处理：
  - `user`（字符串或 `{name, condition, …}`）→ 用户属性绑定（`FUN_140175880` 第二类，进 `SM+0x98`）；
  - `animation` → 关键帧动画绑定（第三类，进 `SM+0x68`）；
  - `script`（+ `scriptproperties`）→ 脚本条目（第一类）：`LoadScript`（引擎虚函数 `+0x30`）**当场编译并求值模块顶层**，成功后置 `SM+0x138 = 1`、`push_back` 进 `SM+0xd8`，状态 0；导出光标回调时置 `SM+0x130 = 1`（P6c 的命中门）；导出媒体回调时订阅媒体。
- 这和场景加载完全同一条路，配置里带什么就登记什么。克隆 `getInitialLayerConfig` 的结果会把原图层的字段脚本、属性绑定、动画**再登记一份**，是新的模块实例。

### 5.2 `init` 何时跑：`FUN_140172830(SM, obj)`（工厂尾部调）【确】
```c
for (a : SM->anims /* SM+0x68 */) if (a->owner_set == 0) { a->owner_set = 1; a->owner = obj; }
if (SM->pending /* +0x138 */) {
  SM->pending = 0;
  for (S : SM->scripts /* SM+0xd8 */) {
    if (S->state == 0) { S->obj48 = obj; S->state = 1; }          // 绑到新对象
    if (S->state == 1) {
      if (SM->loading /* +0x134 = ctx+0x183c */ == 0 && !场景销毁中 && (obj == 0 || obj == S->obj48)) {
        按掩码收集：init(bit0)、媒体回调 0x4000 / 0x8000 / 0x10000 / 0x20000 / 0x40000;
        S->state = 2;
      } else SM->pending = 1;
    }
  }
  依次 CallCallback(init)，再以当前媒体状态调 14–18 号媒体回调;
}
```
- `ctx+0x183c` 只在场景构造的对象循环前后 `+1` / `−1`（`0x140187ead` / `0x140187f72`，【确，有界】全部引用）。运行中为 0，所以**新图层脚本的 `init` 在 `createLayer` 返回之前就跑完**；加载期（`objects` 循环里）则推迟到循环结束后的 `FUN_140172830(SM, 0)` 一起跑。
- 新层自己的 `init` 跑时它已在 `G+0x158` 里（工厂先 `push_back` 再调这个函数），`getLayerIndex(thisLayer)` 可用。
- `update`：派发函数 `FUN_140177ad0` 遍历 `std::list` 时每次调用后再读 `next`，新条目追加在尾部（`FUN_140178e20` = `push_back`），所以**在 `update` 里建的图层当帧就收到第一次 `update`**（排在建它的脚本之后）；在 `init` 里建的，第一次 `update` 是第一帧。
- 递归：克隆的配置若带有「会再次克隆自己」的脚本，`init` 里的 `createLayer` 会嵌套进入同一过程；exe 没有防护，只有 2048 个对象的上限。

### 5.3 `{user}` 绑定【确：登记；取值未查清】
- 绑定照常登记，字段先取 JSON 的 `value`。场景加载时用户属性的当前值由之后的 `applyUserProperties` 路径（`FUN_1401731d0`）套用；运行中建层时有没有立刻套用当前值，没查清（未查清 1）。

## 6. `destroyLayer`（第 5 题）

### 6.1 宿主 `+0x28`：`FUN_14018b730(H, O)`【确】
```c
if (O 不在 G->objects) return 0;
G->pendingDestroy.insert(O);      // G+0x210，已有也返回 1
return 1;
```
- 没有类型、来源、是否 `thisLayer` 的检查：`scene.json` 里加载的、新建的、灯、相机、声音、分组节点都能删。d.ts 原文：「The layer is removed after all scripts on that frame updated.」
- dll 怎么把 `String|Number|ILayer` 解析成对象归 dll 侧。若它用 `D` 虚表 `[3]`，对已标记的对象会解析成空，第二次按名字删就返回假【推】。

### 6.2 生效：`FUN_14018b390(G)`（第 7.5 步）→ `FUN_1401909c0(G, O)`【确】
- 先把待删集合拷出来、清空，再逐个删：
  - 从 `G+0x158`、反射表 `G+0x1c8`、排序表 `G+0x170` 与集合 `G+0x188`、灯表 `G+0x1e0`、相机表 `G+0x1f8` 里摘掉；
  - 从悬停集合 `G+0x280`、按下集合 `G+0x2c0`、待删集合里删除（**不发 `cursorLeave` / `cursorUp`**）；
  - `O->vt[0](O, 1)` 析构并释放。
- 所以这一帧**不画**，下一帧的更新、命中都没有它。

### 6.3 根析构 `FUN_1401de1e0`（各类析构最后都调它）【确】
1. **子对象**：拷出子对象表，对每个 `FUN_1401de750(child, 0, 0, −1)`，即取消父子关系、**不保持世界变换**（本地字段原样当世界变换用，画面会跳）。子对象不删，仍在场景表里，成为根；原来由组画的（bit1）随之改由主循环画（`FUN_1401dd9a0`）【推】。
2. 从父对象的子表删掉自己，调父的虚函数 `+0xa0`。
3. `E = *(ctx+0x1830)` 的虚函数 `+0x68(E, O)`：通知 dll 引擎对象没了（dll 侧怎么让包装失效、`isObjectValid` 见 rea-p6d-script）。
4. `FUN_140176f70(SM, O, 0)`：对 `+8`（名字来源对象）等于 `O` 的脚本条目：从链表摘下，导出了 `destroy`（3 号，掩码 bit3）且场景不在销毁中就 `CallCallback(destroy)`，再卸载模块（引擎虚函数 `+0x38`）；同时删掉 `O` 的用户属性绑定与动画绑定。
5. 释放初始 JSON、名字、子表等。
- effect、材质析构也调 `FUN_140176f70`（它的调用者里有 `0x140153f70`、`0x140157660`、`0x1401e6090`、`0x1401e6b40` 等），挂在被删图层的 effect / 材质常量上的脚本随之清理【推】。

### 6.4 删除前后脚本还收不收回调【确】
- 标记那一刻到第 7.5 步之间：它的脚本照收 `update`（派发不看待删集合）、光标派发照发（第 10 节）、`getLayerIndex` / `sortLayer` / `getInitialLayerConfig` 照常认它。
- 第 7.5 步：收 `destroy`，然后卸载；之后不再收任何回调。

## 7. `sortLayer(layer, index)`（第 6 题）

### 7.1 宿主 `+0x38`：`FUN_14018bbd0(H, O, u32 index)`【确：汇编 `0x14018bbe7`–`0x14018bcbc`】
```c
it = find(G->objects, O);  if (!it) return 0;
G->objects.erase(it);
n = G->objects.size();
if (index >= n) index = n;              // u32 比较：负数也钳到 n
G->objects.insert(begin + index, O);    // O 的最终下标 = index
// 按新顺序重排三张派生表：
G->reflect = [x in G->objects if x in 旧 G->reflect];     // G+0x1c8
G->cameras = [x in G->objects if x in 旧 G->cameras];     // G+0x1f8
G->sorted  = [x in G->objects if x in G->sortedSet];      // G+0x170
return 1;
```
- **下标含义**：删除自己之后的表里的插入位置，也就是移动后它自己的下标。例：`[A,B,C,D]`，`sortLayer(D, 1)` → `[A,D,B,C]`；`sortLayer(A, 2)` → `[B,C,A,D]`。
- 与 `getLayerIndex` 同一张表、同一套下标（含灯、相机、声音、分组节点、子对象和待删对象）。
- 音频条：`thisLayer` 在 `k`，新 bar 在末尾。`sortLayer(bar, k)` 后 bar 在 `k`、`thisLayer` 到 `k+1`；下一根 `getLayerIndex(thisLayer)` 是 `k+1`，又插到 `thisLayer` 前面。63 根之后：bar 们在 `k..k+62`（按建的先后），`thisLayer` 在 `k+63`，全部画在 `thisLayer` 之下。
- **不动的东西**：灯表 `G+0x1e0`；父对象的子表 `O+0x198`（`getChildren` 的顺序）；父子关系。子对象可以被排到父对象前面，绘制就按表的顺序。
- 透明排序（透视场景）每帧对 `G+0x158` 的拷贝做稳定排序，`sortLayer` 的顺序只在键相同时起作用。
- 相机表跟着重排，而当前相机取「相机表里倒序第一个可见的」，所以 `sortLayer` 一个相机对象可能换掉当前相机【推】。
- 同一帧里在光标回调中排序：正交命中循环按下标倒序遍历 `G+0x158`，中途重排会让某些对象这一帧被处理两次或漏掉【推】。

## 8. `getInitialLayerConfig`（第 7 题）

### 8.1 存：基类构造 `FUN_1401ddbb0`【确】
- `FUN_140085090(O+0x1b0, json)`：`Json::Value` 拷贝构造，存的是交给工厂的那份 JSON。加载期修改的是原件（例如关键帧的 `relative` 处理会改原件），`O+0x1b0` 不受影响；运行中脚本写字段也不改它。

### 8.2 取：宿主 `+0x48`：`FUN_14018c5c0(H, O, 回调)`【确；删键【推】】
```c
if (O 不在 G->objects) return 0;              // 不看待删
Json::Value v = O->initJson;                   // 拷贝
v.removeMember("id");                          // FUN_1400878f0，键 "id"（0x14048e5bc）
std::string s = Writer(v);                     // FUN_140004d00
回调(s);  return 1;
```
- 返回给 dll 的是 JSON **文本**（dll 再解析成 JS 对象，dll 侧）。内容：加载时的原文去掉 `id`，带 `name`、`parent`、`origin`、`image` / `text` 等类型键、`effects`、以及字段上的 `script` / `user` / `animation` 对象。
- 对 `createLayer` 建的图层：返回建它时 dll 送来的那份 JSON（去掉 `id`）。

## 9. `getLayerByID`、层级、世界矩阵（第 8 题）

### 9.1 `getLayerByID`：`D` 虚表 `[1]` `FUN_140196840`【确】
- `G+0x158` 里第一个 `O+8 == id` 的（int64 比较），待删返回空。dll 怎么把 d.ts 的 `String` 参数转成整数归 dll 侧。

### 9.2 方法表（根描述符方法表 `0x1404e8290`，登记于 `FUN_1401e0530`）【确】
| 方法 | 实现 | 返回类型码 | 参数类型码 |
|---|---|---|---|
| `getTransformMatrix` | `FUN_1401df5e0` | `0x80`（Mat4） | — |
| `rotateObjectSpace` | `FUN_1401df620` | | `0x20` |
| `lookAt` / `lookAtYaw` | `FUN_1401dfc00` / `FUN_1401dfe30` | | `0x20`, `0x20` |
| `setParent` | `FUN_1401e00b0` | | `0xa08`, `0x20a`, `0x2` |
| `getParent` | `0x1401e0180` | `0x800`（对象） | — |
| `getChildren` | `0x1401e0190` | `0x1000`（数组） | — |
| `getAttachmentIndex` / `Matrix` / `Origin` / `Angles` | `FUN_1401e01d0` / `01f0` / `02c0` / `0390` | 8 / 0x80 / 0x20 / 0x20 | `0x200` / `0x208` |

### 9.3 `getParent` / `getChildren`【确】
- `getParent`：直接返回 `O+0x180`（空时 dll 给 `undefined`，d.ts 如此写）。
- `getChildren`：把 `O+0x198..+0x1a0` 交给回调。子表的顺序在挂上时定：`FUN_1401dda60` 用 `D` 虚表 `[4]` `FUN_140196c40` 算位置（从父对象在 `G+0x158` 里的位置往后数、遇到根对象就停；算不出就追加到末尾），所以和场景表顺序基本一致。之后 `sortLayer` 不再改它。

### 9.4 `setParent`：`FUN_1401e00b0` → `FUN_1401de750(O, P, adjust, attach)`【确】
- 父参数用 `D` 虚表 `[3]` 解析（名字 / id 字符串 / 下标 / 对象）；解析不出（`undefined`、找不到、待删）→ 取消父子关系。
- `adjust` = 第二个参数是布尔真，或第三个参数是布尔真。挂点：第二个参数是整数就当下标，是字符串就让父对象虚函数 `+0x70` 按名字查，否则 −1。
- `FUN_1401de750`：
  - 父与挂点都没变 → 返回真；
  - 从旧父的子表删掉自己；
  - 组深度检查：新父链上「组」（bit2）的个数 + 自己子树里组的最大深度 ≥ 4 → **把父设成空**、清标志，返回假，dll 报「Invalid parent configuration.」；
  - `adjust` 为假：只改 `O+0x180` / `O+0x188` / `O+0x190`，本地 `origin` / `angles` / `scale` 不动 → 世界变换随新父变化；
  - `adjust` 为真且没有挂点：`local = inverse(W_新父) · W_旧`，分解回 `origin`、`angles`、`scale`（缩放按列长度修正），世界变换保持；有挂点时走另一支（`origin` 清零、只重算旋转，细节没查，未查清 6）；
  - 加进新父的子表（`FUN_1401dda60`），设 / 清 bit1（由组画），`O+0xd0 = 0` 标脏。

### 9.5 `getTransformMatrix`：`FUN_1401df5e0` = 拷出 `O->vt[0x80]()` 的 64 字节【确】
- 基类 `FUN_1401850a0`：`O+0xd0` 有效就返回缓存；否则 `M = 缩放 · 旋转`（`O+0x14c` 起的 3×3 乘 `O+0x134` 的缩放）、平移 `O+0x128`，有父时 `M = W_父 · M`（挂点 ≥ 0 时先乘父的挂点矩阵，父虚函数 `+0x78`）。即**世界矩阵**，含父链。
- 图像层 `FUN_1401fd3f0`：基类矩阵再加 `alignment` 偏移（rea-p8-layer）。文本层 `FUN_140256e10`：基类 × 文字框中心平移。
- 不含：视差（只在绘制时压栈，`FUN_14018aac0`）、文本 `anchor`（虚函数 `+0xa8`，命中测试另乘）、透视覆盖。
- 布局：16 个 float，平移在 12–14（rea-p6c-script 的矩阵键 `m`，dll 侧原样包成 `Mat4`）。

## 10. effect 访问（第 9 题）

### 10.1 `getEffect` / `getEffectCount`（图像层方法，登记于 `FUN_1401ee520`）【确】
- `getEffect` = `FUN_1401ecfe0`，参数类型码 `0x208`（字符串或整数）：
  - 整数：`0 ≤ i < effect 表长` 时返回 `O+0x308[i]`，否则空；
  - 字符串：空串返回空；否则遍历全部 effect，`effect+0x120 == name`（`FUN_14000d010`：`std::string` 与 C 串全等，**区分大小写**）就记下，**不提前退出**，最后一个同名的胜出。
- `effect+0x120` 是 effect 描述符表（`0x1404e83e0`，`FUN_1401efca0`）里的 `name` 字段（类型 5 字符串，JSON setter `FUN_1401a4bc0`），即场景 JSON effect 条目的 `name`；脚本也能读写 `effect.name`。effect 表的另一个字段是 `visible`（`+0x118`，改值回调 `FUN_1401e6300`，P3c / rea-p7d）。
- `getEffectCount` = `0x1401ed0b0`：`(O+0x310 − O+0x308) / 8`，全部 effect（含不可见的）。

### 10.2 `IEffect` 的方法（`FUN_1401efca0`）【确】
- `getMaterialCount` = `0x1401ee1a0`：pass 数 `(effect+0xd8 − effect+0xd0) / 0x30`。
- `getMaterial` = `FUN_1401ee0c0`：
  - 整数：第 i 个 pass 的材质（`pass+8`），越界返回空；
  - 字符串：遍历 pass，材质 `+0x200` 处的字符串与参数 `_stricmp`（`FUN_1402c10d0`，**不区分大小写**）相等**或参数是空串**就记下，最后一个胜出。`+0x200` 是材质文件路径【推】。
- `setMaterialProperty` = `FUN_1401ee1d0`，参数 `0x200`（名字）、`0x7c`（数、Vec2、Vec3、Vec4）：
  ```c
  for (pass : effect->passes) {
    d = pass.material->vt[0x20](name);          // 材质的属性描述符，找不到就跳过
    if (!d) continue;
    switch (值类型) {
      case 浮点(4): v = x; if (d->flags & 4) v *= π/180;  d 是 int 就截断、是 float 就写, 其它类型跳过;
      case 整数(8): d 是 int 就写; d 是 float 就转 float（带角度标志再乘 π/180）;
      case Vec2/3/4: d 的类型必须正好是 vec2/vec3/vec4，否则跳过;
    }
    d->setter(pass.material, d, &v);            // 描述符 +0x18
  }
  ```
  对**全部 pass**生效；写入走材质属性描述符的 setter，和 JSON 的 `constantshadervalues`、字段脚本写材质常量是同一套描述符【推：同一个 `vt+0x20` 查找】，所以名字是材质常量的「材质名」（`constantshadervalues` 的键），不是 `g_` uniform 名【推】。
- `executeMaterialFunction` = `FUN_1401ee3a0`：在 `effect+0x100` 的 `functions` 表里按名字（全等）找条目，对条目里列出的每个 fbo 下标：设渲染目标（`effect+0xe8` 表，步长 0x50）与视口、清屏（渲染器虚函数 `+0x120(1, 0)`）。语料 0 处，只记下。

## 11. 时机（第 10 题）【确】

| 调用位置 | `createLayer` | `sortLayer` | `destroyLayer` |
|---|---|---|---|
| 场景加载末的 `init`（第一帧之前） | 第一帧就画；脚本 `init` 当场跑 | 第一帧按新顺序画 | 第一帧第 7.5 步删，第一帧不画 |
| 第 6 步光标回调 | 本帧画；本帧命中循环遍历不到（正交下标已定、透视用拷贝） | 本帧画按新序；本帧命中循环可能重复 / 漏掉 | 本帧剩下的命中派发与 `update` 照发，7.5 删 |
| 第 7 步 `update` / 计时器 / 动画事件 | 本帧画；新脚本本帧收 `init` 和 `update`；它的动画、`+0x48`、命中都从下一帧开始 | 本帧画按新序 | 本帧排在后面的脚本仍收 `update`，7.5 删，本帧不画 |

- P6c 的命中对象表：正交直接用 `G+0x158`，透视每帧现拷进 `G+0x268` 再按视线深度排序（`FUN_1401865c0`），都随建、删、排自动更新，不需要另外重建。
- 场景标志 `G+0xe0` 里由对象决定的几位（bit0、bit11 由 `FUN_14018b230` 在加载末统计）**不随 `createLayer` 重算**，只有 bit17 在工厂里补；bit0 决定是否画平面反射 pass（`FUN_14017fa70` `(*(G+0xe0) & 1)`）。运行中新建「读反射的对象」到原本没有的场景里时，反射 pass 不会打开【推】。同样，加载末的「被依赖图层」标记（`O+0x200` 依赖集合 → 目标图层 `+0x304 |= 0x1010` 并重建合成 RT，rea-p8）也不对新建的层做。

## 顺带：补 P6c 的未查清
- **P6c 未查清 6**（销毁图层后悬停 / 按下集合里的悬空指针）：`FUN_1401909c0` 删除对象时 `FUN_14019e2a0` 从悬停集合 `G+0x280`、按下集合 `G+0x2c0` 里删掉它，不发 `cursorLeave` / `cursorUp`。【确】
- **P6c 未查清 7**（`sortLayer` 是否改 `G+0x158`）：改，正交场景的命中顺序随之改变。【确】

---

## 未查清
1. **新建图层上 `{user}` 绑定的初值**：登记时字段先取 JSON 的 `value`；运行中建层时会不会立刻套用当前的用户属性值，还是要等下一次 `applyUserProperties`，没追到。
2. **着色器 / D3D 纹理创建是否全同步**：纹理文件读取与解析（`FUN_14014d500` → `FUN_14015e580`）是同步的，D3D 资源创建与着色器编译没逐个追。
3. **第一帧没跑 `+0x48` 的影响**：图像层每帧更新（纹理动画、puppet、视频）、文本、粒子在第一帧画出来的状态是否与之后有可见差别。
4. `O+0x120` bit8 除粒子、灯以外还有谁置位，`G+0xe0` 的 `0x1000` 是什么开关（`G+0x170` 排序组的含义）。
5. 加载末统计的 `G+0xe0` bit0 / bit11 与依赖标记不对新建层生效（第 11 节）的实际后果。
6. `setParent` 带挂点且 `adjust` 为真的那一支的精确语义。
7. id 计数器在加载完时的值（取决于场景对象、effect、动画层里没写 `id` 的个数）；场景重载时计数器与 `used` 集合是否清空（只看到渲染器构造时清零）。
8. 图像层加载里 `FUN_14027a260` / `FUN_14017d9b0`（往 `R+0x3060` 表登记路径）的用途，看着与编辑器热重载或缺文件提示有关，不影响上面的结论。
9. dll 侧的全部：字符串 / 句柄 / 对象 → JSON 的拼法、`__workshopId`、`solidlayer` 何时补、`registerAsset` 句柄、`String|Number|ILayer` 的解析、`isObjectValid`、`createLayer` 能否在模块顶层调。见 `rea-p6d-script.md`。
10. 宿主 `+0x58`、`+0xa0`、`+0xb8`、`+0xc8`–`+0xe8` 的确切 JS 对应（与 P6d 无关，只做了粗分类）。

## 建议的实测（给 0c 的确定性工程）
通用做法：工程用 `kbp gen` 生成，带 FR 帧号图层；脚本用 `console.error('[kbp] ' + 帧号 + ' ' + …)` 写进 WPE `log.txt`（`log_mark` / `log_since` 截取）；绘制顺序与当帧画不画用 wpe-renderdoc `capture_wallpaper` 连抓 3–5 帧，按 `get_draw_calls` 数绘制、按颜色认图层。图层用纯色 `solidlayer`（`image: models/util/solidlayer.json` 加 `color`）便于在抓帧里辨认。

- **T1 下标与顺序**：正交场景，`objects` 依次为 A（红，id 10）、灯 L、B（绿，20）、声音 S、C（蓝，30）、分组 G、D（白，40），A–D 互相部分重叠。A 的 `origin` 脚本 `init` 里：
  ```js
  const names = () => thisScene.enumerateLayers().map(l => l.name).join(',');
  log('enum', names(), 'count', thisScene.getLayerCount());
  for (const n of ['A','L','B','S','C','G','D']) log('idx', n, thisScene.getLayerIndex(thisScene.getLayer(n)));
  const x = thisScene.createLayer({ image: 'models/util/solidlayer.json', name: 'X', color: '1 1 0', origin: …, size: … });
  log('new', x.name, thisScene.getLayerIndex(x), thisScene.getLayerCount());
  log('sort', thisScene.sortLayer(x, thisScene.getLayerIndex(thisScene.getLayer('C'))), names());
  thisScene.sortLayer(x, -1); log('sort-1', names());
  thisScene.sortLayer(x, 999); log('sort999', names());
  thisScene.sortLayer(x, 0); log('sort0', names());
  ```
  预期：灯、声音、分组都占下标；`sortLayer(x, i)` 后 `getLayerIndex(x) == i`，X 在 C 前面且画在 C 下面；−1 与 999 都到末尾。抓帧核对 X 的绘制位置。
- **T2 当帧画**：A 的 `update` 在帧号 N（如 30）建一个黄色层 Y 并记日志；抓 N−1、N、N+1 三帧。预期第 N 帧已有 Y 的绘制。再在 Y 的配置里带一个 `alpha` 关键帧动画（第 0 帧 0.2），预期第 N 帧 Y 的 alpha 是 JSON 的 `value`，第 N+1 帧才是动画值。
- **T3 删除时机与回调**：B 上挂脚本，导出 `update`（记日志）与 `destroy`（记日志）。A（排在 B 之前登记）的 `update` 在帧号 N `destroyLayer(B)`，紧接着记 `getLayerCount()`、`enumerateLayers`、`getLayerIndex(B)`、`getLayer('B')`、`getLayerByID(20)`、再调一次 `destroyLayer(B)` 的返回值、`thisScene.getInitialLayerConfig(B)`。预期：计数立刻少 1、枚举里没有 B、`getLayerIndex` 仍返回原下标、`getLayer` / `getLayerByID` 为空；B 的 `update` 在第 N 帧仍出现一次，随后是 `destroy`；第 N 帧抓帧里没有 B。再删一个**父对象**（给 C 设父 B、B 有旋转平移），预期 C 不删、画面跳到 C 的本地变换处。删 `thisLayer` 自己、删灯、删 `scene.json` 里的声音各试一次，看返回值。
- **T4 新层脚本的 `init` / `update`**：模板层 T（不可见）的 `origin` 字段挂脚本，`init` 记 `'init T', thisLayer.name`，`update` 记 `'upd T'`。A 在帧号 N 的 `update` 里：`log('before'); const c = thisScene.createLayer(thisScene.getInitialLayerConfig(T)); c.name = 'T2'; log('after', c.name);`。预期日志顺序 `before` → `init T`（名字还是空或 T 的名字）→ `after`，同一帧还有一条新实例的 `upd T`。
- **T5 id**：场景对象 id 用 3、7、8（其余不写），effect 不写 id。建 3 个新层记 `getLayerByID` 能找回的 id（脚本侧读 id 的途径归 dll；若读不到，就用 `getLayerByID(k)` 对 1–20 扫一遍看哪个返回新层）。预期新 id 从计数器之后的空隙开始（例如 2、4、5…），不是 9、10、11。再建一个配置写 `id: 7` 的层，`getLayerByID(7)` 应返回原来那个。
- **T6 `getInitialLayerConfig` 的形状**：对一个带 `script` 字段、`user` 绑定字段、`animation` 字段、两个 effect、`parent` 的图层 `JSON.stringify(thisScene.getInitialLayerConfig(层))`；对 T1 的 X 也打一份。预期与 `scene.json` 原文一致、没有 `id`；脚本运行中改过的 `origin` 不反映。
- **T7 层级与矩阵**：P（`origin 100 50 0`、`angles 0 0 30`、`scale 2 1 1`）下挂 Q（`alignment: topleft`，`size 64 32`）。记 `Q.getTransformMatrix()` 的 16 个数、`Q.getParent().name`、`P.getChildren().map(c => c.name)`；`Q.setParent(undefined)` 后再记矩阵（预期跳变）；重挂后 `Q.setParent(P, true)` 再 `setParent(undefined, true)`（预期世界矩阵不变）。开 `cameraparallax` 再记一次，预期矩阵不含视差。
- **T8 effect**：一个图层带三个 effect，`name` 依次 `fx`、`FX`、`fx`，第二个两 pass。记 `getEffectCount()`、`getEffect('fx') === getEffect(2)`（预期真）、`getEffect('FX') === getEffect(1)`、`getEffect('')`、`getEffect(9)`、`getEffect(1).getMaterialCount()`；对一个 vec4 常量 `setMaterialProperty('名', new Vec3(1,0,0))`（预期无效果）、`new Vec4(1,0,0,1)`（预期生效，两个 pass 都变），抓帧看常量缓冲。
- **T9 音频条复现**：把 3304642534 的 bar 脚本精简成 5 根（`createLayer('models/workshop/<id>/bar.json')` 先跳过 `__workshopId` 问题），在正交场景里抓第一帧，核对 5 根 bar 与 `thisLayer` 的绘制先后和 `enumerateLayers` 序列。
