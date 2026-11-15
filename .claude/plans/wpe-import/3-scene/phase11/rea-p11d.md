> 逆向原始记录，代理写的，接着 [rea-p11-media.md](rea-p11-media.md) 第 4 节与 [rea-p11-textures.md](rea-p11-textures.md) 第 2.3、5 节查，地址与命名沿用。地址按 Ghidra：`wallpaper64.exe`、`winrtutil64.exe` 基址都是 `0x140000000`（两个不同的文件，下文凡 `winrtutil` 的地址都会注明）。只读码，没有运行 WPE。主会话的实测（p11-REPORT「P11d 补测」）冲突时以实测为准，本文在相关处对照过。

# WPE 2.8.42 P11d 场景快捷方式（usershortcut）补充静态逆向

**概括**
- **网站图标（`winrtutil!FUN_14002fb10`）**：用 WinRT `Windows.Web.Http.HttpClient` 取**用户填的网址原样**（能解析成绝对 URI 就不改；解析不了才依次试 `https://` + 串、`https://www.` + 串），只加一个 iPhone Safari 的 User-Agent，不看状态码，整页读成字符串。在整页 HTML 上用不分大小写的正则逐个找 `<link …>`：`rel="apple-touch-icon"`（或 `-precomposed`）的记下 `href` 与 `sizes` 的宽；`rel="icon"` / `"shortcut icon"` 一类的记下 `href`、宽 0；最后再补一个 `/favicon.ico`（宽 0）。按宽**从大到小稳定排序**（同宽保持文档顺序，`/favicon.ico` 在同宽里最后），逐个按「最终响应地址」用 `Uri.CombineUri` 拼成绝对地址下载，第一个能解码、能重新编码的就用。解码用 FreeImage（按内容识别，ICO 取像素数最大的一页），**边长 ≤ 512 的正方形保持原尺寸**，否则缩成 `min(w, h, 512)` 的正方形；然后**乘一个抗锯齿的圆形遮罩**（`alpha = (mask·alpha) >> 8`，所以圆内的 alpha 是 254），编 PNG 回传。【确】
- **缺省图（`winrtutil!FUN_14002f990`）**：上一步任何异常或全部候选失败才走：`GetCurrentDirectoryW()` + `../assets/materials/util/webthumbnailfallback.png`（300×300 RGBA），**不缩放**，同样乘圆形遮罩后编 PNG。缺省图也失败就**不回包**。【确；当前目录是 `bin` 是推断，实测取到了缺省图可佐证】
- **程序 / 文件图标（`winrtutil!FUN_14002ee30`）的分支要更正上一轮**：上一轮写的「`.lnk` 经 `IShellLink` 取图标位置」是误读——那里的 `CoCreateInstance` 是 **`KnownFolderManager`**，`"%[^,],-%d"` 解析的是**已知文件夹定义的 `pszIcon`**，只对目录生效。`.lnk` 没有专门处理。实际顺序：不是普通文件就 `SearchPathW(文件名, ".exe")` 补全 → **先取 Shell 缩略图**（`IThumbnailCache::GetThumbnail`，256）→ 失败再按：已知文件夹图标 / `.url` 的 `IconFile` / 系统图像列表（`SHGetFileInfoW` 带 `SHGFI_USEFILEATTRIBUTES`，JUMBO → EXTRALARGE → LARGE → SMALL，丢掉「小图标补透明边」的假大图）。【确】
- **去预乘**只在 HICON 那几支做，缩略图那支不做：`af = (float)a / 255.0f`，`c' = (uint8)cvttss2si((float)c / af)`，float32、向零截断、**不钳制只取低字节**；`a = 0` 时写 0；`c == a` 时对 87 个 alpha 值得 254 而不是 255。【确】
- **`FUN_140066ef0` 是 OpenCV 4.4.0 的「透明区填色」**：把 RGB 缩到 64×64，对 alpha ≤ 8 的区域用 `cv::inpaint`（TELEA，半径 8）补色，再线性放回原尺寸，**只替换原图 alpha ≤ 1 的像素的 RGB**，alpha 不变。消息 8 的两支都做，网站图标不做。【确；缓存产物佐证】
- **PNG**：FreeImage 默认参数，块只有 `IHDR`、`pHYs`、`IDAT`、`IEND`，没有 `gAMA`；全部 alpha 都是 255 时写成 RGB（颜色类型 2）。【确：读码 + 本机 `thumbnail.cache` 里的产物】
- **wallpaper64 侧（`FUN_140174710`）**：发给 `winrtutil` 的是 `FUN_1401708c0` 解析出的**路径段**（`cmd` 只有程序部分，`file` 不含 `|` 后的参数），类型串正好是 `web` 才发消息 9，其余发 8；**不校验 6 位系统哈希**。缓存文件是 `<WPE>/bin/thumbnail.cache`，键是这个路径段 UTF-8 字节的 SHA-256。【确：读码 + 用本机缓存核对了 3 个键】

