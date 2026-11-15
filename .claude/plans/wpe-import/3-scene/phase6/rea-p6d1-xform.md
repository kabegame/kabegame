> 逆向原始记录，代理写的，exe 地址按 Ghidra（基址 `0x140000000`），dll 地址按 `0x180000000`，全部没有实测。P6d1 实测核对后以报告为准。范围：图层的 `rotateObjectSpace` / `lookAt` / `lookAtYaw`、`angles` 与旋转矩阵的关系、`getTransformMatrix`，以及 effect 的 `setMaterialProperty`。层级、建删排、effect 访问的其余部分见 `rea-p6d-layers.md`（exe 侧）与 `rea-p6d-script.md`（dll 侧），本文沿用它们的命名。

# WPE 2.8.42 图层变换方法与 `setMaterialProperty` 静态逆向

**概括**
1. **`rotateObjectSpace(v)`**（`FUN_1401df620`）：
   - 轴顺序表 `DAT_1404903a8` 的三个 uint 是 **`2, 1, 0`**（字节 `02000000 01000000 00000000`，`0x1404903b4` 是表尾）。【确】
   - **参数是弧度**：dll 的通用方法桩对 `0x20`（Vec3）参数只取 `x` `y` `z` 转 f32，不做任何换算；exe 直接拿它做 `cosf` / `sinf`。而 `thisLayer.angles` 对脚本是度（描述符的角度位，dll 读写时换算）。两者单位不一致。【确】
   - 每一步都是**右乘**，即绕**物体自己的轴**转：`M ← M · Rz(v.z)`，再 `· Ry(v.y)`，再 `· Rx(v.x)`；合起来 `M_new = M_old · Rz(v.z) · Ry(v.y) · Rx(v.x)`，和 `angles` 的约定（`Rz·Ry·Rx`）同一顺序，所以从零角度起调一次，`angles` 读回就是 `v`（换成度）。每一步的 R 用 glm `rotate` 的通式按 f32 现算（第 1.3 节伪代码）。【确】
   - `FUN_14041a2e0` = `cosf`，`FUN_14041a9c0` = `sinf`，`FUN_14041c460` = `atan2f`，`FUN_14041ad10` = `sqrtf` 的出错分支（只在参数 < 0 时调，其余用内联 `sqrtss`）。都是 MSVC CRT 的实现。【确】
   - 乘完把 3×3 **直接写回** `O+0x14c`，再按 glm `extractEulerAngleZYX` 从这个矩阵反算 `z = atan2f(M[0][1], M[0][0])`、`y = atan2f(−M[0][2], sqrtf(M[2][2]² + M[1][2]²))`、`x = atan2f(sin z·M[2][0] − cos z·M[2][1], cos z·M[1][1] − sin z·M[1][0])` 写进 `O+0x140..0x148`，最后 `O+0xd0 = 0`。**不调角度 setter、不按反算的角度重建矩阵**。【确】
2. **角度与旋转矩阵**：
   - 画图与 `getTransformMatrix` 用的是 **3×3（`O+0x14c`）**，不是角度：世界矩阵 `FUN_1401850a0` 取 `列 j = scale[j] · O+0x14c 的第 j 列`、平移 `origin`，再左乘父的世界矩阵。【确】
   - `angles` 的一切写入（JSON 加载、脚本写、关键帧动画写、`lookAt` / `lookAtYaw`、相机路径、`setParent(…, true)`）都经 `FUN_1401dd630`：存角度 → 按 `Rz(z)·Ry(y)·Rx(x)` 现算 3×3 → `O+0xd0 = 0`。【确】
   - 所以只有 `rotateObjectSpace` 会让 3×3 和「按角度重建的矩阵」不一样（差在末位：反算再重建有 1 ulp 级的差，第 2.6 节）。之后**任何一次 `angles` 写入都会按新角度重建 3×3，把乘出来的矩阵丢掉**；脚本 `thisLayer.angles = thisLayer.angles` 也会（还多一轮度↔弧度的 f32 换算）。【确】
   - `thisLayer.angles` 读的是 `O+0x140`（反算出来的角度），`getTransformMatrix` 读的是乘出来的矩阵。【确】
3. **`lookAt(center, up)` / `lookAtYaw(center, up)`**（`FUN_1401dfc00` / `FUN_1401dfe30`）：
   - `center` 和 `origin`（`O+0x128`）在**同一个坐标系**，也就是父对象的本地空间（没有父就是场景）。函数**不读父链、不读世界矩阵**，有父对象时不做任何换算。【确】
   - `up` 是第二个参数，缺省（缺参数、不是对象）为 `(0, 1, 0)`，**不归一化**。【确】
   - 朝向轴：相机对象（`vt+0x60` 返回 8）让本地 **−Z** 对着目标；其它对象先把目标镜像到 `origin − d`，结果是本地 **+Z** 对着目标。【确】
   - 实现：`glm::lookAtRH(origin, center′, up)`（`FUN_14019d920`）得到视图矩阵 V，按 `extractEulerAngleZYX(Vᵀ)` 取角度，交给角度 setter `FUN_1401dd630`。所以写的是 `angles` 与按角度重建的 3×3、标脏；**不改 `origin`**。【确】
   - `lookAtYaw` 先把 `d = center − origin` 里沿 `up` 的分量减掉：`d′ = d − up·(up·d)`（`up` 不归一化），其余同 `lookAt`。【确】
   - 退化：`|d|²`（`lookAtYaw` 为 `|d′|²`）不大于 `FLT_EPSILON = 1.1920929e-07` 时**什么也不做**；`lookAt` 的视线与 `up` 平行时（例如缺省 `up` 下看正上方）**没有防护**，叉积为零、归一化得 NaN，角度与 3×3 全变 NaN。【确：算式；画面不画为【推】】
