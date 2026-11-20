> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。P14 步骤 0c 实测核对后以报告为准。范围是 exe 侧：宿主接口 `H+0x50` / `+0x58` / `+0x60` 怎么接、模型数据在内存里的样子、D3D11 缓冲与上传、模型层怎么找到并共用模型数据、释放时机、模型层的绘制 / 剔除 / 命中，以及 `general.precache`。`scenescript64.dll` 侧（JS 参数校验、报错文字、句柄 / token、`createLayer` 的包装）见并行的 [rea-p14-script.md](rea-p14-script.md)；接口重叠处（描述结构、错误码、`model` 键的形状）以本文为准。

# WPE 2.8.42 场景脚本的自定义几何（`IModelData`）（exe 侧静态逆向）

**概括**
1. **建模型数据（`H+0x50` = `FUN_14018c720(H, desc, &err)`，返回 u32 id）：** 建出的就是 mdl 文件加载出来的那种**模型资源**（`FUN_1401d5c50` 构造，0x250 字节，引用计数 `+0x230` 初值 1），每个形状一个网格记录（200 字节）+ 一个 GPU 网格，只是字节来自 dll 交来的描述结构、不经 mdl 解析器；`MDLV0011` 只是写在材质串缓冲开头的 9 字节标记，没人读【确】。形状的 `vertexFormat` 在 exe 里**就是 mdl 的 26 位顶点格式掩码**（形状 `+0x28` 原样当 mdl 格式用：stride 走 `FUN_1400ea5b0`、输入布局走 `FUN_1400d7f90`、属性按表序交错），所以 POSITION / NORMAL / TANGENT_SIGNED / UV / COLOR → `0x1` / `0x2` / `0x4` / `0x8` / `0x8000`、按表序交错这一猜想在 exe 侧**成立**；JS 常量到位的换算在 dll 里，exe 看不到，但 Karin 的三种宽度 16 / 12 / 9 个 float 只有这一种映射对得上【exe 侧确；常量值推】。顶点长度单位是 **float 个数**（字节 = ×4），字节数不是 stride 的整数倍报错 3【确】。索引：`Uint16` 指针优先，否则 `Uint32`；都没有就建**非索引网格**（`Draw(顶点数)`）；拓扑恒为三角形列表【确】。材质：每个形状一个材质路径（256 字节串），经全局材质缓存 `ctx+0x1630` **当场同步加载**，不加任何 COMBO；`skin` 无效（每个网格只有一项）；**exe 没有缺省材质，但材质加载从不失败**：文件不存在或 JSON 解析失败时照样建出材质对象、着色器换成 WPE 自带的 `error`（顶点输入 `a_Position` + `a_TexCoord`），并留在缓存里。所以路径无效时报的是错误 2（格式里没有 UV）或者干脆建成功（格式里有 UV），错误 1 实际到不了（2026-11-20 更正，原写「加载失败报错 1」，见文末「实测对照」）。着色器顶点输入的语义名在格式里找不到报错 2（`FUN_1400d7b60` 用 D3DReflect 比语义**名**，不比语义号）【确】。包围盒：给了 `boundingBoxMins/Maxs` 就每个形状都用它；没给时**把整段顶点 float 数组当成紧密的 xyz 三元组**求 min / max（交错的法线、uv、颜色也算进去，WPE 的缺陷），各形状取并集，没有 mdl 加载器的 ±131072 兜底【确】。D3D11：动态 → `USAGE_DYNAMIC` + `CPU_ACCESS_WRITE`，否则 `USAGE_IMMUTABLE`，初值随 `CreateBuffer` 拷进 GPU【确】。存放：`ctx+0x1bf8` 的 `unordered_map<u32 id, 模型资源*>`（即资源管理器 `ctx+0x1a60` 内 `+0x198`），id = `++ctx+0x1c38`（从 1 起、不复用、`0xFFFFFFFF` 时拒绝），也写进资源 `+0x234`【确】。出错时整份释放、返回 0，`err` 留最后一个写入的码（exe 不清零 `err`）【确】。
2. **更新（`H+0x58` → `FUN_1401d6400(ctx+0x1a60, desc, id, replace, &err)`）：** 第 4 参为 0 是 `applyData`（dll 报错串叫 `IModelData.update`），为 1 是 `replaceData`【推：错误码与 dll 串一一对应】。**`applyData` 在调用当场上传**：对 D3D11 即时上下文 `Map(WRITE_DISCARD)` → `memcpy` → `Unmap`，不排队、不等绘制，所以数据当场拷走，之后改 JS 数组不影响画面（除非再调）【确】。拷贝长度是**建时的字节数**（网格记录 `+0x40` / `+0x50`），不是这次数组的长度；数组变短允许，变长按判断顺序报的是 7（5 / 6 两个码在 exe 里到不了）；**绘制数跟着变**：有索引时 = 这次的索引个数（大于 0 才改），无索引时 = `float 数 / stride 字节`（只有真实顶点数的 1/4，WPE 缺陷）【确】。`applyData` 不许：形状比现有多（10）、删形状或删缓冲（11）、换材质（12，`_stricmp` 比较）、换格式（13）、给建时不是动态的缓冲传数据（7）；`Map` 失败 8，索引类型和建时不同 9【确】。`replaceData`：按需重建 GPU 网格（换格式、变长、对非动态缓冲传数据、删索引时销毁旧网格、按新数据新建，动态标志取新的），换材质只改串，加形状、删形状，之后**同步通知所有用它的模型层重建材质与绘制记录**（`FUN_140225410` → `FUN_140224c70`）；**包围盒不更新**【确】。形状数增长时重新分配材质串缓冲，但旧网格记录里指向旧缓冲的材质指针不改，之后读写的是已释放的内存（**释放后使用**）【确：代码；后果推】。整条路径没有锁、没有线程切换，全在调用线程（渲染线程）上同步完成；exe 侧找不到「延迟回调里替换会死锁」的依据，最接近的风险是上面的释放后使用（见未查清 2）【确，有界】。
3. **查找与生命周期：** 模型对象加载 `FUN_14021ad10` 里 `model` 是**数字**（int / uint / real，real 截断，`FUN_140085f70`）才按 id 查 `ctx+0x1bf8`（`FUN_1401607e0`，只查不插），查到就引用计数 +1、挂上；查不到图层照建、没有模型（不画、不命中）。`model` 是**字符串**一律当文件路径走 `FUN_1401d5a40`，所以 token 只能以数字进 JSON（是对象时也建出模型对象但不挂模型）【确】。多个图层用同一 id：共用同一份资源（同一组 D3D 缓冲、同一份包围盒），每个图层各自 +1 引用、各自登记一个变更监听（`ctx+0x1c40`，键是资源指针）、各自一份绘制记录【确】。`destroyModelData`（`H+0x60` = `FUN_14018d8b0(H, id)`）只是引用计数 −1，减到 0 才释放（`FUN_1401d7af0`）并从表里删掉 id；还有图层用着时什么都不释放、id 仍查得到（`applyData` 照样能改它）【确】。图层析构：先摘监听，再 `FUN_1401d6bb0(rm, id)` −1，减到 0 释放并删 id【确】。场景卸载时 `FUN_1401c3840` 不看引用计数，把表里全部模型数据释放【确】。exe 不防重复 `destroyModelData`（再调一次会再减一次），防护归 dll【确】。
4. **绘制：** 脚本建的模型层和 mdl 模型层走**同一个绘制函数** `FUN_1402222a0`，没有按模型数据分支（不读资源 `+0x234`）【确，有界】。绘制前把 `ctx+0x120..+0x12c`（`g_Alpha`、`g_Color`、`g_Color4`）**写死为 1**，模型对象本身也没有 `alpha` / `color` / `brightness` 字段（rea-p5-mesh 2.2）——这就是脚本注释「动态模型层的 alpha 不进 `g_Color4`」的依据【确】。`g_ModelMatrix` = 矩阵栈顶 · 图层世界矩阵 `FUN_1401850a0`（`W_parent · T · Rz·Ry·Rx · S`，含 `scale.z`），栈顶在主 pass 里是视差平移（P5a），不带缩放，所以 Karin 用 `length(mul(vec4(0,0,1,0), g_ModelMatrix).xyz)` 取 `scale.z` 成立【确；视差只平移是 P5a 的结论】。视锥剔除用对象 `+0x2f8..+0x30c` 的包围盒（`FUN_140224c70` 从资源 `+0x1c8` 拷来）：两角经世界矩阵变换，取中点为球心、半对角线为半径【确】。命中：模型（类型 5）参与光标命中，用同一个包围盒做 slab（P6c：实际测的是 `[0, max − min]`、不要求 `t ≥ 0`）；不测三角形【确，沿用 P6c】。另外脚本模型数据带一条「命中盒」记录（`mdl+0x1a0`），按下 / 拖动时 `vt+0x88` 会把它命中的序号 `"0"` 写进事件的骨骼名【确：代码；几何含义推】。
5. **`general.precache`（`0x140187d0a`–`0x140187e1c`）：** 只认 `general.precache` 是**数组**；元素只认字符串；字符串以 `materials` 开头（`_strnicmp`，**不分大小写**，没有斜杠要求）才 `FUN_14014ff70(ctx+0x1630, 路径)` 预载进材质缓存，其它前缀与非字符串一律跳过【确】。除了让缓存先有这一项之外**没有别的效果**：不加引用、不改任何标志，`createLayer` / `createModelData` 照旧是同步的（缓存没有就在调用里当场加载）；材质缓存不按引用计数淘汰，加载失败的路径以「带 `error` 着色器的材质」留在缓存里【确，2026-11-20 更正：原写「以空值留在缓存」】。缺了某个材质时，第一次用它的是 `createModelData`（它为了着色器检查当场同步加载材质，早于建图层）；文件读不到时得到的是带 `error` 着色器的材质（错误 2 或建成功，见第 1 条），不是错误 1【确，2026-11-20 更正】。

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42），SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工时核对一致（与 `ignore/p9/rea/wallpaper64.exe` 相同）。没运行、没附加 WPE，没写 Steam / WPE 目录；只读了 dll 文件里的报错串（核对错误码）和 `ui/dist/scripts/scripts.js` 的更新日志。
- 方法：**没用 REA。** REA 的 Ghidra 会话一次只挂一个 Program，开工时它已挂着并行代理打开的 `scenescript64.dll`；对它 `open_binary` 会把对方的会话切走，所以没碰 REA（也就没有要关的文档）。改用本机同一版本的 Ghidra（`D:\Programs\ghidra_12.1.4_PUBLIC`，REA 用的就是它）无界面导入一份副本、默认自动分析，再用 `DecompAddrs.java` 按地址清单反编译；指令级细节用 `ignore/p4/rea/wp.asm`（objdump 全量反汇编）切片核对，切片与虚表脚本沿用 `ignore/p6/rea/layers/exe/` 的 `slice.py` / `fn.py` / `xr.py` / `vtdump.py` / `rd.py`。Ghidra 工程放在会话临时目录、不保留。
- 工作文件 `ignore/p14/0/rea/exe/`：
  - 伪代码（Ghidra 12.1.4，`<地址>-<名字>.c`）：`14018c720-createModelData`、`14018d8b0-destroyModelData`、`1401d6400-modelDataUpdate`、`1401c2f10-shapeToMesh`、`1401d5c50-modelResCtor`、`1401d7af0-releaseModelRes`、`1401d6bb0-releaseModelDataById`、`1401d5a40-modelResByPath`、`14014ff70-materialLoad`、`1401515b0-materialLoadImpl`、`140151f40-materialCacheInsert`、`1401a5c40-shaderGet`、`14021ad10-modelObjLoad`、`14021c480-modelObjUpdate`、`1402222a0-modelObjDraw`、`140224c70-modelObjMaterials`、`140225410-modelResChanged`、`1401607e0-modelDataFind`、`1401da9c0-listenerMapTryEmplace`、`140185520-modelHit`、`140223810-modelBoneHit`、`14009a780-devCreateMesh`、`14009a880-devCreateIndexedMesh`、`1400ea780-gpuMeshDraw`、`1400ea8d0-gpuMeshMapVB`、`1400ea970-gpuMeshMapIB`、`1400ea5b0-vertexStride`、`1400d7f90-inputLayoutGet`、`140085f70-jsonAsInt`、`1401d7760-meshGpu`、`1401d8e10-meshRecordPush`、`1401d8ec0-gpuEntryPush`、`140186c90-sceneCtor`。
  - 汇编切片：`14018c720-createModelData.asm`、`14018d890-iface_58_60.asm`（`H+0x58` 跳板与 `H+0x60`）、`1401d6400-modeldata_update.asm`（含 `FUN_1401d6bb0`）、`1401c2f10-shape_to_mesh.asm`、`14009a780-dev_create_mesh.asm`（设备 `+0x48` / `+0x40`）、`1400ea6d0-gpu_mesh_vtable.asm`（GPU 网格虚表的析构 / 绘制 / Map / Unmap）、`1400d7b60-shader_accepts_format.asm`、`140187d0a-precache.asm`、`14021aa00-modelObj_dtor_release.asm`、`1401d5f10-releaseModelRes_byOwner.asm`、`1401c3c2f-rm_clear_all_modeldata.asm`。
  - `tools/`：`DecompAddrs.java`（Ghidra 脚本，按地址清单反编译）与两份地址清单。
