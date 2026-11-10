# P7 步骤 0 读码：WPE 在 Windows 上怎么把着色器方言翻成 HLSL 并编译

> 方法：只做静态分析，没有运行、附加或结束任何 WPE 进程，没有改 Steam 目录。`wallpaper64.exe` 拷到会话 scratchpad 后用 REA（Ghidra 12.1.4，从上一轮快照 `wallpaper64-2.8.42-sync.rea-snapshot` 打开）反编译，关键分支用 REA 汇编与 `llvm-objdump` 对照；字符串与表用自写的 PE 节映射脚本直接读文件。唯一读取的安装目录文件是 `assets/shaders/HLSL/dx11fallback.{vert,frag}`（只读）。镜像基址 `0x140000000`。
>
> 置信度标注：**静态确认** = 反编译 + 汇编 / 数据表直接看到；**推断** = 从代码结构或 HLSL / D3D11 语义推出，没有逐条验证；**未知** = 没查清。
>
> 产物（会话 scratchpad，不入库）：`C:\Users\Lenovo\AppData\Local\Temp\claude\97f1c4c5db8b5ee9\d0d089e9-f2cd-4b1d-b6e4-c249c4216f87\scratchpad\`，含本轮快照 `wallpaper64-2.8.42-p7shader.rea-snapshot`（167 条证据）、反编译文本 `decomp\*.c`、汇编 `decomp\*.asm`、脚本 `py\`。

## 0. 目标核对

- 文件：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`，拷贝到 scratchpad `bin\wallpaper64.exe` 后分析。
- 方法：`sha256sum` 同时算原文件与副本；REA `open_binary` 也报告了同一个摘要。
- 结果：两者都是 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，与之前的读码记录一致（同一个 2.8.42 构建）。

## 总览：一次着色器创建的完整流程

着色器对象构造函数 `FUN_1400d5070`（设备 +0x38 调进来；参数 `param_2` = 着色器名，如 `genericimage2`、`effects/xxx`；`param_3` = 材质的 COMBO 表）。顺序如下，全部 **静态确认**：

| 步 | 函数 | 做什么 |
|---|---|---|
| 1 | `FUN_140162ac0` | 拼路径 `shaders/<名>.vert` / `.frag` / `.geom`；拼「前缀」；读源码并展开 `#include`；前缀 + 源码；算缓存文件名并比较修改时间；缓存可用就返回 true |
| 2 | `FUN_14016b0e0`（在 1 里，缓存不可用时） | WPE 自己的预处理器：抹掉块注释、求值 `#if` 系列、处理 `#require`，处理过的指令行和失效分支抹成空格 |
| 3 | `FUN_1400f3d00` | 顶点、片元源码里第一处 `float mod(` 改名成 `float _deprFn_0(` |
| 4 | `FUN_1400f5cb0` | 源到源翻译：顶点（阶段 0）→ 几何（阶段 1，有源码时）→ 片元（阶段 2），三者共用一个 varying 列表 |
| 5 | `D3DCompile`（VS 在 `FUN_1400d5070` 里内联调用，GS / PS 经 `FUN_1400d44e0`） | 编译 |
| 6 | `FUN_1400d5070` | 失败的阶段换成 `shaders/HLSL/dx11fallback.{vert,frag}` 重编 |
| 7 | `D3DReflect` + `FUN_1400d4730` | 顶点着色器反射输入签名，删掉没用到的 `VS_INPUT` 成员后再编一次 |
| 8 | `ID3D11Device::Create*Shader`，写 `.dxs` 缓存 | 只有没用回退时才写缓存 |

---

## 1. 宏头全文

**结论（静态确认）**：三个阶段用**同一份**宏头，`FUN_1400f5cb0` 无条件拼进去，不分阶段。宏头之后紧跟一行 `texSample2DBackBuffer` 的定义，按 COMBO 表里有没有 `BACKBUFFER_MS` 二选一（三个阶段一样）。插入位置是**最终 HLSL 的第 0 个字节**，排在生成的结构体、纹理声明、cbuffer 之前；`#define HLSL 1` 等「前缀」不在宏头里，而在作者源码顶部（见第 2 节），所以在最终文本里排在 cbuffer 之后。

- 宏头字符串：`0x140487d10`（1132 字节，`FUN_1400f5cb0` 里把它拷进新分配的 0x470 字节缓冲，`0x1400f6b..` 附近）。
- 两行 `texSample2DBackBuffer`：`0x1404881b0` / `0x1404881f8`，`FUN_1400f5cb0` 在 `LAB_1400f6bfe` 处选择：COMBO 表里找到 `BACKBUFFER_MS` 用前者（`Load`），否则用后者。
- 宏头里**没有** `frac`、`mul`、`saturate`、`lerp`、`atan2`、`ddx/ddy`：这些是 HLSL 原生函数，直接透传。也没有 `fract`、`texture2D`、`dFdx` 之类 GLSL 名字。

逐字原文（`\n` 结尾，每行一个宏）：

```c
#define vec2 float2
#define vec3 float3
#define vec4 float4
#define uvec4 uint4
#define mat4 float4x4
#define mat4x3 float4x3
#define mat3 float3x3
#define mat2 float2x2
#define mix lerp
#define mod(x, y) ((x)-(y)*floor((x)/(y)))
#define CASTI(x) ((int)(x))
#define CASTU(x) ((uint)(x))
#define CASTF(x) ((float)(x))
#define CAST2(x) ((float2)(x))
#define CAST3(x) ((float3)(x))
#define CAST4U(x) ((uint4)(x))
#define CAST4(x) ((float4)(x))
#define CAST3X3(x) ((float3x3)(x))
#define DECLARE_SAMPLER2D_PARAMETER(t) Texture2D t, SamplerState t ## SamplerState
#define MAKE_SAMPLER2D_ARGUMENT(t) t, t ## SamplerState
#define DECLARE_SAMPLER2D_COMPARE_PARAMETER(t) Texture2D t, SamplerComparisonState t ## SamplerComparisonState
#define MAKE_SAMPLER2D_COMPARE_ARGUMENT(t) t, t ## SamplerComparisonState
#define texSample2D(s, u) s.Sample(s ## SamplerState, u)
#define texSample2DLod(s, u, m) s.SampleLevel(s  ## SamplerState, u, m)
#define texSample2DCompare(s, u, d) s.SampleCmpLevelZero(s ## SamplerComparisonState, u, d)
#define texLoad2D(s, u, r) s.Load(int3((u) * (r), 0))
#define texSample3D(s, u) s.Sample(s ## SamplerState, u)
```

紧跟其后的一行（二选一）：