4. **`setMaterialProperty(名, 值)`**（`FUN_1401ee1d0`）：
   - 材质 `vt+0x20` 是 `FUN_140159900`：先查材质类的静态表（只有 5 个 pass 状态字符串 `blending` `alphawriting` `depthtest` `depthwrite` `cullmode`，类型 5），再查材质实例自己的表 `mat+0x48`（材质加载时按着色器常量表**逐个材质键**建的描述符，名字就是注解里的 `"material": "…"`）。按名字**全等、区分大小写**。**`g_…` 这类 uniform 名不是键**，查不到。【确】
   - 这和 `constantshadervalues` 的套用（`FUN_1401730d0` 按 `vt+0x20` 查）、脚本 `getMaterial(i).<键>` / 常量脚本的 `thisObject.<键>`（包装按 `vt+0x10` 列出的同一批描述符建属性）是**同一张表、同一批描述符、同一个原生 setter**。【确】
   - **dll 把任何对象都转成 Vec2**：值参数的类型掩码是 `0x7c`，dll 方法桩逐位尝试时 `0x10`（Vec2）排在 `0x20`、`0x40` 前面，判定只看「是不是对象」，于是 `Vec3` / `Vec4` / 普通对象一律变成类型码 `0x10`、只取 `x` `y`。exe 端 `0x10` 只配描述符类型 1（vec2）。所以 **vec3 / vec4 常量永远写不进去**；vec2 常量能写（取 `x` `y`）；float 常量收数（整数走 `8`、其它数走 `4`，带 `rad2deg` 的乘 `0.017453292f`）。字符串、布尔、`null`、`undefined`、缺参数落到缺省「整数 0」，**会把 float 常量写成 0**。【确】
   - 写进去：原生 setter 写 `mat + 0x120 + 4·槽位` 后尾调改值回调 `0x1401538c0`（`mat+0x1f8 |= 3`），材质下次绑定时看到 bit0 就重传常量块、清位。脚本在渲染之前跑，所以当帧画面就生效。会被覆盖的只有：这个常量上的关键帧动画（每帧在 `update` 之前写）、常量脚本返回了别的值、用户属性变化。`update(value){ return value; }` 不覆盖（`value` 是 dll 用 getter 现读的当前值）。【确；上传点【确】、在哪个函数里没定名】
   - **那次实验的结论**：不是被干扰，是 `setMaterialProperty` 本身写不了 vec3：`new Vec3(0, 1, 0)` 到 exe 时是 Vec2 `(0, 1)`，`color` 的描述符是 vec3，类型不配，跳过；`'g_TintColor'` 不在表里，直接跳过。挂在 `color` 上的 `return value` 脚本对结果没有影响。直接写 `getMaterial(0).color` 走字段写入，按描述符类型取 `x y z`，所以生效。【确】

**元数据**
- 目标：`ignore/p9/rea/wallpaper64.exe`（SHA-256 前缀 `40e2ce021e935232`）、`ignore/p10/rea/scenescript64.dll`（`58039ef912fcd51c`），开工时核对一致；只读，没运行、没附加 WPE。只读了本机 WPE 的 `assets/effects/*/shaders`（找测试用的常量）、`assets/scripts/jsclasses/baseclasses.js`、`ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`。
- 方法：**没用 REA**（已有导出加 `wp.asm` 切片足够，没开二进制，所以没有快照）。exe 用 `ignore/p4/rea/wp.asm` 切片与 `ignore/p6/rea/layers/exe/dec-*` 的伪代码；dll 用 `rea-p6d-script` 已切好的 `methodcall_214a0.asm` 与 `llvm-objdump` 补看 `0x180016c40`、`0x181620090`。
- 工作目录 `ignore/p6/rea/layers/xform/`：
  - 汇编切片：`rot_1401df620.asm`、`angset_1401dd630.asm`、`lookat_1401dfc00.asm`、`lookatyaw_1401dfe30.asm`、`lookat_14019d920.asm`、`smp_1401ee1d0.asm`、`matdesc_1401553a0.asm`（材质描述符建表）、`matreg_1401577c0.asm`（材质静态表登记）、`mat_1401515b0.asm`（材质构造）、`atan2_a.asm` / `atan2_b.asm`。
  - 脚本：`rd.py` / `pe.py` / `slice.py` / `vtdump.py` / `fn.py`（拷自 `layers/exe`，路径改指 `p9` 的副本）；新写 `cosuse.py`（列出读角度字段后算三角函数的位置）、`callee_before.py`（粗定函数入口）、**`sim.py`**（按读码用 f32 复刻 `rotateObjectSpace` / `lookAt` / `lookAtYaw` / 角度 setter，算下面实测的预期读回）、`smp_vals.py`。
- 标记：【确】汇编 / 伪代码直接看到；【推】由代码推出；【确，有界】在注明范围内搜过。浮点：全部是 SSE 标量单精度（`mulss` / `addss` / `subss` / `divss` / `sqrtss`），没有 FMA；下文伪代码每个运算都是一次 f32 舍入，括号即运算顺序。

**命名**（沿用 `rea-p6d-layers`）
- 对象 `O`：`O+0x128` `origin`、`O+0x134` `scale`、`O+0x140` `angles`（弧度，x y z）、`O+0x14c` 起 3×3 旋转（列主序，`M[c][r]` 在 `O+0x14c + 4·(3c + r)`）、`O+0xd0` 世界矩阵缓存戳（0 = 作废）、`O+0xe0` 世界矩阵缓存、`O+0x180` 父。
- 描述符（相对描述符本体）：`+0` 类型（0 int、1 vec2、2 vec3、3 vec4、4 float、5 string）、`+4` 字段偏移、`+8` JSON setter、`+0x18` 原生 setter、`+0x20` getter、`+0x28` 改值回调、`+0x30` 标志（bit1 只读、bit2 角度）、`+0x38` 名字。
- `M`：dll 通用方法桩 `0x1816214a0`。

---

## 1. `rotateObjectSpace(v)`

### 1.1 dll 侧参数【确】
- 方法表（`rea-p6d-layers` 9.2）：参数类型码 `0x20`（只有 Vec3 一位，`0x1401e0ac3`）。
- `M` 逐位尝试：`0x20` 分支（`0x181621cbc`–`0x181621d58`）要求参数是 JS 对象（`0x180016c40`：实例类型 ≥ `0x11c`，即 JSReceiver），调 `0x181620090` 取 `x` `y` `z`：每个分量 `IsNumber`（`0x180016c70`）才 `NumberValue` 后 `cvtsd2ss`，否则 0。**没有乘法**。
- `M` 里没有任何按描述符标志做的换算（只读 `[r10+0x28..0x30]` 的参数类型码与 `[r10+0x40]` 的返回类型码；`methodcall_214a0.asm` 里唯一的 `mulss` 在区外的小函数 `0x181623400`）。
- 不是对象（数字、字符串、缺参数）时，`M` 填零向量、类型码 `0x80000020`。exe 的 `FUN_1401df620` **不看类型码**，照样按 `(0, 0, 0)` 走一遍（第 1.5 节）。

### 1.2 exe 的轴表与数学函数【确】
- `DAT_1404903a8`：`2, 1, 0`；`0x1404903a0` 是字符串 `visible` 的尾巴，`0x1404903b4` 是循环终点。
- 常量：`0x140492704` = 1.0f；`0x140492ff0` = 符号位掩码。
- 数学函数（都先看 `0x1404e4ee0` 的 FMA3 / AVX 标志分派）：