- 标记：【确】伪代码 / 汇编直接看到；【推】由代码推出，或依赖 D3D11 / 另一侧的约定；【确，有界】在注明范围内搜过。

**命名**（沿用 rea-p6d-layers、rea-p5-mesh）
- `H` 宿主接口（虚表 `0x14048ea50`），`*(H+0x90) = ctx`。`rm = ctx+0x1a60`：资源管理器（嵌在 `ctx` 里，第一个字段是回指 `ctx` 的指针，所以伪代码里的 `*(ctx+0x1a60)+0x1630` 就是 `ctx+0x1630`）。
- `rm` 内（括号里是 `ctx` 偏移）：`+0x158`（`0x1bb8`）按路径的模型资源表；`+0x198`（`0x1bf8`）**模型数据表** `unordered_map<u32, 资源*>`（`+0x1a0` 链表头、`+0x1a8` 元素数、`+0x1b0` 桶、`+0x1c8` 掩码，键的哈希是 4 字节 FNV-1a）；`+0x1d8`（`0x1c38`）id 计数器；`+0x1e0`（`0x1c40`）**变更监听表**（键是资源指针，值里有 `std::function` 链表），`+0x220`（`0x1c80`）监听编号。
- `ctx+0x1630`：材质缓存（`FUN_14014ff70`）。`ctx+0x1518`：设备封装（虚表 `0x140485b90`，`+0x70` → `ID3D11Device*` 的持有者，`+0x8` → 即时上下文）。
- `res`：模型资源（0x250 字节）。`mdl = res+0x10`（模型对象的 `O+0x2e8`）。
- `mesh`：网格记录（200 字节，`res+0x20` 向量，即 `mdl+0x10`）。`gpu`：GPU 网格条目（0x20 字节，`res+0x238` 向量）。`gm`：设备网格对象（0x50 字节，虚表 `0x140486f38`）。
- `S`：dll 交来的形状结构（0x130 字节）；`D`：描述结构（形状数组 + 包围盒）。
- 模型对象 `O`（800 字节，虚表 `0x140491338`）：`+0x2c0` 绘制记录、`+0x2d8` 骨骼运行时、`+0x2e8` mdl、`+0x2f0` 资源、`+0x2f8` / `+0x304` 包围盒 min / max（拷贝）、`+0x314` 监听编号。

---

## 1. 宿主接口三个槽与 dll 交来的结构

### 1.1 槽【确】
| 槽 | 函数 | 签名（exe 侧看到的） |
|---|---|---|
| `+0x50` | `FUN_14018c720` | `u32 (H, D* desc, i32* err)`：返回 id，失败 0 |
| `+0x58` | `0x14018d890`：`rcx = *(H+0x90) + 0x1a60; jmp FUN_1401d6400` | `void (H, D* desc, u32 id, bool replace, i32* err)`（第 1 参被换成 `rm`，其余原样） |
| `+0x60` | `FUN_14018d8b0` | `void (H, u32 id)` |

### 1.2 描述结构 `D` 与形状 `S`【字段的读法确；含义按用途推】
`D`（`H+0x50` / `+0x58` 共用）：

| 偏移 | 类型 | 含义 |
|---|---|---|
| `+0x00` | `S*` | 形状数组 |
| `+0x08` | i32 | 形状个数 |
| `+0x0c` | u8 | 给了包围盒（仅 `+0x50` 读） |
| `+0x10` | f32×3 | `boundingBoxMins` |
| `+0x1c` | f32×3 | `boundingBoxMaxs` |

`S`（步长 0x130）：

| 偏移 | 类型 | 含义 | 依据 |
|---|---|---|---|
| `+0x00` | `float*` | 顶点数据，可空（更新时空 = 不改顶点） | 建时作 `CreateBuffer` 初值、更新时 `memcpy` 源 |
| `+0x08` | u32 | 顶点 **float 个数** | 建时字节数 = 它 ×4（`0x1401c2f6b`），包围盒循环按 float 数走 |
| `+0x0c` | u8 | `isVertexBufferDynamic` | 建时进 `gpu+0x10`、`D3D11_USAGE_DYNAMIC` |
| `+0x10` | `u32*` | `Uint32` 索引，可空 | 建时 `+0x18` 为空才用；更新时只在网格是 32 位索引时用 |
| `+0x18` | `u16*` | `Uint16` 索引，可空 | 建时优先；更新时只在网格是 16 位索引时用 |
| `+0x20` | u32 | 索引个数 | 字节数 = ×2 或 ×4；即绘制数 |
| `+0x24` | u8 | 删掉索引缓冲【推：`applyData` 遇它报 11「Cannot delete shape or buffers」，`replaceData` 遇它且网格有索引就重建】 | `0x1401d65ea`、`0x1401d67df` |
| `+0x25` | u8 | `isIndexBufferDynamic` | 建时进 `gpu+0x11` |
| `+0x28` | u32 | 顶点格式（**mdl 26 位掩码**），更新时 0 = 不改 | 原样写进 `mesh+0x38`、算 stride、建输入布局 |
| `+0x2c` | char[256] | 材质路径（以 `\0` 结尾），更新时空串 = 不改 | 整 256 字节拷进材质串缓冲 |
| `+0x12c` | u8 | 删掉这个形状【推：同 11；`replaceData` 末尾按它删网格】 | `0x1401d65df`、`0x1401d69de` |

exe 不初始化 `*err`，只在出错时写；多个形状都出错时留最后一个【确】。

