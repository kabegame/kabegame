> 逆向原始记录，代理写的，地址按 Ghidra（基址 0x140000000；scenescript64.dll 按 0x180000000）。只读码，没有实测。

# WPE 2.8.42 P13 灯、雾、sprite 对象与透视场景余项静态逆向

**概括**

- **遗留灯按「创建槽位」取，不按距离。** 每个灯对象（不分类型）在工厂里从 4 个槽里取第一个空槽，4 个都占了就取槽 0（`0x1401903e3`–`0x14019042c`）。之后每帧在对象更新里，`point` 灯（类型 5）把世界平移写 `g_LightsPosition[槽]`，把 `(color·intensity, radius)` 写 `g_LightsColorRadius[槽]`；隐藏（自身或父链）时颜色半径写 `(0, 0, 0, 1)`，位置照写（`FUN_14025d1f0`）【确】。空槽 `(0, 100, 0)` / `(0, 0, 0, 1)` 是渲染上下文构造函数的初值（`0x14017d649`–`0x14017d68f`），灯析构时也把自己的槽写回这两个值（`FUN_14025cf90`）【确】。多于 4 盏时第 5 盏起全部落在槽 0，同一帧里按 `objects` 顺序后写的覆盖先写的【确：代码；推：顺序等于 JSON 顺序】。
- **遗留灯与 V1 灯并存，但共用槽号。** V1 灯（`lpoint` 等）也占遗留槽（分配时不看类型），只是遗留写入函数只认类型 5；V1 计算只认类型 0–3【确】。`genericimage2` 读的不是 `g_LightsColorRadius`，而是 `g_LightsColorPremultiplied[3]`（颜色 × 半径²，第 4 盏的 rgb 拆进三个 w）【确】，总计划里「`generic` / `generic2` / `genericimage2` 读两个数组」要改。
- **雾 = 四个 uniform + 两个引擎宏。** `general.fog*` 的 14 个字段全部挂同一个改值回调 `FUN_140186440`，拷进渲染上下文：`g_FogDistanceColor`、`g_FogDistanceParams = (start, end − start, startdensity, enddensity − startdensity)`、`g_FogHeightColor`、`g_FogHeightParams`（同形）【确】。颜色原值、不换算、HDR 不乘。`FOG_DIST` / `FOG_HEIGHT` 只在材质加载时定义，条件是 general 开关为真**且**组合表里 `FOG` 非 0（着色器 `[COMBO]` 的缺省值会先并进组合表，`generic4` 等缺省 1）【确】。数值改动就地生效；开关在运行中改不触发重编，宏不变【推】。
- **灯光 uniform 每帧算。** V1：每帧在动画与脚本之后、渲染之前（`0x14018031a`）；遗留：每帧在对象更新里（`0x1401891f9`，动画与脚本之前）【确】。所以关键帧与字段脚本对 V1 灯当帧生效，对遗留灯晚一帧；用户属性对两者都是下一帧【推，按地址先后】。
- **灯的字段是普通描述符，能绑属性、挂关键帧、挂脚本。** 灯类表 `FUN_14025da80` 注册 `color`（vec3）、`intensity`、`radius`、`exponent`、`innercone`、`outercone`、`density`、`volumetricsexponent`、`cascadedistance0–2`、`lightsourcesize`（float）、`controlpoint`（vec3）、`light`（枚举）、`visible`、`castshadow`（`+0x2c4` bit0）、`usecookie`（bit1）、`castvolumetrics`（bit2）【确】。数值字段没有改值回调，逐帧读【确】。世界矩阵走基类 `FUN_1401850a0`，含父链；可见性走 `FUN_140185010`，沿父链【确】。
- **超配选灯的排序键补全了。** `FUN_140186990` 每帧把灯表排序（并写回表）：先按类型升序，再按 `flags & 3`（castshadow | usecookie）降序，最后按 `dot(局部 origin, g_ViewForward)` 升序；32 盏以内是稳定的插入排序【确】。V1 逐类型按这个顺序取前 N 盏可见的灯。
- **`sprite` 对象是「带遮挡测试的太阳光斑」，不是图像层。** 类型码 3、虚表 `0x140491680`，构造时建一个 4 顶点 6 索引的网格，四个顶点位置都是常量 `(−1, 0, 1)`、uv 为四角（`0x140256621` 起）；另加载 `materials/util/occlusiontest.json` 并建一个 D3D11 遮挡查询【确】。绘制（`FUN_140256780`）：取上一帧查询的样本数 n，`k = min(512 · ((n/2) >> s) / Hs², 1)`；临时把视图矩阵的平移清零（光斑只随相机转动、不随相机平移），`g_ViewUp` / `g_ViewRight` 乘 `2k`、`g_Alpha = k²`，画 sprite 材质；然后每帧一次把两个轴乘 `0.2`、开查询、用 `occlusiontest` 画同一个网格、关查询【确】。对象的 `origin` / `angles` / `scale` 不参与【确】。
- **抓帧里两次绘制的解释。** event 179 = 光斑本体（`k = 0`，两个轴为 0、四边形塌成一点，即上一帧查询结果为 0 或尚未可读）；event 194 = 遮挡测试（轴长 0.2、`occlusiontest.vert` 把 z 写成 1e−7）。`(−1, 0, 1)` 是 exe 里写死的顶点常量，`0.2` 是常量 `0x14049267c`【确】。
- **拼错的 `depthwriting` / `depthtesting` 完全不读**：exe 里 ASCII、UTF-16 都没有这两个串，材质 pass 只认 `depthtest` / `depthwrite`（`FUN_1401577e0`）【确】。ricepod 的 `orbital_*` 因此是「测深度（缺省开）、不写深度（additive）」【推，按 rea-p5-mesh 3.4 的规则】。
- **透视余项。** `transparentsorting` 的「相机前向」就是 `g_ViewForward = −V 第 2 列 = normalize(center − eye)`，键用对象自己的 `+0x128`（局部 origin，不含父链），降序（远的先画），插入排序稳定，`fullscreen` / `projectlayer` 键为 −∞【确】。文本 `_depth` 材质 = 测深度不写深度（translucent 压过 depthwrite）【确】。带子层的组合层在透视场景里，子层仍按 `inverse(W) + 单位视图 + ortho(±w/2, ±h/2, ±1000)` 画进合成 RT，没有按场景类型分支【确】。
- **材质小细节。** `combos` 的键在材质 pass 加载时逐字符 `toupper`（`0x140154595`），`lightmap` → `LIGHTMAP`【确】。`.tex` 不存在时：general 没有 `norecompile` 时 WPE 会在运行时用源图片 + `.tex-json` 重编 `.tex`（日志 `Recompiling texture: %S`），编好前用占位；有 `norecompile: true`（默认工程都写了）时不重编，加载失败，绑 6×6 黄黑棋盘格【确：两条分支与棋盘格；推：重编完成后的替换】。audiophile 的 grid 对象 `skin: 1`，用的是有 `.tex` 的 `grid2`，`grid.json` 运行时根本不加载【确：样本 + rea-p5-mesh 2.4】。