```c
// COMBO 表里有 BACKBUFFER_MS
#define texSample2DBackBuffer(s, u, r) s.Load(int2((u) * (r)), 0)
// 否则
#define texSample2DBackBuffer(s, u, r) texSample2D(s, (u))
```

注意 `texSample2DLod` 原文里 `s` 和 `##` 之间是**两个空格**（不影响语义）。`mod` 是宏，所以作者自己写的 `float mod(...)` 函数定义会被宏展开打坏，这就是第 2 节 `_deprFn_0` 改名的原因。

---

## 2. 作者源码进 `D3DCompile` 之前的全部文本处理（按执行顺序）

### 2.1 读源码与 `#include`：WPE 自己展开（静态确认）

`FUN_140162100(set, 资源管理器, 路径, 输出, 依赖列表)`：

- 逐行扫描（行以 `\r` 或 `\n` 断开）。**行首**（第 0 列，前面不能有空格或制表符）是 `#include`（`strncmp("#include", 行, 8)`）才算；取第一对 `"` 之间的路径，拼成 `"shaders/" + 路径`，递归调用自己展开，结果整段替换这一行。
- **每个阶段 include-once**：每次处理一个阶段新建一个集合（`FUN_140162ac0` 里 `FUN_1400316b0`），同一路径第二次出现时这一行直接丢掉。
- 引号不全的 `#include` 行被**静默丢掉**（既不展开也不保留）。
- 缩进的 `#include` 不展开、原样留下；由于 `pInclude = NULL`（第 3 节），交给 `D3DCompile` 时必然报错（推断）。
- 输出时每行补一个 `\n`，**连续的换行符整体跳过**，即 CRLF 统一成 LF、空行全部删除。展开后的文件内容按路径缓存在资源管理器 +0x1410 的表里。
- 展开过的文件路径记进依赖列表，用于缓存的修改时间比较（2.9）。

### 2.2 前缀与 COMBO 的 `#define`：插在作者源码最前面（静态确认）

`FUN_140162ac0` 拼一个前缀字符串，再用 `FUN_140076fd0(前缀, 源码)`（拼接，前缀在前）分别加到顶点、片元（和几何）源码前面：

```c
#define HLSL 1
#define HLSL_SM40 1
#define GS_ENABLED 1        // 仅当 (*(mgr+8)+0x118) 的 bit3 为 1，含义未知
#define <COMBO名> <值>       // FUN_14016c400：COMBO 表里每一项都写，值为 0 也写，十进制无符号
...
#define <名字> 1            // FUN_14016c800：另一组按纹理槽 / 标志位产生的宏，只在 COMBO 表 [1] 非空时加；具体名字未追
```

- `HLSL_SM40` 在 SM5 设备上也一样定义。
- COMBO 宏的顺序是 COMBO 哈希表的遍历顺序（MSVC `unordered_map` 的内部链表），不是字母序（推断）。
- 预处理器另外**预置**了 `SHADERVERSION = 69`（`FUN_14016b0e0` 开头直接塞进它自己的宏表，字符串 `0x14048d068`），只用于 `#if` 求值，**不**写进文本，`D3DCompile` 看不到它。

### 2.3 WPE 自己的预处理器 `FUN_14016b0e0`（静态确认）

只有缓存不可用时才跑，对顶点、几何、片元各跑一次，**原地改写**源码：

- **块注释**：`/* … */`（可跨行）里的字符连同 `/*`、`*/` 全部改成空格。行注释 `//` 只是让扫描在该行停下，注释文字原样留下（`//` 后面的 `/*` 不算块注释开始）。
- **指令识别**：去掉行首空白后以 `#` 开头，再用正则 `^\s*#\s*([a-z]+)\b\s*(.*)`（`0x14048d048`）取指令名与参数；参数在 `//` 处截断（`0x14048ba14`），去掉尾部 ` \n\r\t`。
- **条件栈**：每层两个字节 `{active, taken}`。
  - `#ifdef X` / `#ifndef X`：当前活跃且条件成立压 `{1,1}`，否则压 `{0,0}`。
  - `#if expr`：同上，`expr` 由 `FUN_140167e10` 求值（递归下降，支持 `defined X` / `defined(X)`，`FUN_1401669a0` 查宏表）。
  - `#elif expr`：栈空则忽略；父层全活跃且本层 `taken==0` 且 `expr` 成立 → `{1,1}`，否则本层 `active=0`。
  - `#else`：栈空则忽略；父层全活跃且本层 `taken==0` → `active=1`，否则 `active=0`。
  - `#endif`：**栈非空才弹出**；栈空时什么也不做（`0x14016bf40`–`0x14016bf60`：`cmp [rsp+0x58], rcx; jz` 跳过 `sub rcx,2`，栈空直接跳到 `0x14016bdc3` 置「抹行」标志）。
  - 处理后「当前活跃」= 栈里所有层 `active` 的与。
- **`#define`**：活跃时登记进宏表（名字与值以空格 / 制表符分开，没有值记作 `1`），**这一行保留**在文本里，留给 `D3DCompile` 的预处理器做宏展开；失效分支里的 `#define` 不登记，并抹掉。
- **`#undef`**：从宏表删除。
- **`#require X`**：`FUN_140169140` 生成一段代码（`LightingV1` 的光照函数），插在这一行的位置，这一行本身抹掉。
- **抹行规则**（`0x14016bc5a`）：当前不活跃、或者这一行是已处理的指令（`ifdef/ifndef/if/elif/else/endif/require`）时，整行（从行首非空白处到行尾）`memset` 成空格。换行符不动，**行号保持不变**。
- 不认识的指令（如 `#pragma`、`#error`、`#line`）在活跃区域里原样留下，交给 `D3DCompile`。

**关键结论（静态确认）：顶点源码里多一个 `#endif` 时，WPE 的预处理器在栈空时忽略它并把这一行抹成空格，`D3DCompile` 根本看不到这个 `#endif`，所以 WPE 能编过。** 同理，没闭合的 `#if` 也不报错，只是后面的内容一直按失效分支被抹掉。`D3DCompile` 收到的文本里**没有任何条件编译指令**，只剩 `#define` 和不认识的指令。

### 2.4 `mod` 改名（静态确认）

`FUN_1400f3d00`：在**顶点和片元**源码（不含几何）里找**第一处** `float mod(`（10 字节精确匹配），替换成 `float _deprFn_0(`。只换第一处、只认这一种写法（`float  mod(`、`vec2 mod(` 不换）。调用处的 `mod(...)` 照样走宏头里的 `mod` 宏。

### 2.5 逐行分类：声明行被收走（静态确认）

