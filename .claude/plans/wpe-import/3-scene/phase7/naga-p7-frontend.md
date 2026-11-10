# P7 步骤 0：naga 嵌入与 GLSL 前端的 HLSL 隐式转换（读码）

范围：naga 30.0.1（`%USERPROFILE%\.cargo\registry\src\index.crates.io-*\naga-30.0.1\`，下文路径都相对它的 `src/`）。
方法：读码，再在 scratchpad 里拷一份 naga 写原型，喂失败语料与 WPE 安装目录语料实测。仓库文件除本文外都没改。

## 结论摘要

- naga GLSL 前端现在**只做一种隐式转换：分量类型按 `int < uint < float < double` 往高处提升**，形状（标量 / 向量宽度 / 矩阵尺寸）一律不动。大多数报错其实不是前端拒绝，而是前端照原样产出类型不一致的 IR，校验器才报错。
- HLSL 模式改动集中在 6 个文件。原型 **+200 / −14 行**（不含矩阵、标量取下标、二义性报错和单测），覆盖赋值、初始化、返回、实参（含内置函数）、二元混算、条件、浮点下标和片元写 varying。
- 原型实测：
  - **失败语料**里能拿到 GLSL 的类型类着色器，除 `video`（标量取下标，原型故意没做）和 `audio`（源码损坏）外，**全部通过校验**。片元写 varying 的 2 个（`geometric_transform`、`auto_sway`）也一并通过。
  - **WPE 安装目录 167 对**：开关关闭时输出与上游逐字节相同。开关打开时，原来通过的 158 对也逐字节相同，另外多过 2 对：`effects/shimmer`、`editorpaintbrush`。
- `fluidsimulation_advection` 是 **naga 前端的缺陷，由我们的改写触发**。前端裁掉 `return` 之后的死代码时，留下了没有语句访问的 `CallResult`。死代码里的 `min` 被我们宏成了用户函数 `kb_min`，才产生了 `CallResult`。前端修法 +43 行，已验证。
- 裁剪：删掉 SPIR-V / MSL / HLSL / GLSL / dot 后端和 SPIR-V 前端后约剩 **6.2 万行**（上游 11.9 万行）。`proc` / `valid` / `common` / `keywords` / `compact` / `arena` 都得留。interpolator 的问题是 cfg 漏了 `glsl-in`，一行修好（已验证只开 `glsl-in` + `wgsl-out` 能编过）。
- 许可证：`MIT OR Apache-2.0`，保留 `LICENSE.MIT` / `LICENSE.APACHE`，`Cargo.toml` 的 `license` 字段照写。改过的文件按 Apache 2.0 §4(b) 加修改声明，另在说明里逐项列出。

---

## 1. 隐式转换现状

### 1.1 全部转换只走这一张「类型等级」表

`front/glsl/types.rs:209`

```rust
pub const fn type_power(scalar: Scalar) -> Option<u32> {
    Some(match scalar.kind {
        ScalarKind::Sint => 0,
        ScalarKind::Uint => 1,
        ScalarKind::Float if scalar.width == 4 => 2,
        ScalarKind::Float => 3,
        ScalarKind::Bool | ScalarKind::AbstractInt | ScalarKind::AbstractFloat => return None, // 现状：bool 不参与任何隐式转换
    })
}
```

几个转换函数（`front/glsl/context.rs`）：

```rust
// context.rs:1411 —— 生成 As（kind + width 转换），不改形状
pub fn conversion(&mut self, expr: &mut Handle<Expression>, meta: Span, scalar: Scalar) -> Result<()>

// context.rs:1429 —— 只在目标等级更高时转（int→float 之类），否则什么也不做
pub fn implicit_conversion(&mut self, expr, meta, scalar: Scalar) -> Result<()> {
    if let (Some(tgt_power), Some(expr_power)) = (type_power(scalar), self.expr_power(*expr, meta)?) {
        if tgt_power > expr_power {
            self.conversion(expr, meta, scalar)?;
        }
    }
    Ok(())
}

// context.rs:1446 —— 分量类型不同就转（构造器用）
pub fn forced_conversion(...)

// context.rs:1461 —— 二元：低等级一边转成高等级一边的分量类型
pub fn binary_implicit_conversion(...)