| 函数 | 身份 | 依据 |
|---|---|---|
| `FUN_14041a2e0` | `cosf` | `|x| < 2⁻¹³` 的快速路径返回常量 1.0（`0x14041a333` 读 `0x140471cb8` = 1.0）；调用方用 `1 − 它` 做 glm 的 `temp` |
| `FUN_14041a9c0` | `sinf` | 同样的快速路径返回 x 本身（`0x14041aa07`–`0x14041aa1b`，乘加只为置 inexact） |
| `FUN_14041c460` | `atan2f(y, x)` | 两个参数；特例常量 π（`0x140492834`）、−π（`0x140492a00`）、±π/2（`0x140492744` / `0x1404929bc`）、−0（`0x1404929a0`） |
| `FUN_14041ad10` | `sqrtf` 的出错分支 | 引用函数名串 `"sqrtf"`（`0x140471e00`）；调用点都是 `ucomiss 0, x; ja` 之后，即只在 `x < 0` 时调用，返回 NaN；`x ≥ 0` 用内联 `sqrtss` |

- CRT 的 `cosf` / `sinf` 在 double 里算再舍入（`vcvtss2sd`），所以 JS 里 `fround(Math.cos(x))` 绝大多数情况相同，个别值可能差 1 ulp【推】。`sqrtss` 与 `fround(Math.sqrt(x))` 逐位相同。

### 1.3 每一步：glm `rotate(M, a, e_i)`，右乘【确：`0x1401df710`–`0x1401dfaa9`】
```
// 输入：v = (v.x, v.y, v.z)，弧度（f32）；M = O+0x14c 的 3×3，列主序 M[c][r]
for i in [2, 1, 0]:                       // DAT_1404903a8
    a  = v[i]
    c  = cosf(a);  s = sinf(a)
    e  = (0, 0, 0); e[i] = 1               // 单位轴
    l2 = (e.x*e.x + e.y*e.y) + e.z*e.z
    l  = l2 >= 0 ? sqrtss(l2) : sqrtf(l2)  // = 1
    inv = 1.0f / l                         // = 1
    nz = e.z*inv;  nx = inv*e.x;  ny = inv*e.y
    k  = 1.0f - c
    tz = nz*k;  tx = nx*k;  ty = ny*k
    R[0][0] = tx*nx + c
    R[0][1] = nz*s + tx*ny
    R[0][2] = tx*nz - ny*s
    R[1][0] = ty*nx - nz*s
    R[1][1] = ty*ny + c
    R[1][2] = ty*nz + nx*s
    R[2][0] = nx*tz + ny*s
    R[2][1] = ny*tz - nx*s
    R[2][2] = tz*nz + c
    for j in 0..2: for r in 0..2:          // M' = M · R（glm 的 Result[j] = m[0]*R[j][0] + m[1]*R[j][1] + m[2]*R[j][2]）
        M'[j][r] = (M[0][r]*R[j][0] + M[1][r]*R[j][1]) + M[2][r]*R[j][2]
    M = M'
写回 O+0x14c..0x16c = M                    // 0x1401dfaaf–0x1401dfafb
```
- 轴是精确的单位向量，所以 R 就是标准的 `Rz(a)`（列 0 = `(c, s, 0)`、列 1 = `(−s, c, 0)`）、`Ry(a)`（列 0 = `(c, 0, −s)`、列 2 = `(s, 0, c)`）、`Rx(a)`。注意**轴向那一个对角元是 `(1 − c) + c`**，`c < 0.5` 时 `1 − c` 有舍入，和不一定正好是 1；要逐位一致就照上面的通式算，别手写 `Rz`。
- 右乘 = 绕物体当前的本地轴转。三步依次是：绕本地 Z 转 `v.z`，再绕（转过之后的）本地 Y 转 `v.y`，再绕本地 X 转 `v.x`。这与 d.ts「Rotates the object around the axes defined by its current transformation」一致。
- 只动 3×3：`origin`、`scale` 不变。

### 1.4 反算角度与标脏【确：`0x1401dfb04`–`0x1401dfbe8`】
```
z  = atan2f(M[0][1], M[0][0])
S1 = sinf(z);  C1 = cosf(z)
x  = atan2f(S1*M[2][0] - C1*M[2][1], C1*M[1][1] - S1*M[1][0])
q  = M[2][2]*M[2][2] + M[1][2]*M[1][2]
y  = atan2f(-M[0][2], q >= 0 ? sqrtss(q) : sqrtf(q))
O+0x140 = x;  O+0x144 = y;  O+0x148 = z
O+0xd0  = 0
```
- 就是 glm `extractEulerAngleZYX`：`x`、`z` 落在 `(−π, π]`，`y` 在 `[−π/2, π/2]`。所以 `rotateObjectSpace` 之后读 `angles` 会得到**归一化**的角度（例如原来 400° 读回 40°）。
- **不调改值回调、不通知绑定**：`angles` 的描述符本来就没有改值回调（第 2.1 节），这里也没有别的通知。
- 子对象：子对象的世界矩阵缓存比较父的 `O+0xd0`，父为 0 时子在下次取矩阵时重算（`FUN_1401850a0` → `FUN_140185040`），所以子对象当场跟着转。

### 1.5 零向量与非对象参数【确】
- `rotateObjectSpace(new Vec3(0, 0, 0))`、`rotateObjectSpace(5)`、`rotateObjectSpace()`：R 全是单位阵（`c = 1`、`s = 0`、`k = 0`），乘法得到同一个矩阵（乘 1 加 0），但第 1.4 节照样从矩阵反算角度。效果是**把 `angles` 归一化到上面的范围**、3×3 不变。

## 2. 角度与旋转矩阵谁是真值

### 2.1 `angles` 的描述符（`FUN_1401e0530`，伪代码第 139–145 行）【确】
- 类型 2（vec3）、偏移 `0x140`、JSON setter `FUN_1401df2f0`、原生 setter `FUN_1401df590`、getter `0x1401a4560`（通用 vec3 读，读 `O+0x140`）、标志 `|= 4`（角度：dll 读时 `× f32(57.29578)`、写时 `× f32(0.017453292)`，见 `apps/wpe-scene/src/script/f32.ts` 的 P3b 实测）、**没有改值回调**。