**命名**（沿用前几份）
- `R`：场景渲染器；`ctx = R+0x10`（对象里是 `obj+0xc8`）；`G`：场景 general 结构（`ctx = *(G+0xd8)`）。
- `ctx+0x118`：渲染标志字；`ctx+0x144`：帧计数；`ctx+0x160 / +0x16c / +0x178`：`g_ViewForward / Right / Up`（rea-p5-camera 8）；`ctx+0x120`：`g_Alpha`；`ctx+0x74 / +0x78`：后备缓冲宽高 Ws / Hs（float）。
- `obj`：场景对象；`+0x120` 对象标志（bit0 visible、bit8 半透明、bit9 fullscreen/projectlayer、bit11 castshadow）；`+0x128` 局部 origin；`+0x180` 父对象；`+0x80` 虚函数 = 世界矩阵。
- 灯对象 `L`（0x3a0 字节，虚表 `0x140491c38`）：`+0x2c0` 类型字节、`+0x2c4` 灯标志、`+0x2c8` 遗留槽号、`+0x2cc` color、`+0x2d8` controlpoint、`+0x2e4` intensity、`+0x2e8` radius、`+0x2ec` exponent、`+0x2f0` innercone、`+0x2f4` outercone、`+0x2f8` density、`+0x2fc` volumetricsexponent、`+0x300..+0x308` cascadedistance0–2、`+0x30c` lightsourcesize、`+0x330` cookie 纹理、`+0x378` 阴影资源。
- 一帧里的顺序（rea-p5-camera / rea-p10-keyframes 已列，这里只标本文用到的）：① `FUN_1401891a0` 对 `G+0x158` 每个对象调 `+0x48`（`0x1401891f9`）→ ② 算 `g_ViewForward / Right / Up`（`0x14018017e`–`0x1401802c7`）→ ③ 动画、脚本 `FUN_140171440`（`0x1401802e5`）→ ④ 泛光脏位 → ⑤ **V1 灯 `FUN_140190c80`（`0x14018031a`）** → ⑥ 绘制 → ⑦ 排队的用户属性（`0x140180d0c`）。

---

## 1. 遗留灯（`"light": "point"`）

### 1.1 槽位分配：工厂里定死【确】
- 工厂 `FUN_14018ff60` 的 `light` 分支（键值是字符串才建，`0x1401903b0`）：遍历场景里已建的灯表 `G+0x1e0..+0x1e8`，把它们的 `+0x2c8` 做成位图 `1 << 槽`（`0x1401903e3`–`0x1401903fd`）；取第一个空槽 0、1、2、3，**四个都占时取 0**（`0x14019042c` `mov r15d, r13d`）；写 `L+0x2c8`（`0x140190457`）。
- 分配时灯的类型还没解析（类型由之后的加载 `+0x40` 写），**所有类型的灯都占槽**。所以 `lpoint` 在前、`point` 在后时，遗留灯拿槽 1，槽 0 空着。
- 新灯推进灯表 `G+0x1e0`（`0x14019052f` / `0x14019054a`），并置 `obj+0x120 |= 0x100`（`0x140190510`，进半透明表），`r15b = 0`（不进反射名单）。
- 构造缺省（`0x140190457`–`0x1401904e4`）：类型 5（`point`）、标志 0、color 0、controlpoint `(2, 0, 0)`、intensity 0、radius 1、exponent 2、innercone 20、outercone 30、density 2、volumetricsexponent 1、cascadedistance `3 / 10 / 100`、lightsourcesize 0。与 lighting-REPORT 的缺省一致，补上了后四项。
- 槽号之后不再改：`+0x2c8` 的 dword 写入在全二进制里只有工厂这一处【确，有界：`xr.py` 搜 `0x2c8`】。

### 1.2 每帧写入（`FUN_14025d1f0` = 灯虚表 `+0x48`）【确】
```
if (L.type != 5 || (unsigned)L.slot > 3) return;
if (L.visible && (L.parent == null || 父链可见 FUN_140185010)) {
    ColorRadius[slot] = (color.r·I, color.g·I, color.b·I, radius);   // ctx+0x1258 + 16·slot
} else {
    ColorRadius[slot] = (0, 0, 0, 1);
}
Position[slot] = W.row3.xyz;   // 世界矩阵（+0x80）的平移，ctx+0x1228 + 12·slot，隐藏时照写
```
- 调用点：`FUN_1401891a0` 对 `G+0x158` 全部对象逐个调 `+0x48`（`0x1401891f0`–`0x140189203`），**不看可见性、不看 `lightconfig`**，每帧都写。
- 坐标：世界空间，含父链（`FUN_1401850a0` 的世界矩阵，见 3.3）。半径不变换，不乘 scale。
- 颜色 = `color × intensity`，w = `radius`。和协调方抓帧的 demon_core 值一致（`(0.67, 0.67, 0.67, 17.13)`，color 1、intensity 0.67、radius 17.13；位置 = origin，没有父对象）。
- 多灯同槽：同一帧里后调 `+0x48` 的覆盖先调的。`G+0x158` 是建对象的顺序（工厂末尾 `0x140190842` push_back）【推：等于 JSON 顺序】。所以 5 盏 `point` 时槽 0 = 第 5 盏，第 1 盏被盖掉；第 5 盏隐藏时槽 0 变成 `(0,0,0,1)`，第 1 盏也一起消失。槽 0 上后来的若是 V1 灯，它不写，第 1 盏保留。

### 1.3 空槽与销毁【确】
- 渲染上下文构造 `FUN_14017c6d0`：`ctx+0x1228..+0x1257` 先清零，再把四个 y 写 100（`0x14017d649`–`0x14017d667`）→ 位置 `(0, 100, 0)`；`ctx+0x1258..+0x1297` 清零，四个 w 写 1（`0x14017d671`–`0x14017d68f`）→ `(0, 0, 0, 1)`。
- 灯析构 `FUN_14025cf90`（虚表 +0）：类型 5 且槽 ≤ 3 时把自己的槽写回 `(0, 100, 0)` / `(0, 0, 0, 1)`（`0x14025cfe3`–`0x14025d016`）。
- 用意【推】：半径 1、颜色 0 让空槽不发光又不除 0；位置放在 y = 100 是为了 `lightDelta` 不为零向量（`normalize` 不出 NaN）。`ComputeLightSpecular` 用 `saturate((radius − d)/radius)`，距离 100 远大于 1，衰减为 0。

### 1.4 uniform 与读者【确】
名字表 `FUN_140002860`（`0x140003d56`–`0x140003dcf`）与 uniform 写入 `FUN_1400d8300` 的跳转表（`jt.txt`）：

| ID | 名字 | case | 内容 |
|---|---|---|---|
| 0x5d | `g_LightsColorRadius` | `0x1400d9973` | `ctx+0x1258` 起 4 个 vec4 原样拷 |
| 0x5e | `g_LightsColorPremultiplied` | `0x1400d99b1` | 3 个 vec4：`[i].rgb = c_i · r_i²`（i = 0..2），`[i].w = c_3[i] · r_3²` |
| 0x5f | `g_LightsPosition` | `0x1400d9aa8` | 4 个 `(x, y, z, 0)`，16 字节步长 |
| 0x60 | `g_LightAmbientColor` | `0x1400d9b78` | `ctx+0x1298` |
| 0x61 | `g_LightSkylightColor` | `0x1400d9b9e` | `ctx+0x12a4` |

