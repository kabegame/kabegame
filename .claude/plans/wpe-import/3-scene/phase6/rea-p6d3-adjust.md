> 读码记录（代理，2026-11-15），exe 地址按 Ghidra 基址 `0x140000000`。目标 `wallpaper64.exe` 2.8.42（SHA-256 前缀 `40e2ce021e935232`），REA 带 p6d 快照打开，汇编核对 f32 运算顺序。工作文件 `ignore/p6/rea/layers/adjust/`：复算脚本 `sim_adjust.py`，汇编切片 `de750.asm`、`world_1401850a0.asm`、`rigid_1401dd7d0.asm`、`inv_14005f730.asm`、`mul_14005ecb0.asm`、`len4_1401e24b0.asm`。复算对 P6d3 步骤 0 的日志（`ignore/p6/d3/out/wpe-parent.log` 的 s5 b、s5 c、s2）逐位相同，只有零的符号看不出。

# `setParent(parent, attachment, adjust)` 的 adjust 分支、组判定与组深度（`FUN_1401de750`）

**更正 rea-p6d-layers 9.4**：「世界变换保持」不总成立。保持的只有三样：
- 平移；
- 世界矩阵每一列的长度；
- 「刚体」意义下的旋转（祖先的缩放不参与）。

新父链带非均匀缩放、相对角度又不为 0 时，世界矩阵里的剪切会丢掉（实测 s5 的 a → b 世界矩阵变了）。

## 1. adjust 为真、没有挂点（attach < 0）【确】

全程 f32，SSE 标量或打包运算，没有 FMA，每步舍入；矩阵列主序 `m[4c + r]`。
```
// 前面已从旧父的子表删掉 O、组深度检查已通过
WP = P ? world(P) : I        // world = FUN_1401850a0，基类世界矩阵（不走 vt+0x80：不含图像层 alignment、文本框偏移）
WO = world(O)                // 旧父下
L  = inv(WP) · WO            // inv = FUN_14005f730（glm compute_inverse），乘 = FUN_14005ecb0
RP = P ? rigid(P) : I        // rigid = FUN_1401dd7d0：每级只取 3×3（O+0x14c）与 origin，过挂点（父 vt+0x78），不乘 scale
RO = rigid(O)
Rr = inv(RP) · RO
s0 = O.scale; O.scale = (1,1,1); 标脏
W1 = world(O)                // 旧父、旧 3×3、旧 origin、自身缩放 1
O.parent = P; O.attach = attach; 标脏
O.origin = (L[12], L[13], L[14])
z = atan2f(Rr[1], Rr[0])                                   // glm extractEulerAngleZYX
y = atan2f(-Rr[2], sqrtf(Rr[6]² + Rr[10]²))
sz = sinf(z); cz = cosf(z)
x = atan2f(Rr[8]·sz − Rr[9]·cz, Rr[5]·cz − sz·Rr[4])
O.angles = (x, y, z)         // 弧度，先写角度
O.rot = Rz·Ry·Rx 按角度重建（式子同 FUN_1401dd630，z 的 sin / cos 复用上一步）
lo_i = len4(W1 第 i 列)      // len4 = sqrt((v0²+v1²)+(v2²+v3²))
W2 = world(O)                // 新父、新 3×3、新 origin、缩放 1
ln_i = len4(W2 第 i 列)
O.scale_i = (s0_i · lo_i) · (ln_i > FLT_EPSILON ? f32(1 / ln_i) : 1)
```
- **矩阵乘** `FUN_14005ecb0(A, B) = A·B`：每个元素是 `((a0·b0 + a1·b1) + a2·b2) + a3·b3`。
- **求逆**：glm `compute_inverse`（Coef / Fac / Vec / Sign）。行列式按 `(x+y)+(z+w)` 成对相加，再 `1/det` 逐元素相乘。Ghidra 伪代码把行列式的结合顺序打印错了，以汇编为准。
- **世界矩阵**：第 j 列 = `scale[j] · rot 第 j 列`（每分量一次乘法），平移是 origin，再左乘 `W_父`（挂点 ≥ 0 时先过 `vt+0x78`）。
- **效果**：
  - 新的局部旋转 = 父链刚体旋转的逆 × 自身链刚体旋转，祖先的缩放不计；
  - 新世界矩阵每列的长度等于旧的。