### 2.2 角度 setter `FUN_1401dd630(O, a)`【确：`0x1401dd630`–`0x1401dd7c4`】
```
O+0xd0 = 0
O+0x140..0x148 = (a.x, a.y, a.z)
cz = cosf(a.z); sz = sinf(a.z)
cy = cosf(a.y); sy = sinf(a.y)
cx = cosf(a.x); sx = sinf(a.x)
M[0] = ( cy*cz,                    cy*sz,                    -sy   )
M[1] = ( (sy*cz)*sx - cx*sz,       (sy*sz)*sx + cx*cz,       sx*cy )
M[2] = ( (cx*cz)*sy + sx*sz,       (cx*sz)*sy - sx*cz,       cx*cy )
```
- 即 `Rz(z)·Ry(y)·Rx(x)`（列主序），与 P4a 的 `Rz·Ry·Rx` 一致；三角函数按 `z、y、x` 的顺序各取一次 cos、sin。

### 2.3 谁调角度 setter【确，有界：`wp.asm` 全部 `call 0x1401dd630`，7 处】
| 调用点 | 场合 |
|---|---|
| `0x1401df42b`、`0x1401df561` | JSON setter `FUN_1401df2f0`（场景加载、`createLayer` 的配置） |
| `0x1401df5bd` | 原生 setter `FUN_1401df590`：**脚本写 `angles`、关键帧动画写 `angles`、`{user}` 绑定**都走它（rea-p10 第 118–122 行：动画经描述符原生 setter 写） |
| `0x1401dfdfa`、`0x1401e006a` | `lookAt`、`lookAtYaw` |
| `0x1401f3306` | 相机路径条目的每帧更新（rea-p5-camera 4.4，语料里条目表都是空的） |
| `0x14022699c` | 粒子代码区一处（经 `FUN_140225900`，调用者 `0x14021cd2d`）：先 glm 旋转一个矩阵、`FUN_1401e23d0` 分解成 ZYX 角度、再写角度；没细读【推：与普通图层无关】 |

- 另外 `setParent(…, true)` 的两支（`FUN_1401de750`，`0x1401ded46` 起与 `0x1401df110` 起）直接写 `O+0x140..0x148` 再内联同样的公式重建 3×3。
- **只有 `rotateObjectSpace` 直接写 3×3 而不经角度**。【确，有界：读过 `O+0x14c` 偏移的 exe 伪代码，以及「读角度后调 cos / sin」的全部位置（`cosuse.py`）】

### 2.4 JSON setter 的取值（`FUN_1401df2f0`）【确】
- 字符串：先清零，`atof`（`FUN_1402d06ac`）读第一段，按空格（只认 0x20、可连续）往后最多三段，少的为 0。
- 数字（jsoncpp 类型 1–3）：`asFloat` **铺满三个分量**。
- 对象（`{value, script / user / animation}`）：开着解析绑定时，**只认字符串的 `value`**（数字的 `value` 被忽略，角度保持原值），再登记绑定（`FUN_1401a4db0`）。
- 单位：JSON 里就是弧度（与 rea-p4a、rea-p10 第 61 行一致）。

### 2.5 画图与 `getTransformMatrix` 用 3×3【确：`FUN_1401850a0`】
```
// O+0xd0 有效且父链未作废就直接返回 O+0xe0
W[0] = scale.x * M[0];  W[1] = scale.y * M[1];  W[2] = scale.z * M[2]   // M = O+0x14c
W[3] = (origin, 1)
if 父: (挂点 ≥ 0 时先乘父挂点矩阵，父 vt+0x78) W = W_父 · W
O+0xd0 = 当前戳
```
- 每个分量一次 f32 乘法（`scale[j]·M[j][r]`）。
- `getTransformMatrix` = `FUN_1401df5e0` = 拷出 `vt+0x80()`；基类就是上面这个，图像层加 `alignment` 偏移、文本层乘文字框中心（rea-p6d-layers 9.5）。
- 所以 `rotateObjectSpace` 之后**画面与 `getTransformMatrix` 用的是乘出来的矩阵**；`angles` 只在下一次被写入时才重新决定 3×3。

### 2.6 `rotateObjectSpace` 之后再写 `angles`【确；数值差为 `sim.py` 推算】
- 任何写入都经 `FUN_1401dd630` 按新角度重建 3×3：乘出来的矩阵被丢掉。
- `thisLayer.angles = thisLayer.angles`：dll 先 `f32(弧度 × 57.29578f)` 给脚本，写回时 `f32(度 × 0.017453292f)`，再重建。和乘出来的矩阵差在末位。`sim.py` 的例子（从 0 角度 `rotateObjectSpace(new Vec3(0.3, 0.2, 0.1))`）：

| 元素 | 乘出来的 | 按反算角度重建 |
|---|---|---|
| `M[0][2]`（`m[2]`） | `-0.19866932928562164` | `-0.19866931438446045` |
| `M[1][0]`（`m[4]`） | `-0.036957018077373505` | `-0.0369570218026638` |
| 其余 7 个 | 相同 | 相同 |

- 同一帧里的先后：关键帧动画在 `update` 之前写 `angles`，所以 `update` 里调的 `rotateObjectSpace` 当帧生效、下一帧被动画覆盖；挂在 `angles` 上的字段脚本 `update(value){ return value; }` 会在它那一轮把反算出来的角度写回去、触发重建（末位变化）。

## 3. `lookAt` / `lookAtYaw`

### 3.1 参数【确】
- 方法表：两个参数都是 `0x20`（Vec3）。第一个参数缺省或不是对象时 dll 填零向量（类型码 `0x80000020`），**exe 不看第一个参数的类型码**，所以 `lookAt()` 等于看向 `(0, 0, 0)`。
- 第二个参数 `up`：exe 先比 `类型码₁ < 0`（`0x1401dfc0b` `cmp dword ptr [r8 + 0x4], 0` → `jl`），缺参数或不是对象都落到缺省 `(0, 1, 0)`。

### 3.2 `glm::lookAtRH(eye, center, up)`（`FUN_14019d920`）【确：`0x14019d93a`–`0x14019db17`】
```
f   = center - eye                                   // 逐分量
inv = 1.0f / sqrt((f.x*f.x + f.y*f.y) + f.z*f.z);  f = (f.x*inv, f.y*inv, f.z*inv)
s.x = up.z*f.y - up.y*f.z
s.y = up.x*f.z - up.z*f.x
s.z = up.y*f.x - up.x*f.y
inv = 1.0f / sqrt((s.x*s.x + s.y*s.y) + s.z*s.z);  s = s*inv
u.x = f.z*s.y - f.y*s.z
u.y = f.x*s.z - f.z*s.x
u.z = f.y*s.x - f.x*s.y
V（列主序）：V[0] = (s.x, u.x, -f.x)，V[1] = (s.y, u.y, -f.y)，V[2] = (s.z, u.z, -f.z)，平移列另算（这里不用）
```
- 右手系（`Result[i][2] = −f`）。`Vᵀ` 的三列 `s`、`u`、`−f` 就是物体的本地 X、Y、Z 轴。

