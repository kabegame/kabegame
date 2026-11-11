# wpefont

场景壁纸（`x-wpe/scene`）文本对象的字体引擎：FreeType 2.14.3 + HarfBuzz 15.0.0 加一小段 C 胶水（`wpefont.c`），编成
wasm32-wasip1 reactor，在场景宿主（`apps/wpe-scene`）的主线程里运行。**不链进应用**，应用的 Rust 代码也不依赖它。
和 `src-tauri/wpesl2wgsl` 并列：都是「编成 wasm 给场景渲染器用」。

它只做「加载字体、查字、度量、排字、取字形位图」，没有状态之外的逻辑；回退链、断行、对齐、图集这些排版规则一条都
不放在 C 里（P6b 1c 的 `apps/wpe-scene/src/text/`）。

## 构建与接入

```bash
deno task build:wpefont   # → bin/wasm/wpefont/wpefont.wasm（git 忽略，约 1.8 MB）
```

- 脚本 `scripts/build-wpefont.ts`：
  1. 检查子模块 `third/freetype`（`VER-2-14-3`）与 `third/harfbuzz`（`15.0.0`），并核对头文件里的版本号；
  2. 用 `scripts/download.ts` 的 `fetchPinned` 把 wasi-sdk 34 的 `wasi-sysroot-34.0.tar.gz`、`libclang_rt-34.0.tar.gz`
     下到 `bin/wasm/wpefont/toolchain/`（SHA-256 校验，已有且摘要对就不下载，能续传）并解压；
  3. 找 clang：`WPEFONT_CLANG` → `PATH` 上的 `clang` → macOS 的 `/opt/homebrew/opt/llvm/bin/clang`、
     `/usr/local/opt/llvm/bin/clang`，要求 `--print-targets` 里有 wasm32（同目录要有 `wasm-ld`）。Apple clang 没有 wasm
     后端，macOS 要 Homebrew 的 `llvm` 与 `lld`。1a / 1b 用的是 LLVM clang 22.1.6；
  4. 并行编译 FreeType 的 21 个单元、`harfbuzz.cc` 与 `wpefont.c`，链接成 reactor。
- kabegame 的 dev / start / build / check / test 不带 `--skip vue` 时，`scripts/plugins/wpefont-plugin.ts` 把产物拷进
  `apps/wpe-scene/src/wpefont/wpefont.wasm`（git 忽略，内容相同不重写）。找不到产物只告警，文本对象退回预览图。
- 路径常量 `WPEFONT_WASM`、`WPEFONT_FE_WASM`、`WPEFONT_TOOLCHAIN_DIR` 在 `scripts/paths.ts`。

### 编译参数（照 P6b 1a，和 WPE 图集逐字节一致的那一版）

| 部分 | 参数 |
|---|---|
| 公共 | `--target=wasm32-wasip1 --sysroot=<wasi-sysroot> -O2 -g0 -fvisibility=hidden`；不加任何改变数值结果的开关（`-ffast-math` 之类） |
| setjmp / longjmp | `-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false`（wasm 异常处理 exnref；光栅化器的池溢出要用），链接 `-lsetjmp` |
| FreeType | `-DFT2_BUILD_LIBRARY -DFT_CONFIG_MODULES_H="ftmodule.h"`，模块表 `ftmodule.h`：`autofit`、`truetype`、`cff`、`psaux`、`psnames`、`pshinter`、`sfnt`、`smooth`（另编 `gzip`） |
| HarfBuzz | 单文件 `harfbuzz.cc`，`-nostdinc++ -isystem <sysroot>/include/wasm32-wasip1/noeh/c++/v1 -std=c++17 -fno-exceptions -fno-rtti -fno-threadsafe-statics`，`-DHAVE_FREETYPE=1 -DHB_NO_MT -DHAVE_FT_GET_VAR_BLEND_COORDINATES=1 -DHAVE_FT_SET_VAR_BLEND_COORDINATES=1 -DHAVE_FT_DONE_MM_VAR=1 -DHAVE_FT_GET_TRANSFORM=1` |
| 链接 | `-mexec-model=reactor -nodefaultlibs`、noeh 的 `-lc++`、`-lsetjmp -lc`、`libclang_rt.builtins.a`、`-Wl,--gc-sections -Wl,--strip-debug -Wl,-z,stack-size=1048576`、逐个 `--export` |

