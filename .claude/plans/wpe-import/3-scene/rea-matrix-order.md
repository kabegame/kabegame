# REA：MVP 的 f32 运算顺序与四边形的三角形对角线（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出，只做静态分析，没有运行、附加或启动 WPE，没有碰 Steam 目录。地址一律是镜像基址 `0x140000000` 下的虚拟地址。
> 标记：【确】反汇编直接看到；【推】由代码推出、或依赖没逐行读的代码；**未确认** 写明原因。
> 矩阵记法：WPE 用的是 **glm**（断言字符串 `D:\dev\we\windows\src\lib\include\glm\detail\type_mat4x4.inl`，`FUN_14005f5b0` 是 `mat4::operator[]`），内存是列主序、列向量约定，平移在内存 12..14。这和我们 `render/math.ts` 的存储（`m[c*4+r]`）**逐字节相同、数学含义也相同**。下文所有公式都直接写内存下标 `m[0..15]`，不再分行列向量；需要时另注 rea-p5-camera 那套「行向量」说法。

## 总结

1. **4×4 乘法。** `FUN_14005ecb0(out, X, Y)` 与 `FUN_14024f0e0(out, X, Y)`（`rdx = X`、`r8 = Y`）逐元素公式完全相同：`out[c*4+r] = ((( X[r]·Y[4c] + X[4+r]·Y[4c+1] ) + X[8+r]·Y[4c+2] ) + X[12+r]·Y[4c+3] )`，每个乘积、每次加法都是 f32 舍入（`mulps` / `addps`），**k 从 0 到 3 依次左结合**，没有 FMA、没有 double。它就是我们的 `multiply(X, Y)`，只差逐步 `fround`。两个函数只是寄存器分配不同（前者 2 宽、后者 4 宽）。【确，两个函数都做了符号执行】
   **但 MVP 链上真正用的不是它。** `g_ModelViewProjectionMatrix` 与 `g_ViewProjectionMatrix` 由 `FUN_1400d4200` 算，图像 / 文本层把世界矩阵并进模型栈也是同一种写法（内联在 `FUN_1401e8aa0`）：DirectXMath `XMVector3Transform` 式的**仿射乘法**，求和顺序是 **k = 2 → (3) → 1 → 0**，右乘数的第 3 列（内存 3 / 7 / 11 / 15）不读、当作 (0,0,0,1)。另有几处 glm::translate / glm::scale 的内联（zoom、视差、anchor、字形平移、对齐偏移），各有自己的顺序，见第 1.3 节。【确】
2. **一次图像 / 文本 draw 的 MVP。** `MVP = M·(V·P)`（我们的写法 `mulAffine(mulAffine(P, V), M)`）：`FUN_1400d4200` 每次先由 V、P 重算 VP 存 `ctx+0x930`，再由 VP 和 M 算 MVP 存 `ctx+0x8f0`，两步都是仿射乘法；只要矩阵栈有改动（`ctx+0x1ca` 脏）就两步一起重算。正交场景的 V 是 glm::lookAtRH 的结果，没有路径时（加载末尾把相机重置）**逐位是单位阵**（平移分量是 ±0）；P 由 `FUN_14009a630` 用 **f32 `divss`** 算 `2/(r−l)`、`−(l+r)/(r−l)`，`l = 0` 时平移项是 `−W/W = −1` 精确值；之后正交场景**无条件**按 glm 顺序做 `translate(W/2,H/2) · scale(z,z,1) · translate(−W/2,−H/2)`，z = 1 时 P 逐位不变（数值核对）。视差是对 V 做一次 glm::translate，抖动是在 lookAt 之前把偏移直接加到 eye 和 center 上。`g_ModelViewProjectionMatrixInverse` 用 `FUN_14005f730`（标量余子式，`1/det` 一次 `divss` 再逐元素乘），输入是 `ctx+0x8f0`。【确】
   **数值核对：** 按读出的顺序写成脚本复算抓帧的 6 个值，**全部逐位相等**（第 6 节）。
3. **模型矩阵。** 本地矩阵 `L`（`FUN_1401850a0`）**不做矩阵乘法**，按元素直接填：`L[c*4+r] = scale[c] · R[c][r]`（一次 f32 乘法），平移列就是 origin；旋转 `R` 在 `FUN_1401dd630` 里按公式填 9 个元素，`sin` / `cos` 是 MSVC CRT 的 `sinf` / `cosf`（内部 double、最后舍入成 f32），**角度为 0 时精确返回 1 和 0**。`W = W_parent · L` 用 `FUN_14005ecb0(tmp, W_parent, L)`（k = 0..3）。对齐偏移（图像层 +0x80 `FUN_1401fd3f0`、文本层 +0x80 `FUN_140256e10`）**只改平移列**：`W_al[12+r] = ((( a.x·W[r] + W[12+r] ) + a.y·W[4+r] ) + a.z·W[8+r] )`，注意 `W[12+r]` 排在第二个加。字形平移（+0xf0）、画进合成 RT 的平移（+0xe8）、anchor（+0xa8）都是 glm::translate 内联：`m[12+r] = ((( m[r]·t.x + m[4+r]·t.y ) + m[8+r]·t.z ) + m[12+r] )`。基类绘制里「`model = W ∘ model`」**不是** `FUN_14005ecb0`，而是内联的仿射乘法（`0x1401e9174`–`0x1401e922f`、`0x1401e9de6`–`0x1401e9e9b`），只有形状（`FUN_14025faf0`）调 `FUN_14005ecb0`。【确】
4. **效果矩阵。** 在 `FUN_1401e8aa0` 的合成路径（`0x1401e9582`–`0x1401e9636`）：把模型栈顶**整个换成** `W_al`（不乘、不带 anchor），重算一次 MVP 存 `this+0x344`（= `M0`），`W_al` 本身存 `this+0x384`；视差平移在 V 里，透视覆盖还没做。`FUN_1401ebf60` 每个 pass 再从这两个存值写 uniform：末 pass `g_EffectModelMatrix = W_al`、`g_EffectModelViewProjectionMatrix = M0`、`g_EffectTextureProjectionMatrix = M0` 的第 0 列 ×`Sx/2`、第 1 列 ×`Sy/2`；中间 pass 前两项也带这个缩放。`scale(w/2, h/2)` 是**逐元素直接乘**（`mulps` 一列一个标量，第 2 列乘 (1,1,1,1)），和对角阵相乘逐位等价。`Sx`、`Sy` 用浮点 `size`（`+0x2f0/+0x2f4`），不是截断后的整数。【确】
5. **四边形与索引。** 公共函数 **`FUN_1401ede30`** 建所有图层四边形：顶点 **v0 = (左, 上)、v1 = (右, 上)、v2 = (左, 下)、v3 = (右, 下)**（本地 y 向上；UV 依次 (u0,v0)、(u1,v0)、(u0,v1)、(u1,v1)），索引 u16 **`[0,2,1, 1,2,3]`**，三角形列表。**对角线是 v1–v2，即「右上—左下」**。图像层的 +0x2e0（2×2，effect 中间 pass）、+0x2e8（世界四边形，末 pass）、+0x490（直接上屏 / fullscreen）、基类 +0x2e0/+0x2e8、合成 RT 像素四边形 +0x2d8、文本背景 +0x5b0、形状的退回方块全走它；文本字形是同一顶点顺序、同一索引模式（每字 `4i + [0,2,1,1,2,3]`）。例外：形状按 `point0..3` 建、索引 `[0,2,1, 0,3,2]`（对角线 v0–v2）；粒子（非 GS）由 `FUN_140261250` 建 `[0,1,2, 0,2,3]`（对角线 v0–v2，UV (0,0)–(1,1)）；粒子 GS 路径是点列表、由着色器展开（exe 里看不到）；泛光链画的是 `R+0x58` 的**单个全屏三角形**（3 顶点、无索引），没有对角线。【确，粒子 GS 除外】

---

## 0. 方法与可信度

