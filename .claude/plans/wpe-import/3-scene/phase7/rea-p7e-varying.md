# P7e 调研 — WPE varying 数组的 HLSL 翻译（读码 + 实测）

> 上级：[P7e 子计划](phase-7e-varyings.md)。关掉 [rea-p7-shader](rea-p7-shader.md)「仍未知」第 12 条。读码由子代理做（2026-11-14），实测与上限统计见文末两节。

对象：`D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（SHA-256 `40e2ce02…`，与 rea-p7-shader.md 同一副本，2.8.42）。只读，没有运行 WPE。

方法说明：REA 用 P7d 快照打开后，Ghidra 两次都在 330 s 启动期限内没分析完（`provider_timeout`），所以本次的指令级证据来自对同一文件的 `llvm-objdump` 反汇编（P7b 的交叉核对也用这种方式），常量串与类型表用只读脚本按虚拟地址从 PE 里读。REA 会话已关闭。

产物（`ignore/varying/rea/`）：

| 文件 | 内容 |
|---|---|
| `f52e0.s` | `FUN_1400f52e0`（`VS_OUTPUT` / `PS_INPUT` 生成）与 `FUN_1400f5640` 的反汇编 |
| `f5680_5cb0.s` | `FUN_1400f5680`（拆包）、`FUN_1400f5940`（置零）、`FUN_1400f5b90`（回写） |
| `f5cb0.s` | `FUN_1400f5cb0`（翻译主体，到 `0x1400f8000`） |
| `f4810.s` | `FUN_1400f4810`（声明解析） |
| `peread.py` | 按虚拟地址读串 / 指针表（`python -X utf8 -I peread.py <exe> <va>:s …`） |
| `emulate.py` | 按反汇编复刻上面四个函数的算术，打印本文的表 |

记号：声明元素 0x38 字节，`+0x00` 类型下标 `t`（表 `0x140482eb0`：0 float、1 vec2、2 vec3、3 vec4、4 mat3、5 mat4x3、6 mat4、7–10 采样器、11 int、12 ivec4、13 uint、14 uvec4），`+0x08` 名字（std::string），`+0x28` 数组长度 `n`（没有 `[…]` 为 0），`+0x2c` accessArray 标志（`t ∈ {float, vec2, int, uint}` 且带 `[…]`），`+0x30` 分组 / 方向（0 = `varying`，1 = `in`，2 = `out`）。

---

## 结论

### 1. 结构体成员与 `TEXCOORD` 推进（静态确认）

`FUN_1400f52e0` 对每个成员只有一条公式，accessArray 与否只影响类型名：

```
类型名 = (n > 0 && accessArray) ? "float4" : HLSL[t]          // 不查 0x140482e30
若 n > 0 且 n·(t+1) > 4：  c = ceil(n / (t == 1 ? 2 : 4))，写 "[c]"，k += c
否则：                     不写 []，k += 1
gl_Position / gl_ViewportIndex：写 SV_POSITION / SV_ViewportArrayIndex，k 不变
```

`t+1` 被当成「分量数」，只对 float / vec2 / vec3 / vec4 碰巧对；除数只区分 vec2（2）和其他（4）。

| GLSL | accessArray | n = 1 | n = 2 | n = 4 | n = 5 | n = 13 | n = 32 |
|---|---|---|---|---|---|---|---|
| float | 是 | `float4 X` +1 | `float4 X` +1 | `float4 X` +1 | `float4 X[2]` +2 | `float4 X[4]` +4 | `float4 X[8]` +8 |
| vec2 | 是 | `float4 X` +1 | `float4 X` +1 | `float4 X[2]` +2 | `float4 X[3]` +3 | `float4 X[7]` +7 | `float4 X[16]` +16 |
| vec3 | 否 | `float3 X` +1 | `float3 X[1]` +1 | `float3 X[1]` +1 | `float3 X[2]` +2 | `float3 X[4]` +4 | `float3 X[8]` +8 |
| vec4 | 否 | `float4 X` +1 | `float4 X[1]` +1 | `float4 X[1]` +1 | `float4 X[2]` +2 | `float4 X[4]` +4 | `float4 X[8]` +8 |
| mat3 | 否 | `float3x3 X[1]` +1 | `float3x3 X[1]` +1 | `float3x3 X[1]` +1 | `float3x3 X[2]` +2 | `float3x3 X[4]` +4 | `float3x3 X[8]` +8 |
| mat4x3 | 否 | `float4x3 X[1]` +1 | `float4x3 X[1]` +1 | `float4x3 X[1]` +1 | `float4x3 X[2]` +2 | `float4x3 X[4]` +4 | `float4x3 X[8]` +8 |
| mat4 | 否 | `float4x4 X[1]` +1 | `float4x4 X[1]` +1 | `float4x4 X[1]` +1 | `float4x4 X[2]` +2 | `float4x4 X[4]` +4 | `float4x4 X[8]` +8 |
| int | 是 | `float4 X[1]` +1 | `float4 X[1]` +1 | `float4 X[1]` +1 | `float4 X[2]` +2 | `float4 X[4]` +4 | `float4 X[8]` +8 |
| ivec4 | 否 | `int4 X[1]` +1 | `int4 X[1]` +1 | `int4 X[1]` +1 | `int4 X[2]` +2 | `int4 X[4]` +4 | `int4 X[8]` +8 |
| uint | 是 | `float4 X[1]` +1 | `float4 X[1]` +1 | `float4 X[1]` +1 | `float4 X[2]` +2 | `float4 X[4]` +4 | `float4 X[8]` +8 |
| uvec4 | 否 | `uint4 X[1]` +1 | `uint4 X[1]` +1 | `uint4 X[1]` +1 | `uint4 X[2]` +2 | `uint4 X[4]` +4 | `uint4 X[8]` +8 |

（`+k` 是加到 `TEXCOORD` 编号上的数。每一行写成 `<类型> <名>[c] : TEXCOORD<k>;`。）

- **非数组成员**一律 +1，**不看类型**：`varying mat4 m;` 写成 `float4x4 m : TEXCOORDk;`，下一个成员是 `TEXCOORDk+1`（矩阵不按列数 / 行数推进）。
- **accessArray**（float / vec2 / int / uint）：容量够用（float、int、uint 装 `4c ≥ n` 个标量，vec2 装 `2c ≥ n` 个），`k` 的增量与 fxc 实际占用的寄存器数一致。int / uint 数组在结构体里是 **`float4`**，不是 `int4` / `uint4`（直接取类型表下标 3，不查 `0x140482e30`）。
- **其他类型的数组**：元素个数是 `ceil(n/4)`，不是 `n`；`n = 1` 的 vec3 / vec4 连方括号都没有，成了普通向量。

### 2. 是同一条路径，`vec4[32] → 8` 是 WPE 的 bug（静态确认）

accessArray 与非 accessArray 走同一个循环、同一段长度计算（`0x1400f53f0`–`0x1400f5434`），区别只在 `0x1400f5384` 处换类型名。对 vec3 / vec4 / ivec4 / uvec4 数组，按 GLSL 语义**数组容量缩成四分之一**（`vec4 v[2]` → `float4 v[1]`，`vec4 v[32]` → `float4 v[8]`）；对矩阵数组更糟（见第 5 条推断）。公式的形状是「按每寄存器 4 个标量（vec2 是 2 个）打包」，只对 accessArray 的打包语义成立，作者没有给其他类型分支。

工坊 `audio_responsive_oscilloscope` 在 WPE 里能用，是因为作者本来就把 32 个标量 4 个一组塞进 `audioValue`、只用下标 0–7（顶点 `audioValue[uint(i) / uint(4)] = vec4(...)`，`i < 32` 步长 4；片元 `audioValue[int(f * 0.25)][i % int(4)]`），恰好落在缩短后的 `float4[8]` 里。

### 3. `main` 里的三段文本（静态确认）

三段都**只对 accessArray** 生成（条件 `n != 0 && 标志`），**不看分组**；非 accessArray 的数组没有任何拆包 / 置零 / 回写，正文里的名字直接换成 `OUT.<名>` / `IN.<名>`，下标打在缩短后的数组上。

| 阶段 | 函数 | 生成的文本 | 位置 |
|---|---|---|---|
| 顶点 | `FUN_1400f5940(varying 列表, buf)`，`0x1400f630b` | `<T> accessArray<名>[m] = (<T>[m])0;\n` | `\tVS_OUTPUT OUT;\n` 之后、uniform 拆包之前 |
| 片元 | `FUN_1400f5680(varying 列表, "IN.", buf)`，`0x1400f61bb` | `<T> accessArray<名>[m] = (<T>[m])IN.<名>;\n` | `\tPS_OUTPUT OUT;\n` 之后、uniform 拆包之前 |
| 顶点 | `FUN_1400f5b90(varying 列表, _, buf2)`，`0x1400f6335` | `OUT.<名> = accessArray<名>;\n` | 整段文本最后一个 `}` 之前，紧接着是 `\treturn OUT;\n` |

- `<T>` 是**原类型**的 HLSL 名（`float` / `float2` / `int` / `uint`，表 `0x140482eb0` 每项 +8），不是 `float4`。
- `m = ceil(k/4)·4 / (vec2 ? 2 : 1)`，`k = vec2 ? 2n : n`。即 float / int / uint 为 `n` 向上取到 4 的倍数，vec2 为 `n` 向上取到偶数。**对 varying，`m × 分量数` 总等于结构体里 `float4` 的标量数**（`emulate.py` 对 n = 1、2、4、5、13、32 全部核对），两边从不错位；错位只出现在 uniform 的 vec2 数组（cbuffer 是 `ceil(n/4)`）。
- 正文替换（`0x1400f6500`–`0x1400f650a`）：varying 列表里 `n > 0 && 标志` 的名字 → `accessArray<名>`，其余 → 顶点 `OUT.<名>`、片元 `IN.<名>`；几何阶段不替换 varying。

### 4. 几何阶段（静态确认）

同一个 `FUN_1400f52e0`、同一条公式。几何调两次：分组 1（顶点传来的共享列表，结构体名 `VS_OUTPUT`）和分组 2（几何的 `out`，结构体名 `PS_INPUT`），每次 `k` 从 0 重新数；之后片元的 `VS_OUTPUT` 用分组 2 那批成员（分组改回 0），顺序相同，所以编号与 `PS_INPUT` 一致。几何阶段**不生成**三段数组文本，也不做 varying 名替换。

### 5. fxc 的反应（推断）

| 情况 | 推断 |
|---|---|
| 常量下标越过缩短后的长度（`vec4 a[4]` → `float4 a[1]`，写 `a[2]` → `OUT.a[2]`；片元读 `IN.a[2]` 同理） | fxc 报 X3504 array index out of bounds，这一阶段编译失败，走 WPE 的回退（片元暗红 / 顶点只乘 MVP） |
| `vec3/vec4 a[1]`（没有方括号，成了 `float4 a`） | `OUT.a[0] = vec4(…)` 是给分量 `.x` 赋 float4，X3206 隐式截断警告、只写 `.x`；片元 `IN.a[0]` 读到标量 `.x`，当 vec4 用时被广播。不报错、值错 |
| 动态下标（循环变量）越过缩短后的长度 | 编译期不报错（oscilloscope 的片元就是 `dcl_indexRange v0.xyzw 8` 加动态下标）；越界的输出写入 / 输入读取在 D3D 里是未定义行为。若 fxc 把循环展开成常量下标，可能转成 X3504 |
| 矩阵 varying（不论是否数组） | 一个 `float3x3` / `float4x3` / `float4x4` 实际占 3–4 个连续语义号，WPE 只推进 1（数组推进 `c`），和下一个成员的 `TEXCOORD` 重叠，推断 fxc 报语义重叠错误（X4504 一类） |
| accessArray 的 `(T[m])` 强制转换 | 对 varying 不会出现长度不匹配（见第 3 条）。int / uint 的 `(int[m])IN.X` 是 float → int 的数值转换、不是按位重解释，且值被插值（没有 `nointerpolation`）。回写 `OUT.X = accessArrayX;` 是「同分量数、不同形状」的隐式转换（`float2[14]` → `float4[7]`），WPE 自带的 edgedetection（`vec2 v_TexCoordKernel[9]`）、localcontrast / godrays 高斯（`vec2 v_TexCoord[13/7/3]`）、downsample（`vec2 v_TexCoord[4]`）都依赖它，这些是 WPE 自带的常用效果，编不过会显示回退色，所以推断 fxc 接受（没有抓帧逐个核对） |
| uniform 的 vec2 数组（参照） | `(float2[2·ceil(n/2)])X`，`X` 是 `float4[ceil(n/4)]`，`n > 2` 时右边更小：推断 fxc 拒绝向更大的聚合转换（X3017 一类），从大转小的显式转换允许截断 |

---

## 证据

### Q1 `FUN_1400f52e0`：结构体成员

参数：`rdx` = 声明列表，`r8d` = 分组，`r9` = 输出流；`ecx` 存进 `0x80(%rsp)` 后被覆盖成计数器 `k`（`0x1400f5352: movl $0x0, 0x80(%rsp)`），不用。

结构体头：

```asm
1400f5305: leaq  0x392794(%rip), %rax     ; 0x140487aa0 "struct VS_OUTPUT\n{\n"
1400f530c: xorl  %r8d, %r8d
1400f5312: cmpl  $0x2, %ebx                ; 分组 == 2 ?
1400f5315: leaq  0x39276c(%rip), %rdx     ; 0x140487a88 "struct PS_INPUT\n{\n"
1400f5322: setne %r8b
1400f5326: addq  $0x12, %r8                ; 长度 18 / 19
1400f532d: cmovneq %rax, %rdx
```

逐成员（`rdi` = i·0x38，`rsi` = 列表首址）：

```asm
1400f537a: cmpl  %ebx, 0x30(%rdi,%rsi)     ; 分组不等 → 跳过
1400f537e: jne   0x1400f55ee
1400f5384: cmpl  $0x0, 0x28(%rdi,%rsi)     ; n > 0 ?
1400f5389: jle   0x1400f5397
1400f538b: cmpb  $0x0, 0x2c(%rdi,%rsi)     ; accessArray ?
1400f5390: movl  $0x3, %eax                ; 是：类型下标 3（vec4）
1400f5395: jne   0x1400f539a
1400f5397: movl  (%rdi,%rsi), %eax         ; 否：原类型下标
1400f539a: cltq
1400f539c: addq  %rax, %rax
1400f539f: movq  (%rcx,%rax,8), %rbx       ; rcx = 0x140482eb8（每项 16 字节的第 2 个指针 = HLSL 名）
...                                         ; 写类型名、" "（0x1404738a8）、名字
1400f53f0: movl  0x28(%rdi,%rsi), %eax     ; n
1400f53f4: movl  $0x1, %r12d               ; regs = 1
1400f53fa: testl %eax, %eax
1400f53fc: jle   0x1400f54ad               ; n <= 0：不写 []
1400f5402: movl  (%rdi,%rsi), %r8d         ; t（原类型下标，不是替换后的 3）
1400f5406: movl  %eax, %edx
1400f5408: leal  0x1(%r8), %ecx
1400f540c: imull %ecx, %edx                ; n·(t+1)
1400f540f: cmpl  $0x4, %edx
1400f5412: jle   0x1400f54ad               ; <= 4：不写 []
1400f5418: cmpl  %r12d, %r8d               ; t == 1 (vec2) ?
1400f541b: movl  $0x2, %edx
1400f5420: movl  $0x4, %ecx
1400f5425: cmovel %edx, %ecx               ; 除数 2 / 4
1400f5428: cltd
1400f5429: idivl %ecx
1400f542b: xorl  %ecx, %ecx
1400f542d: testl %edx, %edx
1400f542f: movb  $0x5b, %dl                ; '['
1400f5431: setne %cl
1400f5434: leal  (%rcx,%rax), %r12d        ; regs = n/d + (n%d != 0)
...                                         ; 写 '[' to_string(regs) ']'
1400f54ad: ...                              ; 写 " : "（0x1404789c4）
1400f54d8: cmpq  $0xb, %rbx                 ; 名字长 11 且 == "gl_Position"（0x140487a68）
...                                         ; → "SV_POSITION"（0x140487a78），跳到 0x1400f55cb
1400f5511: cmpq  $0x10, %rbx                ; 长 16 且 == "gl_ViewportIndex"（0x140487b08）
...                                         ; → "SV_ViewportArrayIndex"（0x140487b20）
1400f5547: ...                              ; "TEXCOORD"（0x140477bd8）
1400f555c: movl  0x80(%rsp), %ebx           ; k
...                                         ; to_string(k)
1400f55c1: addl  %r12d, %ebx                ; k += regs
1400f55c4: movl  %ebx, 0x80(%rsp)
1400f55cb: ...                              ; ";\n"（0x140487a64）
1400f560a: ...                              ; 循环外 "};\n\n"（0x140487a54）
```

伪代码：

```c
void FUN_1400f52e0(int unused, vector<Decl>* list, int group, ostream* out) {
  *out << (group == 2 ? "struct PS_INPUT\n{\n" : "struct VS_OUTPUT\n{\n");
  int k = 0;
  for (Decl& d : *list) {
    if (d.group != group) continue;
    int ti = (d.len > 0 && d.accessArray) ? 3 : d.type;
    *out << HLSL_NAME[ti] << " " << d.name;
    int regs = 1;
    if (d.len > 0 && d.len * (d.type + 1) > 4) {
      int div = d.type == 1 ? 2 : 4;
      regs = d.len / div + (d.len % div != 0);
      *out << '[' << to_string(regs) << ']';
    }
    *out << " : ";
    if (d.name == "gl_Position")           *out << "SV_POSITION";
    else if (d.name == "gl_ViewportIndex") *out << "SV_ViewportArrayIndex";
    else { *out << "TEXCOORD" << to_string(k); k += regs; }
    *out << ";\n";
  }
  *out << "};\n\n";
}
```

类型表 `0x140482eb0`（每项 GLSL 名、HLSL 名）读出：`float→float`、`vec2→float2`、`vec3→float3`、`vec4→float4`、`mat3→float3x3`、`mat4x3→float4x3`、`mat4→float4x4`、`sampler2D / sampler2DBackBuffer / sampler3D→sampler`、`sampler2DComparison→samplerComparison`、`int→int`、`ivec4→int4`、`uint→uint`、`uvec4→uint4`。打包表 `0x140482e30` = `[3,3,3,3,3,3,3,3,3,3,3,12,12,14,14]` 只在 cbuffer 路径用，这里没有引用。

声明解析补充（`FUN_1400f4810`）：`+0x28`、`+0x2c` 先清零（`0x1400f4aa8`、`0x1400f4ab0`），只有正则第 3 组存在时才走长度：数字 `atoi`（`0x1400f4d6e` 判 `isdigit`），否则查 COMBO 表（查不到长度保持 0），两条路都落到 `0x1400f4fcd` 打标。所以「带 `[宏]` 但 COMBO 里没有」是 `n = 0`、标志 1，四个函数都按非数组处理。

### Q2 同一路径

`FUN_1400f52e0` 里没有别的长度分支；accessArray 标志只在 `0x1400f538b` 用来换类型名。长度条件 `0x1400f540c` 读的是原类型下标，所以 `vec4`（t = 3）的 `n·4 > 4` 在 `n ≥ 2` 时成立，除数 4 → `ceil(n/4)`。

实测对照（`emulate.py` 末尾）：顶点声明顺序 `vec4 audioValue[32]`、`vec2 v_TexCoord`、`vec3 v_PerspCoord`、`vec3 v_ViewCoord`，再由 `FUN_1400f8860` 在末尾追加 `gl_Position`，生成：

```hlsl
struct VS_OUTPUT
{
float4 audioValue[8] : TEXCOORD0;
float2 v_TexCoord : TEXCOORD8;
float3 v_PerspCoord : TEXCOORD9;
float3 v_ViewCoord : TEXCOORD10;
float4 gl_Position : SV_POSITION;
};

