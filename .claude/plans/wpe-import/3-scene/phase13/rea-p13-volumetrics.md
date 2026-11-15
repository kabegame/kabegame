> 逆向原始记录，代理写的，地址按 Ghidra（基址 0x140000000）。只读码，没运行、没附加 WPE。「抓帧」指主会话转来的 3287715210（正交、一盏 lpoint、castshadow + pointshadow 1、HDR、high 档）事实与 `ignore/p13/out/wpe-3287715210-high-consts.json` 的常量，本代理只用来对照与 float32 复算。前作 [rea-p13-passes.md](rea-p13-passes.md) 第 3、5 节与 [rea-p13-shadows.md](rea-p13-shadows.md) 已证的地址不再重复，这里补 V1–V11。

# WPE 2.8.42 P13 体积光（castvolumetrics）补充读码

**概括**

- **体积光函数是一个整体**：`FUN_140196ce0`（`0x140196ce0`–`0x1401988cb`，fn 表把它切成了 `0x140196f65`、`0x140198124` 等块，都是同一个函数）。顺序：建 RT（首次）→ 拷场景深度 → 剔除取反、清 Single 深度 → 建灯体网格（首次）→ 画背面 → 剔除还原、压 LightBuffer、按需清 → 判「相机在灯体内」→ 建前面材质（首次）→ 写 uniform → 画正面（或全屏三角形）→ 弹栈【确】。
- **点光灯体是半径 1 的球**，`FUN_14025c660(_, _, 1.0f, 顶点, 索引)`：两极 `(0, ±1, 0)` 在前，然后 23 圈 × 25 个点，纬度角 `a = float(i)·0.130899698f`（i = 1…23），经度角 `b = float(j)·0.261799395f`（j = 0…24），顶点 `(cosf(b)·(sinf(a)·1), cosf(a)·1, sinf(b)·(sinf(a)·1))`，全是 float32 逐个乘（不累加），`sinf/cosf` 是 MSVC CRT 的 FMA 版（内部转 double 再舍回 float）。按这个公式复算抓帧的两个值 `−0.033782683` / `0.03378266841` **逐位相同**；接缝顶点 j = 24 的 z 是 `2.28e-8` 不是 0【确：码 + 抓帧】。经纬分段数是常量（参数 ecx / edx 不读）【确】。
- **非点光的灯体在裁剪空间里建，再用 `inverse(light+0x338)` 变回世界**：`usecookie` 时是 NDC 立方体 `[−1,1]² × [0,1]`（8 点 12 面，`0x1401970a4`），否则是 32 段的 NDC 圆柱（半径 1，`0x140197258`）。`light+0x338` 是聚光的 `V·P`（`FUN_14025d420` 类型 1：看向灯的局部 +X，fovY = 2·outercone，宽高比 1，近平面 正交 1 / 透视 0.05，远平面 `max(radius, near + 0.01)`），所以圆柱 = 半角 outercone、从 near 到 far 的截头圆锥，立方体 = 整个聚光视锥【确】。**管光、平行光开 castvolumetrics 也画、走同一条非点光路径，但 `light+0x338` 从不为它们计算（构造时也不初始化）**，用的是堆上残留值【确：没有类型排除、写点只有类型 0/1；推：画面不可预测】。
- **`g_AltViewProjectionMatrix`**：点光 = `diag(r, r, r, 1)` 第 3 行 = `(世界位置, 1)`，r = 原始 `radius` 字段（不乘系数、不乘世界缩放），位置 = 世界矩阵第 3 行（含父链）；非点光 = `inverse(light+0x338)`。`g_AltModelMatrix` 一律 = `light+0x338`【确】。非点光的 `g_RenderVar3` = 世界矩阵第 0 行**原值**（不归一化，带对象缩放）【确】。
- **`g_EffectModelMatrix = inverse(g_ViewProjectionMatrix)`**（`ctx+0x970 = FUN_14005f730(ctx+0x930)`，`0x140198555`），求逆是 float32 的 GLM `compute_inverse` 标量版；对抓帧复算 16 个值连正负零都逐位相同。透视、正交同一段代码；正交 + 视差时 VP 含这盏灯根对象的视差平移【确】。
- **切到 `volumetrics_fullscreen` 的判定在 `0x1401979bd`–`0x1401980e5`**，不是 `FUN_140185940`（那是 `usecookie` 位的读取）。点光：`p = eye + 0.2·g_ViewForward`，`r² > |p − 灯心|²` 即在内；聚光：`p` 同上，沿灯轴投影 `t`、离轴距离 `perp`，`0 < t ≤ radius` 且 `t/radius·R_far ≥ perp`；cookie：`p = eye + 0.1·F` 在视锥六个平面内。正交场景同样判（eye 是 `(W/2, H/2, 2000)`），灯够大照样触发。**切换后背面 pass 照画**，只把正面换成全屏三角形【确】。
- **`G+0x468` bit0 不是「场景有体积光」，是「当前这次 `FUN_14018aac0` 是主 pass」**：每次进绘制列表函数先清 bit0 再 `|= (模式 == 0)`（`0x14018aacf`、`0x14018ab27`）。场景构造时 bit0 = 0、bit1 = 1、bit2 = 0（`0x14018712d`–`0x140187150`）【确】。灯的 `+0x68` = 自己可见 ∧ 父链可见 ∧ `castvolumetrics`，不看 `lightconfig`、灯数、阴影档【确】。
- **`SHADOW` COMBO 与阴影条目不一致时**：`g_RenderVar0 = light+0x310`、点光 `g_RenderVar3 = light+0x320` 只在灯光函数给这盏灯生成阴影条目的那一帧写；没分到条目（`lightconfig` 没有 pointshadow、投影灯超配、`lightconfig` 为空）就保留上次写的值，从没写过则是构造时没初始化的堆内存【确】。
- **清屏色 `(0,0,0,1)` 的副作用在本帧没有可见影响**：场景渲染里所有其它设备清屏前都显式设了清屏色；唯一读「当前清屏色」的主 pass / 反射 pass 清屏在体积光之前，下一帧开头又重设【确，有界：设备虚表 `+0x120` 的全部调用点】。
- **合成目标总是主 pass 的当前目标**；灯若是组（带子层的组合层）的子孙，由组的子树绘制画，`_rt_volumetricsBack` 的深度拷贝源变成组的合成 RT（没有深度），合成仍在主列表里组之后的第一个可见非灯对象之前、画进主目标【确：路径；推：拷贝结果】。
- **HDR 不乘任何额外系数**；LDR 时 LightBuffer 是 RGBA8，一段灯的累加在合成前就被钳到 1【确】。`QUALITY` = volumetrics 档，`LIGHTS_SHADOW_MAPPING_QUALITY` = shadows 档且**只给点光**，模糊在 volumetrics 档 < 3 时做【确】。
- **雾同普通材质**：`FOG_DIST` / `FOG_HEIGHT` 由通用宏生成器按「general 开雾且组合表 `FOG` 非 0」定，`volumetricsfront` 的 `FOG` 缺省 1【确：生成器；推：缺省值并进这条材质的组合表】。
- **状态残留**：灯体网格、背面 / 正面 / 全屏材质只建一次，只在 `light`（类型）、`castshadow`、`usecookie` 改变时由回调 `FUN_14025c610` 丢掉重建；半径、颜色、强度、锥角、位置、隐藏都只走每帧取值，不重建网格或 RT【确】。

