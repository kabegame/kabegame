> 逆向原始记录，代理写的，地址按 Ghidra（基址 0x140000000）。只读码，没有实测。文中「抓帧」指主会话转来的 RenderDoc 事实（arsenal、fantasticcar、audiophile、3287715210、3453730450），只用来对照，不是本代理实测。

# WPE 2.8.42 P13 主 pass 之外的 pass：平面反射、阴影、体积光、mip 帧缓冲与一帧的顺序

**概括**

- **平面反射的镜面恒为世界 y = 0，不由任何对象或设置决定。** 反射 pass 把视图矩阵栈顶换成 `S · V`（`S = diag(1, −1, 1, 1)`，`FUN_1401844f0` 由整数常量拼出，`FUN_1401842d0` 左乘），再把投影 `P[1][1]` 取反；`g_EyePosition` 与两个视图向量的 y 取反。没有斜裁剪面，着色器里也不裁剪【确】。正交场景走同一段代码【确】。
- **`P[1][1]` 取反是为了配合读反射图的着色器不翻 y。** `generic` / `generic2` / `grid` 用 `clip.xy / clip.w · 0.5 + 0.5` 当屏幕 UV（y 不翻），所以反射图要上下颠倒地画。两次翻转抵消了手性，剔除照主 pass（只看 `alignmentfliph`），不取反【确】。这条只在渲染标志 bit0 置位时成立，而 bit0 在壁纸进程里恒置（`0x140110a19` `mov ebx, 0x100d`）【确】，**更正 rea-p5-mesh「bit0 平时不置」**。
- **反射名单 = 可画对象里 `reflected` 不为 false、且对象标志 bit3 不置位的。** bit3 只由模型在加载网格材质时置位：任一网格材质的纹理槽解析到 `_rt_Reflection`（材质 `+0x1fc` bit0）就置（`0x1402252b9`），整个对象都不进反射【确】。这和三张抓帧的规律一致（fantasticcar 的 Grid、arsenal 的 pistols、audiophile 的 grid 被排除）。
- **反射 pass 的触发是场景标志 `G+0xe0` bit0，不是 `0x20000`。** bit0 = 场景里有对象标志 bit3（即有模型读 `_rt_Reflection`）（`FUN_14018b230` / `0x140183393`）。`_rt_Reflection` 也只在 bit0 时建【确】。之后看用户设置 `reflection`（渲染标志 bit7）：开 → 每帧画反射 pass；关 → 每帧只把 `_rt_Reflection` 清成场景清屏色（alpha 1），不画、不清深度（`0x1401808b6`）【确】。
- **`_rt_Reflection`：窗口客户区尺寸、RGBA8（HDR 下也是）、无 mip、借后备缓冲的 D32F 深度**（深度格式 `0x16 + 4·bit0 = 0x1a`）。`resolution` 设置不影响它【确】。
- **阴影在灯光函数 `FUN_140190c80` 里画，每帧一次，在反射与主 pass 之前**（帧函数 `0x14018031a`）。`lightconfig` 为空时整个函数直接返回【确】。
- **每盏投影灯在图集里占「方块」：边长 S = 256（low、medium）、512（high）、1024（ultra）**（`FUN_14025d3e0`）。点光一块，块内 2 列 × 3 行放六个面（每面 `S/2 × S/3`，整数除）；平行光三级联、每级一块；聚光没读【未知】。多块用打包算法排进图集，图集尺寸 = 打包后的外接尺寸（至少 2）【确：尺寸来源；推：打包算法】。格式 R32_TYPELESS（内部格式 `0x19`），没有颜色【确】。
- **点光阴影投影：竖直 fov 94°（low / medium）、92°（high）、91.2°（ultra），宽高比 1；近平面 = 正交场景 ? 1 : max(0.05, `lightsourcesize`)，远平面 = max(radius, near + 0.01)，反向深度**（`0x14025d9c1`）【确】。渲染标志 bit10 是「场景是正交」（`0x14018768a`）【确】。`g_LFeature_ShadowPointProjection = (P22, P32, P23, P33) = (n/(f−n), n·f/(f−n), −1, 0)`，与 3287715210 抓帧 `(0.00143, 1.00143, −1, 0)`（n = 1、f = 700.22）吻合。
- **阴影 pass 一批最多 6 个视图，用实例化：实例号选视图矩阵 `g_ViewportViewProjectionMatrices[6]` 与视口**（`shadowcaster.vert` 写 `gl_ViewportIndex`）。光栅状态带 SlopeScaledDepthBias −4，**缺省剔除竟是 NONE**（光栅序号 4 漏改 CullMode），非点光视图的 VP 另把 `m32` 减 0.0005【确】。
- **投射者 = `castshadow`（对象标志 bit11，基类属性，模型缺省开）且不透明（bit10，只有模型置）**，实际只有模型能投射【确，有界】。投射着色器取材质片元着色器注解 `// [PASS] shadow <名>`（`chroma4` / `foliage4` / `fur4`），没有注解用 `shadowcaster`【确】。
- **比较采样器：`COMPARISON_MIN_MAG_MIP_LINEAR`、三轴 BORDER、边框色 0、比较 GREATER**（`0x140099a74`）【确】，与抓帧一致。
- **`shadows: disabled`**：解析 `lightconfig` 时把 `pointshadow` / `directionalshadow` / `spotshadow` 丢掉，`spotshadowcookie` 改记进 `spotcookie` 的位（按位或）（`0x140187c39`）；`LIGHTS_SHADOW_MAPPING` 不定义，着色器不声明阴影图集；不建图集、不画阴影 pass【确】。
- **体积光是灯对象自己的绘制：在 `objects` 里灯的位置画进 `_rt_volumetricsLightBuffer`，在下一个不是灯的对象之前（或列表末尾）合成到主目标**（`FUN_14018aac0` 里的 `FUN_140198d00`）【确】。缩放：low / medium 1/8、high / ultra 1/4；low / medium 合成前多两次 `blur_k3`（H、V），所以抓帧里是 3 次与 1 次全屏 pass【确】。`volumetrics: disabled` 时整段跳过【确】。
- **`_rt_MipMappedFrameBuffer` 的更新受 `reflection` 设置控制。** 开：主 pass 全部画完之后、泛光之前，每帧把当前目标（后备缓冲，MSAA 已解析）的 0 级拷进去再 `GenerateMips`，所以主 pass 里读它的对象拿到的是**上一帧**的画面；关：加载时（以及运行中关掉的那一刻）清成 `(0,0,0,1)` 并生成 mip，之后不再更新【确】。这解释了 3453730450 抓帧里整张是黑。mip 数 = max(1, min(log2(npot(w)/2), log2(npot(h)/2)) − 2)，1920×1080 为 8【确】。
- **一帧的顺序**：相机 → 脚本 → 灯光 uniform 与阴影 pass → 反射 pass（或清 `_rt_Reflection`）→ 主 pass（中间穿插体积光合成与 `_rt_FullFrameBuffer` 快照）→ `_rt_FullFrameBuffer` 拷贝（泛光路径）→ mip 帧缓冲 → 泛光 / HDR 合成。地址见第 5 节。

**命名**