// context.rs:1489 / 1504 —— 已有的铺满与截断工具，HLSL 模式直接复用
pub fn implicit_splat(&mut self, expr, meta, vector_size: Option<VectorSize>)   // 标量 → Splat
pub fn vector_resize(&mut self, size: VectorSize, vector, meta)                  // Swizzle XYZW 取前 size 个
```

### 1.2 各处现状

| 位置 | 文件:行 | 现在做的 | HLSL 写法的结果 |
|---|---|---|---|
| 赋值 / 复合赋值 | `context.rs:1213` `HirExprKind::Assign` | 只对目标的分量类型调 `implicit_conversion` | 宽赋窄、标量赋向量：Store 类型不符，校验报 `The type of [x] doesn't match the type stored in [y]` |
| 复合赋值的展开 | `parser/expressions.rs:463–504` | `a op= b` 解析成 `Assign { tgt: a, value: Binary(a, op, b) }` | 走二元与赋值两处，不用单独改 |
| swizzle 赋值 | `context.rs:482` `lower_store` | 逐分量 `AccessIndex(value, i)` 存 | `v.xy = vec4` 碰巧能过（只取前两分量）；`v.xyz = 1.0` 对标量取下标，校验失败 |
| 局部 / 全局初始化 | `parser/declarations.rs:153`（`parse_initializer`）、`:230`（`parse_init_declarator_list`，同一个值再转一次） | `implicit_conversion` | 常量初始化报 `Initializer doesn't match the variable type`；非常量初始化被拆成 Store，报 Store 类型不符 |
| return | `parser/functions.rs:94` | **完全不转**（上游留着 `// TODO: Implicit conversions`） | `float f() { return 1; }` 也会校验失败 |
| 用户函数 / 内置函数调用 | `functions.rs:515` `function_call` | 两者共用同一套重载表（内置函数由 `inject_builtin` 按名字惰性注入成 `FunctionKind::Macro`），逐个候选比较，见 1.3 | 宽度不同就没有候选，报 `Unknown function 'rotateVec2' / 'mix' / 'texture'` |
| 实参落地 | `functions.rs:811` | 选定重载后，对每个实参 `implicit_conversion` | — |
| 二元运算 | `context.rs:604–616`，形状处理 `:773–823` | 分量类型按等级提升；向量 ⊕ 标量只对 `Add/Sub/Div/位运算/移位` 铺满（`Multiply` 是 IR 原生）；向量 ⊕ 向量原样 | 宽度不同的向量原样进 IR，校验报 `Operation Multiply can't work with …`；`%`、比较运算的向量 ⊕ 标量也不铺满 |
| 三元 `?:` | `context.rs:1098–1165` | 降成 `if` + 临时变量；两支按等级互转（`:1143`）；条件不转 | 浮点条件报 `The if condition … is not a boolean scalar`（`?:` 也报成 `if`） |
| `if` / `while` / `do` / `for` 条件 | `parser/functions.rs:123`、`:343`、`:398`、`:484` | 不转 | 同上 |
| `!` / `&&` / `\|\|` | `context.rs:997` `Unary`、二元同上 | 不转 | 校验失败 |
| 下标 | `context.rs:556` `HirExprKind::Access` | 索引不转；底座类型不查 | 浮点索引校验失败；对标量取下标在 `resolve_type` 时报 `Can't resolve type: InvalidAccess` |
| swizzle | `variables.rs:244` `field_selection` | 只认向量；标量 `.xxx` 报 `Can't lookup field on this type` | 语料里没出现 |
| 构造器 | `functions.rs:61` `constructor_single`、`:414` `constructor_many` | 已经很宽：`vec2(vec4)` 截断、`vec4(x)` 铺满、`float(vec3)` 取 `.x`、矩阵按矩阵构造 | 显式转换本来就和 HLSL 一致，不用改 |
| 输入 varying 写入 | `variables.rs:480` | `mutable: !input`；`context.rs:1024` 对 LHS 报错 | `Variable cannot be used in LHS position` 的来源就在这里（已确认） |

摘录：

```rust
// context.rs:1213 赋值 —— 只转分量类型
HirExprKind::Assign { tgt, value } if ExprPos::Lhs != pos => {
    let (pointer, ptr_meta) = self.lower_expect_inner(stmt, frontend, tgt, ExprPos::Lhs)?;
    let (mut value, value_meta) = self.lower_expect_inner(stmt, frontend, value, ExprPos::Rhs)?;
    let ty = match *self.resolve_type(pointer, ptr_meta)? {
        TypeInner::Pointer { base, .. } => &self.module.types[base].inner,
        ref ty => ty,                       // swizzle 指针解析成 Vector；`v.x` 解析成 ValuePointer
    };
    if let Some(scalar) = scalar_components(ty) {
        self.implicit_conversion(&mut value, value_meta, scalar)?;   // 现状：宽度不变
    }
    self.lower_store(pointer, value, meta)?;
    value
}
```

```rust
// parser/functions.rs:94 return —— 一点都不转
TokenValue::Return => {
    ...
    _ => {
        // TODO: Implicit conversions
        let mut stmt = ctx.stmt_ctx();
        let expr = self.parse_expression(frontend, ctx, &mut stmt)?;
        self.expect(frontend, TokenValue::Semicolon)?;
        let (handle, meta) = ctx.lower_expect(stmt, frontend, expr, ExprPos::Rhs)?;
        (Some(handle), meta)
    }
```

```rust
// parser/functions.rs:123 if —— 条件原样
let condition = {
    let mut stmt = ctx.stmt_ctx();
    let expr = self.parse_expression(frontend, ctx, &mut stmt)?;
    let (handle, more_meta) = ctx.lower_expect(stmt, frontend, expr, ExprPos::Rhs)?;
    meta.subsume(more_meta);
    handle                                           // 现状：float 直接当条件
};
```

```rust
// variables.rs:480 输入 varying 不可写（输入在 IR 里本来就是 Private 全局，见 :440 `space: AddressSpace::Private`，
// 入口包装函数把参数拷进去；所以「可写」在 IR 上没有任何障碍）
let lookup = GlobalLookup { kind: GlobalLookupKind::Variable(handle), entry_arg: Some(idx), mutable: !input };
```

### 1.3 重载解析（`functions.rs:515–775`）

- 每个候选、每个实参先比类型：完全相同记 `Exact`；`inout` 不同直接淘汰；否则调 `conversion(param, arg)`（`functions.rs:1523`）。
- `conversion` 只接受**同形状**（标量对标量、同宽向量、同尺寸矩阵），并且目标等级不低于来源，返回 `FloatToDouble` / `IntToFloat` / `IntToDouble` / `Other`。
- 候选之间**逐实参比优劣**（`:694` 的 `best_arg`）：一个实参上新的更好、另一个实参上旧的更好，就记二义。全部 `Exact` 的候选直接选中。
- 没有候选时报 `Unknown function '<名>'`（`:770`）。WPE 方言里 `rotateVec2(vec4, …)`、`mix(vec4, vec3, float)`、`texture(sampler2D, vec4)` 都落在这里。