FreeType 的自动 hinter 不开 `FT_CONFIG_OPTION_USE_HARFBUZZ`（1a 实测结果相同，少一层依赖）。FreeType 2.14 起光栅化器只要有
64 位整数就用 DDA 展平曲线，wasm32 与 x64 结果相同；2.13 要打的那处补丁不再需要。

## 版本与对照结论

WPE 用的是 FreeType 2.14 系列。1a 把各版本编成 wasm，对 `p6b-*` 测试工程逐个栅格化，和 WPE 抓帧的图集（约 70 万像素）比：

| FreeType | 和 WPE 不同的像素 |
|---|---|
| 2.13.2、2.13.3 | 37（opensticks 的 3 个字形） |
| 2.14.0 – 2.14.3 | 1（opensticks 的「2」，WPE 图集装箱器清零格子四周造成，不是栅格化差异） |
| 2.15.0 | 另加微软雅黑 / Malgun 的 251 个 |

HarfBuzz 用 15.0.0，与离线参考 `uharfbuzz` 同版本。

1b 用子模块（git checkout，`src/`、`include/` 与发布包逐字节相同）重新构建，跑同一套对照（`p6b-geom`、`p6b-align`、
`p6b-fx`、`p6b-fallback`、`p6b-extra` 的 38 个对象、342 个字形），和 1a 发布包 2.14.3 的结果逐字段相同（gid、cluster、
步进、偏移、位图尺寸、left / top、像素格式、位图 SHA-1）。`apps/wpe-scene/src/wpefont/index.test.ts` 用其中 9 个单行、
不需要回退的对象做基线。

## 接口（C ABI）

导出全部是 `wpefont_*`，指针都是 wasm32 线性内存里的偏移。字体句柄是不透明指针，0 表示失败。

| 导出 | 参数 | 说明 |
|---|---|---|
| `wpefont_alloc(size) -> ptr` | 字节数 | `malloc`，失败返回 0 |
| `wpefont_free(ptr)` | | `free` |
| `wpefont_font_new(data, length, size26_6) -> font` | `data` 由 `wpefont_alloc` 分配，**所有权交给字体**；`size26_6` 为 `trunc(pointsize · 64)` | `FT_New_Memory_Face`（第 0 个 face）、`FT_Select_Charmap(UNICODE)`、`FT_Set_Char_Size(0, size26_6, 300, 300)`、`hb_ft_font_create`。失败返回 0，`data` 已释放 |
| `wpefont_font_free(font)` | | 释放 `hb_font_t`、`FT_Face` 与字体数据；`font` 为 0 时什么也不做 |
| `wpefont_font_has(font, codepoint) -> 0/1` | Unicode 码点 | `FT_Get_Char_Index != 0`（回退链逐码点查） |
| `wpefont_font_metrics(font, out)` | `out`：5 个 `int32` | 见下 |
| `wpefont_shape(font, text, length, out, cap) -> n` | `text`：`length` 个 UTF-32 码点；`out`：`6 · cap` 个 `int32` | `hb_buffer_add_utf32` + `hb_buffer_guess_segment_properties` + `hb_shape`（不带 features）。最多写 `cap` 个字形，返回实际字形数；返回值大于 `cap` 时放大缓冲重排 |
| `wpefont_glyph(font, gid, out) -> bitmap` | `out`：10 个 `int32` | `FT_Load_Glyph(gid, load_flags)`，再 `FT_Get_Glyph` → `FT_Glyph_Get_CBox(FT_GLYPH_BBOX_PIXELS)` → `FT_Done_Glyph`。返回字形槽里的位图缓冲（同一字体下次加载字形前有效；空字形可能为 0） |

**输出布局：**