`FUN_1400f5cb0` 用 `istringstream` 逐行读（`getline`），每行按**行首前缀**判断（`FUN_1400f8f90` = `memcmp(行, 前缀, 前缀长)`，**第 0 列、没有单词边界检查**），依次试：

| 行首 | 处理 |
|---|---|
| `attribute` | `FUN_1400f4460`：在整行里按**整词**找固定的 26 个属性名（表 `0x140484a90`，按表顺序第一个命中的算），类型和语义取自表 `0x140482fa0`，**作者写的类型被忽略**。没命中任何属性名 → 这一行丢掉 |
| `varying` | 解析声明，进 varying 列表（或系统值列表，见下） |
| `in` | 同 `varying`（注意：任何以 `in` 开头的行都算，例如顶格的 `int i = 0;`） |
| `out` | 同 `varying` |
| `uniform` | 解析声明，进 uniform 列表 |
| 其他 | 原样追加到正文，后补 `\n` |

声明行**不会**进入正文；解析失败的声明行也直接丢掉，并写日志 `HLSL var error: %s\n`（`%s` 是整行）。

**声明解析 `FUN_1400f4810`（静态确认）**：对 15 种 GLSL 类型名（表 `0x140482eb0`：`float vec2 vec3 vec4 mat3 mat4x3 mat4 sampler2D sampler2DBackBuffer sampler2DComparison sampler3D int ivec4 uint uvec4`）按顺序各建一个正则（`FUN_1400f4630`，格式串 `0x1404875a0`）：

```
(\w+)[\s]+<类型>[\s]+(\w+)(\[[\d\w]+\])?
```

对这一行做 `regex_search`（`FUN_1400dc300`，同一函数也用来在整篇 HLSL 里找 `\bVS_INPUT\b`，所以是 search 不是 match），第一个命中的类型胜出：

- 第 1 组 = 类型前面那个单词。它是 `in` 记方向 1，是 `out` 记方向 2，其他（`varying`、`uniform`、`lowp` 等）记 0。
- 第 2 组 = 名字；第 3 组 = 数组长度：去掉方括号后是数字就 `atoi`，否则把它当宏名去 COMBO 表里取值。
- 声明带 `[…]` 且类型是 `float / vec2 / int / uint` 时打「accessArray」标记（掩码 `0x2803`，`0x1400f4fcd`–`0x1400f4fe0`），只看类型，不看名字、方向、声明位置（补查一节）。
- 声明的初值、精度修饰、尾部内容全部丢弃。
- **表里没有的类型**：`mat2`、`ivec2/3`、`uvec2/3`、`bool`、`mat3x4` 等。这些类型的 uniform / varying 声明解析失败，行被丢掉并写 `HLSL var error`，正文里再用到这个名字就是未声明标识符（推断：编译失败）。宏头里有 `mat2`，所以 `mat2` 在函数体里能用，只是不能声明成 uniform / varying。

**`varying vec4 v_Size.xy;` 这种名字后带分量的写法（静态确认，正则语义推出）**：`vec4` 那条正则在行内搜到 `varying vec4 v_Size`（`\w+` 在 `.` 处停下，第 3 组可选、不匹配），于是记成一个名为 `v_Size`、类型 `float4` 的普通 varying，`.xy` 和分号一起被丢弃。不报错。

**系统值**：`varying` / `in` / `out` 声明的名字如果在一张全局表里（`FUN_1400f8df0` 查 `DAT_1404e7e98` 结束迭代器的哈希表），不进 varying 列表，而是作为 `main` 的额外参数 `,<类型> <名字>:<语义>`。表内容推断为 `gl_VertexID → SV_VERTEXID`、`gl_InstanceID → SV_INSTANCEID`（字符串在 `0x140487558`–`0x140487590` 成组出现，表的构造没追）。

### 2.6 varying：语义怎么分配（静态确认，最关键）

1. **顶点阶段**：varying 列表 = 顶点源码里的 varying 声明，**按声明出现的顺序**（`FUN_1400f8620` 是 `push_back`，不去重、不排序），之后 `FUN_1400f8860` 在**末尾**追加 `gl_Position`（类型 `float4`）。这份列表拷到三阶段共享的列表里（`FUN_1400f89a0(dst=共享, src=本地)`）。
2. **片元阶段**：本阶段解析出的 varying 声明**整体作废**，用共享列表（也就是顶点的列表）覆盖（`FUN_1400f89a0(dst=本地, src=共享)`）。片元里写的类型、顺序、有没有声明都不影响结构体。
3. **几何阶段**（有 `.geom` 且 `GS_ENABLED`）：共享列表的成员记为分组 1（GS 输入），几何源码里方向为 `out` 的 varying 记为分组 2（GS 输出），并把这些 `out` 换成新的共享列表给片元用。
4. 结构体生成 `FUN_1400f52e0(列表, 分组, 输出)`：只输出该分组的成员；顶点和片元都用分组 0，名字都是 `struct VS_OUTPUT`（片元的入口参数也是 `VS_OUTPUT IN`），几何的分组 2 名字是 `struct PS_INPUT`。每个成员一行：
   - 名字是 `gl_Position` → `SV_POSITION`；
   - 名字是 `gl_ViewportIndex` → `SV_ViewportArrayIndex`；
   - 其余 → `TEXCOORD<k>`，`k` 从 0 开始，**按列表顺序**递增，每个成员占用的寄存器数（数组可能大于 1）加到 `k` 上。

所以 **`TEXCOORD` 编号 = 顶点着色器里 varying 声明的出现顺序**（按名字无关，按片元无关）。另外注意：顶点源码里用 `out` 声明的 varying 方向是 2，**不会**进顶点的 `VS_OUTPUT`（分组 0 过滤掉了）；顶点必须用 `varying` 或不带方向的写法（推断：用 `out` 会让 `OUT.<名>` 未定义而编译失败）。

**例：顶点写 `vec4 v_TexCoord`、片元写 `vec2 v_TexCoord`**（推断的拼装结果，结构是静态确认的）：

```hlsl
// 顶点
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec3 v_Normal;
// 片元
varying vec2 v_TexCoord;
varying vec3 v_Normal;
```

两边生成的输出结构体**完全相同**：

```hlsl
struct VS_OUTPUT
{
float4 v_TexCoord : TEXCOORD0;
float3 v_Normal : TEXCOORD1;
float4 gl_Position : SV_POSITION;
};

```

片元里读到的 `IN.v_TexCoord` 是 `float4`；拿它当 `float2` 用（`texSample2D(g_Texture0, v_TexCoord)`、`vec2 uv = v_TexCoord;`）时，fxc 按 HLSL 规则做隐式截断，给警告 X3206，不是错误（推断，flags 里没有 `WARNINGS_ARE_ERRORS`，留给 p7 实测确认）。

