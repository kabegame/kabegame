# wpefont

场景壁纸（`x-wpe/scene`）文本对象的字体引擎：FreeType 2.14.3 + HarfBuzz 15.0.0 + msdfgen v1.13 加两小段胶水（`wpefont.c`、`msdf.cpp`），编成
wasm32-wasip1 reactor，在场景宿主（`apps/wpe-scene`）的主线程里运行。**不链进应用**，应用的 Rust 代码也不依赖它。
和 `src-tauri/wpesl2wgsl` 并列：都是「编成 wasm 给场景渲染器用」。

它只做「加载字体、查字、度量、排字、取字形位图、生成 MSDF 距离场格子」，没有状态之外的逻辑；回退链、断行、对齐、图集这些排版规则一条都
不放在 C 里（P6b 1c 的 `apps/wpe-scene/src/text/`）。

## 构建与接入

```bash
deno task build:wpefont   # → bin/wasm/wpefont/wpefont.wasm（git 忽略，约 1.8 MB）
```

- 脚本 `scripts/build-wpefont.ts`：
  1. 检查子模块 `third/freetype`（`VER-2-14-3`）、`third/harfbuzz`（`15.0.0`）与 `third/msdfgen`（tag `v1.13`），并核对头文件
     与 `vcpkg.json` 里的版本号（msdfgen 读 `vcpkg.json` 的 `version`，应为 `1.13.0`；v1.13.1 不行，见下）；
  2. 用 `scripts/download.ts` 的 `fetchPinned` 把 wasi-sdk 34 的 `wasi-sysroot-34.0.tar.gz`、`libclang_rt-34.0.tar.gz`
     下到 `bin/wasm/wpefont/toolchain/`（SHA-256 校验，已有且摘要对就不下载，能续传）并解压；
  3. 找 clang：`WPEFONT_CLANG` → `PATH` 上的 `clang` → macOS 的 `/opt/homebrew/opt/llvm/bin/clang`、
     `/usr/local/opt/llvm/bin/clang`，要求 `--print-targets` 里有 wasm32，再用 `-Wl,--version` 预检它调得起 wasm 链接器
     （找不到时报出 clang 要找的名字与安装命令；Ubuntu 的 clang-N 找的是 `wasm-ld-N`，要装 `lld-N`）。Apple clang 没有 wasm
     后端，macOS 要 Homebrew 的 `llvm` 与 `lld`。1a / 1b 用的是 LLVM clang 22.1.6；
  4. 并行编译 FreeType 的 21 个单元、`harfbuzz.cc`、msdfgen 的 `core/*.cpp`（去掉文件输出、SVG 导出、形状描述文本）、`wpefont.c` 与
     `msdf.cpp`，链接成 reactor。
- `--if-stale`：按输入指纹（构建脚本、本目录除 README 外的源文件、三个子模块的提交与本地改动，记在
  `bin/wasm/wpefont/wpefont.wasm.inputs.json`）判断，没变就直接退出、不碰工具链。
- 场景宿主的 vite build 与 vitest 开始前（`apps/wpe-scene/wasmDeps.ts`）都以 `--if-stale` 跑一次，再把产物拷进
  `apps/wpe-scene/src/wpefont/wpefont.wasm`（git 忽略，内容相同不重写），改了胶水、编译参数或子模块不用记得手动重建。
  构建失败（缺 clang、子模块没初始化等）只告警、沿用已有产物；没有产物时文本对象退回预览图，产物过旧时报 `text:engine`。
- 路径常量 `WPEFONT_WASM`、`WPEFONT_FE_WASM`、`WPEFONT_TOOLCHAIN_DIR` 在 `scripts/paths.ts`。

### 编译参数（照 P6b 1a，和 WPE 图集逐字节一致的那一版）