```rust
// functions.rs:1523
fn conversion(target: &TypeInner, source: &TypeInner) -> Option<Conversion> {
    let (target_scalar, source_scalar) = match (target, source) {
        (&TypeInner::Scalar(t), &TypeInner::Scalar(s)) => (t, s),
        (&TypeInner::Vector { size: ts, scalar: t }, &TypeInner::Vector { size: ss, scalar: s }) if ts == ss => (t, s),
        (&TypeInner::Matrix { .. }, &TypeInner::Matrix { .. }) if /* 同尺寸 */ => (t, s),
        _ => return None,                    // 现状：宽度不同、标量对向量一律不可转
    };
    if type_power(target_scalar) < type_power(source_scalar) { return None; }  // 现状：float → int 不可转
    ...
}
```

另外：我们的翻译器在 `rewrite.rs:782` 给 `pow` / `max` / `min` 补了一组「标量扩展」用户函数 `kb_pow` / `kb_max` / `kb_min`，再用 `#define min kb_min` 指过去。所以这三个函数的调用是**用户函数调用**，不是内置函数调用（第 3 节的流体错误就是这么来的）。

---

## 2. 加 HLSL 模式要改哪里

### 2.0 选项传递

```rust
// front/glsl/mod.rs:52
pub struct Options {
    pub stage: ShaderStage,
    pub defines: FastHashMap<String, String>,
    pub hlsl_implicit: bool,          // 新增；From<ShaderStage> 里给 false
}
// Frontend（mod.rs:167，Default 派生）加 `hlsl: bool`；parse()（:197）在 reset 之后 `self.hlsl = options.hlsl_implicit;`
// Context（context.rs:47）加 `pub hlsl: bool` 与 `pub return_ty: Option<Handle<Type>>`；Context::new(frontend, …) 里 `hlsl: frontend.hlsl`
// parser/declarations.rs:330 函数定义建 Context 之后 `context.return_ty = ty;`（return 要用）
```

- 前端里两类代码各读一处：`Frontend` 的方法（`function_call`、`add_global_var`）读 `self.hlsl` 或 `ctx.hlsl`；`Context` 的方法读 `self.hlsl`。
- 翻译器侧只改一行：`naga_stage.rs:42` 之后加 `options.hlsl_implicit = true;`。
- `Options` 加公有字段对 `Options::from` 的用法是兼容的。naga 自己的测试用结构体字面量构造 `Options` 的地方要补字段：`parser_tests.rs` 只用 `Options::from`，已确认不受影响。

### 2.1 一个转换助手 + 一个条件助手

所有规则共用两个函数，放在 `context.rs`（原型约 75 行，补矩阵和 bool 来源后估计 110 行）：

```rust
/// HLSL：分量类型转换；目标为 bool 时生成 `x != 0`（向量就和铺满的 0 比）。
fn hlsl_kind(&mut self, expr: &mut Handle<Expression>, meta: Span, scalar: Scalar) -> Result<()>;

/// HLSL：把值转到目标类型（标量 / 向量；矩阵见下）。开关关闭时直接返回。
pub fn hlsl_coerce(&mut self, expr: &mut Handle<Expression>, target: &TypeInner, meta: Span) -> Result<()> {
    if !self.hlsl { return Ok(()); }
    // ValuePointer（`v.x = …` 的指针类型）先映射成 Scalar / Vector
    match (target, src) {
        (Vector { size, scalar }, Scalar(_))           => { hlsl_kind; Splat { size } }          // 铺满
        (Vector { size, scalar }, Vector { size: s, .. }) => { if s > size { vector_resize(size) } hlsl_kind }  // 截断
        (Scalar(scalar), Vector { .. })                => { AccessIndex 0; hlsl_kind }          // 取 .x
        (Scalar(scalar), Scalar(_))                    => hlsl_kind,                            // float → int 等
        _ => {}                                        // 窄赋宽仍然交给校验器报错（HLSL 也报错）
    }
}

/// HLSL：标量条件不是 bool 时按 `!= 0`。
pub fn hlsl_condition(&mut self, expr: &mut Handle<Expression>, meta: Span) -> Result<()>;
```

开关关闭时两个助手直接返回，调用点的其余改动只是把 `let x = …` 改成 `let mut x = …`，所以关闭时 IR 与上游完全相同（第 2.3 节实测）。

### 2.2 按规则列

fxc 的语义都是按 HLSL 常识写的**假设**，标「待实测」的由另一条线用 fxc 编译、反汇编确认。