**元数据**
- 目标：`winrtutil64.exe` SHA-256 `42c4801b194bf06408e176d6869407c193e47ad995714ccdcfd5b4e7a0daf1e0`（`ignore/p11/rea/tex/bin/`、`ignore/p11/rea/media/` 两份副本与安装目录原件开工时核对一致）；`wallpaper64.exe` 同 rea-p11-textures。
- 方法：本机 Ghidra 12.1.4 无界面（`ignore/p11/rea/tex/gh/projw`，`-readOnly`，经 `ignore/p11/rea/p11b/dec.sh`）反编译；关键段用 `ignore/p11/rea/media/wu.asm` 切片核对；WinRT 接口槽位按 Windows SDK 10.0.26100 的 `cppwinrt/winrt/impl/*.0.h` 的 `abi<>` 顺序算；C++ 异常块用自写的 FH4 表解析脚本读 try 区间与 catch 续延地址；OpenCV 函数按其 `CV_INSTRUMENT_REGION` 名字串与断言串认。另外**只读**了本机 `<WPE>/bin/thumbnail.cache`（主会话实测时写入的 7 个条目）与 `<WPE>/assets/materials/util/webthumbnailfallback.png` 的头。没有用 REA。
- 工作文件 `ignore/p11/rea/p11d/`：`fb10.asm`（`FUN_14002fb10` 全段）、`ee30.asm`、`f645d0.asm`；反编译 `d1`–`d5`；脚本 `fh4.py`（FH4 异常表）、`tcache.py` / `tcall.py` / `tcpng.py` / `tcpng2.py`（读缓存条目与其中的 PNG）、`pnghdr.py`、`unpremul.py`（复算去预乘）。
- 标记：【确】读到指令或反编译；【确：产物】由本机缓存里 WPE 自己写出的 PNG 证实；【推】推断，写了依据；【未知】没读到；【实测】主会话 P11d 补测的结论。

---

## 1. 网站图标（`winrtutil!FUN_14002fb10`，`0x14002fb10`–`0x140031816`）

### 1.1 入口与回包（`winrtutil!FUN_140045cc0` 消息 9，`0x140045d19` 起）【确】
- 载荷是一个 UTF-8 串（wallpaper64 发来的路径段，见 4 节），转 UTF-16 后交给 `FUN_14002fb10(串, &png, &len, &w, &h)`。
- `FUN_14002fb10` 返回假时调 `FUN_14002f990`（缺省图）；两者都失败时**什么都不发**（`0x140045d8f` 之后的分支只在成功时组包）。
- 回包消息码 10：`原 UTF-8 串 + NUL + w + h + len + PNG 字节`，`w/h` 是**编码前的像素尺寸**。

### 1.2 异常处理【确】（FH4 表，`fh4.py` 读出）
整个函数体（状态 0，`0x14002fb43`–`0x140031744`）在一个外层 `catch(...)` 里，续延 `0x140031744`：清理后返回 `*png != nullptr`。里面另有 6 个 `catch(...)`：三次建 URI（续延 `0x14002fcf6`、`0x14002fe1b`、`0x14002ff8e`）、拼候选地址 `CombineUri`（`0x140030fc2`）、候选单独建 URI（`0x140031144`）、**每个候选的下载 + 解码 + 编码**（`0x1400315e5`，接着试下一个）。所以：
- 主页面取不到（DNS、连接、TLS 失败、协议不支持如 `steam://`、正文不能按字符串读）→ 外层捕获 → 返回假 → 缺省图；
- 某个候选下载失败只跳过它。

### 1.3 请求的地址【确】
1. `Uri(串)`（`FUN_14002c4e0` = `IUriRuntimeClassFactory::CreateUri`，失败抛异常被内层捕获）；
2. 不行再 `Uri(L"https://" + 串)`（`0x14002fd19`，常量 `0x14034b1c0`）；
3. 再不行 `Uri(L"https://www." + 串)`（`0x14002fe3e`）；三次都没有 → 返回假。
- 所以请求的是**用户填的整串**，不取 origin、不去路径与查询；`steam://…` 这类串能建 URI，但 `GetAsync` 抛异常 → 缺省图【推：`HttpClient` 只收 http(s)】。
- 实测键 `https://www.wikipedia.org` 与 `https://example.com` 都是原串（4 节）。