- `R`：场景渲染器（帧函数 `FUN_14017fa70` 的 `this`）；`G = *R`：场景对象；`ctx = R+0x10 = G+0xd8`（对象代码里的 `obj+0xc8`）。渲染标志 `R+0x128 = ctx+0x118`。
- `dev = R+0x1528`：设备封装，虚表 `0x140485b90`。几个槽：`+0x10` 透视投影（`FUN_14009a360`）、`+0x18` 正交（`FUN_14009a630`）、`+0x70` 建 RT、`+0xa0` 深度偏移光栅位、`+0xa8` 开剔除、`+0xb0` 剔正面、`+0xc0` 剔除方向取反、`+0x118` 设清屏色、`+0x120` 清屏 `(颜色?, 深度?)`。
- RT 对象虚表 `0x140486768`：`+0x8` 从当前目标拷贝（有颜色纹理时 `ResolveSubresource` 颜色，没有时 `CopyResource` 深度）、`+0x10` 把自己解析进当前目标、`+0x18` `CopyResource` 颜色、`+0x20` `GenerateMips`、`+0x48` 绑定、`+0x50` 绑回缺省目标。RT 栈：压栈 `[mgr+0x50] += 8` 后调 `+0x48`。
- 内部格式（`FUN_1400d2a20`）：`1` RGBA8_UNORM、`0xf` RGBA16_FLOAT、`0x16` D16_UNORM、`0x17` / `0x19` R32_TYPELESS、`0x18` D32_FLOAT、`0x1a` 借后备缓冲深度、`0x1b` 无。
- 各 RT 在 R 里的槽：`R+0x3090` `_rt_Reflection`、`R+0x3098` `_rt_FullFrameBuffer`、`R+0x30f8` `_rt_MipMappedFrameBuffer`、`R+0x3100` `_rt_FullFrameBufferMultiSampled`；`G+0x420` `_rt_shadowAtlas`；`G+0x428..` 体积光（`G+0x50` 子对象的 `+0x3d8..`，即 `G+0x428` 起，见第 3 节）。
- 画质：`ctx+0x1a8` MSAA 档、`ctx+0x1ac` shadows 档、`ctx+0x1ad` volumetrics 档（建渲染器时从 `W+0x244/+0x245` 拷来，`0x14017c883`）。档位 0 disabled、1 low、2 medium、3 high、4 ultra（p2 G1）。

---

## 1. 平面反射

### 1.1 帧里的入口与条件【确】

帧函数 `FUN_14017fa70`：
- `0x14017fb28`：`r12b = R+0x128 bit7`（用户设置 `reflection`）。
- `0x14018035a`：`G+0xe0 & 1` 为 0 → 整段跳到主 pass（`0x1401808ff`）。
- bit0 为 1 且 `reflection` 开（`0x140180367`）→ 反射 pass（1.3）。
- bit0 为 1 且 `reflection` 关（`0x14018089c`）→ 压 `_rt_Reflection`，`dev+0x120(颜色 1, 深度 0)`，弹栈。清屏色是 `0x140180351` 刚设的场景清屏色（`clearcolor`，或 alignment 时的 `schemecolor`，alpha 写 1.0）。**不看 `clearenabled`**，每帧都清【确】。arsenal 抓帧 `(0,0,0,1)` 即它的清屏色。

`G+0xe0` bit0 的来源（`FUN_14018b230`，加载后另一处 `0x140183369` 相同）：先清 bit0、bit11、bit17，再遍历全部对象，对象标志（虚函数 `+0x58`，缺省实现 `0x140185000` 就是 `obj+0x120` 的低 16 位）bit3 → `G+0xe0 |= 1`，bit6 → `|= 0x800`，bit12 → `|= 0x20000`【确】。rea-p5-mesh 把 `0x20000` 记成「需要反射」是误读，`0x20000` 的作用这里没追【未知】。

### 1.2 `_rt_Reflection` 的建立（`FUN_140181af0` `0x140181c0e`）【确】

| 项 | 值 |
|---|---|
| 条件 | `G+0xe0 & 1`；不满足且已存在时释放（`0x140181c78`） |
| 尺寸 | `R+0x8c × R+0x90`，即后备缓冲（窗口客户区）的整数尺寸（`FUN_14017f1b0` resize 时写，至少 2），缩放 1 |
| 颜色 | 内部格式 1 = RGBA8_UNORM，**不随 HDR 变**（同处 `_rt_MipMappedFrameBuffer` 才看 HDR） |
| 深度 | `0x16 + 4·(R+0x128 & 1)` = `0x1a`（壁纸进程 bit0 恒置）→ 借后备缓冲的 D32_FLOAT 深度（rea-p5-mesh 3.1） |
| mip / MSAA | 无 / 无 |

- `resolution` 设置：`full` 清渲染标志 bit4、bit5，`half` 置 bit5，其他值置 bit4（`0x1401155f6`–`0x14011562c`）。读这两位的只有 `FUN_14017e6f0`（决定是否 2× 视口），而帧函数只在渲染标志 bit0 为 0 时调它（`0x14017fae6`），壁纸进程不会走到。所以 `resolution` 不影响 `_rt_Reflection`，也不影响场景渲染尺寸【确，有界：渲染标志与 `W+0x248` 上 bit4 / bit5 的全部读点】。
- 用户 `config.json` 键：`general.user.reflection`（bool，缺键补 `true`，`0x140047457`）、`resolution`（缺键补 `"full"`）。运行中改 `reflection` 走 `FUN_140115a90`，直接改 `R+0x128`，不重建渲染器；关掉的那一刻顺带把 `_rt_MipMappedFrameBuffer` 清黑（4.2）【确】。

### 1.3 反射 pass（`0x140180370`–`0x140180893`）【确】

1. `R+0x1da = 1`；视图矩阵栈（`R+0x48`）压一份当前 V 的拷贝。
2. `FUN_1401844f0` 用 16 个 int 拼矩阵（int → float）：`S = diag(1, −1, 1, 1)`，没有平移。
3. `FUN_1401842d0(V顶, &S)`：`V顶 = S · V`（`FUN_14005ecb0(out, a, b)` 算的是 `b · a`，`0x14005edd6` 起逐行核对）。行向量约定下即「先在世界里关于 y = 0 镜像，再进视图」。**镜面恒为世界 y = 0**。
4. 用同一个 S 变换并暂存：`g_EyePosition`（`ctx+0x68 = R+0x78..`）、`R+0x17c..`（`ctx+0x16c`）、`R+0x188..`（`ctx+0x178`）。按 rea-p5-camera 的 uniform 名表，这两个向量是 `g_ViewRight`、`g_ViewUp`。**`g_ViewForward`（`ctx+0x160 = R+0x170`）没有被改写**【确：没改；推：名字对应】。抓帧里 `g_EyePosition` 的 y 取反，与此一致。
5. 渲染标志 bit0 置位时（壁纸进程恒置），投影栈顶**只把 `P[1][1]` 一个元素**取反（`FUN_14005f600(P, 1)` 取第 1 行、`FUN_14005f500(行, 1)` 取 y 分量，`0x1401806a4`–`0x1401806ea`）。透视投影第 1 列只有 `P11`，这等于 `P' = P · S`，合起来 `g_ViewProjectionMatrix = S · V · P · S`，即 fantasticcar 抓帧的 `S·VP·S`【确】。正交投影若带 y 方向的偏移项 `P31`（off-center），只翻 `P11` 不等于整列取反，反射图不再是屏幕的上下翻转【推：正交场景的 P 是否带 `P31` 见 rea-p5-camera 1 节；没实测】。
6. 剔除：`edx = (R+0x128 >> 11) & 1`（`alignmentfliph`）；bit0 为 0 时取反，为 1 时不取反（`0x1401806ee`–`0x14018070e`）。壁纸进程里反射 pass 的剔除与主 pass 相同。抓帧两个 pass 都是 Back、front_ccw，一致。
7. `FUN_14017e180(ctx+0x1b0, &flag)` 是剔除状态栈（`std::vector<uint8>`）的 `push_back`，随后 `dev+0xb0(flag)` 设剔正面。**更正 rea-p5-mesh：`FUN_14017e180` 不是「设镜像视图」。** 弹栈是 `FUN_14017e760`。
8. 压 `_rt_Reflection`，`FUN_140183550(R, 1)`：模式 1 不压 MSAA RT；`clearenabled`（`G+0xe0` bit5）为真时清颜色和深度（深度清成 `dev+0x20 = 0`，因为借深度，清的是后备缓冲的 DSV）；然后 `FUN_14018aac0(G, 1)` 画 `G+0x1c8` 名单。`clearenabled` 为假时反射图不清，保留上一帧【推：由同一段代码推出】。
9. 弹栈，弹剔除，`P[1][1]` 再取反还原，恢复眼位与两个向量，弹视图栈，`R+0x1da = 1`。

