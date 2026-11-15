> 逆向原始记录，代理写的，地址按 Ghidra（基址 0x140000000）。只读码，没运行 WPE。「抓帧」指主会话转来的 RenderDoc 常量（`ignore/p13/out/wpe-p13d-*-consts.json`），本代理只用它做对照与 float32 复算，没有自己抓帧。前作 [rea-p13-passes.md](rea-p13-passes.md) 第 2 节已证的地址与结论不再重复，这里只补 R1–R6 与主会话转来的点光偏移。

# WPE 2.8.42 P13d 阴影补充读码：生成器、槽位、级联矩阵、图集打包、投射变体、fur 实例

**概括**

- **生成器把每盏灯展开成一个独立块**（`{ const uint i = <n>u; … }`），没有 `for` 循环。灯的块按「点光（带阴影的在前）→ 聚光（阴影+cookie、cookie、阴影、普通）→ 管光 → 平行光（带阴影的在前）」生成；同类里带阴影的灯占数组的**前几个槽**，`g_LFeature_ShadowPoint*[i]` 与 `g_LPoint_*[i]` 用同一个下标【确】。`worldPos` 是 `PerformLighting_V1` 的参数，各着色器传 `v_WorldPos`【确：着色器】。
- **平行光级联的下标有 WPE 自己的错**：第 k 盏带阴影的平行光生成 `p1 = B + k`、`p2 = B + k + 1`、`p3 = B + k + 2`（B = 聚光占的投影矩阵数），而 CPU 按每盏 3 个连续槽写（第 k 盏在 `B + 3k … B + 3k + 2`）。只有一盏时两边一致；两盏以上时第 2 盏起读错矩阵【确：生成器 `0x14016ae36` `r13 = r13 + 1`；CPU `0x1401929d4` 每级 +1 槽】。
- **灯光 uniform 缓冲 = 生成器的声明顺序**：`LPoint{Color,Origin}`、`LSpot{Color,Origin,Direction,Exponent}`、`LTube{Color,OriginA,OriginB}`、`LDirectional{Color,Direction}`、`ShadowProjection[N]`、`ShadowProjectionTransform[N]`、`ShadowPointProjection[PS]`、`ShadowPointProjectionTransform[PS]`；带阴影的灯写进本类的槽 0 起，普通灯从槽 `PS`（或 `DS`）起【确】。
- **灯排序 `FUN_140186990`**：按（类型升序，`light+0x2c4 & 3` 降序，`dot(局部 origin, g_ViewForward)` 升序）的 `std::sort`。所以点光 / 平行光里 `castshadow` 的排在前面，聚光按「阴影+cookie(3) → cookie(2) → 阴影(1) → 普通(0)」，正好对上生成器的块顺序【确】。
- **平行光级联的视图矩阵**：相机放在防抖后的中心 e，看向**灯的局部 +X**，up = 灯的局部 +Y；`V` 的三列 = 快速倒数平方根归一化的（局部 Z、局部 Y、−局部 X），平移 `−(列·e)`。防抖用 C 的 `fmodf`（向零截断，结果与被除数同号）。全程 float32。用这套算式复算 `dir` / `dir-high` / `dircd` / `dirb` 四组抓帧的三级 `g_LFeature_ShadowProjection`，平移与投影项逐位相同，余下的 1–2 ULP 只在由角度算的灯朝向上（我的三角函数是 double）；把 `fmod` 换成向下取整就差 0.0078【确：码 + 抓帧复算】。`FUN_14017e910` = 场景标志 `G+0xe0` bit3 = 正交场景（与渲染标志 bit10 同源，`0x140187602`–`0x14018768a`）【确】。
- **点光阴影 pass 的深度偏移不是 0**：画阴影用的投影把 `P[3][2]` 先加 `−0.00333f`（`0x1404929a8` = `0xbb5a3c21`）再乘六个视图（`0x140193b4c`），所以每个视图 `VP[3][2]` 比 uniform 推算的少 0.00333；uniform `g_LFeature_ShadowPointProjection` 取的是未改的 `light+0x338`。三组抓帧（po / pp / ppls）的 `VP[3][2]` 按 float32 逐步复算**逐位相同**。非点光仍是 `VP[3][2] −= 0.0005f`（`0x14019632a`），`dir-low` 抓帧 uniform 0.5109015703 与阴影 pass 0.5104015469 差 0.0005【确】。**更正 rea-p13-passes 2.3「点光视图不做偏移」。**
- **图集打包**：条目按（点光优先，再按方块边长降序）`std::sort`（≤ 32 个时是稳定的插入排序），用宽 8192 的条带逐个放：同一边长时就是**一行从左到右，每行 8192/S 块，满了换下一行**。复用条件 = 条目数相同且排序后每块边长相同。**「只扩不缩」不准确**：现有 RT 两边都够就不动（可以比需要的大），任一边不够就**整张改成恰好需要的 (W, H)**，另一边可能变小；`AtlasTransform` 按 RT 的实际尺寸除【确】。`multi-ultra` 抓帧 5 块排成 5120×1024，变换 `x = 0, 0.2, 0.4, 0.6, 0.8` 与此一致。
- **投射变体**：`ctx+0x15a8` 是按着色器名索引的着色器信息表，表项 `+0xb0` 是预处理器从 `// [PASS] shadow <名>` 解析出的名字（`0x14016de6f`），查不到或为空用 `shadowcaster`。变体 = `materials/util/shadowcaster.json` 换着色器名，**COMBO 只取投射着色器自己声明的那几个**，值从基础材质的 COMBO 表取（没有就 0）；基础材质 blending = alphatocoverage（3）时另加 `ALPHATOCOVERAGE = 1` 并把变体 blending 也设成 3。纹理按 `{"material": 键}` 对槽（如基础 `g_Texture5 morph` → 投射 `g_Texture1 morph`、`albedo` → `g_Texture0`），常量按名字 / 键逐个拷值。剔除、深度等其余状态来自 `shadowcaster.json`（全缺省），**不继承基础材质的 `cullmode`**【确：码；推：表项字段名】。
- **fur4**：程序的 `INSTANCECOUNT` COMBO 非 0 时程序标志置 0x20、`+0x1f` 记实例数（`0x1400d5abc`），主 pass 绑材质时 `dev+0x150(INSTANCECOUNT)`，画 N 个实例做 N 层壳（实例 i 沿法线推 `i/(N−1)·g_FurDistance·albedo.a`）。阴影 pass 走 `shadowcasterfur4`：不声明 `INSTANCECOUNT`、不读实例号做偏移、片元空，**只投基础网格一层**；实例号只用来选视图。`foliage4`、`chroma4` 主 pass 没有额外 pass 或实例，全仓只有 `fur4` 用 `INSTANCECOUNT`【确】。