- **REA 没能用上。** 按要求用 `open_binary` 打开 `scratchpad\rea\wallpaper64.exe` + 快照 `wallpaper64-2.8.42-p7d.rea-snapshot`，会话打开了，但两次调用 `procedure_assembly` 都报 Ghidra 在 330 s 启动期限内没做完导入分析（`provider_timeout`，快照没有省掉重新分析）。所以本轮**没有新的 REA 分析、没有改名和注释**。结束时 `close_binary` 照常存了 `wallpaper64-2.8.42-matrix.rea-snapshot`（同目录，10.6 MB），内容就是导入的 p7d 状态，没有本轮的新增。
- **改用全量反汇编。** 仓库里已有的 `ignore\p4\rea\wp.asm`（同一个 exe 的 objdump Intel 语法全量反汇编，只读）。为确认它和本轮的副本一致，用 `llvm-objdump` 直接反汇编 `scratchpad\rea\wallpaper64.exe`（SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`）的 10 段关键区间（`FUN_14005ecb0`、`FUN_14024f0e0`、`FUN_1400d4200`、`FUN_1401ede30`、`FUN_140256e10`、`FUN_1401fd3f0` 后段、`FUN_1401850a0`、`FUN_14009a630`、`FUN_1401e8aa0` 的两段内联乘法），与 `wp.asm` 切片逐条比对，**全部相同**（`xchk.py`）。
- **符号执行。** 自写的 SSE 子集符号执行（`symex.py`：`movss/movsd/movaps/movups/movdqu/shufps/pshufd/mulps/addps/subps/divss/xorps` 等，栈槽按入口 rsp 记账），对乘法、VP/MVP、求逆三类函数输出每个结果元素的完整运算树，**加法结合顺序以运算树为准**，不靠人工读寄存器。
- **函数边界** 用 `.pdata`（`asm.py p`）。
- 工作目录 `C:\Users\Lenovo\AppData\Local\Temp\claude\97f1c4c5db8b5ee9\102a85fd-9cb7-4917-be6c-ff75f4cbbb9a\scratchpad\rea\`：
  - 工具：`asm.py`（按 pdata / 区间切 `wp.asm`）、`symex.py`、`rd.py`（读常量）、`xchk.py`、`inv_sym.py`、`verify.py`（第 6 节核对）、`order_demo.py`。
  - `decomp\`：各函数的汇编切片（`mul_14005ecb0.asm`、`mul_14024f0e0.asm`、`vp_1400d4200.asm`、`ortho_14009a630.asm`、`proj_140183a70.asm`、`zoom_14017fd20.asm`、`lookat_14019d920.asm`、`shake_140199580.asm`、`parallax_14018b00c.asm`、`world_1401850a0.asm`、`rot_1401dd630.asm`、`imgworld_1401fd3f0*.asm`、`txtworld_140256e10.asm`、`txt_f0_140258050.asm`、`txt_e8_140257d70.asm`、`anchor_1402585c0.asm`、`draw_1401e8aa0.asm`、`pass_1401ebf60.asm`、`uni_1400d8300.asm`、`inv_14005f730.asm`、`inv_1402290d0.asm`、`quad_1401ede30.asm`、`imgquad_1402066a0.asm`、`glyph_1401b2900.asm`、`bloom_140183610.asm`、`img_e8_140207b50.asm`、`img_f0_140208670.asm`、`prt_1401d2340.asm`、`sprite_14020ae*.asm`），以及运算树 `mul_14005ecb0.expr.txt`、`mul_14024f0e0.expr.txt`、`inv_14005f730.expr.txt`。
- **f32 与 JS 的等价：** 两个 f32 操作数做 `+ − × ÷ √`，先在 double 里算再 `Math.fround`，结果与 IEEE f32 单步运算逐位相同（double 的 53 位 ≥ 2·24 + 2，二次舍入无害）。所以下文的每一步都可以直接写成 `fround(a op b)`。【确，数学事实】
- **未确认：** MXCSR 的 FTZ / DAZ 没查，只影响非规格化数。

---

## 1. 4×4 乘法

### 1.1 `FUN_14005ecb0(out=rcx, X=rdx, Y=r8)` 【确】

`rdx` 按半行 `movsd` 取（`X[0..1]`、`X[2..3]`…），`r8` 逐个 `movss` 取标量再 `shufps …, 0` 广播。输出第一组（`out[0..1]`）的指令：

```asm
14005ecca: movsd  xmm3, qword ptr [rdx]          ; X[0..1]
14005ecd3: movss  xmm5, dword ptr [r8]           ; Y[0]
14005ecdd: movss  xmm6, dword ptr [r8 + 0x4]     ; Y[1]
14005ece8: movss  xmm7, dword ptr [r8 + 0x8]     ; Y[2]
14005ecfc: movss  xmm8, dword ptr [r8 + 0xc]     ; Y[3]
14005edd6: shufps xmm5, xmm5, 0x0
14005edda: mulps  xmm3, xmm5                     ; p0 = X[0..1]·Y[0]
14005edf0: mulps  xmm0, xmm6                     ; p1 = X[4..5]·Y[1]
14005ede9: mulps  xmm1, xmm7                     ; p2 = X[8..9]·Y[2]
14005edf8: mulps  xmm2, xmm8                     ; p3 = X[12..13]·Y[3]
14005edfc: addps  xmm3, xmm0                     ; p0 + p1
14005ee11: addps  xmm3, xmm1                     ; (p0 + p1) + p2
14005ee29: addps  xmm3, xmm2                     ; ((p0 + p1) + p2) + p3
14005ee3d: movsd  qword ptr [rcx], xmm3          ; out[0..1]
```

符号执行得到的全部 16 个元素（`decomp\mul_14005ecb0.expr.txt`）一律是：

```c
// k 从 0 到 3 依次左结合，每步 f32 舍入
out[c*4+r] = ((( X[r]·Y[c*4+0] + X[4+r]·Y[c*4+1] ) + X[8+r]·Y[c*4+2] ) + X[12+r]·Y[c*4+3] );
```

- 没有 `vfmadd*`、没有 `cvtss2sd` / `cvtps2pd`、没有 `*sd` 运算（全函数 grep 为 0）。
- glm 的 `operator*(m1, m2)`：`Result[c] = SrcA0·SrcB_c[0] + SrcA1·SrcB_c[1] + SrcA2·SrcB_c[2] + SrcA3·SrcB_c[3]`，编译器把 vec4 拆成两个 2 宽做，顺序不变。**`X = m1`（左）、`Y = m2`（右）**，列向量意义下 `out = X·Y`。
- **更正 rea-p4c-sim 第 27 行**「`FUN_14005ecb0(out, A, B)` 是 `A·B`（行向量约定）」：按寄存器顺序 `(out, rdx, r8)`，行向量读法下是 `out = r8 · rdx`；列向量（glm）读法下才是 `rdx · r8`。数值上的乘法本身没变，只是哪个参数在左要按本节读。

### 1.2 `FUN_14024f0e0(out=rcx, X=rdx, Y=r8)` 【确】

`movdqu` 一次读 X 的整列（4 宽），`r8` 同样逐标量广播。符号执行结果（`decomp\mul_14024f0e0.expr.txt`）与 1.1 **逐元素相同**，k 顺序 0→3、无 FMA、无 double。两个函数可互换。

### 1.3 MVP 链上的其它乘法 / 变换写法

| 写法 | 位置 | 每个结果元素的 f32 顺序（内存下标） | 用在哪 |
|---|---|---|---|
| glm 乘法 | `FUN_14005ecb0`、`FUN_14024f0e0` | `((X[r]·Y[4c] + X[4+r]·Y[4c+1]) + X[8+r]·Y[4c+2]) + X[12+r]·Y[4c+3]` | `W = W_parent · L`（`0x1401852c0`）；形状的 `model = model ∘ W`（`0x14025fe1d`）；粒子、模型等另 30 多处 |
| **仿射乘法**（右乘数第 3 列当 (0,0,0,1)） | `FUN_1400d4200`；`FUN_1401e8aa0` 内联两段 | `c < 3`：`(A[4c+2]·B[8+r] + A[4c+1]·B[4+r]) + A[4c]·B[r]`；`c = 3`：`((A[14]·B[8+r] + B[12+r]) + A[13]·B[4+r]) + A[12]·B[r]` | VP、MVP、图像 / 文本层的 `model = W_al ∘ model` |
| glm::translate 内联 | 帧函数 zoom、视差、anchor、`+0xf0`、`+0xe8`、图像 `+0xe8` | `m[12+r] = ((m[r]·t.x + m[4+r]·t.y) + m[8+r]·t.z) + m[12+r]`，`r = 0..3`；其余列不变 | 第 2.3、2.4、3.4 节 |
| glm::scale 内联 | 帧函数 zoom、`FUN_1401ebf60` | `m[c*4+r] = m[c*4+r]·s[c]`（`c = 0..2`），第 3 列不变 | zoom、效果矩阵 |
| 对齐偏移 | 图像 +0x80 `FUN_1401fd3f0`、文本 +0x80 `FUN_140256e10` | `m[12+r] = ((a.x·m[r] + m[12+r]) + a.y·m[4+r]) + a.z·m[8+r]`，`r = 0..2`，`m[15]` 不动 | 第 3.3 节 |
| 本地矩阵 | `FUN_1401850a0` | `L[c*4+r] = scale[c]·R[c][r]`（单次乘法），平移 = origin | 第 3.1 节 |

> 上表的 A / B 是 `FUN_1400d4200` 里的读法：A 逐元素广播（V 或 M）、B 按列整取（P 或 VP）。换成我们的 `multiply(a, b)` 见第 7 节。

仿射乘法的来由：每一列都是 `XMVector3Transform(A 的第 c 列, B)` 的无 FMA 展开（先 Z·r2、[加 r3]、再 + Y·r1、再 + X·r0），c < 3 时是 `XMVector3TransformNormal`。所以它把 A 的第 3 行（内存 3 / 7 / 11 / 15）完全丢掉。对 lookAt 视图、图层世界矩阵都成立（第 3 行恒为 (0,0,0,1)）。

一个说明顺序为什么要照抄的例子（`order_demo.py`）：随机 z 旋转 + 随机对齐偏移 2000 组，对齐偏移按 WPE 顺序 `((a.x·m0 + m12) + a.y·m4)` 与按 glm::translate 顺序 `((a.x·m0 + a.y·m4) + m12)` 算，**964 组结果不同**。正交、无旋转时 VP 每行只有一个非零项，仿射序和 glm 序给出相同的 MVP（同脚本 2000 组 0 差异），所以差异主要出在偏移和带旋转的乘法上。

---

## 2. 一次图像层 / 文本层 draw 的 MVP

### 2.1 VP 与 MVP：`FUN_1400d4200(ctx)` 【确】

```asm
1400d4204: mov    rax, qword ptr [rcx + 0x40]     ; P = 投影栈顶
1400d4208: mov    rdx, qword ptr [rcx + 0x38]     ; V = 视图栈顶
1400d420c: mov    byte ptr [rcx + 0x1ca], 0x0     ; 清脏位
1400d4218: movups xmm2, [rax+0x20] / xmm4,[rax+0x10] / xmm5,[rax] / xmm3,[rax+0x30]   ; P 的四列
1400d4237: movups xmm9, xmmword ptr [rdx]         ; V 的第 0 列
1400d4243: shufps xmm0, xmm9, 0x55                ; V[1] 广播
1400d4248: shufps xmm1, xmm9, 0x0                 ; V[0] 广播
1400d424d: mulps  xmm0, xmm4                      ; V[1]·P列1
1400d4250: mulps  xmm1, xmm5                      ; V[0]·P列0
1400d4253: shufps xmm9, xmm9, 0xaa                ; V[2] 广播
1400d4258: mulps  xmm9, xmm2                      ; V[2]·P列2
1400d425c: addps  xmm9, xmm0                      ; V[2]·P2 + V[1]·P1
1400d4260: addps  xmm9, xmm1                      ; (…) + V[0]·P0
1400d4264: movups xmmword ptr [rcx + 0x930], xmm9 ; VP 第 0 列
...
1400d42dc: mulps  xmm6, xmm2                      ; V[14]·P列2
1400d42e9: addps  xmm6, xmm3                      ; + P列3（不乘 V[15]）
1400d42ec: addps  xmm6, xmm0                      ; + V[13]·P列1
1400d42ef: addps  xmm6, xmm1                      ; + V[12]·P列0
1400d42f2: movups xmmword ptr [rcx + 0x960], xmm6 ; VP 第 3 列
1400d42f9: mov    rax, qword ptr [rcx + 0x30]     ; M = 模型栈顶
...（同样形状，B 换成刚算出的 VP 四列 xmm9/xmm8/xmm7/xmm6）
1400d4323: movups xmmword ptr [rcx + 0x8f0], xmm2 ; MVP 第 0 列
```

伪代码（符号执行逐元素核对过）：

```c
// VP = V ⊗ P，MVP = M ⊗ VP；⊗ 是仿射乘法，每步 f32
for c in 0..2: VP[4c+r]  = (V[4c+2]·P[8+r] + V[4c+1]·P[4+r]) + V[4c]·P[r];
               VP[12+r]  = ((V[14]·P[8+r] + P[12+r]) + V[13]·P[4+r]) + V[12]·P[r];