- `g_LightAmbientColor` / `g_LightSkylightColor` 的来源是 general `ambientcolor` / `skylightcolor`，改值回调 `LAB_1401863f0` 拷进 `ctx+0x1298 / +0x12a4`（p3 L5，原值不换算）。遗留与 V1 共用。
- 写入只看着色器声明了哪个名字，不看材质类型。自带着色器里：
  - `generic.vert/.frag`、`generic2.vert/.frag`：`g_LightsPosition[4]`、`g_LightsColorRadius[4]`、`g_LightAmbientColor`、`g_LightSkylightColor`（顶点里 `mix(sky, ambient, n.y·0.5 + 0.5)`），逐灯 `ComputeLightSpecular`（`common_fragment.h`）。
  - `genericimage2.vert/.frag`：`g_LightsPosition[4]`、**`g_LightsColorPremultiplied[3]`**、`g_LightAmbientColor`（`max(0.001, ·)`），逐灯 `ComputePBRLight`，不读 `g_LightsColorRadius`。
  - 只有这 6 个文件（`grep` 全部 `assets/shaders`）。工程自带着色器声明同名 uniform 也会被写。
- `generic` 不 include `common_fog.h`，遗留路径没有雾。

### 1.5 与 V1 灯的关系【确】
- 并存。V1 计算（`FUN_140190c80`）的类型分派 `0x1401910f2`：0 → `0x14019325f`、1 → `0x140192dbf`、2 → `0x140192a19`、3 → `0x14019111d`，其它（含 5）跳过；遗留写入只认 5。
- 唯一的交叉是槽号（1.1）：V1 灯也占遗留槽。
- `lightconfig` 只管 V1（`ctx+0x121c` 为 0 时 `FUN_140190c80` 直接返回），不影响遗留。

### 对实现的含义
- 编译期（P13a，运行时之前）：按 `objects` 顺序给**每个灯对象**（不分类型）分槽：第一个空槽，满了给 0；遗留灯写 `Position[槽] = 世界平移`、`ColorRadius[槽] = 可见 ? (color·intensity, radius) : (0,0,0,1)`；同槽按顺序后者覆盖；未写的槽 `(0,100,0)` / `(0,0,0,1)`。
- 引擎 uniform 表加 4 个：`g_LightsPosition`（vec3[4]，按 16 字节步长）、`g_LightsColorRadius`（vec4[4]）、`g_LightsColorPremultiplied`（vec4[3]，按上表打包）、已有的 ambient / skylight。`genericimage2` 的光照要用 `g_LightsColorPremultiplied`。
- P13f 之后改成每帧写，且注意遗留灯比 V1 晚一帧看到动画 / 脚本的值（3.2）。

### 建议实测
- `p13-legacy-slots`：`generic` 网格 + 6 盏 `point`（第 2 盏隐藏、第 3 盏挂在会动的父对象下、第 5 盏 `visible` 绑属性、第 6 盏隐藏），前面再放 1 盏 `lpoint`。读常量缓冲：预测 `lpoint` 占槽 0 不写；6 盏遗留灯拿槽 1、2、3、0、0、0，槽 0 每帧是第 6 盏的 `(0,0,0,1)` + 它的位置；切第 5、6 盏可见性看槽 0 跟谁。
- 同工程换 `genericimage2`，读 `g_LightsColorPremultiplied` 的打包。
- 父对象做关键帧平移，逐帧读 `g_LightsPosition`，看是否比同帧画面里父对象的位置晚一帧（3.2 的推断）。

---

## 2. 雾

### 2.1 字段、缺省与存放【确】
general 类表 `FUN_140199780`（`0x14019a2fc`–`0x14019a9c8`），全部字段的改值回调都是 `FUN_140186440`：

| 键 | 类型 | `G` 偏移 | 缺省（`FUN_140186c90` `0x140186fd4`–`0x1401870a1`） |
|---|---|---|---|
| `fogdistance` | bool | `+0xe0` bit14 | 0 |
| `fogheight` | bool | `+0xe0` bit15 | 0 |
| `fogdistancecolor` | vec3 | `+0x380` | (0, 0, 0) |
| `fogheightcolor` | vec3 | `+0x38c` | (0, 0, 0) |
| `fogdistancestart` / `end` | float | `+0x398` / `+0x39c` | 1 / 5 |
| `fogdistancestartdensity` / `enddensity` | float | `+0x3a0` / `+0x3a4` | 0 / 1 |
| `fogheightstart` / `end` | float | `+0x3a8` / `+0x3ac` | 1 / −3 |
| `fogheightstartdensity` / `enddensity` | float | `+0x3b0` / `+0x3b4` | 0 / 1 |

- bool 的类型化 setter：`0x14019bd10`（bit14）、`0x14019bf40`（bit15）；vec3 走通用 `0x1401a4530`（数字铺满三分量，p3），float 走 `0x1401a49f0`。setter 写完都尾调回调。
- 颜色是 JSON 原值，没有 sRGB 换算。

### 2.2 回调 `FUN_140186440` → 渲染上下文【确】
```
ctx+0x12b0 = fogdistancecolor
ctx+0x12bc = fogheightcolor
ctx+0x12c8 = (distancestart, distanceend − distancestart, distancestartdensity, distanceenddensity − distancestartdensity)
ctx+0x12d8 = (heightstart,   heightend − heightstart,     heightstartdensity,   heightenddensity − heightstartdensity)
ctx+0x118 bit23 = fogdistance；bit24 = fogheight
```
- 每次任一字段改动都整组重算（不比较新旧值）。差值是 float32 减法。`end == start` 时 `.y = 0`，着色器里除 0（WPE 不护）。

### 2.3 uniform【确】
| ID | 名字 | case | 值 |
|---|---|---|---|
| 0x87 | `g_FogDistanceColor` | `0x1400da7de` | `ctx+0x12b0`（vec3） |
| 0x88 | `g_FogDistanceParams` | `0x1400da804` | `ctx+0x12c8`（vec4） |
| 0x89 | `g_FogHeightColor` | `0x1400da81a` | `ctx+0x12bc`（vec3） |
| 0x8a | `g_FogHeightParams` | `0x1400da840` | `ctx+0x12d8`（vec4） |

名字与 ID 的对应在 `0x140004243`–`0x14000429d`。

