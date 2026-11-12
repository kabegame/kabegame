# WPE 场景渲染器静态逆向报告（P2：效果链 / 混合模式 / HDR 泛光）

## 0. 分析对象与方法

| 项 | 值 |
|---|---|
| 文件 | `wallpaper64.exe`（从 `D:\Applications\Steam\steamapps\common\wallpaper_engine\` **复制**到 `scratchpad\p2-rea\bin\` 后只分析副本） |
| 版本 | `version.json` → `2.8.42`；PE 时间戳 `1782743820`（2026-06-29 14:37:00 UTC） |
| SHA-256 | `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0` |
| 体积 / 架构 | 5,360,112 B，x86-64，ImageBase `0x140000000` |
| PDB 引用 | `wallpaper64.pdb` GUID `36c37cc2-cff6-44f9-9c53-376b9c8d7736`（未提供 PDB，函数名均为 Ghidra 自动名） |
| 加壳 | 无。8 个标准 MSVC 节，`.text` 熵 6.54，正常；无反调试/加密迹象 |
| 渲染器所在 | 全部在 `wallpaper64.exe` 内（D3D11 后端也静态编译在内）。`resourceutil64.dll` 字符串检查无渲染相关；`scenescript64.dll` 未打开 |

**方法**：REA + Ghidra 12.1.4 headless（ephemeral 导入，原文件只读）；`search_strings` / `xrefs` / `batch_decompile` / `procedure_assembly`；辅以 scratchpad 内自写的只读 Python 脚本（节表/熵、字符串区段、浮点常量、虚表转储、立即数与位测试指令的字节级搜索）。WPE `assets/` 与两个样本工程的 JSON / 着色器只读读取作对照。**未运行任何 WPE 程序，未做任何动态分析，未写入 Steam 目录，未改动 Kabegame 仓库。**
REA 快照：`scratchpad\p2-rea\db\wallpaper64-2.8.42.rea-snapshot`（42 条 Evidence）。反编译文本落在 `scratchpad\p2-rea\decomp\FUN_*.c`。

**置信度用语**：已确认＝有直接代码/字节证据；推断＝间接证据或调用约定推理；未知＝未找到。

### 0.1 本报告用到的关键结构（地址均为 VA）

- **场景渲染器**（下称 `R`，`FUN_14017fa70` 的 `this`）：`R+0x128` 为渲染标志字（场景对象里的 `ctx = R+0x10`，故对象代码里看到的是 `ctx+0x118`，同一个字）。已识别位：`0x1` 主 RT 不带深度；`0x40` 允许泛光（推断为用户/画质开关）；`0x800` 投影 Y 翻转；**`0x2000` = HDR 渲染**；`0x4000` = 显示器 HDR（DisplayHDR）；`0x10000` = 视频 HDR；`0x1800000` 强制所有图层走 passthrough。
- **场景 general**（`*R`，构造函数 `FUN_140186c90`）：属性表 `FUN_140199780`。标志字 `+0xe0`：`bloom`=bit1(`0x2`)，`clearenabled`=bit5(`0x20`)，`hdr`=bit10(`0x400`)。
- **图层对象**（具体图像类虚表 `0x1404911a8`，基类 `0x140490488`）：属性表 `FUN_1401ee520`；渲染入口 `FUN_140206430` → 共享渲染 `FUN_1401e8aa0`。

---

## A. 泛光 / HDR

### A1. 何时走泛光、走哪条链；每一步的 pass / RT / 尺寸 / 格式 / 过滤

**结论**
- 泛光开启条件（每帧）：`R.flags & 0x40`（允许泛光）**且** `general.bloom`（`*R+0xe0` bit1）**且** 场景对象列表非空。否则不做泛光。
- 走哪条链只看 `R.flags & 0x2000`（HDR）：
  - **LDR 链（3 pass，固定 1/4、1/8）**：
    1. `downsample_quarter_bloom`：`_rt_FullFrameBuffer` → `_rt_4FrameBuffer`（1/4）
    2. `downsample_eighth_blur_v`：`_rt_4FrameBuffer` → `_rt_8FrameBuffer`（1/8，13 tap 高斯，方向见着色器：实际沿 **x** 采样）
    3. `blur_h_bloom`：`_rt_8FrameBuffer` → `_rt_Bloom`（1/8，13 tap，沿 **y**）
    4. 合成 `combine_ldr`（`combine` 着色器）：`_rt_FullFrameBuffer + _rt_Bloom`
  - **HDR 链（mip 金字塔 + 加法上采样）**，N = 迭代级数（见 A2）：
    1. 阈值下采样 `hdr_downsample_bloom`（`hdr_downsample` + `BLOOM=1`）：`_rt_FullFrameBuffer` → L0（`_rt_2FrameBuffer`，1/2）
    2. 对 i = 1…N−1：`hdr_downsample` ：L(i−1) → L(i)（`_rt_<2^(i+1)>FrameBuffer`，1/2^(i+1)）
    3. 对 u = N−1 递减到 1：上采样 L(u) → L(u−1)，**加法混合**（材质 `"blending":"additive"`）；`u ≥ N−2`（最粗的两级）用 `hdr_upsample_cubic`（`UPSAMPLE=1,BICUBIC=1`），其余用 `hdr_upsample`（`UPSAMPLE=1`）
    4. 结果在 L0（1/2 分辨率）；合成见 A3
- 金字塔 RT 在 resize 时预建：对 i=0..7，`d = min(w,h)` 逐次减半，`d≥1` 才建并计数 → 最多 8 级（`R+0x310c` = 可用级数，3840×2160 下为 8）。名字 `"_rt_" + (2<<i) + "FrameBuffer"`，尺寸除数 `2<<i`。
- 格式（RT 色彩格式枚举 → DXGI 见 `FUN_1400d2a20`）：
  - LDR 泛光 RT：枚举 1 `rgb888` → `DXGI_FORMAT_R8G8B8A8_UNORM`，无深度
  - HDR 金字塔：枚举 15 `rgb161616f` → `DXGI_FORMAT_R16G16B16A16_FLOAT`，无深度
  - 所有尺寸 `max(2, W/scale) × max(2, H/scale)`（RT 构造 `FUN_1400d2c60`，整数除法）
- 过滤 / 寻址：建 RT 时纹理标志参数恒为 `2`（= ClampUVs，NoInterpolation 位未置）→ **线性过滤 + clamp**（推断：参数与 `.tex` 的 TextureFlags 同义）。

**证据**
- `FUN_14017fa70`（每帧主函数，ev_282c66bd…）：首次加载材质：
  - `bit13&&bit14 → combine_dhdr_upsample`，`bit13 → combine_hdr_upsample`，否则 `combine_ldr`；
  - 非 HDR 时载入 `downsample_quarter_bloom` → `R[0x62c]`、`downsample_eighth_blur_v` → `R[0x62e]`、`blur_h_bloom` → `R[0x62f]`；
  - HDR 时载入 `combine_srgb`/`combine_video_hdr` → `R[0x62b]`、`hdr_downsample` → `R[0x633]`、`hdr_downsample_bloom` → `R[0x632]`、`hdr_upsample` → `R[0x634]`、`hdr_upsample_cubic` → `R[0x635]`。
  - 泛光分支条件（约 0x140180a40）：`(R.flags & 0x40) && (scene.e0>>1 & 1) && scene.objs非空`。
- `FUN_140183610`（泛光链，ev_213eef52…），HDR 分支摘录（意译，变量名为我改写）：
```c
if (R.flags & 0x2000) {
  tx=1/W; ty=1/H;                              // W,H = R+0x84/0x88（场景 RT 尺寸）
  push(L[0]); RenderVar0=(tx,ty,-tx,-ty);
  mat_bloom.tex0 = FullFrameBuffer;  draw(mat_bloom);   pop();
  for (i=1; i<N; i++) { push(L[i]); RenderVar0 = (tx,ty,-tx,-ty)*(1<<i);
       mat_down.tex0 = L[i-1]; draw(mat_down); pop(); }
  for (u=N-1; u>0; u--) { m = (u < N-2) ? mat_up : mat_up_cubic;
       push(L[u-1]); RenderVar0 = (tx,ty,-tx,-ty)*(2<<(u-1));
       m.tex0 = L[u]; draw(m); pop(); }
  return;
}
push(_rt_4FrameBuffer); draw(downsample_quarter_bloom); pop();
push(_rt_8FrameBuffer); draw(downsample_eighth_blur_v); pop();
push(_rt_Bloom);        draw(blur_h_bloom);             pop();
```
  （`L[i]` = `R[0x617+i]`；`R+0xb8..0xc4` 即 `g_RenderVar0`，见 A2。）
- `FUN_14017f1b0`（resize，ev_ff8fd335…）：金字塔/LDR RT 的创建参数：`FUN_1401aadb0(mgr, W, H, scale, name, colorFmt, depthFmt=0x1b, texFlags=2, rtFlags=0)`；`colorFmt = HDR?0xf:1`；LDR：`_rt_4FrameBuffer` scale 4、`_rt_8FrameBuffer` scale 8、`_rt_Bloom` scale 8。
- 格式名表 `FUN_1401e53a0`（ev_66f972c0…）：`rgba8888=0, rgb888=1, rgb565=2, dxt5=4, dxt3=6, dxt1=7, rg88=8, r8=9, rg1616f=10, r16f=11, bc7=12, rgba1010102=13, rgba16161616f=14, rgb161616f=15, rgba16161616=17, rgb161616=18, rgba16161616S=19, rgb161616S=20, rgba8888s=21`。
- DXGI 映射 `FUN_1400d2a20`（ev_8e0e122f…）：`0/1/默认→28 R8G8B8A8_UNORM`，`14/15→10 R16G16B16A16_FLOAT`，`10→34`，`11→54`，`13→24`，`16→41`，`17/18→11`，`19/20→13`；深度：`0x16→55 D16_UNORM`，`0x18→40 D32_FLOAT`，`0x17/0x19→39`，`0x1a/0x1b→无`。
- 着色器（`assets/shaders/hdr_downsample.frag`）：4 tap 于 `uv ± RenderVar0.xy/zw`，`*0.25`（上采样再 `*g_BloomScatter`），`BLOOM` 分支做 soft-knee 阈值。

**与 LWE 的差异**：LWE 只有 1/8 LDR `_rt_Bloom` 一条链。WPE 的 LDR 链与之大体一致；**HDR 时完全不同**：1/2 起的最多 8 级 FP16 金字塔、soft-knee 阈值、逐级加法上采样（最粗两级 bicubic）、强度归一化，LWE 全部缺失。

**置信度**：链结构、材质、RT 名/尺寸、格式枚举与 DXGI 映射——已确认；过滤为线性+clamp——推断。

### A2. `g_RenderVar0` 等引擎参数与场景参数如何换算

**结论**
- `g_RenderVar0` = `R+0xb8..0xc4`（vec4）。泛光各 pass 中取值见 A1 伪代码：下采样 = ±**源**纹素（第 i 步 `±2^i/W, ±2^i/H`）；上采样 = ±**目标**纹素（`±2^u/W`），bicubic 里 `texSize = 0.5/RenderVar0.xy` 即源尺寸。泛光链中未见 `g_RenderVar1…4` 被写（名字存在，ID 0x6d–0x70）。
- 场景参数（偏移 / 类型 / 构造默认值）：

| 键 | `*R`偏移 | 默认 | 去向 |
|---|---|---|---|
| bloomstrength | 0x3bc f32 | **2.0** | LDR：`downsample_quarter_bloom.bloomstrength` |
| bloomthreshold | 0x3c0 f32 | **0.65** | LDR：`…bloomthreshold` |
| bloomtint | 0x3d8 vec3 | **(1,1,1)** | LDR/HDR：`bloomtint`（仅首个下采样材质） |
| bloomhdrstrength | 0x3c4 f32 | **2.0** | HDR：`hdr_downsample_bloom.bloomstrength` |
| bloomhdrthreshold | 0x3c8 f32 | **1.0** | HDR：`blend` |
| bloomhdrfeather | 0x3cc f32 | **0.1** | HDR：`blend` |
| bloomhdrscatter | 0x3d0 f32 | **1.619** | HDR：`hdr_upsample(_cubic).scatter`，并参与强度归一化 |
| bloomhdriterations | 0x3d4 int | **8** | HDR：级数 N |

- HDR 换算（`FUN_140184020`，每次参数变化/加载时调用）：
  - `N = clamp(min(bloomhdriterations, 可用级数), 1, …)`（若 min<1 则 N=1）；
  - `bloomstrength = ( bloomhdrstrength / (1 + pow(scatter, max(N,2) − 2)), scatter )`（2 分量写入，着色器 `g_BloomStrength` 是 float，只用 .x）；
  - `blend = ( t, t − t·f, 2·t·f, 0.25 / (t·f + 1e−5) )`，`t=bloomhdrthreshold, f=bloomhdrfeather`（即标准 soft-knee：knee=t·f）；
  - `bloomtint` 原样；`scatter` 原样写给两个上采样材质。
  - 写死常量：`1.0`（`0x140492704`）、`1e−5`（`0x1404925ec`）、`0.25`（`0x14049268c`），以及着色器内 `0.25`/soft-knee 公式。
- LDR：三个参数原样写入 `downsample_quarter_bloom`（无换算）；`blur_*` 无参数。
- 例：razer_bedroom（hdr, scatter 1.62, strength 2.5, threshold 1.0, feather 0.1，未写 iterations→8，4K→可用 8 级）：N=8，`g_BloomStrength = 2.5/(1+1.62^6)=2.5/19.0≈0.131`，`blend=(1.0, 0.9, 0.2, 2.4998)`。

**证据**
- `FUN_140184020` 汇编（ev_5246f50f…）关键序列：
```asm
mov ecx,[rdi+0x3d4]      ; iterations
mov edx,[rbx+0x310c]     ; 可用级数
...                      ; N=min(...) ; <1 → 1
mov [rbx+0x3108],eax     ; N
cmp eax,2 / jg / mov eax,2 / add eax,-2
movaps xmm0,xmm7         ; xmm7=[rdi+0x3d0] scatter
cvtdq2ps xmm1,eax
call 0x14041e350         ; pow(scatter, max(N,2)-2)
movss xmm1,[rdi+0x3c4] ; addss xmm0,1.0 ; divss xmm1,xmm0
mov [rsp+0x64] ← scatter ; "bloomstrength", 2 分量
t=[rax+0x3c8]; k=t*[rax+0x3cc]; (t, t-k, k+k, 0.25/(k+1e-5)) → "blend", 4 分量
```
- 默认值：场景构造函数内连续指令 `0x1401870ac..0x1401870ee`（`41 C7 87 <disp> <imm>`）与 `0x140186ff0..` 的 bloomtint 三个 1.0（字节级检索，`finddefaults.py`）。
- 键→偏移：属性注册表 `FUN_140199780`（ev_97669439…，脚本 `proptable.py` 抽取）。
- `FUN_14041e350` 为 `powf`：调用约定（xmm0, xmm1）与另一处用法 `pow(x, 4.0)`（`FUN_140183a70`）——推断。

**与 LWE 的差异**：LWE 忽略 `bloomhdr*`，也没有 `blend`（soft-knee）、`scatter`、强度归一化与 tint。注意 WPE 默认 `bloomstrength=2.0 / bloomthreshold=0.65`（与着色器注释一致），缺省键时应取这些值。

**置信度**：偏移/默认值/换算公式——已确认（汇编级）；`FUN_14041e350`=pow——推断；`R+0xb8`=`g_RenderVar0`——推断（强：泛光着色器只读 `g_RenderVar0`，而代码在每个 pass 前写 `R+0xb8..0xc4`；uniform ID 表里 `g_RenderVar0`=0x6c，但把 ID 映射到地址的 switch 未追到）。

### A3. 最终合成：何时用哪个 combine、哪些 combo、SDR 上如何收尾

**结论**（每帧，场景对象都画完之后；`R[0x613]` = `_rt_FullFrameBuffer`）
| 情况 | 动作 |
|---|---|
| LDR，无泛光 | 场景直接画进当前目标（后备缓冲 / MSAA RT），**没有** combine pass |
| LDR，有泛光 | `FullFrameBuffer ← CopyResource(当前目标)`；泛光链；`combine_ldr`：`rgb = scene + bloom`，`a = 1`，不 saturate（RGBA8 目标自然截断） |
| HDR，无泛光 | 拷贝到 `_rt_FullFrameBuffer` 后画 `combine_srgb`（`passthroughsrgb`：`rgb = lin(rgb)`，保留 alpha，**不 saturate**）；`R.flags & 0x10000` 时改用 `combine_video_hdr` |
| HDR，有泛光，非 DisplayHDR | `combine_hdr_upsample`（`combine_hdr`，无 combo）：`bloom = 4 tap(L0, uv ± g_TexelSize 对角)*0.25`；`out = saturate(lin(scene + bloom)) * g_RenderVar0.x`，`a=1` |
| HDR，有泛光，DisplayHDR（`0x4000`） | `combine_dhdr_upsample`（`DISPLAYHDR=1`）：`scene=saturate(scene); c = scene+bloom; k = RV0.y*smoothstep(1,5,luma(c))+RV0.x; out = lin(max(0,c))*k` |
- HDR 合成前：`device->vfunc_0x158(&R.RenderVar0)`（由设备填写 `g_RenderVar0`，推断为 SDR 白电平/峰值亮度等系数），并把 `combine` 材质的纹理槽 1 运行时绑为金字塔 L0（JSON 里只有槽 0）。
- `combine.json`（`util/black`）与 `combine_hdr_editor.json` 不在此函数中使用（编辑器用）。
- **色彩空间含义**：场景里所有图层、效果、泛光都在 **sRGB 编码空间**（"gamma 空间"）里计算，HDR 只是用 FP16 让数值可 >1；`lin()` 只出现在最后一步，配合 FP16（scRGB）交换链/后备缓冲（推断，见 A4）。所以在 SDR 画布上，HDR+泛光的等效收尾就是 `saturate(scene + bloom) × RV0.x`（RV0.x 在 SDR 显示上推断≈1），且仍在 sRGB 空间直接输出；HDR 无泛光时等效 `saturate(scene)`（截断由显示/合成器完成）。

**证据**：`FUN_14017fa70` 0x140180a2d 之后的两个分支（ev_282c66bd…）；材质 JSON 与 `combine_hdr.frag` / `passthroughsrgb.frag` / `combine.frag`（只读）。复制操作 `FUN_1400d3310`（RT 虚表 +8，ev_34d4bd4c…）：`ID3D11DeviceContext::ResolveSubresource`（vtbl+0x1c8，源为 MSAA 时）或 `CopyResource`（vtbl+0x178），源 = 当前绑定 RT 栈顶，空栈则为默认后备缓冲。

**与 LWE 的差异**：LWE 只有 LDR 加法合成；HDR 的 `lin()`、`saturate`、`RenderVar0` 系数、DisplayHDR 路径、HDR 无泛光时的 `combine_srgb` 全无。另：WPE 的 bloom 合成采样 L0 时额外做 4 tap 对角平均。

**置信度**：分支与材质——已确认；`vfunc_0x158` 写入的具体数值——未知（SDR 下≈1 为推断）；"场景在 sRGB 空间计算"——推断（强：仅终合成调用 `lin()`）。

### A4. `hdr: true/false` 时场景主 RT 的格式；clearcolor

**结论**
- `_rt_FullFrameBuffer`（`R[0x613]`，场景尺寸，scale 1）：HDR → `R16G16B16A16_FLOAT`，否则 `R8G8B8A8_UNORM`（**非 sRGB 格式**）；深度 `D16_UNORM`（`R.flags&1` 时无深度）。
- 同一套规则用于 `_rt_FullFrameBufferMultiSampled`（开 MSAA 时场景实际画进它，深度 D32F，再 Resolve）、`_rt_MipMappedFrameBuffer`（general bit11 时，带 mip，每帧拷贝后生成 mip）、`_rt_Reflection`（反射，RGBA8）。
- 场景对象实际画进"当前目标"（无 MSAA 时为后备缓冲），之后才 `CopyResource` 到 `_rt_FullFrameBuffer`。`CopyResource` 要求格式一致 ⇒ HDR 模式下后备缓冲/交换链也必须是 RGBA16F（推断）。
- clear：每帧 `setClearColor(clearcolor.r, .g, .b, 1.0)`（`*R+0x35c..0x364`；原写「编辑器状态下改用 `R+0x31b0..`」不对，切换条件是 `alignment`，值是 `schemecolor`，见 p3-script-REPORT L3），`general.clearenabled`（bit5，默认开）为真时在渲染场景前清屏（颜色+深度）。clearcolor 与图层颜色同处 sRGB 编码空间，HDR 下不做转换。
- 渲染标志 `0x2000` 与 general `hdr`（bit10）的对应关系：未找到设置代码（推断：`hdr` 为真且设备/设置允许时置位）。另：general 标志字的构造默认值为 `0x26`（bloom 位与 clearenabled 位默认置 1），即 **JSON 缺 `bloom` 键时推断为开**。

**证据**：`FUN_14017f1b0`（`_rt_FullFrameBuffer` 创建：`colorFmt = HDR?0xf:1`，`depth = 0x16 + 4*(flags&1)`）；`FUN_140181af0`（场景加载：MSAA/Mip/Reflection RT，ev_75384…）；`FUN_14017fa70` 帧首 clear 色；`FUN_140183550`（`clearenabled` → device clear）；默认标志 `0x140186d20: mov dword [..+0xe0], 0x26`。

**与 LWE 的差异**：LWE 的场景 FBO 不随 hdr 改格式；WPE 在 HDR 下整个场景链（主 RT、合成 RT、`*_backbuffer` 型 fbo）都是 FP16。

**置信度**：格式——已确认；交换链 FP16——推断；`bloom` 缺省为开——推断（仅依据构造默认值）。

---

## B. 图层渲染图

### B5. `_rt_imageLayerComposite_*` 的尺寸、格式、分配时机

**结论**
- 只有需要离屏的图层才分配合成 RT。数量 = `min(2, (passthrough标志?1:0) + count)`，`count` = 所有**启用**效果的 Σ(1 + 该效果 `compose:true` 的 pass 数)（图层标志 bit13 置位时每效果不 +1）；没有效果但为 passthrough 模型且有子图层时为 1；为 0 则不分配（直接画进场景）。
- **命名**：只有在 passthrough 标志（colorBlendMode 混合）下，第 0 张才是独占的 `_rt_imageLayerComposite_<id>_a`；其余（以及无 passthrough 时的全部）是**池化共享 RT**，名字 `sc.<W>.<H>.<n|b><c|r><k>`（`n`=nointerpolation，`b`=双线性；`c`=clampuvs，`r`=repeat；`k`=父链上同名层的序号，避免嵌套冲突）。**WPE 中不存在 `_b` 这个名字。**
- **尺寸**（图层虚函数 +0x128 = `FUN_1402091e0`）：取基础材质槽 0 纹理的**真实图像尺寸**（tex+0x2c/+0x30），非 padding 后的纹理尺寸；精灵表取单帧尺寸；非 fullscreen 的 passthrough/solidlayer 模型取图层 `size`（四舍五入）；无纹理时取 `size`；再除以全局纹理降级系数（`ctx+0x1218`，通常 1）；最终 `max(4, ·)`。同时得到 UV 缩放 `(imgW/texW, imgH/texH)`，用于图层四边形 UV。
- **格式**：HDR → `rgba16161616f`（RGBA16F），否则 `rgba8888`（RGBA8_UNORM）；无深度；纹理标志 = 图层 `nointerpolation` / `clampuvs`。
- 分配时机：图层 resize / 设置效果时（基类虚函数 +0xb8 = `FUN_1401ea500`），不是每帧。

**证据**：`FUN_1401ea500`（ev_667191cb…）：`iVar26=(flags>>4&1)+effectCount; ... if (iVar26>2) iVar26=2;`；passthrough 且 i==0 时拼 `"_rt_imageLayerComposite_"+id+"_"+"a"`（`0x14048de40`="_"，`0x140490714`="a"），否则拼 `"sc."+W+"."+H+"."+("n"|"b")+("c"|"r")+k`（`0x140490838`/`0x140490600`、`0x1404907cc`/`0x1404907c8`）；格式 `local_f0 = (ctx.flags & 0x2000) ? 0xe : 0`。计数累加：`FUN_1401e7170` 末尾 `layer[+0x320] += (~flags>>13 & 1) + effect.composeCount`（仅 `effect.flags&1`）。尺寸：`FUN_1402091e0`（ev_8cc98271…）。

**与 LWE 的差异**：LWE 每个带效果的图层固定分配 `_a/_b` 两张、以 `size` 为尺寸；WPE 以真实图像尺寸为准、ping-pong 两张大多来自共享池、只在需要时分配、HDR 下为 FP16。

**置信度**：已确认（命名后缀的具体含义 `n/b/c/r` 来自与 nointerpolation/clampuvs 位的对应——已确认）。

### B6. effect.json 的 `passes` / `fbos` / `bind` / `target` 与 `textures` 里的 `null`

**结论**
- **fbos[]**（每项 0x50 B）：`name`、`format`（`"rgba_backbuffer"` → HDR?RGBA16F:RGBA8；`"rgb_backbuffer"` → HDR?`rgb161616f`:`rgb888`（DXGI 均为 4 通道）；其他走格式名表；无法识别→`rgba8888`）、`scale`（整数除数，默认 1）、`width`/`height`（显式尺寸，≤4096 时覆盖）、`fit`（≤4096 时按最大边等比适配）、`unique`（bool）、`clear`（字符串颜色 `"r g b a"`，创建/resize 后立即清成该色）、`uvs`（`"repeat"` → 重复寻址，否则 clamp）、`conditions`（combo 条件）。
  - **P7d 更正**（rea-p7d-fluid 第 1–3 节）：`clear` 要解析出 4 个数才置清除位，只写 3 个时存了颜色却不清；清的时机是每次图层 effect 资源重建（`FUN_1401ea500`：创建、resize、可见 effect 数变化、重载 effect），不只创建时。`conditions` 在加载时按 effect 实例顶层 `combos` 求一次，被去掉的 fbo / pass / bind 不进 effect 对象（规则见 rea-p7d-fluid 第 1 节）。尺寸基准 = 图层合成 RT 尺寸，再 `/scale`（RT 最小 2）。
  - 命名：`unique:true` → `<name>_<layerId>`（每图层独占）；否则非 fullscreen 图层用 `<name>_<W>_<H>_<scale>`（**同尺寸图层之间共享**），fullscreen 图层直接用 `<name>`。
- **passes[]**（每项 0x30 B）：`material`、`command`（缺省=绘制；`"copy"`=1；`"swap"`=2）、`target`、`source`（fbo 名 → 下标；`target` 缺省 = 当前合成链）、`compose`（bool：该 pass 写入合成 ping-pong，并使计数 +1）、`bind[] {name, index}`（name 在 fbos 中找不到——例如 `"previous"`——就记为 −1 = 当前合成 RT）、`conditions`。
  - 解析后处理：每个绘制 pass 记录"下一个绘制 pass 是否以合成链为目标"（flag bit2，用于决定画完后是否弹出目标）；`effect+0x144` = **最后一个绘制 pass 的下标**；若任一 pass 材质含 "需要帧缓冲" 位（材质 +0x1fc bit1）则效果标志 |= 2。
- **执行**（`FUN_1401ebf60`，每个 pass）：
  - `copy`：绑定 source fbo，然后 `target_fbo.CopyFrom(当前绑定)`（`CopyResource`），即 **source → target 整张拷贝**；
  - `swap`：不做 GPU 工作，只把**后续所有 pass** 里引用 source/target 下标（target、source、bind）的地方互换（P7d 更正：改写的是本 effect **全部**非 swap pass，含它之前的；两端有一个查不到 fbo 时什么都不做；fbo 条目本身从不交换，rea-p7d-fluid 第 3 节）；
  - 绘制：若 `target≥0` 先压入该 fbo；纹理：**没有 bind 时槽 0 = 当前合成 RT（上一步输出）**；有 bind 时只按 bind 逐槽赋值（−1 → 当前合成 RT），不自动填槽 0；画全屏合成四边形（`layer[0x5c]`）。
- **`textures` 中的 `null`**：材质槽不由材质自己提供，留给上面的运行时赋值；对无 bind 的 pass 即"上一步输出"。像 `rz.json` 的 `[null, "wave"]` → 槽0=上一步、槽1=wave。

**证据**：`FUN_1401e7170`（效果加载，ev_524984f5…）：`"rgba_backbuffer"`/`"rgb_backbuffer"` 分支、`unique→bit0`、`clear→bit1`、`uvs=="repeat"→bit2`、`command=="copy"→1 / =="swap"→2`（`0x1404905b8`="copy"、`0x140474f0c`="swap"）、`compose→pass.flags|=2 && effect[+0x140]++`、`bind` 名查找失败→`0xffffffff`；fbo 实例化与命名在 `FUN_1401ea500` 后半；执行在 `FUN_1401ebf60`（ev_34d4bd4c…）。

**与 LWE 的差异**：LWE 只做 fbos/bind/target ping-pong；WPE 另有 `copy`/`swap` 命令、`compose` 显式计数、fbo 的 `clear`/`uvs`/`fit`/`width`/`height`/`unique`、`*_backbuffer` 格式随 HDR 变化、非 unique fbo 跨图层共享。

**置信度**：字段与命令——已确认；`swap` 的语义（只改后续下标）——已确认；`fit` 的精确算法——推断。

### B7. 哪个 pass 画到场景、用什么 blending 与变换；"blending 挪到最后一个 pass" 是否属实

**结论**
- 基础 pass（图像本身）画进合成 RT 时**关闭混合**（不透明写入，保留 alpha），正交投影、单位模型矩阵（passthrough 模型例外，见 B9）。
- 非 passthrough 图层：效果链里 swap 计数达到 `count−1` 时（即最后一个启用效果，在它最后一次 compose 之后），该效果剩余的 pass 改为 `final` 模式；其中**只有 `effect+0x144`（最后一个绘制 pass）** 用图层世界四边形（`layer[0x5d]`）+ 场景视图投影 × 图层模型矩阵（fullscreen 图层则用单位矩阵、NDC −1..1）画到场景目标；其余 pass 仍画全屏四边形到各自 fbo。
- 该最终 pass 画之前调用图层虚函数 +0x108（`FUN_140209160`）：把**基础材质**的 `blend`（+0x1f0）、+0x1f2、+0x1f3（深度测试/写入类状态）拷到此 pass 的材质上；`colorBlendMode==31` 时 blend 强制为 2（additive）；画完恢复原值。**"第一个 pass 的 blending 挪到最后一个 pass" 属实**（准确说是"图层基础材质的 blending/深度状态用于最终上屏 pass"）。
- 混合模式枚举（`FUN_1401531c0`）：`0 normal`（不开混合）、`1 translucent`、`2 additive`、`3 alphatocoverage`。
- passthrough 图层（colorBlendMode 混合）：所有效果 pass 都留在合成 RT，最后由 passthrough 材质上屏（见 B8）。

**证据**：`FUN_1401e8aa0`（共享图层渲染，ev_f0e1f435…）效果循环与 `LAB_1401e9cc9` 之后的最终绘制；`FUN_140207b50` 绑定基础材质后立即 `device->vfunc_0x128(0)`（关混合）；`FUN_140209160` 机器码（手工解码）：
```asm
cmp dword [rcx+0x32c],0x1f ; jne → mov rax,[rcx+0x498] ; movzx eax,byte [rax+0x1f0]
; je  → mov al,2
mov [rdx+0x1f0],al          ; pass材质.blend = 基础材质.blend (或 additive)
mov [rdx+0x1f2], base[0x1f2] ; mov [rdx+0x1f3], base[0x1f3]
```
`FUN_1401ebf60`：`final && effect+0x144==pass` 时调用 vfunc+0x108，画 `layer[0x5d]`，之后恢复 `+0x1f0/+0x1f2/+0x1f3`。

**与 LWE 的差异**：与 LWE 的"挪 blending"一致；但 WPE 只对**最后一个启用效果的最后一个绘制 pass** 上屏，且同时搬运深度状态；colorBlendMode 31 是 additive 而非着色器混合。

**置信度**：已确认。

### B8. `colorBlendMode > 0` 的真实做法；`_rt_FullFrameBuffer` 如何提供；`g_Texture4`

**结论**
- 加载时若 `colorBlendMode ∉ {0, 31}`（或图层标志 0x100，或渲染标志 0x1800000）→ 置 passthrough 标志（图层 `+0x304` bit4）。
- 有该标志时创建 passthrough 材质：`materials/util/effectpassthrough.json`（`genericimage3`），设备能力等级 >2 时用 `effectpassthrough_4.json`（`genericimage4`）；combos：`BLENDMODE = colorBlendMode`，`FOG_COMPUTED = 1`。合成 RT 数 +1，使**所有**效果 pass 都画进合成 RT；最后：`g_Color4`（渲染器颜色）置 (1,1,1,1)，passthrough 材质槽 0 = 最终合成 RT，blend = 基础材质 blend，用图层几何画到场景。
- 即使没有效果，只要有 passthrough 标志，也走"基础 pass → 合成 RT → passthrough 上屏"。
- `colorBlendMode == 31`：**不**走 passthrough，直接把（基础或最终 pass 的）材质 blend 设为 additive（2）。
- **`_rt_FullFrameBuffer` 是快照，不是反馈环**：`CopyResource`（MSAA 时 `ResolveSubresource`）把**当前场景目标整张**拷进 `_rt_FullFrameBuffer`。拷贝时机：
  1. 图层开始渲染时，若（基础材质需要帧缓冲 **或** colorBlendMode∉{0,31}）且（图层非 fullscreen **或** colorBlendMode∉{0,31} **或** 有子图层）且（无父层或父层不是 passthrough 模型）；
  2. 某个启用效果的第一个 pass 之前，若该效果任一 pass 的材质需要帧缓冲（效果标志 bit1），且本图层还没拷过；
  3. 最终上屏 pass 之前同理补拷。
  拷贝时绑定的是场景目标（合成 RT 已弹出），所以快照 = **画到本图层之前的场景**。
- `g_Texture4`：`genericimage3.frag` 声明 `uniform sampler2D g_Texture4; // {"hidden":true,"default":"_rt_FullFrameBuffer"}`，即由着色器注解默认绑定到上述快照；`BLENDMODE` 分支用屏幕坐标 `screenUV` 采样它，`rgb = ApplyBlending(BLENDMODE, screen.rgb, color.rgb, color.a)`，`a = screen.a`。