| 规则 | 落点 | 改法 | 行数 | 坑 |
|---|---|---|---|---|
| **赋值截断 / 铺满**（含复合赋值、swizzle 赋值） | `context.rs:1213` Assign | `implicit_conversion` 之后 `self.hlsl_coerce(&mut value, &ty, value_meta)`；`ty` 先 `clone()`，否则借用冲突 | +3 | swizzle 指针解析出的是 `Vector`、`v.x` 解析出 `ValuePointer`，助手里要映射；复合赋值靠二元那一步先截短 |
| **初始化截断 / 铺满** | `parser/declarations.rs:153`（`parse_initializer`） | 同上，目标取声明类型 | +3 | `:230` 那一处对同一个值再转一次，不用再加；常量初始化在 `is_const` 下，加的 Splat / Swizzle / AccessIndex / As 都要能被常量求值器折叠（原型里 `vec3 b = 0.5;` 折成了 `vec3(0.5f)`；全局 `const` 没测） |
| **返回截断 / 铺满**，顺带 int → float | `parser/functions.rs:94` | 仅在 `ctx.hlsl` 时按 `ctx.return_ty` 先 `implicit_conversion` 再 `hlsl_coerce` | +9（另含 return_ty 传递 +2） | 关闭时不能顺手修上游 TODO，否则逐字节可能变 |
| **实参截断 / 铺满**：用户函数 | `functions.rs` `function_call` | ① GLSL 规则选不出候选（`maybe_overload.is_none()`）且 `ctx.hlsl` 时，跑**第二遍**按 HLSL 代价选；② 落地处（`:811`）`implicit_conversion` 之后 `hlsl_coerce(param)` | 第二遍 ~70，落地 +3 | 见下方「重载打分」 |
| **内置函数实参宽度不一**（`mix(vec4, vec3, float)`、`texture(sampler2D, vec4)`） | 同上，同一个第二遍 | 内置函数的候选就是 `inject_builtin` 注入的那些具体类型签名，不用单独处理；`MacroCall::call` 收到的已是转换后的实参 | 0 | 带 `depth` 形参的候选第二遍要跳过：第一遍对它们调 `sampled_to_depth` 会改全局纹理的类型 |
| **不同宽度向量混算**（截到窄的） | `context.rs:604` Binary | `binary_implicit_conversion` 之后，两边都是向量且宽度不同，就把宽的 `vector_resize` 到窄的 | +12 | 比较 `==` / `!=` 在 GLSL 前端被包成 `all()` / `any()`（`:773`），HLSL 是逐分量的 bvec，语义不同（语料没出现，不改）；`%` 与 `<` 等对向量 ⊕ 标量现在不铺满（`:789` 的列表），HLSL 允许，语料没出现时先不加 |
| **非布尔条件转 `!= 0`** | `if`（`parser/functions.rs:123`）、`while`（`:343`）、`do`（`:398`）、`for`（`:484`）、`?:`（`context.rs:1098`）、`!`（`:997`）、`&&` / `\|\|`（二元） | 降成 IR 之前调 `hlsl_condition` | ~20 | 向量条件 HLSL 怎么处理待实测（推测 `if` 要求标量，`?:` 是逐分量选择）；HLSL 的 `?:` 两支都求值、`&&` / `\|\|` 不短路，naga 降成 `if`，只有带副作用时才有差别 |
| **float → int 隐式**（初始化 / 赋值 / 实参 / 返回） | 都在 `hlsl_coerce` 里 | `As { kind: Sint, convert: Some(4) }`，WGSL 里是 `i32(x)`，向零截断 | 0 | fxc 的 `ftoi` 也向零截断（待实测）；WGSL 越界饱和、D3D 越界未定义 |
| **bool ↔ 数值** | `hlsl_kind` | → bool：`!= 0`（已做）；bool →：`Select(1, 0)`（原型没做，`constructor_single` 里 `functions.rs:79` 有现成写法） | +10 | `type_power(Bool) = None`，现有比较都把 bool 排除在外 |
| **浮点下标** | `context.rs:556` Access | 索引是浮点标量就 `conversion(I32)` | +8 | `video` 的 `g_AudioSpectrum64Left[barID / 4]`，`barID` 是 float；fxc 是转 uint 还是 int、负数怎么办待实测 |
| **标量取下标**（`f[i % 4]`） | `context.rs:556` Access | 原型没做。底座是标量时：索引常量 0 就返回底座本身；其余等 fxc 结论 | ~15 | 推测 fxc 直接报错（X3121），那样 WPE 本身就会走 dx11fallback，应归到「WPE 也编不过」 |
| **向量 → 标量**（`float f = v;`） | `hlsl_coerce` | `AccessIndex 0` | 0 | fxc 取 `.x` 并给 X3206 警告（待实测） |
| **矩阵截断 / 铺满** | `hlsl_coerce` 加两支 | 大矩阵 → 小矩阵：取前 C 列，每列 `vector_resize` 到 R，再 `Compose`；标量 → 矩阵：**每个元素**都是这个值（不能借 GLSL `mat3(x)` 的对角语义） | ~30 | 语料没出现。HLSL 取左上角；WPE 宏头把 `mul(a, b)` 换成 `b * a`（转置约定），左上角在转置下不变，所以照取左上角即可 |
| **片元写 varying** | `variables.rs:480` | `mutable: !input \|\| self.hlsl` | 1 | 输入在 IR 里本来就是 Private 全局；只放开 `in`，uniform 仍不可写（HLSL 全局默认也是常量）。这和 P7b 的「varying 私有副本」重复，见末尾「建议的改动顺序」 |
| 标量 swizzle（`f.xxx`） | `variables.rs:244` | 底座是标量时当作 1 分量向量 | ~15 | 语料没出现，不做 |
| `out` 实参截断 | `functions.rs:873` `process_lhs_argument` | 不做：第二遍里 `out` / `inout` 要求类型完全相同 | 0 | HLSL 允许 `out` 窄写宽，语料没出现 |

**重载打分（第二遍）**：