```

与 WPE 编译缓存的 DXBC 签名（`TEXCOORD0`–`7` 各一个 float4、`TEXCOORD8` xy、`9` / `10` xyz、`SV_POSITION`，片元 `dcl_indexRange v0.xyzw 8`）逐项一致。

### Q3 三段文本

串（`peread.py` 读出）：`0x140487b48` `" accessArray"`、`0x140487b58` `"] = ("`、`0x140487b38` `"])"`、`0x140487b3c` `"])0;\n"`、`0x140487cc4` `"OUT."`、`0x140487b80` `" = accessArray"`、`0x140487a64` `";\n"`、`0x140487c4c` `"IN."`、`0x140474480` `""`、`0x140487d00` `"\treturn OUT;\n"`、`0x140487cb8` `"accessArray"`、`0x140487cb0` `"main("`。

三个函数的过滤条件相同，都**不读 `+0x30`**：

```asm
; FUN_1400f5680                         ; FUN_1400f5940                        ; FUN_1400f5b90
1400f56ea: movl 0x28(%rdi,%rsi),%eax    1400f599a: movl 0x28(%rdi,%rsi),%eax   1400f5bea: cmpl $0x0,0x28(%rdi,%rbx)
1400f56ee: testl %eax,%eax              1400f599e: testl %eax,%eax             1400f5bef: je   0x1400f5c78
1400f56f0: je   0x1400f5901             1400f59a0: je   0x1400f5b52            1400f5bf5: cmpb $0x0,0x2c(%rdi,%rbx)
1400f56f6: cmpb $0x0,0x2c(%rdi,%rsi)    1400f59a6: cmpb $0x0,0x2c(%rdi,%rsi)   1400f5bfa: je   0x1400f5c78
1400f56fb: je   0x1400f5901             1400f59ab: je   0x1400f5b52
```

`m` 的算术（`FUN_1400f5680` `0x1400f5701`–`0x1400f5744`，`FUN_1400f5940` 同形）：

```asm
1400f5701: movl  (%rdi,%rsi), %edx      ; t
1400f5704: leal  (%rax,%rax), %ecx      ; 2n
1400f5707: cmpl  $0x1, %edx
1400f570a: cmovel %ecx, %eax            ; vec2 → k = 2n，否则 k = n
1400f5710: cmpl  $0x1, %edx
1400f5715: sete  %r8b
1400f5719: incl  %r8d                   ; 除数 = vec2 ? 2 : 1
1400f571c..1400f573b                    ; eax = (k/4)*4 + (k%4 ? 4 : 0)
1400f5744: idivl %r8d                   ; m
```

伪代码：

```c
// 顶点置零 FUN_1400f5940(list, out)
for (Decl& d : list) if (d.len != 0 && d.accessArray)
  out << HLSL[d.type] << " accessArray" << d.name << '[' << m << "] = ("
      << HLSL[d.type] << '[' << m << "])0;\n";