**证据**：`FUN_1401e6f50`（加载，置 bit4 的条件）、`FUN_1401ebbc0`（passthrough 材质与 combos，ev_667191cb…）、`FUN_1401ecae0`（`effectpassthrough_4` 选择）、`FUN_1401e8aa0` 第 147–173 行（层首拷贝条件）、第 788–818 行（效果前拷贝）、第 1045–1108 行（final/passthrough 上屏）、`FUN_1400d3310`（拷贝实现）。

**与 LWE 的差异**：LWE 一律追加 passthrough（genericimage3）且 `_rt_FullFrameBuffer` 是边画边采样的 GL 反馈环；WPE 用显式整帧拷贝（快照）、31 走 additive、只有需要时才拷、拷贝在合成 RT 之外进行。WebGPU 实现：在上述时机对场景目标做 `copyTextureToTexture` 到独立快照纹理即可兼容。

**置信度**：已确认（`vfunc+0x118` 的含义"材质需要帧缓冲" = 基础材质 `+0x1fc` bit1——推断：该位由材质 textures 中出现 `_rt_FullFrameBuffer` 设置，设置点未直接看到）。

### B9. 图层 `copybackground`、`solid` 的语义

**结论**
- 位：`copybackground` = 图层 `+0x304` bit6（`0x40`）；`solid` = 对象 `+0x120` bit13（`0x2000`）。模型 JSON 位：`fullscreen 0x2, nopadding 0x4, autosize 0x8, passthrough 0x20, solidlayer 0x200, projectlayer 0x400, instanced 0x800`；对象属性：`nointerpolation 0x4000, clampuvs 0x8000`。
- **`copybackground` 只对 passthrough 模型生效**（`models/util/composelayer.json`、`fullscreenlayer.json`、`projectlayer.json`，材质纹理为 `_rt_FullFrameBuffer`）：
  - `true`：基础 pass 用图层世界四边形（`layer[0x5d]`）+ 世界变换画基础材质进合成 RT ⇒ 合成 RT 的初始内容是**图层背后的场景快照**，效果链作用于背景；
  - `false`：先把合成 RT 清成 (0,0,0,0)，然后（基础 pass 之后）把**子图层**画进合成 RT（期间切换一个设备状态 `vfunc_0xe8(1)`），即"只合成子层"的组；无效果直接上屏时 blend 被强制为 translucent；加载时标记为透明排序对象。
  - 普通图像模型（如 razer_vortex 的 `models/vortex.json`，只有 `autosize`）上 `copybackground:true` **没有渲染效果**。