**命名**（沿用 rea-p13-passes 的 `R`、`G`、`ctx`、`dev`）

- `B`：灯光 uniform 缓冲 `G+0x348`（float 数组，每帧 memset 0，`0x140190de9`）。
- 灯数（`lightconfig` 位字段 `ctx+0x121c`）：`P`/`S`/`T`/`D` = point/spot/tube/directional（各 4 位，bit0/4/8/12），`SS`/`SC`/`SSC`/`DS`/`PS` = spotshadow / spotcookie / spotshadowcookie / directionalshadow / pointshadow（各 2 位，bit16/18/20/22/24）。`N = SC + 3·DS + SS + SSC`。
- 灯对象：`light+0x2c0` 类型（0 点、1 聚、2 管、3 平行），`+0x2c4` bit0 castshadow、bit1 usecookie，`+0x128..0x130` 局部 origin【推：同 P5d 透明排序键】，虚函数 `+0x80` 取世界矩阵（行向量约定，行 0/1/2 = 局部 X/Y/Z 轴，行 3 = 平移）。
- 阴影条目（0x60 字节）：`+0x00` 灯、`+0x08` 视图投影（点光是投影）、`+0x48` 方块边长 S、`+0x4c/+0x50` 方块左上角、`+0x54` bit0 是点光、`+0x58` 指向本条 `…Transform` uniform 槽。

---

## R1 生成器 `FUN_140169140` 的阴影分支【确】

### 1.1 入口与宏

只认名字 `LightingV1`（`0x1401691f5`）且宏 `LIGHTING` 非 0（`0x140169223`）。然后读 9 个宏（`0x14016926f`–`0x140169535`）：`LIGHTS_POINT`、`LIGHTS_SPOT`、`LIGHTS_TUBE`、`LIGHTS_DIRECTIONAL`、`LIGHTS_SPOT_SHADOW_COOKIE`、`LIGHTS_SPOT_SHADOW`、`LIGHTS_SPOT_COOKIE`、`LIGHTS_DIRECTIONAL_SHADOW`、`LIGHTS_POINT_SHADOW`。不看 `LIGHTS_SHADOW_MAPPING`。

### 1.2 声明顺序（只在计数非 0 时声明）

| 顺序 | 条件 | 声明 |
|---|---|---|
| 1 | `P > 0` | `vec4 g_LPoint_Color[P]`、`g_LPoint_Origin[P]` |
| 2 | `S > 0` | `g_LSpot_Color[S]`、`_Origin[S]`、`_Direction[S]`、`_Exponent[S]` |
| 3 | `T > 0` | `g_LTube_Color[T]`、`_OriginA[T]`、`_OriginB[T]` |
| 4 | `D > 0` | `g_LDirectional_Color[D]`、`_Direction[D]` |
| 5 | `N > 0`（`0x140169a1e`：`SC + 2·DS + DS + SS + SSC`） | `mat4 g_LFeature_ShadowProjection[N]`、`vec4 g_LFeature_ShadowProjectionTransform[N]` |
| 6 | `PS > 0` | `vec4 g_LFeature_ShadowPointProjection[PS]`、`…PointProjectionTransform[PS]` |
| 7 | 总是 | 函数头 `vec3 PerformLighting_V1(vec3 worldPos, vec3 color, vec3 normal, vec3 viewVector, vec3 specularTint, vec3 ambient, float roughness, float metallic)`，`light = 0` |

各灯数组的长度是**本类总数**（含带阴影的），不是减去阴影后的数。

### 1.3 块的生成顺序与下标

所有块的形状都是 `{`、`const uint i = <n>u;`、若干行、`}`。下标 `<n>` 用十进制。