- **对照**：按 L 自己分解，z 会是 −0.472、列长 (0.544, 1.465)，与实测不符。
- **复算**：s5 的 b、c 与 parent s2 的 origin / angles / scale / 世界矩阵与日志逐位相同（只差 ±0）。

## 2. adjust 为真、带挂点（attach ≥ 0）【确】（`0x1401df0cd`–`0x1401df255`）

L、Rr、W1 照样算，但不用：
```
O.angles = (0,0,0); O.origin = (0,0,0); O.scale = s0（恢复原值，不修正）; O.rot = I（按 0 角重建）
```
本地变换变成单位阵（缩放 s0），世界矩阵 = `W_父 · Att · diag(s0)`，**不保持**。

- 实测 0.3 rad 来自挂点本身（P12 报告：`tipB = 骨骼0 · T(0,−30)·Rz(0.3)`），不是保留了旋转。
- s2 与 s3 平移不同，是骨骼 0 随时间在动。
- attach 的 s4（`c_img` 从 tipA 改挂同一个父、不带挂点、adjust）走第 1 支：origin = 世界平移 − (700, 500)，与日志相同；世界 3×3 差 1 ulp，是「反算角度再重建」带来的。

## 3. 组判定与组深度【确】

- **组**：`O+0x120` bit2。只在图像层构造函数尾 `0x1401fb35f` 按模型 JSON 的 `passthrough: true`（只认 JSON 布尔）置位，与有没有子层、effect、blend、copybackground 无关。
  - 算组的：composelayer、composelayer_depthtest、fullscreenlayer、projectlayer。
  - 不算的：solidlayer、文本、粒子、声音、灯、相机。
  - 没有写入会清掉它。
- **检查**（`0x1401de811`，`FUN_1401ddb50`）：
  ```
  失败 ⇔ O == P 或 up(P) + down(O) ≥ 4
  up(P)   = 从 P 本身沿父链走到根，带 bit2 的对象个数（P 为空时 0）
  down(X) = bit2(X) + max(down(c) 对 X 的每个子对象 c)（没有子对象时 max 项为 0）
  ```
  实测四例都对上：R3→K3 是 3 + 0；Z0→K3 是 3 + 1 = 4，失败；Z→K3 是 3 + (1 + 0) = 4，失败；Z→K2 是 2 + 1，成功。
- **时序**：
  1. 「父与挂点都没变」直接返回真，在检查之前。
  2. 「从旧父的子表删掉 O」也在检查之前，所以失败时 O 已离开旧父。
  3. 失败时父置空、挂点 −1、父 id 0、清自己的 bit1（由组画），子对象的 bit1 重新传播；本地字段不动（不论 adjust），画面会跳。dll 报 `Invalid parent configuration.`。
  4. 成功后两支都先写 `angles`、再按角度重建 3×3；origin 直接写、不经 setter；最后标脏，有父调 `FUN_1401dda60`（挂进子表），无父调 `FUN_1401dd9a0`。
- **没有成环检测**：挂到自己的子孙下，只要深度不超限就真的成环。实测 WPE 整个进程崩溃（日志停在调用前）。

## 4. 未查清 / 置信度
- 【推】`sinf` / `cosf` / `atan2f` 复算时用「double 算再取 f32」代替 CRT，本例全部相同，别的输入可能差 1 ulp。
- 【确】挂点矩阵经父的 `vt+0x78` 原地作用，刚体链与世界链各过一次。挂点一支没有逐位复算矩阵（缺骨骼姿势）。
- 【推】adjust 用的是基类世界矩阵。图像层 `alignment ≠ center` 或文本层时，`getTransformMatrix` 比它多一段偏移，没有实测。