### 1.4 HTTP【确】
- 对象：`HttpClient` 的激活工厂 `ActivateInstance` 后 QI `IHttpClient`（IID `7FDA1151-…`，`0x14034a508`）。只用缺省过滤器：没有设置 `HttpBaseProtocolFilter`，所以重定向、缓存、Cookie 都是 WinRT 缺省【推：缺省自动跟随重定向】。
- 请求头只改了一项：`DefaultRequestHeaders.UserAgent.TryParseAdd(…)`（`+0x80` → `+0x100` → `+0x38`），值是
  `Mozilla/5.0 (iPhone17,2; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Resorts/4.5.2`
  （`0x1400300d0` 附近）。没有 Accept、Referer 等。
- 页面：`GetAsync(uri)`（`+0x38`）→ `.get()`（`FUN_140031880`：`WaitForSingleObject(INFINITE)`，取消抛异常）→ `response.Content`（`+0x30`，**不调 `EnsureSuccessStatusCode`、不看状态码**）→ `ReadAsStringAsync`（`+0x50`）→ 整页 UTF-8 `std::string`，**不截断**。
- 超时：代码里没有任何超时设置或取消，只有 WinRT `HttpClient` 自身的缺省【确：没设；缺省值多少【未知】】。
- 拼相对地址的基准：`response.RequestMessage.RequestUri`（`+0x60` → `+0x60`，`0x140030d10`–`0x140030df5`），为空才用 1.3 得到的原 URI【确】；它是不是重定向后的最终地址【推：WinRT 在跟随重定向后会更新它】。

### 1.5 找图标链接【确】
五个 `std::regex`，构造函数 `FUN_14003ba10` 把语法标志写死成 `0x100`（`0x14003bb4c`、`0x14003bb5b`）= **`icase`，语法位为 0 按 ECMAScript**；匹配器在 `flags & 0x100` 时逐字符经 `ctype::tolower` 比较（`FUN_14004b060`），确认不分大小写。

| 栈位 | 正则 | 用途 |
|---|---|---|
| `+0x688` | `<link([^>]*)` | 在整页上逐个找 |
| `+0x660` | `rel\W*=\W*"(apple-touch-icon\|apple-touch-icon-precomposed)"` | 判 apple 图标 |
| `+0x5e8` | `href\W*=\W*"([^"]*)"` | 取 href |
| `+0x638` | `sizes\W*=\W*"([\d]*)x([\d]*)"` | 取尺寸 |
| `+0x610` | `rel\W*=\W*"(shortcut\|icon\|\W+)+"` | 判普通图标 |

流程（`0x140030373`–`0x140030c6b`）：
1. 从页面开头 `regex_search(<link…)`，每次从上一次匹配的 suffix 继续，直到找不到；不识别注释、`<script>`、`<head>` 边界，整页所有 `<link` 都算。组 1 = `<link` 之后到第一个 `>` 之前的全部属性文本。
2. 属性文本先试 apple 正则（`regex_search`，0x10 = `match_any`）：
   - 是：`href` 组 1 → 候选串；`sizes` 匹配时 `w = (float)atof(组1)`、`h = (float)atof(组2)`（`FUN_14026d2a8` 返回 double，`cvtsd2ss`），否则 0；**href 非空才加入**（`0x14003080b`）。
   - 否：再试普通图标正则，是 → `href` 组 1（没匹配到就是空串）→ **不论空不空都加入**，`w = h = 0`（`sizes` 不看）。
3. 链接扫完后无条件追加 `"/favicon.ico"`，`w = h = 0`（`0x140030c85`）。
4. `std::stable_sort`（`FUN_14003a6b0`，≤ 32 项插入排序，否则带缓冲归并），比较函数 `0x14002f7b0`：`a.w > b.w`（只比宽，`comiss`/`seta`）。所以宽大的在前，同宽保持文档顺序，`/favicon.ico` 在宽 0 的组里排最后。

正则带来的边界【推：按 ECMAScript 语义推出，没逐个实测】：
- 只认**双引号**的属性值：`rel='icon'`、`rel=icon`、`href='…'` 都认不出（`href` 认不出时 apple 链接被丢弃、普通链接以空串加入）。
- `rel="alternate icon"`、`rel="mask-icon"` 不算普通图标（组只能由 `shortcut`、`icon` 与非单词字符组成）；`rel="icon shortcut"`、`rel = "icon"` 算。
- `rel`、`href`、`sizes` 都是子串匹配：`data-rel="icon"`、`data-href="…"` 也会被当成它们；`href` 取属性文本里第一个匹配。
- `sizes="any"`、`sizes="32x32 64x64"`（引号内不只一组）不匹配 → 宽 0。
- href 不做 HTML 实体解码（`&amp;` 原样）。