**命名**（沿用前作 `R`、`G`、`ctx`、`dev`）

- `vol = G+0x50`（场景的一个子接口，`ctx+0x1510` 指向它）。RT 槽 `vol+0x3d8` Back、`+0x3e0` Single、`+0x3e8` LightBuffer、`+0x3f0` LightBufferB、`+0x3f8` 全屏三角形网格、`+0x400` combine、`+0x408` blur_h、`+0x410` blur_v 材质；`vol+0x418 = G+0x468` 标志字节。
- 灯（`light`，0x3a0 字节）：`+0x2c0` 类型（0 点、1 聚、2 管、3 平行）、`+0x2c4` bit0 castshadow / bit1 usecookie / bit2 castvolumetrics、`+0x2cc` color、`+0x2e4` intensity、`+0x2e8` radius、`+0x2f0/+0x2f4` inner/outercone（度）、`+0x2f8` density、`+0x2fc` volumetricsexponent、`+0x310` 阴影方块变换、`+0x320` 点光阴影投影四元组、`+0x330` cookie 纹理、`+0x338` 投影 / 视图投影（64 字节）、`+0x378` 灯体网格、`+0x380` 背面材质、`+0x388` 全屏材质、`+0x390` 正面材质。
- uniform 在 `ctx` 里的位置（`FUN_1400d8300` 按 ID 取值）：`+0x930` VP（0xb）、`+0x970` `g_EffectModelMatrix`（0x13）、`+0xa70` `g_AltModelMatrix`（0xf）、`+0xab0` `g_AltViewProjectionMatrix`（0x11）、`+0xa8/+0xb8/+0xc8/+0xd8/+0xe8` `g_RenderVar0–4`。
- 渲染标志 `ctx+0x118`：bit1 MSAA（`BACKBUFFER_MS`）、bit10 正交、bit12 `REVERSEDEPTH`（`0x1401a67b6`）、bit13 HDR（`FUN_14017e750`）、bit23 / bit24 雾。壁纸进程 bit12 恒置（`0x100d`）。

---

## V1 灯体网格

### 1.1 点光球 `FUN_14025c660`【确：码 + 抓帧逐位】

调用：`0x14019708a`，`xmm2 = 1.0`（`0x140492704`），`r9` = 顶点 vector（`vec3` float，12 字节/点），栈参 = 索引 vector（u16）。ecx / edx 的家空间被当临时变量覆盖，从不读——**分段数是写死的**。

```text
push (0,  R, 0); push (0, -R, 0)                // R = 1；两极，下标 0、1
base = 顶点数（= 2）
for i in 1..=23:                                // cmp r14d, 0x18; jl
    a  = float(i) * 0.130899698f                // 0x140492658 = 7.5° 的弧度，float 乘
    sa = sinf(a) * R;  ca = cosf(a)
    for j in 0..=24:                            // cmp edi, 0x18; jle
        b = float(j) * 0.261799395f             // 0x140492690 = 15°
        push (cosf(b) * sa, ca * R, sinf(b) * sa)
for ring in 0..22:                              // 22 条带
    A0 = base + 25·ring;  A1 = A0 + 25
    for j in 0..24:
        tri(A0+j, A0+j+1, A1+j); tri(A0+j+1, A1+j+1, A1+j)
L = base + 22·25                                 // 最后一圈
for j in 0..24:
    tri(0, base+j+1, base+j); tri(1, L+j, L+j+1)  // 两极用绝对下标 0、1
```