**片元声明了、顶点没有的 varying**：不进结构体，也不进替换表，正文里还是裸名字 → 未声明标识符，片元编译失败，走回退（推断）。片元里还能读到 `IN.gl_Position`（`SV_POSITION`，像素坐标）。

### 2.7 attribute：`VS_INPUT`（静态确认）

`FUN_1400f5110`，按 attribute 声明出现顺序：

```hlsl
struct VS_INPUT
{
<类型> <名字> : <语义><序号>;
...
};

```

类型 / 语义 / 序号来自固定表（`0x140482fa0` + 语义名表 `0x140482e70`），与作者写的类型无关：

| 名字 | HLSL | 语义 | | 名字 | HLSL | 语义 |
|---|---|---|---|---|---|---|
| a_Position | float3 | POSITION0 | | a_TexCoordVec4 | float4 | TEXCOORD0 |
| a_PositionVec4 | float4 | POSITION0 | | a_TexCoordC1 / Vec3C1 / Vec4C1 | float2 / 3 / 4 | TEXCOORD1 |
| a_PositionC1 | float3 | POSITION1 | | a_TexCoordC2…C5（同上三种） | float2 / 3 / 4 | TEXCOORD2…5 |
| a_Normal | float3 | NORMAL0 | | a_Color | float4 | COLOR0 |
| a_Tangent4 | float4 | TANGENT0 | | a_BlendIndices | uint4 | BLENDINDICES0 |
| a_TexCoord | float2 | TEXCOORD0 | | a_BlendWeights | float4 | BLENDWEIGHT0 |
| a_TexCoordVec3 | float3 | TEXCOORD0 | | | | |

（表 `0x140482af0` 是对应的 D3D11 输入布局：DXGI 格式 6 = R32G32B32_FLOAT、2 = R32G32B32A32_FLOAT、0x10 = R32G32_FLOAT、3 = R32G32B32A32_UINT，与上表一致。）

编译成功后 `D3DReflect` 顶点输入签名，`FUN_1400d4730` 找出没用到的输入（`BLENDINDICES` 除外），在 `struct VS_INPUT` 块里删掉对应的行（按 `\b(<语义><序号>)\b` 匹配），再编一次；重编失败就保留原来的结果（推断：保证输入布局只含真正用到的属性）。

### 2.8 uniform：纹理声明与 cbuffer（静态确认）

uniform 列表按声明出现顺序（include 展开、预处理之后，只含活跃分支）。每个名字查内置 uniform 名表（`FUN_140002860` 初始化，名字 → ID 见 [p2-REPORT](../p2-REPORT.md) 第 308 行），按 ID 分流（`0x1400f6d8b`–`0x1400f709f`）：

| 条件 | 去处 |
|---|---|
| 不在名表里（**所有材质自定义 uniform**）、ID < 0、ID > 0x8b | `g_bufStatic`（b0） |
| ID 0x20–0x29（`g_Texture0`–`g_Texture9`） | 纹理 + 采样器，寄存器号 = ID − 0x20 |
| ID 0x8c | 单独一档（−1），用途未追 |
| 其余按跳转表（`0x1400f8494` / `0x1400f8480`）：多数 → 1；0x71 → 2；0x78–0x86 → 3；6、7、8（`g_TexelSizeHalf`、`g_TexelSize`、`g_Screen`）、0x5c、0x8b（`g_HDRParams`）→ 0 | 0 = `g_bufStatic`(b0)，1 = `g_bufDynamic`(b1)，2 = `g_bufAnimation`(b2)，3 = `g_bufLights`(b3) |

纹理声明（`local_508`），`<N>` = ID − 0x20：

```hlsl
// sampler2D、sampler2DBackBuffer（无 BACKBUFFER_MS）
Texture2D g_TextureN:register(tN);
SamplerState g_TextureNSamplerState:register(sN);
// sampler2DBackBuffer 且有 BACKBUFFER_MS
Texture2DMS<float4> g_TextureN:register(tN);
// sampler3D
Texture3D g_TextureN:register(tN);
SamplerState g_TextureNSamplerState:register(sN);
// sampler2DComparison
Texture2D g_TextureN:register(tN);
SamplerComparisonState g_TextureNSamplerComparisonState:register(sN);
```

采样器名字不是 `g_Texture0..9` 时不会走纹理分支，而是当普通常量塞进 `g_bufStatic`，写成 `const sampler <名字>;`（推断：编译失败）。

cbuffer（`0x1400f7086` 之后拼接）：

```hlsl
cbuffer g_bufStatic:register(b0)
{
const <类型> <名字>;
const <类型> <名字>[<n>];
}
cbuffer g_bufDynamic:register(b1)
{
...
}
cbuffer g_bufAnimation:register(b2)
{
const float4x3 g_Bones[<BONECOUNT 的值>];
}
cbuffer g_bufLights:register(b3)
{
const float4 g_LPoint_Color[<LIGHTS_POINT>];
const float4 g_LPoint_Origin[<LIGHTS_POINT>];
// ……g_LSpot_*、g_LTube_*、g_LDirectional_*、g_LFeature_Shadow*，各按对应 LIGHTS_* 宏的值决定有无与长度
}
```

- 一个 cbuffer 里没有成员就不输出。动画、灯光两个 cbuffer 的内容是固定模板，与作者声明的名字无关。
- **打包顺序**：成员按 uniform 声明的出现顺序；**对齐**用 fxc 默认的 cbuffer 打包规则（不写 `packoffset`、没有 `PACK_MATRIX_*` 标志 → 矩阵按 column_major 打包）。CPU 端偏移从 `D3DReflect` 读（`FUN_1400dc080` / `FUN_1400dab40` 处理反射结果），推断 WPE 不自己算偏移。
- **accessArray 数组**（`float / vec2 / int / uint` 数组，材质 uniform 与引擎 uniform 一视同仁）：cbuffer 里声明成打包类型（表 `0x140482e30`：float 系 → `float4`，int → `int4`，uint → `uint4`），长度 `ceil(n/4)`；`main` 开头生成一行拆包：`float accessArray<名>[n] = (float[n])<名>;`。**只有 `main` 签名之后的文本**里的 `<名>` 被替换成 `accessArray<名>`；`main` 之前（全局辅助函数、`main` 之前的 `#define`）用到的 `<名>` 保持原名，指向 cbuffer 里的 `float4[ceil(n/4)]`。详见文末「accessArray 的适用条件（补查）」。
- 同名 uniform 声明两次会被收两次（不去重），推断 fxc 报重定义。

### 2.9 `main` 的处理（静态确认）