- **没有斜裁剪面**：投影只动 `P11`，近平面不变；`generic` / `generic2` / 两份 `grid` 着色器里也没有 `clip`。镜面以下（y < 0）的几何同样会画进反射图【确】。
- **正交场景**：同一段代码，没有分支。镜像的是世界 y = 0 这条水平线（正交场景的场景底边）【确】；投影只翻 `P11`，带 `P31` 时画面会整体移出（见第 5 步）【推】。语料里读 `_rt_Reflection` 的三张（arsenal、audiophile、fantasticcar）都是透视。
- 视锥剔除平面在 `FUN_14018aac0` 开头由当前 VP 现算（rea-p5-mesh 4.4），所以按镜像后的 VP 剔【推】。

### 1.4 名单与各类对象【确】

- 名单在对象创建时建（`FUN_14018ff60` `0x140190850`–`0x140190926`）：可画类型（`r15b`，rea-p5-mesh 第 5 节：模型、粒子、图像、sprite、文本）且 `reflected` 缺键或为真，且对象标志 bit3 不置位 → 进 `G+0x1c8`。顺序 = 创建顺序。
- 对象标志 bit3 的置位点全仓只有模型的 `0x1402252b9`：网格循环里，该网格材质 `+0x1fc & 1` 就置（`+0x1fc` 由材质创建按纹理槽名查表，`_rt_Reflection` → 1，p2 I2）。**任一网格读反射图，整个模型都不进名单**（arsenal 的 pistols 只有 planks 读也整体排除）。图像层、粒子读 `_rt_Reflection` 不会置 bit3，所以会把自己画进反射，也不会触发反射 pass【确，有界：`or .. +0x120` 的全部写点】。
- 反射 pass 里 `ctx+0x12eb = 2`（普通模式），材质绑定 `FUN_140155fc0` 走普通变体，各类对象用的就是主 pass 的材质和管线【确】。
- 矩阵：`g_ModelMatrix` 不变（抓帧相同）；`g_ViewProjectionMatrix`、`g_ModelViewProjectionMatrix` 等由栈顶 V / P 现算，都带镜像【确】。正交 + 视差的逐对象视图平移（rea-p5-camera 第 6 节）照样叠在 `S·V` 上【推】。
- 名单里的对象若要 `_rt_FullFrameBuffer` 快照，拷的是「当前目标」= `_rt_Reflection`【推：RT 拷贝取栈顶】。

### 1.5 着色器侧【确：着色器原文】

- `generic.frag` / `generic2.frag` 的 `REFLECTION` 与工程 `grid.frag`：`screenUV = (v_ScreenPos.xy / v_ScreenPos.z) · 0.5 + 0.5`，`v_ScreenPos = gl_Position.xyw`，**y 不翻**；采样点再加法线扰动（`generic` `normal.xy·0.01`、`grid` `bump.yz·0.02`）；`generic` 叠加 `·0.35`。
- `g_TexelSizeHalf` 只在 `#ifdef HLSL_SM30` 时加到 UV 上。WPE 用的是 SM4.0 / 5.0 的 blob（工程 `shaders/blobsSM40`），推断不加【推】。它的值是 `0.5 / 屏幕尺寸`（p2 I4，全局，不随 RT 变），只会出现在常量缓冲里（抓帧 `g_bufStatic` 里有）。
- `generic2` 的 `g_Texture2` 注解缺省 `_rt_Reflection`；`generic` 的 `g_Texture3` 没有缺省，要材质给。

### 对实现的含义

- 场景视图参数化时，反射视图 = `{目标 _rt_Reflection, V' = S·V, P' = P·S, 眼位 y 取反, g_ViewRight/Up 的 y 取反, g_ViewForward 不变, 剔除同主 pass}`。WebGPU 的纹理坐标与 D3D 相同（v = 0 在上，裁剪 y 向上），照 WPE 一样把反射图上下颠倒地画、着色器 UV 不翻，就是对的。
- `_rt_Reflection` 用窗口（画布）尺寸、`rgba8unorm`，深度借场景深度附件（同尺寸）；反射 pass 开头按 `clearenabled` 清颜色（场景清屏色，alpha 1）和深度（0），主 pass 再清一次。
- 触发：编译期判断「有模型的某个网格材质纹理槽解析到 `_rt_Reflection`」；名单 = 可画对象 − `reflected: false` − 这些模型。图像层 / 粒子读它时照 WPE 不排除，也不单独触发（这种情况能力表可以照报）。
- 设置：`reflection` 关时不画、每帧清成清屏色。Kabegame 的设置缺省跟随 WPE（缺键视为开）。
- 不要做斜裁剪面。

### 建议实测

- **镜面与正交**：正交场景放一个读 `_rt_Reflection` 的模型地面和一个 y > 0 的方块，抓 `_rt_Reflection`，预测方块关于 y = 0 镜像并上下颠倒存放；把方块挪到 y < 0，预测仍画进反射图（无裁剪）。
- **`g_ViewForward`**：在反射名单里放一个读 `g_ViewForward` / `g_ViewUp` 的自制材质，比两个 pass 的常量，预测 Forward 不变、Up 的 y 取反。
- **`clearenabled: false` + `reflection: true`**：看反射图是否累积上一帧。
- **图像层读 `_rt_Reflection`**：只放一个图像层用 `debugrt_reflection` 材质，预测 `_rt_Reflection` 不被建（绑定解析失败）；再加一个读它的模型，预测图像层把自己也画进反射。
- **`alignmentfliph`**：开水平镜像，预测两个 pass 都剔正面。

---

## 2. 阴影

### 2.1 位置与总流程【确】

`FUN_140190c80(G)` 由帧函数 `0x14018031a` 每帧调用（在脚本之后、反射 pass 之前）。开头 `ctx+0x121c`（`lightconfig` 位字段）为 0 就返回，不算灯也不画阴影。否则：
1. 读 shadows / volumetrics 档（`0x140190cd9`），按 `lightconfig` 各计数切分灯光 uniform 缓冲（`G+0x348`）的各段指针；`FUN_140186990` 给灯排序（lighting-REPORT 的待查项，归 `rea-p13-lights`）。
2. 遍历灯（`G+0x1e0`），跳过不可见的（`FUN_140185010`，含父链）。按类型（`light+0x2c0`：0 点、1 聚、2 管、3 平行）写颜色 / 位置等。**`castshadow`（`light+0x2c4` bit0）且 shadows 档不为 0** 时这盏灯写进「带阴影」的那段槽位，并且对应的阴影计数还有余量时生成阴影条目（点光一条、平行光三条），记下条目要的方块边长 `FUN_14025d3e0`。
3. 把全部条目打包进图集，算每条的 `(x, y)`；必要时建 / 扩 `_rt_shadowAtlas`（`0x140193863`–`0x1401939e8`）。
4. 逐条目算视图投影、写 `g_LFeature_*` uniform，按批调 `FUN_140196530` 画（点光一批 6 视图；平行光 / 聚光的视图攒满 6 个或结束时一批）。
5. 最后把整块灯光数据交给设备（`dev+0x130`，`0x1401963cb`）。