- `0x14041a9c0` = `sinf`、`0x14041a2e0` = `cosf`（小角度分支分别是 `x·c + c'` 与 `1 − …`），实现是 `vcvtss2sd` 后在 double 里求多项式再舍成 float，等价于「double 的 sin 再舍入」。
- 复算脚本 `ignore/p13/rea/volumetrics/chk_sphere.py`：577 点、3312 个索引；第 1 圈经度 105° 的 x = `−0.033782683312892914`、75° 的 x = `0.03378266841173172`，与抓帧逐位相同（不对称的 ULP 来自 `cosf(float(7)·step)` 与 `cosf(float(5)·step)` 各自舍入）。第 1 圈 y = `0.9914448857307434`；j = 24 的接缝点 z = `2.2821925682592337e-08`（`sinf(float(24)·step)`），不是 0。
- 绕序：按右手系从外看是逆时针（手算第一个三角形，法线朝外）【推】。主 pass 的剔除方向由抓帧（back、front_ccw）决定，照抄抓帧。

### 1.2 非点光（`0x140197094` 起）【确】

`FUN_140185940` = `light+0x2c4` bit1（`usecookie`）。z 值 `z10 = REVERSEDEPTH ? 0 : 1`、`z11 = REVERSEDEPTH ? 1 : 0`（`FUN_14025c5d0` / `FUN_14025c5f0`）；壁纸进程 `z10 = 0`（远）、`z11 = 1`（近）。

- **cookie：NDC 立方体**。`FUN_1401a2f40(out, int x, int y, float z)` 只写 out，调用之间寄存器不变（LTCG）：
  - 顶点 0–3 `(−1,−1,z10) (1,−1,z10) (1,1,z10) (−1,1,z10)`，4–7 同样四个角在 `z11`。
  - 索引（u16，按 dword 常量拼）：`(1,0,2) (2,0,3) (4,5,6) (4,6,7) (3,0,4) (3,4,7) (1,2,5) (5,2,6) (2,3,6) (6,3,7) (0,1,5) (0,5,4)`，36 个。
- **非 cookie：NDC 圆柱，32 段**。
  - 先压两个盖心 `v0 = (0.5, 0.5, z11)`、`v1 = (0.5, 0.5, z10)`——**盖心不在圆心**（WPE 的写法）；因为点在圆内，扇形仍恰好铺满圆盘，形状不受影响。
  - 每段 k = 0…31：`a = (float(k)·0.03125f)·6.2831855f`、`a2 = a + 0.19634955f`（float 加，不是 `(k+1)·…`），`c = 当前顶点数`，压 `(sinf a, −cosf a, z10)`、`(sinf a2, −cosf a2, z10)`、`(sinf a, −cosf a, z11)`、`(sinf a2, −cosf a2, z11)`（每段 4 个独立顶点，不共享）。
  - 三角形：`(c+2, c, c+1)`、`(c+2, c+1, c+3)`（侧面），`(1, c+1, c)`（z10 盖），`(0, c+2, c+3)`（z11 盖）。共 130 点、128 面、384 索引。
- 两种网格都交给 `inverse(light+0x338)`（V2）：圆柱的半径 1 在 fov = 2·outercone、宽高比 1 的透视下正好是半角 outercone 的圆锥，z10 盖在远平面（= max(radius, near + 0.01)），z11 盖在近平面（透视 0.05、正交 1.0）；立方体是整个方形视锥。所以「底面在远平面、半径 = far·tan(outercone)，顶端是近平面上半径 near·tan(outercone) 的小圆」。
- **聚光投影 `FUN_14025d420` 类型 1**（`0x14025d451`–`0x14025d9b0`）：
  - 视图同平行光级联（rea-p13-shadows R3 第 6 步）：取世界矩阵 0/1/2 行，`n0 = qnorm(Z)`、`n1 = qnorm(Y)`、`n2 = qnorm(−X)`（`0x5f375a86` + 一次牛顿），V 的列是 `n0, n1, n2`，平移 `−((V_0j·px + V_1j·py) + V_2j·pz)`。看向局部 +X，up = 局部 +Y。
  - 投影 `dev+0x10(P, fovY = (outercone + outercone)·0.017453292f, 1.0, near, far)`；`near = 渲染标志 bit10 ? 1.0 : 0.05`——**不读 `lightsourcesize`**（点光读）；`far = radius > near + 0.01 ? radius : near + 0.01`。
  - `light+0x338 = V·P`（`FUN_14005ecb0(out, P, V)`）。
- **管光、平行光**：`+0x50` / `+0x68` 只看 castvolumetrics，体积光函数只分「类型 0」与「其它」，所以它们照样画，走圆柱 / 立方体 + `inverse(light+0x338)`、着色器走非 `POINTLIGHT` 的锥形衰减。可是 `FUN_14025d420` 对类型 ≥ 2 直接返回，灯光函数也只在点光 / 聚光分支调它（`0x140192f37`、`0x140193255`、`0x140193379`），灯构造（`0x1401903ba`–`0x140190510`）不写 `+0x310..+0x377`。所以矩阵是堆上残留值【确：写点；推：画面不可预测】。

### 1.3 全屏三角形（`vol+0x3f8`，`0x14019783d`）【确】

3 个顶点，每个 `pos(3) + uv(2)`：`(−1, 1, 0 | 0, 1)`、`(−1, −3, 0 | 0, −1)`、`(3, 1, 0 | 2, 1)`；渲染标志 bit0（壁纸恒置）时 uv 改成 `(0,0)`、`(0,2)`、`(2,0)`。正面全屏变体、两次模糊、合成共用它。