for c in 0..2: MVP[4c+r] = (M[4c+2]·VP[8+r] + M[4c+1]·VP[4+r]) + M[4c]·VP[r];
               MVP[12+r] = ((M[14]·VP[8+r] + VP[12+r]) + M[13]·VP[4+r]) + M[12]·VP[r];
```

- 结论：**`MVP = M·(V·P)`**，VP 用的是同一次调用里刚算的值；`ctx+0x930` 与 `ctx+0x8f0` 只有这一个函数写（全文件搜写入点，另两处是构造函数置初值 `0x14017c90a`、`0x14017c95f`）。
- 何时重算：uniform 写入函数 `FUN_1400d8300` 在写 `g_ViewProjectionMatrix`（`0x1400d8680`）、`g_ModelViewProjectionMatrix`（`0x1400d8753`）、`…Inverse`（`0x1400d8826`）前看 `ctx+0x1ca`，脏就调 `FUN_1400d4200`。所有压栈、弹栈、改栈顶的地方都置 `ctx+0x1ca = 1`。
- 写 uniform 时转置（`ctx+0x8f0 + 4·i` → 常量缓冲 `+0x10·i`，`0x1400d8761` 起），数值不变。

### 2.2 正交场景的 V 与 P 【确】

**V**：`FUN_14019d920` 是 glm::lookAtRH（f32）：

```c
f = (center − eye) · (1 / sqrtss(dot(f,f)));      // dot = (x·x + y·y) + z·z，1/len 用 divss 再逐分量乘
s = normalize(cross(f, up));  u = cross(s, f);
V[0],V[4],V[8]  = s;   V[1],V[5],V[9] = u;   V[2],V[6],V[10] = −f;
V[12] = −((s.x·e.x + s.y·e.y) + s.z·e.z);   V[13] = −((u.x·e.x + u.y·e.y) + u.z·e.z);
V[14] =   (f.x·e.x + f.y·e.y) + f.z·e.z;    V[3] = V[7] = V[11] = 0;  V[15] = 1;
```

正交且没有 `camera.paths` 时，加载末尾把相机重置成 `eye (0,0,0)`、`center (0,0,−1)`、`up (0,1,0)`（p3-script-REPORT L2），代入得 `V` 逐位等于单位阵（`V[12]`、`V[13]` 是 −0，不影响和非零数相加）。【确；`verify.py` 复算】

**P**：`FUN_140183a70` 的正交分支（`G+0xe0 & 8`）经设备虚表 +0x18 调 `FUN_14009a630(dev, P, l, r, b, t, n, f)`：

```asm
14009a655: subss  xmm4, xmm2           ; r − l
14009a65e: addss  xmm2, xmm3           ; l + r
14009a68c: divss  xmm0, xmm4           ; 2.0 / (r − l)        常量 0x1404927a8 = 2.0
14009a6ae: divss  xmm1, xmm7           ; 2.0 / (t − b)
14009a6a9: divss  xmm0, xmm9           ; −1.0 / (n − f)        常量 0x1404929b8 = −1.0
14009a6da: xorps  xmm2, xmm0           ; −(l + r)              0x140492ff0 符号位
14009a6e2: divss  xmm2, xmm4           ; −(l + r) / (r − l)
14009a6e6: movss  dword ptr [rdx + 0x30], xmm2
```

```c
P[0]  = 2 / (r − l);          P[5]  = 2 / (t − b);        P[10] = −1 / (n − f);
P[12] = −(l + r) / (r − l);   P[13] = −(b + t) / (t − b); P[14] = −f / (n − f);   P[15] = 1;  其余 0
// 每个减法、加法、除法都是 f32；2/W 是 f32 divss，不是 double 再转
```

- 场景调用的实参（`0x140183e34` 起，非 `alignmentfliph`）：`l = E0`、`r = W − E2`、`b = E3`、`t = H − E1`、`n = −2000`、`f = 2000`，E0..E3 是 `R+0x110..0x11c`（= `ctx+0x100..0x10c`，`0x140183e98` 起写入）的裁切边距，依次是左、上、右、下（缩放模式 switch，`0x140183b47` 起）。窗口与场景同比例时 E 全为 0，`P[12] = −W/W = −1`、`P[13] = −1` **精确**。比例不同时 `P[12] = f32(−f32(l+r)/f32(r−l))`，一般不是 −1。【确：代码；E 的各模式公式本轮没逐支读】
- `alignmentfliph` 在正交分支里是交换左右（`l = W − E0`、`r = E2`），不是乘 −1；乘 −1 的是透视分支（`0x140183f7d`）。【确】

**zoom**（帧函数 `0x14017fd3f`–`0x1401800a2`，正交时**无条件执行**）：`z = G.zoom(+0x154) × G+0x114`（一次 `mulss`），然后对 P 依次做三步 glm 内联：

```c
P = translate(P, ( W·0.5,  H·0.5,  0 ));   // col3[r] = ((P[r]·tx + P[4+r]·ty) + P[8+r]·0) + P[12+r]
P = scale    (P, ( z, z, 1 ));             // 第 0、1 列 ×z，第 2 列 ×(1,1,1,1)
P = translate(P, ( W·−0.5, H·−0.5, −0 ));  // 同上顺序；常量 0x1404929ac = −0.5，0x1404929a0 = −0.0
```

（第一次 translate 的指令把 `0·P[8+r]` 放在最前、第二次放在第三，都是加 0，结果相同；所以统一写成 glm 顺序。）`z = 1`、`l = 0` 时：第一步得 `q − 1`（`q = f32(W/2·P[0])`，Sterbenz 精确），第三步得 `−q + (q − 1) = −1`，**P 逐位不变**，脚本对 3840×2130 复算确认。`l ≠ 0` 或 `z ≠ 1` 时这三步会带来舍入，要照抄。【确：代码；z=1 精确为数值核对 + 推导】

### 2.3 视差与抖动 【确】

- **视差**（绘制循环 `0x14018b00c`–`0x14018b149`，`(G+0xe0 & 0x108) == 0x108` 时）：先压一层视图栈（拷贝），然后
  ```c
  o.x = ((root.origin.x − Px) · amount) · root.parallaxDepth.x;   // 三步 f32，按这个顺序
  o.y = ((root.origin.y − Py) · amount) · root.parallaxDepth.y;
  o.z = amount · 0;                                              // xmm14 在 0x14018af85 清零
  V = translate(V, o);   // glm 内联：V[12+r] = ((V[r]·o.x + V[4+r]·o.y) + V[8+r]·o.z) + V[12+r]
  ```
  是对 V 的矩阵运算（只改第 3 列），不是另加到某个分量上。
- **抖动**（`FUN_140199580`）：在 lookAt 之前，`eye.i = d.i + eye.i`、`center.i = d.i + center.i`（`0x140199712`–`0x140199751`，单次 `addss`），再进 lookAt；V 的平移因此是 `−((s.x·e.x + s.y·e.y) + s.z·e.z)` 这类点积。`d` 的计算见 rea-p5-camera 第 5 节。
- **透视覆盖**（`perspective: true`，`FUN_1401e5b60`）：直接改 V 栈顶的平移元素、把 P 换成透视矩阵，之后照常走 2.1。本轮没逐条转写它的 f32 顺序。**未确认**（没有读，语料 4 张、都不是本次对照的场景）。

### 2.4 一个图像层 / 文本层 draw 的完整顺序（`FUN_1401e8aa0`）【确】

```c
// 帧开头（FUN_14017fa70）：V = lookAtRH(...)；P = ortho(...)；正交时 P = zoom(P)；M = I
// 绘制循环：push V；开视差时 V = translate(V, o)