| 段 | 循环 | 块内容（公式，非原文） |
|---|---|---|
| 点光·阴影 | n = 0 … PS−1（`0x140169bd0`–`0x140169d25`） | `L = Origin[i].xyz − worldPos`；`pc = CalculateProjectedCoordsPoint(worldPos, Origin[i].xyz, ShadowPointProjection[i], ShadowPointProjectionTransform[i])`；`sf = PerformPointShadowMapping(pc)`；`light += ComputePBRLightShadow(…, Color[i], Origin[i].w, …, sf)` |
| 点光·普通 | n = PS … P−1（从阴影段结束处续，`0x140169d42`） | 同上去掉投影，最后参数 `1.0` |
| 聚光·阴影+cookie | n = 0 … SSC−1 | `L`；`pc = CalculateProjectedCoords(worldPos, ShadowProjection[i])`；`sf = PerformShadowMapping(pc, ShadowProjectionTransform[i])`；`cookie = texSample2D(COOKIE, pc.xy).rgb`；颜色乘 `cookie`，传 `sf`。**没有锥角衰减** |
| 聚光·cookie | 续 SC 个 | `L`；`pc`；`cookie`；颜色乘 `cookie`，传 `1.0` |
| 聚光·阴影 | 续 SS 个 | `L`；`cone = −dot(normalize(L), Direction[i].xyz)`、`cone = smoothstep(Direction[i].w, Origin[i].w, cone)`；`pc`；`sf`；颜色乘 `cone`，传 `sf` |
| 聚光·普通 | 续到 S−1 | `L`；`cone`；颜色乘 `cone`，传 `1.0` |
| 管光 | n = 0 … T−1 | `L = PointSegmentDelta(…)`；传 `1.0` |
| 平行光·阴影 | k = 0 … DS−1（`0x14016a5a0`–`0x14016ae42`），`i = k` | 见 1.4 |
| 平行光·普通 | n = DS … D−1 | `ComputePBRLightShadowInfinite(normal, Direction[i].xyz, …, Color[i].rgb, …, 1.0)` |
| 收尾 | | `return light;` |

聚光三种带投影的块用 `ShadowProjection[i]` / `…Transform[i]`，i 就是聚光自己的下标，所以聚光投影槽 = `[0, SSC + SC + SS)`。

### 1.4 平行光·阴影块（第 k 盏）

基址 `B0 = SSC + SC + SS`（`0x14016a2e7` `r13 = ebx`）。生成三个常量：`p1 = B0 + k`、`p2 = B0 + k + 1`、`p3 = B0 + k + 2`（`0x14016a9b4`、`0x14016abb0`），每盏结束 `r13 = r13 + 1`（`0x14016ae36`）。块内顺序：

```
c1 = CalculateProjectedCoordsCascades(worldPos, ShadowProjection[p1])   // vec4，w = 「越界」
c2 = …[p2]
c3 = …[p3]
c1.xyz = mix(c1.xyz, c2.xyz, c1.w)        // 越出第 0 级 → 用第 1 级
c1.xyz = mix(c1.xyz, c3.xyz, c2.w)        // 越出第 1 级 → 用第 2 级（注意看的是 c2.w，不看 c1.w）
T      = mix(ShadowProjectionTransform[p1], …Transform[p2], c1.w)
T      = mix(T, …Transform[p3], c2.w)
sf     = max(c3.w, PerformShadowMapping(c1.xyz, T))   // 三级都越界 → 1（受光）
light += ComputePBRLightShadowInfinite(normal, Direction[i].xyz, viewVector, color, Color[i].rgb, …, sf)
```

`c.w`（`common_pbr_2.h`，`REVERSEDEPTH`）= `|x| ≥ 0.99` 或 `|y| ≥ 0.99` 或 `z ≤ 0.01` 时为 1，否则 0（`step(1, …)` 对三个 step 求和）。`c.w` 只取 0 或 1，所以两次 `mix` 是选择，不是插值。第二次选择只看 `c2.w`：一个点在第 0 级内（`c1.w = 0`）但在第 1 级外（`c2.w = 1`）时会被换成第 2 级的坐标。缺省参数下第 0 级的方块几乎都落在第 1 级内，实际很少发生【推】。

**多盏平行光阴影的下标错误**：CPU 侧每级用一个连续槽（1.4 与 R2），第 k 盏写在 `B0 + 3k + c`，着色器读 `B0 + k + c`。`DS = 1` 时一致；`DS = 2` 时第 2 盏读的是第 1 盏的第 1、2 级和自己的第 0 级，`DS = 3` 第 3 盏读 `B0+2 … B0+4`【确：两侧都读到了；没实测画面】。

### 1.5 等价伪代码（Rust 风格，按公式另写）

```text
fn lighting_v1(c: Counts) -> String:
  decl(P, [LPoint_Color, LPoint_Origin]); decl(S, [LSpot_Color, LSpot_Origin, LSpot_Direction, LSpot_Exponent])
  decl(T, [LTube_Color, LTube_OriginA, LTube_OriginB]); decl(D, [LDirectional_Color, LDirectional_Direction])
  N = SC + 3*DS + SS + SSC
  if N > 0: decl_mat4(N, ShadowProjection); decl(N, ShadowProjectionTransform)
  if PS > 0: decl(PS, ShadowPointProjection); decl(PS, ShadowPointProjectionTransform)
  header()
  for n in 0..PS:       block(n, point_shadow(n))      // 槽 n、点光阴影 n
  for n in PS..P:       block(n, point_plain(n))
  s = 0
  for _ in 0..SSC:      block(s, spot(s, proj=s, cookie, shadow)); s += 1
  for _ in 0..SC:       block(s, spot(s, proj=s, cookie));         s += 1
  for _ in 0..SS:       block(s, spot(s, proj=s, cone, shadow));   s += 1
  base = s
  for n in s..S:        block(n, spot(n, cone))
  for n in 0..T:        block(n, tube(n))
  for k in 0..DS:       block(k, dir_cascades(k, p = base + k + [0,1,2]))   // 照抄 WPE 的 +k
  for n in DS..D:       block(n, dir_plain(n))
  "return light; }"
```

我们的翻译器现在用 `for` 循环，改成逐灯展开或保留循环都等价；关键是**下标规则**与**段顺序**（决定浮点累加顺序：`light +=` 的先后照这个顺序）。

---

## R2 灯光 uniform 缓冲与槽位【确】

### 2.1 段指针（`0x140190d29`–`0x14019105c`，单位 float）