- `wpefont_font_metrics`：`[ascender, descender, height, units_per_EM, load_flags]`。前三个是 `face->size->metrics`，
  **26.6**（FreeType 已取整到整像素）；`load_flags` 见 hinting 规则。
- `wpefont_shape`：每个字形 `[gid, cluster, x_advance, y_advance, x_offset, y_offset]`，后四个 **26.6**；`cluster` 是输入码点的
  下标。WPE 排版只用 `x_advance >> 6`。
- `wpefont_glyph`：`[width, rows, pitch, bitmap_left, bitmap_top, pixel_mode, xMin, yMin, xMax, yMax]`，全是**整数像素**。
  - `pixel_mode`：2 = 灰度（1 字节 / 像素），7 = BGRA（彩色字形，预乘 alpha，4 字节 / 像素）；字体内嵌点阵可能给
    1 = 单色（1 位 / 像素，高位在左）。`pitch` 是行跨度，为负时第一行在缓冲末尾。
  - `bitmap_left`：笔位置到位图左边；`bitmap_top`：基线到位图上边，向上为正。
  - `xMin … yMax`：本次加载的字形经 `FT_Get_Glyph` → `FT_Glyph_Get_CBox(glyph, FT_GLYPH_BBOX_PIXELS)` 的像素框，y 向上。
    因为加载时带了 `FT_LOAD_RENDER`，取到的是位图字形的框，等于 `(left, top − rows, left + width, top)`；1b 的对照在
    342 个字形上逐个核对过，单测也钉住了这个关系。
  - **这不是 WPE 定图集格子的框**：WPE 取框是另一次加载，标志 `8` = `FT_LOAD_NO_BITMAP`，取的是轮廓框
    （rea-p6b-raster「加载标志」表，`FUN_1401addb0`）。普通灰度字形两者相同（smooth 渲染器的位图框同样是轮廓框向外取整）；
    彩色字形（COLR 渲染的框和基础轮廓不同）、小字号下用到内嵌点阵的字体（`NO_BITMAP` 跳过点阵）、两次加载 hinting
    不同时会不同。1c 写装箱器时照 WPE 补一个取轮廓框的导出，带不带强制自动 hinting 按 WPE 图集定。
  - 失败（gid 越界、字形数据坏）时返回 0，`out` 除 `pixel_mode` 外全为 0，`pixel_mode` 为 −1。

## 规则

- **300 DPI**：`FT_Set_Char_Size(face, 0, trunc(pointsize · 64), 300, 300)`，字号取整在 JS 侧（`Math.trunc`）。
- **两条 hinting 规则**（2026-11-12 实测，离线参考 `FTRULE=fpgm FTCFF=native` 与 WPE 图集一致）：
  1. TrueType（有 `glyf` 表）**没有 `fpgm`** 时强制自动 hinting（`FT_LOAD_FORCE_AUTOHINT`）。FreeType 自己判「没有 hinting」
     时还要看 `prep`，所以要在胶水里按 `fpgm` 补，不能交给 FreeType；
  2. CFF（OpenType 的 `otf`）不强制，走原生 CFF 引擎。
- 加载标志是 `FT_LOAD_RENDER | FT_LOAD_COLOR`（加规则 1 的 `FT_LOAD_FORCE_AUTOHINT`）：COLR / sbix / CBDT 的彩色字形
  栅格化成 BGRA。

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
`has` / `metrics` / `shape` / `glyph` / `dispose`。位图拷出成按行紧排的 `Uint8Array`，不暴露 wasm 内存；wasm 内存会增长，
每次访问都重新取 `memory.buffer`。

`index.test.ts`：wasm 不存在就整组跳过；`KABEGAME_WPE_ROOT` 指向 WPE 安装目录时，用 WPE 自带字体跑基础用例与
`fixtures/baseline.json` 的逐项基线（由 `apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py` 从 1a 的结果生成）。
测试不读系统字体。

```bash
cd apps/wpe-scene
KABEGAME_WPE_ROOT=<steamapps>/common/wallpaper_engine node ../../node_modules/vitest/vitest.mjs run src/wpefont
```