---

## V2 每种灯的矩阵与 RenderVar【确】

背面 pass（`0x1401975b4`–`0x1401977f1`）与正面（`0x14019852f`–`0x1401987f5`）写的值：

| uniform | 点光 | 聚光（及管 / 平行） |
|---|---|---|
| `g_AltViewProjectionMatrix`（`ctx+0xab0`） | `[[r,0,0,0],[0,r,0,0],[0,0,r,0],[px,py,pz,1]]`，r = `light+0x2e8` 原值，p = 世界矩阵第 3 行 | `inverse(light+0x338)`（`FUN_14005f730`，`0x14019759f` 背面、`0x14019797b` 正面） |
| `g_AltModelMatrix`（`ctx+0xa70`） | `light+0x338`（点光阴影的 P，着色器 `POINTLIGHT` 不读） | `light+0x338`（聚光 V·P，阴影 / cookie 的投影） |
| `g_EffectModelMatrix`（`ctx+0x970`） | `inverse(ctx+0x930)`（V3） | 同 |
| `g_RenderVar0` | `light+0x310` | 同 |
| `g_RenderVar1` | `(radius·0.99f, cosf(inner·0.017453292f), cosf(outer·0.017453292f), intensity)` | 同 |
| `g_RenderVar2` | `(世界矩阵第 3 行 xyz, density)` | 同 |
| `g_RenderVar3` | `light+0x320`（点光阴影投影四元组） | **世界矩阵第 0 行原值**（4 个 float，w 一般 0） |
| `g_RenderVar4` | `(color.rgb（`+0x2cc..+0x2d4`，不乘强度）, volumetricsexponent)` | 同 |
| 纹理 | — | `usecookie` 且 `+0x330` 非空时写进材质 `+0xe0`（cookie 槽） |

- 抓帧核对：`g_AltViewProjectionMatrix` = `700.21997 × I₃ + (2022.1543, 1620.2838, 250)`，`g_RenderVar1.x = 693.2178 = 700.22 × 0.99f`。
- **父对象 / 缩放 / 旋转**：点光只取世界矩阵的平移（含父链），半径不乘缩放、旋转无关；`g_RenderVar2` 与「在内」判定用同一个平移。聚光的朝向用归一化后的轴（缩放被约掉，切变不处理），近远与 fov 用原始字段；**只有 `g_RenderVar3` 带缩放**：着色器 `smoothstep(outer, inner, dot(normalize(delta), fwd))` 里 `fwd` 长度是 s，等于把 cos 乘 s。
- **0.99 的配合**：正面顶点着色器对非点光把 NDC 的 xy 乘 0.99（背面不乘），让正面的圆锥 / 立方体侧面整体缩进背面一点，正面片元总在背面之前；点光正面、背面是同一个球，靠背面剔除自然分开。`g_RenderVar1.x = 0.99·r` 给着色器的 `invRadius`，让径向衰减在网格之内归零。
- 背面 pass 先 `dev+0xc0`（剔除取反）再画，材质 `cullmode normal`，画到的是背面；画完再取反还原（`0x14019782a`）。

---

## V3 `g_EffectModelMatrix`【确：码 + 抓帧逐位】

- `0x14019853f`：`ctx+0x1ca`（变换脏）时先 `FUN_1400d4200` 重算 VP / MVP；然后 `FUN_14005f730(&tmp, ctx+0x930)`，`ctx+0x970..0x9ac = tmp`（`0x1401986d7`）。输入就是当前的 `g_ViewProjectionMatrix`（视图栈顶 × 投影栈顶，行向量约定，即 `V·P`）。
- `FUN_14005f730` 是 GLM `detail::compute_inverse<4,4,float>` 的标量展开：18 个 2×2 子式 → 6 组余子式向量 → 乘符号 `(+,−,+,−)` / `(−,+,−,+)`（常量 `0x1404929b8 = −1`）→ 行列式 `(D0+D1)+(D2+D3)` → `1/det` 乘全部。全程 float32，没有 double。
- 复算 `ignore/p13/rea/volumetrics/chk_inv.py`：对抓帧 VP 得到 `(1920, −0, 0, −0, −0, 1080.0001220703125, −0, 0, 0, −0, 3999.999755859375, −0, 1920, 1080.0001220703125, −1999.9998779296875, 1)`，16 个值（含正负零）与抓帧逐位相同。
- 透视场景同一段代码；正交 + 视差时绘制循环 `0x14018afd0` 起对每个对象（含灯）压一份带视差平移的 V，所以这里的 VP 含灯根对象的视差偏移，灯体也按这个 V 画。
- **更正 effect-matrices-REPORT S1**：它说「粒子绘制（`0x1401986de`）只写 0x970」——这个地址是体积光正面 pass，写的是 `inverse(VP)`。

---

## V4 何时切到 `volumetrics_fullscreen`【确】

判定在 `0x14019796d`–`0x1401980e5`，结果 `r15b`；材质 `light[0x388 + 8·(r15b ^ 1)]`：在内 → `+0x388`（`volumetrics_fullscreen.json`），否则 `+0x390`（`volumetrics_front.json`）（`0x140198536`）。所用 eye = `ctx+0x68`（`g_EyePosition`），F = `ctx+0x160`（`g_ViewForward`），灯心 = 世界矩阵第 3 行。全部 float32。