| 部分 | 参数 |
|---|---|
| 公共 | `--target=wasm32-wasip1 --sysroot=<wasi-sysroot> -O2 -g0 -fvisibility=hidden`；不加任何改变数值结果的开关（`-ffast-math` 之类） |
| setjmp / longjmp | `-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false`（wasm 异常处理 exnref；光栅化器的池溢出要用），链接 `-lsetjmp` |
| FreeType | `-DFT2_BUILD_LIBRARY -DFT_CONFIG_MODULES_H="ftmodule.h" -DFT_CONFIG_OPTION_USE_HARFBUZZ`（加 HarfBuzz 的 `src` 进包含路径），模块表 `ftmodule.h`：`autofit`、`truetype`、`cff`、`psaux`、`psnames`、`pshinter`、`sfnt`、`smooth`（另编 `gzip`） |
| HarfBuzz | 单文件 `harfbuzz.cc`，`-nostdinc++ -isystem <sysroot>/include/wasm32-wasip1/noeh/c++/v1 -std=c++17 -fno-exceptions -fno-rtti -fno-threadsafe-statics`，`-DHAVE_FREETYPE=1 -DHB_NO_MT -DHAVE_FT_GET_VAR_BLEND_COORDINATES=1 -DHAVE_FT_SET_VAR_BLEND_COORDINATES=1 -DHAVE_FT_DONE_MM_VAR=1 -DHAVE_FT_GET_TRANSFORM=1` |
| msdfgen | `core/*.cpp`（去掉 `save-*`、`export-svg`、`shape-description`），HarfBuzz 那套 C++ 参数（libc++ 无异常头、`-fno-exceptions -fno-rtti -fno-threadsafe-statics`）加 `-DMSDFGEN_PUBLIC=`；不开 OpenMP、不开 skia。`msdf.cpp` 包含 FreeType 头，另带 sjlj 参数 |
| 链接 | `-mexec-model=reactor -nodefaultlibs`、noeh 的 `-lc++ -lc++abi`、`-lsetjmp -lc`、`libclang_rt.builtins.a`、`-Wl,--gc-sections -Wl,--strip-debug -Wl,-z,stack-size=1048576`、逐个 `--export` |

FreeType 开 `FT_CONFIG_OPTION_USE_HARFBUZZ`（P6f 起，2026-11-19）：自动 hinter 经 HarfBuzz 顺着 GSUB 给字形归类，只能经替换到达、cmap 里没有的字形（上下文替换、连字等）才和 WPE 一样按所属文字 hinting。1a 当时测的字形都在 cmap 里，开不开结果相同，所以没开；P6f 走查 `3833971732` 的时钟「16:22」里 HarfBuzz 把冒号换成抬高的冒号（LXGW 文楷 gid 20066，没有 `fpgm`、走自动 hinter），不开时 hinted 框宽 13、开了是 12，和 WPE 的四边形与 MSDF 格子逐字节相同。FreeType 2.14 起光栅化器只要有
64 位整数就用 DDA 展平曲线，wasm32 与 x64 结果相同；2.13 要打的那处补丁不再需要。

## 版本与对照结论

WPE 用的是 FreeType 2.14 系列。1a 把各版本编成 wasm，对 `p6b-*` 测试工程逐个栅格化，和 WPE 抓帧的图集（约 70 万像素）比：

| FreeType | 和 WPE 不同的像素 |
|---|---|
| 2.13.2、2.13.3 | 37（opensticks 的 3 个字形） |
| 2.14.0 – 2.14.3 | 1（opensticks 的「2」，WPE 图集装箱器清零格子四周造成，不是栅格化差异） |
| 2.15.0 | 另加微软雅黑 / Malgun 的 251 个 |

HarfBuzz 用 15.0.0，与离线参考 `uharfbuzz` 同版本。

**msdfgen 用 v1.13**（`third/msdfgen` 子模块，tag `v1.13`）。依据是对 WPE 2.8.42 的静态逆向（`rea-p6f-msdf` 第 1 节）：
`core/` 里本流程用到的代码在提交 `e36d714`（2025-09-18）到 `1c106ed`（v1.13.1 的一部分）之间逐行相同，v1.13 落在区间内；
区间上界是 `edgeColoringSimple` 里的 `symmetricalTrichotomy`：WPE 是旧式 `int(3 + 2.875·p/(n−1) − 1.4375 + .5) − 3`，
`1c106ed` 改成了 `(3p+1)/n − 1`，所以不能用 v1.13.1（两式只在「恰有一个角的轮廓、边数 ≥ 47」时不同，字体里几乎不出现，但要逐字节一致就用 v1.13）。