### 2.2 图集 `_rt_shadowAtlas`【确，另注】

- 方块边长 S（`FUN_14025d3e0`）：shadows 档 1 → 256、2 → 256、3 → 512、4 → 1024（其他值 256）。**medium 和 low 一样大**；它们的差别在采样（2.6）。抓帧 low 256、ultra 1024 一致。
- 打包：条目逐个放进一组空闲区间（`FUN_14019e690` / `FUN_14019e830` 维护的 8 字节矩形表），记 `entry+0x4c / +0x50` 为左上角；图集宽 = max(2, 最右边)、高 = max(2, 最下边)。上一帧的布局若与本帧方块边长一致就复用【确：尺寸公式；推：算法细节是 skyline / shelf 一类，没逐行核】。
- 建立：`RT 管理器(ctx+0x16c0).创建(w, h, 缩放 1, "_rt_shadowAtlas", 颜色 0x1b 无, 深度 0x19 R32_TYPELESS, 0x8000008, 0x41)`。已存在但更小时 `FUN_140161f40` 扩大（只扩不缩）【确：扩；推：不缩】。
- 每帧第一批画之前清深度成 `dev+0x20 = 0`（反向 Z 的最远），只清一次（`FUN_140196530` 的 `*first` 标志）【确】。抓帧「帧开头清图集」一致。
- 写进 uniform 的方块变换 `AtlasTransform = (x / W, y / H, S / W, S / H)`（`0x1401960b1`–`0x1401960ee`，`0x140196269`–`0x1401962b0`），同时存进灯对象 `light+0x310`（体积光用）。3287715210 只有一块 → `(0, 0, 1, 1)`，与抓帧 `g_RenderVar0` 一致。

### 2.3 点光（六面，不是双抛物面）【确，另注】

- 投影（`FUN_14025d420` 类型 0 分支 `0x14025d9c1`）：`dev+0x10(P, fovY, 1.0, near, far)` 即 rea-p5-camera 的反向深度 `PerspectiveFovRH`：
  - fovY：shadows 档 1、2 → 94°，3 → 92°，4 及其他 → 91.2°；
  - near：渲染标志 bit10（场景正交，`0x14018768a` `or [ctx+0x118], 0x400`）置位 → 1.0；否则 `max(0.05, lightsourcesize)`；
  - far：`max(radius, near + 0.01)`。
  - 结果存 `light+0x338`；`light+0x320 = (P22, P32, P23, P33)`，即 `g_LFeature_ShadowPointProjection` 的值（`0x14019337e`–`0x14019350f`）。
- 六个视图：平移 `−灯世界位置`（灯世界矩阵第 3 行取反，`0x140193a76`）再乘六个轴向旋转，乘上面的 P。顺序与视口：`+X (x, y)`、`−X (x + S/2, y)`、`+Y (x, y + S/3)`、`−Y (x + S/2, y + S/3)`、`+Z (x, y + 2·S/3)`、`−Z (x + S/2, y + 2·S/3)`，每面 `S/2 × S/3`（`0x140196133`–`0x140196234`，`/3` 用 `0xaaaaaaab` 乘法）【确：视口；推：六个旋转与 `common_pbr_2.h` 的 `CalculateProjectedCoordsPoint` 一一对应——着色器按同一顺序取 `viewportOffset`】。
- 面不是正方形（256 时 128×85），而投影宽高比是 1；着色器用 `viewportScale (0.5, 0.3333)` 和按档的 `viewportPointCompensation`（档 1、2 → 0.47，3 → 0.48，4 → 0.49）把采样收进面内，配合大于 90° 的 fov 留出保护带【确：着色器】。
- 点光视图的 VP 不做 2.5 的 `m32 −0.0005`（那段只在非点光路径）【确，有界：0.0005 常量全函数只有一个读点 `0x14019632a`】。

### 2.4 平行光（三级联）【确，另注】

- 每盏平行光固定 3 个级联（循环 `0x1401912a0`–`0x140192a0e`，`cmp r12d, 3`），每级一个独立条目、各占一块 S×S。
- 级联参数（`FUN_14025d370`），记 `(a_i, b_i)`：
  - c0 = `(cd0, 4·cd1)`；c1 = `(cd1, 4·cd1)`；c2 = `(cd2, max(1.5·cd2, 4·cd1))`；
  - `cascadedistance0/1/2` 存 `light+0x300/0x304/0x308`，缺省 3、10、100（`0x1401904d0`–`0x1401904e4`），所以缺省 `(3, 40)`、`(10, 40)`、`(100, 150)`。
- 每级的中心：`F = g_ViewForward`（`ctx+0x160`），`L` = 灯局部 +X 的世界方向（归一化）；`F' = F − ½·(F·L)·L`；`center = eye + F'·(a_i / 2)`，`FUN_14017e910` 为真时 `center.z = 0`【确：算式；推：`FUN_14017e910` 是「正交场景」】。
- 防抖：纹素 `t = a_i / S`，沿灯的局部 Y、Z 轴把中心按 `fmod(dot(轴, center), t)` 退回网格（`FUN_14041d0c0`）【确：调用；推：fmod 方向】。
- 投影：`dev+0x18` 正交 off-center，x、y ∈ `[−a_i/2, a_i/2]`，z ∈ `[−b_i/2, b_i/2]`，深度 `z_view / b_i + 0.5`（`FUN_14009a630`：`m22 = −1 / (zn − zf)`，`m32 = −zf / (zn − zf)`，常量 `0x1404929b8 = −1`）。与场景正交的反向写法相同（z 朝灯为正 → 深度大）【确：投影；推：视图矩阵 `FUN_14005f650` 的朝向，没逐行核】。
- 写 uniform：`g_LFeature_ShadowProjection[k]` = 这一级的 VP（渲染标志 bit0 时转置上传，`0x14019289d`），`g_LFeature_ShadowProjectionTransform[k]` = 方块变换。**uniform 里是不带偏移的 VP**；画阴影时拷进 `ctx+0xb30` 的那份再 `m32 −= 0.0005`（`0x14019632a`）【确】。

### 2.5 聚光【未知】

语料 0 张。`FUN_14025d420` 类型 1 分支（`0x14025d451` 起）算聚光投影，没读。条目走与平行光同一条「攒 6 个一批」的路径，每盏一块【推】。

### 2.6 阴影 pass `FUN_140196530(G, 视口表, 数量, &first)`【确】

1. `dev+0xa0(1)`：光栅加深度偏移位（`dev+0x25` bit2）。
2. 压图集；`*first` 时只清深度（成 0），清 `*first`。
3. 图集记下视口表与数量，`RSSetViewports` 多视口（RT `+0x28`）。
4. `ctx+0x12eb = 0`（阴影模式），`ctx+0x1c8 = 数量`，`dev+0x150(数量)`（实例数）。
5. 每个视图 `FUN_1401849e0(ctx+0xb30 + i·0x40, ctx+0xf20 + i·0x60)` 算视锥平面。
6. `FUN_14018aac0(G, 2)`：全部对象里 `(obj+0x120 & 0xc00) == 0xc00` 的画一次（模型对每个可见视图发一个实例，rea-p5-mesh 4.4）。
7. 数量清 0，`ctx+0x12eb = 2`，弹栈，`dev+0xa0(0)`，图集视口复位。

光栅状态（`FUN_140099050`，D3D11_RASTERIZER_DESC）：序号 = `dev+0x25`（bit0 剔正面、bit1 不剔、bit2 偏移）。