W_al = vfunc_80(this);                       // 0x1401e8b53：图像 FUN_1401fd3f0 / 文本 FUN_140256e10（第 3.3 节）

if (直接上屏) {                               // 无 effect、无 colorBlendMode 合成
    push M (拷贝);                            // 0x1401e9125
    vfunc_a8(this, M);                       // 0x1401e916e：图像返回 false 不改；文本 FUN_1402585c0 = glm translate（anchor）
    M = M ⊗' W_al;                           // 0x1401e9174–0x1401e922f：仿射乘法，A = W_al、B = M（见下）
    if (perspective) { push P, V; FUN_1401e5b60(ctx); }
    vfunc_f0(this);                          // 文本 FUN_140258050：再 push M 并 translate（字形平移）；图像 FUN_140208670 不改 M
    // uniform 取值时：MVP = M ⊗ (V ⊗ P)（FUN_1400d4200）
}
else {                                        // 合成路径
    push M, V, P;
    push M; M = W_al（整块拷贝，0x1401e9582）; this+0x384 = W_al;
    this+0x344 = MVP（FUN_1400d4200，0x1401e95e6）;  pop M;          // 效果矩阵原料 M0，第 4 节
    // 画进合成 RT（未置 +0x304 bit5 时，0x1401e96ac）：
    M = I;  V = M（= I）;  P = ortho(0, rtW, 0, rtH, −1000, 1000)    // ctx+0x118 bit0 为 0 时上下颠倒成 (0, rtW, rtH, 0)
    vfunc_e8(this);                          // 文本 FUN_140257d70：push M，translate(pad.x − min(minx,0), pad.y − miny, 0)
    // effect 中间 pass（0x1401e9970）：M = I、V = I、P = ortho(−1, 1, −1, 1, −1000, 1000)（P[0] = 1、P[12] = −0）
    // 末 pass（0x1401e9d0e）：
    pop 回场景的 M, V, P;  push P, V, M;
    if (!fullscreen) {
        vfunc_a8(this, M);                   // 0x1401e9dd5：anchor
        M = M ⊗' W_al;                       // 0x1401e9de6–0x1401e9e9b，同上
        if (perspective) FUN_1401e5b60(ctx);
    } else { M = I; V = I; P = ortho(−1, 1, −1, 1, −1000, 1000); }
}
```

其中 `M ⊗' W_al` 的逐元素顺序（A = `W_al`、B = 原来的 M）：

```c
for c in 0..2: M'[4c+r] = (W_al[4c+2]·M[8+r] + W_al[4c+1]·M[4+r]) + W_al[4c]·M[r];
               M'[12+r] = ((W_al[14]·M[8+r] + M[12+r]) + W_al[13]·M[4+r]) + W_al[12]·M[r];
```

