> 逆向原始记录，代理写的，接着 [rea-p11-textures.md](rea-p11-textures.md)（下称「上一轮」）查，命名与地址沿用。地址按 Ghidra：`wallpaper64.exe`、`wallpaperui.exe` 基址都是 `0x140000000`，`resourceutil64.dll`、`FreeImage64.dll` 基址 `0x180000000`。只读码，没有实测。实测（M1–M7）由主会话做，冲突时以实测为准。

# WPE 2.8.42 P11b 用户纹理补充静态逆向（R1–R7）

**概括**
- **R1 文件选择**：`selectFileForProperty(type, fileType)` 的处理在 `wallpaperui!FUN_140023650`（`0x140024017` 起）。`type == "scenetexture"` 时对话框类型固定为 `0x12`，`fileType` 被覆盖、不起作用。类型 `0x12` 只给一条过滤 `Textures` = `*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`（VA `0x140ad2b20`，即文件偏移 `0xad1920` 那条），缺省扩展名 `jpg`。`file` 类型则看 `fileType`：`"video"` → `Videos`（`*.webm;*.ogg;*.ogv`），否则 `Images`（`*.jpg;*.jpeg;*.jfif;*.png;*.pnga;*.bmp;*.gif;*.svg;*.webp`）。带 `*.tga`、`*.psd`、`*.dds` 的那几条属于编辑器的纹理导入（类型 8、9），与属性无关。选完返回 `IShellItem` 的 `SIGDN_FILESYSPATH`（绝对路径），转 UTF-8，`\` 全换成 `/`、连续的 `/` 合并成一个，作为 JS 字符串交给回调。不拷贝文件，也不做别的处理。【确：对话框参数、返回值的构造；JS 侧把它原样写进属性值【推】】
- **R2 GIF**：GIF 不走 FreeImage，`OpenGIF` / `AdvanceGIF`（`resourceutil64`）是 **stb_image 派生的 GIF 解码器**（`stbi__gif_load_next` 改过）。要点：
  - 推进只发生在**某次绘制绑定这张纹理时**，每个渲染帧最多一次（按帧号 `ctx+0x144` 去重）；时间用当帧的 `g_Frametime`（`ctx+0x14c`，已含场景 rate、暂停淡变，钳在 [0.0001, 0.25]）。图层不可见、没画到、WPE 暂停时都不推进，也不补时间。【确】
  - 每帧剩余时间减 dt，减到 ≤ 0 才解下一帧，并把下一帧的延时**加到**剩余时间上（带上超出的部分）；一次最多前进一帧。延时 = GIF 的 `10 × delay`（毫秒），**不设下限**，延时 0 的帧每个渲染帧换一次。【确】
  - **无限循环**，不看 NETSCAPE 的循环次数；读到结束符就把读指针拨回开头，重新解析文件头、把画布清成全透明，再解第 0 帧。【确】
  - 合成由解码器自己做：画布是逻辑屏幕尺寸的 RGBA；调色板 alpha ≤ 128 的像素不写；disposal 2 / 3 只作用于上一帧写过的像素。stb 原有的「背景色按 BGRA 拷进 RGBA 画布」照旧，所以用到背景色的地方 R、B 互换（第 2.3 节）。【确】
  - 纹理是裁后的 `w' × h'`（纹理尺寸 = 图像尺寸）、`DYNAMIC`、1 级 mip、`R8G8B8A8_UNORM`，并且**强制点采样**（标志 `|= 1`）。源矩形的偏移在建纹理时按第 0 帧的画布尺寸算一次，每帧按行拷贝。【确】
- **R3 视频**：`+0x130` 建的播放器就是 P9a 的播放器 P（`FUN_1400c7140`，虚表 `0x1404871b8`），初始化、取帧、可见性、暂停的代码路径全部相同。所以 P9a 的规则都适用：循环、`FORCEMUTE` 不出声、自己的时钟、建好纹理就从 0 播放、连续 30 个渲染帧没画到就暂停、WPE 暂停时全部暂停。区别只有这几处：
  - 打开整个文件，不是 `.tex` 里的一段；
  - 纹理按**裁后的尺寸**建；
  - 裁切写进 `TransferVideoFrame` 的**归一化源矩形**（`P+0xb8..+0xc4`），几何的 UV 不变，着色器看到的 `g_Texture<n>Resolution` 就是裁后的 `(w', h', w', h')`；
  - PQ / HLG 视频在渲染标志 `0x10000`（视频 HDR）下用 `R16G16B16A16_FLOAT`；
  - **探测或初始化失败时退回缺省纹理**：64×64 的纹理照建，但失败位没清，随即被丢掉。上一轮写的「64×64 黑占位、清掉失败位」不对。
  - 换值后，旧纹理在同一次材质刷新的末尾由回收函数 `FUN_1401511b0` 删掉，析构时删播放器（`FUN_1400ec060`）；别的材质还在用它就不删。

  【确】
- **R4 槽 0 换图后**：材质刷新把新的槽 0 纹理交给图层的就绪回调 `FUN_140209360`。它按新纹理重算图层尺寸，重建三个四边形（UV 范围与内缩），再调 `FUN_1401ea500` 释放并重建合成 RT 与 effect fbo。逐项结论：
  - `autosize` 的尺寸取参考尺寸，照常换图前后不变；`keepaspect` 或 `usertexturereference` 与缺省图像尺寸不同时会变。
  - UV 上界 = 新纹理的图像尺寸 / 纹理尺寸。用户纹理两者相等，所以是 1。
  - 内缩 = 0.15 / 新纹理尺寸。
  - 合成 RT 按新纹理的图像尺寸重建，instanced 也一样。
  - `fullscreen` 的尺寸取新纹理的图像尺寸。
  - `g_Color4` 与 `g_Alpha` 强制为 1：**每次绘制现读**材质位 `+0x1f8` bit2，条件是图层有 `passthrough` 或 `instanced`，而且这个材质有任一槽的用户纹理生效。
  - `FUN_1401556e0` 开头清 bit2、成功才置位，所以退回缺省后恢复对象色和对象 alpha。

  【确】
- **R5 缺省是 RT 名的槽**：`FUN_14014d500` 依次查三处：自己的信息缓存、纹理表、`materials/<名>.tex` 文件头，都查不到就返回 false，这个槽用缺省纹理。名字只把 `\` 换成 `/`、合并重复的 `/`，大小写不变。`_rt_imageLayerComposite_<id>_a` 在纹理表里有同名对象：引用方材质加载时建的 6×6 占位，加载末尾被 RT 接管，头里的尺寸随之改成 RT 的。所以：
  - **加载时值为空、运行中再选图**（常见情形）：查到的参考尺寸 = 那张 RT 的尺寸，用户图按 RT 的比例裁，**替换掉 RT** 绑在这个槽上；
  - **加载时值就非空**：如果这个材质是第一个引用这个名字的，表里还没有占位 → false → 用缺省纹理（加载后接管成 RT）。用户图在加载时不生效，直到值再变一次。
  - 查到的信息会进缓存，缓存只由这一个函数写、没找到失效点。所以第一次查到的是 6×6 占位（RT 还没建）时，此后一直按 1:1 裁。
  - 回缺省时 `load(name, 1)` 返回表里的同名对象：被依赖时就是 RT 本身，否则是 6×6 黄黑棋盘格。

  【确：查找顺序、缓存写入点、名字规范化；「加载期是否第一个引用」随加载顺序而定【推】】
- **R6 粒子精灵表**：系统的 `0x1000000` 只在粒子系统加载时按材质槽 0 纹理的标志 bit2 定一次（`0x1401d04a5`）。粒子没有登记槽 0 就绪回调，材质刷新不会通知粒子系统。由此：
  - 着色器变体（`SPRITESHEET` 等宏）与 frame 列的推进都按**加载时**的槽 0 定；
  - `g_RenderVar1` 每次绘制按**当前**槽 0 纹理的帧表写，用户纹理没有帧表，这一次就不写，沿用 `ctx+0xb8..0xc4` 里上一次留下的值。

  所以加载时是精灵表、运行中换成用户图：用户图被当成精灵表按旧的 RV1 取格子。加载时就是用户图：没有 `0x1000000`，每个粒子画整张；再换回缺省的精灵表也画整张。【确：代码；画面后果【推】】
- **R7 解码**：
  - `FUN_180009c40`：`FreeImage_GetFileTypeU(path, 0)` 只按内容识别，认不出就失败，不按扩展名回退；`FreeImage_LoadU(fif, path, 10)` → `ConvertTo32Bits`（失败时先 `ConvertToStandardType(dib, TRUE)` 再转）→ `FlipVertical` → 拷出 → `FUN_1800049e0` **只交换 R、B**。【确】
  - 标志 10 = `JPEG_ACCURATE | JPEG_EXIFROTATE`，**不含 `PNG_IGNOREGAMMA`**。FreeImage 版本 **3.18.0**（版本资源 `3, 18, 0, 0`，内含 libpng 1.6.35）。【确】
  - **PNG 的 `gAMA` 会被校正**：`png_set_gamma(2.2, 文件 gamma)`，`gAMA ≈ 1/2.2` 时不变，其它值（如 1.0）改写颜色。计划里「不做色彩处理」对 PNG 不成立。【确】
  - ICC（PNG `iCCP`、JPEG）只存不用，库里没有色彩管理引擎。【确，有界】
  - 16 位 RGB / RGBA **取高字节**；**16 位灰度（无 `tRNS`）按 `[min(255, 最小值), 最大值]` 线性拉伸到 0–255**；16 位灰度带 `tRNS`、灰度加 alpha 先转 RGBA（16 位再取高字节）；调色板与 ≤ 8 位灰度的 `tRNS` 变成透明表，alpha 按表取。【确】
  - wallpaper64 侧没有尺寸上限、不缩小；超过 D3D11 纹理上限时建纹理失败 → 缺省纹理【推】。
- **顺带**：
  - 纹理名 = `值 + "x" + (int)roundf(W/H · 10)`（`"x"` 在 `0x140473c0c`）【确】。比例四舍五入到 0.1 相同的槽**共用一张**纹理，按先建它的那个槽的精确比例裁。
  - `keepaspect` 字符串全文件只有 `0x140154871` 一处引用，在 `usertextures` 项对象里。pass 级的 `keepaspect` 键不读【确，有界：字符串引用】。
  - 扩展名先 `tolower` 再比较（`FUN_1400eaf10`），`.GIF`、`.MP4` 同样认。上一轮写「大小写敏感」不对。【确】

**元数据**
- 目标与 SHA-256：
  - `wallpaper64.exe` 2.8.42：`40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，同上一轮；
  - `wallpaperui.exe` 2.8.0.42：`dab38bfc017dd5fd4947a09706d23f27833870d1bbb87485677a3e67d1d55791`，副本与 Steam 原件一致；
  - `resourceutil64.dll`：`153cb1e273984b5c7a77b10d62089d50fcde3e187787d839918b59a81c8bfc24`；
  - `FreeImage64.dll` 3.18.0：`8ad1c4f80f343c18603afb12029048d2604d42466f4fdfdb5c61d92d40fef3e8`。