**MSDF 对照结论**（P6f 步骤 0b）：`msdf.cpp` 照 WPE 的外围流程（`FT_LOAD_NO_BITMAP` 带 hinting 按 300 DPI 取轮廓、`FT_Glyph_Get_CBox(PIXELS)`
取框、多调一次 `orientContours`、投影参数 float32、`×256` 截断转字节、上下翻转、alpha 255）生成格子，和 WPE 抓帧里的 MSDF 图集（`p6f-*` 工程）
比：**9 张图集、148 个格子、约 101 万字节全部逐字节相同**，覆盖 TrueType 字节码、CFF、无指令 TrueType（强制自动 hinting）、回退到 msyh 的
CJK、空格占格、同字形先到的字号胜出与 94 个字形跨多行的装箱。`apps/wpe-scene/src/wpefont/index.test.ts` 用其中 11 个格子的 SHA-1 做基线。
唯一没覆盖的是彩色 face（`FT_HAS_COLOR`）：WPE 对它不经 msdfgen，用自己的距离变换，这里不做，宿主报 `text:msdf:color`。

1b 用子模块（git checkout，`src/`、`include/` 与发布包逐字节相同）重新构建，跑同一套对照（`p6b-geom`、`p6b-align`、
`p6b-fx`、`p6b-fallback`、`p6b-extra` 的 38 个对象、342 个字形），和 1a 发布包 2.14.3 的结果逐字段相同（gid、cluster、
步进、偏移、位图尺寸、left / top、像素格式、位图 SHA-1）。`apps/wpe-scene/src/wpefont/index.test.ts` 用其中 9 个单行、
不需要回退的对象做基线。1c 改接口（`wpefont_glyph` 回到 6 个 int、加 `wpefont_glyph_box`）后重跑同一套对照，仍逐字段相同；
新框只在 😀 一个字形上和位图框不同。在这之上 `text/` 的排版与图集和 WPE 抓帧逐坐标、逐字节相同（`text/layout.test.ts`）。

## 接口（C ABI）

导出全部是 `wpefont_*`，指针都是 wasm32 线性内存里的偏移。字体句柄是不透明指针，0 表示失败。

| 导出 | 参数 | 说明 |
|---|---|---|
| `wpefont_alloc(size) -> ptr` | 字节数 | `malloc`，失败返回 0 |
| `wpefont_free(ptr)` | | `free` |
| `wpefont_font_new(data, length, size26_6) -> font` | `data` 由 `wpefont_alloc` 分配，**所有权交给字体**；`size26_6` 为 `trunc(pointsize · 64)` | `FT_New_Memory_Face`（第 0 个 face）、`FT_Select_Charmap(UNICODE)`、`FT_Set_Char_Size(0, size26_6, 300, 300)`、`hb_ft_font_create`。失败返回 0，`data` 已释放 |
| `wpefont_font_free(font)` | | 释放 `hb_font_t`、`FT_Face` 与字体数据；`font` 为 0 时什么也不做 |
| `wpefont_font_has(font, codepoint) -> 0/1` | Unicode 码点 | `FT_Get_Char_Index != 0`（回退链逐码点查） |
| `wpefont_font_metrics(font, out)` | `out`：7 个 `int32` | 见下 |
| `wpefont_shape(font, text, length, out, cap) -> n` | `text`：`length` 个 UTF-32 码点；`out`：`6 · cap` 个 `int32` | `hb_buffer_add_utf32` + `hb_buffer_guess_segment_properties` + `hb_shape`（不带 features）。最多写 `cap` 个字形，返回实际字形数；返回值大于 `cap` 时放大缓冲重排 |
| `wpefont_glyph(font, gid, out) -> bitmap` | `out`：6 个 `int32` | `FT_Load_Glyph(gid, load_flags)`，再 `FT_Get_Glyph`（WPE 两步都要成功）→ `FT_Done_Glyph`。返回字形槽里的位图缓冲（同一字体下次加载字形前有效；空字形可能为 0） |
| `wpefont_msdf(font, gid, out) -> rgba` | `out`：8 个 `int32` | MSDF 格子（msdfgen v1.13 + WPE 外围流程，`msdf.cpp`），返回 `cellW · cellH · 4` 字节 RGBA（第 0 行在上、alpha 255），**调用方用 `wpefont_free` 释放**。加载标志同 `wpefont_glyph_box`。包围盒为空（空格）时返回全 0 的 24 × 24 格子；加载失败或不是轮廓字形返回 0，`out` 全 0 |
| `wpefont_glyph_box(font, gid, out) -> 0/非 0` | `out`：4 个 `int32` | WPE 的取框（`FUN_1401addb0`）：`FT_Load_Glyph(gid, FT_LOAD_NO_BITMAP \| (load_flags & FT_LOAD_FORCE_AUTOHINT))` → `FT_Get_Glyph` → `FT_Glyph_Get_CBox(FT_GLYPH_BBOX_PIXELS)`。成功返回 0；失败返回非 0、`out` 不写。会覆盖字形槽，`wpefont_glyph` 返回的位图指针随之失效 |