- **点光**（`0x140198071`）：`p = eye + F·0.2f`（`0x14049267c`，逐分量 `F·0.2 + eye`）；`d = p − 灯心`；在内 ⇔ `r·r > (dx² + dy²) + dz²`（`comiss` + `seta`，严格大于，r 是原始 radius）。
- **聚光 / 无 cookie**（`0x140197b54`）：
  - `p` 同上，`d = p − 灯心`；`a = 世界矩阵第 0 行 / sqrt(x² + y² + z² + w²)`（`sqrtss`，不是快速倒数平方根）。
  - `t = (a.y·d.y + a.z·d.z) + a.x·d.x`；`perp = |d − a·t|`。
  - `R_far` = 把 NDC 的 `(0, 0, z_far, 1)` 与 `(0, 1, z_far, 1)` 经 `inverse(light+0x338)` 变回世界、各自除 w 后的距离（`z_far = REVERSEDEPTH ? 0 : 1`），即远平面上圆的半径【确：结构；推：逐条运算顺序没核】。
  - 在内 ⇔ `t > 0` ∧ `radius ≥ t` ∧ `(t / radius)·R_far ≥ perp`。
- **cookie**（`0x1401979c3`）：`FUN_1401849e0` 由 `light+0x338` 求六个视锥平面；`p = eye + F·0.1f`（`0x140492654`，注意不是 0.2）；六个平面都有 `dot(n, p) + w ≥ 0` 才在内（任一 `0 > 值` 就在外；NaN 当在内）。
- **没有余量**（除了 0.2 / 0.1 的前移）。**正交场景照样判**：eye = `(eye.x + W/2, eye.y + H/2, 2000)`、F = `(0,0,−1)`，p ≈ `(W/2, H/2, 1999.8)`；3287715210 的灯 z = 250、r = 700.22，`dz ≈ 1750 > r`，不触发，与抓帧一致。
- **切换后**：背面 pass 照常画（它在判定之前，`0x1401977b4`–`0x14019782a`），Single 里仍是灯体背面深度；正面用全屏三角形（`FULLSCREEN = 1`，顶点着色器直接 `gl_Position = (xy, 1, 1)`，`nocull`）。光线从近平面（深度 1）出发。

---

## V5 体积光对象标志与灯的「可画」【确】

- `G+0x468`（= `vol+0x418`）：
  - bit0：**当前这次 `FUN_14018aac0` 是主 pass**。函数入口 `and [G+0x468], ~1`（`0x14018aacf`），再 `or [G+0x468], (模式 == 0)`（`0x14018ab24`–`0x14018ab27`）。帧里先阴影 pass（模式 2）清掉，反射 pass（模式 1）仍为 0，主 pass（模式 0）置 1，主 pass 结束后一直保持到下一帧阴影 pass。`FUN_140196ce0` 开头 bit0 为 0 就返回。**更正 rea-p13-passes 3.1「推测是场景里有 castvolumetrics 的灯」。**
  - bit1「需要清」：场景构造置 1（`0x140187145`）；一段灯里第一盏画到 LightBuffer 时清 bit1、置 bit2 并清颜色（`0x14019791f`）；合成 `FUN_140198d00` 开头置 bit1、清 bit2（`0x140198d10`）。
  - bit2「待合成」：构造清 0；上面两处翻转。
- 灯的 `+0x68`（`FUN_14025d330`）= `obj+0x120 bit0`（visible）∧ 父链每级 bit0（`FUN_140185010` 递归）∧ `+0x2c4 bit2`。**不看 `lightconfig`、灯光数是否超配、shadows 档**；volumetrics 档为 0 由体积光函数开头另判（`0x140196d1e`）。
- 主列表循环还先跳过 `obj+0x120 bit1`（「由组画」，`0x14018adb9`）。bit1 由 `FUN_1401dd9a0` / `FUN_1401dd900` 置：父对象带 bit1 或 bit2（组）时，子孙递归置 bit1，不分类型，灯也一样。
- 合成触发：主列表里每个对象 `+0x68` 为真之后、`+0x50` 之前，`bit0 ∧ 类型 ≠ 6 ∧ bit2` → 合成（四个循环变体 `0x14018ade4`、`0x14018ae8e`、`0x14018af1e`、`0x14018afe4`）；列表结束 bit2 仍在再合成一次（`0x14018b1e2`）。**不可见的非灯对象不触发**（`+0x68` 在前）。正交 + 视差的循环里 bit1 检查排在合成之后，所以那里「由组画」的可见对象也会触发合成【确：顺序】。

---

## V6 `SHADOW` 开但灯没分到阴影条目【确，另注】

- `SHADOW = castshadow ∧ shadows 档 ≠ 0`，在**第一次画**（或回调重置后）建材质时定（`0x1401981ea`）。
- `light+0x310`（`g_RenderVar0`）的写点只有阴影条目循环 `0x140196114`、`0x1401962d8`（每个条目写一次，平行光三级里最后一级胜出）；`light+0x320`（点光 `g_RenderVar3`）只有 `0x140193472`（点光生成阴影条目时）。灯构造 `0x1401903ba`–`0x140190510` 不写 `+0x310..+0x32f`，`operator new` 不清零。所以：
  - 本帧分到条目：本帧值；
  - 本帧没分到但以前分到过（比如运行中别的灯抢了名额）：上次的值；
  - 从没分到（`pointshadow` 为 0、投影灯超过 `pointshadow`、`lightconfig` 为空——灯光函数 `0x140190cab` 直接返回）：堆上残留值。