### 3.3 `lookAt(center, up)`（`FUN_1401dfc00`）【确】
```
o  = O+0x128                                         // 本地 origin
up = 第二参 ? 它 : (0, 1, 0)
d  = center - o                                      // 逐分量
c′ = (O->vt[0x60]() == 8) ? center                   // 相机：-Z 对着目标
                          : (o.x - d.x, o.y - d.y, o.z - d.z)   // 其它：镜像，+Z 对着目标
if !(((d.x*d.x + d.y*d.y) + d.z*d.z) > 1.1920929e-07f) return    // 0x1404925e0；d 含 NaN 时比较为假，也返回
(s, u, f) = lookAtRH(o, c′, up)                      // 注意 f 由 c′ − o 重新算，镜像时不一定逐位等于 −d
z  = atan2f(s.y, s.x)                                // V[1][0], V[0][0]
S1 = sinf(z);  C1 = cosf(z)
y  = atan2f(-s.z, sqrt((-f.z)*(-f.z) + u.z*u.z))     // -V[2][0]; V[2][2]² + V[2][1]²
x  = atan2f(S1*(-f.x) - C1*(-f.y), C1*u.y - S1*u.x)  // S1·V[0][2] − C1·V[1][2]，C1·V[1][1] − S1·V[0][1]
FUN_1401dd630(O, (x, y, z))                          // 写角度、按角度重建 3×3、O+0xd0 = 0
```
- `vt+0x60` 是类型码：基础对象 0、粒子 2、模型 5、灯 6、声音 7、**相机 8**（`0x1401f1a20`）、形状 10（各类虚表 `+0x60` 槽，`vtdump.py`）。图像层、文本层没单独核对，不是 8【推】。
- 写的字段：`angles`、3×3（由角度重建，**不是 `Vᵀ` 本身**）、`O+0xd0`。`origin`、`scale` 不动；不通知绑定。
- 有父对象：不处理。`center` 必须按父的本地坐标给；结果是**相对父**的朝向。在世界里它指向 `W_父 · center` 的条件是父的变换不含非均匀缩放【推，数学】。
- 退化：
  - 目标与 `origin` 重合（`|d|² ≤ FLT_EPSILON`）：什么也不做，角度保持原值。
  - 视线与 `up` 平行（缺省 `up` 下看正上方 / 正下方，或 `up = (0, 0, 0)`）：`s = 0`，`1/0 = inf`，`0·inf = NaN`，角度与 3×3 全是 NaN（`sim.py` 的 L3b）。exe 没有防护。
- 二维正交场景里的含义：图层的 +Z 原本对着相机，`lookAt` 一个和图层同一 z 的点会把图层转成侧对相机（例如看向右边得到 `(0, 90°, 0)`）；看向背后得到 `(180°, 0, 180°)`，按缺省背面剔除可能不画【推】。

### 3.4 `lookAtYaw(center, up)`（`FUN_1401dfe30`）【确】
```
o  = O+0x128;  up = 第二参 ? 它 : (0, 1, 0)
d  = center - o
k  = (up.x*d.x + up.y*d.y) + up.z*d.z                // up 不归一化
d′ = (d.x - up.x*k, d.y - up.y*k, d.z - up.z*k)
c′ = (相机) ? (o.x + d′.x, o.y + d′.y, o.z + d′.z)
            : (o.x - d′.x, o.y - d′.y, o.z - d′.z)
if !(((d′.x*d′.x + d′.y*d′.y) + d′.z*d′.z) > 1.1920929e-07f) return
其余同 lookAt（lookAtRH(o, c′, up) → 取角度 → FUN_1401dd630）
```
- 单位 `up` 下视线与 `up` 正交，不会出 NaN；目标正好在 `up` 方向上时 `d′ ≈ 0`，走退化分支、什么也不做（不是 NaN）。
- `up` 不是单位长度时投影不对（`d′` 不再与 `up` 正交），结果会带俯仰（`sim.py` 的 Y3b）。

## 4. `setMaterialProperty(名, 值)`

### 4.1 exe：`FUN_1401ee1d0`【确：`smp_1401ee1d0.asm`】
```
for pass in effect.passes:                          // effect+0xd0..0xd8，步长 0x30
    mat = pass+8;  if !mat: continue
    d = mat->vt[0x20](名);  if !d: continue          // FUN_140159900
    t = 类型码₁ & 0x7fffffff                          // btr eax, 31：缺参数的缺省值也照常当这个类型
    switch t:
      case 4 (float):  v = x;  if (d.flags & 4) v = v * 0.017453292f      // 0x140492628
                       d.type == 0 ? 写 cvttss2si(v) : d.type == 4 ? 写 v : 跳过
      case 8 (int):    d.type == 0 ? 写 i
                       : d.type == 4 ? { v = (float)i; if (d.flags & 4) v = v * 0.017453292f; 写 v } : 跳过
      case 0x10:       d.type == 1 ? 写 (x, y)       : 跳过
      case 0x20:       d.type == 2 ? 写 (x, y, z)    : 跳过
      case 0x40:       d.type == 3 ? 写 (x, y, z, w) : 跳过
      其它:             跳过
    「写」= d->原生setter(mat, d, &v)                  // [d+0x18]
```
- 对 effect 的**每个 pass** 各查各写，一个 pass 类型不配不影响别的 pass。
- 参数登记：`0x1401f0085`–`0x1401f00af`，名字 `0x200`、值 `0x7c`。