- `solid`：在图层渲染路径中未发现任何读取（字节级搜索 `test/bt [reg+0x120], bit13` 无结果）。推断与鼠标拾取/交互（光标命中）有关，不影响画面。模型级 `solidlayer`（不同于 `solid`）影响几何与尺寸（`FUN_1401ea310`、`FUN_1402091e0`）。（2026-11-07 复核：实际只影响带纹理时的合成 RT 尺寸和上屏四边形的 UV 内缩，见 p3-script-REPORT L22。）

**证据**：属性表 `FUN_1401ee520`（ev_03697e84…）+ 位访问器 `FUN_1401ef350`（0x40）、`FUN_14019bb40`（0x4000）、`FUN_14019bd70`（0x8000）（ev_726f7f52…）；`solid` 注册于 `0x1401e1286`，访问器 `FUN_14019c3f0`（`btr/bts edx,13`）；模型解析 `FUN_1401fac50`（ev_3c681665…）；`FUN_140207b50` 第 277–300 与 432–460 行；`FUN_140208670` 第 55–60 行。

**与 LWE 的差异**：LWE 未实现 copybackground；WPE 中它决定合成层是"以背景为底"还是"以透明为底 + 子层"。

**置信度**：copybackground——已确认（子层渲染与 `vfunc_0xe8` 的确切意义——推断）；solid 不影响渲染——推断。