| 序号 | CullMode | DepthBias | SlopeScaledDepthBias | 说明 |
|---|---|---|---|---|
| 4 | **NONE** | 0 | −4 | 阴影 pass、材质缺省剔除：建状态时 CullMode 还停在上一项的 NONE，没改回 BACK【确】 |
| 5 | FRONT | 0 | −4 | 帧级剔正面（`alignmentfliph`） |
| 6、7 | NONE | 0 | −4 | 材质 `nocull` |

DepthBiasClamp 0、DepthClipEnable 1、FrontCounterClockwise 1【确】。深度测试照材质（GREATER，写深度）。

### 2.7 投射者与着色器【确，另注】

- `castshadow` 是基类属性表（`FUN_1401ee520` `0x1401eea7e`，setter `0x1401ef120`）的位 `obj+0x120` bit11，所有对象类型都能写；模型构造时缺省置位（rea-p5-mesh）。
- 不透明位 bit10（0x400）只有模型置（任一网格 blending 为 normal / alphatocoverage，`0x140225252`）；灯、粒子构造时置的是 0x100（半透明）。**所以实际只有模型投射**【确，有界：`or .. +0x120` 的写点】。
- 材质绑定 `FUN_140155fc0`：`ctx+0x12eb ≠ 2` 时按模式缓存变体（`material+0x300` 表，每模式 0x38 字节）。阴影模式的着色器名在 `ctx+0x15a8` 表里按材质着色器查，查不到用 `"shadowcaster"`（`0x1401562a2`）。表的来源是片元着色器首行注解：`chroma4` → `shadowcaster`、`foliage4` → `shadowcasterfoliage4`、`fur4` → `shadowcasterfur4`【确：注解与缺省名；推：表就是注解】。
- `shadowcaster.vert`：`gl_Position = (局部位置 · g_ModelMatrix) · g_ViewportViewProjectionMatrices[gl_InstanceID]`，`gl_ViewportIndex = gl_InstanceID`；COMBO `SKINNING` / `MORPHING` / `MORPHING_NORMALS` / `BONECOUNT`，`ALPHATOCOVERAGE` 时片元按 albedo alpha 丢弃。`g_ViewportViewProjectionMatrices` = `ctx+0xb30` 起 6 个矩阵【确：着色器；推：变体继承基础材质的骨骼 COMBO】。
- 宏 `SHADOW`（`FUN_140198124`）是体积光材质的 COMBO，不是投射者的（第 3 节）。

### 2.8 uniform 与宏【确】

宏（`FUN_1401a5c40`）：`LIGHTS_SPOT_SHADOW` = bit16–17、`LIGHTS_SPOT_COOKIE` = bit18–19、`LIGHTS_SPOT_SHADOW_COOKIE` = bit20–21、`LIGHTS_DIRECTIONAL_SHADOW` = bit22–23、`LIGHTS_POINT_SHADOW` = bit24–25（各 2 位，最多 3）；四个阴影计数之和非 0 时定义 `LIGHTS_SHADOW_MAPPING = 1` 与 `LIGHTS_SHADOW_MAPPING_QUALITY = shadows 档`；`spotcookie + spotshadowcookie` 非 0 时 `LIGHTS_COOKIE = 1`。

`lightconfig` 解析（`0x140187b52`–`0x140187d00`）：`point` / `spot` / `tube` / `directional` 各 4 位（bit0、4、8、12），**是这类灯的总数，含带阴影的**；`*shadow` 是其中带阴影的个数（`0x140190fa0` 用 `directional − directionalshadow` 算普通槽数）。

cbuffer 声明（`FUN_1400f5cb0` `0x1400f7b87`）：
- `N = 3·LIGHTS_DIRECTIONAL_SHADOW + LIGHTS_SPOT_COOKIE + LIGHTS_SPOT_SHADOW + LIGHTS_SPOT_SHADOW_COOKIE`，非 0 时 `float4x4 g_LFeature_ShadowProjection[N]`、`float4 g_LFeature_ShadowProjectionTransform[N]`；
- `M = LIGHTS_POINT_SHADOW`，非 0 时 `float4 g_LFeature_ShadowPointProjection[M]`、`float4 g_LFeature_ShadowPointProjectionTransform[M]`。

| uniform | 内容 |
|---|---|
| `g_LFeature_ShadowPointProjection[i]` | `(n/(f−n), n·f/(f−n), −1, 0)`，着色器按 `[0,0,x,z; 0,0,y,w]` 拼投影 |
| `g_LFeature_ShadowPointProjectionTransform[i]` | 方块变换 `(x/W, y/H, S/W, S/H)` |
| `g_LFeature_ShadowProjection[k]` | 平行光每级（每盏 3 个）/ 聚光的 VP，不带 0.0005 偏移 |
| `g_LFeature_ShadowProjectionTransform[k]` | 对应方块变换 |
| `g_Texture6Texel`（`SHADOW_ATLAS_TEXEL`） | 图集的纹素（p2 I3 的 Texel 规则） |

各段在缓冲里的先后（哪种灯在前）由 `0x140190ff8` 一带的指针算术决定，没逐项核【推：照生成器 `FUN_140169140` 的声明顺序】。

灯字段（`FUN_14025da80` 注册，缺省 `0x140190474`）：`density` `+0x2f8`（2.0）、`volumetricsexponent` `+0x2fc`（1.0）、`cascadedistance0/1/2` `+0x300/304/308`（3、10、100）、`lightsourcesize` `+0x30c`（0）；`castshadow` / `usecookie` / `castvolumetrics` 是 `+0x2c4` 的 bit0 / bit1 / bit2【确：偏移与缺省；推：bit1 = usecookie，按体积光里 bit1 取 cookie 纹理 `light+0x330`】。
- `lightsourcesize` 读到的唯一用处是透视场景点光阴影的近平面（2.3）；没有软阴影【确，有界：`+0x30c` 的读点】。软化只有 `LIGHTS_SHADOW_MAPPING_QUALITY ≥ 2` 时着色器的 9 次比较采样。

### 2.9 比较采样器【确】

采样器缓存（`0x1400999f0` 起）的键 bit27 = 比较采样。比较 + 线性（键 bit0 为 0）：Filter `0x95` = `COMPARISON_MIN_MAG_MIP_LINEAR`，AddressU/V/W = 4（BORDER），BorderColor `(0,0,0,0)`，ComparisonFunc 5（GREATER），MinLOD 0、MaxLOD FLT_MAX、MaxAnisotropy 1。与 ultra 抓帧一致。D3D 的比较是「参考值 GREATER 纹素」，反向 Z 下「比遮挡者更近 = 更大」才受光；越界取边框 0，参考值 > 0 → 受光。

### 2.10 `shadows: disabled`【确】

- 解析期（`0x140187c39`）：档为 0 时只读 `spotshadowcookie`，把它**按位或**进 `spotcookie` 的 bit18–19；`spotshadow` / `directionalshadow` / `pointshadow` 不读，位为 0。
- 宏：四个 `LIGHTS_*_SHADOW` = 0，`LIGHTS_SHADOW_MAPPING` / `_QUALITY` 不定义；`genericimage4` 的 `g_Texture6`（`sampler2DComparison`，缺省 `_rt_shadowAtlas`）在 `#if LIGHTS_SHADOW_MAPPING` 里，整个不声明，`common_pbr_2.h` 的 `SHADOW_ATLAS_SAMPLER` 分支也不编译。
- 灯光函数里 `castshadow` 的灯因档为 0 走普通槽，不生成条目；不建图集，不调 `FUN_140196530`。与抓帧「没有图集清屏」一致。

### 对实现的含义