- 聚光同理；另外聚光的 `light+0x338` 在灯光函数里只要「这盏灯占到聚光槽」（`[rbp-0x64]` 余量 > 0）且「有阴影 / cookie 条目，或 cookie 位，或 volumetrics 档 ≠ 0 ∧ castvolumetrics」就算（`0x140193231`–`0x140193255`），所以 `lightconfig` 的 spot 数不够或为空时聚光的灯体矩阵也是残留值。点光的灯体不依赖这些。
- **`g_Texture0`（`_rt_shadowAtlas`）没建时**：材质建立时按名字解析纹理，解析不到退回 6×6 黄黑棋盘格（p13-REPORT B3 对 `_rt_Reflection` 的实测是同一条路径）【推】；用比较采样器采 RGBA8 棋盘格在 D3D11 上是非法组合，结果由驱动定【未知】。图集晚于这条材质才建时，材质里的占位会不会被换成 RT 没读到【未知】。

---

## V7 清屏色副作用【确，有界：设备虚表 `+0x118` / `+0x120` 的全部 call / jmp 点】

设备虚表 `0x140485b90` 的 `+0x118` = `0x14009b140`（设清屏色）、`+0x120` = `0x14009b160`（清屏，读设备当前清屏色）。全仓 `call/jmp [r + 0x120]` 22 处，属于设备的：

| 地址 | 场景 | 清屏色 |
|---|---|---|
| `0x1401835a7` | 主 pass / 反射 pass 开头（`FUN_140183550`） | **设备当前值**：帧函数 `0x140180351` 每帧设的场景清屏色。主 pass 的清屏在体积光之前，反射 pass 在主 pass 之前 |
| `0x1401808c8` | `reflection` 关时清 `_rt_Reflection` | 同上，体积光之前 |
| `0x140196599` | 阴影图集 | 只清深度 |
| `0x140196fe9` | `_rt_volumetricsSingle` | 只清深度 |
| `0x140197967` | LightBuffer | 显式 `(0,0,0,1)`（就是副作用的来源） |
| `0x1401ebaa8` | 图像层合成 RT / fbo | 显式（`[rdx+0x14..0x20]`，fbo 记录的清屏色），`0x1401eba85` |
| `0x1401ee4b6` | effect fbo | 显式（`[rbx+8·rdi+0x14..]`），`0x1401ee49a` |
| `0x14020781e` | 组合层 | 显式 `(0,0,0,0)`，`0x140207802` |
| `0x14020802e` | 组的合成 RT（`copybackground` 关） | 显式 `(0,0,0,0)`，`0x140208012` |
| `0x14020d781` | 文本层 | 显式（两种），`0x14020d753` |
| `0x140257cbe` | 文本背景（尾调用） | 显式（颜色 × 系数），`0x140257c9d` |
| `0x140181d61` | `_rt_MipMappedFrameBuffer` 建立 | 显式 `(0,0,0,1)` |
| `0x140115b15` | 运行中关 `reflection` | 显式 |

其余 `+0x120` 调用是 D3D 上下文或别的对象的虚表。所以体积光之后同一帧里没有清屏读到 `(0,0,0,1)`；下一帧 `0x140180351` 重设。**更正 rea-p13-passes 3.2 第 5 步与第 5 节补充里的「影响后面的清屏」**：实际没有可见影响。

---

## V8 合成的目标与嵌套【确，另注】

- `FUN_14018aac0` 的调用者只有两个：`FUN_140183550`（模式 0 主列表 `G+0x158`、模式 1 反射名单 `G+0x1c8`）与阴影 pass `FUN_140196530`（模式 2）。没有给组 / 组合层子树单独调用它。
- 反射 pass：名单只收可画类型（不含灯），而且模式 1 时 bit0 = 0，体积光函数会直接返回——反射图里不会有体积光。
- 主 pass：灯的体积光画进 LightBuffer，合成在它之后第一个可见非灯对象画之前（或列表末尾），合成用的「当前目标」= 此刻 RT 栈顶 = 主 pass 的目标（开 MSAA 时是 MSAA RT，否则后备缓冲）。合成发生在下一个对象压它自己的 RT 之前，所以不会画进别的图层的合成 RT。
- **灯在组（带子层的组合层）里**：灯带 bit1，主列表跳过；组的子树循环（`0x140208460`–`0x1402084c7`）对每个子对象 `+0x68` 为真就调 `+0x50`，所以灯在组的合成 RT 压着时画体积光：
  - `_rt_volumetricsBack.拷贝()`（RT 虚表 `+0x8` = `0x1400d3310`）：自己没有颜色纹理时 `CopyResource(自己深度, 栈顶 RT 深度)`；组的合成 RT 不挂深度，源是空指针【确：代码；推：D3D 运行时拒绝或无效，结果没读】。
  - LightBuffer、Single 照常压栈弹栈，弹回组的合成 RT。
  - bit2 留着，合成在主列表里组之后第一个可见非灯对象之前、画进主目标——**不进组的 RT，而且晚于组的上屏**【确：路径】。
- 灯是普通（非组）对象的子对象：不带 bit1，留在主列表里按 `objects` 顺序画，父对象只影响世界矩阵（V2）。

---

## V9 HDR、QUALITY、模糊【确】