1. 先用一个字符串流拼签名：

   ```hlsl
   // 顶点
   VS_OUTPUT main(VS_INPUT IN<额外参数>)
   {
   	VS_OUTPUT OUT;
   <varying 数组置零：float accessArrayX[n] = (float[n])0;>
   <uniform 数组拆包>
   // 片元
   PS_OUTPUT main(VS_OUTPUT IN<额外参数>)
   {
   	PS_OUTPUT OUT;
   <IN 里的数组拆包：float accessArrayX[n] = (float[n])IN.X;>
   <uniform 数组拆包>
   // 几何：正文里有 "[input:triangles]" 就删掉它并用前者，否则用后者
   void main(triangle VS_OUTPUT IN[3], inout TriangleStream<PS_INPUT> OUT<额外参数>)
   {
   	
   void main(point VS_OUTPUT IN[1], inout TriangleStream<PS_INPUT> OUT<额外参数>)
   {
   	
   ```

2. 用正则 `\bvoid[\s]+main[\s]*\([\s]*\)[\s\r\n]*\{`（`0x140487cd0`，`std::regex_replace`，替换**所有**匹配）把作者的 `void main() {` 换成上面的签名。只认空括号：`void main(void)` 不会被换（推断：编译失败）。
3. 找到签名结束的位置，把正文切成两半：**签名之前**（全局声明、`main` 之前定义的辅助函数、签名本身）和**签名之后**（`main` 函数体及其后的所有内容）。
4. **标识符替换只作用于后一半**：按标识符字符 `[A-Za-z0-9_]` 切词，整词查替换表：
   - 顶点：attribute 名 → `IN.<名>`；varying 名 → `OUT.<名>`（accessArray 数组 → `accessArray<名>`）；
   - 片元：varying 名 → `IN.<名>`；`gl_FragColor` → `OUT.gl_FragColor`；
   - accessArray uniform → `accessArray<名>`（只在这一半里；`main` 之前的用法是原名 + `float4` 打包形态，见补查一节）；
   - 几何不替换 varying。
   - 不看前面是不是 `.`，所以 `foo.v_TexCoord` 里的 `v_TexCoord` 也会被换（推断，少见）。
   - 后果：**`main` 之前定义的辅助函数里直接读 varying / attribute 的名字不会被替换**，是未声明标识符（推断：编译失败）；`main` 之后的函数里会被换成 `IN.x` / `OUT.x`，而那里没有 `IN` / `OUT`（同样失败）。
5. 前一半里，**每一行首个记号是 `const`**（`const` 后面不是字母数字下划线）的行前插 `static `（`FUN_1400f3ea0`，不看花括号深度，函数内部的 `const` 也加）。不带 `const` 的全局变量不处理，在 HLSL 里会变成隐式 uniform（进 `$Globals`，初值无效），WPE 是否绑定 `$Globals` 未知。
6. 顶点 / 片元：用 `rfind('}')`（`0x1400f69d6` 处 `mov r9b, 0x7d`）找**整段文本的最后一个 `}`**，在它前面插入「数组回写」（顶点：`OUT.X = accessArrayX;`）和 `\treturn OUT;\n`。所以 `return OUT;` 只在最后一个 `}` 之前出现一次：作者 `main` 里提前的 `return;` 在 `VS_OUTPUT main` 里是语法错误（推断），`main` 之后还有函数时 `return OUT;` 会插错位置（推断）。
7. 片元的 `PS_OUTPUT`：正文里出现过 `gl_FragColor`（`FUN_1400f8fd0`，整段 `rfind`）就生成带 `float4 gl_FragColor : SV_TARGET;` 的结构，否则生成空结构 `struct PS_OUTPUT {};`。

写入 varying：片元里 `IN.x = …` 合法，`IN` 是按值传入的参数（HLSL 语义，推断）；顶点里先读后写 `OUT.x` 会得到「可能未初始化」警告（推断）。

### 2.10 最终交给 `D3DCompile` 的文本布局（静态确认）

`FUN_1400f9070(正文, 0, 头部)` 把头部插在最前面，整体顺序：

```hlsl
<宏头 1132 字节>
<texSample2DBackBuffer 一行>
struct VS_INPUT {...};            // 仅顶点
struct PS_OUTPUT {...};           // 仅片元
struct VS_OUTPUT {...};           // 顶点、片元；几何是 VS_OUTPUT + PS_INPUT
<Texture2D / SamplerState 声明>
cbuffer g_bufStatic ... / g_bufDynamic ... / g_bufAnimation ... / g_bufLights ...
#define HLSL 1                     // ←以下是作者源码（含前缀）
#define HLSL_SM40 1
#define <COMBO> <值>
...（作者全局代码，声明行已删、指令行和失效分支已是空格、const 已加 static）
<main 签名 + 函数体（标识符已替换）>
	return OUT;
}
```

`D3DCompile` 报错时的行号是相对这段完整文本的，前面隔着生成的头部，与作者文件行号不同。

### 2.11 缓存命中时

缓存可用时 2.3 之后的步骤都不做，直接读 `.dxs` 里的字节码（第 5 节）。

---

## 3. `D3DCompile` 的参数（静态确认）

两处调用（`FUN_1400d5070` 内联的顶点编译、`FUN_1400d44e0`），参数一样：

```c
D3DCompile(
    src, srcLen,
    pSourceName = "shaders/<名>.vert" / ".frag" / ".geom"   // 回退时为 "shaders/HLSL/dx11fallback.vert|frag"
    pDefines    = NULL,
    pInclude    = NULL,                // 没有 include 回调
    pEntrypoint = "main",              // 0x140477bb8
    pTarget     = 见下,
    Flags1      = 0x8800,
    Flags2      = 0,
    &blob, &errors);
```