### 2.4 宏【确】
- `FUN_1401a5c40(着色器管理器, 着色器名, 组合表)` 只有两个调用者：材质构造 `FUN_1401515b0`（`0x140151a83`）、材质 pass 加载 `FUN_140154480`（`0x140154dd9`）。即**宏在材质加载时定死**。
- 进来先加载着色器、取它声明的 `[COMBO]` 列表，组合表里没有的名字按声明的缺省值补进去（`0x1401a5cc0`–`0x1401a5d43`）。
- 雾段（`0x1401a64a0`–`0x1401a666f`）：`ctx+0x118 & 0x1800000`（bit23 | bit24）非 0 时，在组合表里查 `FOG`（`0x14048ee24`）；**存在且值非 0** 时：bit23 → 定义 `FOG_DIST = 1`，bit24 → 定义 `FOG_HEIGHT = 1`。`FOG` 不在表里或为 0 时两个都不定义。
- 所以：
  - 材质写 `FOG: 1`（或着色器缺省 1，`generic4` / `genericimage4` / `genericparticle` 的 `[COMBO] {"combo":"FOG","default":1}`）但 general 没开雾 → 两个宏都不定义，着色器里 `#if FOG_DIST || FOG_HEIGHT` 整段不编，等于没有雾。
  - general 开了雾、材质写 `FOG: 0` → 这个材质不上雾。
  - 着色器没有声明 `FOG` 且材质也没写 → 表里没有 → 不上雾（`generic` 系列即使 include 了也一样）。
- `FOG_COMPUTED`：图像层光照路径（`FUN_140206b3a`，`0x140206c90`、`0x1402074e5`）往组合 JSON 写 `FOG_COMPUTED`、删 `FOG`【推：是 `PRELIGHTING` 的基础 pass 先算雾，上屏 pass 不再算】。P13 不做 `PRELIGHTING`，照报即可。

### 2.5 与 `common_fog.h` 对照【确：着色器原文】
- `CalculateFogPixelState(viewDist, worldY)`：`x = (viewDist − P.x) / P.y`、`y = (worldY − H.x) / H.y`。`viewDist = length(g_EyePosition − worldPos)`（世界单位），`worldY = worldPos.y`（`generic4.vert:140`、`genericparticle.vert:101`、`genericimage4.vert:255`）。
- `ApplyFog`：先高度后距离，`color = mix(color, fogColor, z + w · saturate(t)²)`，即 `startdensity + (enddensity − startdensity) · t²`；mix 因子不钳制（密度大于 1 会外插）。
- `ApplyFogAlpha`：`alpha · (1 − f²)`，`f = saturate(max(距离因子, 高度因子))`。
- 正交场景的 `g_EyePosition` 是 `eye + (W/2, H/2)`、z = 2000（rea-p5-camera 8），所以正交场景的距离雾以 2000 左右为基数【推】。
- HDR：引擎侧不乘任何系数；`generic4` 在 HDR 下怎么用由着色器自己决定。

### 2.6 运行中改动【确：回调；推：开关不重编】
- 数值与颜色：用户属性（渲染后排队，下一帧）、脚本（`thisScene.fog*`，p3 L1 证实是 general 描述符，写入同帧走回调）、关键帧（同帧）都经回调就地改 uniform。
- 开关：回调只改 `ctx+0x118` 的两位；宏只在材质加载时读这两位，运行中没有触发重编的路径（`FUN_1401a5c40` 只有两个加载期调用者）【推】。结果：加载时开着、运行中关掉，着色器仍按旧参数上雾；加载时关着、运行中打开，不会出现雾。

### 对实现的含义
- 编译期：`fogdistance` / `fogheight` 与材质组合表（含着色器缺省）里的 `FOG` 共同决定 `FOG_DIST` / `FOG_HEIGHT`，进 `engineDefines`（只对声明了 `FOG` 或材质写了 `FOG` 的程序）。
- 四个 uniform 进引擎 uniform 表，按 2.2 打包；数值绑属性、脚本写回、关键帧都就地。开关绑属性按 WPE 的行为是「不变」，要么照抄（不重编），要么照报；不建议重编（会和 WPE 不同）。
- 缺省值照 2.1（注意高度雾缺省 end = −3 < start = 1，`.y` 为负）。

### 建议实测
- `p13-fog`：透视，`generic4` 平面 + 若干方块；距离雾、高度雾各一组，读常量缓冲里的四个 uniform，预测按 2.2 打包。
- 同工程材质写 `FOG: 0`、不写 `FOG`、着色器换 `generic2`，看宏（RenderDoc 看着色器源码的 `#define`）。
- 运行中 `apply_properties` 切 `fogdistance`，看画面是否不变（2.6 的推断）；改 `fogdistancestart`，看下一帧 uniform 变。

---

## 3. 灯的运行时

### 3.1 灯的字段表（`FUN_14025da80`，类表 `0x1404e8960`）【确】
| 键 | 类型 | 偏移 | JSON / 类型化 setter | 改值回调 |
|---|---|---|---|---|
| `color` | vec3（2） | `0x2cc` | `0x1401a4230` / `0x1401a4530` | 无 |
| `intensity`、`radius`、`exponent`、`innercone`、`outercone`、`density`、`volumetricsexponent`、`cascadedistance0–2`、`lightsourcesize` | float（4） | `0x2e4`、`0x2e8`、`0x2ec`、`0x2f0`、`0x2f4`、`0x2f8`、`0x2fc`、`0x300`–`0x308`、`0x30c` | `0x1401a4b00` / `0x1401a49f0` | 无 |
| `controlpoint` | vec3 | `0x2d8` | 同 color | 无 |
| `light` | 枚举（5） | `0x2c0` | `0x14025eb40` / `0x14025e9e0` | `0x14025c610` |
| `visible` | bool（6） | `+0x120` bit0 | `0x1401e1a90` / `0x1401e1c60` | 无 |
| `castshadow` | bool | `+0x2c4` bit0 | 同上 | `0x14025c610` |
| `usecookie` | bool | `+0x2c4` bit1 | `0x14019b4e0` / `0x14019b6b0` | `0x14025c610` |
| `castvolumetrics` | bool | `+0x2c4` bit2 | `0x14019bfa0` / `0x14019c170` | 无 |

- 枚举表（`0x14025e853` 起）：`point` 5、`lpoint` 0、`lspot` 1、`ltube` 2、`ldirectional` 3。
- `0x14025c610`：释放阴影 / cookie 资源（`+0x378`）、清 `+0x380..+0x390`。即切类型、切 castshadow / usecookie 在运行中就地生效（下次用到时重建资源），不重编。
- 变换字段（`origin` / `angles` / `scale` / `parent` / `name`）走基础对象表（p3：`0x1404e8250`，`origin` 回调 `0x1401e0520` 作废变换缓存）。
- 加载 `FUN_14025d080`：基类加载 `FUN_1401de470`（逐键套描述符、建绑定），之后 `usecookie` 为真时读 `cookie` 纹理（缺省 `0x140491ad8`）。

### 3.2 一帧里的时序【确：地址；推：生效帧】
| 步 | 地址 | 和灯有关的动作 |
|---|---|---|
| ① | `0x1401891f9` | 每个对象 `+0x48`：遗留灯写 `g_LightsPosition` / `g_LightsColorRadius`（1.2） |
| ③ | `0x1401802e5` | 动画写字段、字段脚本 `update` 写回、`thisLayer.x = …` |
| ⑤ | `0x14018031a` | V1：排序（3.6）、逐灯算 `g_L*` 数组 |
| ⑦ | `0x140180d0c` | 排队的用户属性写字段 |

- V1：关键帧、字段脚本、脚本直接写字段**当帧**生效；用户属性下一帧。
- 遗留：①在③之前，关键帧 / 脚本都**晚一帧**；用户属性也是下一帧（⑦写 → 下一帧①读）。
- 两者都不缓存：没有「加载时算一次」的路径。V1 的结果写进 `G+0x348` 的缓冲（每帧 `memset` 后重写，大小 = 灯数 × 16，`0x140190d6a`–`0x140190de9`），uniform 写入时读它。