- 正面 uniform 全部列在 V2，没有亮度 / HDR 系数；合成材质是 `passthrough`（无 `TRANSFORM`，`gl_Position = a_Position`），模糊是 `blur_k3`（0.25 / 0.5 / 0.25），都不乘系数。
- LightBuffer / LightBufferB 格式：`FUN_14017e750`（渲染标志 bit13 = HDR）? `0xf` RGBA16F : `1` RGBA8（`0x140196e49`）。**LDR 时一段灯在 LightBuffer 里累加就被钳到 1**，再加进主目标；HDR 不钳。
- LightBuffer 清成 alpha 1，正面只写 RGB（抓帧），模糊输出 alpha 1，所以合成的 `SrcAlpha/One` 实际是纯加法。
- `QUALITY` = `ctx+0x1ad`（volumetrics 档 1–4）（`0x140198273`）；`LIGHTS_SHADOW_MAPPING_QUALITY` = `ctx+0x1ac`（shadows 档），**只在 `POINTLIGHT` 时写**（`0x1401982fa` 跳过非点光，`0x14019838e`）；`COOKIE = 1` ⇔ `usecookie`（`0x14019817e`）。**补正 rea-p13-passes 3.3**：cookie 不只是绑纹理，还有 `COOKIE` COMBO。
- 模糊：建 RT 时 `ctx+0x1ad < 3` 才建 LightBufferB 与两个模糊材质（`0x140196ea0`），合成时同一判断（`0x140198d21`）。合成顺序：压 B → `blur_h`（读 LightBuffer）→ 弹 → 压 LightBuffer → `blur_v`（读 B）→ 弹 → `combine` 画进当前目标。三次都用全屏三角形。

---

## V10 雾【确：生成器；推：缺省并入】

- 引擎宏生成器 `FUN_1401a5c40` 对所有程序同一段（`0x1401a64a0`–`0x1401a666f`）：渲染标志 `& 0x1800000` 非 0 时在组合表里找 `FOG`，存在且非 0 → bit23 定义 `FOG_DIST = 1`、bit24 定义 `FOG_HEIGHT = 1`。与普通材质相同（rea-p13-lights 雾一节）。
- 体积光变体的组合表由代码给（`COOKIE`、`SHADOW`、`QUALITY`、`POINTLIGHT`、`LIGHTS_SHADOW_MAPPING_QUALITY`），材质 JSON 不写 `FOG`；`volumetricsfront.frag` 首行 `[COMBO] FOG default 1`。按 rea-p13-lights「着色器缺省先并进组合表」，`FOG = 1`，所以 **general 开雾时体积光也上雾**【推：缺省并入这条路径没单独核】。
- 着色器里的写法要照抄：`shadowSample *= ApplyFogAlpha(shadowSample, …)`，而 `ApplyFogAlpha` 返回 `alpha·(1 − f²)`，结果是 `shadowSample²·(1 − f²)`（WPE 着色器的写法，不是我们的选择）。雾的视距用 `g_EyePosition − 采样点`，高度用采样点 y。

---

## V11 运行中改变时的残留【确】

- 回调 `FUN_14025c610`（字段描述 `+0x58`）挂在 `light`（类型，`0x14025e531`）、`castshadow`（`0x14025e68d`）、`usecookie`（`0x14025e75c`）三个字段上：清 `+0x380/+0x388/+0x390`（背面、全屏、正面材质指针），释放并清 `+0x378`（灯体网格）。下一次画时按当时的类型 / cookie / castshadow 重建网格与 COMBO。
- `visible`、`castvolumetrics` 没有回调（`+0x58` = 0）；`radius`、`color`、`intensity`、锥角、`density`、`volumetricsexponent`、位置每帧现读进矩阵 / uniform。点光网格是单位球、非点光网格在 NDC 里，**半径与锥角变化都不需要重建网格**。
- 场景级 RT（`vol+0x3d8..`）、全屏三角形、合成 / 模糊材质只在第一次画时建，灯的任何变化都不重建。
- 隐藏：`+0x68` 为假就不画，不碰标志；只要这一帧还有别的灯或没有灯，bit1 / bit2 在合成或下一段开始时归位，没有跨帧残留。
- 残留的只有 V6 的两项：没分到阴影条目时 `+0x310` / `+0x320` 保持旧值，以及非点光在没算投影时 `+0x338` 保持旧值（例如运行中把聚光数配置改小、或这盏灯隐藏后又显示期间别的灯占了槽）。
- shadows / volumetrics 档在建材质时取值，运行中改档有没有整场重建没读【未知】。

---

## 对实现的含义

- 点光网格照 V1.1 生成（float32 乘法 + 「double 求值再舍入」的 sin / cos），两极下标写死 0、1；可以直接用 `chk_sphere.py` 的输出做单测期望值。
- 非点光：只支持「这盏聚光在 `lightconfig` 里占得到槽」的情形；管光 / 平行光开 castvolumetrics、聚光数不够、`lightconfig` 为空时照报（WPE 画的是残留矩阵）。聚光投影近平面 0.05 / 1，不读 `lightsourcesize`。
- `g_EffectModelMatrix` = 按 GLM 顺序的 float32 求逆，输入是本次绘制的 VP（含正交视差偏移）。
- 「在内」判定照 V4 三种公式，切换只换正面网格与材质。
- `SHADOW` 开但没有条目时照报（或给确定值并记为有意不同），不要去模仿堆残留。
- LDR 场景 LightBuffer 用 `rgba8unorm`，让钳制照 WPE 发生。
- 合成时机照 V5：一段连续可见灯共用一次清屏与合成，不可见的非灯对象不打断这段；组里的灯照报。