**输出布局：**

- `wpefont_font_metrics`：`[ascender, descender, height, units_per_EM, load_flags, y_ppem, has_color]`。前三个是 `face->size->metrics`，
  **26.6**（FreeType 已取整到整像素）；`load_flags` 见 hinting 规则；`y_ppem` 是 `size->metrics.y_ppem`（整数像素，MSDF 格子大小与
  四边形外扩按它）；`has_color` 是 `FT_HAS_COLOR(face)`（0 / 1）。
- `wpefont_shape`：每个字形 `[gid, cluster, x_advance, y_advance, x_offset, y_offset]`，后四个 **26.6**；`cluster` 是输入码点的
  下标。WPE 排版只用 `x_advance >> 6`。
- `wpefont_glyph`：`[width, rows, pitch, bitmap_left, bitmap_top, pixel_mode]`，全是**整数像素**。
  - `pixel_mode`：2 = 灰度（1 字节 / 像素），7 = BGRA（彩色字形，预乘 alpha，4 字节 / 像素）；字体内嵌点阵可能给
    1 = 单色（1 位 / 像素，高位在左）。`pitch` 是行跨度，为负时第一行在缓冲末尾。
  - `bitmap_left`：笔位置到位图左边；`bitmap_top`：基线到位图上边，向上为正。
  - 位图宽高就是 WPE 图集的格子（它对这次加载的位图字形取 `FT_Glyph_Get_CBox(PIXELS)`，等于位图框）。
  - 失败（gid 越界、字形数据坏）时返回 0，`out` 除 `pixel_mode` 外全为 0，`pixel_mode` 为 −1。
- `wpefont_msdf`：`[x0, y0, x1, y1, cellW, cellH, generated, y_ppem]`。前四个是 `FT_Glyph_Get_CBox(PIXELS)` 的整数像素框（y 向上，同
  `wpefont_glyph_box`）；格子 `inner = max(1, trunc(框 · f32(32 / y_ppem)))`（`y_ppem < 2` 当 1），`cell = inner + 24`（四周各 12 像素余量）；
  `generated` 为 0 表示框为空、没有生成（格子全 0）；`y_ppem` 是生成时这个 face 的值。WPE 用**第一个用到这个字形的对象**的字号生成，
  由调用方决定传哪个 face。
- `wpefont_glyph_box`：`[xMin, yMin, xMax, yMax]`，轮廓框向外取整的**整数像素**，y 向上。WPE 的字形四边形、断行的墨迹右沿、
  行与文字框的包围盒都用它，图集格子用位图宽高（P6b 1c 实验，`ignore/p6/b1c/`）：
  - 普通灰度字形两者相同（smooth 渲染器的位图框就是轮廓框向外取整）：`p6b-*` 的 499 个 WPE 四边形全部如此。
  - 彩色字形不同：Segoe UI Emoji 的 😀（32 磅）框是 `21, −24, 162, 118`（141×142，WPE 的四边形），位图是 133×132
    （WPE 的格子），位图被拉伸到四边形上；Twemoji 是 COLR 字体，基础字形没有轮廓，框为空，WPE 画成零尺寸四边形。
  - 强制自动 hinting 的位照加（WPE 那份 FreeType 两次加载 hinting 一样；加不加在 `p6b-*` 上结果相同）。
  - 只有内嵌点阵的字体（sbix / CBDT）`NO_BITMAP` 加载失败，WPE 沿用上一个字形的框（没测过）。

## 规则