```rust
/// 原型：GLSL 规则选不出候选时才走；对每个候选求实参代价之和，取最小；同代价取先出现的。
fn hlsl_cost(target: &TypeInner, source: &TypeInner) -> Option<u32> {
    if target == source { return Some(0); }                 // 纹理、采样器等非数值形参只认相同
    // 分量类型：相同 0，按等级提升 1，降级（float → int）4，bool 不可转
    match (target, source) {
        (Scalar(t), Scalar(s))                         => kind_cost(t, s),
        (Vector { size, scalar: t }, Vector { size: ss, scalar: s }) =>
            if ss < size { None } else { Some(kind_cost(t, s)? + 8 * (ss - size)) },   // 每截掉一个分量 8
        (Vector { scalar: t, .. }, Scalar(s))          => Some(kind_cost(t, s)? + 2),  // 铺满 2
        (Scalar(t), Vector { size, scalar: s })        => Some(kind_cost(t, s)? + 8 * (size - 1)),
        _ => None,
    }
}
```

坑与取舍：
- **为什么要两遍，不直接扩展 `conversion()`**：现有的逐实参比较遇到「一个实参更好、另一个更差」就报二义。把截断、降级塞进同一遍，会让本来能选出唯一重载的调用变成二义（例如 `max(vec3, 1)` 多出一个 `max(int, int)` 候选：它在实参 0 上更差（截断 + 降级），在实参 1 上更好（`Exact` 对 `IntToFloat`））。只在 GLSL 选不出时才走第二遍，**现在能过的调用一定不变**，逐字节基线也就有了保证。
- **总代价**近似 HLSL 内置函数的规则：模板维度取最窄的非标量实参，标量铺满。`mix(vec4, vec3, float)` 选 `mix(vec3, vec3, float)`，代价 8，结果 `vec3`；`texture(sampler2D, vec4)` 选 `(sampler2D, vec2)`，代价 16。
- **同代价**原型取先出现的。正式实现应报二义，或照 fxc 的规则选，待实测。
- 用户函数与内置函数在同一张重载表里，第二遍一视同仁。我们的 `kb_min` / `kb_max` / `kb_pow` 也参与：`min(vec4, vec3)` 会选到 `kb_min(vec3, vec3)`。

### 2.3 原型实测

原型补丁 +200 / −14 行，分布：`context.rs` +104 / −8、`functions.rs` +68、`parser/functions.rs` +17 / −5、`mod.rs` +7、`parser/declarations.rs` +3、`variables.rs` +1 / −1。

**失败语料**：用翻译器拿到改写后的 GLSL，再喂原型 naga，默认 COMBO。

| 着色器 | 现在的首个错误 | 原型 |
|---|---|---|
| `pixelate`、`gaussian` ×2、`iris_follow_cursor`（顶点） | 混算宽度不同 | 通过 |
| `cutout_vignette`、`sharpen_filter`、`lens_flare_sun`、`caustics`、`lens_distorsion`、`rounded_mask`（`int x = float`）、`Simple_Audio_Bars` 旧版 ×4 | 赋值 / 初始化宽度或类型不符 | 通过 |
| `hue_shift` ×2、`procedural_noise`、`shimmer`（WPE 自带 + 工坊） | `Unknown function 'mix' / 'rotateVec2'` | 通过 |
| `chromatic_aberration`、`clipping_mask`、`fxaa` | `Unknown function 'texture'` | 通过 |
| `frame_builder_by_gariam` | `?:` 浮点条件 | 通过 |
| `geometric_transform`、`auto_sway` | 片元写 varying | 通过 |
| `video` | 标量取下标 | 仍失败（原型未做） |
| `audio` | `DefineRedefined`（源码损坏） | 仍失败（不属于 naga） |

**WPE 安装目录语料**（167 对，默认 COMBO，只绑 `g_Texture0`）：

| 组合 | 通过 | 与上游 naga 比 |
|---|---|---|
| 上游 naga 30.0.1 | 158 | — |
| 原型，开关关闭 | 158 | 167 个文件（GLSL + WGSL 或错误摘要）**逐字节相同** |
| 原型，开关打开 | 160 | 原来通过的 158 对逐字节相同；多过 `assets/effects/shimmer`（`rotateVec2`）、`assets/shaders/editorpaintbrush`（`texelSize` 初始化宽度不符） |

规则样例的 WGSL 输出也逐条看过：`vec2 a = v4` → `_e4.xy`；`float f = v4` → `_e7.x`；`int i = f * 3.0` → `i32(...)`；`rot(v4, f)` → `rot(_e23.xy, …)`；`mix(v4, v3, f)` → `mix(_e27.xyz, _e28, vec3(_e29))`；`texture(…, v4)` → `textureSample(t, s, _e34.xy)`；`if (f)` → `if (_e43 != 0f)`；`!f && i` → `!(f != 0f) && (i != 0i)`；片元写 `v_TexCoord.y += 1.0` 写的是 Private 全局的副本。

估算正式实现：原型 200 行，加矩阵、bool 来源、标量取下标、二义报错、注释，约 **300–350 行**；每条规则正反两例的单测另计约 150 行（放 `parser_tests.rs` 旁边）。

---

## 3. `fluidsimulation_advection` 的错误

**定位**：`Expression not visited by the appropriate statement` 是 `valid/function.rs:1937` 的 `FunctionError::UnvisitedExpression`。校验器把每个 `CallResult` / `AtomicResult` 记进 `needs_visit`（`:1902`），只有对应的 `Call` / `Atomic` 语句才把它划掉。

**成因**（`effects/fluidsimulation_advection.frag:64`，`RENDERING` 为 1 或 2 时出错，0 或 3 时通过）：