### 1.6 下载候选【确】（`0x140030e30`–`0x14003162b`）
对排好序的每一项：
1. href UTF-8 → UTF-16，`基准.CombineUri(href)`（`IUriRuntimeClass +0xb0`）；抛异常 → 改 `Uri(href)` 单独建；还是没有 → 下一项。相对地址（`//`、`/`、`a/b`、`?q`）的拼法就是 WinRT `Uri.CombineUri` 的规则【推：按 RFC 3986 解析，没有逐条实测】；空串 href 会得到基准地址本身【推】，下载回来是 HTML，解码失败，自然跳过。
2. `GetAsync` → `.get()` → `Content.ReadAsBufferAsync`（`+0x40`）→ 整段字节（不截断，不看状态码、不看 `Content-Type`）；长度 0 → 下一项。
3. 解码 `FUN_140066920(len, 字节, &w, &h, &像素, 0)`：
   - `FreeImage_OpenMemory` → `FreeImage_GetFileTypeFromMemory`（**按内容识别**，认不出 = 失败）；
   - ICO（`FIF_ICO = 1`）：`LoadMultiBitmapFromMemory(ICO, mem, 0)`，逐页比 `w·h`，**取像素数严格最大的一页**（相等时保留先出现的），克隆出来；标志 0 = 没有 `ICO_MAKEALPHA`【推：低位深、靠 AND 掩码透明的旧图标得不到透明】；
   - 其它：`FreeImage_LoadFromMemory(fif, mem, 10)`（与属性图片同一组标志：JPEG 精确解码 + EXIF 旋转，PNG 的 `gAMA` 会校正，见 rea-p11b R7）；FreeImage 3.18 没有 SVG，SVG 图标一律失败；
   - 宽或高为 0 失败；非 32 位 `ConvertTo32Bits`；`FlipVertical`；拷出，**字节序是 FreeImage 的 BGRA**，最后一个参数 0 不换通道。
4. 尺寸（`0x1400313aa`–`0x140031403`）：
   ```
   if (w > 512 || h > 512 || w != h) {
       m = min(w, h); if (m >= 512) m = 512;
       FUN_140066d50(&px, w, h, m, m);   // 拉伸成 m×m，不保持比例、不裁切
       w = h = m;
   }
   ```
   `FUN_140066d50` 把像素放进 32 位 FreeImage 位图再调 `FUN_1400653e0(位图, m, m)` 缩放【未知：`FUN_1400653e0` 里用的是哪个 FreeImage 缩放滤镜，没读】。**≤ 512 的正方形不缩放**（实测维基百科 160×160 与此一致）。
5. 圆形遮罩 `FUN_14002f7c0(px, w, h)`（2 节 2.3）。
6. 编 PNG `FUN_14002e5e0`（2 节 2.4）；失败 → 下一项（`0x14003155b`）；成功 → 结束循环，返回真。
- 网站图标这一支**不去预乘、不做 `FUN_140066ef0` 的透明区填色**【确；产物：维基百科与缺省图的缓存 PNG 里 alpha ≤ 1 的像素 RGB 全是 (255, 255, 255)】。

### 1.7 缺省图（`winrtutil!FUN_14002f990`）【确】
- 路径：`GetCurrentDirectoryW()`（`FUN_140007600` → `FUN_14025ad60` → 导入 `GetCurrentDirectoryW`）`/ "../assets/materials/util/webthumbnailfallback.png"`（`FUN_140005b80`，串 `0x14034b188`）。即 winrtutil 进程的**当前目录**，不是 exe 所在目录；WPE 拉起它时当前目录是 `bin`【推：实测 `example.com` 拿到了 300×300 的缺省图】。
- `FreeImage_GetFileTypeU` + `LoadU(…, 10)` 只为取宽高、随即卸载；再整文件读入（`FUN_1400055c0`）、`FUN_140066920` 解码；**不缩放、不补成正方形**；`FUN_14002f7c0` 圆形遮罩；编 PNG。
- 本机文件：300×300、8 位 RGBA，块 `IHDR pHYs iTXt IDAT IEND`。

## 2. 图标的后处理（`winrtutil`）

