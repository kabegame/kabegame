# Kabegame 核心： PathQL 模块测试报告

课程：工程概论  
项目名称：Kabegame / PathQL  
测试对象：`src-tauri/pathql-rs`  
测试日期：2026 年 5 月  
姓名 / 学号：按课程要求补充

## 一、测试概述

本测试报告的对象是 Kabegame 项目中的 PathQL 模块。PathQL 是一个用于 Provider 路由和查询组合的路径折叠查询 DSL 引擎，位于 `src-tauri/pathql-rs`。它主要负责将 provider DSL 文件、运行时路径、动态参数和查询片段组合为结构化的 `ProviderQuery`，再渲染为 SQL 和绑定参数，最后由宿主程序执行。

PathQL 在 Kabegame 中属于底层核心模块。画廊、虚拟磁盘、过滤、排序、分页等功能都可能依赖它完成路径解析和查询构建。因此，该模块的正确性会直接影响图片列表展示、画册访问、虚拟目录浏览和插件相关数据查询。

本次测试以自动化 Rust 测试为主，重点验证 PathQL 的 AST 解析、JSON5 加载、Provider 注册、路径解析、查询折叠、模板求值、SQL 渲染、语义校验和 SQLite 端到端执行能力。

## 二、测试目标

本次测试的主要目标如下：

1. 验证 PathQL 的基础数据结构和 DSL 反序列化逻辑是否正确。
2. 验证 provider 注册、命名空间查找和路径解析行为是否符合设计要求。
3. 验证查询片段在多级 provider 链中能否被稳定折叠。
4. 验证模板变量、捕获参数、属性、全局变量和引用的求值行为是否正确。
5. 验证 SQL 渲染结果是否符合 SQLite、MySQL 和 PostgreSQL 的占位符规则。
6. 验证真实 provider DSL 文件能够被加载和校验。
7. 验证异常输入能够被正确拒绝，而不是产生错误 SQL 或污染运行时缓存。
8. 验证基于内存 SQLite 的端到端流程能够正常执行。

## 三、测试环境

| 项目 | 内容 |
|---|---|
| 操作系统 | macOS 15.7.1 |
| 系统内核 | Darwin 24.6.0 arm64 |
| Rust 版本 | rustc 1.93.0 |
| Cargo 版本 | cargo 1.93.0 |
| 项目路径 | `/Volumes/KIOXIA/kabegame` |
| 测试模块 | `src-tauri/pathql-rs` |
| 主要测试命令 | `cargo test -p pathql-rs --all-features` |
| 辅助测试命令 | `cargo test -p pathql-rs` |

## 四、测试范围

| 测试范围 | 说明 |
|---|---|
| AST 数据结构 | 测试表达式、调用、列表、名称、排序、属性、查询和 resolve 配置的解析与反序列化。 |
| JSON5 加载器 | 测试 provider DSL 文件的 JSON5 读取，包括注释、尾逗号、单引号、未加引号字段和错误输入。 |
| ProviderRegistry | 测试 provider 注册、重复注册、命名空间查找、默认属性填充和程序化 provider 注册。 |
| ProviderRuntime | 测试路径解析、列表展开、元数据读取、缓存、schema 注册和错误路径处理。 |
| 查询折叠 | 测试字段、JOIN、WHERE、ORDER BY、LIMIT、OFFSET 等查询片段的组合规则。 |
| 模板解析与求值 | 测试 `${properties.X}`、`${capture[N]}`、`${global.X}`、`${data_var.X}` 等模板变量。 |
| SQL 渲染 | 测试最终 SQL 生成、绑定参数顺序和不同数据库方言占位符。 |
| 语义校验 | 测试名称、命名空间、SQL 片段、动态变量、正则、引用、循环和元数据模板。 |
| 真实 DSL 集成 | 测试仓库中的真实 provider DSL 能否加载、折叠、校验并构建 SQL。 |
| SQLite 端到端 | 测试路径解析到 SQL 构建，再到内存 SQLite 执行的完整流程。 |

不在本次测试范围内的内容包括：完整 Kabegame 图形界面测试、真实用户媒体库压力测试、真实 MySQL/PostgreSQL 数据库执行测试、移动端 UI 测试和插件网络爬取测试。

## 五、测试方法

本次测试采用以下方法：

1. 单元测试：对 AST、模板、校验器、注册表和运行时内部函数进行细粒度验证。
2. 集成测试：加载真实 provider DSL，验证跨模块组合是否符合预期。
3. 端到端测试：通过内存 SQLite 构造测试数据，验证路径解析、SQL 构建和查询执行结果。
4. 异常测试：构造非法名称、非法 SQL、多语句 SQL、DDL、错误正则、越界捕获参数等输入，确认系统能够拒绝。
5. 回归测试：通过固定测试用例保证已有路径解析、缓存、排序、分页和 delegate 行为不被后续修改破坏。
6. Feature 测试：分别运行默认特性和 `--all-features`，确认 feature-gated 的 JSON5 与 validate 测试也能通过。