| 段 | 起点 | 大小 | 写入指针 |
|---|---|---|---|
| `LPoint_Color[P]` / `_Origin[P]` | 0 / 4P | 8P | 阴影 `[rbp+0x5b8]` = 0；普通 `[rbp+0x5b0]` = 4·PS（`Origin = Color + 4P`） |
| `LSpot_*[S]` ×4 | 8P | 16S | 阴影+cookie `rbx` = 8P；cookie `+4·SSC`；阴影 `+4·(SSC+SC)`；普通 `+4·(SSC+SC+SS)`（`[rbp+0x608/0x600/0x5f8/0x5f0]`） |
| `LTube_*[T]` ×3 | 8P+16S | 12T | |
| `LDirectional_Color[D]` / `_Direction[D]` | 8P+16S+12T | 8D | 阴影 `[rbp+0x128]` = 段首；普通 `[rbp+0x120]` = 段首 + 4·DS（`Direction = Color + 4D`） |
| `ShadowProjection[N]` | 之后 | 16N | 聚光阴影+cookie 0；cookie `[rbp+0x540]` = SSC；阴影 `[rbp+0x538]` = SSC+SC；平行光 `[rbp+0x530]` = SSC+SC+SS（每级 +1 槽，`0x1401929d4`） |
| `ShadowProjectionTransform[N]` | 之后 | 4N | 同上下标（`[rbp+0x568/0x560/0x558/0x550]`） |
| `ShadowPointProjection[PS]` | 之后 | 4PS | `[rbp+0x4d0]`，每条点光阴影 +1（`0x14019351a`） |
| `ShadowPointProjectionTransform[PS]` | 之后 | 4PS | `[rbp+0x4d8]`，同上 |

总大小（vec4 个数，`0x140190d54`）`= 5N + 2PS + 4S + 2D + 2P + 3T`，与上表一致。

### 2.2 写入规则

- 灯按 `G+0x1e0` 顺序遍历（已经过 2.3 的排序），跳过不可见的（含父链）。
- **点光**（`0x14019325f`）：`P` 余量为 0 就整盏跳过；`flag = (shadows 档 ≠ 0) && castshadow` 选指针，写 `Color = (rgb·intensity, light+0x2e8)`、`Origin = (世界位置, light+0x2ec)`，指针 +1 槽。之后**另判** `flag && PS 余量 > 0` 才生成阴影条目（余量 −1）。
- **平行光**（`0x14019111d`）：`D` 余量为 0 跳过；同样按 `flag` 选指针（阴影计数只减不判）。之后 `flag && N 余量 > 0`（`[rbp+0xd98]`，初值是 **N** 不是 DS，每盏 −1）才生成三级条目。
- 用完的平行光槽（阴影段和普通段各自剩下的）把 `Direction` 补成固定向量、`w = 0`，颜色保持 0（`0x1401931bb`、`0x140193530`）。

### 2.3 排序 `FUN_140186990`（`std::sort`，比较器内联在 `FUN_14019f360`）

每盏灯取 `{type = +0x2c0, flags = +0x2c4 & 3, key = dot(+0x128..0x130, ctx+0x160)}`，`less(a, b)` =
1. `a.type ≠ b.type` → `a.type < b.type`；
2. 否则 `a.flags ≠ b.flags` → `a.flags > b.flags`；
3. 否则 `a.key < b.key`。

排完写回 `G+0x1e0`（每帧原地重排）。`ctx+0x160` 是 `g_ViewForward`（R3 复算用它对上了抓帧）【确】。`std::sort` 在 ≤ 32 个元素时是插入排序（稳定），场景灯数到不了 32。

### 2.4 与生成器的对应、以及配置不一致时的怪行为

- 正常配置（`lightconfig` 的阴影灯数 = 实际 `castshadow` 的灯数）：排序让带阴影的灯先写，正好填满本类的前 PS / DS 槽，`ShadowPointProjection[i]` 就是 `LPoint[i]` 的；聚光的投影槽就是聚光槽；平行光第 0 盏的三级在 `B0..B0+2`。
- `castshadow` 的点光多于 `PS`：多出来的仍写阴影指针（越过 PS 进入普通段的槽），而普通灯从槽 PS 起写，**后写的覆盖先写的**（排序后普通灯在后，所以多出来的阴影灯被普通灯盖掉）；多出来的不生成阴影条目。平行光同理。
- 平行光的条目判的是 N 余量：`castshadow` 平行光多于 DS 但 N 还有余量时会多生成三级、写越过 `ShadowProjection[N]` 的末尾进入 `…Transform` 段。
- shadows 档 0（disabled）：所有灯 `flag = 0`，且解析期 PS = DS = 0，普通指针从槽 0 起，一致。

---

## R3 平行光级联的视图投影【确：码 + 抓帧逐位复算】

循环 `0x1401912a0`–`0x140192a0e`，每级 c = 0, 1, 2。全部是 float32 标量运算（`mulss`/`addss`/`divss`），除了 `fmod` 内部转 double（结果精确）。