### 2.1 `FUN_14002ee30`（消息 8：文件、目录、程序、`.lnk`、`.url`）的完整分支【确】
1. 路径 UTF-8 → UTF-16。
2. **不是普通文件**（`FUN_140007530`：`std::filesystem` 状态为 regular；符号链接 / 目录联接的重解析点直接算否）→ `SearchPathW(NULL, 文件名部分, L".exe", 4096, buf, NULL)`（`FUN_140005d50` 取的是 `path.filename()`，只用文件名、丢掉目录），结果是普通文件才替换路径。实测 `calc` → 计算器图标，与此一致。目录也会走这一步（例：`D:/x/Foo` → 找 `Foo.exe`），找不到就保持原路径。
3. **先取 Shell 缩略图** `FUN_14002e0f0`：
   - `CoInitializeEx(STA | DISABLE_OLE1DDE)`；`SHCreateItemFromParsingName` → `CoCreateInstance(CLSID_LocalThumbnailCache)`（`50EF4544-…`）→ `IThumbnailCache::GetThumbnail(item, 256, WTS_EXTRACT = 0, &ISharedBitmap, NULL, NULL)` → `GetSharedBitmap` → `HBITMAP`；
   - `GetDIBits` 先取头：只收 24 位（`biSizeImage == w·h·3`）或 32 位（`== w·h·4`）；按自下而上翻转成自上而下，输出 RGBA，24 位时 alpha 填 255；尺寸 = 缩略图本身的宽高（≤ 256，不一定正方形）；
   - 成功 → **跳过去预乘**，直接 `FUN_140066ef0` → `FUN_140007780`（R、B 互换成 BGRA）→ 编 PNG → 返回。
4. 缩略图失败：
   - 若是目录（`FUN_140007460`）：`CoCreateInstance(CLSID_KnownFolderManager)`（`4DF0C730-…`，IID `IKnownFolderManager` `8BE2D872-…`）→ `FindFolderFromPath(path, FFFP_EXACTMATCH)`（`+0x50`）→ `IKnownFolder::GetFolderDefinition`（`+0x58`）→ `pszIcon` 非空时 `swscanf_s(pszIcon, L"%[^,],-%d", 模块, 4096, &id)`；**恰好 2 项**才继续：`ExpandEnvironmentStringsW` → `LoadLibraryExW(模块, NULL, 0x1002 = AS_DATAFILE | SEARCH_DEFAULT_DIRS)` → `LoadImageW(h, MAKEINTRESOURCE(id), IMAGE_ICON, 256, 256, 0)` → 记为图标 A。不是已知文件夹、`pszIcon` 为空、格式不是 `模块,-数字`（如正数索引）都得不到 A。
   - 扩展名（`path::extension()` 与 `L".url"` 按 `path::compare` 比，**区分大小写**，`FUN_140003240`）是 `.url`：
     - `GetPrivateProfileStringW("InternetShortcut", "IconFile", "", buf, 260, path)`；**为空** → 不用 A，直接走系统图像列表；
     - 否则 `IconIndex`（缺省 0）、`ExpandEnvironmentStringsW`、`PrivateExtractIconsW(文件, 索引, 256, 256, &hicon, &id, 1, 0)`；返回 0 或句柄为空 → 走系统图像列表。
   - 不是 `.url`：有 A 用 A；没有 → 系统图像列表。
   - **系统图像列表**：`SHGetFileInfoW(path, 目录 ? FILE_ATTRIBUTE_DIRECTORY : 0, &sfi, …, 0x4750)`，`0x4750` = `SYSICONINDEX | TYPENAME | DISPLAYNAME | ICON | OVERLAYINDEX | USEFILEATTRIBUTES`；`DestroyIcon(sfi.hIcon)`；`SHGetImageList(SHIL_JUMBO, IID_IImageList)` 成功后 `FUN_14002e860(sfi.iIcon & 0xffffff)`。
     - `SHGFI_USEFILEATTRIBUTES` 意味着**不读文件本身、只按扩展名与属性取图标**【确：标志位；对 `.exe` 会得到通用程序图标而不是程序自己的图标【推：按该标志的文档语义】】。
     - `FUN_14002e860`：依次取 `SHIL_JUMBO(4)`、`SHIL_EXTRALARGE(2)`、`SHIL_LARGE(0)`、`SHIL_SMALL(1)`，`ImageList_GetIcon(…, ILD_TRANSPARENT)`，只收**颜色位图 32 位**的，同尺寸只留一份；排序后从大到小【推：`FUN_14003e450` 按宽比较，方向按后面的选择逻辑推断】逐个检查：若某个更小的条目恰好等于它左上角、它其余部分 alpha 全 0（「48×48 补透明边成 256」的假大图）就跳过它，取第一个不是假大图的；一个都没有 → 失败。
5. 有了 HICON（A、`.url` 的、图像列表的）→ `FUN_14002de50` 画成位图（2.2）→ `DestroyIcon` → **去预乘**（2.2）→ `FUN_140066ef0`（2.3）→ `FUN_140007780` R/B 互换 → 编 PNG。
6. 全部失败 → 返回假 → **不回包**，wallpaper64 那边一直是缺省纹理【推：等待集合里的项不会被清】。
- `.lnk` **没有专门分支**：它走 3（缩略图）或 4 的系统图像列表（按扩展名 `.lnk`）【确：代码里没有 `IShellLink`】。实际是哪一支生效【未知：要看 `IThumbnailCache` 对 `.lnk` / `.exe` 是否返回图，需在本机实测；实测只给出了 256×256】。
- 缩略图（3）与图像列表（4）的退路之间没有交叉：缩略图失败才看 A / `.url` / 图像列表。