### 1.3 错误码【exe 写入点确；文字是 dll 里按顺序排列的 13 个串，对应关系推】
| 码 | 写入点 | dll 串 |
|---|---|---|
| 1 | 材质缓存返回空或材质没有着色器：`0x14018cdc8`、`0x1401d6b4b`（实际到不了：材质总能建出、着色器缺省是 `error`，见「实测对照」Q2） | Invalid material |
| 2 | 着色器检查失败：`0x14018cdc0`、`0x1401d689c` | Shader expecting more vertex data. |
| 3 | 顶点字节数不是 stride 的整数倍：`0x1401c2f8d` | Inconsistent vertex buffer size |
| 4 | id 不在表里：`0x1401d6b95` | Invalid model data token |
| 5 | `applyData` 顶点 float 数超过建时：`0x1401d6b6c`（按判断顺序到不了，变长先报 7，见 3.1） | Vertex buffer size cannot increase |
| 6 | `applyData` 索引数超过建时：`0x1401d6b60`（同上） | Index buffer size cannot increase |
| 7 | `applyData` 给非动态缓冲传数据，或任何要重建的情形（含变长）：`0x1401d6b54` | Model data not created as dynamic |
| 8 | `Map` 失败：`0x1401d6908`、`0x1401d6957` | Buffer lock failed |
| 9 | 索引数组类型和网格不同：`0x1401d6b78` | Incorrect index buffer type |
| 10 | `applyData` 形状数多于现有：`0x1401d64f1` | Cannot add shapes in IModelData.update |
| 11 | `applyData` 带删形状 / 删缓冲标志：`0x1401d6b84` | Cannot delete shape or buffers in IModelData.update |
| 12 | `applyData` 换材质：`0x1401d6b41` | Material cannot be changed in IModelData.update |
| 13 | `applyData` 换格式：`0x1401d6747` | Vertex format cannot be changed in IModelData.update |

## 2. 建模型数据（`H+0x50`，第 1 题）

### 2.1 流程【确：`FUN_14018c720`，伪代码 + 汇编】
```c
u32 createModelData(H, D* d, i32* err) {
  ctx = H->ctx;
  if (ctx->idCounter /*+0x1c38*/ == 0xFFFFFFFF) return 0;                  // 0x14018c755
  n = d->count;  size = n > 0 ? (n << 8 | 9) : 9;
  res = new ModelResource;            // FUN_1401d5c50：refcount(+0x230)=1, id(+0x234)=0
  res->bufSize = size;  res->buf(+0x08) = calloc(size);  res->mdl.data(+0x10) = res->buf;
  memcpy(res->buf, "MDLV0011\0", 9);  slot = res->buf + 9;                  // 只是标记，没人解析
  for (i = 0; i < n; i++) {           // 出错不跳出，接着处理下一个形状
    S* s = &d->shapes[i];
    mesh = res->meshes.push_back({});              // 200 字节，见 2.2
    gpu  = res->gpu.push_back({});                 // 0x20 字节
    shapeToMesh(ctx, mesh, gpu, s, err);           // FUN_1401c2f10，见 2.3；失败只写 err=3
    mat = materialCache(ctx+0x1630, s->material);  // FUN_14014ff70：同步加载
    if (!mat || !mat->shader(+0x1e0)) *err = 1;
    else if (!mat->shader->acceptsFormat(mesh->format)) *err = 2;           // vt+0x18 = FUN_1400d7b60
    memcpy(slot, s->material, 256);  mesh->materials.push_back(slot);  slot += 256;
    box_i = d->hasBox ? (d->mins, d->maxs) : xyzTriplesMinMax(s->vertices, s->floatCount);   // 2.6
    box = union(box, box_i);
  }
  res->hitBoxes(+0x1b0 = mdl+0x1a0).push_back({ box.max - box.min, I(3×4), center(box), 1 });    // 0x14018d1e4
  res->boxMin(+0x1c8 = mdl+0x1b8) = box.min;  res->boxMax(+0x1d4 = mdl+0x1c4) = box.max;       // 0x14018d397
  if (*err != 0) { releaseModelRes(res); return 0; }                         // 0x14018d3e6
  id = ++ctx->idCounter;  ctx->modelData(+0x1bf8)[id] = res;  res->id = id;  // 0x14018d401 / 0x14018d45c
  return id;
}
```
- 没有形状（`n ≤ 0`）也能建出来、拿到 id：没有网格，包围盒保持 `(+FLT_MAX, −FLT_MAX)` 的反向初值，命中盒记录里是无穷 / NaN【确】。dll 先报「Shapes missing」（dll 侧）。
- 返回之前不碰任何图层；模型数据建出来时没有图层用它，引用计数 1 归脚本句柄【推】。

### 2.2 模型资源（「内存里的 mdl」）【确】
和 mdl 文件加载出来的是同一个类（同一个构造 `FUN_1401d5c50`、同一个释放 `FUN_1401d7af0`，P5 的模型对象读的字段都在）：

| 偏移 | 内容 | 脚本模型数据 | mdl 文件 |
|---|---|---|---|
| `+0x00` | u32 缓冲字节数 | `n·256 + 9` | 文件长 |
| `+0x08` | 缓冲 | `MDLV0011\0` + 每形状 256 字节材质串 | 文件字节 |
| `+0x10` = `mdl` | `mdl+0` 数据指针（模型对象只判非空） | 同 `+0x08` | |
| `+0x20` = `mdl+0x10` | 网格记录向量（200 字节/项） | 每形状一项 | 每网格一项 |
| `+0x40` = `mdl+0x30` | 骨骼向量 | 空 | MDLS |
| `+0x1b0` = `mdl+0x1a0` | 命中盒向量（0x4c/项） | 1 项（2.1 末） | puppet 的记录 |
| `+0x1c8` / `+0x1d4` = `mdl+0x1b8` / `+0x1c4` | 包围盒 min / max | 2.6 | 1.6 节（rea-p5-mesh） |
| `+0x210` | 路径串 | 空 | 资源路径 |
| `+0x230` | 引用计数 | 建时 1 | 建时 1 |
| `+0x234` | 模型数据 id | `≥ 1` | 0 |
| `+0x238` | GPU 网格向量（0x20/项） | 每形状一项 | 每网格一项 |

网格记录里用到的字段（偏移相对 `mesh`）：`+0x00` 材质路径指针向量（脚本模型恒为 1 项，指进 `res+0x08` 的 256 字节槽）、`+0x18` 网格标志（bit0 = 32 位索引）、`+0x38` 格式、`+0x3c` stride（字节）、`+0x40` 顶点字节数、`+0x50` 索引字节数。GPU 条目：`+0x00` 设备网格对象、`+0x08` 建时顶点 float 数（容量）、`+0x0c` 建时索引数（容量）、`+0x10` 顶点动态、`+0x11` 索引动态、`+0x12` 有索引、`+0x18` 变形纹理（脚本模型恒空）。

### 2.3 形状 → 网格：`FUN_1401c2f10(ctx, mesh, gpu, S, err)`【确：`0x1401c2f10`–`0x1401c309c`】
```c
mesh->format = S->format;                       // 0x1401c2f4f
mesh->stride = vertexStride(S->format);         // FUN_1400ea5b0（mdl 同一个函数，表序求和）
mesh->vertexBytes = S->floatCount * 4;
if (mesh->vertexBytes % mesh->stride) { *err = 3; return false; }        // 网格对象留空
vtx = mesh->vertexBytes / mesh->stride;
gpu->{cap, idxCap, dynV, dynI, hasIdx} = {S->floatCount, S->indexCount, S->dynV, S->dynI, S->u16 || S->u32};
flags = (S->dynI ? 2 : 0) | (S->dynV ? 1 : 0);
if (hasIdx) {
  mesh->indexBytes = S->indexCount * (S->u16 ? 2 : 4);
  gpu->mesh = dev->createIndexedMesh(S->format, S->vertices, vtx,
                                     S->u16 ? S->u16 : S->u32, S->indexCount, /*is32*/ !S->u16, /*topology*/ 0, flags);   // 设备 +0x40
  mesh->flags = S->u16 ? mesh->flags & ~1 : mesh->flags | 1;
} else {
  gpu->mesh = dev->createMesh(S->format, S->vertices, vtx, /*topology*/ 0, flags);                                    // 设备 +0x48
}
```
- **格式**：形状 `+0x28` 不经任何换算就是 mdl 格式掩码（rea-p5-mesh 1.4 的 26 位表）。顶点内按表序交错、偏移是前面置位属性大小的累加（输入布局 `FUN_1400d7f90` / `FUN_1400d81b8` 与 mdl 共用）。所以 `POSITION 0x1(12) · NORMAL 0x2(12) · TANGENT4 0x4(16) · TEXCOORD 0x8(8) · COLOR 0x8000(16)` 的五种组合宽度是：`[P,N,T,UV,C]` 64 字节 = 16 float、`[P,N,UV,C]` 48 = 12、`[P,UV,C]` 36 = 9，与 Karin 分配的数组宽度一致【exe 侧确；JS 常量 → 位由 dll 决定，推】。
- **两种索引同时给**：`Uint16` 胜出【确】。不检查索引数是不是 3 的倍数、不检查索引越界【确，有界：本函数与设备 `+0x40`】。
- **拓扑**：设备建网格时参数 0 → `gm+0x30 = 4`（`D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST`），所以永远是三角形列表【确】。
- **绘制数** `gm+0x2c`：有索引 = 索引数（为 0 时取顶点数），无索引 = 顶点数【确：`0x14009a90c`–`0x14009a913`】。