- 阴影 pass 每帧画，在反射与主 pass 之前；没有灯光配置就整段不做。
- 图集：`depth32float`，方块边长按档（256 / 256 / 512 / 1024），点光一块（块内 2×3 面）、平行光三块；尺寸 = 打包外接尺寸。单灯场景直接 S×S。
- WebGPU 没有视口数组：每个视图单独一次绘制（设视口、写该视图的 VP），等价于 WPE 的实例化。剔除照 WPE：材质缺省剔除时用 `"none"`（序号 4 的怪行为要照抄），帧级剔正面时 `"front"`；`depthBiasSlopeScale = −4`、`depthBias = 0`；非点光视图的 VP `m32 −= 0.0005`。
- 比较采样器：`compare: "greater"`、线性；WebGPU 没有 BORDER，需要在采样前判断越界当作受光（或给图集留 0 边）。
- 投射者只有不透明的模型。阴影变体要支持 `SKINNING` / `MORPHING`，`foliage4` / `fur4` 换专用投射着色器。
- 宏与 uniform 照 2.8；`disabled` 照 2.10。

### 建议实测

- `capture_sweep` 扫 5 档（已有 low / ultra）：核对 medium = 256、high = 512，点光 fov（用 RenderDoc 读 6 个 `g_ViewportViewProjectionMatrices` 的 P 部分）94 / 94 / 92 / 91.2°。
- **透视场景点光**：`lightsourcesize` 缺省与 2.0 各一组，读 `g_LFeature_ShadowPointProjection` 反推 near = 0.05 / 2.0。
- **平行光**：一盏 `ldirectional` + `directionalshadow: 1`，相机平移一点点，读三级 `g_LFeature_ShadowProjection`，核对 `(a, b)` = `(3, 40)`、`(10, 40)`、`(100, 150)` 与防抖（中心只按纹素跳）；改三个 `cascadedistance` 再核。看图集里三块的排布。
- **剔除**：投射者用单面网格，从背面打光，预测仍投影（CullMode NONE）。读阴影 pass 的光栅状态。
- **投射者**：给图像层写 `castshadow: true`，预测不进阴影 pass。
- **两盏投影灯**：读图集尺寸与两块的位置，确认打包规则。

---

## 3. 体积光（`castvolumetrics`）

### 3.1 何时画【确】

- 灯对象的绘制虚函数（虚表 `0x140491c38` `+0x50` = `0x14025d300`）：`light+0x2c4` bit2（`castvolumetrics`）置位时调体积光渲染器（`ctx+0x1510`）的 `+0x28` = `FUN_140196ce0(体积光对象 = G+0x50, light)`。灯的「可画」判断 `+0x68`（`0x14025d330`）要求可见（含父链）且 bit2。
- `FUN_140196ce0` 开头：体积光对象 `+0x418`（即 `G+0x468`）bit0 为 0 或 volumetrics 档为 0 → 直接返回（`0x140196cf5`、`0x140196d1e`）。所以 `volumetrics: disabled` 时什么都不建、不画【确】，与抓帧一致。`G+0x468` bit0 由谁置没追【未知：推测是场景里有 castvolumetrics 的灯】。
- 灯只在主 pass 的名单里（`G+0x158`）。反射名单只收可画类型，阴影 pass 要不透明位，都不含灯，所以体积光只在主 pass 画【确】。
- **与 `lightconfig` 的关系**：体积光的参数直接取灯对象字段（3.4），不读灯光 uniform 缓冲，所以 `lightconfig` 里没有这盏灯也会画【推】。但阴影图集方块与点光投影（`light+0x310` / `+0x320`）只在灯光函数给它生成阴影条目时才写；`SHADOW` COMBO 却只看 `castshadow` 与 shadows 档（3.3），两边不一致时会拿未写的值采样【推，建议实测】。

### 3.2 一盏灯的绘制（`FUN_140196ce0`）【确，另注】

首次建 RT（体积光对象 `+0x3d8..`，在 `G` 里是 `+0x428..`）：

| RT | 尺寸 | 颜色 | 深度 |
|---|---|---|---|
| `_rt_volumetricsBack` | 后备缓冲尺寸（`ctx+0x7c/0x80`），缩放 1；开 MSAA 时多重采样 | 无 | `0x19` R32_TYPELESS |
| `_rt_volumetricsSingle` | 后备缓冲 / d | 无 | 档 ≥ 3 → `0x19`，否则 `0x17`（都是 R32_TYPELESS） |
| `_rt_volumetricsLightBuffer` | 后备缓冲 / d | HDR ? RGBA16F : RGBA8 | 无 |
| `_rt_volumetricsLightBufferB`（只档 < 3） | 后备缓冲 / d | 同上 | 无 |

`d` = volumetrics 档 ≥ 3（high、ultra）? 4 : 8（`0x140196d79`）。所以 low、medium 1/8，high、ultra 1/4。1920×1080 → 240×135 / 480×270，与抓帧一致。材质：`volumetrics_combine`（总是），`volumetrics_blur_h` / `_v`（档 < 3）。

每次绘制：
1. `_rt_volumetricsBack.拷贝()`：没有颜色纹理 → `CopyResource` 深度，源是当前目标的深度（场景深度，开 MSAA 时是多重采样深度）（`0x140196f9c`）。抓帧「CopyResource（场景深度）」。
2. `dev+0xc0`：剔除方向取反（画灯体的背面）。
3. 压 `_rt_volumetricsSingle`，只清深度（成 0）。
4. 灯体网格（`light+0x378`，首次由 `FUN_14025c660` 等建；点光是球，抓帧 3312 个索引）用 `volumetrics_back`（只写深度、`cullmode normal`）画进去：得到灯体背面的深度（光线步进的终点上限）。`g_AltViewProjectionMatrix`（`ctx+0xab0`）= 点光：`缩放(radius·k)` + 平移到灯的世界位置【确：组装；未知：k】。
5. 弹回，剔除还原；压 `_rt_volumetricsLightBuffer`。若体积光对象标志 bit1（「需要清」）：清 bit1、置 bit2（「待合成」），`dev+0x118` 设清屏色 `(0,0,0,1)`，清颜色（`0x140197910`–`0x140197967`）。**这一步把设备的清屏色改成了 `(0,0,0,1)`**，之后本帧的清屏都用它【确，影响见第 5 节】。
6. 选 `volumetricsfront` 材质变体（`FUN_140198124` 建，COMBO 见 3.3），写 uniform（3.4），画灯体正面（`additive`、不测不写深度）。相机在灯体内时改用 `volumetrics_fullscreen`（`FULLSCREEN = 1`、`nocull`）【推：`FUN_140185940` 的判断没细读】。

### 3.3 材质 COMBO（`FUN_140198124`）【确】

- `SHADOW = 1`：`castshadow`（`+0x2c4` bit0）且 shadows 档 ≠ 0；
- `QUALITY` = volumetrics 档（着色器：有阴影 / cookie 时步数 12 / 24 / 32 / 64，没有时 2 / 3 / 5 / 8）；
- `POINTLIGHT = 1`：类型 0；
- `LIGHTS_SHADOW_MAPPING_QUALITY` = shadows 档（给 `CalculateProjectedCoordsPoint` 的补偿系数用）；
- `usecookie`（bit1）时 cookie 纹理 `light+0x330` 绑到材质 `+0xe0`【推】。

### 3.4 uniform（`0x1401985d0`–`0x1401987f5`）【确】

