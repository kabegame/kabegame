> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`；`winrtutil64.exe` 同为 `0x140000000`，`resourceutil64.dll` 为 `0x180000000`）。只读码，没有实测。实测结论见 `p11-REPORT.md`「属性纹理」一节，冲突时以报告为准；本文与报告已对照的地方在正文里注明。

# WPE 2.8.42 P11 纹理侧静态逆向（`usertextures`、封面、快捷方式图标、音频 uniform 复核）

**概括**
- **解析**（`FUN_140154480`）：逐项读材质 pass 的 `usertextures` 数组。字符串 → 用户属性名，来源类型 0；对象 → `name`（字符串）、`type`（`"system"` → 1、`"usershortcut"` → 2、其它 → 0）、`keepaspect`（JSON 布尔）；`null` 与空名字跳过，但槽号照常递增（槽号 = 数组下标）。每个有效项建一个类型 5 的描述符（setter `FUN_1401538d0`）、一个绑定对象和一个槽状态（当前值 + `keepaspect`），初值取累计属性全集里该属性的 `value`，不是字符串就当空串。对象 `instance` 的覆盖在材质刷新时合进 pass 再解析（见 2.1）【确】；effect pass 也是材质对象、走同一函数【推，实测已确认生效】。
- **只有 `textures` 同位置是非空字符串的槽才会换**（`FUN_1401556e0`）：只遍历 `textures` 的前 10 项；`textures[i]` 为 `null` / 空串的槽什么纹理都不绑，`usertextures[i]` 也不看。【确】
- **取哪张**（`FUN_1401556e0`）：槽状态的值为空 → 缺省纹理；来源类型 0 先问文件系统文件在不在，不在 → 缺省纹理；否则建（或复用）一张「用户纹理」，建不成（纹理标志 `0x40000000` 没清掉）→ 缺省纹理。三种情况都**不保留上一张**（与实测一致）。【确】
- **比例只看缺省纹理的图像尺寸**：参考宽高 = `usertexturereference.width/height`（两者都是非 0 数字时）；否则取缺省纹理（`textures[i]`）的信息：精灵表取帧尺寸，否则取**图像尺寸**（纹理对象 `+0x2c/+0x30`，不是补到 2 的幂的纹理尺寸 `+0x20/+0x24`）。目标比例 = 宽/高（float）；`keepaspect: true` 时传 0（不裁），加载后把材质参考尺寸改成实际图像尺寸。对象 `size` 不参与（`instanced` 纯色层例外：P5 读到它把对象 `size` 写进 `instance.usertexturereference`）。【确】
- **裁切**（`FUN_1401702f0`）：比例 0 → 原样拷贝；`w/h ≤ a`（图偏高）→ 高裁成 `(int)(w/a)`，起始行 `(h − h')>>1`；否则宽裁成 `(int)(h·a)`，起始列 `(w − w')>>1`。只裁、不缩放（与实测「正中最大矩形、一比一」一致）。属性图片与封面都走它；快捷方式图标走另一段，是**补透明边居中**；GIF、视频按同样的比例改的是 UV / 源矩形。【确】
- **GPU 资源**（`FUN_1400eb570` 的静态图分支）：`D3D11_TEXTURE2D_DESC` = 裁后宽高、`MipLevels 1`、`Format 0x1c`（`R8G8B8A8_UNORM`）、`Usage IMMUTABLE`、`Bind SRV`；纹理尺寸与图像尺寸都写成裁后宽高，所以 `g_Texture<n>Resolution = (w, h, w, h)`。采样器 `FUN_140099980(flags, 1)`：没有点采样位时 `MIN_MAG_MIP_LINEAR`、`MaxAnisotropy 1`；寻址 `(flags & 2) | 1`（WRAP / CLAMP）。`flags = 8 | 缺省纹理的(点采样位 1、夹取位 2)`，快捷方式另加夹取位。【确，与实测一致】
- **收哪些文件**：扩展名在 `.mp4 .wmv .avi .m4v .mov .mkv .webm` 里 → 视频纹理；扩展名正好是 `.gif` → 动图（逐帧更新的 DYNAMIC 纹理）；其它 → `resourceutil64.dll!LoadUnknownImageBitsFromPath`：FreeImage 按文件内容识别格式（`FreeImage_GetFileTypeU`）、`LoadU` 标志 10（JPEG 为精确解码 + EXIF 旋转）、转 32 位、只收单帧。所以 `scenetexture` 收图片（FreeImage 能读的都行）、GIF、视频。读不出来 → 缺省纹理。【确：分支与入口；FreeImage 版本支持的格式清单未读】
- **换纹理的时机**：setter 名字变了才写，并把材质插进待刷新集合（`ctx+0x1670` 的 `unordered_set`，P3 记作 `S+0x1678`，是它的链表头）。唯一的消费者是材质管理器 `FUN_140150d60(ctx+0x1630)`：逐个材质重读材质文件的 `passes[0]`、合进 `instance` 覆盖、重跑纹理解析 `FUN_1401556e0`，重挂槽 0 纹理的就绪回调，最后清空集合。调用点：帧函数 `FUN_14017fa70` 的开头（`0x14017fd1a`，在模拟、脚本、渲染之前），以及每帧脚本函数 `FUN_140171440` 处理完封面消息（`0x140171f56`）和异步图标完成（`0x1401722e5`）之后。运行中改属性：帧间消息泵里改值 → 下一帧开头换好、同帧画出；封面：收到消息的那一帧、渲染之前换好。【确】
- **`applyUserProperties`**：封面的增量只有 `{"$mediaThumbnail": {"value": 名字}}`（及 `$mediaPreviousThumbnail`），不带 `type`，按 P3 的规则（`value` 与 `type` 都要有）不进 `applyUserProperties` 的参数；UI 改 `scenetexture` 时的增量带 `type`，会进。【确：封面增量的构造；UI 增量形状沿用 P3】
- **封面纹理**：每条封面消息让媒体状态 `M` 把当前块 `M+0x108` 挪到 `M+0x160`、新块进 `M+0x108`，生成新名字 `mediaThumbnail_<计数>.system`；旧名字非空时同一增量把 `$mediaPreviousThumbnail` 设成旧名字。所以 **previous = 上一条封面消息的那张**，第一条之前没有值 → 缺省纹理。建纹理时按名字等于 `M+8`（当前名）选 `M+0x108`，否则 `M+0x160`；数据是 wuffs 解码好的 RGBA（`RGBA_NONPREMUL`），**同样按槽的缺省纹理比例居中裁切**、不缩放；宽或高为 0（会话没有封面）→ 缺省纹理。媒体集成关掉 / 没有会话时根本不产生这些增量 → 两个槽都是缺省纹理。【确：路径；关掉媒体集成时 `M` 是否存在【推】】
- **封面图**：由独立进程 `winrtutil64.exe -mediainterface` 从 SMTC 读：`ContentType` 为 `image/png` 用 wuffs，否则 FreeImage；Spotify 有专门处理；再以**原尺寸**重新编码成 PNG 发给 wallpaper64（消息 2），只有字节变了才发。【确】
- **封面配色**（`winrtutil64!FUN_140065590` + `FUN_14002db80`，第 4 节可直接复刻）：
  1. 360 格色相直方图，只计 alpha ≥ 16 的像素：每格累计 `s` 和、`v` 和、`(int)(v·s·100)` 权重和、像素数（`max − min < 1e-5` 或 `v ≤ 0` 的像素进第 0 格、`s = 0`）；
  2. 主色 = 权重最大的格；次色 = `权重 × d(i, 主)/180` 最大的格；第三色 = `权重 × (d(i, 主)/180 · d(i, 次)/180)²` 最大的格（`d` 为环形格距，> 180 取 360 − d；比较时最佳值存成 int）；
  3. 每色 = HSV(格号/360, 该格平均 s, 该格平均 v) → RGB，`(int)(x·255)` 夹到 [0, 255]；
  4. 文字色 = 主色与黑色的 WCAG 对比度 < 2.5 时白，否则黑；
  5. 高对比色 = 次色（若它与主色对比度 ≥ 2.5 且大于第三色的）；否则第三色（若 ≥ 2.5）；否则文字色。
  网页壁纸与场景收到的是同一条消息里的同一组颜色。【确：算法；wallpaper64 把五个值映射到脚本字段名的那一步【推】】
- **快捷方式图标**：wallpaper64 按路径的 SHA-256 查图标缓存 `thumbnail.cache`（`SHTC0001`），没有就请 `winrtutil64.exe` 取（消息 8 程序 / 文件，9 网址）。取法：`.url` 读 `IconFile/IconIndex` → `PrivateExtractIconsW(256×256)`；`.lnk` 经 `IShellLink` 的图标位置 → `LoadImageW(256×256)`；否则 `SHGetFileInfoW` + `SHGetImageList(SHIL_JUMBO)`。图标画成 `cLines × cLines` 的正方形位图（`cLines` = 图标颜色位图的高，通常 256），去预乘，编 PNG 回传（消息 10）。wallpaper64 解码后按槽比例**补透明边**居中，寻址一律 CLAMP；取不到 → 缺省纹理；还在异步取时也是缺省纹理，取到后标记材质、下一次刷新换上。【确】
- **音频 uniform 复核**：六个 `g_AudioSpectrum*` 在着色器程序的「应用」虚函数（`0x1400d7440`、`0x1400d7790`）里经常量填充函数 `0x1400d8300` 写入，每次绑定程序画一次就填一次（effect 中间 pass、粒子同一类程序）【确：调用链；「所有 pass 都是这一类程序」【推】】；数据来自 `ctx` 的三块，没声明 `supportsaudioprocessing` 时三块保持 0（rea-p4e 4.4，实测已确认全 0）；读码没看到着色器读这六个 uniform 会触发采集（采集只由工程开关决定，rea-p4e 4.3）。

**元数据**
- 目标：`wallpaper64.exe` 2.8.42，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（`ignore/p9/rea/wallpaper64.exe` 与 Steam 原件开工时都核对一致；另拷到 `ignore/p11/rea/tex/wallpaper64.exe`）。
- 新读的二进制（只读副本在 `ignore/p11/rea/tex/bin/`）：
  - `winrtutil64.exe`，SHA-256 `42c4801b194bf06408e176d6869407c193e47ad995714ccdcfd5b4e7a0daf1e0`（系统媒体会话、封面解码与配色、快捷方式图标）；
  - `resourceutil64.dll`，SHA-256 `153cb1e273984b5c7a77b10d62089d50fcde3e187787d839918b59a81c8bfc24`（FreeImage 封装：`LoadUnknownImageBitsFromPath`、GIF、`GetDominantColor` 等导出）；
  - `mediaextensions64.dll` `898ffaa0…`、`resourcecompiler64.exe` `09957ab6…`：只扫了字符串，前者是音频解码库，与纹理无关。
- 方法：REA 的 MCP 服务端是多个代理共用的单会话，打开后很快被另一个代理切到它的目标，Ghidra 首次分析又在 330 s 超时，所以**没用 REA**（拷来的 `work.rea-snapshot` 未改动，也没另存 `-p11-tex` 快照、没调 `close_binary`，以免关掉别人的会话）。改用本机 Ghidra 12.1.4 无界面模式自建三个工程（`gh/proj` wallpaper64、`gh/projw` winrtutil64、`gh/projr` resourceutil64），脚本 `gh/scripts/DecompList.java`（按地址反编译）、`XrefDecomp.java`（引用者 + 反编译）、`DecompTree.java`（按调用深度反编译）。关键段落用 `ignore/p4/rea/wp.asm` 切片核对。
- 工作文件 `ignore/p11/rea/tex/`：`dc/ dc3/ dc4/ dc5/ dc7/ dc8/`（wallpaper64 反编译）、`dcw/`（winrtutil64）、`dcr/`（resourceutil64）、`f_*.asm`（切片）、`s2.py`（任意 PE 的 ASCII/UTF-16 串）、`rdw.py`（任意 PE 读常量）、`exp.py`（导出表）、`riprel.py`、`rtti.py`、`chk.py`，以及从 `ignore/p10/rea/` 借来改了路径的 `pe.py`、`fn.py`、`slice.py`、`xr.py`、`grepfn.py`、`ptr.py` 等。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。

**命名**
- `R` 渲染器，`ctx = R + 0x10`；`P = ctx + 0x1708`（= `R + 0x1718`，绑定管理器），`P+8 = ctx`，`P+0x140 = M`（媒体状态），`P+0x148`（异步图标状态）。`ctx+0x1848` 在用户纹理里也被当作 `M` 读【推：同一对象】。
- `ctx+0x158`：`DesktopMediaExtensions`（虚表 `0x140485fe0`；`+0x60` `LoadUnknownImageBitsFromPath` 包装 `0x1400c4820`，`+0x68` 释放，`+0x108` `openUserShortcut` `0x1400c5090`（「User shortcut blocked.」），`+0x110` 取快捷方式图标 `0x1400c5760`，`+0x118` 释放，`+0x120` 启动 `-mediainterface` `0x1400c66d0`，`+0x130` 建视频播放器，`+0x140/+0x148/+0x150` GIF 打开 / 取帧 / 关闭；后两组的用途按 `FUN_1400eb570` 的调用方式定，函数体没读【推】）。
- `ctx+0x1518`：渲染设备，虚函数 `+0x50` = `FUN_14009ac80` → `FUN_1400eb570`（建用户纹理，对象 0x170 字节，虚表 `0x140487088`）。`ctx+0x1520`：纹理管理器；`ctx+0x1630`：材质管理器；`ctx+0x1670`：待刷新材质集合；`ctx+0x1898`：文件系统。
- `mat`：材质 pass 对象。`mat+0xd0+8·i` 槽 i 的纹理；`mat+0x200` 材质文件名；`mat+0x220/+0x228` `instance` 覆盖 JSON；`mat+0x270` 槽号 → 槽状态的 `unordered_map`；`mat+0x2b0/+0x2b2` 参考宽高（u16）；`mat+0x1f8` bit2 = 本 pass 有用户纹理生效；`mat+0x2f8` 槽 0 就绪回调句柄。
- 槽状态（0x38 字节）：`+0` 绑定对象，`+8` 描述符，`+0x10` 当前值（`std::string`），`+0x30` `keepaspect`。
- 绑定对象（0x60 字节，虚表 `0x14048b700`）：`+8` mat，`+0x10` 描述符，`+0x18` 来源类型（0 属性、1 system、2 usershortcut），`+0x20` 属性名。
- 加载请求（`FUN_1401556e0` 的 `local_268`，即 `FUN_1400eb570` 的 `param_3`）：`+0` 纹理名，`+0x20` 纹理标志，`+0x24` 目标宽高比（float，0 = 不裁），`+0x28` 是否 system，`+0x29` 是否 usershortcut。

---

## 1. `usertextures` 的解析（`FUN_140154480`，`0x140154480`–`0x140155668`）【确】

```
uts = pass["usertextures"]                       // 0x140154685
if uts 是数组:
  for i in 0 .. len-1:                           // i 即槽号
    item = uts[i]
    if item 是字符串:      name = item; type = 0; keepaspect = 0
    elif item 是对象:
      name = item["name"]（字符串才取，否则空）
      t = item["type"]（字符串才看）: "system" → 1, "usershortcut" → 2, 其它 → 0   // 0x140154870 一带，同 FUN_140153700
      keepaspect = item["keepaspect"] 是 JSON 布尔且为 true                       // 0x140154871
    else: continue                               // null、数字等
    if name 为空: continue
    desc = new 0x58 { type 5, slot i, setter FUN_1401538d0, name }
    bind = new 0x60 { vt 0x14048b700, mat, desc, 来源类型, 属性名 }
    st   = new 0x38 { bind, desc, value = "", keepaspect }
    v = 累计全集[name]                            // ctx+0x1718（R+0x1728）
    if v 存在 且 v["value"] 是字符串: st.value = v["value"]
    FUN_140175880(P, bind)                       // 登记：属性名 → 绑定
    mat.slotMap[i] = st                          // mat+0x270