### B10. `brightness`、`alpha`、`color` 如何进入 uniform；LDR 下 brightness > 1 是否被截断

**结论**
- 图层默认：`color=(1,1,1)`（+0x330）、`alpha=1`（+0x33c）、`brightness=1`（+0x340）。
- 画基础 pass（直接上屏或画进合成 RT）前设置渲染器颜色：`ctx+0x124..0x12c = color.rgb × k`，`ctx+0x120 = alpha`，其中 **`k = brightness`（仅当 HDR，`ctx.flags & 0x2000`），否则 `k = 1.0`**。推断这就是 `g_Color4 = vec4(color·k, alpha)`（引擎 uniform，ID 2；另有 `g_Alpha` ID 0、`g_Color` ID 1）。
- **LDR 下 brightness 完全不生效**（不是截断，是不乘）；HDR 下无截断（FP16），>1 的部分会被 HDR 泛光阈值（默认 1.0）捡到。
- 例外：模型为 passthrough/instanced 且基础材质标志 `+0x1f8` bit2 时，颜色强制 (1,1,1,1)；passthrough 上屏 pass 也强制 (1,1,1,1)。效果 pass 不重设颜色（只在基础 pass 应用一次）。
- 材质自身的 `g_Brightness`/`g_UserAlpha`（`genericimage2` 的 material 常量）与对象 brightness 是两回事。

**证据**：`FUN_140208670` 第 25–46 行、`FUN_140207b50` 第 79–99 行（ev_8cc98271…）：
```c
k = (ctx.flags & 0x2000) ? layer.brightness : 1.0f;
ctx.color[1..3] = layer.color.rgb * k;   // +0x124,+0x128,+0x12c
ctx.color[0]    = layer.alpha;          // +0x120
```
默认值：`0x1401e6a6b..0x1401e6a93`（图层基类构造内 5 个 `mov dword [..], 1.0f`）。

**与 LWE 的差异**：razer_bedroom 的 brightness 3–4 只在 HDR 下才放大；若 Kabegame 在 LDR 下也乘 brightness 会过曝。

**置信度**：赋值逻辑——已确认；`ctx+0x120..` = `g_Color4`——推断。

### B11. 效果 `visible=false` 或绑定用户属性时

**结论**：效果对象标志 `+0x118` bit0 = 启用（visible）。渲染循环对未启用效果**整体跳过**（不是直通）；加载时合成计数只累加启用效果，所以"最后一个启用效果"才会上屏。用户属性绑定通过效果对象的通用属性系统（`FUN_1401a38f0`）改写该位。运行时切换后是否重算计数——未直接确认（推断：属性变化回调会重建，见 `FUN_1401e6f50` 末尾调用 vfunc+0x110）。

**证据**：`FUN_1401e8aa0` 第 788 行 `if ((*(byte*)(effect+0x118) & 1) != 0)`；`FUN_1401e7170` 第 1067–1075 行（仅 `flags&1` 时累加）。

**与 LWE 的差异**：与"整步跳过"一致；但 WPE 跳过后会影响"哪个 pass 上屏"的选择（计数），实现时需按启用效果重新计算。

**置信度**：跳过——已确认；运行时重算——推断。

### B12. FreeImage 内嵌 PNG 的 `.tex`（头 4096×4096、实际 3840×2160）

**结论**：图层合成尺寸取纹理对象的"图像尺寸"字段（tex+0x2c/+0x30），UV 缩放 = `(tex+0x2c / tex+0x20, tex+0x30 / tex+0x24)`，图层四边形的 UV 上界就是这个比值；即**内容按真实图像尺寸处理，UV 只覆盖有效区域**。`g_Texture0Resolution` 的计算未追到（推断与 LWE 相同为 `(texW, texH, imgW, imgH)`）。对 FreeImage 内嵌 PNG 而言 tex+0x20 是头里的 4096 还是解码后的实际尺寸——未知。

**证据**：`FUN_1402091e0`；`FUN_1401ea500` 第 514–518 行把 `(uvScale, texSize)` 交给 `FUN_1401ede30` 生成 `layer[0x5b]` 四边形。

**置信度**：合成尺寸/UV 比——已确认；`g_Texture0Resolution`——未知。

---

## C. 引擎内置 uniform（有余力部分）

- **名字 → ID 表**（`FUN_140002860`，ev_0f649bf8…）：`g_Alpha 0, g_Color 1, g_Color4 2, g_Time 3, g_Frametime 4, g_Daytime 5, g_TexelSize 6, g_TexelSizeHalf 7, g_Screen 8, g_ModelMatrix 9, g_ModelMatrixInverse 10, g_ViewProjectionMatrix 11, g_ModelViewProjectionMatrix 13, …, g_EffectModelMatrix 0x13, g_EffectModelViewProjectionMatrix 0x14, g_EffectTextureProjectionMatrix 0x16, g_LayerModelMatrix 0x18, g_Texture0..9 0x20–0x29, …Rotation 0x2a–, …Translation 0x34–, …Resolution 0x3e–0x47, …Texel 0x48–0x51, …MipMapInfo 0x52–, g_PointerPosition 0x69, g_PointerPositionLast 0x68, g_ParallaxPosition 0x6b, g_RenderVar0..4 0x6c–0x70, g_HDRParams 0x8b`。常量缓冲名：`g_bufStatic / g_bufLights / g_bufAnimation / g_bufDynamic`。ID→数值的 switch 未定位（下一步的锚点）。
- **时间**：每帧 `R+0x148`（double）累加 dt，`R+0x140` = float 副本；**超过 432000 s（5 天）归零**；`R+0x15c` = 本帧 dt、`R+0x160` = 上帧 dt。推断 `g_Time`/`g_Frametime` 来自这里。（`FUN_14017fa70` 开头）
- **效果矩阵**：pass 材质的着色器能力位 4（解析时转成 pass 标志 bit0）为真时，每个 pass 前写 `ctx+0x970..0xa2c` 三个 4×4：非 final 时 = 图层世界矩阵（`layer+0x384..`）× `scale(width/2, height/2)` 以及视图投影（`layer+0x344..`，取自 `ctx+0x8f0`）× 同一缩放；final 时直接用未缩放矩阵、只给纹理投影乘缩放。推断依次对应 `g_EffectModelMatrix` / `g_EffectModelViewProjectionMatrix` / `g_EffectTextureProjectionMatrix`（`FUN_1401ebf60`）。
- `g_TexelSize`（LDR 泛光与 combine_hdr 用）、`g_PointerPosition`、`g_Daytime`、`g_Screen` 的具体取值——未知。