- `Flags1 = 0x8800` = `D3DCOMPILE_OPTIMIZATION_LEVEL3`（0x8000）| `D3DCOMPILE_ENABLE_STRICTNESS`（0x800）。**没有** `ENABLE_BACKWARDS_COMPATIBILITY`（0x1000）、`WARNINGS_ARE_ERRORS`（0x40000）、`PACK_MATRIX_ROW_MAJOR / COLUMN_MAJOR`（8 / 16，所以用默认 column_major）、`DEBUG`、`SKIP_OPTIMIZATION`、`IEEE_STRICTNESS`、`PARTIAL_PRECISION`。`ENABLE_STRICTNESS` 会拒绝旧语法，具体拒哪些写法留给 p7 实测。
- `d3dcompiler_47.dll` 懒加载（`DAT_1404e52c8`，锁 `DAT_1404df730`），同时取 `D3DCompile`（`DAT_1404e52d0`）和 `D3DReflect`（`DAT_1404e52c0`）。找不到时 `FUN_1400986c0("DirectX compiler cannot be found, d3dcompiler_47.dll is missing.\n")`，这个函数最后调 `FatalAppExitA`，即直接退出程序。
- **目标串**（`FUN_1400d44e0`；`param_2` 0 = VS、1 = GS、2 = PS）按设备 +0x48 的标志位选：

  | 设备 +0x48 | VS | GS | PS |
  |---|---|---|---|
  | bit1（值 2）置位 | `vs_5_0` | `gs_5_0` | `ps_5_0` |
  | 只有 bit0（值 1） | `vs_4_0` | `gs_4_1` | `ps_4_1` |
  | 都没有 | `vs_4_0` | `gs_4_0` | `ps_4_0` |

  标志位在建设备时写（`0x14012ad59` 调 `D3D11CreateDevice`，`0x14012ad7a`–`0x14012ada4`）：特性级别 11_0 / 11_1 → 3（bit0|bit1），10_1 → 1，其他 → 0。**所以以前记录的「回退 `4_1`」不是编译失败后的重试，而是由显卡特性级别决定的**；编译失败不会换目标重编。

---

## 4. 编译失败的处理（静态确认，除注明外）

`FUN_1400d5070`：

1. 顶点、几何、片元依次编译，每个失败都写一条日志：

   ```
   %s shader %s error:\n%s\n
   ```

   三个 `%s` 依次是目标串、`pSourceName`、`D3DCompile` 的错误文本，例如（推断的样子）：

   ```
   ps_5_0 shader shaders/effects/xxx.frag error:
   shaders/effects/xxx.frag(123,9-20): error X3004: undeclared identifier 'v_Foo'
   ```

   声明解析失败时另有 `HLSL var error: %s\n`（第 2.5 节）。日志函数 `FUN_140098760` 只在 `DAT_1404e52b8 > 0` 时工作，经 `FUN_140098350` 写文件（推断是 `log.txt`）并分发给监听者；默认是否开启未确认，本机当前 `log.txt` 里没有这类行。
2. **顶点失败**：读 `shaders/HLSL/dx11fallback.vert`（`FUN_1400d3f80`，从资源管理器读文件，**不经过翻译**，原文就是 HLSL），以这个文件名为 `pSourceName` 重新编译，用它替换。
3. **片元失败**：同样换成 `shaders/HLSL/dx11fallback.frag`。
4. 两个回退**各自独立**：顶点失败、片元成功时，是「回退顶点 + 原片元」；反之亦然。
5. **几何失败**：几何着色器直接没有（指针为空），不回退。
6. 用了任何回退或几何失败 → 不写 `.dxs` 缓存（`bVar6` / `bVar5`），下次打开会重新编译并再次失败。
7. 之后照常 `Create*Shader`、反射、建常量表，**没有向上层返回失败标志**；没有看到「跳过这个 pass」「整个图层不画」「整张壁纸回退」的逻辑（这一层确认；上层材质代码没有逐个检查，推断上层也不知道发生过回退）。回退本身也编不过时，着色器指针为空，`Create*Shader` 不调用（边界情况，没再追）。

回退着色器原文（`assets/shaders/HLSL/dx11fallback.*`，只读）：

```hlsl
// dx11fallback.vert
struct VS_INPUT
{
	float3 a_Position : POSITION;
};

struct VS_OUTPUT
{
	float4 gl_Position : SV_POSITION;
};

cbuffer g_bufDynamic:register(b1)
{
	const float4x4 g_ModelViewProjectionMatrix;
}

VS_OUTPUT main(VS_INPUT IN)
{
	VS_OUTPUT OUT;

	OUT.gl_Position = mul(float4(IN.a_Position, 1.0), g_ModelViewProjectionMatrix);

	return OUT;
}
```

```hlsl
// dx11fallback.frag
struct PS_OUTPUT
{
	float4 gl_FragColor : SV_TARGET;
};

struct VS_OUTPUT
{
	float4 gl_Position : SV_POSITION;
};

PS_OUTPUT main(VS_OUTPUT IN)
{
	PS_OUTPUT OUT;
	OUT.gl_FragColor = float4(0.5, 0, 0, 1);
	return OUT;
}
```

**画什么**：片元回退输出**不透明暗红 `(0.5, 0, 0, 1)`**，混合方式仍按材质设置；顶点回退只用 `a_Position` 乘 MVP，画出几何的原位置。片元回退时原顶点输出的 TEXCOORD 都不再被读，签名上 `SV_POSITION` 的位置对不上（原顶点里它在最后），D3D11 只在调试层报不兼容，实际一般照画（推断）。所以「WPE 也编不过」的 pass 在 WPE 里应该显示为暗红色块，而不是静默不画，这一点需要在 p7 实测里抓帧确认。

---

## 5. 缓存 `.dxs`（静态确认）

- **文件名**：`shaders/blobsSM40/<sha1 十六进制>.dxs`（`FUN_140162ac0`：`"shaders/"` + `"blobsSM40/"` + 哈希 + `".dxs"`）。
- **写到哪里**：资源管理器（`ctx+0x1898`）虚表 +0x38 写文件，挂载点参数是字符串 `"PROJECT"` → 写进**当前壁纸的工程目录**下的 `shaders/blobsSM40/`（与之前在工坊目录、测试工程里看到 `blobsSM40` 一致）。读的时候走资源管理器的普通查找（虚表 +8）。
- **sha1 对什么算**（`FUN_14016c990`，SHA-1 初值 `67452301 efcdab89 98badcfe 10325476 c3d2e1f0`）：
  1. 着色器名字符串（`FUN_1400d5070` 的 `param_2`，不含 `shaders/` 和扩展名）；
  2. 4 字节整数，来自 `ctx+0x1518` 对象虚表 +0x30 的返回值（含义未知，推断是渲染后端 / 特性级别相关的版本号）；
  3. COMBO 表里**值不为 0** 的每一项：名字字节 + 4 字节值（顺序由 `FUN_14016e270` 决定，是否排序未追）；
  4. COMBO 表 [1] 非空时，再加 2.2 里那组 `#define <名字> 1` 的文本。

  **不包含**最终 HLSL、作者源码、编译 flags、目标串。