1. `M` = 灯世界矩阵拷贝；`(a, b)` = `FUN_14025d370` 的第 c 级（前作 2.4）；`ha = a·0.5`、`hb = b·0.5`。
2. `L = normalize4(M.row0)`（`FUN_14019e5e0`：`sqrtss` 求长度、`1/len`、四个分量都乘，长度含 w²）。
3. `F = ctx+0x160`（`g_ViewForward`），`d = (F.x·L.x + F.y·L.y) + F.z·L.z`，`F' = F − (L·d)·0.5`（逐分量 `L[k]·d` 再 `·0.5`）。
4. `e.xy = F'.xy·ha + eye.xy`；`e.z = 正交场景 ? +0.0 : F'.z·ha + eye.z`（`FUN_14017e910` = `G+0xe0` bit3，正交；eye = `ctx+0x68`）。写进 `M.row3.xyz`。
5. 防抖（`0x14019152c`–`0x1401915e0`）：`Y = M.row1.xyz`、`Z = M.row2.xyz`（**未归一化**），`t = a / S`（a 不减半，S 是方块边长转 float）。先算 `dZ = dot(Z, e)`、`dY = dot(Y, e)`；`e −= Y·fmodf(dY, t)`；再 `e −= Z·fmodf(dZ, t)`（`dZ` 用的是减 Y 之前的 e）。`fmodf` 向零截断：坐标为负时中心往 0 方向退。
6. 视图（`FUN_14005f650` 拼 `K = [Z; Y; −X; e]`，`−X` 含 w 取反；`0x14019177d`–`0x140191bee`）：
   - `n0 = qnorm(Z)`、`n1 = qnorm(Y)`、`n2 = qnorm(−X)`，`qnorm` = `FUN_1400dc250`：`l2 = (x² + y²) + z²`，`y0 = asfloat(0x5f375a86 − (asuint(l2) >> 1))`，`r = (1.5 − ((l2·0.5)·y0)·y0)·y0`，结果 `v·r`。
   - `V[i][j] = n_j[i]`（i, j < 3），即 V 的第 j 列是 `n_j`；`V[3][j] = −((n_j.x·e.x + n_j.y·e.y) + n_j.z·e.z)`；`V[0..2][3]` 取 K 各行的 w（0、0、−0），`V[3][3]` 取 `M.row3.w`（1）。
   - 相机局部 −z = `−n2` = 灯局部 +X：**看向灯的 +X**（与 `g_LDirectional_Direction = −X` 一致），up = 灯局部 +Y。
7. 投影 `dev+0x18`（`FUN_14009a630`，参数 l = −ha、r = ha、b = −ha、t = ha、n = −hb、f = hb）：`m00 = 2/(r−l)`、`m11 = 2/(t−b)`、`m22 = −1/(n−f)`、`m30 = −(l+r)/(r−l)`（= −0）、`m31 = −(b+t)/(t−b)`（= −0）、`m32 = −f/(n−f)`（= 0.5）、`m33 = 1`，其余 0。深度 = `z_view / b + 0.5`，朝灯为正（离灯近深度大）。
8. `VP = V·P`，每行 `((V_i0·P0 + V_i1·P1) + V_i2·P2) + V_i3·P3`（先算 `t1 + t0`，再加 `t2`，最后加 `t3`，`0x140191f30`–`0x140191ff9`）。
9. 写 uniform `ShadowProjection[slot]`（渲染标志 bit0 时按转置写，`0x14019289d`）；条目里存同一份 VP；画阴影时拷到 `ctx+0xb30 + 64·i` 再 `VP[3][2] −= 0.0005f`（`0x14019632a`）。

复算脚本 `ignore/p13/rea/shadows/chk_dir.py`：用工程的角度 `(0, −0.3, −1.2)`、eye、`F = normalize(center − eye)` 与上面 1–8 步，四组抓帧（`dir-low`、`dir-high`、`dircd-low`、`dirb-low`）48 个值的最大差 2.98e-8（只在由角度算的轴分量上，1–2 ULP）；变异 `chk_dir_floor.py`（取模改向下取整）最大差 0.0078。

---

## 补充：点光阴影 pass 的 −0.00333（主会话转来的抓帧问题）【确】

视图循环 `0x140193a44` 起，点光条目分支（`entry+0x54` bit0）：

- `0x140193b06`–`0x140193b64`：从条目取投影 P（`light+0x338` 的拷贝），`P'32 = P32 + (−0.00333f)`（常量 `0x1404929a8`，位模式 `0xbb5a3c21`，即 float `−0.00333`）。
- 随后用 P' 与六个轴向视图逐个相乘，结果直接写进 `ctx+0xb30 + 64·i`（如 `0x140193c80` 写 `ctx+0xc70`）。乘法顺序同 R3 第 8 步。
- 点光分支直接 `jmp 0x14019636f`，**不走** `0x14019632a` 的 `−0.0005`。
- uniform：`light+0x320 = (P22, P32, P23, P33)` 取自未改的 `light+0x338`（`0x14019337e`–`0x140193472`），所以 `g_LFeature_ShadowPointProjection` 不带偏移。

于是每个面的 `VP[3][2] = tz·P22 + (P32 − 0.00333f)`（tz 是该面视图平移的 z 分量，±灯坐标），float32 逐步：`ignore/p13/rea/shadows/chk_pt.py` 对 po（1.8645819425582886 / 0.13009226322174072）、pp（0.051807843148708344 / 0.04178278148174286）、ppls（2.441114664077759）全部逐位相同。主会话差值里的 ±4e-6 来自预测值本身（例如 po 的 `1300·P22 + P32` float32 是 1.8679119，不是 1.8679161）。

| 灯 | 阴影 pass 用的 VP | uniform |
|---|---|---|
| 点光 | `S_face · (P with P32 −= 0.00333f)`（每面） | `(P22, P32, −1, 0)` 不偏 |
| 平行光 / 聚光 | `VP` 之后 `VP[3][2] −= 0.0005f` | `VP` 不偏 |

另：抓帧里同一帧不同绘制的 `g_ViewportViewProjectionMatrices` 顺序不同（po 的 event 28 是 `[−X, −Y, −Z, +X, +X, +X]`），即模型按自己的可见视图压紧了数组（rea-p5-mesh 4.4「只给可见视图发实例」）。视口数组是否跟着压紧没读到【未知，建议在 RenderDoc 里看该绘制的 RS 视口】。WebGPU 逐视图画时不需要压紧，但视锥剔除若要照做应按视图判。