---

## D. 对 Kabegame P2 的落地要点（行为摘要）

1. 场景链全部在 sRGB 编码空间计算；HDR 只换 RGBA16F，终合成才 `lin()`。SDR 画布：LDR+泛光 = `scene + bloom`；HDR+泛光 ≈ `saturate(scene + bloom)`；HDR 无泛光 ≈ `saturate(scene)`。
2. HDR 泛光照 A1/A2 实现：1/2 起 ≤8 级 FP16 金字塔、soft-knee、加法上采样（最粗两级 bicubic）、`strength/(1+scatter^(N−2))`；缺省参数用 A2 表。
3. `_rt_FullFrameBuffer` = 场景目标的整帧快照（`copyTextureToTexture`），按 B8 的时机拷贝；不要采样正在渲染的目标。
4. 图层：基础 pass 关混合画进合成 RT（RGBA8/RGBA16F，真实图像尺寸）；最后一个启用效果的最后一个绘制 pass 用基础材质的 blend/深度状态与图层世界四边形上屏；colorBlendMode∉{0,31} → genericimage3+BLENDMODE passthrough 上屏；31 → additive。
5. brightness 只在 HDR 下乘进 `g_Color4`。
6. effect.json 要支持 `command: copy/swap`、`compose`、fbo `clear/uvs/fit/width/height/unique`、`*_backbuffer` 随 HDR 的格式。

## E. 未解决问题与下一步建议

| 问题 | 现状 | 建议 |
|---|---|---|
| `device->vfunc_0x158` 写入 `g_RenderVar0` 的值（SDR / HDR 显示） | **已解决**（第二轮，见 G5）：SDR 时 (1, 1) | — |
| uniform ID → 数值的 switch（确认 `g_RenderVar0=R+0xb8`、`g_Color4=ctx+0x120`、`g_TexelSize`、`g_Texture0Resolution`、`g_Time`） | **已解决**（第三轮，见 I4；ID 6 / 7 已更正） | — |
| 渲染标志 `0x2000/0x40/0x4000` 由谁置位（与 general `hdr`/`bloom`、用户设置的关系） | **已解决**（第二轮，见 G2–G3）：由用户设置 `postprocessing` 与场景 `bloom`/`hdr` 共同决定 | — |
| 交换链格式 | **已解决**（第二轮，见 G2）：HDR 时 R16G16B16A16_FLOAT，否则 R8G8B8A8_UNORM | — |
| FreeImage 内嵌 PNG 的 tex+0x20 取头尺寸还是解码尺寸 | **已解决**（第三轮，见 I3）：纹理尺寸被强制改成头里的图像尺寸 | — |
| 材质 `+0x1fc` bit1（需要帧缓冲）的设置点 | **已解决**（第三轮，见 I2）：纹理槽解析到 `_rt_FullFrameBuffer` | — |
| `solid` 的用途 | 第三轮仍未找到渲染侧读取（I6），推断为交互 | 不影响渲染，暂不追 |
| 效果可见性运行时切换后计数是否重算 | **已解决**（第三轮，见 I5）：会重算并重建 | — |

## F. 安全与合规说明

- 全程只读静态分析；未运行、未附加任何 WPE 进程；未对 Steam 目录写入；Kabegame 仓库未改动、未执行 git/进程操作。
- 文件未加壳、无加密，未遇到反分析手段。
- 反编译出的字符串/代码中**未发现**要求执行、下载或发送内容的指令（仅有正常的错误信息、调试断言路径 `D:\dev\we\windows\src\...` 与内置 HLSL 宏文本）。

---

## G. 第二轮（2026-11-01）：用户设置 `postprocessing` 如何决定渲染标志

背景：用户 WPE 的 `config.json` 里是 `"postprocessing" : "disabled"`（只读查看）；二进制里有 `postprocessing`、`ultra`、`displayhdr` 三个字符串。本轮要查的是这个用户设置与 `R+0x128` 渲染位的关系。约束与第一轮相同：只读静态分析 scratchpad 副本，不运行、不附加任何 WPE 进程；本轮没有另存快照。

**一句话结论**：
- `postprocessing` 只要不是 `"disabled"` 就置 0x40（允许泛光）。
- 只有 `ultra` / `displayhdr` 才可能开 HDR，而且场景 JSON 的 `general.bloom` 和 `general.hdr` 都必须显式写 `true`。
- 所以 `"disabled"` 时：不画泛光、不走 HDR、brightness 不生效，全程 LDR。

**渲染位的来源**（已确认）：`R+0x128` 不是渲染器自己算的，而是拷自壁纸宿主对象 W 的标志字 `W+0x248`。
- 渲染线程 `FUN_140110630` 建渲染器时，描述结构 `+0x20 = W+0x248 | 0x100d`；开 MSAA 时为 `| 0x100f`。
- `FUN_14017c6d0` 里 `this[0x23] = desc[+0x20]`（this = R+0x10），也就是写到 `R+0x128`。
- 因此下文 `W+0x248` 的各位，就是 `R+0x128` 的对应位。

### G1. 取值集合与默认值
- **结论**：
  - wallpaper64 只认三个值：`"disabled"`（`memcmp` 8 字节精确比较）、`"ultra"`、`"displayhdr"`。
  - 其它任何字符串（UI 里可能是 `"enabled"` 之类）一律当作「开泛光、不开 HDR」。完整选项列表在 `wallpaperui.exe`，本次没看。
  - 配置缺这个键时，默认补成 `"disabled"`。
  - 补默认值之前，若运行时直接读到空串，长度不等于 8，反而会置 0x40；但配置加载时已先补默认值，所以实际效果仍是 disabled。
- **置信度**：已确认；UI 选项列表未知。
- **地址**：
  - `FUN_14010df40`（壁纸加载）与 `FUN_14010efb0`（运行时应用设置）中的 `memcmp(v, "disabled", 8)`。
  - 配置默认值填充 `FUN_140046f20`：postprocessing → `"disabled"`；同处还有 msaa → `"x2"`、resolution → `"full"`、shadows / volumetrics → `"medium"`。
  - 同批画质项 shadows / volumetrics（存于 `W+0x244` / `W+0x245`）共用档位枚举 `FUN_14010dad0`：disabled=0、low=1、medium=2（缺省 / 其他）、high=3、ultra=4。postprocessing 不用这张表。

### G2. 各取值置哪些位

| 位 | 条件 | 地址 |
|---|---|---|
| 0x40 | postprocessing ≠ `"disabled"`；运行时改设置会立即更新 | 0x14010edcb 一带、0x14010f1aa |
| 0x2000（HDR） | postprocessing == `"ultra"`，且满足 G3 的场景条件 | 0x14010e6a7 附近 |
| 0x6000（HDR + 显示器 HDR） | postprocessing == `"displayhdr"`，且满足 G3 的场景条件 | 0x14010e6a7 附近 |
| 0x8000 | 工程 `general.supportsvideo` 为 true（对应 D3D11 VIDEO_SUPPORT 设备标志） | `FUN_14010df40` |
| 0x2 | MSAA 实际启用（`msaa` 的 x2/x4/x8 对应 1/2/3，设备不支持时回退为 0） | `FUN_14012ac60` |
| 0x1、0x4、0x8、0x1000 | 壁纸进程中恒置 | `FUN_140110630` |

补充：
- **显示器 HDR 会被自动摘掉**：DXGI 初始化时，若匹配到的输出色彩空间不是 G2084 / P2020（0xc），就清掉 0x4000（`FUN_14012ac60` 写 `param+0x15 = 0`；`FUN_140110630` 约 0x140110970 处清 `W+0x248` 的 0x4000）。
- **交换链格式由 0x2000 决定**：HDR 时 Format = 10（R16G16B16A16_FLOAT），否则 0x1c（R8G8B8A8_UNORM，不是 sRGB 格式）。这证实了第一轮 A4「HDR 时交换链为 FP16」的推断。
- **HDR 位每次加载才重算**：加载开始时先清 0x2000 / 0x4000 / 0x8000（`uVar1 & 0xffff1fff`）；这几位与上次不同时重建渲染器（`FUN_140113be0`）。
- 壁纸运行路径里没找到 0x1800000 的设置点，推断是编辑器专用（未知）。0xc000000 只在销毁资源期间短暂置位，与正常渲染无关。
- **置信度**：已确认。

### G3. 0x2000 / 0x40 是否还依赖场景设置
- **0x2000（HDR）**：
  - 三个条件必须同时满足：场景 JSON 的 `general.bloom` 是 bool true、`general.hdr` 是 bool true、postprocessing 为 ultra 或 displayhdr。任一键缺失或为 false 都不开 HDR。
  - 判定位置在 `FUN_14010df40`：先在场景 JSON 中查 `"bloom"`，再查 `"hdr"`（字符串 0x1404890e8），再比较 `"ultra"` / `"displayhdr"`。
  - 判定检查了 rapidjson 的 bool 标志（`+0xe & 8`），所以推断 `general.bloom` 写成用户属性对象（`{"user":…,"value":true}`）时也不会开 HDR。
  - 置信度：三个条件已确认；属性对象的情况为推断。
- **0x40（允许泛光）**：
  - 只看用户设置，与场景无关。
  - 真正画泛光还要每帧满足：`*R+0xe0` 的 0x2 位（场景 bloom 属性）为真，且场景对象非空（`FUN_14017fa70`，见 A1）。
  - 置信度：已确认。

### G4. general 缺 `bloom` / `hdr` / `clearenabled` 键时
- **结论**：
  - 保留构造默认值，不清零。默认标志为 0x26：bloom = 1、bit2 = 1、clearenabled = 1、hdr = 0。
  - 所以缺 `"bloom"` 键的场景仍会画 LDR 泛光（只要 postprocessing 不是 disabled），但不可能开 HDR，因为 HDR 判定要求显式写 true。
- **置信度**：已确认（有逐键 setter 证据）。通用加载函数是否遍历缺失键为推断，不影响结论。
- **证据**：
  - 场景构造兼解析函数 `FUN_140186c90` 开头先写 `param_1[0x1c] = 0x26`（即 `*R+0xe0`，指令在 0x140186d20），再写完所有泛光默认值，之后才读 JSON 的 `"general"`，调用通用属性加载 `FUN_1401730d0(ctx+0x1708, scene, general)`。
  - 三个 setter 只在值是 bool、或是带 bool `"value"` 的对象时才改位，其它情况一律不动：bloom `FUN_14019b4e0`（0x2）、hdr `FUN_14019b6f0`（0x400）、clearenabled `FUN_14019b920`（0x20）。
  - `FUN_1401730d0` 本身没有反编译。