- 只读副本在 `ignore/p11/rea/tex/bin/`。本轮新拷的是 `wallpaperui.exe`、`FreeImage64.dll`，没动 WPE 安装目录；`config.json` 只读搜了一次，没有找到已存的图片路径。
- 方法：
  - REA 连不上，用本机 Ghidra 12.1.4 无界面模式。
  - 沿用 `gh/proj`、`gh/projr`，新建 `gh/projui`（wallpaperui，首次分析约 15 分钟）与 `gh/projfi`（FreeImage64）。
  - 脚本沿用 `gh/scripts/DecompList.java`、`XrefDecomp.java`；关键段用 `ignore/p4/rea/wp.asm` 切片（`tex/slice.py`、`tex/xr.py`）核对。
- 工作文件 `ignore/p11/rea/p11b/`：
  - `dec.sh` 调 Ghidra 的包装；
  - `tbl.py` 打印指针表；`ver.py` 读版本资源；`guid.py` 读 GUID；
  - 反编译输出：`d1`–`d8` 是 wallpaper64 与 resourceutil64，`u1`–`u4` 是 wallpaperui，`fi1`–`fi6` 是 FreeImage64。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到；【确，有界】在注明的范围里搜过。

---

## 1. R1：`selectFileForProperty`（`wallpaperui.exe`）

### 1.1 调用链【确】
- `FUN_140023650` 是 JS 绑定的分派函数，`0x140024017` 比较方法名 `"selectFileForProperty"`。参数 0 是属性类型 `type`，参数 1 是 `fileType`。
- 定对话框类型（反编译 `u1/f_140023650.c` 第 2703–2721 行）：
```
k = (fileType == "video")               // DAT_140ab3bdc = "video"
k = (type == "directory") ? 7 : (k | 0x10)   // 0x10 Images / 0x11 Videos
if type == "scenetexture":     k = 0x12      // 覆盖，fileType 不起作用
if type == "usershortcutfile": k = 0x13
FUN_140146990(hwnd, &results, k, 多选 = 0)
```
- 对话框 `FUN_140146990`：`CoCreateInstance(FileOpenDialog)`。
  - 选项在 `GetOptions` 的基础上加 `FOS_FORCEFILESYSTEM`（0x40）；`k == 0x13` 再加 `FOS_NODEREFERENCELINKS`。
  - `SetFileTypes(1, &spec)`，`spec` 是 `0x140ba0bb0`：`{L"Textures", L"*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4"}`，只有这一条，没有「所有文件」。
  - `SetDefaultExtension(L"jpg")`，跳转表 `0x140147eec` 第 0x11 项。
  - 初始文件夹：先用这一类型记住的文件夹（`0x140ba0bd0 + k·0x20`，用一次就清掉）；没有就用 `FOLDERID_Desktop`（`0x140aecd08`）。
  - `SetClientGuid` 用进程启动后随机生成的 GUID，所以「上次的文件夹」只在本次运行里记住。