- **300 DPI**：`FT_Set_Char_Size(face, 0, trunc(pointsize · 64), 300, 300)`，字号取整在 JS 侧（`Math.trunc`）。
- **两条 hinting 规则**（2026-11-12 实测，离线参考 `FTRULE=fpgm FTCFF=native` 与 WPE 图集一致）：
  1. TrueType（有 `glyf` 表）**没有 `fpgm`** 时强制自动 hinting（`FT_LOAD_FORCE_AUTOHINT`）。FreeType 自己判「没有 hinting」
     时还要看 `prep`，所以要在胶水里按 `fpgm` 补，不能交给 FreeType；
  2. CFF（OpenType 的 `otf`）不强制，走原生 CFF 引擎。
- 加载标志是 `FT_LOAD_RENDER | FT_LOAD_COLOR`（加规则 1 的 `FT_LOAD_FORCE_AUTOHINT`）：COLR 的彩色字形栅格化成 BGRA。
  sbix 与 CBDT 读不了：它们的彩色字形是内嵌 PNG，构建没开 `FT_CONFIG_OPTION_USE_PNG`（`FT_DEFS` 只有模块表，FreeType 缺省的
  `ftoption.h` 里这一项是注释掉的），也没有编进 libpng，FreeType 加载这类字形报 `Unimplemented_Feature`。所以 Apple Color
  Emoji（sbix）、Noto Color Emoji（CBDT）不能当 emoji 字体用，文本的 emoji 在 Windows 以外交给回退链里的 Twemoji（COLR）。

## WASI 导入与宿主

wasm 导入了 13 个 `wasi_snapshot_preview1` 函数（`environ_get environ_sizes_get clock_time_get fd_close fd_fdstat_get
fd_fdstat_set_flags fd_prestat_get fd_prestat_dir_name fd_read fd_seek fd_write path_open proc_exit`，构建脚本最后会列出），
都来自 wasi-libc，胶水不读文件、不写输出。宿主（`apps/wpe-scene/src/wpefont/index.ts`）给的是桩：没有预打开目录
（`fd_prestat_get` 返回 EBADF）、环境变量与参数为空、`fd_write` 丢弃但报告写完、`proc_exit` 抛错，其余文件操作返回
EBADF；模块将来多导入了别的函数，`fd_*` / `path_*` 返回 EBADF、其余 ENOSYS。实例化后调 `_initialize`。

宿主要支持 wasm 异常处理（exnref）。Node 26 支持；CEF 149 待核对（P6b 1b 验收的 CEF 一项）。

## JS 包装

`apps/wpe-scene/src/wpefont/index.ts`：`loadWpefont()`（主线程 `fetch` → `compile` → 实例化，失败返回 null、原因见
`wpefontLoadError()`）、`Wpefont.fromBytes()`（Node 测试用）、`Wpefont.face(bytes, pointsize)` 与 `WpefontFace` 的
`has` / `metrics` / `isColor` / `shape` / `glyph` / `box` / `msdf` / `dispose`（`msdf(gid)` 返回 `MsdfCell`：像素框、格子宽高、`generated`、`yPpem`、拷出的 RGBA 像素）。位图拷出成按行紧排的 `Uint8Array`，不暴露 wasm 内存；wasm 内存会
增长，每次访问都重新取 `memory.buffer`。`box(gid)` 按 gid 缓存（WPE 也缓存），失败为 null。

排版、回退链与图集在 `apps/wpe-scene/src/text/`（P6b 1c），见 `cocs/wpe/scene/TEXT.md`「字体引擎 `wpefont`」。

`index.test.ts`：wasm 不存在就整组跳过；`KABEGAME_WPE_ROOT` 指向 WPE 安装目录时，用 WPE 自带字体跑基础用例与
`fixtures/baseline.json` 的逐项基线（由 `apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py` 从 1a 的结果生成）。
MSDF 格子基线（11 个格子的 SHA-1，取自 WPE 的 p6f-atlas 图集）里 msyh 与 arial 两项读 `C:/Windows/Fonts`，没有就跳过；别的用例不读系统字体。

```bash
cd apps/wpe-scene
KABEGAME_WPE_ROOT=<steamapps>/common/wallpaper_engine node ../../node_modules/vitest/vitest.mjs run src/wpefont
```