### 2.2 画图标与去预乘【确】
- `FUN_14002de50(hicon, &px, &w, &h)`：`GetIconInfo`；没有颜色位图（单色图标）→ 失败；`GetObjectW(hbmColor)` 取 `bmWidth`、`bmHeight`；`CreateCompatibleBitmap(屏幕 DC, bmWidth, bmHeight)`（内容不清零）→ `DrawIconEx(memDC, 0, 0, hicon, bmWidth, bmHeight, 0, NULL, DI_NORMAL)` → `GetDIBits` 32 位、`biHeight = -bmHeight`（自上而下）；缓冲按 `bmHeight² · 4` 分配（假定正方形）；BGRA → RGBA；输出 `w = h = bmHeight`。
- 去预乘（`0x14002f654`–`0x14002f6fc`，`ee30.asm`）：
  ```
  for 每个像素 (RGBA):
      af = (float)a / 255.0f;                 // cvtdq2ps + divss，常量 0x14034c6dc = 255.0f
      r = (uint8)cvttss2si((float)r / af);    // 向零截断成 int32，只存低 8 位
      g = (uint8)cvttss2si((float)g / af);
      b = (uint8)cvttss2si((float)b / af);
  ```
  - 全程单精度，`cvttss2si` 向零截断，**不钳制**：`c > a` 时（非预乘数据）结果 ≥ 256 被截成低字节（例：c = 200、a = 100 → 510 → 254）。
  - **a = 0**：`af = 0`；c > 0 时 `c/0 = +∞`，c = 0 时 `0/0 = NaN`，`cvttss2si` 对两者都给 `0x80000000`，低字节 **0**。所以 a = 0 的像素 RGB 写 0（随后 2.3 会把 alpha ≤ 1 的像素 RGB 换掉）。
  - **c == a 不一定得 255**：a ∈ {1, 2, 4, 5, 8, 9, 10, 16–21, 32–42, 64–84, 128–169} 时得 254（如 128 / (128/255f) = 254.99998）；在 c ≤ a 的全部组合里有 244 个与整数 `floor(c·255/a)` 不同（`unpremul.py`）。
  - 前提是 `DrawIconEx` 画到 32 位兼容位图上得到的是预乘颜色、并带 alpha【推：GDI 对带 alpha 的 32 位图标的行为；对只有 AND 掩码的旧图标，目标 alpha 可能保持 0，整张变透明——没有实测】。

### 2.3 `FUN_14002f7c0`：圆形遮罩（只用于网站图标与缺省图）【确；产物】
```
mask = Mat::zeros(h, w, CV_8UC1);
r = (min(w, h) >> 1) - 2;  if (r <= 1) r = 1;         // 按反编译是无符号比较：min(w,h) < 4 时下溢成很大的数，当 int 传给 circle 是负半径，
                                                       // OpenCV 断言失败抛异常 → 网站图标那支被候选的 catch 接住、换下一个【推：没核对指令】
cv::circle(mask, Point(w >> 1, h >> 1), r, Scalar(255), FILLED, LINE_AA /*16*/, 0);
for 每个像素: a = (mask · a) >> 8;                     // 除以 256，不是 255
```
- 圆内 a = 255 的像素变 **254**，圆外 0，边上是 OpenCV 抗锯齿的过渡值。缓存产物：维基百科 160×160 的 (80, 1) 处 alpha 49、(80, 0) 处 0、(80, 2) 起 254，与 r = 78、圆心 (80, 80) 一致；缺省图 300×300 同理。