```glsl
vec4 AddEmitterColor(vec2 texCoord, float amt, vec4 currentColor, vec3 emitterColor)
{
#if RENDERING == 2
	vec4 prevColor = texSample2D(g_Texture2, texCoord);
	return mix(currentColor, prevColor, amt);
#endif
	...
	return min(currentColor + CAST4(amt), CAST4(1.0));   // ← return 之后的死代码
}
```

1. 我们的改写在 `rewrite.rs:782` 加了 `#define min kb_min`，死代码里的 `min(...)` 因此变成用户函数调用：前端生成 `CallResult` 表达式与 `Statement::Call`。
2. 前端在终结语句（`return` / `break` / `continue` / `discard`）之后**直接裁掉语句**：

```rust
// parser/functions.rs:611（复合语句）；另两处 :281（switch case）、:418（do-while）同理
if let Some(idx) = *terminator {
    ctx.body.cull(idx..)            // 现状：语句裁掉了，CallResult 表达式还留在 arena 里
}
```

3. 校验器遍历 arena 时看到这个 `CallResult`，却没有任何语句访问它，于是报错。

所以这是 **naga GLSL 前端的缺陷，由我们的改写触发**。不改写时内置的 `min` 是普通表达式，不在 `needs_visit` 里，死代码不报错。

**最小复现**（上游 naga 30.0.1，`glsl-in` → 校验）：

```glsl
#version 450
layout(location = 0) out vec4 o;
float f(float a) { return a * 2.0; }
float g(float x) {
    return x;
    return f(x);          // 死代码里的用户函数调用 → UnvisitedExpression
}
void main() { o = vec4(g(1.0)); }
```

另外三种变体也复现：`if (…) { return x; f(x); }`、循环里 `break; s += f(1.0);`。把 `f(x)` 换成内置的 `min(x, 1.0)` 就通过。

**修法 A（推荐，前端补丁，+43 / −4，已验证）**：三处 `cull` 换成一个助手。裁剪之前，把被裁语句里（递归进 `Block` / `If` / `Loop` / `Switch`）`Call` / `Atomic` 的结果表达式改写成同类型的 `ZeroValue`：

```rust
// context.rs 新增
pub fn cull_dead(&mut self, idx: usize, meta: Span) -> Result<()> {
    let mut results = Vec::new();
    for stmt in self.body.iter().skip(idx) {
        collect_stmt(stmt, &mut results);   // Call { result: Some(r) } / Atomic { result: Some(r) }，递归子块
    }
    for r in results {
        let ty = self.resolve_type_handle(r, meta)?;
        *self.expressions.get_mut(r) = Expression::ZeroValue(ty);   // 不再是 CallResult，校验器不追
    }
    self.body.cull(idx..);
    Ok(())
}
// parser/functions.rs :281 / :418 / :611 的 `ctx.body.cull(idx..)` 改成 `ctx.cull_dead(idx, meta)?`
```

- 被裁掉的表达式没有任何活语句引用，后端不输出，所以 WGSL 不受影响。
- 只有带死调用的模块会走到改写，这类模块现在一定校验失败，所以不影响逐字节基线（上节「开关关闭」一行已包含这个补丁）。
- 实测：4 个复现、advection 在 `RENDERING=1/2`、`DYE=1` 组合下全部通过。
- 这个补丁和 HLSL 开关无关，直接生效。

**修法 B（不改 naga）**：`naga_stage.rs` 在校验报 `UnvisitedExpression` 时，`naga::compact::compact(&mut module, KeepUnused::Yes)` 后重验，实测同样通过。只在失败时重试，也不影响基线。但 compact 会给表达式重新编号，`_eN` 命名和修法 A 的输出不同；既然要嵌入 naga，用 A 更直接。

P7d 总计划里推断的「naga 前端的缺陷」成立，但修法很小，**可以放在 P7a 嵌入时的第一个补丁**，不必等 P7c。流体 effect 本身（`conditions`、`functions`、RT 跨帧）仍是 P7d 的事。

---

## 4. 裁剪清单

### 4.1 模块与体积（行数，含注释与内联测试）

| 模块 | 行数 | 处置 | 依据 |
|---|---|---|---|
| `back/spv` | 17 224 | 删 | 只给 `spv-out` |
| `back/hlsl` | 11 171 | 删 | |
| `back/msl` | 10 987 | 删 | |
| `back/glsl` | 6 585 | 删 | |
| `back/dot` | 897 | 删 | |
| `back/pipeline_constants.rs` | 1 217 | 删 | `#[cfg(any(hlsl_out, msl_out, spv_out, glsl_out))]` |
| `back/continue_forward.rs` | 313 | 删 | `#[cfg(any(hlsl_out, glsl_out))]` |
| `front/spv` | 8 480 | 删 | |
| `front/atomic_upgrade.rs` | 273 | 删 | 只给 `spv-in` |
| `back/wgsl` + `back/mod.rs` | 2 348 + 398 | 留 | WGSL 后端 |
| `front/glsl` | 11 814 | 留 | 我们改的就是它 |
| `front/wgsl` | 15 203 | 留（只在测试里用） | `lib.rs` 的 `#[cfg(test)]` 与 `tests/corpus.rs` 用 `parse_str` 回读 |
| `front/mod.rs`、`type_gen.rs`、`interpolator.rs` | 380 + 620 + 54 | 留 | `Typifier`、`SymbolTable`、类型生成，GLSL / WGSL 前端共用 |
| `proc` | 11 168 | **整个留** | GLSL 前端用 `ConstantEvaluator`、`Layouter`、`Emitter`、`ensure_block_returns`、`Typifier`；WGSL 后端用 `Namer` / `KeywordSet`；校验用 `index` / `overloads`；`mod.rs` 里互相 re-export，按文件拆不划算 |
| `valid` | 10 156 | 留 | |
| `ir`、`arena`、`span.rs`、`error.rs`、`diagnostic_filter.rs`、`non_max_u32.rs` | 2 974 + 1 105 + 524 + 196 + 274 + 126 | 留 | |
| `common`（含 `common/wgsl`） | 1 265 | 留 | `proc/constant_evaluator.rs`、`proc/overloads/rule.rs` 用 `common::wgsl` 打印类型名，不只给 WGSL 前后端 |
| `keywords`（只剩 `wgsl.rs`）+ `racy_lock.rs` | 461 + 61 | 留 | WGSL 后端与前端的保留字；`racy_lock` 给关键字集合用 |
| `compact` | 2 605 | 留 | WGSL 前端在 lower 末尾调 `compact`；修法 B 也用它 |