### G5. HDR 合成前 `vfunc_0x158` 写进 RV0 的值
- **结论**：SDR 显示时 RV0 = (1.0, 1.0)，即 RV0.x = 1。只改 .xy，.zw 保留上一个泛光 pass 的值。
- **置信度**：已确认。第一轮 A3 / E 中这一项原为「未知」。
- **证据**：
  - 设备虚表在 0x140485b90（构造函数 `FUN_140098ea0` 里 `lea rax,[0x140485b90]`）。
  - +0x158 指向 0x14009b790：`mov r8,[rcx+0x70]; out[0] = [r8+0x40]; out[1] = [r8+0x44]; ret`。`device+0x70` 指向 DXGI 上下文 `W+0x1e8`，所以这两个值是 `W+0x228` / `W+0x22c`。
  - 渲染线程初始化时写 `*(W+0x228) = 0x3f8000003f800000`，即 (1.0, 1.0)。
- **只有输出处于 HDR10 色彩空间时才改写**（`FUN_14012ac60`，`IDXGIOutput6::GetDesc1` 的 ColorSpace == 0xc）：
  - 先算 `maxL = max(MaxLuminance, 80)`。
  - 再取白电平 `white`：用户配置的 SDR 白点（`W+0xa0`）；若小于 80，改用 Windows 的 SDR 白电平（`DisplayConfigGetDeviceInfo` type 0xb，取 `SDRWhiteLevel·80/1000`）；查询失败则用 200。
  - `white` 限制到 [80, maxL]。
  - 最后 RV0.x = white / 80，RV0.y = (maxL − white) / 80。这一步不看 postprocessing，只看输出是不是 HDR10。
- **对 Kabegame 的含义**：在 SDR 画布上，HDR + 泛光的收尾就是 `saturate(lin(scene + bloom))`，不额外乘系数。`lin()` 之后交换链按线性显示，所以在普通画布上等价于 `saturate(scene + bloom)`。

### G6. 第二轮关键函数索引

| 函数 / 地址 | 作用 |
|---|---|
| `FUN_14010df40` | 壁纸加载，置 HDR 位与 0x40 |
| `FUN_14010efb0` | 运行时应用设置，只更新 0x40、msaa、shadows、volumetrics |
| `FUN_140046f20` | 配置默认值填充 |
| `FUN_14010dad0` | shadows / volumetrics 档位枚举 |
| `FUN_140110630` | 渲染线程，拼出 `R+0x128`，处理显示器 HDR 回退 |
| `FUN_14017c6d0` | 把标志写进 `R+0x128` |
| `FUN_14012ac60` | DXGI 初始化（交换链格式、MSAA、HDR 白电平） |
| 0x14009b790 | 设备虚表 +0x158 |
| `FUN_140186c90` | 场景构造与解析 |

---

## H. 主会话独立核对记录（2026-11-01）

代理的结论没有直接采信。主会话用 scratchpad 里的只读脚本，对二进制副本（SHA-256 与安装目录原文件一致）和 WPE `assets/` 做了抽查：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 文件身份 | 副本与原文件 `certutil -hashfile` 对比 | 一致：`40e2ce02…5cd993b0` |
| 泛光默认值（A2） | 在场景构造函数范围内按 `disp32` 搜索 `41 C7 86 <disp> <imm>` | 0x3bc=2、0x3c0=0.65、0x3c4=2、0x3c8=1、0x3cc=0.1、0x3d0=1.619、0x3d4=8（int）、0x3d8..0x3e0=1,1,1。寄存器是 r14，报告写的 r15，不影响结论 |
| general 默认标志（A4 / G4） | 0x140186d20 字节 | `c7 86 e0 00 00 00 26 00 00 00`，即 `mov [rsi+0xe0], 0x26` |
| HDR 换算（A2） | 读 `FUN_140184020` 反编译；常量地址取值 | 公式与报告一致；0x140492704 = 1.0、0x1404925ec = 1e−5、0x14049268c = 0.25 |
| cbm 31（B7） | `FUN_140209160` 起始字节 | 首条为 `83 B9 2C 03 00 00 1F`（`cmp dword [rcx+0x32c], 0x1f`）；`FUN_140208670` 中 cbm==0x1f → blend = 2 |
| brightness 只在 HDR 下乘（B10） | 读 `FUN_140208670` 反编译 | `(ctx+0x118 & 0x2000) ? brightness : 1.0`，乘进 color.rgb |
| passthrough 条件（B8） | 读 `FUN_1401e6f50` 反编译 | cbm ∉ {0, 0x1f}、或图层 0x100、或渲染标志 0x1800000 → 置 0x10 |
| 合成着色器（A3） | 只读查看 `assets/shaders/combine_hdr.frag`、`hdr_downsample.frag`、`passthroughsrgb.frag`、`combine.frag` | 公式与报告一致；另有 `combine_hdr_upsample_linear.json`（LINEAR=1），报告没提到它的使用条件 |
| 设备虚表 +0x158（G5） | 0x140485b90+0x158 的指针及目标字节 | 指向 0x14009b790，字节 `4c 8b 41 70 41 8b 40 40 89 02 41 8b 40 44 89 42`，与报告一致 |
| RV0 初值 (1, 1)（G5） | 搜索 `mov r64, imm64 (1.0,1.0)` | 没有找到这样的立即数，可能是从常量区加载。未证伪，结论沿用代理的反编译 |
| 字符串 | 精确搜索 | `disabled`、`displayhdr`、`ultra`、`supportsvideo`、`combine_*`、`hdr_*`、`effectpassthrough(_4)`、`rgba_backbuffer`、`rgb_backbuffer`、`_rt_imageLayerComposite_` 均存在 |
| 样本的场景开关 | 只读 grep 两张样本的 `scene.json` | razer_bedroom 为 `"bloom" : true`、`"hdr" : true`；razer_vortex 为 `"bloom" : false` |
| 样本脚本（D10） | 只读扫描 `scene.json` 里的脚本导出 | vortex 的 3 处只导出 `applyUserProperties`；bedroom 的 6 处都导出 `update` |
| 用户 WPE 设置 | 只读 grep `wallpaper_engine/config.json` | `"postprocessing" : "disabled"`、`"msaa" : "none"` |

核对脚本：`C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\36cb4cb1-6cd2-47f4-827f-952bf91340b1\scratchpad\verify_rea.py`、`verify_defaults.py`、`verify_pp.py`、`verify_pp2.py`、`scripts_scan.py`（会话 scratchpad，不入库）。REA 快照：同目录 `p2-rea\db\wallpaper64-2.8.42.rea-snapshot`。

---

## I. 第三轮（2026-11-01）：剩余未解决项

约束与前两轮相同：只读静态分析 scratchpad 副本，不运行、不附加 WPE 进程，不写 Steam 目录和仓库。快照：`C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\36cb4cb1-6cd2-47f4-827f-952bf91340b1\scratchpad\p2-rea\db\wallpaper64-2.8.42-round3.rea-snapshot`。

**更正**：C 节把 ID 6 / 7 写成 g_TexelSize / g_TexelSizeHalf，写反了。正确的是 ID 6 = g_TexelSizeHalf，ID 7 = g_TexelSize（见 I4）。

### I1. passthrough 材质用 `effectpassthrough_4`（genericimage4）还是 `effectpassthrough`（genericimage3）
- **结论**：
  - 看场景 `scene.json` 顶层的 `"version"`：`version > 2` 用 `_4`，否则用 genericimage3；缺键时为 0。
  - 与 D3D feature level、着色器模型、画质设置都无关，所以 B8 里写的「设备能力等级」是误判。
- **置信度**：已确认。
- **地址**：
  - `FUN_1401ecae0` 调 `ctx+0x1510` 的虚表 +0x40；场景构造时 `ctx+0x1510 = scene+0x50`（`FUN_140186c90`），这个子接口的虚表在 0x14048ea08。
  - +0x40 = 0x1401853b0：`mov eax,[rcx+0x41c]; ret`，即 scene+0x46c。同一构造函数里 scene+0x46c = JSON `"version"`，默认 0。
- **两个着色器在 passthrough 下的差别**（只读对照 assets）：
  - passthrough 只开 `BLENDMODE` 和 `FOG_COMPUTED`，不开 `LIGHTING`。
  - 两者的 BLENDMODE 路径相同：`tex0·g_Color4`，按 `screenUV` 采样 `g_Texture4` 做 `ApplyBlending`，`a = screen.a`。
  - genericimage4 多一行 `#require LightingV1`，还多了 CLIPPING* combo；`PerformLighting_V1` 只在 `LIGHTING=1` 时编译。
  - 置信度：着色器对比已确认；`#require LightingV1` 在 LIGHTING=0 时没有副作用为推断。

### I2. 材质「需要帧缓冲」标志
- **`+0x1fc`**：在材质创建 `FUN_1401515b0` 里计算，不读材质 JSON 的任何键。
  - 逐个看着色器声明的纹理槽（着色器 +0x14 的槽表，以 0xff 结尾），取槽里的纹理名：材质 JSON `textures` 给的；没给就用着色器注解的 `default`（如 genericimage3 的 `g_Texture4` 为 `_rt_FullFrameBuffer`）；都没有为 `"error"`。
  - 拿这个名字查全局静态表 0x1404e7fa8（`FUN_140002170` 初始化），命中就把表项值 OR 进 `+0x1fc`。表项：`_rt_Reflection` → 1，**`_rt_FullFrameBuffer` → 2**，`_rt_MipMappedFrameBuffer` → 8。
  - 着色器能力位含 8 时，另置 0x10。
- **effect 层面**：加载时（`FUN_1401e7170`），只要某个 pass 的材质 `+0x1fc & 2`，就置 `effect+0x118 |= 2`，渲染时据此触发快照拷贝。
- **置信度**：已确认（`FUN_1401515b0`、`FUN_140002170`）。
- **`+0x1f8` bit2**：
  - 用途已确认：图像尺寸回调 `FUN_140209360` 里，autosize 且不是精灵表时，此位为 1 就用材质 `+0x2b0` / `+0x2b2`（ushort）作图层尺寸，否则用纹理的图像尺寸。passthrough / instanced 模型在此位为 1 时颜色强制为 (1,1,1,1)。
  - 置位点没找到：字节级搜不到 `or [..+0x1f8],4`。推断它表示「材质自带尺寸」。

### I3. FreeImage `.tex` 的尺寸与 `g_TextureNResolution`
- **TEXI 头**（`FUN_14015c760`）依次读 format、flags、textureWidth、textureHeight、（flags & 0x40 时多一个字段）、imageWidth、imageHeight、unk。
- **纹理对象布局**：从 +0x18 起按头的顺序排列，+0x20 / +0x24 = textureWidth / Height，+0x2c / +0x30 = imageWidth / Height，+0x1c = flags。置信度：推断（布局吻合，flags 位 1 / 4 的用法也吻合）。
- **FreeImage 型**（TEXB 的图像格式 ≠ −1）：
  - 解码前强制 `textureWidth/Height = imageWidth/Height`（`FUN_14015c8d0`：`hdr[2] = hdr[5]; hdr[3] = hdr[6]`）。
  - 所以头写 4096×4096、图像 3840×2160 时，两组尺寸都是 3840×2160，UV 缩放为 1。两组尺寸都取头字段，不取解码结果。
  - 置信度：强制赋值已确认；落到纹理对象哪个偏移为推断。