### 3.3 父链与可见性【确】
- 世界矩阵：两条路都调虚函数 `+0x80` = 基类 `FUN_1401850a0`。按帧缓存（`obj+0xd0` 存帧号，`origin` 等 setter 回调清零），并检查父链的缓存（`FUN_140185040`），父对象是模型时取的是模型对象自己的 `W`（模型的 `+0x80` 也是这个函数，不含骨骼）。公式同 rea-p5-mesh 2.3：`W = W_parent · T · Rz·Ry·Rx · S`。
- 可见性：`FUN_140185010` = 自身 bit0 且父链递归可见。V1 先查可见性再分类型（`0x1401910d6`），隐藏的灯**不占** V1 槽；遗留灯隐藏时写 `(0,0,0,1)`，占着自己的槽。
- 灯对象的 `+0x68`（`FUN_14025d330`）= 可见 ∧ 父链可见 ∧ `castvolumetrics`；`+0x50`（`0x14025d300`）在 `castvolumetrics` 时把自己交给 `ctx+0x1510` 的 `+0x28`。即灯在绘制循环里被「画」只是登记体积光【确：调用；推：用途，交给 rea-p13-passes】。

### 3.4 属性、关键帧、字段脚本【确：机制；推：灯上的具体效果】
- 三种绑定都由加载期 `FUN_1401a4db0` 对「对象 + 描述符」建（p3、rea-p10 第 9 节），灯字段是普通描述符，所以都能挂：
  - `{user}`：⑦按描述符 setter 写字段。`color` / `intensity` 等无回调，下一帧被①或⑤读到。
  - `animation`：③逐帧写（vec3 / float 都在 rea-p10 第 10 节的可写类型里）。语料 `3465215190` 的 `intensity` 关键帧就是这条。
  - `{script}`：`update(value)` 的返回值经同一个 setter 写回 `+0x2e4` 等；`3706286085` 两盏灯的 `intensity` 脚本就是这条。
- 没有任何字段需要重编着色器：灯数（宏）只来自 `lightconfig`，与灯对象无关；类型、castshadow 切换走 3.1 的资源回调。

### 3.5 灯在脚本里【推】
- 灯和别的对象一样进 `G+0x158`（`0x140190842`）。脚本接口（虚表 `0x14048ea50`）的图层表就是这张表（接口里 `getLayerCount` = `(+0x118 − +0x110)/8 − 排除计数`，`0x14018b57e`），所以 `thisScene.getLayer(灯名)` / `enumerateLayers` 能拿到灯。
- 脚本读写对象字段走描述符（p3 L6：dll `FUN_181620e10` 按类型分支后 `call [描述符+0x48]`），`thisScene` 的 47 个字段正好是 general 类表——推断对象包装同样按类表暴露字段。灯的 `thisLayer` 可读写 3.1 的全部字段与基础对象的变换字段；`light` 是枚举（类型 5）在脚本侧读出什么没读【未知】。
- 字段脚本的返回值写到挂脚本的那个描述符（例：挂在 `intensity` 上就写 `+0x2e4`）。
- 灯的类型码（`+0x60`）是 6（`FUN_1401b49e0`），sprite 是 3、模型 `0x140128f80`、粒子 `0x140118a50`、文本 `0x1401f4c10`（没逐个读返回值）。

### 3.6 超配选灯：`FUN_140186990(G+0x1e0, ctx+0x160)`【确】
- 每帧在 `FUN_140190c80` 开头调（`0x140191063`）。为每盏灯建记录 `{u8 类型 (+0x2c0), u32 标志 & 3 (+0x2c4), f32 键, obj}`，键 = `dot(局部 origin (+0x128..+0x130), g_ViewForward)`（`0x140186a42`–`0x140186a76`），排序后**把顺序写回灯表**（`0x140186c30`）。
- 比较器（`FUN_14019f360` 内联，`0x14019f490`–`0x14019f4b5`）：
  ```
  less(a, b) = a.type != b.type ? a.type < b.type
             : a.flags != b.flags ? a.flags > b.flags
             : a.key < b.key
  ```
  即类型升序（0 点、1 聚、2 管、3 平行、5 遗留），同类型里 castshadow / usecookie 的在前（3 > 2 > 1 > 0），再按「沿视线方向的局部 origin 投影」从小到大（离相机近、或在相机后面的在前）。
- MSVC `std::sort`：元素少于 33 个（`0x14019f396` `cmp rax, 0x318`，24 字节 × 33）走插入排序，**稳定**；更多时 introsort，不稳定。lighting-REPORT `lt-over`「留下文件靠前的那盏」与之吻合（键相等、稳定）。
- V1 逐灯：按排好的顺序，跳过不可见的，某类型剩余数 > 0 就取下一个槽，取完该类型的其余灯丢掉（`0x14019111d` 起，以平行光为例）。阴影：`ctx+0x1ac`（阴影开关字节）为真且灯 `castshadow` 时计入「带阴影」的子计数与另一段缓冲（`0x140191141`–`0x140191165`），子计数不查下限【确：代码；推：越界写，交给 rea-p13-passes】。

### 对实现的含义
- `render/lights.ts`：每帧（脚本之后、渲染之前）由 `SceneState` 算：灯表按 3.6 排序（键用局部 origin 与本帧 `g_ViewForward`，稳定排序），沿父链算世界矩阵与可见性，按 lighting-REPORT 的公式写 V1 数组；遗留数组按 1.2 写，但时机在「脚本之前」（要逐帧对齐的话，遗留灯用上一帧脚本之后的字段值）。
- 绑定表加「灯字段」目标：`color`、`intensity`、`radius`、`exponent`、`innercone`、`outercone`、`controlpoint`、`visible`、`light`（类型），全部就地；关键帧（P10a 运行时）和字段脚本写同一张字段表。去掉 `object:parent`（灯）与 `value:animation:light`。
- `density`、`volumetricsexponent`、`cascadedistance*`、`lightsourcesize`、`castvolumetrics` 也是可绑字段，消费方在体积光 / 阴影。

### 建议实测
- `p13-light-rt`：一盏 `lpoint`（`intensity` 挂关键帧）+ 一盏 `point`（同一条关键帧），两盏都挂在一个会动的模型下，`lightconfig { point: 1 }`；逐帧读两边的 uniform：预测 V1 与关键帧同帧、遗留晚一帧；父对象动时两者位置都跟。
- 同工程脚本 `thisScene.getLayer('灯名').intensity = …`、字段脚本 `update` 返回值，看是否写进 uniform（3.5 的推断）；`light` 读出什么。
- 超配：3 盏 `lpoint`、`lightconfig.point = 1`，一盏 `castshadow`，相机转动使另两盏的投影次序交换，逐帧看留下哪盏。

---

## 4. `sprite` 对象