### 2.4 D3D11 缓冲（设备 `+0x40` = `0x14009a880`、`+0x48` = `0x14009a780`）【确】
| | 顶点缓冲 | 索引缓冲 |
|---|---|---|
| `ByteWidth` | `stride · 顶点数` | `索引数 · (is32 ? 4 : 2)` |
| `Usage` | 动态 `2`（DYNAMIC），否则 `1`（**IMMUTABLE**） | 同左，看 `isIndexBufferDynamic` |
| `BindFlags` | `1`（VERTEX_BUFFER） | `2`（INDEX_BUFFER） |
| `CPUAccessFlags` | 动态 `0x10000`（WRITE），否则 0 | 同左 |
| 初值 | `pSysMem = S->vertices`（为空时不给初值） | `pSysMem = 索引指针` |
| 索引格式 | — | `is32 ? 0x2a (R32_UINT) : 0x39 (R16_UINT)`（`gm+0x20`） |

`CreateBuffer` 是 `ID3D11Device` 虚表 `+0x18`（`0x14009a97e`、`0x14009a9fe`）。初值由 D3D 当场拷进资源，之后不再引用脚本的内存【推，D3D 规则】。设备网格对象 `gm`：`+0x10` 顶点缓冲、`+0x18` 索引缓冲、`+0x20` 索引格式、`+0x24` 顶点格式、`+0x28` stride、`+0x2c` 绘制数、`+0x30` 拓扑。