---

## R4 图集打包（`0x1401935dc`–`0x1401939e8`）【确】

1. **排序**：`FUN_14019e660` = `std::sort(条目, cmp 0x140186c60)`，`cmp(a, b) = ((a.点光 << 15) + a.S) > ((b.点光 << 15) + b.S)`：点光在前，同类按 S 降序。≤ 32 个条目是稳定插入排序，同键保持生成顺序（即灯排序后的顺序、平行光的 c0 c1 c2）。
2. **复用**：上一帧布局 `G+0x408`（6 字节记录 `{u16 S, u16 x, u16 y}` 的 vector）。条目数相同且排序后逐个 S 相同 → 直接取记录的 x、y（`0x140193685`）。否则清空记录重排。
3. **重排**：空闲矩形表（8 字节 `{x0, x1, y0, y1}`），初值一条 `{0, 8192, 0, 0}`。每个条目（边长 S）依次试表里的矩形（表在循环中会追加，追加的也会被试到）：
   - 先 `y1 = max(y1, y0 + S)`（矩形向下长到至少 S 高，试过不放也保留这个增长）；
   - `x1 − x0 ≥ S` 且 `y1 − y0 ≥ S` → 放在 `(x0, y0)`，`x0 += S`，追加 `{x_old, x_old + S, y0 + S, y1}`（块下方的竖条），记录 `{S, x, y}`，换下一个条目；
   - 否则追加一条整宽条带 `{0, 8192, y1, y1}`，试下一个矩形。
   - 图集 `W = max(2, max(x + S))`、`H = max(2, max(y + S))`。
4. **结果**（所有条目同一个 S，因为 S 只看档位）：第 j 个条目放在 `((j mod K)·S, ⌊j / K⌋·S)`，`K = 8192 / S`（256 → 32、512 → 16、1024 → 8）。例：2 点光 + 1 平行光（5 块），low → x = 0, 256, …, 1024，图集 1280×256；ultra → 5120×1024（与 `multi-ultra` 抓帧的 `g_Texture6Texel = (1/5120, 1/1024, 5120, 1024)`、变换 x = 0, 0.2, … 0.8 一致）。
   - 第三行起算法有重叠的隐患（旧的整宽条带 `{0, 8192, S, S}` 还在表里，会把块放回第二行的开头）：要 `2K + 1` 个条目，1024 时是 17 个，点光 ≤ 3 + 平行光 ≤ 9 = 12 到不了；只有加上聚光才可能【确：按算法推演；未实测】。
5. **建 / 改 RT**：没有就按 (W, H) 建（`0x1401938d1`）；有且 `w < W` 或 `h < H` 时 `FUN_140161f40(W, H)` **改成恰好 (W, H)**，两边都够就不动。`AtlasTransform` 用 RT 实际的 `w`、`h`（`0x1401939e4`）。所以条目变少时图集不缩，变换的分母仍是大图；变多时一边可能缩小。**更正 rea-p13-passes 2.2「只扩不缩」。**

---

## R5 投射变体（`FUN_140155fc0`，阴影模式 `ctx+0x12eb = 0`）【确：码；推：表项字段名】

缓存：`material+0x300` 是按模式索引的 0x38 字节表，空时建变体（`0x1401561e2`）。

1. **选着色器**（`0x1401561ed`–`0x1401562b4`）：基础材质的程序名（`program+0xb0`）在 `ctx+0x15a8`（`std::map<名字, 着色器信息>`）里查，命中且表项 `+0xb0` 字符串非空 → 用它，否则 `"shadowcaster"`。`+0xb0` 来自预处理器对 `// [PASS] shadow <名>` 的解析（`0x14016de11`–`0x14016df0f`：匹配一个全局前缀串后跳空白、比 `shadow`、跳过这个词与空白，余下的就是名字）【确：解析；推：写进的是表项 `+0xb0`】。语料着色器只有 `chroma4` → `shadowcaster`、`foliage4` → `shadowcasterfoliage4`、`fur4` → `shadowcasterfur4` 三处注解。
2. **COMBO**（`0x1401562b9`–`0x140156497`）：再用投射着色器名查同一张表，遍历**投射着色器自己的 COMBO 列表**；每个名字在基础材质的 COMBO 表（`program+0x70`）里找，找到取值、找不到取 0，写进新表。所以：
   - `shadowcaster`：`SKINNING`、`MORPHING`、`MORPHING_NORMALS`、`BONECOUNT`；
   - `shadowcasterfoliage4`：再加 `LEAVESUVMODE`；
   - `shadowcasterfur4`：同 `shadowcaster` 四个，**没有 `INSTANCECOUNT`**。
   - 基础材质 blending（`material+0x1f0`）= 3（alphatocoverage）时再写 `ALPHATOCOVERAGE = 1`（`0x1401564a4`）。blending 枚举：0 normal、3 alphatocoverage（`0x14022523d` 不透明判断）。