- **纹理 uniform**（写入函数 `FUN_1400d8300`）：
  - `g_TextureNResolution`（ID 0x3e+N）= (tex+0x20, tex+0x24, tex+0x2c, tex+0x30) = (纹理宽, 纹理高, 图像宽, 图像高)，以 float 写入；空槽为 (2,2,2,2)。置信度：已确认。
  - `g_TextureNTexel`（0x48+N）= (1/纹理宽, 1/纹理高, 纹理宽, 纹理高)，空槽为 (0.5,0.5,2,2)。
  - `g_TextureNMipMapInfo`（0x52+N）= max(0, tex+0xd0)，空槽为 1。
  - `g_TextureReductionScale`（0x5c）= ctx+0x1218。
- **精灵表单帧尺寸**：取 tex+0xb0 / +0xb4（flags 位 4 为 gif / 精灵表时）。推断来自 TEXS0003 帧表（`FUN_14015e1d0`），没有细看。

### I4. uniform ID → 数值（`FUN_1400d8300`）
`FUN_1400d8300` 是着色器 bind 函数 `FUN_1400d7440`（着色器程序虚表 0x140486ef8 的 +8）Map 常量缓冲后调用的写入函数。下表 ctx = R+0x10，除注明外均为已确认。

| uniform | ID | 取值 |
|---|---|---|
| g_Alpha | 0 | ctx+0x120 |
| g_Color | 1 | ctx+0x124..0x12c |
| g_Color4 | 2 | (ctx+0x124, +0x128, +0x12c, +0x120) = (r·k, g·k, b·k, alpha)，B10 的推断得到确认 |
| g_Time | 3 | ctx+0x130 = R+0x140：逐帧累加 dt 的 float，超过 432000 s 归零 |
| g_Frametime | 4 | ctx+0x14c = R+0x15c，本帧 dt |
| g_Daytime | 5 | ctx+0x140 = 本地时间 h/24 + m/1440 + s/86400 + ms/8.64e7，范围 [0,1)（渲染线程 `FUN_140110630` 里调 `GetLocalTime`） |
| g_TexelSizeHalf | 6 | 0.5 / (ctx+0x74, ctx+0x78) |
| g_TexelSize | 7 | 1 / (ctx+0x74, ctx+0x78) |
| g_Screen | 8 | (w, h, w/h)，w、h 同上 |
| g_EffectModelMatrix | 0x13 | ctx+0x970 |
| g_EffectModelViewProjectionMatrix | 0x14 | ctx+0x9b0；Inverse（0x15）对它求逆 |
| g_EffectTextureProjectionMatrix | 0x16 | ctx+0x9f0；Inverse（0x17）对它求逆 |
| g_LayerModelMatrix | 0x18 | ctx+0xa30 |
| g_EyePosition | 0x19 | ctx+0x68 |
| g_PointerPosition | 0x69 | ctx+0x8c = R+0x9c |
| g_PointerPositionLast | 0x68 | ctx+0x94，即上一帧的 PointerPosition（帧末 `R+0xa4 = R+0x9c`） |
| g_PointerState | 0x6a | (down, down, down && !wasDown, 0)，取自 ctx+0xa4 的 bit0 / bit1 |
| g_ParallaxPosition | 0x6b | ctx+0x9c = R+0xac，每帧由视差逻辑写入（细节没看） |
| g_RenderVar0 | 0x6c | ctx+0xa8 = R+0xb8，A2 的推断得到确认；RV1–RV4 = ctx+0xb8 / +0xc8 / +0xd8 / +0xe8 |
| g_HDRParams | 0x8b | 设备虚表 +0x158，与 RV0 同源，SDR 时为 (1, 1) |

补充：
- **屏幕尺寸**：ctx+0x74 / 0x78 = R+0x84 / 0x88，在 resize 时设为窗口（后备缓冲）客户区尺寸。绑定 RT 只设设备视口（`FUN_1400d3920` → 设备 +0x88），不改这两个值。所以 g_TexelSize、g_TexelSizeHalf、g_Screen 在合成 RT、fbo、泛光 pass 里始终是全屏尺寸。没发现别的改写点，这一点为推断；它与 LDR 泛光着色器里 `g_TexelSize*8` 的写法一致。
- **g_PointerPosition**：`ScreenToClient(光标) / (R+0x84, R+0x88)`，即窗口归一化坐标，原点在左上、y 向下。
- **效果矩阵**（`FUN_1401ebf60`，只在 pass 标志 bit0 置位时写；该位来自着色器能力 & 4；w、h 取图层 size layer+0x2f0）：
  - 效果 pass（非 final）：0x970 = 图层世界矩阵 × scale(w/2, h/2)；0x9b0 = 图层开始时快照的 MVP（ctx+0x8f0）× 同一缩放；0x9f0 = 0x9b0 的拷贝。
  - final 上屏 pass：0x970 = 世界矩阵，0x9b0 = MVP，都不缩放；0x9f0 = MVP × scale(w/2, h/2)。
  - 置信度：写入逻辑已确认；各量的语义命名为推断。

### I5. effect 可见性切换后是否重算；fbo `fit` 算法
- **会重算**：
  - `FUN_1401e6300(effect)` 重新统计：合成次数 = Σ(启用效果的 compose 数 + 1)，pass 数 = Σ(启用效果的 pass 数)。
  - 只要与 layer+0x320 / +0x324 不同，就写回并调用图层虚函数 +0x110（`FUN_1402065e0`），依次重算尺寸（`FUN_140209360`）、+0xb0 几何、+0xb8 合成 RT（`FUN_1401ea500`）、+0xc0 passthrough 材质。
  - 「最后一个启用 effect」每帧在渲染循环里按计数判定，所以重算计数即可。
  - 差异：加载时的累加多一个条件 `!(图层+0x304 bit13)`，运行时重算没有。
  - 置信度：已确认；是谁调用 `FUN_1401e6300`（推断是 visible 属性回调）没追。
- **fit 算法**（`FUN_1401ea500`）：
  1. W' = fbo.width（≤4096 时），否则取图层合成宽；H' 同理取 height。
  2. fit ≤ 4096 时：W' < H' 则 h = min(fit, H')、w = (W'/H')·h；否则 w = min(fit, W')、h = (H'/W')·w。
  3. 截断成 uint，除以 scale，每一维至少取 2。
  4. width / height / fit 缺省都是 0xffff，即不生效。
  - 置信度：已确认。

### I6. 余项
- **`combine_hdr_upsample_linear.json`（LINEAR=1）**：wallpaper64 里没有这个字符串，`_editor` / `_dbg` / `debugrt` 变体也没有。运行时不用，推断是编辑器或工具专用。置信度：「wallpaper64 未引用」已确认。
- **`solid`（对象 +0x120 bit13）**：渲染侧没找到读取点（字节级 test / bt 搜索为空），仍推断只与交互 / 命中检测有关。置信度：推断。
- **0x1800000 由谁设置**：wallpaper64 里对 R+0x128 / W+0x248 的立即数 or 只有 0x40、0x2000、0x6000、0x8000、0x800、0x4000000 / 0xc000000，最后两个只出现在销毁路径，没有 0x1800000。推断属于其它宿主（编辑器 / 预览），或根本没用。置信度：未知。

### I7. 第三轮关键函数索引

| 函数 / 地址 | 作用 |
|---|---|
| `FUN_1401ecae0` | passthrough 材质版本选择 |
| 0x1401853b0 | 场景 version getter |
| `FUN_1401515b0` | 材质创建，计算 `+0x1fc` |
| `FUN_140002170` | 特殊 RT 名 → 标志表初始化 |
| `FUN_1401577e0` | 材质 pass 属性表（blending、alphawriting、depthtest、depthwrite、cullmode） |
| `FUN_14015e580` | `.tex` 加载入口 |
| `FUN_14015c760` | TEXI 头解析 |
| `FUN_14015c8d0` | TEXB 解析，含 FreeImage 尺寸覆盖 |
| `FUN_140209360` | 图层尺寸 / UV 回调 |
| `FUN_1400d8300` | uniform 写入 switch |
| `FUN_1400d7440` | 着色器 bind |
| `FUN_1400f5cb0` | 着色器编译与 cbuffer 分组 |
| `FUN_1401e6300` | 效果可见性重算 |
| `FUN_1402065e0` | 图层重建 |
| `FUN_1401ea500` | 合成 RT 分配与 fit 算法 |

### I8. 主会话核对（第三轮）

| 核对项 | 方法 | 结果 |
|---|---|---|
| version getter（I1） | 0x1401853b0 字节 | `8b 81 1c 04 00 00 c3`，即 `mov eax,[rcx+0x41c]; ret`，一致 |
| 场景 `version` 分布（I1） | 只读脚本：默认工程直接读 `scene.json`；工坊按 PKGV 目录表从 `scene.pkg` 读出 `scene.json` | 默认工程：缺键 9 张、0 两张（dino_run、shimmering_particles）、1 一张（razer_bedroom）→ 全部走 genericimage3。工坊 13 张：1 两张（2932157836、3146703458），3 四张，4 三张，5 四张 → 11 张走 genericimage4 |

核对脚本：`C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\36cb4cb1-6cd2-47f4-827f-952bf91340b1\scratchpad\verify_r3.py`。I2 的静态表与 I3 的强制赋值没做字节级复核（需要反汇编上下文），沿用代理的反编译结论。

---

## J. 动态核对（2026-11-01）：RenderDoc 抓帧与 WPE 实拍对照

约定按 PLAN D12 修订后，开始用 WPE 的实际运行结果核对逆向结论。工具：RenderDoc 1.47 + 本地补丁版 RenderDocMCP（`ignore/RenderDocMCP`，经仓库 `.mcp.json` 的 `renderdoc` 接入）。

### J1. razer_vortex 一帧（后处理 disabled）

抓帧：`C:\Users\Lenovo\AppData\Local\Temp\RenderDoc\wallpaper64_2026.11.01_11.57.59_frame2331.rdc`（D3D11，10 个 action：2 次清屏、7 次 draw、1 次 present）。

| event | 输出 | 内容 |
|---|---|---|
| 2 / 3 | 背景缓冲 `37077` / 深度 `37097` | 清屏 |
| 20 | `37128`，3840×2160 RGBA8 | vortex 基础 pass（采样 3840×2160、7 级 mip 的底图） |
| 40 | 背景缓冲 | vortex 的 rz effect 上屏 |
| 58 | `37141`，**219×216** RGBA8 | THS 基础 pass |
| 78 | 背景缓冲 | THS 的 rz effect 上屏 |
| 96 | `37157`，64×32 RGBA8 | led 基础 pass |
| 116 | `37154`，64×32 RGBA8 | led 的 rz effect（**不上屏**，画进第二张合成 RT） |
| 136 | 背景缓冲 | led 的 passthrough 上屏（像素着色器带 `g_Color4`，顶点着色器带 `g_ModelMatrix` / `g_EyePosition`，即 genericimage3 + `FOG_COMPUTED`） |