### 1.2 过滤表（`0x140ba0980`–`0x140ba0bc8`，`COMDLG_FILTERSPEC` 成对）【确】

| 类型 k | 名字 | 过滤 | 用途（按调用方） |
|---|---|---|---|
| 8 | Textures | `*.png;*.tga;*.jpg;*.jpeg;*.jfif;*.bmp;*.psd;*.ico;*.gif;*.dds;*.tif;*.tiff`（`FUN_140069390(10,0,0)` 为真时多 `;*.mp4`） | 编辑器导入纹理 |
| 9 | Textures | 同上去掉 `*.gif` | 编辑器 |
| 10 | Animated Textures | `*.gif` | 编辑器 |
| 0x10 | Images | `*.jpg;*.jpeg;*.jfif;*.png;*.pnga;*.bmp;*.gif;*.svg;*.webp` | 属性 `file`，`fileType` ≠ `video` |
| 0x11 | Videos | `*.webm;*.ogg;*.ogv` | 属性 `file`，`fileType` = `video` |
| **0x12** | **Textures** | **`*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`** | **属性 `scenetexture`** |
| 0x13 | （无过滤） | — | `usershortcutfile` |
| 7 | 选文件夹 | — | `directory` |

- 过滤只限制列表里显示哪些文件。用户在文件名框里直接输入别的文件，对话框照样返回【推：`IFileDialog` 的标准行为，代码里没有再校验扩展名】。所以 `scenetexture` 的值可能是 wallpaper64 能解码的任何格式（上一轮 2.3 节：视频扩展名、`.gif`、其它交给 FreeImage 按内容识别）。

### 1.3 返回值【确】
- `GetResults` → 逐项 `GetDisplayName(SIGDN_FILESYSPATH)`，得到绝对路径的宽字符串，存进结果数组。没有任何拷贝、移动或建缓存的调用。
- 回调（`u1/f_140023650.c` 第 2733–2752 行）：取第一个结果 → `WideCharToMultiByte(CP_UTF8)`（`FUN_14000c210`）→ `FUN_14000c3f0(s, '/')`：把 `\` 全换成 `/`，再把非开头的连续 `/` 合并（开头的 `//` 保留，UNC 路径不受影响）→ 两边加 `"` → `FUN_1400ff9a0(…, "%s", 串)` 交给 JS。对话框返回失败（取消）时改调 `FUN_1400ff670`（没读，推测是拒绝 / 取消回调）。成功但结果为空时传 `""`。
- 例：`D:\Pics\a.png` → JS 收到字符串 `D:/Pics/a.png`。属性值存的就是它【推：JS 侧没读，wallpaper64 的 `exists` 与读文件都接受 `/` 分隔的绝对路径】。
- `usershortcutfile` 的结果另经 `FUN_14001b1f0` 处理（没读，归 P11d）。

## 2. R2：GIF

### 2.1 建纹理（`FUN_1400eb570` GIF 分支）【确】
```
st = new 0x20 { +0 句柄, +8 x 偏移, +0xc y 偏移, +0x10 画布宽, +0x14 画布高, +0x18 上次推进的帧号 = 0 }
ok = ext.OpenGIF(path, &st.h)                    // 虚函数 +0x140 → resourceutil64!OpenGIF
ok = ext.AdvanceGIF(st.h, dt = 0, &bits, &W, &H) // 虚函数 +0x148：第一次调用不看时间，解出第 0 帧
a = req.aspect
if a != 0:
  if W/H <= a: h' = (int)(W/a); st.y = (int)((float)(H − h') · 0.5)
  else:        w' = (int)(a·H); st.x = (int)((float)(W − w') · 0.5)
tex.flags |= 1                                   // 点采样
纹理 = 图像 = (w', h')
D3D11: Usage DYNAMIC(2), CPUAccess WRITE, Bind SRV, MipLevels 1, Format 0x1c
初始数据 = 第 0 帧的 [st.x, st.y, w', h'] 区域（FUN_140170470 逐行拷）
失败（打开 / 第一帧）→ FreeGIF，失败位不清 → 缺省纹理
```
- 采样器 `FUN_140099980(flags, 1)`：bit0 → 点采样，寻址照缺省纹理的夹取位。【确】

### 2.2 推进（`FUN_14015f0d0` → 纹理虚函数 `+0x38` = `FUN_1400ee9e0`）【确】
- 调用点同 P9a 的视频：材质绑定 `FUN_140155fc0` 末尾（`0x1401572a0`），对着色器程序用到的每个槽调纹理虚函数 `+0x20`（`FUN_14015f0d0`）。纹理带 GIF 状态时转 `+0x38`。
```
FUN_1400ee9e0(tex):
  if st.lastFrame == ctx.frameNo(+0x144): return       // 每个渲染帧最多一次
  st.lastFrame = ctx.frameNo
  if AdvanceGIF(st.h, ctx.dt(+0x14c), &bits, &W, &H):  // 有新帧才写
     Map(WRITE_DISCARD); 逐行拷 bits[(st.y + r)·W·4 + st.x·4 …] 到第 r 行（r < 图像高）; Unmap
```
- `ctx+0x14c` 是 `g_Frametime`：`clamp(场景 rate × 暂停淡变 × 原始帧时间, 0.0001, 0.25)`（rea-p10、p4 报告 T2）。
- 时间只在「画到」时推进：
  - 图层隐藏、被剔除、着色器不读这个槽时都不推进；再画到时接着放，不补时间；
  - WPE 暂停时帧函数不跑，也不推进。
- 在帧里的位置：渲染阶段，第一次绑定它的那次绘制之前，也就是在脚本、粒子之后。
- 每行拷 `RowPitch & ~3` 字节（不是 `w'·4`），行尾多读的源像素落在纹理行距的填充里，不影响画面。

### 2.3 `resourceutil64` 的 GIF 解码器【确】
- `OpenGIF`（`0x180001be0`）：路径按 UTF-8 → UTF-16，整个文件读进内存，建 0x8978 字节的状态：`+0` 起是 `stbi__context`（`+0xc0` 读指针、`+0xd0/+0xd8` 原始区间），`+0x100` 起是改过的 `stbi__gif`；`+0x8968` 剩余时间，`+0x896c` 首次标志 = 1。
- `AdvanceGIF(s, dt, &bits, &w, &h)`（`0x1800021d0`）：
```
if !s.first && s.remain > 0:
    s.remain -= dt
    if s.remain > 0: return false             // 还没到，不换帧
s.first = false
p = gif_load_next(s, &g, 4, two_back = s+0xf8, restart = false)
if p == s:                                     // 读到 ';'（结束符）
    rewind 读指针; p = gif_load_next(…, restart = true)
if p:
    *w = g.w; *h = g.h                         // 逻辑屏幕尺寸，每帧相同
    s.remain = g.delay / 1000.0 + s.remain     // 带上超出的部分
    if 本帧 disposal ∈ {0, 1}: 把画布拷进 two_back（给后面的 disposal 3 用）
    *bits = 画布
return p != 0
```
  - 一次调用最多解一帧，落后的时间只能每个渲染帧追一帧；延时 0 的帧不阻挡，下一个渲染帧就换。
  - 没有最小延时（浏览器把 ≤ 10 ms 当 100 ms，WPE 不这样）。