| uniform | 值 | 3287715210 抓帧 |
|---|---|---|
| `g_RenderVar0` | `light+0x310`：阴影方块变换 | `(0, 0, 1, 1)` |
| `g_RenderVar1` | `(radius·0.99, cos(innercone°), cos(outercone°), intensity)` | `(693.22, 0.9397, 0.8660, 4.58)`（缺省内外锥 20°、30°） |
| `g_RenderVar2` | `(灯世界位置, density)` | `(2022.15, 1620.28, 250, 0.65)`（场景 `density: 0.65`） |
| `g_RenderVar3` | 点光：`light+0x320`（点光阴影投影，2.3）；聚光：聚光前向【推】 | `(0.00143, 1.00143, −1, 0)` |
| `g_RenderVar4` | `(color.rgb（不乘强度）, volumetricsexponent)` | `(1, 1, 1, 1.7)` |
| `g_AltModelMatrix` | `light+0x338`（聚光的阴影 VP；点光不用） | — |
| `g_EffectModelMatrix` | 屏幕 → 世界的逆矩阵（着色器拿它把 `(uv, depth)` 变回世界）【推】 | — |

`693.22` = 半径 700.22 × 0.99（常量 `0x1404926f8`）；`0.65` = 灯的 `density`。着色器最后 `rgb = density · maxLightScale · shadowFactor · color · 0.1`，`a = 1`。

### 3.5 合成（`FUN_140198d00`，rea-p5-mesh 记的「作用未知」）【确】

`FUN_14018aac0` 画每个对象前（`0x14018ade4`）：`G+0x468` bit0 且该对象类型（虚函数 `+0x60`）不是 6（灯）且 bit2（待合成）→ 先合成；列表画完时 bit2 仍在也合成（`0x14018b21e`）。所以**连续的几盏灯共用一次清屏与一次合成，合成落在它们后面第一个非灯对象之前**。

合成：置 bit1、清 bit2；档 < 3 时 `blur_h`（LightBuffer → LightBufferB）、`blur_v`（LightBufferB → LightBuffer），两次全屏；然后 `volumetrics_combine`（`passthrough`、`additive`、不测不写深度）把 LightBuffer 画进当前目标（主目标）。所以 low / medium 3 次全屏、high / ultra 1 次，与抓帧一致。

### 对实现的含义

- 体积光是主 pass 里的一个插入点：灯在 `objects` 中的位置决定合成时机；同一段连续的灯共用缓冲。
- 每盏灯：拷场景深度 → 画灯体背面深度到 1/d 的深度图 → 画正面做光线步进（读场景深度、背面深度、阴影图集）加进光缓冲；合成前低档模糊两次。
- `volumetrics_*` 与 `blur_k3`、`passthrough` 都是 WPE 自带材质，直接翻译。
- 注意 3.2 第 5 步把清屏色改成 `(0,0,0,1)` 的副作用（第 5 节）。

### 建议实测

- 扫 medium / high，核对 1/8、1/4 与模糊次数。
- 读 LightBuffer 的 alpha 与合成的混合状态（`additive` 的 alpha 通道），确认合成是否乘到 alpha。
- 一盏 `castvolumetrics` 的灯但 `lightconfig` 为空：预测仍画体积光（无阴影）。再加 `castshadow` 但不写 `pointshadow`：看 `g_RenderVar0` / `g_RenderVar3` 是什么。
- 两盏灯在 `objects` 里相邻 / 中间隔一个图像层：数合成次数。
- 相机进灯体：看是否换成 `FULLSCREEN` 变体。

---

## 4. `_rt_MipMappedFrameBuffer`

### 4.1 何时建【确】

- 场景标志 `G+0xe0` bit11 ← 有对象的标志 bit6（1.1 的 `FUN_14018b230`）。bit6 的置位点：模型 = 全部网格材质 `+0x1fc` 或起来含 bit3（`0x1402253bb`）；图像层 = 基础材质 `+0x1fc` bit3（`0x1402096f4`）。材质 `+0x1fc` bit3 = 某个纹理槽解析到 `_rt_MipMappedFrameBuffer`（p2 I2）。
- 建立（`FUN_140181af0` `0x140181c98`）：后备缓冲尺寸、缩放 1，颜色 HDR ? RGBA16F : RGBA8，深度 `0x1b` 无，flags `0x10`（带 mip）。
- 建好时若 `reflection` 设置关（渲染标志 bit7 为 0）：压栈，清屏色 `(0,0,0,1)`，清颜色，弹栈，`GenerateMips`（`0x140181cfd`–`0x140181daf`）。运行中把 `reflection` 关掉时 `FUN_140115a90` 做同样的事（`0x140115ab1`–`0x140115b56`）。

### 4.2 每帧更新【确】

帧函数主 pass 之后（泛光路径 `0x140180a8c`–`0x140180aad`，非泛光路径 `0x140180b73`–`0x140180b94`）：`R+0x30f8` 存在且 `reflection` 开 → RT `+0x8`（拷贝）再 `+0x20`（`GenerateMips`）。
- 拷贝：目标有颜色纹理 → `ResolveSubresource(本 RT 颜色, 0, 源颜色, 0, 本 RT 格式)`；源 = RT 栈顶，空栈时取缺省目标（后备缓冲）。主 pass 结束时 MSAA RT 已解析进后备缓冲并弹栈，所以源是后备缓冲【确】。源不是多重采样时 D3D 的 `ResolveSubresource` 实际怎么拷【未知，建议实测】。
- **时机**：主 pass 全部对象画完之后、泛光链（`FUN_140183610`）和 HDR 合成之前，每帧一次。主 pass 里读它的对象拿到的是**上一帧**的场景（未加泛光）【确：顺序；推：内容】。
- **`reflection` 关时整帧不写**，所以 3453730450 抓帧里读到的是加载时清的 `(0,0,0,1)`。

### 4.3 mip 与 `g_Texture3MipMapInfo`【确，另注】

- mip 数（RT 构造 `FUN_1400d2c60` `0x1400d2dd6`）：`npot(x)` 为不小于 x 的 2 的幂；`m = min(log2(npot(w)/2), log2(npot(h)/2))`；mip 数 = `max(1, m − 2)`。1920×1080：`npot` = 2048 → 1024 → 10，`10 − 2 = 8`，与抓帧 8 级一致。
- 生成：D3D11 `GenerateMips`（上下文虚表 `+0x1b0`），滤波由驱动定（通常 2×2 盒式）【确：调用；推：滤波】。
- `g_TextureNMipMapInfo` 取纹理对象 `+0xd0`（p2 I3），RT 上即 mip 数【推】；抓帧为 8。`genericimage4` 用 `texSample2DLod(g_Texture3, screenUV, roughness · g_Texture3MipMapInfo)`。

### 对实现的含义

- 编译期：任何对象的纹理槽解析到 `_rt_MipMappedFrameBuffer` 就建这张 RT（画布尺寸、HDR 跟场景目标）。
- 设置开：主 pass 之后、泛光之前拷 0 级，写一个逐级 2×2 平均的缩小 pass 生成 mip；读它的对象用上一帧的结果（第一帧是清屏内容）。设置关：清成 `(0,0,0,1)`、不再更新。
- mip 数照 4.3 公式，不是完整链；`g_Texture3MipMapInfo` = mip 数。

### 建议实测

- `reflection: true` 抓 3453730450：核对拷贝发生在主 pass 之后、泛光之前，读到的是上一帧；看拷贝在 RenderDoc 里是 Resolve 还是 Copy，mip 链的滤波（与 2×2 盒式比）。
- 不同窗口尺寸（如 1280×720、2560×1440）读 mip 数，核对公式。

---

## 5. 一帧的顺序

帧函数 `FUN_14017fa70`（在 rea-p5-camera 的表上补全）：