### 4.2 材质的按名查找 `vt+0x20` = `FUN_140159900`【确】
- 材质对象（`FUN_1401515b0` 分配 0x318 字节，虚表 `0x14048b710`；`+0x10` = `0x140159a70` 列举、`+0x20` = `0x140159900` 查找）。
- 查找：名字 FNV-1a 散列，先查**类静态表**（`0x1404e7fd0`，`0x1401577c0`–`0x140157c5c` 登记），再查**实例表** `mat+0x48`（`unordered_map`：链表头 `+0x50`、桶 `+0x60`、掩码 `+0x78`）。比较用 `FUN_14000d010`（`std::string` 与 C 串全等，**区分大小写**）。返回节点 `+0x30` 的描述符。
- 静态表只有 5 项，全是类型 5（字符串），偏移 `0x1f0`–`0x1f4`：`blending`、`alphawriting`、`depthtest`、`depthwrite`、`cullmode`（`0x14048b638` / `6c0` / `6b0` / `6a0` / `690`）。`setMaterialProperty` 对它们永远类型不配。
- 实例表由材质加载 `FUN_140154480` 末尾建（`0x1401553cb`–`0x1401554fc`）：遍历着色器的合并常量表（按**材质键**存，见 `vector-constant-REPORT` 2.1），每个材质键一个描述符：
  - 名字 = 材质键（注解 `"material": "<键>"` 的原串，可以有大写、空格，如 `Speed X`、`ui_editor_properties_direction`）；
  - 偏移 `0x120 + 4·槽位`；
  - 类型按合并类型 1 / 2 / 3 / 4 → 描述符类型 **4 float / 1 vec2 / 2 vec3 / 3 vec4**；原生 setter `0x1401a49f0` / `0x1401a4200` / `0x1401a4530` / `0x1401a4900`，getter `0x1401a4a10` / `4220` / `4560` / `4920`；
  - 改值回调 `0x1401538c0`；注解 `"conversion": "rad2deg"` 的（条目标志 `0x20`）置描述符角度位 `+0x30 |= 4`。
  - **没有 int 类型**的材质描述符；uniform 名（`g_TintColor`）不是键。
- 同一张表的另外两个用户：
  - `constantshadervalues`：建完描述符后 `FUN_1401730d0(SM, mat, mat+0x248)`（`0x1401555d0`）逐键 `mat->vt[0x20](键)`（`dec-script/functions/0x1401730d0.c` 第 58 行）。
  - 脚本字段：包装 `W` 按 `vt+0x10` 列出描述符建属性（rea-p6d-script 第 6 节）；材质的 `vt+0x10`（`0x140159a70`）先列静态表、再列实例表。所以 `getMaterial(i).<键>` 和常量脚本的 `thisObject.<键>` 用的是同一批描述符与同一个原生 setter。

### 4.3 dll：`0x7c` 的值怎么转【确：`methodcall_214a0.asm`】
- `M` 对每个参数按固定顺序试，第一个成立的就用：

| 顺序 | 位 | 判定 | 结果 |
|---|---|---|---|
| 1 | `0x200` | 字符串 | — （`0x7c` 没有这一位） |
| 2 | `0x2` | 布尔 | — |
| 3 | `0x8` | `IsInt32`（`0x180017040`） | 类型码 8，`ToInt32` |
| 4 | `0x4` | `IsNumber` | 类型码 4，`f32` |
| 5 | `0x400` | 对象 | — |
| 6 | **`0x10`** | **对象**（`0x180016c40`，`0x181621b21`–`0x181621cb3`） | **类型码 `0x10`，只取 `x` `y`**（`[r13+0x10]`、`[r13+0x18]` 两个名字，与 Vec3 助手 / Vec4 分支同一张名字表的前两项） |
| 7 | `0x20` | 对象 | 到不了：对象在第 6 步已经被拿走 |
| 8 | `0x40` | 对象 | 到不了 |

- 都不成立（字符串、布尔、`null`、`undefined`、缺参数）时按掩码里最先的一位放零值：`0x7c` 的顺序是 `0x400 → 2 → 8 → …`（`0x1816228b7`–`0x181622a42`），落在 **`0x80000008`、整数 0**。exe 去掉最高位后当整数 0 处理，float 常量被写成 0。
- 于是 `setMaterialProperty` 的实际效果：

| 传入 | 到 exe | float 常量 | vec2 常量 | vec3 / vec4 常量 |
|---|---|---|---|---|
| 整数（`1`、`0`、`-3`） | 8 | `(float)i`（带 `rad2deg` 的 `× 0.017453292f`） | 不写 | 不写 |
| 其它数（`0.5`、`-0`、`1e10`、`NaN`） | 4 | `f32(x)`（同上） | 不写 | 不写 |
| `Vec2` / `Vec3` / `Vec4` / `{x, y}` / 数组 | `0x10` | 不写 | `(x, y)`（不是数的分量为 0，数组得 `(0, 0)`） | **不写** |
| 字符串、布尔、`null`、`undefined`、缺参数 | 8（值 0） | **写 0** | 不写 | 不写 |

- 第一个参数不是字符串时落成空串 `""`，查不到，什么也不写。

### 4.4 写进去以后【确】
- 原生 setter（例如 vec3 的 `0x1401a4530`）把值拷到 `mat + 偏移`，然后尾调 `[d+0x28]` = `0x1401538c0`：`mat+0x1f8 |= 3`。
- 材质绑定时（`0x14015712e`–`0x140157157`）看到 `+0x1f8` bit0 就把 `mat+0x120` 起的常量块重传、清掉 bit0。脚本（帧内第 7 步）在渲染（第 8 步）之前，所以当帧画出来就是新值。
- 之后谁会改它（都走同一个描述符）：
  - **关键帧动画**绑在这个常量上：每帧在 `update` 之前写（rea-p10 第 52 行），`update` 里 `setMaterialProperty` 的值只活这一帧。
  - **常量上挂的字段脚本**：每帧 `update(value)` 的返回值经原生 setter 写回；`value` 是 dll 用 getter 现读的当前值（rea-p10 第 445 行），所以 `return value` 原样写回、不覆盖；返回缓存的旧值才会覆盖。
  - **`{user}` / `usershadervalues` 绑定**：只在属性变化时写（排在渲染之后）。
- 没有每帧按 JSON 重写常量的路径（`constantshadervalues` 只在材质加载时套用）。

### 4.5 那次实验【确】
- `fx.setMaterialProperty('color', new Vec3(0, 1, 0))`：dll 第 6 步把 `Vec3` 当成 Vec2，到 exe 是类型码 `0x10`、值 `(0, 1)`；`color` 的描述符类型是 2（vec3），`0x10` 只配 1 → 跳过。读回与画面都不变。
- `fx.setMaterialProperty('g_TintColor', …)`：`vt+0x20` 只认材质键与 5 个 pass 状态名，查不到 → 跳过（就算查到，`0x10` 也配不上 vec3）。
- 挂在 `color` 上的 `update(value){ return value; }`：每帧原样写回当前值，不会把 `setMaterialProperty` 写的值改回去；而且这里根本没有写进去。不是干扰。
- `fx.getMaterial(0).color = new Vec3(0, 0, 1)`：dll 字段写入按描述符类型（vec3）取 `x y z`，经同一个原生 setter 写入并标脏，所以读回与画面都变。
- 结论：WPE 2.8.42 的 `setMaterialProperty` **对 vec3 / vec4 常量不生效**，原因在 dll 的参数转换顺序；exe 本身能写 vec3（类型码 `0x20` 时），只是 dll 永远送不来。d.ts 写的 `value: Number|Vec2|Vec3|Vec4` 与实际不符。