- 帧解码 `FUN_180007800`（`stbi__gif_load_next`）：
  - **画布**：`g.w × g.h` 的 RGBA（`FUN_180007230` 写像素时把调色板的 BGR 换回 RGB），首次 / 重新开始时清成 (0, 0, 0, 0)。
  - **写像素**：调色板 alpha `> 128` 才写；无论写没写，都把这个像素记进本帧的「写过」表。GCE 带透明位时，透明索引的 alpha 置 0。
  - **disposal**（下一帧开始时按上一帧的 GCE 处理，只作用于上一帧「写过」的像素）：
    - 3：恢复成 `two_back`，没有 `two_back` 时按 2 处理；
    - 2：`bgindex < 0` → (0,0,0,0)；上一帧不透明 → 全局调色板 `pal[bgindex]`；否则 → `pal[transparent]`（alpha 0）；
    - 0 / 1：不动。
  - **第一帧 / 重新开始**：本帧 GCE 不带透明位、且 `bgindex` 有效时，没写到的像素填 `pal[bgindex]`。
  - **`bgindex` 的改动**（`FUN_180006d90`）：没有全局调色板、`bgindex == 0` 或越界时置 −1。所以背景色 0 号永远不用，这是对 stb 原版的修改。
  - **R / B 互换**：背景色与 disposal 2 的填色是把调色板项（按 B、G、R、A 存）按 4 字节整拷进 RGBA 画布，R、B 互换。这是 stb 自身的行为。
  - **延时**：GCE 的 `10 × get16le`，单位毫秒。
  - **扩展块**：只认 GCE（`0xF9`、长度 4），其它扩展整段跳过，所以 NETSCAPE2.0 的循环次数不读，永远循环。
  - **尺寸上限**：`w`、`h` 都 ≤ 0x1000000（stb 的 `STBI_MAX_DIMENSIONS`）。
- `FreeGIF` 释放画布、「写过」表与状态。

### 2.4 换值 / 销毁【确】
- 纹理析构 `FUN_1400ec060` 调 `+0x150`（`FreeGIF`）。换值后旧纹理没人引用时，在材质刷新末尾由 `FUN_1401511b0` 回收（第 3.4 节）。同一文件、同一比例键再选回来时是新纹理，从第 0 帧开始。

## 3. R3：视频

### 3.1 建纹理（`FUN_1400eb570` 视频分支，`0x1400eb705`–`0x1400eb990`）【确】
```
tex.flags |= 0x20                                  // Video 位
P = ext.+0x130(ctx)                                // FUN_1400c7140，播放器 P（虚表 0x1404871b8），同 P9a
ok = P.Init(+8)(ctx+0x1518 设备, tex)              // 同 P9a：FORCEMUTE 由渲染标志位 17 决定
P.Open(+0x18)(path, 偏移 0, 长度 0)                // 长度 0 → stat 取整个文件（FUN_1400f28e0）
P.Info(+0x20)(&info)                                // {ok, W, H, fps, hdr}：MF_MT_FRAME_SIZE 等，hdr = 传递函数 PQ(15)/HLG(16)
if !info.ok: 删 P; (w', h') = (64, 64)              // 失败分支
elif a != 0:
  if W/H <= a: h' = (int)(W/a); c = (H−h')/H·0.5; P.SetSourceRect(+0x28)(0, c, 1, 1−c)
  else:        w' = (int)(a·H); c = (W−w')/W·0.5; P.SetSourceRect(+0x28)(c, 0, 1−c, 1)
if info.hdr && ctx.flags(+0x118) & 0x10000:  Format = 10 (R16G16B16A16_FLOAT), +0x18 = 0xe, 8 B/px
纹理 = 图像 = (w', h'); Usage DEFAULT, Bind SRV|RT(0x28), MiscFlags SHARED_KEYEDMUTEX, MipLevels 1, 初始数据全 0
QI 键控互斥 → tex+0x168
if P == null:  goto 收尾（失败位不清）              // 0x1400eb977 → 0x1400ebeed
if D3D 纹理建成: P.SetTarget(+0x10)(tex); 清失败位
else: 6×6 棋盘格 + 失败位
```
- 汇编核对：`0x1400eb977 je 0x1400ebeed` 跳过了 `0x1400ebee6 and [rsi+0x1c], 0xbfffffff`。所以**探测或初始化失败时纹理带着失败位返回**，`FUN_1401556e0` 释放它、用缺省纹理。上一轮表格「播放器建不起来 → 64×64 黑占位，并清掉失败位」更正为「→ 缺省纹理」。
- `SetSourceRect`（`FUN_1400f2e90`）写 `P+0xb8 left, +0xbc top, +0xc0 right, +0xc4 bottom`，并置「要帧」。这正是 rea-p9 第 2 节说的「场景路径里没看到调用」的那个虚函数：`.tex` 视频不调，用户纹理视频调。
- `TransferVideoFrame` 的目标矩形是 `{0, 0, tex+0x20, tex+0x24}` = `(w', h')`，源矩形是上面的归一化裁切，所以纹理里正好是正中那块，一比一。`(W − w')` 为奇数时起点落在半像素上，由 MF 的视频处理器重采样【推】。
- 几何 UV 不变（用户纹理纹理尺寸 = 图像尺寸，UV 上界 1，见第 4 节）。`g_Texture<n>Resolution = (w', h', w', h')`。
- 尺寸取 MF 源读取器的原生帧尺寸，旋转元数据（手机竖拍）是否被考虑【未知】。

### 3.2 与 P9a 的异同【确：同一个类与同一套虚函数；规则引自 rea-p9】

| | `.tex` 视频（P9a） | 用户纹理视频 |
|---|---|---|
| 播放器 | P（`0x1404871b8`） | 同 |
| 字节来源 | 自写 `IMFByteStream`，`.tex` / `scene.pkg` 的一段 | 同一个类，整个文件（长度 0 → 文件大小） |
| 纹理尺寸 | `.tex` 头的 mip 0 | 探测的帧尺寸按比例裁后 |
| 源矩形 | `{0,0,1,1}` | 居中裁切 |
| 格式 | `R8G8B8A8_UNORM` | 同；PQ / HLG 且视频 HDR 标志时 `R16G16B16A16_FLOAT` |
| 声音 | `FORCEMUTE`（场景不置位 17） | 同 |
| 时钟 / 循环 / 从 0 开始 / 30 帧没画到暂停 / WPE 暂停 | rea-p9 第 3、4 节 | 同（同一工作线程 `FUN_1400f3930`、同一 `AcquireFrame` 路径 `FUN_14015f0d0` → `P+0x78`） |
| 失败 | 纹理保持透明 | 退回缺省纹理 |
| 脚本 `getVideoTexture()` | 槽 0 是视频纹理时有效 | 同一判断（看纹理 `+0xd8` 播放器），换图时图层缓存的包装（`+0x4c0`）若不是新纹理的就删掉（`FUN_140209360` 尾） |