- 上游 `src/` 共 119 023 行，删掉 57 147 行，**剩约 61 900 行**。
- 如果连 WGSL 前端也不要（测试回读改用别的办法），还能再删 `front/wgsl` + `compact`，剩约 44 000 行；但测试回读要另找替代，不建议。

### 4.2 删除后要跟着改的 cfg 引用（保留代码里）

```text
back/mod.rs:5–30, 52, 70, 117   各后端的 #[cfg(..._out)] 模块声明与 allow(dead_code) 条件
error.rs:30, 80                 feature = "spv-in"
front/mod.rs:5, 9, 13           interpolator / atomic_upgrade / spv 的 cfg
lib.rs:11–12                    文档测试的 cfg_attr（feature = "glsl-out"）
proc/index.rs:346               cfg_attr(not(feature = "msl-out"), allow(dead_code))
proc/mod.rs:508–512             cfg_attr 列表里的 spv-in / glsl_out / hlsl_out / msl_out
```

- 处理办法：`Cargo.toml` 删掉这些 feature 之后，`cargo check` 的 `unexpected_cfgs` 警告会把漏掉的地方都点出来。
- `build.rs` 的 `cfg_aliases` 可以只留 `wgsl_out` / `std` / `no_std`。
- 删掉后端后，一些只给后端用的 `proc` 助手会变成死代码、出 `dead_code` 警告。这些只是警告，不影响产物；要清的话在相应位置加 `allow`，并记进说明。

### 4.3 feature 与依赖

| 项 | 处置 |
|---|---|
| `glsl-in`（`pp-rs`）、`wgsl-out` | 留 |
| `wgsl-in`（`unicode-ident`） | 留，但翻译器只在 `[dev-dependencies]` 里开（`naga = { path = "naga", features = ["wgsl-in"] }`）；根 `Cargo.toml` 是 `resolver = "2"`，dev 依赖的 feature 不进 wasm 构建 |
| `spv-in`（`petgraph`、`spirv`）、`spv-out`、`msl-out*`、`hlsl-out*`、`glsl-out`、`dot-out`、`fs` | 删 |
| `serialize` / `deserialize` / `arbitrary` | **feature 声明留着**：源码里有 318 处 `cfg_attr(feature = "serialize", …)` 等，删了声明会出一片 `unexpected_cfgs`；不开就不编译 `serde` / `arbitrary` |
| `stderr` / `termcolor` | 留声明（`emit_to_stderr` 的 cfg），不开 |
| 必需依赖 `arrayvec`、`bit-set`、`bitflags`、`cfg-if`、`codespan-reporting`、`half`、`hashbrown`、`indexmap`、`libm`、`log`、`num-traits`、`once_cell`、`rustc-hash`、`thiserror` | 留；`codespan-reporting` 给 `emit_to_string`，`libm` / `half` 给常量求值，`once_cell` 给 `racy_lock` |
| dev 依赖 | 只留 `diff`、`strum`（`front/wgsl` 的内联测试用）；`bytemuck`、`env_logger`、`itertools`、`ron`、`rspirv`、`spirv`、`walkdir`、`hlsl-snapshots`、`naga-test` 删掉。嵌进来的 naga 会成为工作区的隐式成员，dev 依赖会进 `Cargo.lock` |

**interpolator**（`front/mod.rs:5`）：

```rust
#[cfg(any(feature = "spv-in", feature = "wgsl-in"))]   // 上游漏了 glsl-in
pub(crate) mod interpolator;
```

- `front/glsl/variables.rs:467` 调 `binding.apply_default_interpolation(…)`，这个方法定义在 `interpolator.rs`。只开 `glsl-in` 时模块不编译，就报错了。
- 修法：cfg 里加 `feature = "glsl-in"`。已验证只开 `glsl-in` + `wgsl-out` 能编过。

**`naga-types`**（`naga-types-30.0.1`，642 行）：
- 用途：`FastHashMap` / `FastHashSet` / `FastIndexMap` / `FastIndexSet`（`lib.rs:132` 重导出），`TaskDispatchLimits`（`back/mod.rs`），以及各后端的选项类型（`glsl.rs` 233 行，其余各 1–12 行）。
- 依赖：`hashbrown`、`indexmap`、`rustc-hash`、`thiserror`。`Cargo.lock` 里只有 naga 用它。
- 建议：**继续从 crates.io 取，钉 `=30.0.1`**。我们不需要改它，而且它很小；嵌进来只会多一份要同步的东西。