## 5. 对实现的含义（给 P6d1）
- 图层状态要多一份**旋转 3×3**：`angles` 的任何写入按 `FUN_1401dd630` 的 f32 公式重建它；`rotateObjectSpace` 直接写它并反算 `angles`；世界矩阵与 `getTransformMatrix` 只读它。现在「每次由 `angles` 现算 `Rz·Ry·Rx`」在没有 `rotateObjectSpace` 时等价。
- `rotateObjectSpace` 的参数按**弧度**、不换算；`lookAt` / `lookAtYaw` 的目标在**父的本地空间**；相机对象 −Z、其它对象 +Z 对着目标。
- `setMaterialProperty` 若照 WPE：值是对象时一律只当 Vec2 处理；非数非对象写 0 进 float 常量；名字按材质键、区分大小写；对全部 pass。是否照搬「vec3 / vec4 不生效」，建议先跑实测 S4 确认再定。

---

## 未查清
1. `0x14022699c`（粒子代码区经 `FUN_140225900` 写角度）是什么功能、会不会作用于普通图层。
2. 材质绑定重传常量的那个函数（`0x14015712e` 一带）的入口与调用时机没定名；`+0x1f8` bit1 的含义。
3. effect 可见性切换、合成次数变化导致「重建图层」时，材质对象是否重建（若重建，`setMaterialProperty` 写的值会不会丢）。
4. dll 名字表 `[ctx+0x10..0x28]` 的四个串没逐个读出，按用法认定是 `x y z w`。
5. CRT `cosf` / `sinf` / `atan2f` 与「double 算再取 f32」是否逐位相同（预期读回的末位可能差 1 ulp）。
6. 图像层、文本层的 `vt+0x60` 返回值没逐个读（只用于判断「是不是相机」）。

## 建议的 WPE 实测
通用：正交 1920×1080，`kbp gen` 生成，带 FR 帧号图层；脚本里 `const log = (...a) => console.error('[kbp]', ...a);` 写进 `log.txt`（`log_mark` / `log_since`）；向量打印 `v.x + ' ' + v.y + ' ' + v.z`（不要 `toFixed`，看全精度）；被测图层不挂动画、不绑属性。下面的「预期」由 `sim.py` 按读码算出，末位可能差 1 ulp（未查清 5）。角度读回单位是度。

### A. `setMaterialProperty`（最优先，要能干净地判定生不生效）
被测图层 L 带两个 effect：`effects/tint`（材质键 `color` vec3、`alpha` float，**常量上不挂任何脚本**）与 `effects/blur`（4 个 pass，pass 1、2 有 vec2 `scale`，pass 0、3 没有）。L 的 `origin` 挂脚本，`init` 里依次做，每做一步立刻读回；每步之间把值复原。另在第 1 帧抓一张 RenderDoc 帧看 tint pass 的常量缓冲。
```js
const t = thisLayer.getEffect(0), b = thisLayer.getEffect(1);
const m = t.getMaterial(0);
const v3 = (v) => v.x + ' ' + v.y + ' ' + v.z;
log('S0', v3(m.color), m.alpha, Object.keys(m).join(','));
t.setMaterialProperty('alpha', 0.25);  log('S1', m.alpha);          // 预期 0.25
t.setMaterialProperty('alpha', 1);     log('S2', m.alpha);          // 预期 1（整数路径）
t.setMaterialProperty('alpha', '0.5'); log('S3a', m.alpha);         // 预期 0（!）
t.setMaterialProperty('alpha', 1);
t.setMaterialProperty('alpha', true);  log('S3b', m.alpha);         // 预期 0
t.setMaterialProperty('alpha', 1);
t.setMaterialProperty('alpha');        log('S3c', m.alpha);         // 预期 0
t.setMaterialProperty('alpha', 1);
t.setMaterialProperty('color', new Vec3(0, 1, 0)); log('S4a', v3(m.color));   // 预期不变（1 0 0）
t.setMaterialProperty('color', new Vec4(0, 1, 0, 1)); log('S4b', v3(m.color)); // 预期不变
t.setMaterialProperty('color', 0.5);   log('S4c', v3(m.color));     // 预期不变
t.setMaterialProperty('g_BlendAlpha', 0.25); log('S6a', m.alpha);   // 预期 1（uniform 名查不到）
t.setMaterialProperty('Alpha', 0.25);  log('S6b', m.alpha);         // 预期 1（区分大小写）
b.setMaterialProperty('scale', new Vec3(0.3, 0.7, 9));
log('S5a', [0, 1, 2, 3].map(i => { const s = b.getMaterial(i).scale; return s ? s.x + ' ' + s.y : 'none'; }).join(' | '));
// 预期 none | 0.30000001192092896 0.699999988079071 | 同左 | none
b.setMaterialProperty('scale', { x: 0.5, y: 0.25 }); log('S5b', b.getMaterial(1).scale.x, b.getMaterial(1).scale.y);  // 预期 0.5 0.25
b.setMaterialProperty('scale', [2, 3]); log('S5c', b.getMaterial(1).scale.x, b.getMaterial(1).scale.y);               // 预期 0 0
```
- 判定：S1 / S2 生效、S4 全不变、S5a 两个 pass 都变，即证实「float 与 vec2 生效、vec3 / vec4 不生效」，与常量上有没有脚本无关。S3 读回 0 证实缺省整数 0 的路径。
- 画面：S1 之后不复原、停在 `alpha = 0.25` 抓一帧，tint pass 常量缓冲里 `g_BlendAlpha = 0.25`、`g_TintColor` 仍为 `1 0 0`。
- 补测 S7（角度常量）：图层换 `effects/chromaticaberration`（材质键 `ui_editor_properties_direction`，float，`rad2deg`）：先读 `getMaterial(0)['ui_editor_properties_direction']`（预期约 90，缺省 π/2 经 dll 换成度），`setMaterialProperty(该键, 45)` 后读回预期 45、常量缓冲里 `u_Direction = 0.7853982`；若读回 2578.31（≈ 45 弧度换成度）则说明没有换算。
- 补测 S8（覆盖）：在 `alpha` 上挂关键帧动画（常值 0.8），A 的 `update` 在帧 N 调 `setMaterialProperty('alpha', 0.1)` 并读回；抓 N、N+1 两帧。预期第 N 帧读回 0.1、画面 0.1，第 N+1 帧回到 0.8。