## 六、测试用例与结果

### 6.1 代表性测试用例

| 用例编号 | 测试模块 | 测试内容 | 测试步骤 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|---|
| TC01 | AST | Provider 名称解析 | 解析简单名称、绝对名称和命名空间名称 | 名称结构正确，非法名称被拒绝 | 与预期一致 | 通过 |
| TC02 | AST | Query 配置解析 | 解析 fields、joins、where、order、limit、offset | 配置被正确反序列化 | 与预期一致 | 通过 |
| TC03 | JSON5 Loader | 加载最小 provider 文件 | 使用 JSON5 loader 读取最小 provider 定义 | 成功生成 `ProviderDef` | 与预期一致 | 通过 |
| TC04 | JSON5 Loader | 加载带注释和尾逗号的 JSON5 | 构造包含注释、单引号、尾逗号的 DSL | loader 能够兼容 JSON5 语法 | 与预期一致 | 通过 |
| TC05 | Registry | 注册 provider | 注册 DSL provider 和程序化 provider | 注册成功，可通过命名空间查找 | 与预期一致 | 通过 |
| TC06 | Registry | 重复注册检测 | 注册同名 provider | 返回重复注册错误 | 与预期一致 | 通过 |
| TC07 | Runtime | 路径解析 | 解析 `test://albums/A` 一类路径 | 返回解析后的 provider chain 和 composed query | 与预期一致 | 通过 |
| TC08 | Runtime | 错误路径处理 | 解析不存在的路径 | 返回 `PathNotFound`，不污染缓存 | 与预期一致 | 通过 |
| TC09 | Runtime | 最长前缀缓存 | 连续解析相邻路径 | 复用已解析前缀，只新增必要缓存 | 与预期一致 | 通过 |
| TC10 | Query Fold | WHERE 条件叠加 | 多个 provider 依次贡献 WHERE 条件 | 条件按 AND 语义组合 | 与预期一致 | 通过 |
| TC11 | Query Fold | ORDER BY 覆盖与反转 | 叠加不同排序规则 | 排序结果符合覆盖、prepend、revert 规则 | 与预期一致 | 通过 |
| TC12 | SQL Render | SQLite 占位符 | 渲染带模板参数的 SQL | 使用 `?` 占位符，参数顺序正确 | 与预期一致 | 通过 |
| TC13 | SQL Render | PostgreSQL 占位符 | 渲染 PostgreSQL 方言 SQL | 使用 `$1`、`$2` 等占位符 | 与预期一致 | 通过 |
| TC14 | Validate | 非法 SQL 拒绝 | 输入多语句 SQL 或 DDL | 校验器返回错误 | 与预期一致 | 通过 |
| TC15 | Validate | 正则和 capture 检查 | 输入非法正则或越界 capture | 校验器返回错误 | 与预期一致 | 通过 |
| TC16 | Real DSL | 加载真实 provider | 递归加载仓库真实 provider DSL | 所有真实 provider 可加载 | 与预期一致 | 通过 |
| TC17 | Real DSL | 严格交叉引用校验 | 对真实 provider 启用 cross-ref 检查 | 校验通过，无未解析引用 | 与预期一致 | 通过 |
| TC18 | SQLite E2E | 查询画册 A | 构造内存 SQLite 并解析 `test://albums/A` | 返回图片 ID 1、2、3 | 与预期一致 | 通过 |
| TC19 | SQLite E2E | 查询画册 B | 构造内存 SQLite 并解析 `test://albums/B` | 返回图片 ID 4、5 | 与预期一致 | 通过 |
| TC20 | Typed Meta | 元数据传递 | 测试 parent list child meta 和模板求值 | 元数据类型被保留并正确返回 | 与预期一致 | 通过 |

### 6.2 自动化测试执行结果

执行默认特性测试：

```bash
cargo test -p pathql-rs
```

结果：测试通过。默认特性下共执行 361 个有效测试用例，全部通过。

执行完整特性测试：

```bash
cargo test -p pathql-rs --all-features
```

结果：测试通过。完整特性下共执行 488 个有效测试用例，全部通过。

完整特性测试统计如下：

| 测试类别 | 数量 | 结果 |
|---|---:|---|
| 单元测试 | 428 | 全部通过 |
| 集成测试 | 60 | 全部通过 |
| 文档测试 | 0 | 无文档测试 |
| 失败测试 | 0 | 无失败 |
| 忽略测试 | 0 | 无忽略 |

主要集成测试文件结果如下：