- **有效性**：缓存文件存在、前 8 字节是 `SHDV0069`、且它的修改时间 ≥ 顶点 / 片元 / 几何源码和所有被 include 文件中最新的修改时间（资源管理器虚表 +0x30 取修改时间）。否则重新编译。改源码靠修改时间失效，改 COMBO 值靠文件名失效。
- **何时写**：没有用回退、几何（有的话）编译成功、VS 与 PS 字节码都非空时才写。
- **文件格式**（`FUN_1400d5070` 写、else 分支读）：`"SHDV0069\0"`，然后依次是 `u32 长度 + VS 字节码`、`u32 长度 + GS 字节码（没有为 0）`、`u32 长度 + PS 字节码`、三组 `u32 2 + u16`（三个阶段的常量计数）、`u32 2n + u16[n]`（常量表）、`u32 12 + 12 字节`、`u32 11 + 11 字节`、`u32 条目数` + 每条 `名字\0 u32 u32 名字\0 名字\0 u32 u32`、最后 `u32 标志 + u32 一个字节`。

---

## 函数与地址索引

| 地址 | 作用 |
|---|---|
| `FUN_1400d5070` | 着色器对象构造：翻译、编译、回退、反射、写缓存 / 读缓存 |
| `FUN_1400d44e0` | GS / PS 编译包装（选目标串、调 `D3DCompile`、写错误日志） |
| `FUN_140162ac0` | 拼路径和前缀、读源码、算缓存名、比修改时间、调预处理器 |
| `FUN_140162100` | `#include` 展开（include-once、删空行） |
| `FUN_14016b0e0` | WPE 预处理器（注释、`#if` 系列、`#define`、`#require`、`#undef`） |
| `FUN_140167e10` | `#if` 表达式求值 |
| `FUN_14016c400` / `FUN_14016c800` | COMBO 宏 / 附加宏文本 |
| `FUN_14016c990` | 缓存名 SHA-1 |
| `FUN_1400f3d00` | `float mod(` → `float _deprFn_0(` |
| `FUN_1400f5cb0` | 源到源翻译主体 |
| `FUN_1400f4630` / `FUN_1400f4810` | 声明正则表 / 声明解析 |
| `FUN_1400f4460` | attribute 名匹配 |
| `FUN_1400f5110` / `FUN_1400f52e0` / `FUN_1400f5640` | `VS_INPUT` / `VS_OUTPUT`·`PS_INPUT` / `PS_OUTPUT` 生成 |
| `FUN_1400f5940` / `FUN_1400f5680` / `FUN_1400f5b90` | accessArray 置零 / 拆包 / 回写 |
| `FUN_1400f3ea0` | `const` → `static const` |
| `FUN_1400d4730` | 按反射删除未用的 `VS_INPUT` 成员 |
| `FUN_140098760` / `FUN_1400986c0` | 日志 / 致命错误退出 |
| `0x14012ad59` | `D3D11CreateDevice`，之后写设备 +0x48 能力位 |
| 数据 `0x140487d10` | 宏头 |
| 数据 `0x140482eb0` | GLSL ↔ HLSL 类型表（15 项） |
| 数据 `0x140484a90` / `0x140482fa0` / `0x140482e70` | attribute 名 / 类型语义 / 语义名 |

---

## 仍未知

1. **COMBO 宏与哈希的顺序**：`FUN_14016c400` 遍历哈希表的实际顺序、`FUN_14016e270` 是否排序。不影响编译结果，只影响缓存文件名。
2. **`FUN_14016c800` 那组 `#define <名字> 1`** 具体来自哪些标志（推断与纹理格式 / `formatcombo` 有关），以及 `FUN_140164690`、`FUN_140164850` 对 COMBO 表做了什么。
3. **`GS_ENABLED` 的开关**：`(*(mgr+8)+0x118)` 的 bit3 由什么设置。
4. **SHA-1 里那个 4 字节整数**（`ctx+0x1518` 虚表 +0x30）的含义。
5. **`#if` 里的未定义标识符**：分词器 `FUN_140166a90` 是否先做宏替换、未定义名字是否按 0 处理（推断与 C 一致），没逐条确认；`#if` 里能用的运算符全集没列。
6. **`#require` 生成的文本**（`FUN_140169140`）没有逐字取出，P4 / P3 的光照读码已有相关结论。
7. **系统值表**（`DAT_1404e7e98`）的完整内容，推断只有 `gl_VertexID`、`gl_InstanceID`。
8. **ID 0x8c** 是哪个 uniform、为什么单独一档；跳转表逐项对应的名字只核对了边界几项。
9. **上层对回退的反应**：材质 / 图层代码是否另外检查着色器是否用了回退（本层没有失败标志，推断没有）；回退的暗红实际是否画出来需要抓帧确认。
10. **日志开关** `DAT_1404e52b8` 的默认值，即 `%s shader %s error` 默认是否写进 `log.txt`。
11. **不带 `static` 的全局变量**进 `$Globals` 后 WPE 是否绑定；**`ENABLE_STRICTNESS`** 具体拒绝哪些写法；隐式截断、`float` 条件、标量取下标等 fxc 语义 —— 这些留给 p7 实测（本机 fxc 编译 + 反汇编）。
12. **非 accessArray 的 `vec4` 等数组 varying** 的寄存器数公式看起来按分量数算（`vec4 v[2]` 会写成 `[1]`），没核实是不是 WPE 的 bug。

---

## accessArray 的适用条件（补查）

起因：工坊 effect `workshop/3605510527/effects/video` 的片元声明 `uniform float g_AudioSpectrum64Left[64];`，写了 `g_AudioSpectrum64Left[barID / 4][barID % 4]`。按旧文字它应被换成 `float accessArrayg_AudioSpectrum64Left[64]` 再二次下标（fxc 报 X3121），但 WPE 抓帧（场景 3815289650）里它编译成功：`g_bufDynamic` 里是 `float4[16]`，代码是 `dp4 r0.w, cb1[r1.w + 0].xyzw, icb[r0.w + 0].xyzw`，即直接按 float4 元素加分量下标读 cbuffer。

**结论：没有冲突。打标与替换规则不区分引擎 / 材质 uniform；这个着色器的下标写在 `main` 之前的辅助函数里，而标识符替换只作用于 `main` 签名之后。** 下面分条给证据。

### 1. 打标条件：只看类型（静态确认）

`FUN_1400f4810`（声明解析，uniform 和 varying 共用），汇编 `0x1400f4fcd`–`0x1400f4fe0`：

```asm
1400f4fcd: movl   (%r12), %eax        ; 类型下标（0x140482eb0 表）
1400f4fd1: cmpl   $0xd, %eax
1400f4fd4: ja     0x1400f4fe6
1400f4fd6: movl   $0x2803, %ecx       ; bit 0 float, 1 vec2, 11 int, 13 uint
1400f4fdb: btl    %eax, %ecx
1400f4fde: jae    0x1400f4fe6
1400f4fe0: movb   $0x1, 0x2c(%r12)    ; accessArray 标志
```