FUN_1401556e0(mat, pass)                         // 0x140154bbc：解析 textures
```

- 名字比较大小写敏感（`strcmp`）；`type` 写别的值（包括 `"user"`）都按属性处理。
- 属性名不在全集里时槽状态值为空 → 缺省纹理。例：`3643916956` 的 `usertextures` 引用 `imagevideoimport`，但它的 `project.json` 没声明这个属性，这两个槽永远是缺省纹理（`ignore/p11/rea/tex/proj_3643916956.json`）。
- 纹理名里的比例用 `roundf`（`FUN_1402edef0`：`shr` + `adc`，四舍五入远离 0）。
- 解析函数只认传进来的 pass JSON。effect pass 与对象 `instance`：
  - 材质刷新 `FUN_140150d60` 在重跑前，若 `mat+0x228` 是对象（`instance` 覆盖）就用 `FUN_140153200` 合进 `passes[0]`（`0x140150ee8`），合并后的 `usertextures` 照上面解析【确】；
  - effect pass 也是材质对象，走同一套解析【推：调用方没逐个追，实测已确认 effect pass 同样生效】。
- `combos`、`constantshadervalues`、`usershadervalues` 的处理在同一函数里，见 P3 报告。

## 2. 纹理解析与换纹理

### 2.1 setter 与待刷新集合【确】

- setter `FUN_1401538d0(bind, desc, value)`：按 `desc` 的槽号在 `mat+0x270` 找槽状态；`value` 是字符串取其内容，否则当空串；与 `st.value` 不同才赋值，并把 `mat` 插进 `ctx+0x1670` 集合（`0x140153a8c`–`0x140153c9c`）。同值重发不入集合。
- 集合的其它访问：`ctx` 构造 `0x14017d210` 一带初始化；`FUN_140209563` 一带（`0x140209cc5`–`0x140209e31`）是材质销毁时把自己从集合里摘掉；`0x14017ef97` 是卸载时清空。
- **消费者 `FUN_140150d60(mm = ctx+0x1630)`**（`0x140150d60`–`0x14015117a`）：
  1. 集合为空直接返回（`[mm+0x50]`）；
  2. 对每个材质：注销槽 0 纹理的就绪回调；按 `mat+0x200` 重新读材质文件（`FUN_1400d3f80`，经 `ctx+0x1898`），取 `passes[0]`；`mat+0x228` 是对象时合进 `instance` 覆盖；调 `FUN_1401556e0(mat, pass)`；重挂槽 0 就绪回调 `FUN_140157780`，槽 0 纹理变了就立即调一次（让图层重算 `autosize` 等，见 rea-p5 §6.2、§7）；
  3. 清空集合（`0x1401510b6`），再让资源管理器回收不用的纹理（`[mm+0x80]+0x158` 的虚函数、`FUN_1401511b0`）。
- 调用点（`xr.py`）：
  - `FUN_14017fa70`（帧函数）开头 `0x14017fd1a`：每帧第一件事；
  - `FUN_140171440`（每帧脚本函数，帧函数 `0x1401802e5` 调）：封面消息处理完 `0x140171f56`、异步图标完成 `0x1401722e5`。
- 所以：
  - 运行中改属性（P3：帧间消息泵里同步处理 → `FUN_1401731d0` 直接绑定 → setter）→ 下一帧开头换好，这一帧就画新纹理；
  - 首次加载：解析期直接用全集的初值，不经集合；
  - 封面：脚本函数里把增量走 `FUN_1401731d0`、随即 `FUN_140150d60`，同一帧渲染前换好。脚本函数在帧函数里的位置见 rea-framework（P4c：粒子 → 脚本 → 渲染）。

### 2.2 `FUN_1401556e0(mat, pass)`（`0x1401556e0`–`0x140155f94`）【确】

```
mat.flags(+0x1f8) &= ~4
tex = pass["textures"]; 不是数组就返回
n = min(len(tex), 10)
for i in 0 .. n-1:
  name = tex[i]; 不是非空字符串 → continue           // 这一槽不绑任何纹理
  st = mat.slotMap[i]
  if st 不存在 或 st.value 为空:  goto 缺省
  type = st.bind.type
  if type == 0 且 !FS(ctx+0x1898).exists(st.value):  goto 缺省   // 虚函数 +0x60，0x140155858 一带
  (W, H) = usertexturereference 的 width/height（对象、两者都是数字、都非 0）
  否则 (W, H) = 缺省纹理 name 的信息（FUN_14014d500，0x140155a23）：
           标志位 4（精灵表）→ 帧尺寸；否则图像尺寸
  if W == 0 或 H == 0:  goto 缺省
  mat.ref = (W, H)                                   // +0x2b0/+0x2b2
  a = W / H
  key = (type == 2 ? "usershortcut_" : "") + st.value + "x" + (int)roundf(a·10)   // 0x140155axx–0x140155bxx
  t = 纹理管理器.find(key)                           // FUN_14014cf90(…, 0)
  if !t:
    req = { key, flags = 8 | (缺省纹理标志 & 2 或 type == 2 ? 2 : 0) | (缺省纹理标志 & 1),
            aspect = st.keepaspect ? 0 : a, isSystem = type == 1, isShortcut = type == 2 }
    t = ctx+0x1518 → vfunc +0x50(st.value, req)      // FUN_1400eb570
    if t.flags & 0x40000000:  释放 t; t = null       // 建失败
    else:
      if st.keepaspect: mat.ref = t 的图像尺寸        // +0x2c, +0x30
      纹理管理器.add(t)
  if t: mat.flags |= 4; mat.tex[i] = t; continue