### 2.4 `FUN_140066ef0`：透明区填色（OpenCV 4.4.0，`FUN_1400645d0`）【确；产物】
输入 4 通道 `CV_8UC4`（就地包装 `Mat(h, w, CV_8UC4, data)`），通道顺序无关、alpha 在第 4 个字节：
```
rgb   = cvtColor(src, COLOR_BGRA2BGR /*1*/);      // 丢掉第 4 通道
alpha = split(src)[3];
small  = resize(rgb,   Size(64, 64), 0, 0, INTER_LINEAR);
smallA = resize(alpha, Size(64, 64), 0, 0, INTER_LINEAR);
threshold(smallA, smallA, 8.0, 255.0, THRESH_BINARY);  bitwise_not(smallA, smallA);  // 掩码 = 缩小后 alpha ≤ 8
inpaint(small, smallA, small, 8.0, INPAINT_TELEA /*1*/);
bg = resize(small, Size(w, h), 0, 0, INTER_LINEAR);
t  = threshold(alpha, 1.0, 255.0, THRESH_BINARY);  bitwise_not(t, t);               // 原图 alpha ≤ 1
for 每个像素: k = t/255.0f;  rgb = (uint8)(int)(rgb·(1−k) + bg·k);                   // k 只有 0 / 1，等于「alpha ≤ 1 处换成 bg」
dst = merge(split(rgb) + [alpha]);                  // alpha 原样
```
- 识别依据：`FUN_14016f140` = `cv::cvtColor`、`FUN_1401ad590` = `cv::resize`、`FUN_14016e420` = `cv::threshold`、`FUN_1400a5640` = `cv::split`（各自的断言串与源文件串），`FUN_140091b60` = `cv::bitwise_not`（`binary_op(a, a, dst, noArray, not8u, bitwise=1, OCL_OP_NOT = 12)`），`FUN_140259e10` = `cv::inpaint`（插桩名 `0x14032a0a0`），`FUN_140095b30` = `cv::merge`；常量 8.0（`0x14034c698`）、255.0、1.0 读自 `.rdata`，半径与 flags 在 `0x14006497d`、`0x14006499f`。
- 作用：给 alpha ≤ 1 的像素填上附近不透明区的颜色，避免线性采样时边缘发黑；不改 alpha、不改 alpha ≥ 2 的像素。
- 产物：消息 8 写进缓存的 4 个 RGBA 条目里，alpha ≤ 1 的像素有 2536–6728 种不同 RGB（填色），网站图标与缺省图的只有 (255, 255, 255)（没做这步）。

### 2.5 编 PNG（`FUN_14002e5e0`）【确；产物】
- 输入 BGRA（消息 8 已经 `FUN_140007780` 换过；网站图标直接是 FreeImage 的 BGRA）→ `FreeImage_Allocate(w, h, 32)` 逐像素 `SetPixelColor` → `FlipVertical` → `FreeImage_SaveToMemory(FIF_PNG, …, 0)`。
- 产物块：`IHDR pHYs IDAT IEND`，**没有 `gAMA`、`iCCP`、文本块**；8 位；有任一 alpha ≠ 255 时 RGBA（类型 6），全部 255 时 RGB（类型 2，缓存里 `calc` 那条就是）。去 alpha 只影响文件格式，解码后仍是 alpha 255，不影响结果。
- wallpaper64 用 wuffs 解码这份 PNG（rea-p11-textures 第 5 节），没有 `gAMA` 也就没有伽马校正问题。

## 3. wallpaper64 给脚本的字段（`FUN_1401731d0`，`0x140173b14` 起）
按主会话要求没有再深挖，以实测为准：
- 解析失败（空串、哈希段不是 6 位）→ `{isbound: false}`，**没有** `commandtype`、`file` 两个键【实测】；`0x140173ee5` 分支没有逐条读【未知：指令级没核对，实测已定】。
- `cmd:<哈希>:calc /x` → `{isbound: true, commandtype: "command", file: "calc"}`：`file` 是解析后的程序部分（解析器在第一个空格处拆参数）【实测；与 rea-p11-media 4.1 的解析一致】。`FUN_1400187b0` 的规整规则没读【未知】，`cmd` / `web` 不经过它（rea-p11-media 4.2）。
- `engine.userProperties` 里快捷方式属性始终是 `{}`【实测】；`FUN_14018dc70` 没读【未知】。
- 门禁抛的是 `SyntaxError`【实测，更正 rea-p11-media 4.3 的 `Error`】。

## 4. wallpaper64 `FUN_140174710` 的网址分支【确，另注的除外】
- `FUN_1401708c0(槽值, &out)`；失败 → 返回假（缺省纹理）。
- `isWeb = (out.type 长度 == 3 && memcmp(out.type, "web", 3) == 0)`（`0x14048ddf8` = `"web"`）。
- 调 `DesktopMediaExtensions` 虚函数 `+0x110`（`FUN_1400c5760`）时传的目标串是 **`out.path`**（`out+0x40`）：
  - `web` → 用户填的网址整串（界面已补好 `https://`）；
  - `cmd` → 第一个空格之前的程序部分；
  - `file` → `|` 之前的路径；`directory` → 整个路径。