结论：
- **B5 证实**：合成 RT 按图像尺寸分配。THS 纹理是 256² 补齐，合成 RT 是 219×216；vortex 是 3840×2160。
- **A3 证实**：LDR 且没有泛光时，场景直接画进背景缓冲，没有整帧拷贝、没有 combine。
- **B7 证实**：普通图层只有 effect 的最后一个绘制 pass 上屏（40、78）。
- **新发现**：led 层 colorBlendMode 为 0，却走了 passthrough（116 画进第二张合成 RT，136 上屏）。B8 的 passthrough 条件里只有「图层标志 0x100」能解释（渲染标志 0x1800000 会作用于所有图层，而 vortex、THS 没走），led 层独有的属性是 `ledsource`，推断 0x100 即 `ledsource`（未坐实）。这层在屏幕外，对画面无影响；Kabegame 目前按普通图层处理，见 PLAN P2a「遗留」。
- GPU 耗时：整帧约 1.23 ms，vortex 的两个 4K pass 各约 0.46 / 0.52 ms。

### J2. 与 WPE 实拍视频对照（P2a 验收 D7）

材料：用户录的 WPE 桌面视频（3840×2160、50 fps、5.24 s，属性亮度 1、速度 0.3、长度 1、模式 Radial，即默认值）。视频除开头几帧外画面静止，只能比静帧。

方法：vortex 的颜色按 `g_Time` 循环（scroll = speed² × t = 0.09 t，周期约 11.1 s），两边时钟起点不同。在主窗口临时画布里暂停时钟、把场景时间设为 0–11.2 s（步长 0.2 s）逐帧渲染并同步读回，与视频静帧找最接近的时刻：
- 480×270 缩略图上，最接近的时刻 t ≈ 4.9 s 平均每像素差 3.5（满分 255），相位对不上时约 11。
- 在 t = 4.9 s 渲染 1920×1080 全帧对比（去掉任务栏）：平均每像素差 **1.76**，95% 的像素差 ≤ 6。

| 中心 300×300 区域 | WPE | Kabegame（t=4.9 s） |
|---|---|---|
| 平均色 BGR | 93.2 / 40.1 / 9.4 | 93.9 / 41.1 / 9.5 |
| 最高亮度 | 136 | 132 |
| 亮度 > 60 的外框 | 297×277 | 297×277 |

结论：构图、图标尺寸、颜色一致，差异在视频压缩与缩放误差量级。此前看到的「WPE 图标更亮更青」是两边时间相位不同所致。

另记：P2a 代理报告里的 `p2a_vortex_desktop_3840_a/b.png` 实为全透明空图（四通道均值 0），不能用于对照；读回 WebGPU 画布要在 `render()` 之后同一任务内同步 `drawImage`。

### J3. 逐帧精确对照（RenderDoc `g_Time` 注入，2026-11-01）

J2 受视频压缩与相位扫描步长（0.2 s）限制。用户用 RenderDoc 抓了 4 帧 wallpaper64（frame 49 / 65 / 84 / 104），从每帧 vortex 效果 pass 的常量缓冲里读出精确 `g_Time`，把 Kabegame 渲染器的时钟钉到同一时刻、同 3840×2160 渲染，逐像素比最终画面（WPE 侧取 Present 前的后备缓冲，存 PNG）：

| 帧 | `g_Time`（s） | 平均差 /255 | p99 | 差 >16 像素占比 | 最大差 |
|---|---|---|---|---|---|
| 49 | 4.992828 | 0.273 | 3 | 0.037% | 44 |
| 65 | 6.838074 | 0.277 | 3 | 0.036% | 43 |
| 84 | 8.610946 | 0.282 | 3 | 0.043% | 43 |
| 104 | 10.611182 | 0.287 | 3 | 0.040% | 43 |

整图平均色三通道差 ≤ 0.05。亚像素对齐核对：在色带不照到的暗像素上对合成 RT 做 ±1px、0.25px 步长的平移搜索，WPE 与 Kabegame 的最佳偏移都是 (0, 0)。

**残余差异的归因**：差异集中在色带照亮的方块棱边与标志轮廓（光照 mask `comp.g` 的陡边）。把输出按 `out = base + wave·g·brightness` 分解，差异处是 WPE 的光照项局部偏高（如某棱边像素 WPE 等效 wave.r≈1.49 > 1），而非底图或对齐问题——这是 D3D11 对 `wave`（64×8、无 mip、Wrap + **8x 各向异性**）在 `frac()` 接缝、UV 导数不连续处的各向异性采样行为；WebGPU 的各向异性要求三种过滤全为 linear（无 mip 纹理给不出），复刻不了。量级 0.04% 像素 >16/255，肉眼不可见，不再追。

**采样器真值**（修复 MCP 扩展采样器读取后；RenderDoc 1.32+ 的采样器状态在 `UsedDescriptor.sampler`，旧代码读 `.descriptor` 拿到空对象）：
- 静态纹理（vortex 7 mip、THS / wave 无 mip）：**一律 Anisotropic 8x**，寻址按 `clampuvs`（vortex / THS 为 Clamp、wave 为 Wrap），LOD 全开。
- 上屏 pass 采样合成 RT：Linear / Linear / Linear、Clamp、无各向异性。
- 对照实验：把 Kabegame 静态纹理采样器临时改成「线性即 8x 各向异性」，四项统计完全不变——放大为主的本场景里各向异性没有可测影响，P2a 维持现状（有完整 mip 链时已用 8x）。

其余与 J1 一致：uniform（速度 0.3、亮度 1、长度 1、模式 0、`g_Texture0Resolution` 取图像尺寸）、混合（基础 pass 不混合写四通道、上屏借基础材质 blend 且 write_mask=7）逐项吻合。D7 验收通过。

### J4. 更正（2026-11-01）：快照用 `ResolveSubresource` 与 MSAA 无关

B8 / A3 写的「源为 MSAA 时 `ResolveSubresource`，否则 `CopyResource`」与抓帧不符。`A:\bedroom\{disabled,enabled,highres}\` 三档抓帧（WPE MSAA 关闭，后备缓冲 3840×2160 R8G8B8A8_UNORM、`msaa_samples` = 1）里，6 个混合模式图层（cbm 11 ×5、12 ×1）上屏前的整帧快照全是 `ResolveSubresource`（disabled 帧 event 174 / 404 / 466 / 528 / 590 / 690）。对 Kabegame 没有影响（一律 `copyTextureToTexture`），只是不能再据此推断开了 MSAA。

### J5. P2b 规格的抓帧核对（2026-11-01，bedroom 三档）

抓帧：`A:\bedroom\enabled\enabled-frame22.rdc`（后处理「开启」）、`A:\bedroom\highres\highres-frame1452.rdc`（「超高」）。

**开启档（LDR 泛光）**，场景画完后：

| event | 动作 | 目标 | 要点 |
|---|---|---|---|
| 772 | `ResolveSubresource` | `3875`，3840×2160 RGBA8 | 整帧快照 |
| 786 | `downsample_quarter_bloom` | 960×540 RGBA8 | 4 tap 平均 → `saturate(max(rgb) − threshold)·rgb` → `2·c − luma`（加饱和）→ `× strength × tint`，a = 1；常量取场景原值 strength 1、threshold 1、tint (1,1,1) |
| 799 | `downsample_eighth_blur_v` | 480×270 RGBA8 | |
| 812 | `blur_h_bloom` | 480×270 RGBA8（`_rt_Bloom`） | |
| 826 | `combine_ldr` | 后备缓冲 | `scene + bloom`，只写 RGB |

- 全部线性过滤、Clamp、不混合、write mask = RGB。链路与 A1 一致。
- **bedroom 的 LDR 泛光全黑**（960×540 与 `_rt_Bloom` 的 min / max 都是 0）：`bloomthreshold` = 1.0，LDR 值不超过 1，`max − 1` 恒为 0。所以 bedroom 的「开启」档与「关闭」档画面相同，验证不了 LDR 泛光。

**超高档（HDR）**：后备缓冲本身是 **R16G16B16A16_FLOAT**，场景直接画进它；合成 RT 也是 RGBA16F（如 wave 层 128×8）。

- **brightness**：wave 层基础 pass 的 `g_Color4` = (3, 3, 3, 1)，与 `brightness` 3 一致（B10 证实）。场景快照最大值 (4, 16, 8.8)。
- 772 快照到 `3515`（RGBA16F）后：
  - 788 `hdr_downsample_bloom` → 1920×1080：`g_BloomStrength` = 0.131058、`g_BloomBlendParams` = (1, 0.9, 0.2, 2.49975)、tint (1,1,1)、`g_RenderVar0` = (1/3840, 1/2160, −, −)。与 A2 公式（scatter 1.62、N = 8）逐位一致。
  - 803–893：再 7 次下采样，共 8 级（L7 = 15×8）。
  - 910–1006：7 次上采样。混合 **SrcAlpha / One**（着色器 a = 1，即加法），只写 RGB，`g_BloomScatter` = 1.62。910 读 L7（15×8）写 L6（30×16），用 bicubic。
  - `g_RenderVar0` 用**名义尺寸**：910 为 (128/3840, 128/2160)，不是按实际 RT 30×16 算的 1/30、1/16。RT 尺寸向下取整（2160/256 → 8），纹素偏移不随取整变。
  - 1025 `combine_hdr_upsample` → 后备缓冲：`out = saturate(lin(scene + 0.25·Σ4 tap bloom)) · RV0.x`，RV0 = (1, 1, 上一步的 zw)，`g_TexelSize` = (1/3840, 1/2160)，只写 RGB。L0 泛光最大值 (1.47, 3.89, 2.30)。
- 结论：A1–A3、B10、G5 的 HDR 部分全部证实；新增「RV0 用名义尺寸」「上采样混合 SrcAlpha/One」两条实现细节。

**本机样本的泛光参数**（只读扫描，工坊已有 22 张）：
- LDR 泛光看得见（threshold < 1）：neon_sunset（0.36 / 0.5）、shimmering_particles（0.36，strength 绑脚本，脚本只有 `applyUserProperties`）、工坊 3409595232（0.0 / 0.16，`bloom` 绑属性）、3445915391（0.79，tint 暗红，`bloom` 绑属性）、3286859278；3D 的 arsenal / demon_core / dna_fragment 用默认值 0.65。
- 实际会走 HDR（`bloom`、`hdr` 都是 bool true）：只有 razer_bedroom 与 shimmering_particles（scatter 1.13、**feather 0**、threshold 0.7、`bloomhdrstrength` 绑属性 glow）。
- 3286859278：`hdr: true`，但 `bloom` 写成属性对象 `{user: "postprocessing", value: true}`。按 G3 推断它在超高档也不走 HDR，可以用抓帧（后备缓冲格式）坐实。

**更正 G3（`A:\32868-ghost-rider\highres\highres-frame137.rdc`，工坊 3286859278，超高档）**：
该场景 `general.bloom` = `{user: "postprocessing", value: true}`、`hdr: true`。抓帧里后备缓冲 `5352` 为 RGBA16F，event 2437 是 `combine_hdr_upsample`（读 3840×2160 RGBA16F 快照与 1920×1080 RGBA16F L0），说明 WPE 照样走 HDR。
G3「`general.bloom` 写成属性对象时不开 HDR」的推断不成立：HDR 判定也接受属性对象，取它的生效值。属性在默认值，这张抓帧区分不了取 JSON 的 `value` 还是用户当前值。