### 3.3 HDR 一句话
- 探测到 PQ / HLG 传递函数，且渲染标志 `0x10000`（p2-REPORT：视频 HDR）置位时，纹理用 `R16G16B16A16_FLOAT`；否则照常 RGBA8，由 MF 转成 SDR【推】。

### 3.4 换值时旧播放器什么时候停【确】
- setter 把材质插进待刷新集合 → 下一帧开头 `FUN_140150d60` 重跑纹理解析，槽里换成新纹理 → 末尾 `FUN_1401511b0`：
  1. 纹理表里 `(+0x10 & 1) == 0` 且 `+0xd4 == 0` 的纹理是候选；
  2. 去掉仍被任何材质槽引用的；
  3. 剩下的从表里摘掉并 `delete`。
- 析构 `FUN_1400ec060` 删播放器（`P` 的析构结束工作线程、释放引擎）与 GIF。所以旧视频在换值那一帧开头的刷新里就停、就销毁；别的材质还引用同一张（同值同比例键）时不销毁。
- `+0xd4` 的含义没查【未知】，用户纹理建成后这个字段没被写过【推】。

## 4. R4：槽 0 换图后图层重算什么

### 4.1 触发【确】
- `FUN_140150d60`：每个待刷新材质先注销槽 0 就绪句柄 `mat+0x2f8`，重跑 `FUN_1401556e0`。原句柄非 0 时：
  - 重新登记；
  - 槽 0 纹理非空且和原来不是同一个对象时，立即 `FUN_140157780(mat, 新槽 0 纹理)`（`0x140150f62`–`0x140150f76`，`rdx = [rsi+0xd0]`）。
- `FUN_140157780` 遍历 `mat+0x2c0` 的监听者调 `+0x10`。图像层在构造时登记的监听者调 `FUN_140209360(layer, tex)`（`0x1401fb22f`）。
- 只有材质创建（`FUN_1401515b0`）与图像层构造登记这类监听。`0x140157780` / 函数对象虚表 `0x14048b6d0` 的全部引用只在这三处与 `0x14015b6a0`【确，有界：`wp.asm` 交叉引用】。

### 4.2 `FUN_140209360(layer, tex)` 逐项【确，汇编 `0x140209360`–`0x14020953b` 核对】
```
imgW, imgH = tex+0x2c, +0x30;  texW, texH = tex+0x20, +0x24
if fullscreen(0x2):  size = (imgW, imgH);  geo = (2, 2)
elif autosize(0x8):
  if tex.flags & 4:            size = 帧尺寸 (tex+0xb0, +0xb4)
  elif projectlayer(0x400):    size = 正交投影宽高
  elif mat.flags(+0x1f8) & 4:  size = mat.ref (+0x2b0, +0x2b2)
  else:                        size = (imgW, imgH)
uvScale = (imgW/texW, imgH/texH)
if (精灵表且帧数 ≥ 3) || effect 数(+0x320) > 0 || cbm 上屏(0x10):  uvScale = (1, 1)
vfunc+0xb0 = FUN_1402066a0(uvScale, texW, texH, (int)size)    // 重建 +0x2e0、+0x2e8、+0x490 四边形
vfunc+0xb8 = FUN_1401ea500()                                   // 重建合成 RT 与 effect fbo
if layer+0x4c0（脚本视频 / 纹理动画包装） && 它的纹理 != tex: 删掉
```

| 项 | 结论 |
|---|---|
| `autosize` 尺寸 | 用户纹理生效时取 `mat.ref`，即缺省纹理的图像尺寸（精灵表取帧尺寸）或 `usertexturereference`；回缺省时取缺省纹理的图像尺寸。普通情况两者相同，**不变**。`keepaspect`（ref 被改成用户图的尺寸）或 `usertexturereference` 与缺省图像尺寸不同时会变。不是 `autosize` 的不变 |
| UV 范围 | `imgW/texW`：用户纹理纹理尺寸 = 图像尺寸 → **1**；缺省纹理补到 2 的幂时 < 1 |
| UV 内缩 | `FUN_1401ede30` 的 `e = 0.15 / (texW, texH)`，用**新纹理**的纹理尺寸。`+0x490` 在 `flags & 0x226` 为 0 时内缩；`+0x2e8` 在 `fullscreen` 或 `0x220` 都没有时内缩（rea-p5 5.2） |
| 合成 RT | `FUN_1401ea500` 无条件释放两张合成 RT，按 `vfunc+0x128` = `FUN_1402091e0` 重新算尺寸再建：新槽 0 纹理的图像尺寸（精灵表取帧尺寸）。非 `fullscreen` 的 `passthrough` / `solidlayer` 改按 `round(size)`，但 instanced 除外，instanced 仍按图像尺寸。再除纹理降级系数（`fullscreen` 且非精灵表时不除），`max(4, ·)`。**instanced 换成用户图后合成 RT = 裁后用户图的尺寸**，回缺省时回到 32×32 |
| effect fbo | 同一函数里逐个 fbo：已有的 `FUN_140161f40` 改尺寸，没有的 `FUN_1401aadb0` 新建，按新的合成尺寸 |
| 被依赖图层的 `_rt_imageLayerComposite_<id>_a` | 同样销毁重建（rea-p8 2.2），内容丢失，下一次画之前引用方读到新建 RT 的初值 |
| `fullscreen` | 尺寸 = 新纹理的图像尺寸，几何 (2, 2) |
| `g_Color4` / `g_Alpha` | 见 4.3 |

### 4.3 颜色强制为白【确】
- `FUN_140207b50`（合成路径）与 `FUN_140208670`（直接上屏）开头，**每次绘制**都判断：
```
if (layer.flags304 & 0x820) && (layer.baseMat(+0x498).flags(+0x1f8) & 4):
    ctx.g_Alpha(+0x120) = 1; ctx.g_Color(+0x124..+0x12c) = (1, 1, 1)     // g_Color4 = (1,1,1,1)
else:
    g_Color = color · k（HDR 时 k = brightness）; g_Alpha = 对象 alpha(+0x33c)
```
- `0x820` = `passthrough` | `instanced`。bit2 是材质级的：这个材质**任一槽**的用户纹理生效都会置位，不限于槽 0。
- **对象的 alpha 也被换成 1**，不只是颜色。
- `FUN_1401556e0` 开头 `mat.flags &= ~4`，只有某槽用户纹理建成才 `|= 4`。所以退回缺省（值清空、文件不存在、解码失败）后的下一次绘制恢复对象色与 alpha。

