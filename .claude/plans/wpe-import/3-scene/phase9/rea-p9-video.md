# REA：P9 步骤 0 —— 场景视频纹理的解码、进纹理、时钟与脚本 API（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出（只做静态分析，没有运行或附加 WPE）。置信度三档：**静态确认**（反编译或汇编直接看到）、**推断**（由代码推出，或依赖 Media Foundation 自身的行为）、**未知**。
> 反编译出的字符串与代码只当数据看。地址一律是镜像基址 `0x140000000` 下的虚拟地址。

## 方法

- 分析副本：`d:\Codes\kabegame\ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`（开工时原件与副本都用 `sha256sum` 复核，一致）。
- REA（Ghidra 12.1.4）从 P7d 的快照副本 `ignore\p9\rea\wallpaper64-2.8.42-p7d.rea-snapshot` 打开，结束时另存 `ignore\p9\rea\wallpaper64-2.8.42-p9.rea-snapshot`。
- 汇编按地址切自 `ignore\p4\rea\wp.asm`（全量反汇编）；常量、字符串、GUID、虚表用脚本直接读副本。脚本与摘录都在 `ignore\p9\rea\`：
  - 脚本：`strs.py` / `wstrs.py` / `cs.py`（字符串）、`guid.py`、`rd.py`、`vtdump.py`、`ptr.py`（找含某地址的虚表槽）、`xr.py` / `gall.py` / `grepfn.py`（`wp.asm` 交叉引用与按函数 grep）、`near.py` 系列（「读 `+0xd8` 后调某槽」）、`imm.py`（找置渲染位 17 / 18 的立即数）。
  - 汇编摘录 `asm\`：`player_methods_1400f2e70.asm`（播放器各方法、每帧更新、工作线程）、`notify_1400f1c40.asm`（事件回调）、`settarget_1400f2510.asm`、`texload_*.asm`（建纹理的视频分支）、`script_ivideotexture_1401fa510.asm`、`getvideotexture_14020e7b0.asm`、`layer_ended_*.asm`（结束回调）、`pauseall_140181960.asm`、`renderloop_pause_140111440.asm`、`vw_flags_1401202a6.asm`、`bytestream_1400facc0.asm` 等。
- 锚点：
  - 字符串 `getVideoTexture`（`0x140490e08`）、`setCurrentTime`（`0x140490ff0`）、`addEndedCallback`（`0x140491068`）的引用 → 脚本方法表登记函数 `FUN_140214050`。
  - 导入：`MFCreateSourceReaderFromByteStream`（`0x140426698`，引用点 `0x1400f2b89`）、延迟导入的 `MFStartup` / `MFCreateDXGIDeviceManager`（引用点在 `FUN_1400f1fa0`）、`CoCreateInstance`（`0x1400f227f`）。
  - 纹理加载 `FUN_1400ec7b0`（rea-p4b-render 的建纹理函数）里的 `test byte ptr [r15+0x1c], 0x20`（`0x1400ed542`，Video 标志）。
  - 材质 pass 绑定 `FUN_140155fc0`（rea-p4a / rea-p5-mesh）末尾的逐槽纹理更新（`0x1401572a0`，摘录 `asm\bindmat_tail_140157240.asm`）。
- 没有 PDB，类没有 RTTI。下文的类名是按行为起的：
  - **播放器 P**：Media Engine 播放器，对象 0x140 字节，虚表 `0x1404871b8`；
  - **包装 V**：脚本的 `IVideoTexture` 对象，0x110 字节，虚表 `0x140491128`；
  - **纹理 T**：`.tex` 纹理对象，虚表 `0x140487088`；
  - **图层 L**：图像图层，虚表 `0x1404911a8`；
  - **`ctx`**：渲染上下文，即 `R+0x10`，`ctx+0x118` 就是 `R+0x128` 渲染标志字（p2-REPORT）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | 解码路径 | 场景视频纹理一律用 **`IMFMediaEngineEx`**（`CoCreateInstance(CLSID_MFMediaEngineClassFactory)`，帧服务器模式：DXGI 设备管理器 + 输出格式 `B8G8R8A8_UNORM`），**不走 `videoframework` 的回退链**，也不读 `videoreadmode` / `videoloopmode` / `videohardwareacceleration` / `videomfstutterhack`，这几个键只存在视频壁纸对象上。字节由自写的、以文件为后端的 `IMFByteStream` 交给引擎：打开 `.tex` 散文件或 `scene.pkg`，只露出 `[mip 数据偏移, +长度)` 这一段，按需从磁盘读，经 `SetSourceFromByteStream(stream, L"video")` 交给引擎。`MFCreateSourceReaderFromByteStream` 只用来先探一下帧尺寸、帧率和 HDR 传递函数。没有硬件解码开关：播放器自建一个带 `VIDEO_SUPPORT` 的 D3D11 设备，有 DXVA 就用。 | 静态确认（「有 DXVA 就用」是 MF 行为，推断） |
| 2 | 进纹理 | 场景纹理是 `R8G8B8A8_UNORM`，尺寸取 mip 0 的宽高，mip 数取 `.tex` 里的 mip 数（语料 1），带 `SHARED_KEYEDMUTEX`，绑定 `SRV | RT`。播放器在**自己的** D3D11 设备上 `OpenSharedResource` 打开它。颜色转换全由 `IMFMediaEngine::TransferVideoFrame`（MF 视频处理器）完成：源矩形归一化 `{0,0,1,1}`，目标矩形 `{0,0,头里纹理宽,高}`，边框色不透明黑。WPE 的着色器拿到的就是 RGB。取帧分两半：工作线程以「2 × 视频帧率 × rate」的频率调 `OnVideoStreamTick`，有新帧就置标志；渲染线程在**某次 draw 绑定这张纹理时**，若有新帧，就在键控互斥下 `TransferVideoFrame`。采样器与普通纹理同一套（按纹理标志）。 | 静态确认（「怎么换算 BT.709 limited」是 MF 视频处理器的行为，推断） |
| 3 | 时钟 | 用媒体引擎**自己的实时时钟**：不读 `g_Time`、场景 rate、帧时间。纹理建好时就开始播放，第一次工作线程循环会 `Pause → SetCurrentTime(0) → Play`，所以从 0 开始。`loop` 缺省为真（引擎 `SetLoop(TRUE)`，脚本包装也缺省真），循环由引擎自己做。`rate` 同时调 `SetDefaultPlaybackRate` 与 `SetPlaybackRate`，WPE 不钳制。WPE 暂停：音量淡到 0 后对场景里所有视频纹理调 `Pause`；恢复时对所有视频纹理调 `Play`（**连脚本暂停过的也一起放**），从暂停处接着放。属性改动导致重新加载时，纹理重建，从 0 开始（推断）。 | 静态确认（重载为推断） |
| 4 | 可见性 | 不看 `visible` 字段，只看「这张纹理最近有没有被绑定画过」：每次绑定把当前帧号记下来，工作线程发现**超过 30 个渲染帧没被画**，就 `Pause` 引擎；再被画到时 `Play`，**从暂停处接着放**（不追赶）。隐藏期间脚本的 `isPlaying` 仍为真，`getCurrentTime` 冻结。 | 静态确认 |
| 5 | 声音 | 场景壁纸的渲染标志里没有位 17，所以场景视频纹理的媒体引擎带 `MF_MEDIA_ENGINE_FORCEMUTE` 创建，**不出声**，也不受 `videoaudiooutput` 影响。位 17 只有视频壁纸（mfEngine 后端的视频播放场景）会置；那时音量 = 全局音量 `ctx+0x2d8`（设置音量 / 100 × 暂停淡变），不平方。 | 静态确认：引擎侧与「位 17 从哪来」静态确认；「场景从不置位 17」是在全文件范围内搜过立即数，有界确认 |
| 6 | 脚本 | 见第 6 节的成员表。要点如下。`getVideoTexture()` 在材质槽 0 不是视频纹理、或播放器没建成时返回空，结果缓存在图层 `+0x4c0`，和 `getTextureAnimation()` 共用这个槽。`addEndedCallback`：`loop` 为真时，每次检测到当前时间回退（即绕回）触发一次；`loop` 为假时在 `IsEnded` 变真的那一帧触发一次。回调不带参数。`stop()` = `pause()` + `setCurrentTime(0)`，之后 `isPlaying` 为假，`getCurrentTime` 约为 0，但画面停在 `stop` 时那一帧，直到再 `play()`。`setCurrentTime` 不钳制。`duration` 来自 `IMFMediaEngine::GetDuration`，第一次读会**阻塞最多 3 秒**等 `LOADEDMETADATA`。 | 静态确认（回调参数个数、`GetDuration` / `SetCurrentTime` 越界时的取值是 MF / 脚本 dll 的行为，推断） |
| 7 | 失败 | 场景路径**不写日志**。缺 `mfplat.dll`（Windows N）时整个进程弹一次本地化对话框 `core_msgbox_media_feature_pack_missing`。播放器初始化失败时删掉播放器，纹理留着；探测失败时不给引擎设源；解码报错时清「在放」标志。三种情况下纹理都保持初值，或保持最后一帧。 | 静态确认 |
| 8 | 第一帧之前 | 纹理用**全 0** 的初始数据创建，即 RGBA = (0, 0, 0, 0)，透明黑；第一次 `TransferVideoFrame` 之后像素 alpha 为 255。 | 静态确认（「转换后 alpha 为 255」是推断） |

**对 Kabegame 的直接含义**（推断，供 P9a / P9b 子计划参考）：
- `<video>` 静音、`loop = true`、`playbackRate = rate`，加载即从 0 播放，不跟场景时间。
- 纹理初值透明黑。
- 图层连续 30 个渲染帧没画到这张纹理时暂停，再画到时从暂停处接着放。
- WPE 自身暂停 / 恢复时全部视频跟着暂停 / 播放。
- 结束回调按上面的规则在图层每帧更新里判定。
- 解不了的视频保持透明，不报错。

---

## 1. 解码路径

### 结论

1. **类与后端**（静态确认）：
   - 场景纹理的视频播放器由 `ctx+0x158` 的媒体扩展接口创建：虚函数 `+0x130`，真正的虚表头是 `0x140485fe0`，槽在 `0x140486110` = `FUN_1400c7140`。
   - 它只会建一种对象：播放器 P（虚表 `0x1404871b8`），并把 P 登记进 `ctx+0x1460` 的播放器列表。
   - 纹理加载在 `0x1400ed69f` 调它，没有任何按设置挑后端或回退的逻辑。
2. **`videoframework` 回退链只属于视频壁纸**（静态确认）：
   - `FUN_1400ff750` 读 `videoframework`、`videoaudiooutput`（含 `location` 下的覆盖）、`videohardwareacceleration`、`videoloopmode`（`syncclock` = 1，`synctopo` = 2）、`videoreadmode`（`frommemory` = 1）、`videomfstutterhack`。
   - 结果写进视频壁纸对象：
     - `+0x260`：后端名列表，如 `mfEngine`、`mfEngine.muted`、`mf`、`mf.muted`、`dshow.lav.vmr9`；
     - `+0x17c`：标志位 8 / 0x10 / 0x20；
     - `+0x198` / `+0x19c`：循环方式与读取方式。
   - 播放器 P 的代码（`0x1400f1600`–`0x1400f3d00`）不引用这些字段，也不引用视频壁纸对象。它只读 `ctx+0x118`（标志）、`ctx+0x144`（帧号）、`ctx+0x2d8`（全局音量）。
3. **用的是 Media Engine，不是 Source Reader**（静态确认，`FUN_1400f1fa0` = P 的虚函数 `+0x8`，初始化）：
   - 加载与启动：先 `LoadLibraryW(L"mfplat.dll")` 探测（全进程一次），再 `MFStartup(0x20070, MFSTARTUP_LITE)`。
   - 自建 D3D11 设备：`D3D11CreateDevice(NULL, HARDWARE, 0, 0x800 = VIDEO_SUPPORT, {11_1, 11_0, 10_1, 10_0})`，取 `ID3D10Multithread`，`SetMultithreadProtected(TRUE)`，再 `MFCreateDXGIDeviceManager` + `ResetDevice`。
   - 创建引擎：`CoCreateInstance(CLSID_MFMediaEngineClassFactory {b44392da-…}, IID_IMFMediaEngineClassFactory)`。属性：
     - `MF_MEDIA_ENGINE_CALLBACK`（通知对象虚表 `0x140487260`）；
     - `MF_MEDIA_ENGINE_DXGI_MANAGER`；
     - `MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT = 87`（`DXGI_FORMAT_B8G8R8A8_UNORM`）；
     - 静音时另加 `MF_MEDIA_ENGINE_EXTENSION {3109fd46-…}`，扩展虚表 `0x140487280`，见下。
   - `CreateInstance` 的标志 = `0x12 | (静音 ? 0x4 : 0)`，即 `WAITFORSTABLE_STATE | DISABLE_LOCAL_PLUGINS`，静音再加 `FORCEMUTE`；没有 `REAL_TIME_MODE`。
   - 之后 QI 成 `IMFMediaEngineEx`（`{83015ead-…}`）存到 `P+0x58`，调 `SetAutoPlay(FALSE)`、`SetLoop(TRUE)`；不静音时再 `SetVolume(ctx+0x2d8)`。
   - `MFCreateSourceReaderFromURL`（`0x140120050`）属于视频壁纸的 mfEngine 后端，用来探 HDR，不在场景路径上。
4. **字节怎么交给引擎**（静态确认，`FUN_1400f28e0` = P 的虚函数 `+0x18`，`Open(路径, 偏移, 长度)`）：
   - 纹理加载先经资源文件系统 `ctx+0x1898` 算出两样东西：
     - 物理文件：`scene.pkg`，或散的 `.tex`；
     - 区间：起点 = `.tex` 在容器里的偏移 + mip 数据在 `.tex` 里的偏移（`mip+0x1c`），长度 = `mip+0x18`。
     - 地址：`0x1400ed601`–`0x1400ed68f`，用到资源文件系统虚函数 `+0x50`、`+0x40`、`+0x58`。
   - `Open` 新建一个 400 字节的流对象（虚表 `0x1404883a8`）：
     - 底层是 MSVC `std::basic_filebuf`，以只读二进制打开整个物理文件；
     - 记下长度（`+0x128`）与起点（`+0x138`），先 seek 到起点。
   - 流的行为（`0x1400facc0` 起）：
     - `GetCapabilities` 返回 `0x805`：可读、可 seek、不走网络；
     - `GetLength` 返回长度；
     - `SetCurrentPosition` 先把位置钳到长度以内，再 seek 到「起点 + 位置」；
     - `Read` 至多读到区间末尾。
     - **长度与起点都按 32 位存**。语料最大 674 MiB，没问题；容器超过 4 GiB 会出错。
   - 散文件与 pkg 条目走同一套，只是物理文件不同。**按需从磁盘读，不整段读进内存**，`videoreadmode` 不起作用。
   - 先用 `MFCreateSourceReaderFromByteStream(stream)` 探测：
     - `SetStreamSelection(FIRST_VIDEO_STREAM)` + `GetCurrentMediaType`；
     - 读 `MF_MT_FRAME_SIZE` → 宽 `P+0x68`、高 `P+0x6c`、成功标志 `P+0x64`；
     - 读 `MF_MT_FRAME_RATE` → `P+0x70`（float）；
     - 读 `MF_MT_TRANSFER_FUNCTION`：15（PQ）→ `P+0x78 = 2`，16（HLG）→ 1，并置 `P+0x74`；
     - 读 `MF_MT_VIDEO_PRIMARIES == 9`（BT.2020）→ `P+0x7c`。
   - 只有拿到帧尺寸才会 `SetSourceFromByteStream(stream, L"video")`（`IMFMediaEngineEx` 槽 `+0x168`）。
   - 之后新建一个手动复位事件 `P+0x80`（`LOADEDMETADATA` 时置位），调 `P->play()`，并置「重头开始」标志 `P+0x95`。
5. **静音时的扩展**（静态确认调用；用途推断）：
   - 扩展的 `CanPlayType` 对任何类型都答 `PROBABLY`（`0x1400f1960`）。
   - `BeginCreateObject`（`0x1400f1970`）用 `MFCreateSourceResolver` 的 `CreateObjectFromByteStream`，标志 `0x11` = `MEDIASOURCE | CONTENT_DOES_NOT_HAVE_TO_MATCH_EXTENSION_OR_MIME_TYPE`，所以 URL 只写 `"video"` 也能按内容识别 MP4 / Matroska。
   - 结果 QI 成 `IMFMediaSource` 后，包进自己的 `IMFMediaSourceEx` 包装（虚表 `0x1404872f8`），再异步完成。
   - 推断：这个包装是在静音时把音频流藏掉。包装本身没有逐行读。
6. **硬件解码**（静态确认 / 推断）：播放器里没有任何关硬件解码的属性。设备总是 `D3D_DRIVER_TYPE_HARDWARE` 加 DXGI 管理器，所以有 DXVA 解码器就走硬件，否则 MF 自己退回软件 MFT（推断，MF 行为）。`videohardwareacceleration` 只存在视频壁纸的 `+0x17c` bit4 上。
7. **编码支持**（推断）：取决于系统里的 MF 组件。
   - H.264 / AAC / MP4 / Matroska 是 Windows 10+ 自带的；
   - HEVC 要装「HEVC 视频扩展」，或有对应的硬件解码 MFT；
   - 不支持时引擎发 `ERROR` 事件（错误码 3 / 4），见第 7 节。

### 证据

`FUN_1400f1fa0`（初始化）关键片段：
```c
D3D11CreateDevice(0, 1 /*HARDWARE*/, 0, 0x800 /*VIDEO_SUPPORT*/, {0xb100,0xb000,0xa100,0xa000}, 4, ...); // 存 P+0x10 / +0x18
bVar19 = (*(uint*)(ctx + 0x118) >> 17) & 1;          // P+0x21：出声
... MFStartup(0x20070, 1);
CoCreateInstance(&CLSID_MFMediaEngineClassFactory, 0, 0x17, &IID_IMFMediaEngineClassFactory, &fac);
MFCreateAttributes(&a, 1);
a->SetUnknown(MF_MEDIA_ENGINE_CALLBACK, notify);     // 虚表 0x140487260
dev->QI(IID_ID3D10Multithread)->SetMultithreadProtected(1);
MFCreateDXGIDeviceManager(&tok, &P->dxgiMgr); P->dxgiMgr->ResetDevice(dev, tok);
a->SetUnknown(MF_MEDIA_ENGINE_DXGI_MANAGER, P->dxgiMgr);
a->SetUINT32(MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT, 0x57);
if (!bVar19) a->SetUnknown(MF_MEDIA_ENGINE_EXTENSION, ext /*0x140487280*/);
fac->CreateInstance((bVar19 ^ 1) << 2 | 0x12, a, &me);
me->QI(IID_IMFMediaEngineEx, &P->me /*+0x58*/);
P->me->SetAutoPlay(0); P->me->SetLoop(1);
if (bVar19) P->me->SetVolume(*(float*)(ctx + 0x2d8));
```
GUID 已逐个用 `guid.py` 读出核对：`0x140486148`、`0x1404871a8`、`0x140486178`、`0x140486188`、`0x140486158`、`0x140486168`、`0x140487178`、`0x140487198`、`0x140487188`（`IDXGIResource`）、`0x140487078`（`IDXGIKeyedMutex`）、`0x140477ef0`（`ID3D11Texture2D`）、`0x140487168`（`IMFByteStream`）、`0x14042c2e0`–`0x14042c310`（四个 `MF_MT_*`）。

纹理加载的视频分支（`FUN_1400ec7b0`，`0x1400ed542` 起）：
```asm
1400ed542: test byte ptr [r15+0x1c], 0x20     ; T 的标志 Video
1400ed582: or   byte ptr [r15+0x10], 0x4
1400ed58e: mov  dword ptr [rbp-0x14], 0       ; Usage = DEFAULT（非视频为 1 = IMMUTABLE）
1400ed592: mov  dword ptr [rbp-0x10], 0x28    ; BindFlags = SRV|RT（非视频为 8）
1400ed599: mov  dword ptr [rbp-0x8], 0x100    ; MiscFlags = SHARED_KEYEDMUTEX
1400ed695: mov  rcx, [rdx+0x158]              ; ctx 的媒体扩展
1400ed69f: call [rax+0x130]                   ; 建播放器 → T+0xd8
1400ed6c5: call [r9+0x8]                      ; P->Init(ctx+0x1518, T)
1400ed6f5: call [rbx+0x18]                    ; 成功：P->Open(物理路径, 偏移, 长度)
1400ed70a: call [rax]                         ; 失败：delete P，T+0xd8 = 0
```

---

## 2. 进纹理

### 结论

1. **目标纹理**（静态确认）：
   - 格式：`FUN_1400d2a20(T+0x18)`，格式 0 → `R8G8B8A8_UNORM`（28），不是 sRGB。
   - 尺寸：mip 0 的宽高；mip 数是这一组 mip 的个数，语料 1，所以没有 mip 链，也没人生成 mip。
   - 其它：`Usage = DEFAULT`，`BindFlags = SRV | RT`，`MiscFlags = SHARED_KEYEDMUTEX`；建好后 QI 出 `IDXGIKeyedMutex` 存在 `T+0x168`。
   - SRV 格式与普通纹理相同（`T+0x160`）。
   - 采样器 `T+0x158` 来自 `FUN_140099980(设备, T 的标志, …)`，和所有纹理是同一个按标志缓存的采样器：标志 34（ClampUVs）→ 夹边、线性；35 再加 NoInterpolation → 最近点。标志位到过滤 / 寻址的映射沿用以前的报告，本轮没逐位核对。
2. **两个设备之间怎么交接**（静态确认）：
   - 建完纹理后，加载函数调 `P->SetTarget(T 的第 0 个 D3D 纹理)`，即 P 的虚函数 `+0x10`（`0x1400edd24`）。
   - `SetTarget`（`FUN_1400f2510`）做这些事：
     - QI `IDXGIResource` → `GetSharedHandle` → 在 P 自己的设备上 `OpenSharedResource(…, IID_ID3D11Texture2D)` 存到 `P+0xa8`；
     - QI 键控互斥存到 `P+0xb0`；
     - 记 `P+0x60 = ctx+0x144`（当前帧号），置「要帧」标志 `P+0x92 = 1`；
     - 若渲染标志位 18 没置位且工作线程没起，就起工作线程。场景壁纸位 18 恒为 0，见第 5 节。
   - 推断：`D3D11CreateDevice` 传的是默认适配器（NULL），多显卡时可能和渲染设备不在一块卡上，`OpenSharedResource` 失败后就没有帧。
3. **颜色转换**（WPE 侧静态确认；换算细节推断）：
   - WPE 里没有 YUV 着色器。`IMFMediaEngine::TransferVideoFrame`（`P` 虚函数 `+0x78` = `FUN_1400f3480`）一次把解码帧（一般是 NV12）经 MF 视频处理器转成 RGB，写进目标纹理。
   - 参数：
     - 源矩形：归一化 `MFVideoNormalizedRect = P+0xb8..+0xc4`，构造缺省 `{0, 0, 1, 1}`。P 的虚函数 `+0x28`（`0x1400f2e90`）可以改，场景路径里没看到调用。
     - 目标矩形：`RECT{0, 0, T+0x20, T+0x24}`，即 `.tex` 头里的纹理宽高。
     - 边框：`MFARGB{0, 0, 0, 0xff}`，不透明黑。
   - 推断（MF 行为）：
     - 矩阵和范围按码流的 `MF_MT_YUV_MATRIX` / `MF_MT_VIDEO_NOMINAL_RANGE` 换算，输出全范围 RGB，alpha 为 255，不做 sRGB 转换。
     - 码流没标颜色时，MF 按分辨率选 BT.601 或 BT.709。
     - 头里的纹理宽高比和视频不同时，媒体引擎会保持画面比例，用边框色补黑边。
   - 语料的颜色标注（`ignore/p9/out/vtex.json` 的 `color` 字段，[矩阵, 原色, 传递, 范围]）：
     - 41 段 `bt709/bt709/bt709/tv`；
     - 13 段全未标；
     - 2 段 `bt709/-/-/tv`，2 段 `bt709/bt709/-/tv`，2 段 `bt470bg/-/-/tv`；
     - 全部是 limited（`tv`）。
4. **取帧时机**（静态确认）：
   - **工作线程**：`FUN_1400f3930`，每个播放器一个，`timeBeginPeriod(1)`。每轮持锁 `P+0xd8` 做下面的事，然后 `Sleep(max(1, (int)(1000 / (f · rate))))`：
     - 先同步播放状态，见第 3 节；
     - 若「要帧」`P+0x92` 或引擎在放 `P+0x91`：调 `OnVideoStreamTick(&pts)`，返回 `S_OK` 就置新帧标志 `P+0xc8 = P+0xc9 = 1`；
     - 引擎没暂停、也没结束时，跑卡顿检测，见第 3 节；
     - `f` = 视频帧率 × 2；帧率未知时 `f` = 60（不乘 2）。`rate` = `P+0x24`。
   - **渲染线程**：材质 pass 绑定 `FUN_140155fc0`（rea-p4a / rea-p5-mesh 的「材质绑定」，每个 draw 调一次）在末尾（`0x1401572a0`）遍历着色器程序用到的纹理槽表（`pass+0x1e0` 指向的程序 `+0x14` 起的字节表，`0xff` 结尾），对每个槽调 `pass+0xd0+8·slot` 的纹理虚函数 `+0x20`（`FUN_14015f0d0`）。它看到 `T+0xd8` 非空，就尾跳到 `P->AcquireFrame()`，即 P 的虚函数 `+0x78`。`AcquireFrame` 的步骤：
     1. `P+0x60 = ctx+0x144`：记下本帧号，供可见性判断用；
     2. 若 `P+0xc9`：在 P 的设备上 `AcquireSync(0, 1000 ms)` → `TransferVideoFrame` → 成功则清 `P+0x92` / `P+0xc9`，`P+0x8` = 是否成功 → `ReleaseSync(0)`。
   - 随后纹理虚函数 `+0x28`（`FUN_1400ee8b0`）在渲染设备上 `AcquireSync(0, 1000)` 并 `PSSetShaderResources` / `PSSetSamplers`；解绑（`+0x30`）时 `ReleaseSync(0)`。
   - 所以在一帧里：场景更新（脚本）→ 渲染 → 画到这个图层、绑定纹理的那一刻才把**当时最新**的视频帧拷进去。视频帧和场景帧之间没有同步，渲染慢于视频时会跳帧。
   - 只有着色器真正用到的槽才会被更新。语料里视频都在槽 0，`genericimage*` 都用槽 0。
   - 同一个函数还按槽号写 `ctx+0x1cc + 16·slot` 的纹理动画 uniform，并按 `ctx+0x144` 每帧只推进一次，说明它确实是绘制前的逐槽准备。

```asm
1401572a0: movzx eax, byte ptr [rbx]          ; 程序用到的槽号
1401572a3: and eax, 0xf
1401572a8: mov rcx, [r12 + 8*rax + 0xd0]      ; pass 的纹理数组（槽 0 = +0xd0）
1401572b3: call [rax+0x20]                    ; T->Update(slot) = FUN_14015f0d0 → 视频：P->AcquireFrame
1401572b6: cmp byte ptr [rbx+1], 0xff; jne 1401572a0
```

- **更正 rea-p4b-render 1.2**：那里写「`flags & 0x20` 时 … `GENERATE_MIPS`」。实际 `MiscFlags = 0x100` 是 `D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX`（`GENERATE_MIPS` 是 `0x1`）。建纹理后正是按 `MiscFlags & 0x100` 去 QI `IDXGIKeyedMutex`（`0x1400eda15`）。

### 证据

`AcquireFrame`（`0x1400f3480`）：
```asm
1400f3486: mov rax,[rcx+0x50]; mov eax,[rax+0x144]; xchg [rcx+0x60],eax   ; 记帧号
1400f3496: movzx eax, byte ptr [rcx+0xc9]; test al,al; je ret            ; 没有新帧就返回
1400f34ce: mov rcx,[rbx+0x88]; ... [rsp+0x38]=T+0x20, [rsp+0x3c]=T+0x24 ; 目标 RECT
1400f34ff: mov byte ptr [rsp+0x53], 0xff                                   ; 边框 alpha
1400f3514: call [rax+0x40]    ; keyedMutex->AcquireSync(0, 1000)
1400f353f: call [rax+0x158]   ; me->TransferVideoFrame(P+0xa8, &P+0xb8, &rect, &border)
1400f356e: call [rax+0x48]    ; keyedMutex->ReleaseSync(0)
```

---

## 3. 时钟

### 结论

1. **自己的时钟**（静态确认）：
   - 播放器只读 `ctx+0x118`、`ctx+0x144`、`ctx+0x2d8`，见 `grepfn` 对 `0x1400f1600`–`0x1400f3d00` 的扫描。
   - 不读场景 rate（`ctx+0x154`）、帧时间（`ctx+0x14c`）、`g_Time`。
   - 播放进度完全由 Media Engine 的呈现时钟决定，实时走，不随场景 rate 或固定帧时间。
2. **从哪开始**（静态确认）：
   - `Open` 末尾调 `play()`（置「想放」`P+0x90 = 1`、「要帧」`P+0x92 = 1`），并置 `P+0x95 = 1`。
   - `SetTarget` 起工作线程。
   - 工作线程第一轮：「应当在放」成立（`P+0x90` 且 `P+0x60 + 30 ≥ 帧号`）→ `Play`；看到 `P+0x95` → 清掉，`Pause` → `SetCurrentTime(0)` → `Play`。
   - 所以从 0 开始，起点是**纹理建好的时刻**，不是第一次被画到的时刻。
   - 引擎就绪前没有帧，纹理是透明黑，见第 8 节。
3. **循环**（静态确认；循环点的处理推断）：
   - `loop` 缺省为真：P 的构造让 `P+0x23 = 1`，初始化里 `SetLoop(TRUE)`；脚本包装的 `loop` 也缺省为真。
   - 循环由 Media Engine 自己做：到结尾时 seek 回 0，不发 `ENDED`。
   - `videoloopmode` 对场景视频不起作用，见第 1 节。
   - 时长不是帧时间整数倍时，接缝由 MF 决定（推断），要实测。
4. **`rate`**（静态确认）：
   - P 的虚函数 `+0x68`（`0x1400f3350`）：`P+0x24 = rate`，`SetDefaultPlaybackRate(rate)` 加 `SetPlaybackRate(rate)`。WPE 不钳制。
   - MF 不支持的速率会静默失败（推断）。
   - 副作用：工作线程的睡眠时间 `1000 / (f·rate)` 截成整数后按无符号和 1 比较：
     - `rate` = 0 时得到 +inf，转整数为 0，睡 1 ms；
     - **`rate` 为负时，转整数是负数，按无符号就是近 2³² ms，工作线程等于卡死**，以后 `pause()` 的 join 也会卡住（推断，由代码推出）。
5. **WPE 暂停**（静态确认）：
   - 渲染循环里（`0x140111452` 起），暂停时先把全局音量淡到 0（`W+0x170`，见 rea-p6a-sound 第 4 节）。
   - 淡完后若 `W+0x1b8` bit27 未置位：置位，并调 `FUN_140181960(R, 1)`；然后 `Sleep(250)`，循环不再渲染。
   - `FUN_140181960(R, 1)` 遍历 `R+0x1538` 里的全部纹理，有播放器的调 `P->pause()`。
   - 恢复时 bit27 清掉，`FUN_140181960(R, 0)` 对**每个**有播放器的纹理调 `P->play()`，不看脚本之前有没有暂停、停止。
   - `play()` 只是继续放，所以从暂停处接着放。`pause()` 会结束并 join 工作线程，`play()` 再起。
   - 推断：
     - 「被全屏程序挡住」走的就是这个暂停状态，具体由 WPE 的应用规则决定。
     - 规则是「停止」或卸载壁纸时，场景重建，视频从 0 开始。
6. **预览与桌面**（推断）：每个渲染器各建自己的纹理与播放器，所以各自独立解码、独立计时，没有共享时钟。
7. **属性改动与重新加载**（推断）：
   - 播放器挂在纹理对象上，只在纹理加载时建。
   - 改属性导致场景重建时，纹理重建，视频从 0 开始。
   - 不重建时，视频不受影响。
8. **卡顿检测**（静态确认；只在本类内，没有开关）：
   - 引擎在放、没暂停、没结束时：
     - `dt = min(高精度计时增量, 0.1)`；
     - 当前时间 > 0 且和上一轮完全相同时，`P+0x48 += dt`；
     - 超过 0.2 s，且冷却 `P+0x4c < 5`：`Pause` → `SetCurrentTime(0)` → `Sleep(100)` → `SetCurrentTime(原时间)` → `Play`，冷却变成 `3·冷却 + 10`。
     - 冷却大于 0 时每轮减 `dt` 并 `Sleep(1)`。
   - `videomfstutterhack` 只控制视频壁纸的 `+0x17c` bit5，这里不读。
   - 常量：`0x140492654 = 0.1`、`0x14049267c = 0.2`、`0x140492858 = 5`、`0x140492868 = 10`、`0x1404928e0 = 60`、`0x140492944 = 1000`。

---

## 4. 可见性

### 结论（静态确认）

- 播放器不看图层的 `visible`。工作线程每轮判断：
  ```
  应当在放 = P+0x90（想放） && (P+0x60 + 30 >= ctx+0x144)
  ```
  然后和 `P+0x91`（引擎实际在放）比较，不同就 `Play` 或 `Pause`。
- `P+0x60` 只在 `SetTarget`（建纹理时）和 `AcquireFrame`（绑定这张纹理时）更新。`ctx+0x144` 由场景渲染函数 `FUN_14017fa70` 每帧加 1（`0x14017fca7`：`inc [R+0x154]`，即 `ctx+0x144`）。
- 后果：
  - 图层隐藏（JSON 写死或脚本改 `visible`）、被剔除、所在材质不再绘制时，这张纹理不再被绑定。**连续超过 30 个渲染帧**之后，工作线程把引擎 `Pause`。按 144 Hz 渲染约 0.2 s，30 fps 约 1 s。
  - 停之前的这 30 帧里视频照常前进。
  - 再被画到时，第一帧绑定只更新 `P+0x60`，这时多半没有新帧，画的是隐藏前最后一帧。工作线程下一轮 `Play`，**从暂停处接着放**，不追赶时间。
  - 隐藏期间 `P+0x90` 不变，所以脚本的 `isPlaying` 仍为真，`getCurrentTime` 冻结。
  - 只要别的可见材质还在用同一张纹理，视频就一直放。
- 推断：同一个 `.tex` 被多个图层引用时，纹理由缓存共享，所以只有一个播放器，任一图层可见就继续放。
- 结束回调的判定在图层每帧更新里（第 6 节）。场景更新循环 `FUN_1401891a0` 对 `G+0x158` 里每个对象无条件调虚函数 `+0x48`，**不看可见性**；图像图层的 `+0x48` 是 `FUN_1401fdf90`，判定在它的尾部（`0x14020569b`）。所以隐藏的图层也照常检查结束。

---

## 5. 声音

### 结论

1. **场景视频纹理不出声**。
   - 引擎侧（静态确认）：
     - 初始化读 `ctx+0x118` 的位 17（`0x20000`）：为 0 时带 `FORCEMUTE` 创建，并装上静音扩展。
     - 渲染循环每帧调 `FUN_1401816d0`（全局音量）；它末尾遍历 `ctx+0x1460` 的播放器，调虚函数 `+0x80`（`0x1400f35b0`）。这个函数在 `P+0x21`（出声）为假时什么都不做。
   - 场景壁纸的标志（有界确认）：
     - 场景壁纸的渲染器标志是 `W+0x248 | 0x100d`（或 `| 0x100f`），见 p2-REPORT G2。`W+0x248` 已知的写入点都不置位 17 / 18：
       - 构造：`(byte[+0x46] & 0x10) << 17` = `0x200000`；
       - `0x2000` / `0x6000` / `0x8000` / `0x40`；
       - `FUN_140115a90` 只设 / 清 `0x200`、`0x10`、`0x20`、`0x30`、`0x80`。
     - 全文件搜「同时含位 17 / 18 的渲染标志立即数」（`imm.py`），只有视频壁纸的线程 `FUN_140120050` 命中：
       - `0x50200` / `0x56200`：不出声；
       - `0x70200` / `0x76200`：出声，多了 `0x20000`；
       - 条件是 `[this+0xea4] != 0 && !([this+0xea8] & 1)`。推断这对应 `videoaudiooutput` 为真且后端不是 `.muted`。
2. **出声时的音量**（静态确认，只对视频壁纸）：
   - `SetVolume(ctx+0x2d8)`，即全局音量 `G` = 设置 `volume / 100` × 暂停 / 静音淡变系数（rea-p6a-sound），不平方，没有对象音量。
   - 每帧经 `FUN_1401816d0` 刷新。
3. 推断：所以 Kabegame 的 `<video>` 应当始终 `muted`，语料里 35 段带 AAC 的也一样。

---

## 6. 脚本 `IVideoTexture`

### 登记（静态确认，`FUN_140214050`，类描述 `DAT_1404e86e0`，方法表 `DAT_1404e8720`）

| 成员 | 类型 | 实现 | 原生调用 |
|---|---|---|---|
| `rate` | float 字段 `V+0xe8`，缺省 1.0 | 写：`FUN_1401a49f0` 存值，再调改值回调 `LAB_1401fa6d0` | `P->setRate(V.rate)` → `SetDefaultPlaybackRate` + `SetPlaybackRate`；**读只返回字段**，不问引擎 |
| `loop` | bool 字段 `V+0xec`，缺省 true | 改值回调 `LAB_1401fa700` | `P->setLoop` → `P+0x23`，`me->SetLoop` |
| `duration` | float，只读（`+0x60 = 2`） | `FUN_1401fa690` | `P->duration()`：P 不存在时返回 0；否则在 `P+0x80`（`LOADEDMETADATA` 事件）上 `WaitForSingleObject(3000 ms)`，超时就关掉句柄、以后不再等；然后返回 `(float)me->GetDuration()` |
| `play()` | 无返回 | `FUN_1401fa510` | `if (P->isEnded()) P->setCurrentTime(0); P->play()` |
| `pause()` | 无返回 | `LAB_1401fa560` | `P->pause()` |
| `stop()` | 无返回 | `FUN_1401fa580` | `if (V.loop) V+0xf4 = 0; P->pause(); P->setCurrentTime(0)` |
| `isPlaying()` | bool | `FUN_1401fa5d0` | `P->isPlaying() && !P->isEnded()`；`isPlaying` = `me != 0 && P+0x90` |
| `setCurrentTime(t)` | 参数 float | `LAB_1401fa650` | `if (V.loop) V+0xf4 = 0; P->setCurrentTime(t)` → `me->SetCurrentTime((double)t)`，再置 `P+0x92 = 1`。**不钳制** |
| `getCurrentTime()` | float | `FUN_1401fa620` | `(float)me->GetCurrentTime()` |
| `addEndedCallback(fn)` | 参数是函数（类型 `0x2000`） | `FUN_1401fa730` | 往 `V+0xf8..0x108` 的向量末尾加一项。不去重，也没有删除接口 |

P 的方法（虚表 `0x1404871b8`）：

| 槽 | 地址 | 用途 |
|---|---|---|
| `+0x30` | `0x1400f3030` | `pause`：清线程运行标志并 join 工作线程，`me->Pause()`，清 `P+0x91` / `P+0x90` |
| `+0x38` | `0x1400f2f50` | `play`：置 `P+0x90` / `P+0x92`，条件满足时起工作线程。**不直接调 `me->Play`**，由工作线程或更新函数去调 |
| `+0x40` | `0x1400f30c0` | `me != 0 && P+0x90` |
| `+0x48` | `0x1400f30e0` | `me->IsEnded()` |
| `+0x50` | `0x1400f3160` | 设当前时间 |
| `+0x58` | `0x1400f31f0` | 读当前时间 |
| `+0x60` | `0x1400f3280` | 时长 |
| `+0x68` | `0x1400f3350` | 设 rate |
| `+0x70` | `0x1400f33f0` | 设 loop |

### `getVideoTexture()`（`FUN_14020e7b0`，静态确认）

```
if (L+0x4c0) return L+0x4c0;                       // 每个图层只建一次，以后返回同一个对象
T = (L+0x498 /*基础材质*/)->+0xd0;                  // 材质纹理槽 0（rea-p4b-render：基础材质 +0xd0 = tex0）
if (!T || !(T+0x1c & 0x20) || !T+0xd8) return L+0x4c0;   // 也就是返回空
V = new 0x110; V.rate = 1.0; V.loop = true; V+0xf0 = 0; V+0xf4 = 1; V.callbacks = {};
L+0x4c0 = V; V+0x58 = L; V+0x50 = T; return V;
```
- 非视频图层、或播放器初始化失败（`T+0xd8 = 0`）时返回空指针。推断：脚本 dll 把它转成 `null`。
- `getTextureAnimation()`（`FUN_14020e670`）也读写 `L+0x4c0`，类型不同（虚表 `0x140491168`，要求纹理标志 `0x4`）。
  - 先调了其中一个、拿到对象之后，再调另一个，会拿到前一个的对象。
  - 推断：语料里一张纹理不会同时带 Video 和 Sprite 标志，实际不冲突。

### 结束回调（静态确认，`FUN_1401fdf90` 尾部，每次图层更新）

```
V = L+0x4c0; if (!V || !(V.T+0x1c & 0x20)) skip;
if (V.loop) {
    t = P->getCurrentTime();
    if (callbacks 非空 && V+0xf0 > t && V+0xf4) 调全部回调;      // 时间回退 = 绕回
    V+0xf4 = 1; V+0xf0 = t;
} else {
    if (P->isEnded()) { if (V+0xf4) { V+0xf4 = 0; if (callbacks 非空) 调全部回调; } }
    else V+0xf4 = 1;
}
```
- **`loop` 为真**：每次绕回触发一次，判定方法是「这次读到的时间小于上次」。`stop()` / `setCurrentTime()` 在 loop 下会清 `V+0xf4`，让自己造成的回退不触发。第一次更新时 `V+0xf0 = 0`，不会触发。
- **`loop` 为假**：
  - 引擎到结尾发 `ENDED`，事件回调把 `P+0x90` 清掉，并置 `P+0x94`（场景路径不读 `P+0x94`）。
  - `IsEnded` 变真的那次更新触发一次，之后不再触发；直到不再是 ended（`play()` 会先 seek 到 0）再重新装上。
- **回调参数**：经 `FUN_140177bf0` → 脚本引擎（`ctx+0x1708+0x128` 的虚函数 `+0x60`），只传函数数组和个数。推断：回调不带参数调用，这部分在 `scenescript64.dll` 里，没读。
- 判定只跟图层更新的频率，也就是渲染帧，不在工作线程里。

### 由上面推出的值（推断）

- **`stop()` 之后**：`isPlaying` 为假；`getCurrentTime` ≈ 0（MF 在 seek 时报目标时间）。
  - 但工作线程已经被 `pause()` 结束，不会再有新帧，**画面停在 `stop` 那一刻的帧**，直到 `play()`。
  - `pause()` 后 `setCurrentTime(t)`、脚本暂停期间 seek 也一样：画面不变，直到 `play()`。
- **`play()` 之后**：从当前位置接着放。如果之前已经 ended（loop 为假），先回到 0。
- **超出范围的 `setCurrentTime`**：WPE 不钳制，结果取决于 MF。
- **`duration`**：引擎没拿到源（探测失败）时，`GetDuration` 按 MF 文档返回 NaN；探测成功、元数据就绪后是秒数。
- **在 `init` 里读 `duration`**：若元数据还没就绪，会把脚本线程（也就是渲染线程）卡住最多 3 s。

---

## 7. 失败

### 结论（静态确认）

- **日志**：播放器类与纹理加载的视频分支里**没有任何日志字符串**；播放器代码段只引用 `L"video"`、`mfplat.dll`、`core_msgboxtitle_error`、`core_msgbox_media_feature_pack_missing`。
  - 下面这些字符串都属于视频壁纸的 `StartVideoWithNewPlayer` 等，场景视频纹理用不到：
    - `Failed creating video player (%s): %x`
    - `Failed opening video (%s): %s, %x`
    - `Failed resizing video …`
    - `Failed handling MF video event …`
    - `Video stutter detected`
- **缺 Media Foundation**（Windows N）：第一次初始化弹一次本地化对话框（`MessageBoxW`，标题 `core_msgboxtitle_error`，正文 `core_msgbox_media_feature_pack_missing`）。之后全进程的播放器初始化都失败（`DAT_1404e8f78`）。
- **初始化失败**（MF、D3D11 视频设备、类工厂任一步）：加载函数删掉播放器，`T+0xd8 = 0`，纹理照常建，内容全 0。`getVideoTexture()` 返回空。
- **探测失败**（Source Reader 拿不到首个视频流的帧尺寸）：`P+0x64 = 0`，不设源，也不调 `play()`（`Open` 里的 `play()` 和置 `P+0x95` 都在成功分支里），没有帧，纹理全 0。脚本照常可调：`isPlaying` 为假（`P+0x90` 没置）；之后脚本调 `play()` 会置 `P+0x90`，`isPlaying` 变真，但仍然没有帧；`duration` 见第 6 节。
- **播放中出错**（`ERROR` 事件，`0x1400f1d02`）：
  - 先清 `P+0x90`（`isPlaying` 变假）。
  - 设备丢失类错误：置 `P+0x93`。
  - 解码错误（3）或源不支持（4）：没有窗口句柄（`P+0xd0`，场景路径为空）时只置 `P+0x96`，场景路径不读它。视频壁纸则 `PostMessage(hwnd, 0x8003, 3)`，换下一个后端。
  - 纹理保持最后一帧；从没成功过就保持全 0。
- 推断：不支持的编码（例如没装 HEVC 扩展）大概率是探测成功（原生媒体类型就有帧尺寸），然后在引擎里报 `SRC_NOT_SUPPORTED` / `DECODE`。也就是透明、不出日志。

---

## 8. 第一帧之前

- **结论**（静态确认，`0x1400ed99f` 起）：
  - 视频纹理分支按 `bpp × 宽 × 高` 分配一块内存，`memset` 成 0，作为 `CreateTexture2D` 的初始数据。
  - 所以第一次 `TransferVideoFrame` 之前，纹理是 RGBA = (0, 0, 0, 0)。
  - 透明黑经 genericimage 的 alpha 混合后什么都看不见；关混合时是黑。
- **之后**（推断）：转换后的像素 alpha 为 255。
- **什么时候有第一帧**：引擎就绪、工作线程 `OnVideoStreamTick` 拿到帧，并且这个图层被画到。

```asm
1400ed9ab: mov eax, r14d; imul eax,[rdi+4]; imul eax,[rdi]   ; bpp·h·w
1400ed9b9: call 0x14028b0c0                                 ; 分配
1400ed9c9: call 0x1404217a0                                 ; memset(buf, 0, size)
1400ed9e2: call 0x1400eb220                                 ; 组 D3D11_SUBRESOURCE_DATA
1400eda09: call [rax+0x28]                                  ; dev->CreateTexture2D(&desc, init, &tex)
1400eda2f: call [rax]                                       ; tex->QI(IID_IDXGIKeyedMutex, T+0x168)
```

---

## 附：视频壁纸与场景视频纹理的关系（静态确认，供对照）

- 视频壁纸的 mfEngine 后端在 `FUN_140120050` 里加载 `assets/scenes/videoplayer/scene.json`，并把 `videotex` 换成用户的视频文件。播放器对象虚表是 `0x140489d68`；从字符串和行为推断，它就是 `mfEngine` 后端。
- 视频文件经 `FUN_1400eb570`（按扩展名识别视频，置纹理 Video 标志）走**同一个播放器 P**：`Open(路径, 0, 0)`，整个文件。
- 它给渲染器的标志多带：
  - 位 18：不起工作线程，由壁纸代码直接调 P 的 `+0x90` 更新；
  - 位 16：HDR 时收尾用 `materials/util/combine_video_hdr.json`；
  - 出声时位 17；
  - 并自己设 loop / rate（`0x140120545`、`0x14012055b`）。
- `mf` 后端（Media Session + EVR，虚表 `0x140489fe0`）和 DirectShow 后端是另外的类，场景视频纹理用不到。

## 字段速查（播放器 P，0x140 字节，构造在 `FUN_1400c7140`）

| 偏移 | 含义 | 缺省 |
|---|---|---|
| `+0x8` | 上次 `TransferVideoFrame` 是否成功（读取方未查） | 0 |
| `+0x10` / `+0x18` | P 自己的 D3D11 设备 / 上下文 | — |
| `+0x20` | MFStartup 成功 | 0 |
| `+0x21` | 出声（ctx 标志位 17） | 0 |
| `+0x22` | `SetSourceFromByteStream` 成功 | 0 |
| `+0x23` | loop | 1 |
| `+0x24` | rate | 1.0 |
| `+0x40` / `+0x48` / `+0x4c` | 卡顿检测：上次时间 / 累计不动时长 / 冷却 | 0 |
| `+0x50` | ctx | — |
| `+0x58` | `IMFMediaEngineEx` | — |
| `+0x60` | 最近一次被绑定时的帧号 | 建纹理时的帧号 |
| `+0x64..+0x7c` | 探测结果：有效、宽、高、fps、HDR、传递函数、BT.2020 | 0 |
| `+0x80` | `LOADEDMETADATA` 事件句柄 | — |
| `+0x88` | 纹理 T | — |
| `+0x90` | 想放 | 0（`Open` 后为 1） |
| `+0x91` | 引擎实际在放 | 0 |
| `+0x92` | 要帧 | 0 |
| `+0x93` | 设备丢失 | 0 |
| `+0x94` | 收到过 `ENDED` | 0 |
| `+0x95` | 重头开始 | 0（`Open` 后为 1） |
| `+0x96` | 解码 / 源错误 | 0 |
| `+0xa8` | P 设备上打开的共享纹理 | — |
| `+0xb0` | 它的键控互斥 | — |
| `+0xb8..+0xc4` | 源矩形（归一化） | `{0, 0, 1, 1}` |
| `+0xc8` / `+0xc9` | 新帧标志（`+0xc8` 只给视频壁纸取用） | 0 |
| `+0xd0` | 视频壁纸的窗口句柄（场景路径为空） | 0 |
| `+0xd8` | 互斥量 | — |
| `+0x128..+0x138` | 工作线程句柄 / 线程号 / 运行标志 | 0 |

---

## 未知 / 需要实测的点

1. **MF 侧的行为**（推断，要实测）：
   - YUV → RGB 的矩阵与范围：特别是 13 段未标颜色的、2 段 `bt470bg`；
   - alpha 是否为 255；
   - 宽高比不一致时会不会加黑边；
   - `SetCurrentTime` 超过时长时落在哪；
   - `GetDuration` 在没有源时是不是 NaN；
   - 循环接缝停几帧；
   - 负 `rate` 是否真的让工作线程卡死；
   - HEVC、Matroska 在用户机器上能不能放。
2. **纹理虚函数 `+0x20` 的其它调用点**：已确认材质 pass 绑定 `FUN_140155fc0` 逐槽调用它（第 2 节）。没有在全文件里穷举别的间接调用点。如果别处也会对视频纹理调用（例如每帧对全部纹理调一次），第 4 节「30 帧不画就暂停」就不成立，要实测（第 4 条实测）。
3. 静音扩展里的 `IMFMediaSourceEx` 包装（虚表 `0x1404872f8`）有没有藏掉音频流：没读。
4. `addEndedCallback` 的回调参数：dll 侧没读。
5. `getVideoTexture()` 返回空指针时，JS 侧拿到的是 `null` 还是 `undefined`：dll 侧没读。
6. `.tex` 读取（`FUN_14015c8d0`）在解析头时，有没有把视频 mip 整段读进内存：没逐行读。这只影响 WPE 的内存，不影响行为。
7. 同一个 `.tex` 被多个图层引用时，纹理缓存是否共享同一个播放器：推断共享，没核对缓存键。
8. P 的 `+0x8`（帧是否成功）在场景路径里有没有被读、用来决定画不画：没查到读取点。
9. 「被全屏程序挡住」时，WPE 走的是暂停（本报告第 3.5 节的路径）还是卸载，取决于应用规则设置，没跟。

## 建议的实测（主会话：wpe-renderdoc + kbp 合成视频）

测试工程：一个图像层，`genericimage2` 槽 0 是视频 `.tex`（TEXB0003 / 0004，标志 34），外加 CLK 图层。

合成视频：
- H.264 `yuv420p`，60 fps，BT.709 limited，在 VUI 里标出颜色；
- 每帧用色块编出帧号，带一张固定色卡（含 16 / 235 灰阶、纯色）；
- 时长取一个不是帧时间整数倍的值，例如 2.51 s；
- 再做一份不标颜色的、一份 `bt470bg` 的，一份带 AAC 的。

1. **抓帧要点**：
   - 写纹理的是 P 自己的 D3D11 设备（共享纹理 + 键控互斥）。RenderDoc 抓渲染设备时，这张纹理在抓帧里可能显示为初值或上一帧。
   - **以采样它的那个 draw 的输出 RT 为准**，用 `pick_pixel` 读输出，别只读纹理资源。必要时把图层设为不混合、全屏。
2. **起点与时钟**：
   - 开窗后连续抓若干帧，解出帧号，和 CLK 的场景时间对齐，应当约等于「纹理加载以来的实时秒数 × 60」。
   - 改 WPE 的场景 rate（如果有入口），或用脚本改 `engine` 时间，视频不应变化。
3. **第一帧之前**：开窗后尽早抓的第一帧里，视频图层位置应当透明（alpha 0），不是黑。
4. **可见性**：
   - 脚本在 t = 2 s 设 `visible = false`，t = 5 s 设回 `true`；
   - 预期再显示后的帧号 ≈ 隐藏时的帧号 + 30 渲染帧对应的视频时间，之后连续增长，不跳到 5 s；
   - 隐藏期间读 `isPlaying` 应为真。
5. **WPE 暂停**：用 WPE 的暂停（托盘或全屏程序）暂停 3 s 再恢复，帧号应当接着走。同时让脚本事先 `pause()` 另一段视频，验证恢复后它**也被放起来了**。
6. **脚本**：
   - 按时间依次 `pause` → `setCurrentTime(1.0)` → 抓（预期画面不变）→ `play` → 抓（预期跳到约 1 s 后接着放）；
   - `stop` → 抓（预期画面停在 stop 时那帧，`getCurrentTime` ≈ 0）→ `play`；
   - `rate = 2` / `0.5`；
   - `loop = false` 时 `addEndedCallback` 只触发一次，loop 为真时每次绕回触发一次；回调里打印 `arguments.length`；
   - `getVideoTexture()` 在非视频图层上 `typeof` 的结果；
   - `init` 里读 `duration` 的耗时。
7. **颜色**：
   - 色卡在 WPE 输出 RT 里的值，和 Kabegame `copyExternalImageToTexture` 的结果逐像素比；
   - 三种颜色标注各比一次，确认 16 → 0、235 → 255 的映射，以及未标注时用的矩阵。
8. **声音**：带 AAC 的测试视频在场景里放，读 `wallpaper64.exe` 音频会话的峰值，预期为 0（静音）。对照一张视频壁纸，预期有声。
9. **尺寸不一致**：把 `.tex` 头里的纹理宽高改成和视频不同的比例（mip 尺寸保持视频尺寸），看有没有黑边、画面是否拉伸。