缺省:
  mat.tex[i] = 纹理管理器.load(name, 1)              // FUN_14014cf90(…, 1)，0x140155eff
```

- 缺省纹理信息的偏移：`FUN_14014d500` 把纹理对象 `+0x18` 起的块拷进输出（`0x14014d6xx`，见 `dc5/f_14014d500.c` 192 行），输出 `+4` 是标志（纹理 `+0x1c`），`+0x14/+0x18` 是纹理 `+0x2c/+0x30`（图像尺寸，rea-p5 命名表）；精灵表时改读帧尺寸（纹理 `+0xb0/+0xb4`）（`0x140155a2c`–`0x140155a44`）。
- `keepaspect` 只把比例置 0（`0x140155d1x` 一带，`local_244 = 0`），比例 0 时 `FUN_1401702f0` 原样拷贝。
- 纹理名带比例，所以同一文件绑到不同比例的槽是两张不同的纹理；同比例的槽共用一张。
- `mat+0x1f8 |= 4` 的后果见 rea-p5 §6.2（组合层 / instanced 颜色强制为白、`autosize` 取参考尺寸）。

### 2.3 用户纹理的建立（`FUN_1400eb570`，`0x1400eb570`–`0x1400ec02d`）【确】

对象 0x170 字节，虚表 `0x140487088`，构造时标志 = `req.flags | 0x40000000`（「未就绪 / 失败」），格式 `+0x160 = 0x1c`。按来源分支：

| 来源 | 条件 | 做法 |
|---|---|---|
| 属性 + 视频 | 扩展名（`FUN_14016ff50`，表 `0x14048a7f8`… `0x140488af8`）是 `.mp4 .wmv .avi .m4v .mov .mkv .webm` | `ctx+0x158` 虚函数 `+0x130` 建播放器，渲染目标纹理 `Bind SRV|RT`；按比例算 UV 裁切（左右或上下各裁 `(1 − 比)/2`，`+0x28` 虚函数）；HDR 视频且设备支持时格式 `R16G16B16A16_FLOAT`（10）；播放器建不起来 → 64×64 黑占位，并清掉失败位 |
| 属性 + GIF | 扩展名正好是 `.gif`（4 字节比较，`0x140487000`，大小写敏感） | `+0x140` 打开、`+0x148` 取帧（【推】包装 `resourceutil64` 的 `OpenGIF`/`AdvanceGIF`）；`Usage DYNAMIC`、`CPUAccess WRITE`、`MipLevels 1`；按比例算居中的源偏移（`+8`、`+0xc`，系数 0.5） |
| 属性 + 其它 | 以上都不是 | `+0x60`（`LoadUnknownImageBitsFromPath`）读成 RGBA → `FUN_1401702f0(…, a)` 裁切（`0x1400ebe48`：`xmm3 = req+0x24`）→ `+0x68` 释放 |
| system | `req.isSystem` | `M = ctx+0x1848`；值等于 `M+8` 用块 `M+0x108`，否则 `M+0x160`；块的数据非空且 `+0x38`（宽）、`+0x3c`（高）都非 0 时 `FUN_1401702f0(数据, 宽, 高, a)`（`0x1400ebc3d`：`xmm3 = req+0x24`） |
| usershortcut | `req.isShortcut` | `FUN_140174710(P, 值, …)` 取图标 RGBA；比例非 0 时**补透明边**：`w/h ≤ a` → 宽补到 `(int)(h·a)`、左右各 `(w' − w)>>1`；否则高补到 `(int)(w/a)`、上下居中；之后经 `+0x118` 释放 |

静态图、封面、图标三支汇合到 `0x1400ebe7e`：
- 纹理尺寸与图像尺寸都写成结果宽高（`+0x20/+0x24`、`+0x2c/+0x30`）；
- `D3D11_TEXTURE2D_DESC`：`MipLevels 1`（`local_c8`）、`Format 0x1c`（`local_c0`）、`Usage 1` IMMUTABLE、`BindFlags 8`；
- SRV 格式同纹理；采样器 `FUN_140099980(flags, 1)`：
  - `flags & 1` → 点采样（`Filter 0`）；否则 `0x15`（MIN_MAG_MIP_LINEAR，第三参 1 时）；
  - 寻址 U/V/W = `(flags & 2) | 1`（1 WRAP、3 CLAMP），`flags & 0x4000000` 时 4（BORDER）；
  - `MaxAnisotropy 1`、`MaxLOD FLT_MAX`；
- 成功清掉 `0x40000000`；任何一步失败都留着它 → `FUN_1401556e0` 退回缺省纹理。

**属性图片的解码**（`resourceutil64!LoadUnknownImageBitsFromPath` `0x180001520` → `FUN_180009c40`）：路径 UTF-8 → UTF-16；`FreeImage_GetFileTypeU`（按内容）→ `FreeImage_LoadU(type, path, 10)` → `ConvertTo32Bits`（失败时先 `ConvertToStandardType` 再转）→ `FlipVertical` → 拷出并调 `FUN_1800049e0`（【推】BGRA → RGBA）；结果帧数不是 1 → 失败。直通 alpha、不预乘【推：FreeImage 32 位本身不预乘】。

## 3. 封面纹理 `$mediaThumbnail` / `$mediaPreviousThumbnail`

### 3.1 系统会话进程（`winrtutil64.exe -mediainterface`）【确】

- 入口：`main` 一带 `FUN_140037500` 认 `-mediainterface` → `FUN_140031fb0`（RTTI 名 `RunMediaInterface`）。wallpaper64 侧由 `DesktopMediaExtensions` 虚函数 `+0x120`（`0x1400c66d0`）拉起，环境变量 `__WPXProviderAPIMediaControlPID` 一带。
- 主循环把会话变化打包发回（`FUN_140054310`），消息头 `u32 2`（版本）后：
  - 消息 1 属性：7 个字符串（各有长度上限 0x400 / 0x100）+ 会话 ID；
  - 消息 2 封面：5 个 `u32` 颜色、`ContentType` 字符串、`i32` 字节数 + 数据、会话 ID。**只在 PNG 字节与上一次不同时发**（`0x140032b59` 一带的 `memcmp`）；
  - 消息 3 播放状态（`i32`），消息 4 时间轴（两个 float），只在变化时发；
  - 消息 10 图标结果（路径、宽、高、字节数 + PNG），见第 5 节。
- 缩略图协程 `FUN_140046c20`：
  1. `OpenReadAsync` 读完整个流；读不出（`0x1400469xx` 的 `CanRead` 一类判断）或长度 ≤ 1 → 不带封面的事件；
  2. `ContentType` 转小写，等于 `image/png` → wuffs PNG（像素格式 `0xa1008888` = `RGBA_NONPREMUL`）；否则 `FUN_140066920`（FreeImage：内存加载，ICO 取面积最大的页，其它 `LoadFromMemory(…, 10)`，转 32 位，`FlipVertical`，BGRA → RGBA）；
  3. 来源 App ID（事件 `+8`，转小写）以 `spotify` 开头时（`0x140047e39`）：
     - 若 `(0.06w, 0.4h)` 与 `(w − 0.06w, 0.4h)` 两点 alpha 都是 0：从 `x = (int)(0.06w)` 向右找第一个 alpha ≠ 0 的列 `L`（最多走 `w/2` 步），满足 `0 ≤ L < 0.4w` 且 `0 ≤ 2L − w + h < 0.4h` 时，裁成左上角在 `(L, 0)`、边长 `w − 2L` 的正方形；
     - 否则若 `(w/2, 0)` 的 alpha 是 0：在 `y ∈ [77, 227)`、`x ∈ [44, 256)` 内把 alpha ≠ 255 的像素改成灰 `(a, a, a, 255)`；
     （常数 `0x14034c64c` = 0.06、`0x14034c658` = 0.4）【确：代码；用途【推】是去掉 Spotify 的透明边和角标】
  4. `FUN_140065590` 算三色（第 4 节），`FUN_14002db80` 算文字色与高对比色；
  5. RGBA → BGRA（`FUN_140007780`）后 `FUN_140066b90` 用 FreeImage 编 PNG：最大边参数（`+0x10`）为 0 → **不缩放**，`FlipVertical` 后 `SaveToMemory(PNG)`；`ContentType` 改成 `image/png`；
  6. 入队（`FUN_14003ac40`）。没封面、解码失败时颜色字段保持 0。
- 消息 2 里 5 个颜色的顺序 = 事件 `+0x150…+0x160`：主色、次色、第三色、高对比色、文字色（主循环 `0x140032bxx` 依次写 `local_508…local_4f8`）。打包 `0xAABBGGRR`（字节 0 = R），alpha 0xff；文字色为黑时是 `0`（alpha 也是 0）。

### 3.2 wallpaper64 侧【确，另注明的除外】

- 接收：`DesktopMediaExtensions` 的接收 lambda `FUN_1400cbaa0`：消息 2 解出五色、`ContentType`、数据，存进 `+0x600` 块、标志 `+0x4f0 |= 2`。（反编译里数据拷贝长度写成「字节数 − 1」，没用汇编核对，【未知】是否真的少 1 字节；对 PNG 解码大概率无影响。）
- 交给场景：轮询函数 `0x1400c1b16` 一带与建事件函数 `0x1400c7707` 一带把块拷出，需要像素时用 `FUN_1400c0710`（wuffs PNG，`RGBA_NONPREMUL`）解成 RGBA，宽高写进块 `+0x38/+0x3c`（`0x1400c7856`、`0x1400c1ccf`）。场景的媒体状态 `M` 存的是**解码后的 RGBA**。
- 每帧脚本函数 `FUN_140171440` 取事件（`M+0x1c8` 队列）；事件标志位 2（封面，`0x1401716xx`–`0x140171a8d`）：
  ```
  M.prev(+0x160) = M.cur(+0x108); M.cur = 新块
  old = M.name(+8)
  M.name = "mediaThumbnail_" + to_string(M.counter(+4)) + ".system"
  delta = { "$mediaThumbnail": { "value": M.name } }
  if old 非空: delta["$mediaPreviousThumbnail"] = { "value": old }
  P.增量(+0x38) = delta; P.全集(+0x10) = 合并(全集, delta)
  FUN_1401731d0(P)                      // 直接绑定 → setter → 材质入集合；没有 type → 不进 applyUserProperties
  M.counter += 1
  ```
  队列取空后若处理过封面就 `FUN_140150d60` 立即刷新（`0x140171f56`）。
- 其它标志（给脚本侧代理参考）：1 属性、4 播放状态（回调号 `0xf`）、8 时间轴（`0x12`）、`0x10` 状态（`0xe`），经 `FUN_140177ad0(P, 0, 0, 号)` 派发。
- 建纹理按名字选块（2.3 表 system 行）：
  - 名字 = 当前名 → 当前块；否则 → 上一块。`$mediaPreviousThumbnail` 的名字恰好是上一条的当前名，所以取到上一条的图；
  - 块里没数据或宽高为 0（会话没封面）→ 建不成 → 缺省纹理；
  - 裁切同属性图片（按槽的缺省纹理比例，`keepaspect` 时不裁），格式、采样器同 2.3。
- 没有媒体会话、关掉 `mediaintegration`、非 Windows：没有封面事件 → 两个伪属性不在全集里 → 槽状态值为空 → 缺省纹理。【推：`mediaintegration` 只在 `0x1400481ed`、`0x14006cd95` 读，没逐行追它是否连 `M` 都不建；结论不受影响】
- 同一张封面重复出现（字节相同）不会发新消息 → 名字与 previous 都不变。换歌但封面字节相同时 previous 不更新。【确：winrtutil 侧的比较】

## 4. 封面配色算法（`winrtutil64.exe`）【确】

### 4.1 三色：`FUN_140065590(pix, w, h, &c1, &c2, &c3)`（`0x140065590`）

输入是 RGBA（字节 0 = R）、自上而下。外层按列、内层按行（顺序不影响结果）。

```
for 每个像素 p:
  if p.a < 16: continue                 // 条件是 u32 > 0x0FFFFFFF，即 alpha ≥ 0x10
  r, g, b = p.rgb / 255.0f
  M = max(r,g,b); m = min(r,g,b); d = M − m
  if d < 1e-5 或 M <= 0:  bin = 0; s = 0
  else:
    s = d / M
    if r < M:
      if g < M: h = (r − g)/d + 4.0     // b 最大（double 加法后转 float）
      else:     h = (b − r)/d + 2.0     // g 最大
    else:       h = (g − b)/d           // r 最大
    h = h / 6; if h < 0: h += 1
    bin = min((int)(h · 360), 359)       // 负数夹到 0
  S[bin] += s;  V[bin] += M;  W[bin] += (int64)(int)(M · s · 100);  N[bin] += 1
```

```
// 主色：W 最大（严格大于才替换，初值 0，所以全 0 时不选任何格）
best = 0; for i in 0..359: if W[i] > best: best = (int)W[i]; p = i
c1 = HSV(p/360, S[p]/N[p], V[p]/N[p])

// 次色：W[i] · d(i,p)/180，d = |p − i|，> 180 时取 360 − d
best = 0; for i: x = (float)W[i] · (d(i,p)/180); if (float)best < x: best = (int)x; q = i
c2 = HSV(q/360, S[q]/N[q], V[q]/N[q])

// 第三色：W[i] · (d(i,p)/180 · d(i,q)/180)²
best = 0; for i: k = (d(i,p)/180 · d(i,q))/180; x = (float)W[i] · k · k; if (float)best < x: best = (int)x; r = i
c3 = HSV(r/360, S[r]/N[r], V[r]/N[r])
```

- 没有任何格被选中时（全透明、或全是灰色 `s = 0` 且 `W = 0`），对应的 `h, s, v` 保持 0 → 黑；次色、第三色的初值也是 0（`fVar16/21/15`、`fVar20/19/18` 初始化为 0）。
- 灰色像素（`s = 0`）进第 0 格但权重 0，只拉低第 0 格的平均 `s`、`v`。
- 比较用 `(float)best < x`、`best = (int)x`：best 截断成整数后再比，平局取先出现的格。
- HSV → RGB（`FUN_140063cc0`）：`C = v·s`，`h' = fmod(h·6, 6)`（double），`X = C·(1 − |fmod(h', 2) − 1|)`，`m = v − C`；扇区 `[0,1) (C,X,0)`、`[1,2) (X,C,0)`、`[2,3) (0,C,X)`、`[3,4) (0,X,C)`、`[4,5) (X,0,C)`、`[5,6) (C,0,X)`，加 `m`。
- 量化：各分量 `(int)(x · 255)`，夹到 [0, 255]；打包 `b<<16 | g<<8 | r | 0xff000000`。

### 4.2 文字色与高对比色（`FUN_140046c20` `0x14004806x`–`0x1400482cf`）

```
L(c) = 0.2126·lin(R) + 0.7152·lin(G) + 0.0722·lin(B)
lin(x) = x > 0.03928 ? powf((x + 0.055)/1.055, 2.4) : x / 12.92     // x = 分量/255
contrast(a, b) = (max(La, Lb) + 0.05) / (min(La, Lb) + 0.05)

text = contrast(c1, 黑) < 2.5 ? 0xFFFFFFFF : 0x00000000
k2 = contrast(c1, c2); k3 = contrast(c1, c3)
if k2 >= 2.5 且 k2 > k3:  high = c2
elif k3 >= 2.5:           high = c3
else:                     high = text
```

常数（`winrtutil64` `.rdata`）：`0x14034c640` 0.03928、`0x14034c648` 0.055、`0x14034c664` 1.055、`0x14034c690` 2.4、`0x14034c6bc` 12.92、`0x14034c654` 0.2126、`0x14034c65c` 0.7152、`0x14034c650` 0.0722、`0x14034c644` 0.05、`0x14034c694` 2.5、`0x14034c6dc` 255、`0x14034c6e0` 360、`0x14034c6d8` 180、`0x14034c6d4` 100、`0x14034c63c` 1e-5、`0x14034c6b8` 6、`0x14034c678` 2.0（double）、`0x14034c680` 4.0（double）。

- 配色在原尺寸、Spotify 处理之后的像素上算，不缩小采样。
- wallpaper64 只转发这五个 `u32`，网页壁纸（`CEFWallpaper` 的 `MediaIntegration::Event`）与场景用的是同一组【确：只有一处来源】。到脚本时除以 255 成 `Vec3`、文字色为 0 时是 `(0,0,0)`【推：wallpaper64 侧的转换没逐行读，交给脚本侧代理核】。
- `resourceutil64.dll` 另有导出 `GetDominantColor` / `GetDominantColorFromImage`，wallpaper64 有它们的名字串（`0x1404864c0`、`0x140489198`），与封面配色无关【推：没追调用者，推测给壁纸主题色用】。

## 5. 快捷方式图标【确，另注明的除外】

- **wallpaper64 取像素**（`FUN_140174710(P, 槽值, &像素, &w, &h)`）：
  1. `FUN_1401708c0` 把属性值解析成「命令类型 + 目标」【未知：值的编码没读，P3 说脚本侧形状是 `{isbound, commandtype, file}`】；命令类型为 `web` 时按网址处理；
  2. `DesktopMediaExtensions` 虚函数 `+0x110`（`FUN_1400c5760`）：键 = 目标字符串的 SHA-256；查内存表（从某目录下的 `thumbnail.cache` 读【未知：目录】，头 `SHTC0001`，条目记宽 `+0x20`、高 `+0x24`、文件偏移 `+0x28`、长度 `+0x2c`），命中就读出并用 `FUN_1400c0710`（wuffs PNG）解码返回；
  3. 没命中且 `winrtutil` 在跑：发请求（消息 8 文件 / 程序，9 网址，内容只有目标字符串，**不带尺寸**），登记到等待集合；`FUN_140174710` 在 `P+0x148` 记「目标 → 槽值」，本次返回失败 → 缺省纹理；
  4. 结果回来后写缓存，`FUN_140171440` 取到完成的目标，把槽值相同的材质插进集合并刷新（`0x1401720xx`–`0x1401722e5`），再建一次就命中缓存。
- **winrtutil 取图标**（消息 8 → `FUN_14002ee30`；9 → `FUN_14002fb10` 网站图标（正则 `rel\W*=\W*"(shortcut|icon|\W+)+"`）→ 失败时 `FUN_14002f990` 用 `../assets/materials/util/webthumbnailfallback.png`）：
  - 目标没扩展名时 `SearchPathW(…, ".exe")` 补全；
  - `.lnk`：`CoCreateInstance(ShellLink)` → `IPersistFile::Load` → 图标位置 `"%[^,],-%d"` → `LoadLibraryExW(AS_DATAFILE)` + `LoadImageW(id, IMAGE_ICON, 256, 256)`；
  - `.url`：`GetPrivateProfileStringW("InternetShortcut", "IconFile")` + `IconIndex` → `PrivateExtractIconsW(…, 256, 256)`；
  - 其它或前面取不到：`SHGetFileInfoW(SHGFI_SYSICONINDEX…)` → `SHGetImageList(SHIL_JUMBO)` → `FUN_14002e860` 取 `HICON`；
  - `FUN_14002de50`：`GetIconInfo` 取颜色位图的高 `cLines`，按 `cLines × cLines` 建位图 `DrawIconEx(DI_NORMAL)`、`GetDIBits` 32 位自上而下，BGRA → RGBA；所以图标是**正方形、边长 = 图标颜色位图的高**（请求 256 时通常 256×256）；
  - 去预乘：`rgb = (int)(rgb / (a/255))`（a = 0 时除以 0，结果由 CPU 浮点转换决定【未知】）；`FUN_140066ef0`：OpenCV 对 `CV_8UC4` 同尺寸就地处理一遍【未知：哪种处理没读】；RGBA → BGRA；`FUN_14002e5e0` FreeImage 编 PNG，消息 10 回传。
- **成纹理**：2.3 表 usershortcut 行，补透明边、`CLAMP`、`R8G8B8A8_UNORM`、1 级 mip；纹理名 `usershortcut_<槽值>x<round(a·10)>`。没配置（值为空）→ 缺省纹理；取不到图标 → 缺省纹理。
- `openUserShortcut` 在 `DesktopMediaExtensions` 虚函数 `+0x108`（`FUN_1400c5090`，含「User shortcut blocked.」）——留给脚本侧代理。

## 6. 音频 uniform 复核

- 编号与拷贝见 rea-p4e 3.4。常量填充函数 `0x1400d8300`（入口先判 `r8b`：程序有没有动态常量）只由着色器程序对象虚表 `0x140486ef8` 的两个槽调用：`0x1400d7440`（`+8`）与 `0x1400d7790`（`+0x10`），每个槽调三次（`0x1400d7519`、`0x1400d7596`、`0x1400d7613`；【推】对应各着色器阶段的常量缓冲）。这两个槽是绘制前绑定程序、提交常量的入口，所以**每次绘制都按当时的 `ctx` 三块重填**，不是每帧一次【确：调用链；「每次绘制都经这两个槽」【推】】。
- 三块每帧在帧函数之前算一次、帧内不变（rea-p4e 3.5），所以同一帧所有 pass 读到同一份值；effect 中间 pass、粒子与图像层用同一个程序类【推】。
- 没声明 `supportsaudioprocessing`：帧函数不碰三块，保持构造时的 0（rea-p4e 4.4；实测已确认全 0）。
- 着色器读这六个 uniform 不会打开采集：采集线程的启停只看工程开关与用户的「音频录制」（rea-p4e 4.3 `FUN_14006e0c0`），没有按着色器反射的分支【确：读过启停条件；没有在着色器编译路径里找到相关写入】。

## 7. 对 Kabegame P11 的含义（代理建议）

- 编译期：每个槽记 `{来源, 属性名, keepaspect, 缺省纹理名}`；`textures[i]` 为空的槽忽略 `usertextures[i]`；比例取缺省纹理的**图像**尺寸（精灵表取帧尺寸），`usertexturereference` 优先。
- 运行期：「纹理来源」按 `(值, 比例)` 缓存；改值后下一帧开头换（rAF 开头处理完属性消息即可）；值空、文件不存在、解码失败 → 缺省纹理，不保留上一张。
- 解码：`createImageBitmap` 即可（直通 alpha、`R8G8B8A8_UNORM` 非 sRGB、1 级 mip、线性、寻址跟缺省纹理）；居中裁切照 2.3 的取整（`(int)` 截断、`>>1`）。GIF / 视频分别给细分键，或接 P9 的视频纹理。
- 封面：`WpeMediaHub` 已有 PNG。宿主自己维护 `当前 / 上一张` 两块，仅在字节变化时轮换；裁切规则同属性图片；没有封面 → 缺省纹理。
- 配色：照第 4 节改 `colors.rs`，网页壁纸与场景共用；注意 Spotify 预处理（可选）。
- 图标：后端取 256 边长的正方形图标（Windows），按比例补透明边、`CLAMP`。

## 留给实测的问题

| # | 问题 | 怎么测能区分 |
|---|---|---|
| 1 | 封面配色是否逐字节等于第 4 节（含次色 / 第三色的取整、灰图全 0、Spotify 预处理） | SMTC 夹具依次发几张已知封面（纯色、两色对半、三色条、灰度图、带透明边的 PNG），脚本把 `mediaThumbnailChanged` 的五色打进 `[kbp]` 日志；Python 照第 4 节复算比对。再用 `ContentType` 为 `image/jpeg` 的封面各一张，核 FreeImage 路径 |
| 2 | `$mediaPreviousThumbnail` 的轮换与「字节相同不发」 | 夹具连发 A、B、B、C：抓帧读两个封面槽，预期 (A,—)、(B,A)、(B,A)、(C,B)；第一张之前 previous 槽是缺省纹理 |
| 3 | 封面是否按槽缺省纹理比例居中裁、原尺寸不缩放 | 夹具发 640×360 的封面，槽的缺省纹理分别是 1:1 与 16:9，抓帧读封面纹理尺寸：360×360（x∈[140,500)）与 640×360 |
| 4 | 没有封面（会话存在但无缩略图）、关掉 `mediaintegration` 时两个槽 | 夹具发一个不带缩略图的会话；改 WPE 设置关媒体集成各抓一组：预期都是缺省纹理 |
| 5 | 快捷方式图标的尺寸与补边 | 配一个 `.exe` 快捷方式（只读，不点击），绑到 1:1 与 16:9 的槽：预期纹理 256×256 与 455×256 左右（`(int)(256·16/9)`），两侧透明，采样器 Clamp；再配一个只有 32×32 图标的程序看是否被放大到 256 |
| 6 | GIF / 视频作为 `scenetexture` | 选一张 GIF 和一段 mp4：抓帧看纹理是否随帧更新、尺寸是否按比例裁（GIF 为 DYNAMIC 纹理，视频为 RT） |
| 7 | 去预乘后的 OpenCV 处理（`FUN_140066ef0`）和 a = 0 像素的颜色 | 用带半透明边缘的图标，读纹理边缘像素的 rgb 与 alpha |
| 8 | 每次绘制都重填音频 uniform | 同一帧里 effect 中间 pass 与粒子 pass 各读一次 `g_AudioSpectrum16Left` 常量缓冲，预期逐值相同 |