M 是单位阵（帧开头置的，anchor 为 `none` 或平移 0）时 `M' = W_al` 逐位相同（每个和里只有一个 ×1 项，其余是 ×0 与 +0）。所以本次对照的文本场景，末 pass 的 `MVP = W_al ⊗ (V ⊗ P)`，`V = I`、`P` 是精确的正交阵。

### 2.5 `g_ModelViewProjectionMatrixInverse` 【确】

- `0x1400d8826`：脏就先 `FUN_1400d4200`，再 `lea rdx, [rcx + 0x8f0]` 跳 `0x1400d85a4`：`FUN_14005f730(tmp, ctx+0x8f0)`，转置写常量缓冲。
- 同一入口 `0x1400d859e` 还服务 `g_ModelMatrixInverse`（模型栈顶 `[ctx+0x30]`）、`g_EffectModelViewProjectionMatrixInverse`（`ctx+0x9b0`，`0x1400d9521`）、`g_EffectTextureProjectionMatrixInverse`（`ctx+0x9f0`，`0x1400d95df`）。**uniform 求逆一律是 `FUN_14005f730`**；`FUN_1402290d0`（SSE、`divps`）不在 uniform 路径上（粒子用，rea-p4c-sim）。
- `FUN_14005f730` 的结构（符号执行，`decomp\inv_14005f730.expr.txt` 有 16 个元素的完整运算树）：标量余子式，正负号用乘 `−1.0`（`0x1404929b8`）；`det = (C3·M[3] + C2·M[2]) + (C1·M[1] + C0·M[0])`（两两相加再相加）；`1/det` 是一次 `divss`（`0x14005fa92`，被除数 `1.0`），每个输出元素 = `(1/det) · 余子式`。全函数没有 FMA、没有 double。和 glm::inverse 的 `Dot1 = (x+y)+(z+w)`、`Inverse * OneOverDeterminant` 同形【推：只比了形状，没逐个余子式对 glm 源码】。

---

## 3. 模型矩阵 M

### 3.1 本地矩阵与世界矩阵：`FUN_1401850a0`（虚表 +0x80 的基类）【确】

```asm
140185174: movss  xmm2, dword ptr [rbx + 0x134]     ; scale.x
140185184: movaps xmm0, xmm2
140185187: mulss  xmm0, dword ptr [rbx + 0x14c]     ; scale.x · R[0]
1401851e6: movss  dword ptr [rdi], xmm0             ; L[0]（rdi = this+0xe0）
...
140185150: mov    eax, dword ptr [rbx + 0x128]      ; origin.x → L[12]（0x140185156）
140185146: mov    dword ptr [rbx + 0x11c], 0x3f800000 ; L[15] = 1；L[3]/L[7]/L[11] = 0
1401852b0: call   0x1401850a0                       ; 父的世界矩阵（递归，非虚，不带父的对齐偏移）
1401852b5: mov    rdx, rax                          ; X = W_parent
1401852bd: mov    r8, rdi                           ; Y = L
1401852c0: call   0x14005ecb0                       ; W = W_parent · L（k = 0..3）
```

```c
L[c*4+r] = scale[c] · R[c*3+r];     // c, r ∈ 0..2，各一次 f32 乘法；R 存在 this+0x14c..0x16c
L[12..14] = origin;  L[15] = 1;  L[3] = L[7] = L[11] = 0;
W = parent ? glm_mul(W_parent, L) : L;     // 有 attachment 时先经父的虚函数 +0x78 改 L
```

- **不是逐个矩阵相乘**：T·R·S 是直接按元素填的。
- 缓存按 `ctx+0x144` 版本号（`this+0xd0`），版本相同且父链没变就直接返回 `this+0xe0`。

### 3.2 旋转 R：`FUN_1401dd630`（angles setter）【确】

angles（弧度）存 `+0x140..+0x148`，依次对 z、y、x 调 `FUN_14041a2e0`（cosf）和 `FUN_14041a9c0`（sinf），参数和返回都是 f32。记 `cz, sz, cy, sy, cx, sx`：

```c
R[0] = cy·cz;                    R[1] = cy·sz;                    R[2] = −sy;
R[3] = ((sy·cz)·sx) − (cx·sz);   R[4] = ((sy·sz)·sx) + (cx·cz);   R[5] = sx·cy;
R[6] = ((cx·cz)·sy) + (sx·sz);   R[7] = ((cx·sz)·sy) − (sx·cz);   R[8] = cx·cy;
// 每个括号一次 f32 运算；R[3k..3k+2] 是第 k 列（列向量意义），L 的第 k 列 = scale[k]·R 第 k 列
```

- `cosf` / `sinf` 是 MSVC CRT 实现：参数转 double（`vcvtss2sd`）、double 多项式（有 FMA 分派，`0x1404e4ee0` 标志）、最后 `vcvtsd2ss` 一次舍入。**角度为 0**：`|x| < 2⁻¹³`（`0x39000000`）走捷径，cosf 返回常量 `0x140471cb8 = 1.0`，sinf 返回 x 本身（0），**精确的 1 和 0**。【确】
- 非零角度：结果是「接近正确舍入」的 f32，与 `Math.fround(Math.cos(x))` 在绝大多数参数上相同，个别参数可能差 1 ulp。**未确认**（没有逐值比对）。

### 3.3 对齐偏移：+0x80 【确】

图像层 `FUN_1401fd3f0`：`+0x4b1`（alignment）为 0 时直接尾跳 `FUN_1401850a0`；否则拷贝到 `this+0x450` 再改平移列。文本层 `FUN_140256e10`：**无条件**拷贝到 `this+0x554` 再改。两段指令一样（偏移 `+0x2f8/+0x2fc/+0x300`）：

```asm
140256e36: movss  xmm4, dword ptr [rdi + 0x2f8]    ; a.x
140256e8b: mulss  xmm4, dword ptr [rbx]            ; a.x · M[0]
140256eac: addss  xmm4, dword ptr [rdi + 0x584]    ; + M[12]
140256e9c: mulss  xmm6, dword ptr [rdi + 0x564]    ; a.y · M[4]
140256ed2: addss  xmm6, xmm4                       ; (a.x·M[0] + M[12]) + a.y·M[4]
140256ec3: mulss  xmm0, dword ptr [rdi + 0x574]    ; a.z · M[8]
140256ed6: addss  xmm0, xmm6                       ; (...) + a.z·M[8]
140256edf: movss  dword ptr [rdi + 0x584], xmm0    ; M[12]
```

```c
W_al = W;
for r in 0..2: W_al[12+r] = ((a.x·W[r] + W[12+r]) + a.y·W[4+r]) + a.z·W[8+r];   // W_al[15] 不改
```

- **只改平移列**，不是完整的 `T(a)·W` 乘法；`W[12+r]` 在第二个位置加入（和 glm::translate 的「最后加」不同）。
- 本例代入：`x' = ((410.5·sx + X) + (−16)·0) + 0·0 = f32(f32(410.5·sx) + X)`，`y' = ((410.5·0 + Y) + (−16)·sy) + 0 = f32(Y + f32(−16·sy))`，与假设一致。

### 3.4 文本层的其余平移 【确】

- **anchor**（+0xa8 `FUN_1402585c0`，跳转表 `0x1402588d4`）：`none` 返回 `al = 0`、不改 M；其余九种都是 glm::translate 内联 `M[12+r] = ((M[r]·tx + M[4+r]·ty) + M[8+r]·0) + M[12+r]`，`tx/ty` 由 `ctx+0x100..0x10c`（裁切边距）算出。图像层 +0xa8 是 `0x1400a36d0`（`xor al, al; ret`）。
- **直接上屏字形平移**（+0xf0 `FUN_140258050`）：再压一层 M，`t = (−0.5·w − min(minx, 0), 0.5·h − maxy, 0)`（`0x1402583a8`–`0x1402583cc`，先 `w·(−0.5)` 再减 minx），M 按 glm::translate 顺序更新（`0x14025841d`–`0x14025848d`）。背景（`opaquebackground`）另压一层，`t = (−0.5·w − pad.x, −0.5·h − pad.y, 0)`，同样顺序，画 `+0x2d8`。
- **画进合成 RT**（+0xe8 `FUN_140257d70`）：在 `M = I` 上压一层，`t = (pad.x − min(minx, 0), pad.y − miny, 0)`，glm::translate 顺序（`0x140257ec7`–`0x140257f3f`）。`I` 上平移得 `(tx, ty, 0, 1)` 精确值。
- 图像层画进合成 RT（+0xe8 `FUN_140207b50`）：`t = (imgW/(2k), imgH/(2k), 0)`，`k = ctx+0x1218`，glm::translate 顺序（`0x140207d66`–`0x140207d9e`）。