### B. `rotateObjectSpace`
图层 R（`origin 960 540 0`、`scale 1 1 1`、无父），`init` 里做，每步前把 `angles` 设回对应初值。
```js
const a3 = () => { const v = thisLayer.angles; return v.x + ' ' + v.y + ' ' + v.z; };
const mm = () => thisLayer.getTransformMatrix().m.slice(0, 11).join(' ');
thisLayer.angles = new Vec3(0, 0, 0);
thisLayer.rotateObjectSpace(new Vec3(0.3, 0.2, 0.1)); log('R1', a3(), mm());
thisLayer.angles = new Vec3(0, 0, 0);
thisLayer.rotateObjectSpace(new Vec3(0, 0, 90));      log('R1c', a3());
thisLayer.angles = new Vec3(0, 0, 30);
thisLayer.rotateObjectSpace(new Vec3(0.5, 0, 0));     log('R2', a3(), mm());
thisLayer.angles = thisLayer.angles;                  log('R3', a3(), mm());
```
- R1 预期 `angles` = `17.18873405456543 11.459155082702637 5.729578018188477`（若参数按度：`0.3 0.2 0.1`；若轴顺序是 x → y → z：`18.4842 9.1689 8.9622`）。矩阵 `m[0..2] = 0.975170373916626 0.09784340113401413 -0.19866932928562164`，`m[4..6] = -0.036957018077373505 0.956425130367279 0.2896294891834259`，`m[8..10] = 0.21835066378116608 -0.2750958502292633 0.9362934231758118`。`m[2]`、`m[4]` 若是 `-0.19866931438446045`、`-0.0369570218026638`，说明 WPE 实际按反算角度重建了矩阵（与读码不符）。
- R1c 预期 `0 -0 116.62015533447266`（90 弧度归一化后），证实单位是弧度。
- R2 预期 `28.647890090942383 -0 30.000001907348633`；矩阵 `m[0..2] = 0.8660253882408142 0.5 0`、`m[4..6] = -0.43879127502441406 0.7600087523460388 0.4794255495071411`、`m[8..10] = 0.23971277475357056 -0.41519469022750854 0.8775825500488281`。若是绕世界轴（左乘）会得到约 `25.32 -13.87 26.87`。
- R3（写回自己）后角度不变、矩阵末位可能变。
- 补测 R4（归一化）：scene.json 里 R 的 `angles` 写 `"0 0 6.981317"`，`init` 先读（预期 `0 0 400`），再 `rotateObjectSpace(new Vec3(0, 0, 0))` 读（预期 `0 -0 40.000003814697266`），再 `rotateObjectSpace(5)` 读（预期同上）。
- 补测 R5（子对象当场跟随）：R 下挂子层 C（`origin 100 0 0`），`init` 里先读 `C.getTransformMatrix().m[12..13]`（预期 `1060 540`），R 调 `rotateObjectSpace(new Vec3(0, 0, Math.PI / 2))` 后立刻再读（预期约 `960 640`）。
- 补测 R6（动画覆盖）：R 的 `angles` 挂关键帧动画，`update` 在帧 N 调 `rotateObjectSpace`；预期帧 N 画面转了、帧 N+1 回到动画值。

### C. `lookAt` / `lookAtYaw`
图层 K（`origin 960 540 0`、无父），另有父子对 P（`origin 500 300 0`、`angles` 绕 z 90°）/ Q（`origin 100 0 0`），一个相机对象 Cam（`origin 960 540 0`，可选）。每步前把 `angles` 设回 0。
```js
const a3 = (o) => { const v = o.angles; return v.x + ' ' + v.y + ' ' + v.z; };
const K = thisScene.getLayer('K'), Q = thisScene.getLayer('Q'), Cam = thisScene.getLayer('Cam');
K.lookAt(new Vec3(960, 540, 1000));    log('L1',  a3(K));   // 预期 0 -0 -0
K.lookAt(new Vec3(960, 540, -1000));   log('L1b', a3(K));   // 预期 180 -0 180
K.lookAt(new Vec3(1060, 640, 500));    log('L2',  a3(K));   // 预期 -11.095804214477539 11.309932708740234 0
K.angles = new Vec3(0, 0, 30);
K.lookAt(new Vec3(960, 540, 0));       log('L3',  a3(K));   // 预期 0 0 30（不动）
K.lookAt(new Vec3(960, 640, 0));       log('L3b', a3(K));   // 预期 NaN NaN NaN，图层消失
K.angles = new Vec3(0, 0, 0);
K.lookAt();                            const z1 = a3(K);
K.angles = new Vec3(0, 0, 0);
K.lookAt(new Vec3(0, 0, 0));           log('L7', z1 === a3(K));   // 预期 true（缺参数 = 看原点）
Q.lookAt(new Vec3(200, 100, 500));     log('L4',  a3(Q));   // 预期同 L2：-11.0958… 11.3099… 0（目标在父空间，不受 P 的旋转影响）
K.lookAtYaw(new Vec3(1060, 590, 300)); log('Y1',  a3(K));   // 预期 0 18.434947967529297 0
K.angles = new Vec3(0, 0, 0);
K.lookAt(new Vec3(1060, 590, 300));    log('Y1b', a3(K));   // 预期 -8.984877586364746 18.434947967529297 0
K.angles = new Vec3(0, 0, 30);
K.lookAtYaw(new Vec3(960, 640, 0));    log('Y2',  a3(K));   // 预期 0 0 30（不动，不是 NaN）
K.angles = new Vec3(0, 0, 0);
K.lookAtYaw(new Vec3(1060, 590, 300), new Vec3(0, 2, 0)); log('Y3', a3(K));   // 预期 25.37693214416504 18.434947967529297 0
Cam.lookAt(new Vec3(1060, 640, 500));  log('L6',  a3(Cam)); // 预期 -168.90420532226562 -11.309932708740234 180（-Z 对着目标）
```
- 每条之后顺带读 `K.origin`（预期不变）与 `K.getTransformMatrix().m[8..10]`（本地 +Z 方向；L2 预期约 `0.1925 0.1925 0.9623`，即 `normalize(100, 100, 500)`）。
- L1b、L3b 各抓一帧看图层画不画（背面剔除、NaN）。
- 避开的写法：目标与 `origin` 同 z、只差 x 或 y 的组合（如看向正右方）会落在 `y = ±90°` 的万向节锁上，`x`、`z` 取决于零的符号，读回不适合逐位比，只看 `y`。