## 5. R5：缺省纹理名是 `_rt_*` 的槽

### 5.1 `FUN_14014d500(纹理管理器, 名, &信息, &帧表)`【确】
```
key = FUN_1400187b0(名)          // 只把 '\' 换成 '/'、合并重复的 '/'，不改大小写
if 信息缓存(mgr+0x40) 有 key:   拷出缓存的信息与帧表; return true
if 纹理表(mgr+0x00) 有 key:      拷出该对象 +0x18 起的头（格式、标志、纹理尺寸、图像尺寸）与 +0xa8 帧表
                                 写进信息缓存; return true
读 "materials/" + 名 + ".tex" 的头（经 ctx+0x1898 文件系统）
   成功: 写缓存; return true
   失败: return false            // 不写缓存
```
- 唯一调用者是 `FUN_1401556e0`（`0x140155a23`），也是信息缓存唯一的写入者（`FUN_14014e850` 只在本函数里调）。只在「槽有用户纹理值、文件存在、没有 `usertexturereference`」时才查。缓存的失效点没找到，推断随纹理管理器一起销毁【推】。
- 返回 false 时参考宽高是 0 → 走缺省（上一轮 2.2 节）。

### 5.2 `_rt_imageLayerComposite_<id>_a` 的几种情形
- 纹理表里的同名对象由引用方材质创建时 `FUN_14014cf90(名, 1)` 建：文件找不到，退回 6×6 棋盘格（rea-p8 2.1、2.6）。被依赖图层的 RT 在场景加载末尾建，建时接管同名对象，把头改成 RT 的尺寸与标志（rea-p8 2.1）。纹理表的键同样经 `FUN_1400187b0`，大小写一致。
- **材质创建里的顺序**（`FUN_1401515b0`）：先 `FUN_140154480` → `FUN_1401556e0` 解析 `textures` 与用户纹理（`0x140151970` / `0x1401519c2`），再给仍空着的着色器槽取注解缺省（`0x140151b82`）。所以引用方材质在**自己的缺省分支**里才第一次建占位；判断用户纹理时，如果没有别的材质先引用过这个名字，表里还没有它。

| 情形 | `FUN_14014d500` 得到 | 结果 |
|---|---|---|
| 加载时值为空，运行中选图（常见） | 纹理表命中，已被 RT 接管 → RT 的尺寸 (W, H)、RT 的标志 | 用户图按 W/H 裁，**替换掉 RT**；`g_Texture<n>Resolution` = 裁后用户图尺寸；采样标志取 RT 的点采样 / 夹取位 |
| 加载时值非空，本材质是第一个引用这个名字的 | 表、缓存、文件都没有 → false | 缺省：这个槽是 RT（被依赖时）或棋盘格。用户图在加载后不显示，直到值再变一次（那时走第一行） |
| 加载时值非空，别的材质已先引用（占位已在表里），RT 还没建 | 6×6 占位 → 比例 1 | 用户图按 1:1 裁。**这个 6×6 进了信息缓存，以后每次都按 1:1 裁** |
| 被引用的 id 不存在 / 没被依赖 | 第一行：6×6 → 1:1；第二行：false | 同上，按 1:1 裁或缺省 |

- 回缺省时 `FUN_14014cf90(名, 1)` 返回表里的同名对象：接管后就是 RT 本身（内容、尺寸、采样器都是 RT 的），否则是棋盘格。
- 其它 `_rt_*`（`_rt_FullFrameBuffer` 等）规则一样：RT 建好、按名登记进表之后查到的是 RT 的尺寸，之前查不到。语料里挂用户纹理的 `_rt_` 缺省只有 `_rt_imageLayerComposite_*`（计划里的 23 项）。
- 上面第 2、3 行依赖加载顺序与「谁先引用」，读码只能给出规则。哪种情形真的出现要实测【推】。

## 6. R6：粒子材质槽 0 是精灵表

### 6.1 `0x1000000` 只在加载时定【确】
- 粒子定义解析 `FUN_1401cfe16` 一带：`mat = FUN_140150110(ctx+0x1630, …)` 创建材质（此时 `usertextures` 已按初值解析，见第 5.2 节的顺序），然后 `tex0 = FUN_14011ee90(mat, 0)`，`FUN_14015c470(tex0)` = `(tex0+0x1c >> 2) & 1` 为真时置 `def.flags |= 0x1000000`（`0x1401d04a5`）。只做这一次。
- 着色器变体（`SPRITESHEET`、`SPRITESHEETBLEND`、`THICKFORMAT` 等宏，rea-p4b 2.4）在加载时按这个位建；frame 列每帧按它推进（rea-p4b 2.5）。
- 粒子系统没有登记材质槽 0 的就绪监听（4.1 的有界搜索），材质刷新不通知粒子，这几项都不重算。

### 6.2 `g_RenderVar1` 每次绘制按当前槽 0 写【确，汇编 `0x140236827`–`0x1402368e7`】
```
if def.flags & 0x1000000 && (tex0 = 绘制材质(+0x358).tex[0]) && tex0.frames(+0xb8..+0xc0) 非空:
    RV1 = (f0.w, f0.h, 帧数, (texH/texW)·(f0.h/f0.w))
// 否则不写，ctx+0xb8..+0xc4 保留上一次写入的值
```
- 用户纹理（`FUN_1400eb570` 建的对象）不读 TEXS，帧表为空，所以**换成用户图后这一次不写 RV1**。
- `ctx+0xb8` 是全局的：沿用的是上一个写它的粒子绘制留下的值，同一场景只有这一个精灵表系统时就是它自己换图之前的值。帧内或帧间有没有别的地方复位它【未知】。

### 6.3 画面后果【推】

| 加载时槽 0 | 运行中换成 | 变体 / frame 列 | RV1 | 画面 |
|---|---|---|---|---|
| 缺省精灵表 | 用户图 | `SPRITESHEET` 照旧，frame 照推 | 沿用旧值 | 用户图被当成同样行列的精灵表，每个粒子画其中一格并按旧帧序轮换 |
| 用户图（加载前值就非空） | — | 没有 `0x1000000`：不用精灵表宏，frame 不推 | 不写 | 每个粒子画整张用户图 |
| 用户图 | 换回缺省精灵表 | 仍没有 `0x1000000` | 不写 | 每个粒子画整张精灵表 |

- 参考尺寸：缺省是精灵表时取帧尺寸（`tex+0xb0/+0xb4`，上一轮已读），用户图按单帧的比例裁。
- 粒子的变体材质是否各自登记了 `usertextures` 绑定（每个变体都经 `FUN_1401515b0` 创建，推断会），没逐个追【推】。

## 7. R7：属性图片的解码