---

## 4. 效果矩阵

### 4.1 原料（`FUN_1401e8aa0` 合成路径）【确】

```asm
1401e9582: ...                                    ; push M，然后 M 栈顶 ← W_al（movups ×4，拷贝，不乘）
1401e95b5: movups xmmword ptr [rbx + 0x384], xmm0 ; this+0x384 ← W_al
1401e95dd: cmp    byte ptr [rcx + 0x1ca], 0x0
1401e95e6: call   0x1400d4200                     ; MVP = W_al ⊗ (V ⊗ P)
1401e95eb: movups xmm0, xmmword ptr [rcx + 0x8f0]
1401e9609: movups xmmword ptr [rbx + 0x344], xmm0 ; this+0x344 ← M0
1401e963d: add    qword ptr [rax + 0x30], -0x40   ; pop M
```

- `L = W_al`、`M0 = W_al ⊗ (V ⊗ P)`。此时 V 已带视差平移，P 是场景投影；**没有 anchor**（M 是整块替换），**没有透视覆盖**（`FUN_1401e5b60` 只在直接上屏 `0x1401e92b3` 和末 pass `0x1401e9eb3` 调）。

### 4.2 每个 pass 写 uniform（`FUN_1401ebf60`，pass 标志 bit0 时）【确】

```c
Sx2 = f32(this.size.x · 0.5);  Sy2 = f32(this.size.y · 0.5);   // +0x2f0 / +0x2f4，浮点 size
g_LayerModelMatrix (0xa30) = L;                                   // 0x1401ec271
if (final) {                                                      // 0x1401ec2b2
    g_EffectModelMatrix (0x970)               = L;
    g_EffectModelViewProjectionMatrix (0x9b0) = M0;
    g_EffectTextureProjectionMatrix (0x9f0)   = scaleCols(M0);    // 0x1401ec331–0x1401ec3e5
} else {                                                          // 0x1401ec3f1
    g_EffectModelMatrix (0x970)               = scaleCols(L);
    g_EffectModelViewProjectionMatrix (0x9b0) = scaleCols(M0);
    g_EffectTextureProjectionMatrix (0x9f0)   = 0x9b0 的拷贝;
}
// scaleCols(m)：m[0..3] ×= Sx2，m[4..7] ×= Sy2，m[8..11] ×= (1,1,1,1)，m[12..15] 不变
```

- 缩放是 `shufps` 广播后的 `mulps` / `mulss`，一元素一次乘法，**不是矩阵乘法**；数值上与 `multiply(m, diag(Sx2, Sy2, 1, 1))` 逐位相同（每个和里只有一个非零项）。
- 求逆的两个（0x15、0x17）在 uniform 写入时用 `FUN_14005f730` 现算（2.5 节）。`g_EffectModelMatrixInverse` 不是内置名（effect-matrices-REPORT）。
- 与 rea-p8-layer 1.5、effect-matrices-REPORT S2 的结论一致，本节补上「原料不带 anchor、不带透视覆盖」和逐元素缩放的细节。

---

## 5. 四边形几何与索引

### 5.1 公共函数 `FUN_1401ede30(ctx, size, texSize, uvMax, flags, out)` 【确】

参数：`rdx` = `(sx, sy)`、`r8` = `(tw, th)`、`r9` = `(u1, v1)`（都是两个打包的 float），第 5 参数 `flags`，第 6 参数输出指针。

```c
if (flags & 1) { xR = sx·0.5; yT = sy·0.5; xL = −xR; yB = −yT; }   // 居中
else           { xR = sx;     yT = sy;     xL = 0;   yB = 0;   }
du = dv = 0;
if (flags & 2) { du = 0.15 / tw; dv = 0.15 / th; }                   // 常量 0x140492660 = 0.15，半纹素内缩
vT = dv;  vB = v1 − dv;  uL = du;  uR = u1 − du;
if (flags & 4) { vT = 1.0; vB = 1.0 − (v1 − dv); }                   // v 翻转
// 顶点格式 7：position xyz + texcoord uv，步长 20（FUN_140098c30）
v0 = (xL, yT, 0, uL, vT);     // 左上（本地 y 向上）
v1 = (xR, yT, 0, uR, vT);     // 右上
v2 = (xL, yB, 0, uL, vB);     // 左下
v3 = (xR, yB, 0, uR, vB);     // 右下
index (u16) = { 0, 2, 1,  1, 2, 3 };            // [rsp+0x50] = 0x20000, 0x10001, 0x30002
*out = dev->vfunc_40(fmt, vertices, 4, index, 6, 0, 0, 0);   // FUN_14009a880
```

关键汇编（`rbp = rsp + 0x100`，顶点数组从 `rsp+0x70` 起）：

```asm
1401edf4d: movss dword ptr [rsp + 0x70], xmm9    ; v0.x = xL
1401edf59: movss dword ptr [rsp + 0x74], xmm12   ; v0.y = yT
1401edf6e: movss dword ptr [rbp - 0x7c], xmm11   ; v1.x = xR   (rsp+0x84)
1401edf74: movss dword ptr [rbp - 0x78], xmm12   ; v1.y = yT   (rsp+0x88)
1401edf85: movss dword ptr [rbp - 0x68], xmm9    ; v2.x = xL   (rsp+0x98)
1401edf8b: movss dword ptr [rbp - 0x64], xmm10   ; v2.y = yB   (rsp+0x9c)
1401edf9c: movss dword ptr [rbp - 0x54], xmm11   ; v3.x = xR   (rsp+0xac)
1401edfa2: movss dword ptr [rbp - 0x50], xmm10   ; v3.y = yB   (rsp+0xb0)
1401edfd1: mov   dword ptr [rsp + 0x50], 0x20000 ; idx 0, 2
1401edfd9: mov   dword ptr [rsp + 0x54], 0x10001 ; idx 1, 1
1401edfe1: mov   dword ptr [rsp + 0x58], 0x30002 ; idx 2, 3
1401ee022: mov   dword ptr [rsp + 0x28], 0x6     ; 6 个索引
1401ee011: mov   r9d, 0x4                        ; 4 个顶点
```

- 设备 +0x40 `FUN_14009a880`：顶点原样拷进顶点缓冲，索引格式 `0x39`（`DXGI_FORMAT_R16_UINT`），第 9 参数 0 → 拓扑 `4`（TRIANGLELIST）。不重排。【确】
- **三角形 (v0,v2,v1) = (左上, 左下, 右上)、(v1,v2,v3) = (右上, 左下, 右下)，共享边 v1–v2：对角线是「右上—左下」**（本地 y 向上时是 `/` 方向）。
- 和任务说明里抓帧所见的比较：抓帧记为顶点 (TL, BL, TR, BR)、索引 `[0,2,1, 1,2,3]`。按读码 v1 是右上、v2 是左下。两种记法下共享边都是「v1–v2 = 右上—左下」，**对角线结论一致**；只是 v1、v2 谁是「右上」的标签不同。差异的来源**未确认**（可能是抓帧时在合成 RT 的 y 方向或屏幕坐标下标的）；按读码，UV 与位置的配对是 `v1 = (右, 上, u1, vT)`。
- 对这次的文本场景：抓帧里 `ty = +0.209…`，说明画进合成 RT 时投影是 `ortho(0, w, 0, h)`，即 `ctx+0x118` bit0 置位；所以 `+0x2e0` 不带 v 翻转（bit2 为 0）。【推】