- 等待表 `P+0x148` 的键也是 `out.path`，值是完整槽值（`0x1401749xx`）。
- **不校验系统哈希**：本函数只调解析、不调 `0x1400c5090` 里的哈希比对，所以别的机器上配的值在本机也会取图标（只是启动会被拒）【确：本函数内没有哈希路径】。
- 缓存：`FUN_1400c5760` 用 `"bin"`（`0x140473850`）与 `"thumbnail.cache"`（`0x140486588`）拼路径，本机文件在 `<WPE>/bin/thumbnail.cache`（头 `SHTC0001`）。键 = **目标串 UTF-8 字节的 SHA-256**：用本机缓存核对，`sha256("https://www.wikipedia.org")`、`sha256("https://example.com")`、`sha256("calc")` 都命中，带尾 `/` 或 `calc.exe` 都不命中【确：产物】。条目 52 字节：32 字节键 + 宽 + 高 + 文件偏移 + 长度 + 再一个 4 字节（与长度同值，含义【未知】）；缓存里的宽高就是回包里的 `w/h`（维基百科 160×160、缺省图 300×300、其余 256×256）。

---

## 对 Kabegame 的含义
1. **网址**：照 1.3–1.6 做（后端 Rust 侧最合适）：先按原串建 URL，建不成再补 `https://`、`https://www.`；只带那条 iPhone UA；不看状态码；整页按字符串读，不分大小写地扫全部 `<link`，只认双引号属性，apple 图标按 `sizes` 的宽排前（href 空的不收），普通图标宽 0（href 空也收），最后 `/favicon.ico`；按宽从大到小**稳定**排序，以最终响应地址为基准解析相对地址，逐个下载，第一个能解码的就用。
2. **网站图标的像素**：按内容识别格式（ICO 取像素最多的一帧，不支持 SVG）；≤ 512 的正方形保持原尺寸，否则拉伸成 `min(w, h, 512)` 的正方形（缩放滤镜待定，先用双线性）；再乘圆形遮罩：半径 `max(1, (min(w,h) >> 1) − 2)`，圆心 `(w >> 1, h >> 1)`，抗锯齿，`a = (mask·a) >> 8`（圆内 254）。不去预乘、不填色。
3. **缺省图**：页面取不到、所有候选都失败时，用 `<WPE>/assets/materials/util/webthumbnailfallback.png`（Kabegame 可以内置同一张或读 WPE 的），原尺寸 + 同样的圆形遮罩；缺省图也读不到就当没有图标（缺省纹理）。
4. **文件 / 程序 / 目录**：Windows 后端照 2.1 的顺序：不存在的普通文件按文件名 `SearchPath` 补 `.exe`；先 Shell 缩略图（256，`IThumbnailCache` 或等价的 `IShellItemImageFactory` 只取缩略图）；再已知文件夹图标 / `.url` 的 `IconFile` / 按扩展名的系统图像列表（JUMBO 起，丢掉补边的假大图）。`.lnk` 不特殊处理。哪一支在 `.exe`、`.lnk` 上实际生效需要本机对照 WPE 缓存里的图（`tcall.py` 能读出 WPE 写的 PNG 直接比）。
5. **去预乘**只对 HICON 那几支做，必须用 `Math.fround` / `f32` 复刻：`af = f32(a)/255`，`c' = trunc(f32(c)/af) & 0xff`，`a = 0` 写 0、不钳制。
6. **透明区填色**（2.4）对消息 8 的全部结果都做；精确复刻要 OpenCV 的 TELEA inpaint，代价大。它只改 alpha ≤ 1 的像素 RGB，只在线性采样的边缘上看得出；可以先用「最近不透明像素颜色 / 模糊扩散」近似，并在文档里记为已知差异。
7. **缓存**：WPE 的键是 `sha256(路径段的 UTF-8)`；Kabegame 自己的缓存键照这个即可，取图标时不校验机器哈希（与 WPE 一致），启动时照旧校验。
8. **纹理**：回到 wallpaper64 后的处理不变（rea-p11-textures 第 5 节：按槽比例补透明边居中、CLAMP、`R8G8B8A8_UNORM`）；网站图标不再是 256 边长，补边按实际尺寸算。

## 留给实测的问题
| # | 问题 | 怎么测 |
|---|---|---|
| 1 | `.exe` / `.lnk` / 普通文件实际走缩略图还是系统图像列表 | 用 `tcall.py` 读 WPE 缓存里这几条 PNG，与 `IThumbnailCache` 和 `SHGetFileInfo + SHIL_JUMBO` 各自的输出逐像素比 |
| 2 | 非正方形或 > 512 的网站图标的缩放滤镜 | 本地起一个 HTTP 服务给 600×400 的 PNG 图标，读缓存里的 512×512 结果，与几种 FreeImage 滤镜比 |
| 3 | 重定向后相对 href 的基准、`//`、`../` 的拼法 | 本地服务做 302 到子路径的页面，图标用各种相对写法，看哪一个被取到（缓存 PNG 与源图比） |
| 4 | 只有 AND 掩码的旧图标经 `DrawIconEx` 后的 alpha | 配一个只有 32×32 4 位图标的 `.url`（`IconFile` 指向它），读缓存 PNG 的 alpha |