| 测试文件 | 用例数 | 结果 |
|---|---:|---|
| `build_real_chain.rs` | 3 | 通过 |
| `dsl_dynamic_sqlite.rs` | 9 | 通过 |
| `dsl_full_chain_sqlite.rs` | 6 | 通过 |
| `dsl_typed_meta_wire.rs` | 4 | 通过 |
| `fold_real_chain.rs` | 3 | 通过 |
| `load_real_providers.rs` | 7 | 通过 |
| `programmatic_runtime.rs` | 5 | 通过 |
| `runtime_real_sqlite.rs` | 5 | 通过 |
| `validate_bad_fixtures.rs` | 16 | 通过 |
| `validate_real.rs` | 2 | 通过 |

## 七、缺陷与问题分析

本次测试未发现失败用例，自动化测试结果为全部通过。根据测试结果，PathQL 当前在以下方面表现稳定：

1. DSL 基础结构解析稳定，非法字段和非法结构能够被拒绝。
2. Provider 注册、查找、命名空间回退和程序化 provider 共存逻辑正常。
3. 路径解析与缓存行为符合预期，错误路径不会污染缓存。
4. 查询折叠规则清晰，字段、JOIN、WHERE、ORDER BY 和分页组合结果可预测。
5. 模板变量能够被正确解析，调用者输入通过绑定参数进入 SQL，降低 SQL 注入风险。
6. 真实 provider DSL 能够通过加载和严格交叉引用校验。
7. 内存 SQLite 端到端流程能够正确返回预期数据。

但测试中也暴露出一些需要注意的测试覆盖边界：

| 编号 | 问题或不足 | 严重程度 | 说明 | 建议 |
|---|---|---|---|---|
| P01 | 默认测试不覆盖全部 feature | 中 | 默认 `cargo test -p pathql-rs` 中部分 JSON5 和 validate 集成测试不会运行 | CI 中应加入 `--all-features` 测试 |
| P02 | 缺少真实大规模数据压力测试 | 中 | 当前 SQLite 测试数据量较小，不能完全反映大图库场景 | 增加上万级图片、画册和路径的性能测试 |
| P03 | PostgreSQL/MySQL 只验证渲染，未连接真实数据库执行 | 低 | 目前主要验证占位符格式和 SQL 字符串 | 如未来支持多数据库执行，可增加真实数据库集成测试 |
| P04 | 缺少 fuzz 测试 | 低 | 模板解析、路径解析和 JSON5 输入可能存在未知边界 | 后续可对 parser 和 template 增加随机输入测试 |
| P05 | 与 Kabegame GUI 的联动测试不在本报告范围内 | 中 | PathQL 通过后不代表前端画廊路径拼装完全正确 | 应增加核心模块与前端路径生成逻辑的联动测试 |

## 八、风险与改进建议

### 8.1 主要风险

1. 查询语义回归风险：PathQL 是底层查询组合模块，一旦折叠规则变化，可能影响画廊、虚拟磁盘和过滤功能。
2. DSL 文件质量风险：provider DSL 由多个文件组成，如果缺少严格校验，可能在运行时才暴露错误。
3. 安全风险：如果调用者输入没有通过绑定参数进入 SQL，可能带来 SQL 注入风险。
4. 性能风险：真实图库规模较大时，路径解析、缓存和 SQL 查询性能可能成为瓶颈。
5. Feature 测试遗漏风险：如果只运行默认测试，可能遗漏 JSON5 加载和语义校验相关问题。

### 8.2 改进建议

1. 在 CI 中固定执行 `cargo test -p pathql-rs --all-features`。
2. 增加性能基准测试，重点覆盖长路径解析、大量 provider 注册和大规模图库 SQL 查询。
3. 增加真实 Kabegame provider 路径样例测试，例如画册、插件、日期、媒体类型和壁纸历史路径。
4. 对模板解析和路径解析增加 fuzz 或 property-based testing。
5. 将 PathQL 测试与 Kabegame 核心媒体库测试结合，验证 SQL 执行结果是否符合真实业务语义。
6. 为重要设计规则补充文档测试或示例测试，避免文档与实现脱节。

## 九、测试结论

通过本次测试，PathQL 模块在默认特性和完整特性下均通过自动化测试。完整特性测试共执行 488 个有效测试用例，其中单元测试 428 个、集成测试 60 个，失败数为 0。测试覆盖了 AST、JSON5 加载、ProviderRegistry、ProviderRuntime、查询折叠、模板求值、SQL 渲染、语义校验、真实 DSL 加载和 SQLite 端到端执行等关键功能。

综合测试结果可以判断，PathQL 当前基本满足 Kabegame 对 provider 路由、查询组合和 SQL 构建的核心需求，具备继续作为底层查询引擎使用的稳定性。后续工作应重点加强大规模数据性能测试、GUI 联动测试、多数据库执行验证和 CI 中的完整 feature 覆盖，以进一步降低后续迭代带来的回归风险。