| 顺序 | 动作 | 地址 |
|---|---|---|
| 1 | 选清屏色、`g_Time` | `0x14017fc4c` 起 |
| 2 | 相机、投影、视图向量 | `0x14017fd26`、`0x14017fd2e`、`0x1401800a7`–`0x1401802c7` |
| 3 | 光标事件 | `0x1401802d5` |
| 4 | 脚本 `FUN_140171440` | `0x1401802e5` |
| 5 | `FUN_14018b390`（没追）；`G+0xe0` bit31 时 `FUN_140184020` | `0x1401802ed`、`0x140180305` |
| 6 | **灯光 uniform + 阴影 pass**（`FUN_140190c80` → `FUN_140196530`，内部 `0x14019623e` / `0x140196262` / `0x14019639d`）；`lightconfig` 为空时直接返回 | `0x14018031a` |
| 7 | 设清屏色（场景 `clearcolor`，alpha 1） | `0x140180351` |
| 8 | **反射 pass**（`G+0xe0` bit0 且设置开）`FUN_140183550(R, 1)`；设置关时清 `_rt_Reflection` | `0x140180762` / `0x1401808c8` |
| 9 | 剔除 = `alignmentfliph` | `0x140180a3b` |
| 10 | **主 pass** `FUN_140183550(R, 0)`：压 MSAA RT → `clearenabled` 时清颜色与深度 → 按对象顺序画（中间：需要时 `_rt_FullFrameBuffer` 快照；灯处画体积光，下一个非灯对象前合成 `FUN_140198d00`）→ 弹 MSAA 并解析进后备缓冲 | 泛光路径 `0x140180a7a`，否则 `0x140180b6e` |
| 11 | 泛光路径：主 pass 结果拷进 `_rt_FullFrameBuffer`（`R+0x3098` 的 `+0x8`） | `0x140180a89` |
| 12 | **`_rt_MipMappedFrameBuffer`** 拷贝 + `GenerateMips`（设置开） | `0x140180aa0` / `0x140180b87` |
| 13 | 泛光链 `FUN_140183610`、HDR / 泛光合成（`R+0x3150`）；非泛光的 HDR 路径先拷 `_rt_FullFrameBuffer` 再合成（`R+0x3158`） | `0x140180ac5`、`0x140180b4c` / `0x140180ba6` |
| 14 | `R+0x3188`、`R+0x3180` 等收尾材质（没追） | `0x140180bd2` 起 |

补充：
- 阴影 pass 在反射 pass 之前，所以反射名单里的模型也能接收本帧阴影【推】。
- 第 6 步里体积光不画；体积光只在第 10 步。
- 3.2 第 5 步把设备清屏色改成 `(0,0,0,1)`，而第 7 步每帧开头重设，所以只影响同一帧后面的清屏（例如组合层合成 RT 若在体积光之后清屏）【推】。

### 对实现的含义

- 场景视图的执行顺序：阴影（每盏灯的每个视图）→ 反射 → 主 pass；体积光与 mip 帧缓冲都是主 pass 内 / 后的加工，挂在已有的 `_rt_FullFrameBuffer` 快照与泛光之间。

---

## 未查清

- `G+0xe0` bit17（对象标志 bit12）的作用；`G+0x468` bit0（体积光开）的置位点；`FUN_14018b390` 的作用。
- 聚光阴影与 cookie 的投影、方块分配（语料 0 张）。
- 平行光级联视图矩阵 `FUN_14005f650` 的朝向与 up 向量；防抖 `fmod` 的符号；`FUN_14017e910` 是否就是「正交场景」。
- 阴影 uniform 缓冲里各类阴影段的先后。
- 图集打包算法（多盏灯时的排布）。
- `_rt_MipMappedFrameBuffer` 用非多重采样源调 `ResolveSubresource` 的实际行为。
- 体积光：灯体网格（`FUN_14025c660`）的细分与缩放系数 k；`volumetrics_fullscreen` 的切换条件；LightBuffer 的 alpha 与合成的 alpha 混合；`SHADOW` 开但没分到方块时的取值。
- 反射 pass 里 `R+0x1da` 的用途、`FUN_140184630` 对镜像矩阵做了什么（对 `diag(1,−1,1,1)` 无影响）。

## 对前几份读码的更正

1. **rea-p5-mesh 第 5 节**：`FUN_14017e180` 是剔除状态栈的 `push_back`，镜像视图由 `FUN_1401844f0` + `FUN_1401842d0` 做；反射 pass 的触发是 `G+0xe0` bit0，不是 `0x20000`。
2. **rea-p5-mesh「未查清」最后一条**：渲染标志 bit0 在壁纸进程里恒置（p2 G2 已写，`0x140110a19`），所以 `_rt_FullFrameBuffer` / `_rt_Reflection` 的深度是借后备缓冲的 D32F（`0x1a`），不是 D16；反射 pass 的剔除不取反、改为投影翻 y。
3. **rea-p5-mesh 4.1**：`FUN_140198d00` 是体积光的模糊与合成。
4. **渲染标志 bit10（0x400）= 场景正交**（`0x14018768a`），目前只见于点光阴影近平面等 9 个读点。
5. **rea-p5-mesh 3.4 光栅序号 4**：确认 CullMode 是 NONE（建状态时没改回 BACK），阴影 pass 在缺省剔除的材质上实际不剔除。

---

**元数据**

- 目标：`d:\Codes\kabegame\ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工时与安装目录原件 `sha256sum` 核对一致。没运行、没附加 WPE，没改 Steam 目录。
- REA：把 `ignore/p11/rea/media/wallpaper64-2.8.42-p11-media.rea-snapshot` 拷成 `ignore/p13/rea/passes/wp-passes-work.rea-snapshot`。REA 里已有另一会话打开的同一目标，两次 `procedure_pseudo_code` 都在 330 s 导入期限内超时（每次重新导入），这一轮**没有用 REA 反编译**，也没有新增标注；结束时把工作副本另存为 `ignore/p13/rea/passes/wallpaper64-2.8.42-p13-passes.rea-snapshot`（内容与 p11 快照相同）。
- 方法：全量反汇编 `ignore/p4/rea/wp.asm` 按地址切片读；常量与字符串用脚本直接读 exe 副本。
- 工作文件 `ignore/p13/rea/passes/`：
  - 脚本：从 `ignore/p11/rea/media/` 拷来的 `slice.py`、`fn.py`、`xr.py`、`rd.py`、`strs.py`、`pe.py` 等；新写的 `vtq.py`（读虚表槽）、`rng.py`（区间字符串）、`flaguse.py`（标志位读点）、`jt4.py`（格式表跳转）、`scanlights.py`、`sess.py`，模式文件 `pat_set.txt`、`p_sh.txt` 等。
  - 汇编摘录 `asm/`：`frame_14017fa70.asm`（帧函数）、`sceneload_140181af0.asm`（RT 建立）、`rt_1400d2c60.asm`（RT 构造与 mip 数）、`rtmgr_1401aadb0.asm`、`rinit_14017c6d0.asm`、`lights_140190c80.asm`（灯光与阴影，4200 行）、`shadowdriver.asm`、`vol_1401966d0.asm`、`vol2_140197600.asm`（体积光）、`lightfields_14025da80.asm`（灯字段注册）。
- 读的着色器与文件（只读）：`assets/shaders/` 的 `common_pbr_2.h`、`shadowcaster.vert/.frag`、`volumetricsback/front.vert/.frag`、`generic.frag/.vert`、`generic2.frag/.vert`、`genericimage4.frag`，以及 `chroma4` / `foliage4` / `fur4.frag` 的首行注解；`assets/materials/util/` 的 `volumetrics_*.json`、`shadowcaster.json`、`debugrt_reflection.json`；工程 `fantasticcar/shaders/grid.frag`；3287715210 的 `scene.pkg`（只 grep 了 `density` 等键）；`ignore/p13/out/scan.json`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明范围里搜过，范围外没排除；【确：着色器】读 WPE 自带着色器原文得到。