### 4.1 创建【确】
- 工厂分支（`0x1401902cd`）：对象有 `sprite` 键且值是字符串 → 0x270 字节，构造 `FUN_140256560`，虚表 `0x140491680`。分支顺序：`model` → 粒子 → 图像 → **sprite** → `text`（只看键存在）→ `light` → `sound` → `camera` → `shape` → 空对象。所以 arsenal 灯对象上的 `"sprite": null` 不会建 sprite。
- 和图像层无关：基类构造 `FUN_1401ddbb0` 之后自己建资源，加载用基类 `FUN_1401de470`（只有基础对象字段），更新为空（`0x14000ec30`），绘制 `FUN_140256780`，类型码 3（`FUN_1401253a0`）。构造不置 `+0x120` 的半透明位，所以不进半透明表。
- 构造内容（`0x1402565b9`–`0x1402566f0`）：
  - `+0x240` = 材质 `sprite` 键的路径（`FUN_14014ff70`，普通材质加载，组合只有着色器缺省）；
  - `+0x248` = 网格：顶点格式 `FUN_140098c30({0, 7})`（POSITION float3 + TEXCOORD float2，20 字节），4 个顶点、6 个 u16 索引 `0,1,2, 0,2,3`（索引在 `rsp+0x50`：`0x10000, 2, 0x30002`）；顶点数据 80 字节来自常量 `0x140492b60 / e00 / ba0 / 020 / df0`：四个顶点位置都是 **`(−1, 0, 1)`**，uv 依次 `(0,0) (1,0) (1,1) (0,1)`；
  - `+0x250` = `materials/util/occlusiontest.json`；
  - `+0x258` = 设备 `+0x80` → `FUN_14009ae40`：`ID3D11Device::CreateQuery({Query = 1 (OCCLUSION), 0})`，包装虚表 `0x1404870e8`（`+8` Begin、`+0x10` End、`+0x18` 取结果）。

### 4.2 绘制 `FUN_140256780`【确】
```
if (ctx->passMode (ctx+0x12eb) != 2) return;              // 阴影 pass 不画
n  = query.GetData();          // FUN_1400f0090：没 Begin 过返回 0；GetData(flags 0) 不看返回值，取低 32 位
h  = (n / 2) / (1 << ctx+0x1a8);  // 有符号整除、向 0 截断
k  = min(float(h) / (Hs * Hs) * 512.0, 1.0);   // Hs = ctx+0x78，后备缓冲高
push V；V' = V 且第 3 行 (平移) = (0, 0, 0, 1)；标 VP 脏 (ctx+0x1ca)
保存 g_ViewUp U、g_ViewRight R
g_ViewUp = 2k·U；g_ViewRight = 2k·R；g_Alpha = k²
bind(sprite 材质)；画网格；unbind
if (obj+0x260 != 帧号) {                            // 每帧只测一次
    obj+0x260 = 帧号
    g_ViewUp = 0.2·U；g_ViewRight = 0.2·R
    query.Begin()；bind(occlusiontest)；画同一个网格；unbind；query.End()
}
恢复 U、R；pop V；标 VP 脏
```
- 模型矩阵不压对象自己的 `W`：`M` 是栈顶（主 pass 里为单位阵），所以 **`origin` / `angles` / `scale` / `parent` 的变换对 sprite 无效**；`visible`（含父链）照常由绘制循环检查。
- 顶点着色器（ricepod `shaders/sprite.vert`，与 `occlusiontest.vert` 同式）：`pos = (−1,0,1) + 0.5·((u−0.5)·g_ViewRight + (v−0.5)·g_ViewUp)`，再乘 `M·V'·P`。V' 去掉平移，所以光斑是**相机坐标系下方向 (−1, 0, 1) 上、距离 √2 的公告板**：随相机转动，不随相机平移（像天空盒里的太阳）。
- 尺寸：光斑边长 = `k` 世界单位（k = 1 时 1 个单位）；遮挡测试四边形边长 0.1。和纹理尺寸、`scale` 都无关。
- `g_Alpha = k²`（覆盖对象的 alpha）；`g_Color` 不写（`sprite.frag` 不读）。`g_Alpha` 画完不恢复。
- 遮挡测试：`occlusiontest.json` 是 `nocull`、`depthwrite: disabled`、缺 `depthtest`（= 开，GREATER）、缺 `blending`（= normal）；`occlusiontest.vert` 在 `REVERSEDEPTH` 下把 z 写成 1e−7，所以只在**深度缓冲仍是清屏值 0 的像素**通过，即没有任何写深度的几何挡住的地方。ricepod 的天空盒材质 `depthwrite: disabled`，不挡；船体缺省写深度，挡。
- `occlusiontest.frag` 输出白色，材质没关颜色写【推：主场景普通绘制写 RGB 不写 A（rea-p5-modelflags 2.5），所以光斑中心会叠一个 0.1 单位的白方块；光斑纹理中心若本来就是白色就看不出】。
- `ctx+0x1a8` 是什么没查到写入点【未知；推：MSAA 采样数的 log2，无 MSAA 时为 0】。
- 抓帧对照：event 179 = 光斑（两个轴为 0 → `k = 0`，即上一帧查询为 0 或没读到结果——GetData 不等待，RenderDoc 抓帧那一帧可能读不到）；event 194 = 遮挡测试（轴 × 0.2、z = 0）。两次的 MVP 相同（同一个 V'）。

### 4.3 名单与顺序【确】
- 主 pass：按 `objects` 顺序，和别的对象一样；不在半透明表，`transparentsorting` 下属于第一遍。
- 反射：工厂里 `r15b` 保持 1，`reflected` 不为 false 就进反射名单 `G+0x1c8`；反射 pass 期间 `ctx+0x12eb` 仍是 2（只有阴影 pass 改它，`0x1401965c9` / `0x140196664`），所以 sprite 在反射 pass 里也画；查询每帧一次，**谁先画谁做测试**——反射 pass 在主 pass 之前时，测试是对 `_rt_Reflection` 的深度、在镜像视图下做的【推：反射 pass 的位置与视图交给 rea-p13-passes】。
- 阴影：`ctx+0x12eb == 0` 时直接返回，且没有 `castshadow` 位。

### 4.4 `editorsprite`【确，有界】
- exe 里没有 `editorsprite`、`materials/editor`、`lightsprite` 等任何相关字符串（ASCII 全量扫描）。`editorsprite` 只被 `assets/materials/editor/{light,soundsprite,spotlight,sunlight,tubelight}sprite.json` 引用，是编辑器的灯 / 声音图标。壁纸运行时不加载。

### 4.5 拼错的深度键【确】
- `depthwriting`、`depthtesting` 在 exe 里 ASCII、UTF-16 都搜不到；材质 pass 只在 `FUN_1401577e0`（`0x140157a01`、`0x140157ae6`）读 `depthtest` / `depthwrite`，另有图像层（`0x140206e0b`）与文本（`0x140257ad8`、`0x140259dd6`）读 `depthtest`。
- 结论：拼错的键完全不读，按缺省处理。ricepod 的 `orbital_aurora` / `orbital_ring` / `orbital_thunder` 都是 additive → 不写深度、**测深度**（缺省开），会被船体挡住【推：照 rea-p5-mesh 3.4 的状态表】。