### 2.5 材质与着色器检查【确】
- **加载**：`FUN_14014ff70(ctx+0x1630, 路径)`：把 `\` 换成 `/`（`FUN_1400187b0`），按整串 FNV-1a 查缓存（**区分大小写**，`memcmp`）；没有就 `FUN_1401515b0` 当场同步加载（读 json、取着色器 `FUN_1401a5c40`，着色器编不出来时换成 `error` 着色器），用 `FUN_140151f40` 插进缓存后返回。缓存项没有引用计数【确】。`FUN_1401515b0` 一开头就分配材质对象、无论成败都返回它，文件不存在 / 解析失败时着色器是 `error`；这份「坏材质」照样留在缓存里（2026-11-20 补全，原写「失败结果（空指针）留在缓存」，见「实测对照」Q2）【确】。
- **和 mdl 网格同一套**：建图层时模型对象的 `FUN_140224c70` 按 `mesh.materials[min(skin, 项数 − 1)]` 取路径，脚本模型每个网格只有 1 项，所以 `skin` 不起作用；没有骨骼，走 `FUN_14014ff70` 无 COMBO 的那一支（rea-p5-mesh 2.4）【确】。
- **缺省材质**：exe 里没有专门的缺省材质，但空串、不存在的路径、坏 JSON 都会得到带 `error` 着色器的材质（`FUN_1400d3f80` 读不到返回空串 → 解析失败 → `0x140151a6b` 换 `error`），不会是错误 1【确，2026-11-20 更正】；不传 `material` 时 dll 先报「Material missing.」（dll 侧）。
- **着色器检查** `FUN_1400d7b60`（着色器类虚表 `0x140486ef8` 的 `+0x18`，类由设备 `+0x38` → `FUN_1400d5070` 构造）：
  ```c
  bool acceptsFormat(Shader* sh, u32 fmt) {
    if (vsBytecode(sh+0x198..0x1a0) 为空) return false;
    D3DReflect(vsBytecode) → refl;  失败 return false;                // d3dcompiler 动态取 D3DReflect
    names = { inputElementDesc[i].SemanticName | 表序 i ∈ 0..25 且 fmt & mask[i] };   // 0x140484a20 / 0x140482af0
    for (k = 0; k < refl.InputParameters; k++)
      if (refl.GetInputParameterDesc(k).SemanticName ∉ names) ok = false;
    return ok;
  }
  ```
  只比**语义名**（`POSITION`、`NORMAL`、`TANGENT`、`TEXCOORD`、`COLOR`、`BLENDINDICES`、`BLENDWEIGHT`），不比语义号：着色器读 `a_TexCoordC1`（TEXCOORD1）而格式只有 UV（TEXCOORD0）也算通过【确】。这一检查只在 `createModelData` 与 `replaceData` 重建网格时做，模型对象建图层时不做【确，有界】。

### 2.6 包围盒【确：`0x14018cf87`–`0x14018d0a8`、`0x14018d397`–`0x14018d3d5`】
```c
if (d->hasBox) box_i = (d->mins, d->maxs);                  // 每个形状都用同一个
else {
  box_i = (+FLT_MAX, −FLT_MAX);
  if (S->floatCount > 2)
    for (f = S->vertices; (f - S->vertices) + 2 < S->floatCount; f += 3)   // 按 float 走，步长 3
      box_i = expand(box_i, f[0], f[1], f[2]);
}
box = union(box, box_i);
```
- 没给包围盒时**不看 stride**：整段交错数组被当成 xyz 三元组，法线、切线、uv、颜色的分量都混进 min / max（只有格式恰好只有 POSITION 时才是真的位置包围盒）【确】。位置在几百像素量级时，混进来的分量大多落在 `[−1, 1]`，效果是包围盒被撑到含原点附近一小块【推】。
- 最后没有 mdl 加载器那种「`max.x ≤ min.x` 就改成 ±131072」的兜底【确】。
- 包围盒**只在这里算一次**：`replaceData` / `applyData` 都不改（`FUN_1401d6400` 不写 `res+0x1c8..+0x1dc`）【确】。Karin 每次都传 `±8000` / `±2600` 的盒子。

### 2.7 存放与 id【确】
- 表：`ctx+0x1bf8`（`rm+0x198`），`std::unordered_map<u32, ModelResource*>`，键哈希是 id 的 4 字节 FNV-1a；节点 `+0x10` id、`+0x18` 资源。
- id：`++ctx+0x1c38`，从 1 起，删了不复用；计数器在场景卸载时不清零【推，有界：`FUN_1401c3840` 不写它】。

## 3. 更新（`H+0x58`，第 2 题）

### 3.1 流程【确：`FUN_1401d6400`，`0x1401d6400`–`0x1401d6bab`】
```c
void update(rm, D* d, u32 id, bool replace, i32* err) {
  res = rm->modelData.find(id);  if (!res) { *err = 4; return; }
  if (!replace && d->count > res->gpu.size()) { *err = 10; return; }
  size = d->count > 0 ? (d->count << 8 | 9) : 9;
  if (size > res->bufSize) { 新缓冲 = calloc(size); 拷旧内容; free(旧缓冲); res->buf = 新缓冲; }   // 见 3.4 的释放后使用
  listeners = ctx->listeners(+0x1c40).tryEmplace(res);
  changed = false;  slot = res->buf + 9;
  for (i = 0; i < d->count; i++) {
    S* s = &d->shapes[i];
    if (s->deleteShape || s->dropIndex) { if (!replace) { *err = 11; goto done; } if (s->deleteShape) continue; }
    if (replace && i >= res->gpu.size()) { res->gpu.push_back({}); res->meshes.push_back({}); res->meshes[i].materials.push_back(slot); }
    if (s->material[0] && _stricmp(s->material, *res->meshes[i].materials[0]) != 0) {
      if (!replace) { *err = 12; goto done; }
      memcpy(*res->meshes[i].materials[0], s->material, 256);  changed = true;
    }
    slot += 256;
    if (i >= res->gpu.size()) continue;
    mesh = &res->meshes[i];  gpu = &res->gpu[i];
    fmtChanged = s->format && s->format != mesh->format;
    if (fmtChanged && !replace) { *err = 13; goto done; }
    hasIdx  = s->u32 || s->u16;
    vGrow   = s->vertices && s->floatCount > gpu->cap;
    iGrow   = hasIdx && s->indexCount > gpu->idxCap;
    rebuildV = fmtChanged || vGrow || (s->vertices && !gpu->dynV);
    rebuildI = fmtChanged || iGrow || (hasIdx && !gpu->dynI) || (s->dropIndex && gpu->hasIdx);
    if ((s->vertices && !gpu->dynV) || (hasIdx && !gpu->dynI) || rebuildV || rebuildI) {
      if (!replace) { *err = 7; goto done; }
      delete gpu->mesh;  gpu->mesh = null;  changed = true;
      shapeToMesh(ctx, mesh, gpu, s, err);                        // 2.3，按新形状新建（动态标志、格式都取新的）
      if (s->material[0]) { 材质检查同 2.5，失败 *err = 1 / 2 并直接跳到通知监听 }
      continue;
    }
    if (!replace && vGrow) { *err = 5; goto done; }            // 实际上被上一个 if 先截住（vGrow ⊂ rebuildV）
    if (!replace && iGrow) { *err = 6; goto done; }
    uploadInPlace(gpu, mesh, s, err);                           // 3.2
  }
  if (replace)                                                  // 只在循环正常走完时
    for (i = 0, j = 0; i < d->count; i++, j++)
      if (d->shapes[i].deleteShape) { 释放 res->gpu[j] 的网格与变形纹理; 删 res->gpu[j]、res->meshes[j]; j--; changed = true; }
done:
  if (changed) for (l : listeners) l(res);                      // 3.3
}
```
- 第 5、6 码按上面的判断顺序其实到不了：`vGrow` / `iGrow` 已经让「要重建」成立，`applyData` 先报 7【确：`0x1401d679f`–`0x1401d6815` 的布尔组合】。
- 出错时已经处理过的形状不回滚（`applyData` 里第 2 个形状报错时，第 1 个已经上传）；`replaceData` 的错误 1 / 2 也跳过后面的形状和删除循环，但仍通知监听【确】。

### 3.2 就地上传（`applyData`，以及 `replaceData` 里不用重建的形状）【确：`0x1401d68bf`–`0x1401d6995`，GPU 网格虚表 `0x140486f38`】
```c
if (s->vertices) {
  if (gm->vt[0x10](gm, &p, s->floatCount / mesh->stride, s->indexCount))   // 0x1400ea8d0
    { memcpy(p, s->vertices, mesh->vertexBytes); gm->vt[0x18](gm); }       // Unmap
  else *err = 8;
}
if (s->u32 && (mesh->flags & 1))       { gm->vt[0x20](gm, &p, s->indexCount); memcpy(p, s->u32, mesh->indexBytes); gm->vt[0x28](gm); }
else if (s->u16 && !(mesh->flags & 1)) { 同上，源 s->u16 }
else if (s->u32 || s->u16)             *err = 9;
```
GPU 网格的 `Map` / `Unmap`：
```c
bool mapVB(gm, void** p, u32 vtxCount, u32 idxCount) {      // 0x1400ea8d0
  if (gm->ib) { if (idxCount > 0) gm->drawCount = idxCount; }
  else        { if (vtxCount > 0) gm->drawCount = vtxCount; }
  return ctx->Map(gm->vb, 0, D3D11_MAP_WRITE_DISCARD /*4*/, 0, &m) >= 0 && (*p = m.pData, true);
}
bool mapIB(gm, void** p, u32 idxCount) { gm->drawCount = idxCount; return Map(gm->ib, …WRITE_DISCARD…); }   // 0x1400ea970
```
- **时机**：调用当场，在 `ID3D11DeviceContext`（即时上下文，`dev+0x8`）上 `Map` / `memcpy` / `Unmap`。没有上传队列，也没有「绘制时再传」；模型对象的每帧更新 `FUN_14021c480` 对没有骨骼的模型直接返回【确】。脚本都在帧函数里、渲染之前跑（rea-p6d-layers 第 10 节），所以本帧就画新数据【推】。
- **拷多少**：`memcpy` 的长度是建 / 重建时记下的 `mesh+0x40`、`mesh+0x50`（**整块容量**），不是这次数组的长度。数组比容量短时从脚本给的指针多读（源是否越界看 dll 交的是不是数组本身）；`WRITE_DISCARD` 之后整块都被重写【确：代码；越界后果推】。
- **绘制数**：
  - 有索引的网格：传了索引（`indexCount > 0`）→ 绘制数 = 这次的索引个数（顶点 `Map` 与索引 `Map` 都这样写）；只传顶点、`indexCount` 为 0 → 不变【确】。Karin 的遮罩部件每次整块传、多余三角形填 0，正好对上。
  - 无索引的网格：绘制数 = `floatCount / stride字节`（`0x1401d68c9` 的 `div` 用 float 个数除以字节 stride），是真实顶点数的 1/4 取整，WPE 的缺陷；`floatCount` 不足一个 stride 字节数时为 0 → 不变【确】。语料没有无索引的用法。
- **形状数少于现有**：只改前几个，其余原样【确】。**不传某个缓冲**：那个缓冲原样【确】。

### 3.3 通知用它的模型层【确】
`changed` 为真时（只可能在 `replaceData` 里：换了材质、重建了网格、删了形状）逐个调监听表里该资源的 `std::function`（`0x1401d6ae1`–`0x1401d6b16`）。模型对象登记的是 `FUN_140225410(O)`：清空绘制记录 `O+0x2c0`，调 `FUN_140224c70` 重新按网格取材质、建绘制记录并**重新拷包围盒**（值没变），再处理骨骼（脚本模型没有）。同步完成，同一帧就用新网格画。`applyData` 不通知（网格对象没换、绘制记录里的指针仍然有效）【确】。

### 3.4 `replaceData` 重建什么【确】
- **重建 GPU 网格**（销毁旧设备网格、`FUN_1401c2f10` 按新形状新建）的条件：换格式；顶点或索引超过建时容量；给建时不是动态的缓冲传数据（所以非动态的模型数据只能经重建来改）；带「删索引」标志而网格有索引。新网格的容量、动态标志、索引宽度、绘制数全部取这次的形状。
- 新建时格式取形状 `+0x28`：如果 dll 在 `replaceData` 里对没写 `vertexFormat` 的形状传 0，重建会写 `mesh->format = 0`、stride 0，随后按 stride 取余会除零【推：取决于 dll 怎么填，见未查清 3】。
- **换材质**：只改材质串（256 字节），不检查着色器（检查只跟着重建走），由监听重建绘制记录时加载【确】。
- **加形状**：在末尾追加网格记录与 GPU 条目（空的，动态标志为 0，于是一定走重建）【确】。
- **删形状**：循环之后统一删，`i` 是**原来的**下标（边删边把后面的下标减一）【确】。
- **材质串缓冲的释放后使用**：形状数增长到 `n·256 + 9` 超过原缓冲时换新缓冲、释放旧的，但已有网格记录里 `materials[0]` 仍指向旧缓冲；之后同一次调用里的 `_stricmp` / `memcpy`、监听里的 `FUN_140224c70`、以后每次重建都读写已释放的内存【确：`0x1401d6534`–`0x1401d657b` 只改 `res+0x08`、新网格才取新槽】。语料（Karin）不用 `replaceData`。

### 3.5 线程与锁【确，有界】
- `FUN_1401d6400`、`FUN_1401c2f10`、设备建网格、GPU 网格 `Map` / `Unmap`、监听 `FUN_140225410` / `FUN_140224c70` 里没有任何临界区、SRW 锁或等待；exe 全局导入的 `EnterCriticalSection` / `AcquireSRWLockExclusive` / `WaitForSingleObject(Ex)` / `SleepConditionVariableSRW` 的调用点（`xr.py` 全量扫描）都不在这些函数里。
- 脚本回调（`update`、计时器、光标回调、属性回调）都在渲染线程的帧函数里、渲染之前派发（rea-p6c / p6d），D3D11 即时上下文也在这个线程上，所以 `applyData` / `replaceData` 不跨线程。
- 结论：exe 侧没有能解释「延迟回调里替换活的 GPU 缓冲会让原生渲染器死锁」的机制。能看到的风险是 3.4 的释放后使用（可能表现为崩溃或卡死）和 3.2 的多读；「延迟回调」在 dll 侧指什么、dll 有没有自己的锁，见 rea-p14-script.md（未查清 2）。

## 4. 查找、共用与释放（第 3 题）

### 4.1 模型对象怎么找到模型数据：`FUN_14021ad10`【确】
```c
v = json["model"];                                   // 工厂已保证是 string / int / uint / real / object（rea-p5-mesh 2.1）
switch (v.type) {
  case string: O->res = modelResByPath(ctx+0x1a60, v.asCString());   break;    // FUN_1401d5a40：文件路径
  case int: case uint: case real:
    id = (i32)jsonToInt(v);                          // FUN_140085f70：int/uint 取低 32 位，real 截断（cvttsd2si）
    it = ctx->modelData.find(id);                    // FUN_1401607e0：只查不插
    O->res = (it != end) ? (it->res->refcount++, it->res) : null;  break;
  default: O->res = null;                            // object：模型对象建出来但没有模型
}
if (O->res) { O->mdl = O->res + 0x10; ctx->listeners[O->res].push(FUN_140225410 绑定 O); O->listenerId = ++ctx+0x1c80; }
buildMaterialsAndDraws(O);                           // FUN_140224c70：mdl 为空时直接返回
```
- **token 只能是数字**：字符串（包括 `"5"`、`"MODL:5"` 一类）都当文件路径读，读不到就是没有模型的图层【确】。dll 侧把句柄序列化成什么，归 rea-p14-script.md；exe 只认 JSON 数字。
- 查不到的 id（已经释放、从没建过）：图层照样建出来、照样进对象表，不画、不参与命中（命中要求 `O+0x2e8` 非空），没有任何报错【确】。
- `createLayer` 同步：工厂里当场加载、当场建绘制记录（材质缓存命中或当场加载），所以当帧就画（同 rea-p6d-layers 第 3 节）【确】。

### 4.2 多个图层共用一份【确】
- 共用的：资源本身（网格记录、GPU 网格 = 同一组 D3D 缓冲、包围盒、命中盒）。所以一次 `applyData` 改了所有用它的图层。
- 各自的：引用（每个图层 +1）、监听项（`ctx+0x1c40` 里该资源下的链表项，编号在 `O+0x314`）、绘制记录（`O+0x2c0`，存 GPU 网格与材质指针）、包围盒拷贝（`O+0x2f8`）、变换 / 可见性等图层字段。

### 4.3 引用计数与真正释放的时机【确】
| 事件 | exe 动作 |
|---|---|
| `createModelData` | `refcount = 1`（脚本句柄） |
| 图层加载时按 id 找到 | `refcount += 1` |
| `destroyModelData`（`FUN_14018d8b0`） | 按 id 找；找到就 `refcount −= 1`；**到 0** 才 `FUN_1401d7af0` 释放、从 `ctx+0x1bf8` 删掉 id；没到 0 什么都不做，id 仍在表里 |
| 图层析构（`0x14021aa1f`–`0x14021ab65`） | 先从监听表摘掉自己（链表空了就删整个键），再看资源 `+0x234`：非 0 → `FUN_1401d6bb0(rm, id)`（同上：−1，到 0 释放并删 id）；0（mdl 文件）→ 按路径表 `rm+0x158` 释放 |
| 场景卸载 / 渲染器重置（`FUN_1401c3840`，调用点 `0x14017ee65`） | 遍历 `ctx+0x1c00` 链表，**不看引用计数**全部 `FUN_1401d7af0`，清表 |

- 所以 `destroyModelData` 之后、最后一个用它的图层 `destroyLayer`（rea-p6d-layers 第 5 节：帧尾真正删除）之前，GPU 数据一直在、图层照常画；最后一个图层删掉的那一刻才释放。
- 在这段时间里，exe 侧按 id 仍能 `applyData` / `replaceData` / `createLayer` 到它（会再 +1）；要不要拦归 dll【确：exe 无防护】。
- 重复 `destroyModelData`：exe 再减一次，可能在图层还用着时把它释放（之后图层析构会对已删的 id 查不到、跳过；但绘制记录里的指针已悬空）【推】。
- `FUN_1401d7af0`：析构 mdl 部分（`FUN_1402671a0`）、释放材质串缓冲、逐个删 GPU 网格（`ID3D11Buffer::Release`）与变形纹理、释放资源本身。

## 5. 模型层的绘制、剔除与命中（第 4 题）

### 5.1 `g_Color4` / `g_Alpha` / `brightness`【确】
- 绘制 `FUN_1402222a0` 在压模型矩阵之前写 `ctx+0x120 = ctx+0x124 = ctx+0x128 = ctx+0x12c = 1.0`（`0x140222807`–`0x14022282c`），即 `g_Alpha = 1`、`g_Color = (1, 1, 1)`、`g_Color4 = (1, 1, 1, 1)`，无条件。
- 模型对象的描述符表（`FUN_140227470` + 基类 `FUN_1401e0530`）没有 `alpha` / `color` / `brightness`（rea-p5-mesh 2.2），图层上没有存这三个值的地方；脚本对模型层写 `alpha` 落到哪里由 dll 决定（rea-p14-script.md），但 exe 绘制不读。
- 脚本建的与 mdl 的没有区别：绘制、材质构建都不读资源 `+0x234`（`xr.py` 扫 `+0x234` 的全部读点，没有一处在模型绘制 / 材质路径上）。

### 5.2 `g_ModelMatrix`【确】
- `M = 栈顶 · W`，`W = O->vt[0x80]() = FUN_1401850a0`：`W_parent · T · Rz·Ry·Rx · S`，`S` 含 `scale.z`（rea-p5-mesh 2.3）。`g_ModelMatrix = M`、`g_ModelMatrixInverse = M⁻¹`、`g_NormalModelMatrix` 是 M 的 3×3 各轴归一化（同 mdl）。
- 栈顶是模型矩阵栈 `ctx+0x30` 的顶（与视图 `+0x38`、投影 `+0x40` 分开），主 pass 里是根对象的视差平移（P5a：只是平移），没有视差时是单位阵，所以 `length(M · (0,0,1,0)) = |scale.z| · (父链的 z 轴缩放)`；Karin 的根部件没有父，等于 `scale.z`【推：视差只平移沿用 P5a】。
- `perspective`（`O+0x120` bit7）为真时临时换透视投影（`FUN_1401e5b60`），与 mdl 模型相同。

### 5.3 视锥剔除【确：`0x1402222db`–`0x140222770`】
- 门：`ctx+0x11c` bit0（场景加载时总置位）。
- 取 `O+0x2f8`（min）、`O+0x304`（max）——即创建时的包围盒——两角各乘 `W`（不含栈顶的视差），球心 = 两角中点，半径 = 两角距离的一半；单视图用 `FUN_1401e5a10`，多视图（阴影级联等）逐视图比六个平面，全部视图都在外才跳过。
- 没给包围盒时按 2.6 的缺陷算；空形状时是反向无穷，半径无穷，等于不剔【推】。

### 5.4 光标命中【确：沿用 rea-p6c-dispatch 3.4 并核对 `FUN_140185520`】
- 模型对象（类型 5）参与命中，`solid` 缺省为真；脚本建的模型层与 mdl 模型一样。
- 用 `mdl+0x1b8` / `+0x1c4`（同一个包围盒）做 slab，前提 `max.x > min.x`；P6c 已查明实际测的是模型空间的 `[0, max − min]`（起点多减了半尺寸）、不要求 `t ≥ 0`。不测三角形。
- 按住或左键变化的那一帧，`vt+0x88`（`FUN_140223810`）对没有骨骼的模型走 `0x140224519` 起的分支：逐条读 `mdl+0x1a0` 的命中盒记录，射线变进「`W` · 记录的 3×4」空间做 slab，命中的取序号十进制串（`FUN_140053e40`）写进事件 `+0x18`（骨骼名）。脚本模型数据恰有一条记录（2.1），所以骨骼名是 `"0"`。记录 `+0x0..+0x8` 存的是 `max − min`，P6c 把这一段读作半尺寸，照此这个盒子是真实盒子的两倍【记录内容确；几何解读推】。dll 是否把骨骼名交给脚本见 rea-p6c-script。

### 5.5 其它与 mdl 相同的行为【确，沿用 rea-p5-mesh】
- 一个模型数据的多个形状 = 一个图层里的多次绘制，按「不透明在前」不稳定排序（`FUN_140228440`）；所有形状都是 translucent / additive 时整个图层算半透明对象（`O+0x120` bit8）。
- 深度、剔除、混合按材质 pass（缺键 = depthtest / depthwrite / cullmode normal 都开），正交场景里一样（P5d）。
- `castshadow` 对模型缺省为开、`reflected` 缺省为真：开了阴影 / 反射的场景里脚本模型层也会进投射者 / 反射名单。

## 6. `general.precache`（第 5 题）【确：`0x140187d0a`–`0x140187e1c`，`FUN_140186c90` 内】
```c
general = root["general"];                                     // 0x140187452，键串 0x1404750e0
v = general["precache"];                                       // 0x140187d1c，键串 0x14048e5b0
if (v.type == arrayValue /*6*/)
  for (e : v)                                                   // jsoncpp 的 map 顺序 = 数组下标顺序
    if (e.type == stringValue /*4*/ &&
        _strnicmp(e.asCString(), "materials", strlen("materials")) == 0)   // FUN_1402c9e60，ASCII 不分大小写
      FUN_14014ff70(ctx+0x1630, e.asCString());                // 同步加载进材质缓存，返回值丢掉