3. **建变体材质**：`FUN_140150110(ctx+0x1630, "materials/util/shadowcaster.json", COMBO, 着色器名)`；基础 blending = 3 时变体 `+0x1f0 = 3`。投射着色器有材质常量时（`program+0x28` 非 0）另走 `FUN_140150770`，用 `{"shader": 名, "combos": {...}}` 生成一个本材质独占的变体（`0x140156b68`），以便各材质的常量值不串。变体的其余状态来自 `shadowcaster.json`（只有 `shader`），**`cullmode`、深度、混合都不从基础材质继承**（只额外拷了 blending 的 a2c）。
4. **纹理**（`0x140156683`–`0x140156af6`，绑定时 `0x140157050`）：两份程序的纹理表里 `+0x60` 字符串（`{"material": 键}`）相同的配对 `(基础槽, 投射槽)`，绑定时 `变体.纹理[投射槽] = 基础.纹理[基础槽]`。实际配对：`albedo`（基础 `g_Texture0` → 投射 `g_Texture0`，只在 `ALPHATOCOVERAGE` 时声明）、`morph`（基础 `g_Texture5` → 投射 `g_Texture1`）。
5. **常量**（`0x140156cb5`–`0x140156f62`，绑定时 `0x140157070`）：两份程序的常量 `std::map` 按键（字符串）对齐、类型（`+0xa8`）相同的记 `(基础偏移, 投射偏移, 字节数)`；基础材质 `+0x1f8` bit1（常量变了）置位时把这些常量拷进变体。foliage 的 11 个常量（`g_SpeedLeaves` … `g_FoliageUVBounds`）名字与 `material` 键两边都相同，所以不论键是哪个都能对上【推：键是名字还是 material 键】。`g_Time`、`g_ModelMatrix`、骨骼、`g_MorphOffsets/Weights` 是引擎 uniform，照常按变体自己设。
6. **ALPHATOCOVERAGE 在阴影 pass**：变体 blending = 3 → 阴影 pass 的混合状态带 A2C，但图集没有颜色附件；投射片元着色器在 HLSL 下只输出 alpha（`(a − 0.5)/max(fwidth(a), 1e-4) + 0.5`，`foliage4` 版用 `fwidth(a − 0.9)`，等价），GLSL 路径才 `discard`。单采样 RT 上 A2C 等价于 `alpha ≥ 0.5` 才写【推：D3D11 无 RTV 时 A2C 仍按 o0.a，建议实测】。`shadowcasterfur4.frag` 是空函数，`ALPHATOCOVERAGE` 不起作用。

---

## R6 fur4 的实例与其他专用着色器【确】

- **主 pass**：程序构造 `FUN_1400d5070` 里 COMBO `INSTANCECOUNT` 非 0 → 程序标志 `|= 0x20`、`+0x1f = INSTANCECOUNT`（`0x1400d5abc`）。普通模式绑材质时 `flags & 0x20` → `dev+0x150(+0x1f)` 设实例数（`0x140157106`–`0x140157128`），网格一次画 N 个实例。`fur4.vert`：`w = i / (N − 1)`（`gl_InstanceID`），`worldPos += worldNormal · w · g_FurDistance · albedo.a(lod 0)`；`fur4.frag`：`alpha = step(w, furMask) · g_TintAlpha`，`furMask` 取 `g_Texture8` 的 a（UV 乘 `g_FurDetail`），再 `ApplyAlphaToCoverage`。N 的选项 5 / 9 / 13 / 21（缺省 5）。
- **阴影 pass**：变体 `shadowcasterfur4` 不声明 `INSTANCECOUNT`（不继承，R5），程序没有 0x20 标志；而且阴影模式下绑定路径走变体分支，绕过 `0x1401570f8` 的实例数设置，实例数由 `FUN_140196530` 的 `dev+0x150(视图数)` 定。`shadowcasterfur4.vert` 的实例号只用来选视图矩阵与视口，不做毛发偏移，片元空 → **只投基础网格，不投毛发层**。
- **foliage4**：主 pass 单次绘制，顶点动画（`CalcFoliageAnimation`），没有实例或额外 pass；阴影变体 `shadowcasterfoliage4` 做同一份顶点动画（同名常量 + `LEAVESUVMODE`），所以影子随风动。
- **chroma4**：主 pass 单次绘制；阴影用通用 `shadowcaster`。
- 全仓着色器只有 `fur4` 用 `INSTANCECOUNT`，读 `gl_InstanceID` 的只有 `fur4.vert` 与三个投射着色器【确：grep】。混合 / 剔除都由材质 JSON 决定，引擎没有对这三种着色器的特殊分支【确，有界：`FUN_140155fc0` 与程序构造】。

---

## 对实现的含义

- **翻译器**：照 R1 的段顺序生成（点光阴影 → 点光普通 → 聚光四段 → 管光 → 平行光阴影 → 平行光普通），带阴影的灯用本类前 PS / DS 槽，点光阴影与 `ShadowPointProjection` 同下标，平行光三级 `p = B0 + k + c`（**照抄 +k**，`DS = 1` 时与正确写法相同；`DS ≥ 2` 照抄才和 WPE 一样）。声明顺序照 1.2；`N` 照 `SC + 3DS + SS + SSC`。
- **编译期**：灯按 R2.3 的比较器排序（类型、castshadow/usecookie 降序、`dot(局部 origin, g_ViewForward)` 升序），只是 `ViewForward` 每帧变、灯是编译期常量时排序结果也可能变；P13d 灯固定时建议每帧照排（或在 P13f 一起做），至少带阴影的灯排在前面必须做到。`castshadow` 灯数与 `lightconfig` 不一致的怪行为（R2.4）建议照报。
- **渲染器**：
  - 平行光级联照 R3 的 1–9 步 float32 逐步，`fmodf` 截断，快速倒数平方根归一化（`0x5f375a86` + 一次牛顿），每帧算；`chk_dir.py` 可直接改写成单测的期望值。
  - 点光阴影 pass 的投影用 `P32 − 0.00333f`，非点光用 `VP[3][2] − 0.0005f`；uniform 都不偏。
  - 图集：条目排序 + 一行 `8192/S` 块；RT 尺寸规则照 R4.5（不够就改成恰好、够就不动，变换按实际尺寸）。灯固定时尺寸只在加载时定一次。