### 7.1 `resourceutil64` 侧【确】
```
LoadUnknownImageBitsFromPath(utf8 path, &bits, &w, &h)      // 0x180001520
  wpath = UTF-8 → UTF-16
  ok = FUN_180009c40(wpath, &out)                            // 结果数组恰好 1 项（0x20 字节）才成功
FUN_180009c40:
  fif = FreeImage_GetFileTypeU(wpath, 0)                     // 只看内容；-1 → 失败（不按扩展名回退）
  dib = FreeImage_LoadU(fif, wpath, 10)
  w, h = GetWidth, GetHeight（转换前的值）
  d32 = FreeImage_ConvertTo32Bits(dib)
  if !d32: std = FreeImage_ConvertToStandardType(dib, TRUE); d32 = ConvertTo32Bits(std)
  FreeImage_FlipVertical(d32)
  memcpy(w·h·4 字节, FreeImage_GetBits(d32))                 // 32 位扫描行没有填充
  FUN_1800049e0: 每像素交换字节 0 与 2                        // 只交换 R、B，确认
```
- 不预乘、不缩小、不限尺寸。`FUN_1401702f0` 裁切也没有上限。
- 纹理宽或高超过 D3D11 的 16384 时 `CreateTexture2D` 失败，失败位不清 → 缺省纹理【推】。
- 多页格式（TIFF、ICO、GIF 改了扩展名）`FreeImage_LoadU` 只读第一页（或 ICO 的第一个图标）【推：FreeImage 单页接口的行为】。

### 7.2 `FreeImage_LoadU` 的标志 10 对各格式的含义（FreeImage 3.18 头文件常量）

| 格式 | 位 1（2） | 位 3（8） | 结论 |
|---|---|---|---|
| JPEG | `JPEG_ACCURATE` | `JPEG_EXIFROTATE` | 精确 IDCT，按 EXIF 方向旋转 |
| PNG | — | — | **`PNG_IGNOREGAMMA`（1）没置位，见 7.3** |
| GIF（扩展名不是 `.gif` 时才会到这里） | `GIF_PLAYBACK` | — | 合成后的第一帧 |
| PSD | `PSD_LAB` | — | Lab 文件保留 Lab，不转 RGB【推，语料无关】 |
| RAW | `RAW_DISPLAY` | — | 不涉及 |
| ICO / TGA / TIFF / BMP | 无对应位 | — | 缺省加载 |

### 7.3 FreeImage 3.18 内部（`FreeImage64.dll`，`gh/projfi`）【确，另注明的除外】
- PNG 插件的 `Load` 是 `FUN_1800348c0`：插件初始化 `FUN_180035d80` 把它写进 `+0x40`，描述串 `"Portable Network Graphics"` 在 `0x180465d88`。解码配置 `FUN_180034600` 与 3.18 源码的 `ConfigureDecoder` 一一对应。
- **gamma 会被校正**（`FUN_180034600` 尾部）：
```
if png_get_valid(PNG_INFO_gAMA) && png_get_gAMA(&g) && (flags & 1) == 0:   // flags = 10，位 0 没置
    png_set_gamma(png, 2.2 /* 0x400199999999999a */, g)
```
  - libpng 1.6.35 在 `|g × 2.2 − 1| < 0.05` 时不变换，所以 `gAMA = 1/2.2` 的文件不变。只有 `sRGB` 块时，libpng 也按 0.45455 给出 gamma，同样不变【推：libpng 1.6 行为】。
  - 别的值按指数 `1/(g·2.2)` 改写颜色（调色板图改调色板），alpha 不动。例：`gAMA = 1.0` 的 PNG 被**提亮**（指数 1/2.2）。
- **类型与通道**：

| PNG | FreeImage 类型 | `ConvertTo32Bits`（`0x180054bc0`）之后 |
|---|---|---|
| 8 位 RGB / RGBA | `FIT_BITMAP` 24 / 32 位（`png_set_bgr`） | 原值 |
| 16 位 RGB / RGBA | `FIT_RGB16` / `FIT_RGBA16`（`png_set_swap`） | **取高字节**（每通道读 16 位值的第 1 字节，即 `>> 8` 截断）；RGB16 的 alpha = 255 |
| RGB + `tRNS` 单色 | `png_set_tRNS_to_alpha` → 32 位 / `FIT_RGBA16` | 同上两行 |
| 灰度 1 / 2 / 4 / 8 位 | 8 位（2 位或带 `tRNS` 的低位深先扩到 8 位）+ 灰阶调色板 | 查调色板，alpha 255 |
| 灰度 ≤ 8 位 + `tRNS` | 同上，再建 256 项透明表：`表[灰度值] = 0`，其余 255（`fi4/f_1800348c0.c` 第 252–300 行，灰度值 < 256 且位深 ≤ 8 时） | alpha 取透明表 |
| **16 位灰度（无 `tRNS`）** | `FIT_UINT16` | `ConvertTo32Bits` 返回空 → `ConvertToStandardType(dib, TRUE)`（`FUN_18005d7a0`）：**线性拉伸**，`min = min(255, 最小值)`（初值 0xff）、`max = max(0, 最大值)`，相等时取 0 / 255，`v' = (int)((v − min)·255/(max − min) + 0.5)`；再按 8 位灰度转 32 位 |
| 16 位灰度 + `tRNS` | `tRNS_to_alpha` + `gray_to_rgb` → `FIT_RGBA16` | 取高字节 |
| 灰度 + alpha（8 / 16 位） | `gray_to_rgb` → 32 位 / `FIT_RGBA16` | 原值 / 取高字节 |
| 调色板 1 / 2 / 4 / 8 位（+ `tRNS`） | 2 位或带 `tRNS` 的低位深扩到 8 位；`tRNS` 的前 `min(num_trans, 256)` 项成透明表 | 8 位：`alpha = 下标 < 表长 ? 表[下标] : 255`（`fi1/f_180054bc0.c` 第 235–315 行）；1 / 4 位走 `ConvertLine1/4To32MapTransparency` |

- **ICC**：PNG 的 `iCCP`（Load 里 `valid & 0x1000` → `png_get_iCCP`）只存进 FreeImage 的 ICC 结构。库里没有色彩管理引擎：没有 lcms 的字符串或导出，ICC 相关的导出只有 `Create/Get/DestroyICCProfile`；`ICC profile …` 这类字符串是 libpng 自己校验 `iCCP` 的报错。所以 **ICC 不应用**。JPEG 的 ICC 同理不应用【推：没读 JPEG 插件】。`bKGD`、`pHYs` 只记录，不影响像素。
- **JPEG**：`JPEG_ACCURATE | JPEG_EXIFROTATE`。没有 `JPEG_CMYK`，CMYK / YCCK JPEG 转 RGB【推：没读 JPEG 插件，按 3.18 源码】。
- **尺寸**：FreeImage 与 resourceutil 都不缩小。PNG 受 libpng 缺省的 100 万像素边长上限；超过 D3D11 纹理上限 16384 时在 wallpaper64 建纹理失败 → 缺省纹理【推】。

## 8. 对 Kabegame P11b 的含义（代理建议）