### 对实现的含义
- `sprite` 进对象类型：编译期建 4 顶点常量网格（位置 `(−1,0,1)`）、加载 sprite 材质与 `occlusiontest`；渲染时视图去掉平移、`g_ViewUp/Right` 乘 `2k`、`g_Alpha = k²`，再画遮挡测试。
- WebGPU 有遮挡查询（`occlusionQuerySet` + `beginOcclusionQuery`，结果要 resolve 再异步读回，天然晚 1–2 帧）。WPE 是「本帧用上一帧的结果」，GetData 不等待；我们照「最近一次读回的结果」即可，首帧 `k = 0`。查询结果是样本数，单采样时等于像素数。
- 能力表：`depthwriting` / `depthtesting` 按中性键放行（WPE 不读），但材质按缺省 `depthtest: enabled` 建管线——这会改变 ricepod 的 `orbital_*` 画面，需要实测确认。

### 建议实测
- ricepod 抓几帧连续画面，读 event 179 的 `g_ViewUp` 长度随帧的变化（预测稳定后 `= 2k`，k 由上一帧遮挡测试的通过像素数决定）；把船挡到太阳前，看 k 降到 0。
- 读 event 194 的输出目标：遮挡测试是否真的往颜色里写了白方块。
- 确定性工程：只有一个 sprite（材质用纯色纹理）+ 一个能挡住它的模型，相机平移不旋转，预测光斑在屏幕上不动；平移相机让模型挡住，k 按 512·(n/2)/Hs² 变化。
- `orbital_*`：去掉船体前后比画面，确认测深度。

---

## 5. 透视场景的余项

### 5.1 `transparentsorting`（复核 rea-p5-mesh 4.2）【确】
- 调用：绘制循环 `0x14018ae2a`–`0x14018ae3f`：`FUN_1401865c0(G+0x170, ctx+0x160)`；光标命中 `FUN_140189e10`（`0x140189fb5`）也用同一个排序。
- 「相机前向」= `ctx+0x160` = `g_ViewForward` = −(V 第 2 列) = `normalize(center − eye)`（rea-p5-camera 1.2 / 8，`0x14018017e`–`0x140180194`：`FUN_140184310(V, 2)` 取第 2 列再整体取负）。
- 键 = `dot(obj+0x128..+0x130, ctx+0x160)`，**局部 origin，不含父链**（直接读字段，没调 `+0x80`）；`obj+0x120 & 0x200` 的对象键为 `−inf`（常量 `0x140492a28` = `0xff800000`）。
- 排序 `FUN_14019ee60`：插入排序，`comiss` + `ja` → 键大的在前（沿视线更远的先画），相等保持原顺序（稳定）；长序列再走 `FUN_14019ef50`（同比较）。
- `ctx+0x160` 取步骤②的值，不含逐对象视差和透视覆盖。

### 5.2 透视场景里的文本（复核 rea-p6b-raster 1）【确】
- 条件：`!(ctx+0x118 & 0x400)`（非正交）且对象 `depthtest` 没写或为 enabled（`O+0x5a0 == 0`）→ `basefont_depth` / `basefontrgba_depth` / `*_msdf_depth`，背景 `fontbackground_depth`（exe 里五个路径串都在，`0x14048f130` 等）。
- 和普通材质的唯一区别是 `depthtest` / `depthwrite` 从 disabled 变 enabled；材质都是 translucent，按 rea-p5-mesh 3.4 **不写深度**，所以实际效果 = **测深度（GREATER）、不写**。着色器、混合、剔除（nocull）相同。
- 矩阵同普通对象：矩阵栈压文本居中平移 `(−宽/2 − min(minX,0), 高/2 − maxY)`，再乘对象 `W`，`VP` 是场景透视相机；单位是 300 DPI 的 face 像素（所以透视场景里文本对象的 scale 很小，3453730450 是 0.001–0.01 量级）。
- 直接上屏时深度有效；走合成 RT（带 effect）时合成 RT 没有深度（rea-p5-mesh 3.1），字形在 RT 里不测深度；之后上屏用哪个材质的深度状态没读【未知】。

### 5.3 透视场景里带子层的组合层（复核 rea-p5-modelflags 2.4 / 2.5）【确】
- 子树画进合成 RT（`FUN_140207b50` 的 `0x140208217` 起）：除了 `fullscreen`（`+0x304 & 2`，`0x140208252`），**没有按场景类型的分支**。设置 `M = inverse(W_组)`（`0x1402082e0`）、`V = 单位阵`（`0x140208334`–`0x140208363`）、`P = ortho(−w/2, w/2, −h/2, h/2, −1000, 1000)`（设备 `+0x18`，`w/h = +0x2f0/+0x2f4`）。透视场景里同样把子层正交地压平进组的局部矩形。
- 合成 RT 不挂深度，子层的深度状态不起作用。
- 组自己的基础 pass（`copybackground`）用 `W` + 场景相机（透视）采快照；上屏用 `W·V·P`（透视）与基础材质的深度状态：`composelayer` 是 `depthtest: disabled`，模型 JSON 若选 `materials/util/composelayer_depthtest.json` 则测深度不写（这个名字 exe 里不出现，只由模型 JSON 选）。

### 对实现的含义
- P13h：`transparentsorting` 键用局部 origin 点乘本帧 `g_ViewForward`，降序、稳定，`fullscreen` / `projectlayer` 最后。
- 透视场景的直接上屏文本用「测深度、不写深度」的管线；正交场景永远不测。
- 透视场景里的组：子层照现有正交局部投影画进合成 RT，不需要新逻辑；上屏走场景透视相机与基础材质深度。

### 建议实测
- `p13-tsort`：rea-p5-mesh 4「建议实测」的 `p5-order` 原样做（父对象把 Y 挪近、键仍用局部 origin）。
- `p13-text-depth`：透视场景，一个不透明模型挡住半个文本对象，文本写 / 不写 `depthtest`；预测被挡部分不画；再在文本后面放一个半透明模型，看文本不写深度。
- `p13-group-persp`：透视场景，组合层带 `angles` 绕 y 转 45°、两个子图层；预测子层先被正交压平进组的矩形，再随组一起透视。

---

## 6. 材质的小细节

### 6.1 `combos` 键的大小写【确】
- 材质 pass 加载 `FUN_140154480`：取 `combos` 对象（`0x1401544d3`），逐个键逐字符调 `toupper`（`0x1402bfb48`，C 区域只改 a–z）拼成大写名，值 `asInt`（`0x140085ee0`），写进组合表（`0x140154595`–`0x140154607`）。
- 之后 `FUN_1401a5c40` 按着色器 `[COMBO]` 声明补缺省（2.4）。所以 `lightmap: 1` 等于 `LIGHTMAP = 1`，`#if LIGHTMAP` 生效；着色器声明的组合名本身是大写。
- 值不是数字时（字符串、对象）`asInt` 断言中止（p3 已实测）。