- **投射变体**：COMBO 只传投射着色器声明的那几个（取基础值），a2c 另加；纹理按 `material` 键配对（`morph` 换槽）；常量按名字拷；剔除不看基础材质（一律缺省 → 前作 2.6 的「实际 none」，帧级剔正面时 front）。
- **fur4**：主 pass 画 N 层实例（P13d 之外的事，fur4 主 pass 若尚未支持要单列）；阴影只画基础网格一次。

## 建议实测

- **两盏平行光阴影**（`directional 2, directionalshadow 2`）：读 `g_LFeature_ShadowProjection[0..5]` 与接收者的阴影，预测第 2 盏的阴影用错级联（画面上第 2 盏的影子错位或缺失）。
- **castshadow 多于 pointshadow**：2 盏 castshadow 点光 + 1 盏普通点光、`point 3, pointshadow 1`，读 `g_LPoint_*`，预测槽 1 被普通灯覆盖。
- **图集缩放**：运行中隐藏一盏投影灯（条目数变），读 `_rt_shadowAtlas` 尺寸与 `AtlasTransform` 分母，预测不缩、分母仍是大图。
- **压紧的视图数组**：po 工程 event 28 一类绘制，看 RS 视口数组是否也按可见视图压紧。
- **A2C 投射者**：基础材质 `blending: alphatocoverage` 带透明孔的贴图，看图集里孔是否被挖掉（预测 alpha < 0.5 不写深度）。
- **fur4**：`INSTANCECOUNT` 5 与 21 各一，阴影 pass 每个视图实例数与图集内容，预测阴影不随层数变。

## 未查清

- `ctx+0x15a8` 表项的确切结构（`+0xb0` 是否就是注解名只由用法推出；字段写入点没追）。
- 常量配对的键是 uniform 名还是 `material` 键（`std::map` 的键，现有着色器两者一致）。
- 投射变体 a2c 在无颜色附件时的 D3D11 行为。
- 模型在阴影 pass 压紧视图数组时视口是否同步压紧。
- 聚光的投影（`FUN_14025d420` 类型 1）、cookie 的取样坐标与 `_alias_lightCookie`（语料 0 张，未读）。
- 平行光未用槽补的 `Direction` 固定值（`FUN_14005ec10(0, 1, 0)` 的参数含义没核，颜色为 0 不影响画面）。

## 对前作的更正

1. **rea-p13-passes 2.3**「点光视图的 VP 不做 2.5 的偏移」：点光有偏移，是投影 `P32 −= 0.00333f`（`0x140193b4c`），只是不是 `0.0005`；抓帧逐位证实。
2. **rea-p13-passes 2.2**「只扩不缩」：任一边不够时整张改成恰好的 (W, H)，另一边可能变小；两边都够时不动。
3. **rea-p13-passes 2.2**「打包算法是 skyline / shelf 一类」：具体是宽 8192 的条带 + 块下竖条，等边长时退化为逐行排列，见 R4。
4. **rea-p13-passes 2.4**「防抖 fmod 方向【推】、视图朝向【推】」：均已确认（截断、看向 +X、up = +Y），并有抓帧逐位复算。
5. **rea-p13-passes 2.8**「各段先后照生成器声明顺序【推】」：已确认，见 R2.1。

---

**元数据**

- 目标：`ignore/p9/rea/wallpaper64.exe`（同 rea-p13-passes，基址 0x140000000）。没运行、没附加 WPE，没改 Steam 目录。REA 这一轮没有用（汇编切片已足够，上一轮导入超时）。
- 方法：全量反汇编 `ignore/p4/rea/wp.asm` 按地址切片；常量用脚本读 exe；与主会话的抓帧常量做 float32 逐位复算。
- 工作目录 `ignore/p13/rea/shadows/`：
  - 脚本：从 `ignore/p13/rea/passes/` 拷来的 `slice.py`、`fn.py`、`xr.py`、`rd.py`、`strs.py`、`rng.py`、`pe.py`；新写的 `grepe0.py`（按正则找指令）、`chk_pt.py`（点光 `VP[3][2]` 复算）、`chk_dir.py`（平行光三级 VP 复算）、`chk_dir_floor.py`（取模变异）。
  - 汇编摘录 `asm/`：`gen_140169140.asm`（生成器）、`cascade.asm`（级联循环）、`point.asm`（点光写入与条目）、`pack.asm`（打包与建图集）、`views.asm`（视图与阴影 pass 调度）、`sort_140186990.asm`、`sortimpl.asm`（灯排序）、`matbind.asm`、`matbind2.asm`（投射变体）。
- 读的着色器与文件（只读）：`assets/shaders/` 的 `common_pbr_2.h`、`shadowcaster.vert/.frag`、`shadowcasterfoliage4.vert/.frag`、`shadowcasterfur4.vert/.frag`、`generic4.frag`、`genericimage4.frag`、`genericparticle.frag`、`chroma4.vert/.frag`、`foliage4.vert/.frag`、`fur4.vert/.frag`、`base/model_fragment_v1.h`；`assets/materials/util/shadowcaster.json`。抓帧常量 `ignore/p13/out/wpe-p13d-{po,pp,ppls,dir,dirb,dircd,multi}-*-consts.json`（经 `ignore/p13/d/ana/show.py`），工程参数取自 `ignore/p13/d/gen_d0.py`。
- 标记：【确】读到代码（或代码 + 抓帧逐位复算）；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过；【确：着色器】读 WPE 自带着色器原文。