**体积**：
- 这些模块原本就被 feature 门控掉了，wasm 又开了 LTO，删源码大概率不改变 wasm 大小。当前产物 1 606 373 字节。
- 把 `wgsl-in` 挪到 dev 依赖后，wasm 也应当不变（`parse_str` 本来就只在测试里调用，LTO 会剔除）。
- P7a 照计划实测前后大小。

### 4.4 嵌入时的其它注意

- 用注册表里的 `Cargo.toml`（已规范化、没有工作区继承）做底本，`Cargo.toml.orig` 用了 `version.workspace = true` 等，不能直接用。补上 `publish = false`。
- 原样拷字节，保持 LF（仓库约定）。注意：在 Windows 上用 Python `write_text` 改文件会写成 CRLF，原型里就踩到了。
- 路径依赖落在工作区目录下，会自动成为**隐式工作区成员**：
  - `cargo check / test --workspace` 会带上它，它的内联测试（`front/glsl/parser_tests.rs`、`front/wgsl/tests.rs` 等）会跑。
  - 「默认关闭时 naga 自带的 GLSL 测试照旧通过」可以直接用 `cargo test -p naga` 验。
  - 不想让工作区命令带上它，就在根 `Cargo.toml` 的 `exclude` 里写明。是否这样做待定。
- 上游的快照测试（`naga/tests/in/glsl/*`）不在 crates.io 包里（`exclude = ["tests/**/*"]`）。要用的话得从 wgpu 仓库对应 tag 取，放 `ignore/` 下按需跑。

---

## 5. 许可证

- naga 是 `license = "MIT OR Apache-2.0"`，包根有 `LICENSE.MIT`（`Copyright (c) 2025 The gfx-rs developers`）和 `LICENSE.APACHE`，没有 `NOTICE` 文件。
- 嵌入时：
  - 两个许可证文件原样放进 `src-tauri/wpesl2wgsl/naga/`，嵌入的 `Cargo.toml` 保留 `license` 与 `authors`；
  - 选 MIT 时只需保留版权与许可声明；若按 Apache 2.0（§4(b)）还要求改过的文件带显著的修改声明。稳妥做法是两者都满足：每个改过的文件顶部加一行「kabegame 修改，见 naga/KABEGAME.md」，说明文件里逐处列出补丁；
  - `README.md` / `CHANGELOG.md` 可留可删，不影响许可。
- wasm 随应用分发，MIT 要求「所有副本或实质部分」带上声明。应用有没有第三方许可汇总页、要不要把 naga 加进去，不在本次读码范围（见「仍未知」）。

---

## 仍未知

1. **fxc 的确切语义**（另一条线实测）：截断取前几分量、警告还是错误；混算截到窄的一边；向量条件；`float → int` 与浮点下标的取整方式和负数；**标量取下标是否合法**（决定 `video` 归「类型类」还是「WPE 也编不过」）；内置函数实参宽度不一时的维度选择与同代价时的规则；`bool` 参与算术。
2. 二义性：第二遍同代价时报错还是照 fxc 选，要等 1 的结论。
3. 失败语料只看了**默认 COMBO** 和**每个着色器的第一个错误**。原型修掉第一个错误后，其它 COMBO 组合下会不会露出新的错误，要等 P7a 的完整夹具。
4. 全局 `const` 初始化在 HLSL 模式下加的 Splat / Swizzle 能否被常量求值器折叠，原型只测了局部初始化。
5. 上游 wgpu 主干是否已修 interpolator 的 cfg 与死代码 `CallResult`（升级时可以少一个补丁）。没查。
6. 应用有没有第三方许可声明的汇总位置。
7. `Tint` 对 HLSL 模式新产出的写法（如 `i32(f)`、`x != 0f`）的接受度，按 P7a 的方法在 dev app 里跑一遍。

## 建议的改动顺序

1. **P7a 嵌入**（不改行为）：
   - 拷源码、删模块与 feature；
   - 修 interpolator 的 cfg；
   - 翻译器改成 `glsl-in` + `wgsl-out`，dev 依赖开 `wgsl-in`；
   - 补许可证与说明文件。

   验收是逐字节基线与 `cargo test -p naga`。
2. **P7a 第一个补丁：死代码 `CallResult`**（第 3 节修法 A）。
   - 只影响现在失败的模块，基线不变；
   - 流体着色器的翻译这样就先通了，P7d 只剩 effect 字段。
3. **P7c 选项骨架**：`Options.hlsl_implicit` → `Frontend.hlsl` → `Context.hlsl` / `return_ty`，加上两个助手。开关关闭时逐字节验证。
4. **按规则逐条加**，每条带正反两例单测，每加一条跑一次「开关打开、已通过语料逐字节不变」：
   1. 赋值 / 初始化 / 返回；
   2. 二元混算；
   3. 条件；
   4. 实参第二遍（用户函数与内置函数一起）；
   5. float → int 与浮点下标；
   6. 矩阵、bool 来源。

   **标量取下标**等 fxc 结论再定。
5. **片元写 varying**：HLSL 模式下一行（`mutable: !input || self.hlsl`）就能解决，原型验证过，且不影响逐字节基线。P7b 原计划用改写阶段的「私有副本」处理它，并和「两阶段 varying 宽度不同」共用机制。两条路选哪条，需要你定：
   - 宽度不同那一半仍要在改写阶段做，因为它是两个阶段之间的接口问题；
   - 只有「写」这一半可以交给 naga。
6. **README 与清理**：`kb_gs_as_*`、`kb_min` 等「标量扩展」包装在 HLSL 模式下已多余。但去掉它们会改变已通过着色器的输出，所以不在 P7 内动，记作以后的清理项。