### 6.2 只有 `.tex-json` + 源图片、没有 `.tex`【确：分支；推：重编完成后的替换】
- GPU 纹理加载（`FUN_1400ec220` 的 `0x1400ec32e` 段）：路径 = `"materials/" + 名字 + ".tex"`（`FUN_1400eb130`）。
  1. `ctx+0x3078`（构造 0，没找到别的写入）为真时走同步重编分支 `FUN_140279790(vfs, 路径, 0, 1)`。
  2. 否则 `ctx+0x3058`（构造 1；general `norecompile: true` 时 `FUN_140186c90` 在 `0x140187644` 清 0）为真时：`FUN_14017dfc0` 判断正在跑的编译任务数是否低于上限（CPU 线程数 − 1，钳到 1–7），再调 `FUN_140279790(vfs, 路径, &任务, 同步?)`：
     - VFS 里 `.tex` 存在（`vfs +0x28`）→ 返回 false，照常加载；
     - 不存在 → 按 13 种扩展名找源图片（`FUN_1402797dd` 循环到 `0xd`）【推：扩展名表没读】，`FUN_1402787c0` 比 `.tex` 头（`TEXV0005`）与源文件、`.tex-json` 的时间戳 / 摘要，需要时打日志 `Recompiling texture: %S` 并编译（同步 `FUN_140279150` / 异步 `FUN_1402792e0`）→ 返回 true → `FUN_14017d9b0` 登记待重载，本次先用占位。
  3. 名字是 `error`（`0x1400ec38e` 比较）或加载 `FUN_1400d4160` 失败 → 6×6 RGBA8 黄黑棋盘格（`FUN_140170510`，像素规则见 rea-p8-render 2.6），名字是 `_rt_shadowAtlas` 时占位的格式标志另设 `0x10 / 0x8000008`（`0x1400ec5df`–`0x1400ec5fa`，交给 rea-p13-passes）。
- 着色器编译期读纹理头（取尺寸、格式给 `TEX<n>FORMAT` 等）是另一个函数 `FUN_14014d500`（`0x140155a23` 调）：`.tex` 打不开就返回 false，宽高留 0。
- 默认工程五张都写了 `norecompile: true`，所以在 WPE 里缺 `.tex` 一律棋盘格。audiophile 的 `grid.json`（引用缺 `.tex` 的 `grid/grid`）是 mdl 的皮肤 0，场景里 `skin: 1` 用 `grid2`，`grid.json` 不加载，不影响画面。

### 对实现的含义
- 组合键统一转大写再进组合表与宏（翻译器请求里的组合名按大写传），着色器 `[COMBO]` 缺省在材质没写时补上。
- 缺 `.tex`：`norecompile: true` → 绑 6×6 棋盘格（已有实现可复用）；没写 `norecompile` → WPE 会从源图片重编，Kabegame 可以直接解码源图片（`.tex-json` 给格式）作近似，或照报。语料里目前没有走到这条的场景（audiophile 不走）。

### 建议实测
- 复制 audiophile，grid 对象改 `skin: 0`：预测棋盘格；再去掉 `norecompile`：预测日志出现 `Recompiling texture` 且之后变成 grid 图（实测会写工程目录，用 `ignore/` 下的副本）。
- 材质写 `"combos": {"lightmap": 1}` 与 `{"LightMap": 1}`，RenderDoc 看着色器源里的 `#define LIGHTMAP 1`。

---

## 未查清

- `ctx+0x1a8`（sprite 遮挡结果的除数指数）的写入点与含义。
- 灯的 `light` 枚举字段在脚本里读出字符串还是数字；对象包装是否真的按类表暴露灯字段（3.5 只有间接证据）。
- 雾开关在运行中改动后是否有别的路径触发重编（本文只确认宏函数只有两个加载期调用者）。
- V1 阴影子计数越界（3.6）的实际后果、`ctx+0x1ac` / `+0x1ad` 的来源（阴影 / 体积光档位）。
- sprite 在反射 pass 里的矩阵（镜像在 V 还是 M，清平移后还剩什么）。
- 带 effect 的透视文本上屏用什么深度状态。
- 纹理重编时的源图片扩展名表、重编完成后怎样替换占位。

## 元数据

- 目标：`d:\Codes\kabegame\ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工时与安装目录原件逐字节哈希一致。没有运行、附加 WPE，没写 Steam 目录。
- REA：把 `ignore\p11\rea\media\wallpaper64-2.8.42-p11-media.rea-snapshot` 拷成 `ignore\p13\rea\lights\wallpaper64-2.8.42-p13-lights.rea-snapshot` 后 `open_binary`；两次反编译请求都在 Ghidra 启动期限（330 s）内没导入完（另一个代理同时在用），按约定退到全量反汇编，`close_binary` 时没另存（本轮没有任何 REA 标注，快照文件就是 p11 快照的原样拷贝）。
- 方法：全部结论来自 `ignore\p4\rea\wp.asm` 按地址切片（`slice.py` / `xr.py` / `grepfn.py`）与直接读 exe 字节（`strs.py` / `wstrs.py` / `f32.py` / `dumpf.py` / `cs.py` / `vt.py`），uniform 跳转表用 `jt.py`（从 `ignore\p5\rea\camera\jt.py` 拷来改了路径）。
- 工作文件 `ignore\p13\rea\lights\`：
  - 汇编摘录 `asm\`：`legacy_14025d1f0.asm`（遗留写入）、`factory_14018ff60.asm`（工厂）、`lightprops_14025da80.asm`（灯类表）、`v1_140190c80.asm`（V1）、`lightsort_140186990.asm`、`sort_14019f360.asm`（比较器）、`frame_14017fcfc.asm`（帧函数中段）、`genprops_fog.asm`（general 雾描述符）、`macros_1401a5c40.asm`（引擎宏）、`sprite_ctor_140256560.asm`、`sprite_draw_140256780.asm`、`tsort_1401865c0.asm`、`texload_14014d500.asm`。
  - `jt.txt`（uniform ID → case）、`xr_legacy.txt`、`showscene.py`（打印 scene.json 对象）。
- 读过的着色器与文件：`assets\shaders\generic.vert/.frag`、`generic2.vert/.frag`、`genericimage2.vert/.frag`、`common_fragment.h`（`ComputeLightSpecular`）、`common_fog.h`、`generic4.vert/.frag`、`genericimage4.vert/.frag`、`genericparticle.vert/.frag` 的雾段、`occlusiontest.vert/.frag`、`editorsprite.vert/.frag`；`assets\materials\util\occlusiontest.json`、`composelayer*.json`、`solidlayer_depthtest.json`、`fonts\basefont*.json`、`fontbackground*.json`；默认工程 ricepod（`ricepod.json`、`shaders\sprite.vert/.frag`、`materials\sprites\sunsprite.json`、`materials\ricepod\*.json`）、demon_core / arsenal 的灯对象、audiophile 的 `grid.json` / `grid2.json` / 对象表、五个默认工程的 `norecompile`。工坊样本 `3706286085`、`3453730450`、`3465215190` 没有解包（本轮问题都能从 exe 与默认工程回答）。
- 引用的前序读码：lighting-REPORT、rea-p5-mesh（2、3、4、5）、rea-p5-camera（1.2、8）、rea-p5-modelflags（2.4、2.5）、rea-p6b-raster（1、5）、rea-p8-render（2.6）、rea-p10-keyframes（1、9、10）、p3-script-REPORT（I、L 节）。
- 标记：【确】读到代码或文件原文；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过。