```
- 前缀只比 `materials` 九个字符：`materials/x.json`、`MATERIALS\x.json`、`materialsX` 都算；`models/…`、`shaders/…`、纹理、声音等其它项**全部跳过**，exe 不读它们。
- 效果只有一个：材质（及其着色器、纹理）在场景构造时就进了 `ctx+0x1630`。之后 `createModelData`（2.5）与模型对象建绘制记录（`FUN_140224c70`）查缓存直接命中，省掉运行中的同步加载卡顿。没有引用、没有「只许用预载材质」的门，也不让 `createLayer` 变成异步或延后【确，有界：scene ctor 里只此一处读 `precache`，`FUN_14014ff70` 无副作用标志】。
- 表里没有的材质：第一次 `createModelData` 当场同步加载（会卡这一帧）；文件读不到或 json 失败 → 得到带 `error` 着色器的材质（错误 2 或建成功），这份坏材质留在缓存里，以后同一路径直接拿到它【确，2026-11-20 更正】。
- 缓存键区分大小写（`memcmp`），预载与后用的路径大小写不同时会各加载一份【确】。
- 来源：`ui/dist/scripts/scripts.js` 的更新日志 REV 4301「Added precache system for registerAsset.」，与 d.ts 说的 `registerAsset(file, true)` 一致：编辑器把这类资产写进 `general.precache`【推，编辑器侧没读码】。

## 7. 实测对照（2026-11-20）
测试工程 `ignore/p14/0/proj/p14-api`（生成脚本 `ignore/p14/0/make_api.py`）在用户常驻的 WPE 里跑了两轮，两轮都在 `init` 中途崩溃；实测记录见 [phase-14-model-data.md](phase-14-model-data.md) 的对照表与「两次崩溃」。已对上的：id 只在成功时分配、从 1 起连续（2.1、2.7）；码 3、7、9、10、11、12、13 的触发与 3.1 一致，变长报 7 不报 5；`applyData` 数组变短不报错（3.2）。下面是回 exe 读码查的两处（只读码与读转储，没碰 WPE）。新增导出：`1402671a0-mdlDtor.c`、`1401d5e20-modelResPartDtor.c`、`1401d5ca0-mdlCtor.c`、`14028af80-crtFree.c`、`14017ec63-renderer_reset_scene_then_modeldata.asm`、`140151a5f-material_error_shader_fallback.asm`。

### 7.1 Q1：释放模型资源有没有双重释放 —— **没有**
- **`FUN_1402671a0`（mdl 部分的清理）不释放 `mdl+0`**：开头两个循环只处理 `mdl+0xc0` 的 puppet 记录与每个网格的 `mesh+0x98`（HeapFree），然后 `*mdl = 0`（`*param_1 = 0`，只清零），再逐个析构网格记录里的向量并把各向量置空【确】。`FUN_1401d5e20`（资源成员的析构）只析构 `mdl+0x10..+0x200` 的向量与字符串，不碰 `mdl+0`【确】。所以脚本模型的材质串缓冲（`res+0x08`，与 `mdl+0` 同址）只由 `FUN_1401d7af0` 的 `free(res+0x08)` 释放一次。
- 其余成员也只释放一次：网格记录的子向量在 `FUN_1402671a0` 里析构后 `end = begin`，`FUN_1401d5e20` 再析构时是空向量；GPU 条目由 `FUN_1401d7af0` 逐个 `delete` 后 `end = begin`，再由 `FUN_1400efd70` 释放存储；`mesh+0x98` 对脚本模型恒为 0（建时 200 字节全清零）；mdl 构造 `FUN_1401d5ca0` 把所有成员清零，没有未初始化的指针会被释放【确】。
- **走到 `FUN_1401d7af0` 的全部场合**【确】：
  | 场合 | 位置 | 条件 |
  |---|---|---|
  | `createModelData` 报错 | `0x14018d3e6` | `*err != 0`（码 1 / 2 / 3） |
  | `destroyModelData` | `0x14018d975` | 引用计数减到 0 |
  | 图层析构 | `FUN_1401d6bb0` `0x1401d6c75`（由 `0x14021ab60` 调） | 引用计数减到 0；资源 id 为 0（mdl 文件）走路径表 `0x14021abef` |
  | 通用释放 `FUN_1401d5f10`（唯一调用点 `0x140224c54`） | id 非 0 转 `FUN_1401d6bb0`，否则路径表 `0x1401d5fdf` | 同上 |
  | 场景卸载 `FUN_1401c3840` | `0x1401c3c44` | 不看引用计数，表里剩下的全部释放，然后清表 |
  | `replaceData` | —— | **从不释放资源本身**；只释放：重建时的旧设备网格（`0x1401d6832`）、删形状时的设备网格 / 变形纹理 / `mesh+0x98`（`0x1401d6a15`–`0x1401d6a4a`）、形状数增长时的旧材质串缓冲（`0x1401d656a`） |
- **场景卸载**（关壁纸、换壁纸、关测试窗口都走渲染器重置 `FUN_14017eae0`）：先在 `0x14017ec73` 以删除标志 1 调场景 `G` 的析构（场景对象表里的模型层随之析构、各自 −1，只被图层持有的资源在这里释放并删 id），之后才在 `0x14017ee65` 调 `FUN_1401c3840` 释放表里剩下的（脚本持有、没 `destroyModelData` 的）并清表。两步按 id 查表，前一步删掉的 id 后一步查不到，后一步之后不会再有图层按 id 查，所以**场景卸载不会双重释放**【确：调用顺序；「场景析构销毁全部对象」是推】。
- **转储**：
  - 栈的 exe 一侧是场景构造 `FUN_140186c90` 在 `0x140187f82` 调 `FUN_140172830(SM, null)`（加载完对象后统一跑 `init`），`0x140172bd0` 经 `E->vt[0x40]`（`CallCallback`）进 dll。所以崩溃发生在场景脚本的 `init` 里，在 precache 之后【确】。
  - 被释放的地址：dll 帧 `0x1801154be`（运行时偏移 `+0x1154be`）在调 `operator delete` 前释放 `[rsp+0x60]` 处一个 `std::vector` 的缓冲，转储里读出 begin = end = `0x22420bdf4a0`、cap = `0x22420bdf4a8`，即一个 8 字节的小块，不是模型资源（0x250）、材质串缓冲（`n·256 + 9`）、网格记录或形状结构（0x130 的倍数）【确：转储】。这个 dll 函数属于哪个脚本 API 归 dll 侧（调用链 `0x1801155e6` → `0x180114ae1` → `0x1801154be`）。
  - exe 与 dll 的 CRT 用同一个堆（exe `DAT_1404e4ed0` 与 dll `0x181acd318`（运行时 `0x7ff93cd0d318`）处的句柄在转储里都是 `0x22390630000`）【确：转储】，所以坏块可能是任何一侧写坏的。
  - 转储只带数据段（`MiniDumpWithDataSegs`），堆内存不在里面，看不到坏块的邻居，也就认不出是谁越界写的【确】。
- **这组用例在 exe 里走过的路径上没有越界写**【确，有界：2.1 / 2.3 / 3.1 / 3.2 的每个写点按实际参数核过】：
  - 创建：材质串缓冲恰好 `n·256 + 9`、写满不越界；
  - `applyData` 就地上传：写的是 `Map` 出来的 D3D 缓冲，长度等于缓冲大小；源数组比容量短时是**多读** `vertexBytes − 新长度` 字节（S14d 多读 12 字节），不写；
  - S14p / S14s / S14t：形状数都是 1，材质串缓冲不重新分配，没有 3.4 的释放后使用。
  
  本次崩溃在 exe 侧找不到原因，dll 侧（尤其 `0x180114ae1` 一带是哪个 API、S11 一类空形状 / 删除标志、`WriteUtf8V2` 与 `RP` 的缓冲）要由 rea-p14-script 那边查。

### 7.2 Q2：不存在 / 超长路径为什么报 2 不报 1 —— **材质加载从不失败，坏材质用 `error` 着色器**
- `FUN_1401515b0` 一进来就 `new` 一个 0x318 字节的材质对象，最后无条件 `return` 它【确：`0x1401515b0` 开头、函数末尾；中间唯一的另一个 `return` 在 `int 0x29` 之后，不是真路径】。
- 读文件用 `FUN_1400d3f80`（打不开返回空串、不报错），jsoncpp 解析失败时打 `Material %s error: %s`（实测日志 `Material materials/p14_nope.json error: * Line 1, Column 1  Syntax error: value, object or array expected.` 就是这一句），然后拿空 JSON 照常初始化材质（`FUN_140154480`）【确】。
- 着色器槽 `material+0x1e0` 仍为空时，`0x140151a6b`–`0x140151a88` 换成 `FUN_1401a5c40(ctx+0x15a8, "error", 0)`；JSON 正常但着色器编不出来时，`FUN_1401a5c40` 内部也回退到 `"error"`（`0x1401a5c40` 尾部 `FUN_1401a7350(…, "error", 0)`）【确】。
- `error` 着色器是 WPE 自带的 `assets/shaders/error.vert` / `.frag`：顶点输入 `a_Position`（POSITION）、`a_TexCoord`（TEXCOORD），片元输出 `texSample2D(g_Texture0, v_TexCoord)`【确：文件】。
- 所以路径无效（不存在、超长被 dll 截到 255 字节后不存在、坏 JSON、空串）时：
  - 格式里没有 UV（S9c / S9d 用的 `[POSITION]`）→ 着色器检查找不到 TEXCOORD → **码 2**；
  - 格式里有 UV → **建成功**，图层用 `error` 着色器画（采样 `g_Texture0`，材质没给纹理时绑什么没查）【推：画面】。
- **码 1 实际什么时候出现**：只有 `FUN_14014ff70` 返回空（分配失败）或材质的着色器槽为空（连 `error` 着色器都建不出来，而那种情况下 `0x140151a8f` 先解引用空指针崩掉）。正常运行中**到不了**【推】。
- **失败结果留在缓存里**：`FUN_14014ff70` 把 `FUN_1401515b0` 的返回值（这个带 `error` 着色器的材质）用 `FUN_140151f40` 插进缓存，以后同一路径直接拿到它，不再读文件，直到缓存清空（场景重载）【确】。
- 超长路径：dll 把 `material` 按 UTF-8 写进 256 字节缓冲、截到 255 字节加 NUL（rea-p14-script 1），exe 只按 256 字节读，没有越界【确：exe 侧；截断归 dll】。

### 7.3 按读码会损坏堆或崩溃的操作（设计测试时避开）
| 操作 | 后果 | 依据 |
|---|---|---|
| `replaceData` 让形状数变多（材质串缓冲重新分配），之后同一次或以后的 `replaceData` 给旧形状传 `material` | 旧网格的材质指针指向已释放的缓冲：`_stricmp` 读、材质不同时 `memcpy` **写 256 字节进已释放的堆块**；监听重建绘制记录时也从那里读路径 | 3.4，`0x1401d6534`–`0x1401d657b`、`0x1401d667a`、`0x1401d66a5`【确：代码；后果推】 |
| 对同一个 token 调 `destroyModelData` 的次数多于「脚本那一份」，而图层还在用它 | 引用计数提前到 0，资源在图层底下被释放；之后每帧绘制、命中都读已释放的资源与设备网格（虚调用） | 4.3【推】 |
| `replaceData` 需要重建网格而该形状的格式是 0（dll 对没写 `vertexFormat` 的形状若填 0） | `mesh->format = 0`、stride 0，随后取余除零（`0x1401c2f7e` `div r10d`），异常 `c0000094`，不是堆损坏 | 3.4【推：取决于 dll 的填法】 |
| `applyData` / 就地上传时数组比建时短 | 从脚本给的源指针多读，跨进未映射页才会访问冲突；不写堆 | 3.2【确】 |

### 7.4 追问：m2 的 S14p → S14s → S14t 有没有写坏堆 —— **exe 侧没有越界写**
m2 建时：1 个形状、9 个 float、`POSITION`、`Uint16` 索引 3 个、两个缓冲都动态、材质 `materials/p14_pos.json`；材质串缓冲 `n·256 + 9 = 265` 字节，`materials[0]` 指向它的 `+9`。

- **`FUN_1401c2f10` 对网格记录只写 5 个字段**【确：`0x1401c2f4f` `+0x38` 格式、`0x1401c2f5f` `+0x3c` stride、`0x1401c2f6e` `+0x40` 顶点字节数，有索引时再写 `0x1401c3005` `+0x50` 与 `0x1401c3058` `+0x18`】：不碰 `+0x00` 的材质指针向量，也不按值重建整条记录；对 GPU 条目只写 `+0x00`、`+0x08`、`+0x0c`、`+0x10..+0x12`。材质指针在 `createModelData` 里建一次（`0x14018ce46` / `0x14018cf5f`，在 `shapeToMesh` 之后），重建时向量原样保留，所以不需要补；`FUN_1401d6400` 只给**新追加**的网格补指针（`0x1401d664d`，在 `shapeToMesh` 之前）。S14s 的 `materials[0]` 仍指向 265 字节缓冲的 `+9`。
- **逐步走**（dll 对没写的键：顶点 / 索引指针为空、格式 0、材质空串、动态标志假，按 rea-p14-script）：
  - S14p：需要的缓冲 265 ≤ 现有 265，不重新分配（`0x1401d6534`）；材质同名（`_stricmp`）不写；`floatCount 12 > 容量 9` → 重建：删旧设备网格，`FUN_1401c2f10` 写 `format 1 / stride 12 / 48 字节`，新形状没给索引 → **非索引**网格；新形状没给动态标志 → 两个缓冲变成 **`USAGE_IMMUTABLE`**；`CreateBuffer` 从脚本数组读 48 字节（数组正好 48 字节）；材质检查通过。没有越界写【确】。
  - S14s：材质不同 → `memcpy(buf+9, s->material, 256)`，写 `[9, 265)`，恰在 265 字节缓冲内；没有顶点 / 索引 / 格式 → 不重建、不上传。没有越界写【确】。
  - S14t：格式 `0x8001 ≠ 1` → 重建：`stride 12 + 16 = 28`，`84 % 28 = 0`，3 个顶点，非索引、`IMMUTABLE`，`CreateBuffer` 读 84 字节（21 个 float 正好 84 字节）；材质空串 → 跳过着色器检查。没有越界写【确】。
  - 三步里 exe 新分配的块：设备网格对象 0x50（写到 `+0x48`）、监听表节点 0x58 与哨兵 0x58、监听桶 0x100（只在 S14p 第一次更新 m2 时建），写入都在块内【确】。
- **S14t 之后留下的、不会写坏堆的问题**【确：代码；后果推】：m2 从 S14p 起已不是动态的，之后 `applyData` 只会报 7；`mesh+0x50`（6）、`mesh+0x18` 与 `gpu+0x0c`（0）是旧值，非索引网格不用它们；S14s 换成 `p14_color` 时不做着色器检查（检查只跟着重建走），若在 S14t 之前给 m2 建图层，`a_Color` 在格式里没有，绘制时输入布局可能建不出（未查清 4），属于画面问题。
- **与转储对照**【推】：被检测的是 8 字节块（LFH 里每块 16 字节的那一档），能写坏它块头的通常是同一档里紧挨在前面的 ≤ 8 字节块被越界写，或经悬空指针写进同一档的已释放块。S14p–t 在 exe 里分配的块最小 0x50、写入都不越界，没有一块在这一档。这处损坏不是这三步的 exe 侧造成的；应在 dll 侧找小块（例如 1–2 个元素的 `std::vector`、短字符串）的越界写或释放后使用，例如 `0x180114ae1` / `0x1801154be` 所在的 API 本身。
- **哪些 `replaceData` 序列会写坏堆**【确：代码；后果推】：只有让形状数**变多**的 `replaceData`。它把 265 字节缓冲换成更大的，旧网格的 `materials[0]` 仍指向已释放的旧块；之后同一次调用或以后的 `replaceData` 给这些旧形状传了不同的 `material`，就会 `memcpy` 256 字节进已释放的块。监听重建绘制记录时也从旧块读路径，这一步只读不写。形状数不变或变少的序列，包括 m2 这种单形状的 S14p → S14s → S14t，按读码不写坏堆。

不会损坏堆的（按读码可以放心跑）：exe 侧报错的 `createModelData`（码 2 / 3 及其它）、`destroyModelData` 减到 0（没有图层在用时）、图层析构、场景卸载（关窗、换壁纸）、`applyData` 的各种报错（码 4–13 都在写之前返回或只写 `*err`）。

---

## 对实现的含义
- 模型数据就是「内存里的 mdl」：格式掩码直接复用 `compile/mdl.ts` 的 26 位表与表序交错，stride = 各项字节和，顶点长度按 float 个数、要求是 stride 的整数倍；索引 `Uint16` 优先，没有索引就 `draw(顶点数)`；永远三角形列表。
- 材质每个形状一个、不加 COMBO，`skin` 无视；`g_Color4` 等固定 1，图层的 `alpha` / `color` / `brightness` 不进着色器；`g_ModelMatrix` 就是图层世界矩阵（含 `scale.z`）乘视差平移。
- `applyData` 当场拷贝、当帧生效；拷贝按建时容量整块、绘制数按这次的索引数（有索引时）。WebGPU 侧照「调用时拷一份、`writeBuffer` 整块（多余部分保持旧值或补 0 都不影响画面，绘制数只到这次的索引数）」即可；无索引网格 `applyData` 后绘制数变成 1/4 的缺陷要不要照抄，按语料再定（语料没有）。
- `replaceData` 重建后要让所有用它的图层换网格；包围盒保持创建时的值。
- 包围盒：给了就用；没给就按「整段 float 当 xyz 三元组」算（影响剔除与命中，不影响画面里的顶点）。命中用 `[0, max − min]`（沿用 P6c 的实现）。
- 引用计数：脚本句柄一份 + 每个图层一份，`destroyModelData` 只减脚本那份；最后一个图层删掉才释放；场景卸载全释放。
- `general.precache`：只需在加载时把 `materials` 开头的项预编进程序缓存，不改变语义，能力表不该再报它。

## 建议实测（对应 0c）
1. **格式**：生成工程四种格式各一个三角形，着色器把每个属性编码成颜色输出；预测与「表序交错、POSITION 0x1 / NORMAL 0x2 / TANGENT4 0x4 / TEXCOORD 0x8 / COLOR 0x8000」一致。再让着色器声明 `a_TexCoordC1` 而格式只有 UV：预测 `createModelData` 不报错（只比语义名），画面上 TEXCOORD1 读到什么看 D3D 输入布局（未查清 4）。
2. **无索引 + `applyData`**：格式 `[POSITION, UV, COLOR]`、无索引、动态，建 6 个顶点两个三角形，然后每帧 `applyData({ vertexBuffer })`：预测第一帧后只画 `54 / 36 = 1` 个顶点（即什么都不画）。
3. **短数组**：有索引、动态，`applyData` 传一个更短的 `indexBuffer`（前半）：预测只画这几个三角形；传更短的 `vertexBuffer`：预测不报错、绘制数不变。
4. **包围盒缺省**：不给包围盒、位置在 (1000, 1000) 附近的四边形，`origin` 移到画面外边缘：预测比按真实位置算的更早被剔掉 / 更晚（盒子含原点附近）；光标在原点附近点击时也会命中（`[0, max − min]`）。
5. **生命周期**：`destroyModelData` 后图层仍画；再 `applyData` 照样生效（若 dll 不拦）；`destroyLayer` 最后一个图层后，`createLayer({ model: 同一句柄 })` 不画。
6. **`replaceData` 增长形状数**：1 个形状 → 2 个形状（缓冲从 265 字节涨到 521 字节）；看日志 / 画面是否异常（3.4 的释放后使用，可能材质路径变乱码而退回 error 着色器）。
7. **precache**：同一工程 `precache` 去掉某个材质，第一次建层那一帧的帧时间变长、画面相同。
8. **alpha / scale.z**：同一份模型数据两个图层，`alpha 0.2` / `color "1 0 0"` 对画面无影响；`scale.z = 0.5` 时着色器读到的 z 轴长度 0.5。

## 未查清
1. **JS 常量到格式位的换算**：exe 只拿到掩码；`IModelData.POSITION` 等的值、dll 把 `vertexFormat` 数组怎么拼成掩码、是否允许 0x1 以外的位置属性，见 rea-p14-script.md。本文只能说宽度对得上。
2. **「延迟回调里替换会死锁」**：exe 侧更新路径无锁、无跨线程（3.5）。是 dll 里的锁 / 回调排队、3.4 的释放后使用，还是作者遇到的别的崩溃，静态上分不出来。
3. **dll 对 `S` 的填法**：`applyData` / `replaceData` 时没给的字段是不是填 0 / 空串（3.1 依赖「格式 0 = 不改、材质空 = 不改、`indexCount` 0 = 不改绘制数」）；`replaceData` 里没写 `vertexFormat` 的形状若填 0 且需要重建，会除零（3.4）。`+0x24` / `+0x12c` 两个标志对应 JS 的哪种写法（`indexBuffer: null`、数组里放 `null`）也归 dll。
4. **着色器多读属性**：检查只比语义名，语义号对不上（如 TEXCOORD1）时 `CreateInputLayout` 是否失败、失败后画不画，没读（与 rea-p5-mesh 1.4 的同一未知）。
5. ~~材质缓存的失败项~~：已查清（「实测对照」Q2）：返回带 `error` 着色器的材质并留在缓存里。
6. **命中盒记录的几何**：`mdl+0x1a0` 记录在无骨骼分支里怎么变换、`+0x0..+0x8` 是半尺寸还是全尺寸，只按 P6c 的读法推了（5.4）。
7. **id 计数器的初值与是否随场景重置**：`ctx+0x1c38` 在 `FUN_1401c3840` 里不清零，构造时的初值没找（只影响 id 的绝对值）。
8. ~~`FUN_1402671a0` 对 `mdl+0` 的处理~~：已查清（「实测对照」Q1）：只清零、不释放，没有双重释放。
9. **2026-11-20 两次崩溃的真正出事点**：exe 侧的释放路径排除了，exe 在这组用例走过的路径上也找不到越界写；转储只有数据段、没有堆内存，坏块的邻居和写坏它的人看不出来（「实测对照」Q1 末）。