### 5.2 各类四边形

| 几何 | 建在哪 | 尺寸 / 标志 | 顶点顺序 | 索引 | 何时画 |
|---|---|---|---|---|---|
| 图像层 `+0x2e0` | `FUN_1402066a0` → `FUN_1401ede30`（`0x1402067fb`） | `(2,2)`；居中；`ctx+0x118` bit0 为 0 时 v 翻转 | 5.1 | `0,2,1,1,2,3` | effect 中间 pass（`FUN_1401ebf60` `0x1401ec6b2`），配 `M = V = I`、`P = ortho(−1,1,−1,1)` |
| 图像层 `+0x2e8` | 同上（`0x14020686f`） | 整数 `size`（`cvtdq2ps`）；居中；`+0x304` 无 `0x2` 且无 `0x220` 时内缩 | 5.1 | 同上 | 末 pass 上屏（`0x1401ec667`）；组合层基础 pass（`0x140207fe9`） |
| 图像层 `+0x490` | 同上（`0x1402069e0`） | 不合成时整数 `size`、`+0x304 & 0x226` 为 0 时内缩；合成且 `+0x4b0` 时 `texSize / ctx+0x1218` | 5.1 | 同上 | 直接上屏（`FUN_140208670`）；`fullscreen` 时 size 已改成 (2,2)（rea-p8-layer 2.2）【推】 |
| 基类 `+0x2e0/+0x2e8` | `FUN_1401ea310` → `FUN_1401ede30`（`0x1401ea450`、`0x1401ea4cf`） | 同图像层前两行 | 5.1 | 同上 | 文本层、形状（只在有合成时建） |
| 合成 RT 像素四边形 `+0x2d8` | `FUN_1401ea500` → `FUN_1401ede30`（`0x1401eb1e8`） | 合成 RT 整数尺寸；**不居中**（`flags = 0`）：`(0,h) (w,h) (0,0) (w,0)` | 5.1 | 同上 | 文本直接上屏背景；组合层基础 pass；形状不建（`+0x304` bit13） |
| 文本背景 `+0x5b0` | `FUN_140258900` → `FUN_1401ede30`（`0x140258a72`） | 浮点 `size`（`+0x2f0/+0x2f4`，不截断）；居中；`(1,1)` 纹理与 UV | 5.1 | 同上 | 合成路径的 RT 初值（`composelayer_clearalpha`） |
| 文本字形 | `FUN_1401b0410` 内 `0x1401b2a6e`–`0x1401b2b68` | 每字 `(x0−pad, y1+pad)`、`(x1+pad, y1+pad)`、`(x0−pad, y0−pad)`、`(x1+pad, y0−pad)` | 左上、右上、左下、右下（同 5.1） | `4i, 4i\|2, 4i\|1, 4i\|1, 4i\|2, 4i\|3` = `4i + [0,2,1,1,2,3]` | 直接上屏 +0xf0、画进 RT +0xe8 |
| 文本合成 RT 上屏 | 基类 `+0x2e8` | 同基类 | 5.1 | 同上 | 末 pass |
| 形状（有 `point0..3`） | `FUN_140260190` | 顶点按点 0..3 | 点 0..3 | `0,2,1, 0,3,2`（对角线 v0–v2） | rea-p8-layer 1.3 |
| 形状（无点） | `FUN_14026076d` → `FUN_1401ede30` | 居中方块 | 5.1 | `0,2,1,1,2,3` | 同上 |
| 粒子（非 GS） | `FUN_1401d2340` → `FUN_140261250`（模式 0，`0x1401d3546` 等） | 动态顶点缓冲，容量 × 4 顶点 | 抓帧：UV (0,0)、(0,1)、(1,1)、(1,0)（phase-4-0-tools，`0x140235b71` 起写入） | 每粒子 `4k + [0,1,2, 0,2,3]`（`0x1402612e0`–`0x14026132b`），对角线 v0–v2 = UV (0,0)–(1,1) | 粒子绘制 |
| 粒子（GS） | 同上，模式 2 → 设备 +0x48（无索引） | 每粒子 1 个点 | — | 无 | 展开在 `genericparticle` 几何着色器里（抓帧 6 顶点 / 粒子），**exe 里看不到，未确认** |
| 泛光链全屏 pass | 渲染器 `R+0x58`，`0x14017f25b`–`0x14017f304`，设备 +0x48 | **单个三角形**：`(−1, 1)`、`(−1, −3)`、`(3, 1)`，z = 0；UV `R+0x128` bit0 置位时 `(0,0) (0,2) (2,0)`，否则 `(0,1) (0,−1) (2,1)` | — | 无索引，3 顶点 | `FUN_140183610` 每个泛光 pass（`0x1401836e7` 等） |
| 精灵 / puppet 图层 `+0x490` | `FUN_14020ae40`（`+0x4b8` 带网格时） | 模型自己的顶点与索引 | — | — | 不是四边形，归 mdl（P5c）【推】 |

- 「建四边形 + 索引」的公共函数就是 **`FUN_1401ede30`**；动态的多四边形版本是 **`FUN_140261250`**（索引 `0,1,2,0,2,3`，粒子用）。两者的索引模式不同，对角线方向也不同（前者 v1–v2，后者 v0–v2）。
- 灯对象（`FUN_140256560`，`materials/util/occlusiontest.json`）另有一个写死顶点的四边形，索引 `0,1,2, 0,2,3`；不在本次范围，没解读顶点含义。

---

## 6. 数值核对（`verify.py`）

按第 1–3 节读出的顺序逐步 `fround` 复算（脚本里的 `ortho`、`zoom`、`lookat`、`affine`、`glm_mul`、`local`、`offset80`、`translate_glm` 各对应一节）：

| 对象 | 量 | 按 WPE 顺序复算 | WPE 抓帧 | 结果 |
|---|---|---|---|---|
| 179 | MVP tx | 0.8629395961761475 | 0.8629395961761475 | 相等 |
| 179 | MVP ty | 0.8874444961547852 | 0.8874444961547852 | 相等 |
| 67 | MVP tx | 0.8645793199539185 | 0.8645793199539185 | 相等 |
| 67 | MVP ty | 0.8890844583511353 | 0.8890844583511353 | 相等 |
| 文本画进合成 RT | MVP ty | 0.2091503143310547 | 0.2091503143310547 | 相等 |

另：复算的 `V` 逐位是单位阵；`zoom(z=1)` 后的 `P` 与 `ortho(0, 3840, 0, 2130, −2000, 2000)` 逐位相同（`P[0] = 0.0005208333604969084`、`P[5] = 0.0009389671613462269`、`P[12] = P[13] = −1`）；`VP` 的 x/y 两列等于 `P`。路径是「末 pass，`M = W_al ⊗ I`，`MVP = M ⊗ (V ⊗ P)`」。

（本例每个分量只有一个非零乘积，只能验证「f32 逐步舍入、无 FMA、无 double」，验证不了 k 的结合顺序；结合顺序的依据是第 1、2 节的指令和符号执行。）

---

## 7. 换成我们的列向量约定

我们的 `multiply(a, b) = a·b`，`out[c*4+r] = Σ_k a[k*4+r]·b[c*4+k]`。WPE 的内存布局和我们逐字节相同，而且 WPE 本身就是 glm（列向量），所以**不用转置、参数顺序直接对应**：

| WPE | 我们 | 求和顺序（在我们的循环变量 k 上） |
|---|---|---|
| `FUN_14005ecb0(out, X, Y)` / `FUN_14024f0e0` | `multiply(X, Y)` | k = 0 → 1 → 2 → 3，左结合 |
| `FUN_1400d4200` 的 VP | `mulAffine(P, V)` | c < 3：k = 2 → 1 → 0（k = 3 项丢弃）；c = 3：k = 2 → 3 → 1 → 0，k = 3 项是 `a[12+r]` 本身（不乘 `b[15]`） |
| `FUN_1400d4200` 的 MVP | `mulAffine(VP, M)` | 同上 |
| `FUN_1401e8aa0` 的 `W_al ∘ model` | `mulAffine(model, W_al)` | 同上 |
| 形状的 `W ∘ model` | `multiply(model, W)` | k = 0 → 3 |
| `W = W_parent · L` | `multiply(W_parent, L)` | k = 0 → 3 |