这段只在正则第 3 组（`[…]`）存在时才执行（紧接在数组长度写入 `0x28(%r12)` 之后）。**不查名字、不查内置 uniform 表、不看声明位置和方向。** 名字查内置表是在之后的 `FUN_1400f5cb0` 里，只用来决定进哪个 cbuffer。

### 2. 三个使用点都只看「长度 > 0 且标志」，同样不区分引擎 uniform（静态确认）

| 位置 | 判断 | 效果 |
|---|---|---|
| cbuffer 声明 `0x1400f7162`–`0x1400f7183`、`0x1400f71f9`–`0x1400f7218` | `[+0x28] > 0 && [+0x2c] != 0` | 类型换成打包类型（`0x140482e30`），长度 `ceil(n/4)` → `const float4 g_AudioSpectrum64Left[16];`。这条在 `g_bufStatic` 和 `g_bufDynamic` 两个分类共用的路径 `0x1400f7150` 上 |
| 替换表 `0x1400f65c0`–`0x1400f65f7`（遍历 uniform 列表） | 同上 | `map[<名>] = "accessArray" + <名>`（`0x140487cb8` = `accessArray`） |
| `main` 开头拆包 `FUN_1400f5680(uniform 列表, "", …)`（VS 和 PS 都调） | 同上 | `float accessArray<名>[m] = (float[m])<名>;`，`m = ceil(n/4)*4`（float）/ `ceil(2n/4)*4/2`（vec2） |

所以 `g_AudioSpectrum16/32/64Left/Right` 这类引擎 uniform 与材质 uniform 走完全相同的路径：

```hlsl
cbuffer g_bufDynamic:register(b1)
{
...
const float4 g_AudioSpectrum64Left[16];
const float4 g_AudioSpectrum64Right[16];
}
...
PS_OUTPUT main(VS_OUTPUT IN)
{
	PS_OUTPUT OUT;
float accessArrayg_AudioSpectrum64Left[64] = (float[64])g_AudioSpectrum64Left;
float accessArrayg_AudioSpectrum64Right[64] = (float[64])g_AudioSpectrum64Right;
...
```

### 3. 替换只在 `main` 签名之后，`video.frag` 的下标恰好在之前（源码 + 静态确认）

`FUN_1400f5cb0` 把正文按签名结束处切成两半，只对后一半做整词替换（第 2.9 节第 3、4 步）。`ignore/p7/src/workshop__3605510527__effects__video.frag` 里：

```glsl
uniform float g_AudioSpectrum64Left[64];
...
float volumNum(float barID)          // 定义在 main 之前
{
    return clamp(0. , 1., g_AudioSpectrum64Left[barID / 4][barID % 4]);
}
...
void main() { ... drawSence(uv) ... }   // main 里没有直接用这个名字
```

`volumNum` 在前一半，名字保持原样，看到的是 `float4[16]`：`[barID / 4]` 取 float4，`[barID % 4]` 取分量（`float` 下标被 fxc 截断成整数），正好编成抓帧里的 `cb1[r1.w]` 与 `icb` 独热向量的 `dp4`。`main` 开头那行拆包没人用，被优化掉。这也说明 `(float[64])float4[16]` 这种数组转换 fxc 是接受的（若不接受，这个着色器在 WPE 里就编不过；实测佐证）。

### 4. 哪些情况会以「原名 + `float4[ceil(n/4)]`」访问

规则（静态确认，结果为推断）：凡是 `float / vec2 / int / uint` 数组 uniform（引擎和材质都算），cbuffer 里一律是打包形态；正文里的名字是哪种形态取决于**文本位置**：

1. `main` 签名之后的文本（`main` 体、`main` 之后的函数、以及这一段里的 `#define` 行）：整词换成 `accessArray<名>`，是 `float[n]`（标量下标）。
   - 例：内置 `assets/effects/pulse/shaders/effects/pulse.vert` 在 `main` 里调 `CreateAudioResponse(g_AudioSpectrum16Left, …)`，参数被换成 `accessArrayg_AudioSpectrum16Left`，与形参 `float bufferLeft[16]` 匹配。
   - 例：`assets/zcompat/scene/shaders/2084198056/Simple_Audio_Bars.frag` 的 `#define u_AudioSpectrumLeft g_AudioSpectrum16Left` 写在 `main` **内部**，替换是纯文本、`#define` 行也被换，所以 `u_AudioSpectrumLeft[int(i)]` 最终是 `float[16]` 的标量下标。
   - `main` 之后定义的函数里名字也被换，但 `accessArray<名>` 是 `main` 的局部变量，那里看不到 → 未声明标识符（推断）。
2. `main` 签名之前的文本（全局辅助函数、文件顶部的 `#define`）：保持原名，是 `float4[ceil(n/4)]`。
   - `video.frag` 的 `[i / 4][i % 4]` 写法正是依赖这一点。
   - 如果作者在 `main` 之前的函数里写标量下标 `g_X[i]`，得到的是第 `i` 个 **float4**（越界读 0），赋给 `float` 时隐式截断取 `.x`。不报错，但取值与作者意图不同（推断）。
   - 如果在 `main` 之前写 `#define SPEC g_AudioSpectrum16Left`、再在 `main` 里写 `SPEC[i]`：`SPEC` 不在替换表里，fxc 展开后同样是原名 + `float4` 形态（推断）。
3. 不受影响的数组：`vec3 / vec4 / mat*` 数组不打标，cbuffer 里原样 `const float4 g_X[n];`，正文不替换。

内置着色器里其他带标的数组 uniform（`assets/shaders` 全文 grep）：`g_MorphWeights[12]`（float）、`g_MorphOffsets[12]`（uint）、`g_BonesAlpha[BONECOUNT]`（float），都只在 `main` 里按标量下标使用（如 `clippingmaskimage4.vert`），走第 1 种形态。

对翻译器的含义：要复刻 WPE，需要按「是否在 `main` 签名之后」区分同一个数组的两种视图。`wpesl2wgsl/README.md` 目前把 `float g_AudioSpectrum16Left[16]` 写成 `array<vec4<f32>, 16>`（每元素一个 vec4），和 WPE 的 `float4[4]` 打包不同；`main` 之前的 `[i/4][i%4]` 写法要按 WPE 的打包语义（第 `i` 个标量 = 第 `i/4` 个 float4 的第 `i%4` 个分量）。

### 仍未知（本节）

- `vec2` 数组：声明长度用 `ceil(n/4)`、拆包按 `2n` 个标量算，`n` 较大时 `(float2[m])` 转换两边元素数对不上，是否让 fxc 报错没验证；本机语料里没看到 `vec2` 数组 uniform。
- `float` 下标（`barID / 4`）在 fxc 里是截断还是就近取整，归入 p7 实测的「`float` → `int`」一项。