- **R1 面板**：`scenetexture` 的文件选择照 WPE 只给一条过滤 `*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`。存绝对路径，分隔符统一成 `/`，不拷贝。后端 `user_props.rs` 认 `scenetexture` 时不用管 `fileType`。WPE 的值本来就可能是别的扩展名（用户手输），宿主照「按内容识别」处理，认不出就用缺省纹理。
- **R2 GIF**：不能用 `<img>` / `ImageDecoder` 的时序。要自己按 2.2、2.3 的规则走：
  - 时间：画到才推进，用 `g_Frametime`，一帧最多换一帧，延时不设下限，永远循环。
  - 合成：照 stb 的规则（alpha > 128 才写、disposal 只管上一帧写过的像素、背景色 R/B 互换、`bgindex` 0 不用）。
  - 纹理：点采样。
  - 可以先用 `ImageDecoder` 解出帧（它做的合成与 stb 不完全一样），差异作为已知差异，或者自己写 GIF 解码。建议后者，代码量小（LZW + 上面这几条规则）。
- **R3 视频**：直接复用 P9a 的播放器，只加两点：
  - 纹理按裁后尺寸建，`copyExternalImageToTexture` 的源矩形用 `{origin: (round(c·W), …), width: w', height: h'}`（浏览器不做半像素重采样，记为已知差异）；
  - 失败时用缺省纹理，不是透明。
- **R4**：槽 0 换图走整层强制重建是对的。重建要覆盖：尺寸（`autosize` 用 ref）、UV 上界与内缩（按新纹理）、合成 RT 与 fbo（按新纹理图像尺寸，instanced 也是），以及被依赖图层的独占 RT 内容清掉。`g_Color4` / `g_Alpha` 强制为 1 按 pass 是否有用户纹理生效现算，不用重建，也不限槽 0。
- **R5**：建议照报 `usertextures:rendertarget`，或只实现「运行中选图 → 按 RT 尺寸裁、替换 RT」这一种，加载时值已非空的情形另报。参考尺寸取那张 RT 的尺寸（`compositeSize`）。
- **R6**：建议照报 `usertextures:particle-sheet`。要做的话：编译期按加载时的槽 0（属性初值有效就是用户图）定 `SPRITESHEET` 与 frame 推进；运行中换图不改变体，RV1 换图后沿用上一次的值。
- **R7**：
  - `createImageBitmap(…, { colorSpaceConversion: "none" })` 对 ICC 与 WPE 一致，对 PNG 的 `gAMA` 不一致：WPE 按 `png_set_gamma(2.2, g)` 改写。
    - 要对齐，可以宿主自己读 `gAMA` 块，`|g·2.2 − 1| ≥ 0.05` 时对 RGB 做 `v' = 255·(v/255)^(1/(g·2.2))`；
    - 或者照报、记为已知差异。语料里这种 PNG 应该极少。
  - 16 位 PNG：浏览器解码出的 8 位值是四舍五入还是截断要实测；16 位灰度的拉伸是 FreeImage 的怪癖，要对齐只能自己解 PNG。建议都记为已知差异。
  - JPEG 的 EXIF 旋转、直通 alpha、不做 ICC 与计划一致。
- **顺带**：
  - 缓存键用 `round(ratio·10)` 而不是精确比例，比例相近的槽共用一张；
  - `material:keepaspect`（pass 级）可以从能力表删掉，当中性键；
  - 扩展名判断不分大小写。

## 留给实测的问题

| # | 问题 | 怎么测能区分 |
|---|---|---|
| 1 | R1 过滤与返回值 | 在 WPE 编辑器里对 `scenetexture` 属性点浏览：对话框文件类型下拉只有 `Textures (*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4)`；选一张带 `\` 的路径，看工程 `project.json` / 用户配置里存的值是否为 `D:/…`。再在文件名框手输一个 `.webp`、`.tga`，看能否选上、场景里是否显示 |
| 2 | GIF 时序 | GIF：4 帧，延时 0 / 2 / 10 / 50 cs，每帧一种纯色。60 fps 与 144 fps 各连抓 100 帧读纹理像素：延时 0 的帧只停一个渲染帧，其余帧持续 ≈ 延时（带余量），不受 fps 影响；场景 rate 改 2 时节奏加倍 |
| 3 | GIF 隐藏不推进 | 脚本每 1 s 切图层 `visible`，记录再显示时是从隐藏前那一帧接着放（不跳到「应该」的帧） |
| 4 | GIF 合成规则 | 一组 disposal 0/1/2/3、带透明、`bgindex` 为 0 与非 0、首帧不带透明的 GIF，抓纹理像素与 stb 规则比较；尤其背景色 R/B 是否互换、`bgindex` 0 是否不填 |
| 5 | GIF 点采样 | 把 GIF 绑到放大显示的槽上，看是否硬边（点采样）；同一张 PNG 对照是线性 |
| 6 | 视频裁切与尺寸 | 1920×1080 mp4 绑到 1:1 的槽：RenderDoc 看纹理 1080×1080、`g_Texture0Resolution` = (1080,1080,1080,1080)，画面是正中一块不变形 |
| 7 | 视频失败 | 绑一个改名成 `.mp4` 的文本文件：预期显示缺省纹理（不是透明、不是黑） |
| 8 | R4 instanced | 纯色层 + tint effect，用户纹理选 640×360、对象 `size` 1920×1080：合成 RT 预期 640×360（裁到 16:9 后不变）；清空值后回 32×32；`g_Color4` 预期 (1,1,1,1)、对象 alpha 0.5 时也读到 1 |
| 9 | R4 alpha 也被强制 | 同上，对象 `alpha` 设 0.3，用户纹理生效时读 `g_Alpha`（或画面是否变为不透明），清空后恢复 0.3 |
| 10 | R5 加载时值非空 | M3 工程：属性先存一个有效图片路径再打开壁纸，看槽 1 绑的是用户图还是 RT；然后改成另一张图再抓，看是否按 RT 比例裁。另做一份让两个材质引用同一个 `_rt_imageLayerComposite_` 名，看是否变成 1:1 裁 |
| 11 | R6 粒子 | 精灵表粒子：属性初值为空 → 运行中选图，读粒子顶点 UV / 画面，预期只采样用户图的一格；再把属性初值存成图片后重开，预期每个粒子整张图 |
| 12 | R7 PNG gamma | 同一张图做三份 PNG：无 `gAMA`、`gAMA` = 1/2.2、`gAMA` = 1.0，读纹理像素：按 7.3 的结论，第三份应被改写（变暗或变亮），前两份相同 |
| 13 | R7 16 位与灰度 | 16 位 RGB PNG（值 0x12FF 等）读纹理字节，判断高字节截断还是四舍五入；16 位灰度 PNG（值域只占 1000–3000）读纹理，判断是否被拉伸到 0–255 |
| 14 | 比例键共用 | 同一张图绑到 1.77 与 1.78 比例的两个槽：预期两槽共用一张纹理（RenderDoc 资源相同），按先建的那个比例裁 |