（与任务说明「WPE 的 `A·B` 对应我们的 `multiply(B, A)`」的关系：那句话说的是 rea-p5-camera 等笔记里的行向量写法 `A·B`。按寄存器看，`FUN_14005ecb0(out, rdx, r8)` 就是 `multiply(rdx, r8)`；两种说法一致，只是 rea-p4c-sim 把参数名标反了，见 1.1。）

可以直接照抄的写法（`f = Math.fround`）：

```ts
// = FUN_14005ecb0(out, a, b)：k 从 0 到 3
function mulGlm(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = f(a[r] * b[c * 4]);
      s = f(s + f(a[4 + r] * b[c * 4 + 1]));
      s = f(s + f(a[8 + r] * b[c * 4 + 2]));
      s = f(s + f(a[12 + r] * b[c * 4 + 3]));
      o[c * 4 + r] = s;
    }
  return o;
}

// = FUN_1400d4200 / FUN_1401e8aa0 内联：b 的 3、7、11 当 0，15 当 1
function mulAffine(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++)
      o[c * 4 + r] = f(f(f(b[c * 4 + 2] * a[8 + r]) + f(b[c * 4 + 1] * a[4 + r])) + f(b[c * 4] * a[r]));
    o[12 + r] = f(f(f(f(b[14] * a[8 + r]) + a[12 + r]) + f(b[13] * a[4 + r])) + f(b[12] * a[r]));
  }
  return o;
}

// glm::translate 内联（zoom、视差、anchor、字形、+0xe8）
function translateGlm(m: Mat4, t: Vec3): Mat4 {
  const o = Float32Array.from(m);
  for (let r = 0; r < 4; r++)
    o[12 + r] = f(f(f(f(m[r] * t[0]) + f(m[4 + r] * t[1])) + f(m[8 + r] * t[2])) + m[12 + r]);
  return o;
}

// 图像 / 文本层 +0x80 的对齐偏移
function alignOffset(w: Mat4, a: Vec3): Mat4 {
  const o = Float32Array.from(w);
  for (let r = 0; r < 3; r++)
    o[12 + r] = f(f(f(f(a[0] * w[r]) + w[12 + r]) + f(a[1] * w[4 + r])) + f(a[2] * w[8 + r]));
  return o;
}

// FUN_14009a630
function orthoWpe(l: number, r: number, b: number, t: number, n: number, fr: number): Mat4 {
  const rl = f(r - l), tb = f(t - b), nf = f(n - fr);
  const m = new Float32Array(16);
  m[0] = f(2 / rl); m[5] = f(2 / tb); m[10] = f(-1 / nf);
  m[12] = f(-f(l + r) / rl); m[13] = f(-f(b + t) / tb); m[14] = f(-fr / nf); m[15] = 1;
  return m;
}

// 一次图像 / 文本层末 pass（或直接上屏）的 MVP：
//   L     = 按 3.1 逐元素填；W = parent ? mulGlm(W_parent, L) : L
//   W_al  = alignOffset(W, a)            // 图像层 alignment ≠ 0、文本层恒做
//   model = anchor ? translateGlm(I, t_anchor) : I
//   M     = mulAffine(model, W_al)       // 文本直接上屏再 translateGlm(M, t_glyph)
//   V     = lookAtRH(...)（正交无路径时 = I）；开视差时 V = translateGlm(V, o)
//   P     = orthoWpe(E0, W − E2, E3, H − E1, −2000, 2000)
//           正交时 P = translateGlm(scaleXY(translateGlm(P, [f(W*0.5), f(H*0.5), 0]), z), [f(W*-0.5), f(H*-0.5), -0])
//           scaleXY(m, z)：m[0..7] 逐元素 ×z，m[8..11] ×1，m[12..15] 不变
//   MVP   = mulAffine(mulAffine(P, V), M)
// 效果矩阵原料：M0 = mulAffine(mulAffine(P, V), W_al)（无 anchor、无透视覆盖），L = W_al。
// 四边形：顶点 左上、右上、左下、右下，索引 [0,2,1, 1,2,3]（字形每字同样）；粒子 [0,1,2, 0,2,3]；泛光一个全屏三角形。
```

---

## 独立核对（Claude，2026-11-14）

用 `llvm-objdump` 从 `scratchpad\rea\wallpaper64.exe` 直接反汇编，逐条读了三段，结论和上文一致：
- `FUN_1400d4200`（`0x1400d4200`–`0x1400d43d1`）：VP、MVP 的每一列都是先算 k = 2 的乘积，再加 k = 1、k = 0；平移那一列在 k = 2 之后先加右乘数的平移列。V、M 的第 3 个分量（内存 3 / 7 / 11 / 15）都不读。（2.1 节）
- `FUN_140256e10`：三个分量都是 `a.x·W[r] + W[12+r]`，再加 `a.y·W[4+r]`，最后加 `a.z·W[8+r]`。（3.3 节）
- `FUN_1401ede30`：顶点步长 20，v0 = (xL, yT, uL, vT)、v1 = (xR, yT, uR, vT)、v2 = (xL, yB, uL, vB)、v3 = (xR, yB, uR, vB)，索引 `0,2,1, 1,2,3`。（5.1 节）

## 更正与补充（旧文字未改）

- **rea-p4c-sim 第 27 行**「`FUN_14005ecb0(out, A, B)` 与 `FUN_14024f0e0(out, A, B)` 都是 `A·B`（行向量约定）」：按寄存器 `(rcx, rdx, r8)`，行向量读法下是 `r8 · rdx`，列向量（glm）读法下是 `rdx · r8`。下游笔记里引用这两个函数的「谁在左」要按 1.1 重核。
- **rea-p8-layer 第 138 行**「`model = W ∘ model; // FUN_14005ecb0`」：只对形状（`FUN_14025faf0`）成立；图像 / 文本层的基类绘制 `FUN_1401e8aa0` 是内联的仿射乘法，求和顺序不同（第 2.4 节）。
- **rea-p4a A1**「`L = T·R·S`」：数学上成立，但实现是逐元素填（第 3.1 节），没有矩阵乘法。
- **rea-p6b-raster「顶点」表**：顶点 0..3 与索引 `4i, 4i+2, 4i+1, 4i+1, 4i+2, 4i+3` 读码复核成立，和图层四边形 `FUN_1401ede30` 同一种对角线。
- **p2-REPORT「`R+0x128` 0x1 = 主 RT 不带深度」**：本轮看到同一位还决定 `+0x2e0` 的 v 翻转、合成 RT 正交的上下方向和泛光三角形的 UV，含义更像「纹理原点在左上」；**未确认**（没找到置位点）。

## 未查清

- REA / Ghidra 本轮没能完成导入（两次 330 s 超时），新快照没有本轮的改名与注释；静态结论全部来自 `wp.asm` + `llvm-objdump` 交叉核对与符号执行。下次要用 REA，需要调大 `REA_GHIDRA_STARTUP_TIMEOUT_MS`。
- 透视覆盖 `FUN_1401e5b60` 改 V / P 的 f32 顺序；透视场景 `FUN_14009a360`（PerspectiveFovRH）的 f32 顺序。
- 裁切边距 E0..E3 在各缩放模式下的公式（`0x140183b47` 起的 switch）。
- `FUN_14005f730` 每个余子式与 glm 源码的逐项对照（运算树已导出，没逐个比）。
- 抓帧的顶点标签（TL, BL, TR, BR）与读码（左上、右上、左下、右下）为什么不同；对角线结论不受影响。
- 粒子 GS 路径的展开顺序（在着色器里）。
- MXCSR 的 FTZ / DAZ。