// 拆包 FUN_1400f5680(list, prefix, out)：片元 varying 用 "IN."，各阶段 uniform 用 ""
  out << HLSL[d.type] << " accessArray" << d.name << '[' << m << "] = ("
      << HLSL[d.type] << '[' << m << "])" << prefix << d.name << ";\n";
// 顶点回写 FUN_1400f5b90(list, _, out)
  out << "OUT." << d.name << " = accessArray" << d.name << ";\n";
```

调用点（`FUN_1400f5cb0`，`r15d` = 阶段，`0x30(%rbp)` = varying 列表，`0x88(%rbp)` = uniform 列表，`rsi` 先置 `"IN."`（`0x1400f6130`））：

| 阶段 | 地址 | 内容 |
|---|---|---|
| 0 顶点 | `0x1400f629d` | 签名 `"VS_OUTPUT main(VS_INPUT IN"` + 系统值参数 + `")\n{\n\tVS_OUTPUT OUT;\n"`（`0x140487bf8` / `0x140487b68`） |
| | `0x1400f630b` | `FUN_1400f5940(varying, buf)` |
| | `0x1400f6325` | `FUN_1400f5680(uniform, "", buf)` |
| | `0x1400f6335` | `FUN_1400f5b90(varying, _, buf2)` |
| 2 片元 | `0x1400f614a` | 签名 `"PS_OUTPUT main(VS_OUTPUT IN"` + … + `")\n{\n\tPS_OUTPUT OUT;\n"`（`0x140487c30` / `0x140487c98`） |
| | `0x1400f61bb` | `FUN_1400f5680(varying, "IN.", buf)` |
| | `0x1400f61d5` | `FUN_1400f5680(uniform, "", buf)` |
| 1 几何 | `0x1400f61df` | 只有签名（`triangle` / `point`，`")\n{\n\t"`），三个函数都不调 |
| 共用 | `0x1400f633a` | 签名后接 `buf`（所以置零 / 拆包紧跟在 `OUT;` 一行之后） |
| 0、2 | `0x1400f69a5`–`0x1400f6a0d` | 阶段 ≠ 1 时：`pos = rfind('}')`，若 `pos` 存在且在 `find("main(")` 之后，把 `buf2 + "\treturn OUT;\n"` 插到 `pos`（片元的 `buf2` 是空串） |

正文替换表（`0x1400f6437`–`0x1400f6606`）：

```asm
1400f64d1: leaq  0x3917ec(%rip), %rax    ; "OUT."
1400f64d8: testl %r15d, %r15d
1400f64e0: cmoveq %rax, %rsi             ; 顶点用 "OUT."，片元保留 "IN."
1400f6500: cmpl  $0x0, 0x28(%rsi)        ; 遍历 varying 列表：n > 0 ?
1400f6504: jle   0x1400f6522
1400f6506: cmpb  $0x0, 0x2c(%rsi)        ; 且 accessArray
1400f650a: je    0x1400f6522
1400f650c: ... "accessArray" + 名        ; 0x140487cb8
1400f6522: ... 前缀 + 名
```

阶段 1 在 `0x1400f64c7`（`cmpl $0x2; jne 0x1400f65a9`）跳过 varying 这段，直接进 uniform 那段。注意 uniform 的 accessArray 替换（`0x1400f65c0`）对几何也执行，但几何不生成 uniform 拆包行（见「附带发现」）。

### Q4 几何

```asm
1400f6c4b: cmpl  $0x1, %r15d
1400f6c4f: jne   0x1400f6c6a
1400f6c51: leaq  0x50(%rsp), %r9
1400f6c56: movl  %r15d, %r8d             ; 分组 1
1400f6c59: leaq  0x30(%rbp), %rdx
1400f6c5d: callq 0x1400f52e0             ; → "struct VS_OUTPUT"
1400f6c62: movl  $0x2, %r8d              ; 分组 2
1400f6c68: jmp   0x1400f6c86
...
1400f6c83: xorl  %r8d, %r8d              ; 顶点 / 片元：分组 0
1400f6c86: leaq  0x50(%rsp), %r9
1400f6c8b: leaq  0x30(%rbp), %rdx
1400f6c8f: callq 0x1400f52e0             ; 几何：→ "struct PS_INPUT"
```

几何的列表（`0x1400f5f96`–`0x1400f606a`）：共享列表每项拷一份、分组置 1；几何源码里分组 2（`out`）的项追加进来，同时以分组 0 推进新的共享列表给片元。`k` 每次调用从 0 开始，公式与第 1 条相同。

### Q5 fxc

全部是推断，依据见结论第 5 条表格。旁证只有两条：oscilloscope 的动态下标编出 `dcl_indexRange`（已有的 DXBC 签名）；WPE 自带效果里有 vec2 varying 数组（`assets/` 全文 grep，vec3 / vec4 / 矩阵 / 整数的 varying 数组一个都没有），它们若编不过会显示回退色，所以推断「同分量数、不同形状」的数组隐式转换与 `(float2[m])float4[c]` 强制转换 fxc 都接受。

---

## 附带发现（静态确认，后果推断）

1. **三段数组文本和顶点 / 片元的替换都不看分组**：顶点源码里用 `in` / `out` 声明的 accessArray varying（分组 1 / 2）不进顶点 `VS_OUTPUT`，却仍会生成置零和 `OUT.<名> = accessArray<名>;`，`OUT` 没有这个成员 → 推断编译失败。顶点的整份列表（含分组 1 / 2 的项）原样拷进共享列表，片元那边的拆包同样会引用 `IN.<名>`。
2. **几何阶段的 accessArray uniform**：替换表对所有阶段都建（`0x1400f65a9` 起），几何的签名分支却不调 `FUN_1400f5680`，`main` 之后的 `<名>` 被换成从没声明的 `accessArray<名>` → 推断编译失败。
3. **片元的 accessArray 判定来自顶点的声明**：片元列表被共享列表覆盖，片元写 `varying vec4 v[4]`、顶点写 `varying vec2 v[4]` 时，片元照样按 vec2 拆包成 `float2 accessArrayv[4]`，正文 `v[i]` 是 float2。
4. 长度判断有两种写法：替换表用 `n > 0`（`jle`），三个函数用 `n != 0`（`je`）。只有 COMBO 给负数时才会分歧，正常语料遇不到。
5. **`vec3` / `vec4` 数组 `n = 1` 没有方括号**、`mat*` 数组 `n = 1` 却有 `[1]`（`n·(t+1)` 对矩阵是 5–7 > 4）。

## 对翻译器的含义

要和 WPE 的画面一致，varying 数组按上表的「声明长度 + location 增量」复刻：vec3 / vec4 / ivec4 / uvec4（以及矩阵）数组只有 `ceil(n/4)` 个元素、占 `ceil(n/4)` 个 location；float / int / uint 数组打包成 `ceil(n/4)` 个 vec4、vec2 数组打包成 `ceil(n/2)` 个 vec4；`n = 1` 的 vec3 / vec4 数组退化成普通向量。顺带的好处是不会超出 WebGPU 默认的 16 个阶段间变量（忠实的 `vec4[32]` 一个就超了）。

## 仍未知

1. fxc 对 **数组 → 非数组** 的隐式回写（`n ≤ 4` 的 float、`n ≤ 2` 的 vec2：`OUT.X`（`float4`）= `accessArrayX`（`float[4]` / `float2[2]`））是否接受。WPE 自带着色器里没有这种长度，没有旁证；可以拿本机 fxc 编一下。
2. 矩阵 varying 的语义重叠到底报什么，以及矩阵在签名里占几个语义号（`float4x3` 在 column_major 下是 3 还是 4），没有实测。缩短后数组的常量越界与循环越界已由下面的实测确认（X3504）。
3. 动态下标越界写输出 / 读输入在实际驱动上的表现（丢弃、写到相邻寄存器、读出 0）。
4. `FUN_1400f52e0` 的第一个参数（`ecx`）在两个调用点都没有显式赋值，本函数也不用；是否是某个被优化掉的参数没追。

## 实测（2026-11-14）

两份抓帧加 WPE 的编译缓存，和上面的公式逐项相符。

**工坊场景 3585875739**（抓帧 `A:\p8\osc\osc-frame274.rdc`，缓存 `…\431960\3585875739\shaders\blobsSM40\cf597063….dxs`）：示波器顶点输出 `TEXCOORD0`–`7`（`audioValue`）、`TEXCOORD8`（`v_TexCoord`.xy）、`TEXCOORD9`、`TEXCOORD10`（xyz）、`SV_POSITION`，共 12 个寄存器；片元输入相同，`dcl_indexRange v0.xyzw 8`，循环 `i < 32`、下标 `int(i * 0.25)`。场景在 WPE 里正常显示。

**确定性工程 `ignore/varying/proj/p-va`**（生成器 `ignore/varying/gen_var.py`，抓帧 `A:\varying\va\va-frame188.rdc`，签名脚本 `ignore/varying/sigs.py`，取像素 `ignore/varying/px_va.py`）：每种情况一个纯色图层 + 一个自写 effect，顶点先声明待测数组、紧跟 `vec2 v_TexCoord` 作标记（标记的 `TEXCOORD` 编号 = k 的增量），第 j 个元素写 x = (j + 1) / 40，片元输出读到的元素。

| 情况 | 声明 | 写 / 读 | 签名（数组 + 标记） | 声明长度 | 画面 |
|---|---|---|---|---|---|
| v4n2 | `vec4 a[2]` | 写 0、读 0 | T0.xyzw、T1.xy | 1 | 对 |
| v4n5 | `vec4 a[5]` | 写 0–1、读 1 | T0–1.xyzw、T2.xy | 2 | 对 |
| v4n8 | `vec4 a[8]` | 写 0–1、读 1 | 同上 | 2 | 对 |
| v4combo | `vec4 a[KBN]`（COMBO 缺省 8） | 写 0–1、读 1 | 同上 | 2 | 对 |
| v4n32 | `vec4 a[32]` | 写 0–7、读 7 | T0–7.xyzw、T8.xy | 8 | 对 |
| v3n4 | `vec3 a[4]` | 写 0、读 0 | T0.xyz、T1.xy | 1 | 对 |
| v3n5 | `vec3 a[5]` | 写 0–1、读 1 | T0–1.xyz、T2.xy | 2 | 对 |
| f6 | `float a[6]` | 写 0–5、读 5 | T0–1.xyzw、T2.xy | 2（打包） | 对 |
| v2n4 | `vec2 a[4]` | 写 0–3、读 3 | T0–1.xyzw、T2.xy | 2（打包） | 对 |
| v2n13 | `vec2 a[13]` | 写 0–12、读 12 | T0–6.xyzw、T7.xy | 7（打包） | 对 |
| v4oob | `vec4 a[4]` | 写 0 和 2 | —（顶点编译失败） | — | 整块黑 |
| v4loop | `vec4 a[8]` | 循环写 0–7 | —（顶点编译失败） | — | 整块黑 |

- 「T0–1.xyzw、T2.xy」这一形状有 5 个 blob（v4n5、v4n8、v4combo、f6、v2n4），`u_case_*` 没用到、所在 cbuffer 被 fxc 删掉，按排除法对上；其余形状各只有一个候选。
- 两个失败的日志原文：`kbva_v4oob.vert(62,2-9): error X3504: array index out of bounds`；`kbva_v4loop.vert(62,3-10): error X3504: literal loop terminated early due to out of bounds array access`（另有 `warning X3550: array reference cannot be used as an l-value; not natively addressable, forcing loop to unroll`）。顶点走回退（只变换位置），片元照常编过、读到的输入全是 0，所以输出 `(0, 0, 0, 1)` 黑，不是暗红。
- 语料（183 张）里非 accessArray 类型的 varying 数组只有 `workshop/2799421411/effects/audio_responsive_oscilloscope` 一处，WPE `assets/` 里一处也没有；accessArray 的有 `blur_gaussian`、`blur_downsample4` 等 vec2 数组，长度都 > 2。

## 和 WebGPU 阶段间变量上限的关系（2026-11-14 语料统计）

`ignore/p8/s4/varyings.test.ts` → `ignore/p8/s4/out/varyings.json`：我们现在每个 varying 一个 location、数组每个元素一个。WebGPU 缺省 `maxInterStageShaderVariables` 是 16（本机适配器最多 28，设备没申请）。183 张里超过 16 的程序有 5 张：

| 场景 | 着色器 | 现在 | 照 WPE |
|---|---|---|---|
| 3243449890、3486806915、3492627662、3516174947 | 工坊 `auto_sway`（31 个以内的 float / vec2 散变量） | 17–31 | fxc 签名打包：3492627662 的缓存里 32 个输出元素进 12 个寄存器（含位置），即 11 |
| 3585875739 | 示波器 | 35 | 数组照上表缩成 8：8 + 3 = 11 |