## 建议实测

- **相机进灯体**：正交场景放一盏 z ≈ 1900、radius 300 的点光，预测正面 pass 换成 3 个顶点的全屏三角形、背面 pass 仍是 3312 个索引。
- **聚光体积光**：`lightconfig` spot 1 的一盏 lspot（不开阴影），读背面 pass 的顶点数（130）与 `g_AltViewProjectionMatrix`，与 `inverse(V·P)` 逐位比；再把 spot 数改 0，看画面是否乱。
- **cookie 聚光**：读 36 个索引、立方体 8 点。
- **castshadow 但 pointshadow 0**：读 `g_RenderVar0` / `g_RenderVar3` 与 `g_Texture0` 绑的资源。
- **LDR 钳制**：同一场景关 HDR，两盏重叠的亮灯，读 LightBuffer 是否饱和在 1。
- **组里的灯**：灯挂在带子层的组合层下，看 `CopyResource` 是否报错、合成落在哪个 RT。

## 未查清

- 聚光「在内」判定 `R_far` 的逐条运算顺序（结构已确认）。
- `_rt_shadowAtlas` 没建时比较采样器读占位纹理的实际结果；图集晚建时材质的纹理槽会不会被接管。
- 组里的灯：`CopyResource` 源为空时 D3D 的实际行为。
- 运行中改 shadows / volumetrics 档是否整场重建。
- `volumetricsfront` 的 `FOG` 缺省值并入代码给定组合表这一步（按通用规则推）。

## 对前作的更正

1. **rea-p13-passes 3.2 第 6 步**：`FUN_140185940` 不是「相机在灯体内」判断，是 `usecookie`（`+0x2c4` bit1）的读取，用来给非点光选立方体 / 圆柱网格；判定在 `0x1401979bd`–`0x1401980e5`（V4）。
2. **rea-p13-passes 3.1 与「未查清」**：`G+0x468` bit0 是「当前绘制列表调用是主 pass」，每次进 `FUN_14018aac0` 重置（V5），不是「场景有体积光」。
3. **rea-p13-passes 3.2 第 4 步**：k = 1——网格是半径 1 的球，矩阵直接乘原始 radius。
4. **rea-p13-passes 3.4**：非点光 `g_RenderVar3` = 世界矩阵第 0 行原值（不归一化），不是推测的「聚光前向」；`g_AltModelMatrix` 对所有类型都写 `light+0x338`；`g_EffectModelMatrix` = `inverse(VP)` 已确认（GLM float32）。
5. **rea-p13-passes 3.3**：`LIGHTS_SHADOW_MAPPING_QUALITY` 只给点光；`usecookie` 另定义 `COOKIE = 1`。
6. **rea-p13-passes 3.2 第 5 步、第 5 节补充**：`(0,0,0,1)` 清屏色在同一帧之后没有被任何清屏读到（V7）。
7. **rea-p13-passes 3.1「与 lightconfig 的关系」**：点光体积光确实不依赖 `lightconfig`；但聚光的灯体矩阵依赖灯光函数里的聚光槽（V6），`lightconfig` 为空时聚光体积光的矩阵是残留值。
8. **effect-matrices-REPORT S1**：`0x1401986de` 是体积光正面 pass 写 `g_EffectModelMatrix = inverse(VP)`，不是粒子绘制。

---

**元数据**

- 目标：`d:\Codes\kabegame\ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（与前作一致）。没运行、没附加 WPE，没改 Steam 目录。REA 没用。
- 方法：全量反汇编 `ignore/p4/rea/wp.asm` 按地址切片；常量、字符串、虚表用脚本读 exe；与抓帧常量做 float32 逐位复算。
- 工作目录 `ignore/p13/rea/volumetrics/`：
  - 脚本：从 `ignore/p13/rea/shadows/` 拷来的 `slice.py`、`fn.py`、`xr.py`、`rd.py`、`strs.py`、`rng.py`、`pe.py`、`grepe0.py`；新写 `vtq.py`（读虚表）、`showvol.py`（抽抓帧里体积光的常量）、`chk_sphere.py`（球网格复算）、`chk_inv.py`（GLM 求逆复算）；模式文件 `pat1.txt`、`pat2.txt`；清屏点列表 `clr120.txt`、`clr118.txt`。
  - 汇编摘录 `asm/`：`vol_full.asm`（体积光函数全段）、`mesh_14025c660.asm`（球）、`front_140198124.asm`（COMBO 与 uniform）、`proj_14025d420.asm` / `proj2.asm`（灯投影）、`inv_14005f730.asm`（求逆）、`drawlist.asm`（绘制列表循环）、`groupdraw.asm`（组子树）、`fields.asm`（灯字段与回调）、`defs.asm`（引擎宏）、`uniget.asm`（uniform 取值）、`lights.asm`、`shadowpass.asm`（灯光函数与阴影 pass）。
- 读的着色器与文件（只读）：`assets/shaders/` 的 `volumetricsback.vert/.frag`、`volumetricsfront.vert/.frag`、`blur_k3.vert/.frag`、`common_blur.h`、`passthrough.vert/.frag`、`common_fog.h`、`common_pbr_2.h`（`CalculateProjectedCoordsPoint`）；`assets/materials/util/volumetrics_{back,front,fullscreen,combine,blur_h,blur_v}.json`；抓帧常量 `ignore/p13/out/wpe-3287715210-high-consts.json`。
- 标记：【确】读到代码（或代码 + 抓帧逐位复算）；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过。
