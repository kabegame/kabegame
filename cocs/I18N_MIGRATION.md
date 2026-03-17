# i18n 迁移指南（参考 Clash Verge Rev）

本文档描述将 **Clash Verge Rev (CVR)** 的 i18n 方案迁移到 **Kabegame** 所需的框架搭建、细节迁移步骤，以及今后维护与使用方式的大框架。**不包含 .kgpg 爬虫插件内的 i18n**（插件多语言另行规划）。

参考实现：工作区内的 `clash-verge-rev-dev`。CVR 采用「前端 i18next + 后端 rust-i18n」双轨、运行时动态切换、前后端翻译文件分离维护。

---

## 1. 架构总览（目标状态）

| 层级 | 技术选型 | 翻译文件位置 | 用途 |
|------|----------|--------------|------|
| 前端 (Vue) | vue-i18n | 应用内 `locales/<lang>/`（JSON 或 TS 聚合） | 主界面、设置、弹窗等 |
| 后端 (Rust) | rust-i18n | 独立 crate `kabegame-i18n/locales/<lang>.yml` | 托盘菜单、系统通知、原生对话框等 |

- **动态切换**：用户切换语言后，前端立即 `locale` 切换，后端通过配置持久化 + `set_locale` 同步，**无需重启应用**。
- **前后端翻译独立**：前端 JSON 与后端 YAML 分开维护，需通过流程或脚本保持 key 一致（可选工具：format/check 脚本）。

---

## 2. 框架搭建

### 2.1 前端（Vue 3）

- **依赖**：`vue-i18n`（Vue 3 兼容版本，如 `^10` 或 `^11`）。
- **入口**：在 `apps/main`（或实际前端入口）的 `main.ts` 中创建 `createI18n` 实例，并 `app.use(i18n)`。
- **结构**：
  - 前端 i18n 统一放在 `apps/main/src/i18n/` 下，locales 置于 `i18n/locales/<lang>/`。
  - 按命名空间拆分：如 `common.json`、`settings.json`、`gallery.json` 等，与 CVR 的 `home`/`settings`/`shared` 思路一致。
  - 每个语言一个目录：`i18n/locales/zh/`、`i18n/locales/en/` 等，其下各命名空间 JSON + 一个 `index.ts` 聚合导出。
- **懒加载（可选）**：与 CVR 一致，可采用 `import.meta.glob('@/locales/*/index.ts')` 按需加载语言包，并在 `locale` 切换时再加载对应 bundle。
- **默认语言与持久化**：从「应用配置」读取当前语言（若后端提供），否则使用 `navigator.language` 或固定默认（如 `en`）；切换后写回配置并调用后端保存（见 3.2）。

### 2.2 后端（Rust / Tauri）

- **新建 crate**：在仓库中新增 `kabegame-i18n`，位于 `src-tauri/kabegame-i18n/`（与 CVR 的 `clash-verge-i18n` 对应）。
- **依赖**：`rust-i18n = "3.x"`（与 CVR 一致便于对照），可选 `sys-locale` 用于系统语言检测。
- **宏与入口**：在 crate 的 `lib.rs` 中：
  - 使用 `rust_i18n::i18n!("locales", fallback = "en");`
  - 提供 `set_locale(lang)`、`sync_locale(Option<&str>)`（从配置恢复）、`system_language()`、以及封装好的 `t!(key)` 或 `translate(key)`，与 CVR 的 `clash-verge-i18n` 一致。
- **YAML 放置**：`kabegame-i18n/locales/zh.yml`、`en.yml` 等；内容按模块分块（如 `tray:`、`notifications:`、`dialog:`），与 CVR 的 `clash-verge-i18n/locales/*.yml` 结构可对齐便于迁移。
- **app-main 依赖**：在 `src-tauri/app-main/Cargo.toml` 中增加 `kabegame-i18n = { workspace = true }`（或 path 依赖），并在需要显示原生 UI 文案的地方调用 `kabegame_i18n::t!(...)` 或等价 API。

### 2.3 配置与同步

- **配置项**：在应用「全局配置」（`kabegame_core::settings::Settings`）中增加 `language: Option<String>`，与 CVR 的 verge 配置中的 `language` 一致。
- **前端 → 后端**：用户在前端切换语言时，除前端 `locale` 切换外，通过 `set_language` 命令写入 `language` 并持久化；`set_language` 内部会调用 `kabegame_i18n::sync_locale`。
- **后端处理**：后端在 `init_globals()` 中，`Settings::init_global()` 完成后立即从 `Settings::global().get_language()` 读取并调用 `kabegame_i18n::sync_locale(lang.as_deref())`；在 `set_language` 命令保存后调用 `sync_locale`，并刷新依赖语言的 UI（如托盘菜单 `update_menu()`）。

---

## 3. 细节迁移步骤（按顺序）

### 3.1 后端 i18n crate 与配置

1. 在 `src-tauri` 下新建 `kabegame-i18n` crate，`Cargo.toml` 中加入 `rust-i18n`、按需 `sys-locale`。
2. 在 crate 内创建 `locales` 目录，从 CVR 的 `crates/clash-verge-i18n/locales/` 复制或改写 `zh.yml`、`en.yml` 等；保留相同或相近的 key 结构（如 `tray:`、`notifications:`），删除与 Kabegame 无关的 key，并补充 Kabegame 专属文案。
3. 在 `lib.rs` 中实现与 CVR 对齐的 API：`i18n!`、`set_locale`、`sync_locale`、`system_language`、`t!`/`translate`，以及语言别名（如 `zh` → `zh`、`zh-tw` → `zhtw`）。
4. 在 workspace 的 `Cargo.toml` 的 `[workspace.members]` 中加入 `kabegame-i18n`。
5. 在 `kabegame_core::settings` 中增加 `SettingKey::Language` 及 `get_language`/`set_language`，在 app-main 的 `init_globals()` 中调用 `sync_locale`；在 `set_language` 命令中保存后调用 `sync_locale`，并刷新托盘/通知等。

### 3.2 前端 i18n 与配置联动

1. 在 `apps/main` 安装 `vue-i18n`，在入口中创建并挂载 i18n 实例；设定 `fallbackLocale`（如 `zh`）、`legacy: false`（Composition API 风格）。
2. 建立目录结构 `apps/main/src/i18n/locales/<lang>/`，每个语言下按命名空间拆分为多个 JSON（如 `common.json`、`settings.json`），再通过 `index.ts` 聚合为 `messages`。
3. 实现「当前语言」与后端配置同步：
   - 应用启动时：在 `App.vue` 中 `settingsStore.loadAll()` 后，从 `settingsStore.values.language` 读取，调用 `setLocale(resolveLanguage(...))` 恢复前端 locale。
   - 用户切换语言时：通过 `LanguageSetting` 组件调用 `settingsStore.save('language', value)`，保存后后端 `set_language` 会调用 `sync_locale`；同时 `setting-change` 事件会触发 `setLocale` 更新前端。
4. 将现有界面中的硬编码中文（或英文）替换为 `$t('namespace.key')` 或 `useI18n().t('namespace.key')`，优先从 CVR 前端 `src/locales/` 中对照命名空间与 key 迁移。

### 3.3 后端需翻译的调用点

1. **托盘菜单**：所有托盘项文案改为 `kabegame_i18n::t!("tray.xxx")`，在配置中 `language` 变更并执行 `set_locale` 后调用 `update_menu()` 刷新。
2. **系统通知 / 对话框**：凡面向用户的字符串，改为通过 `t!(...)` 获取，保证与当前 `locale` 一致。
3. **其他原生 UI**：若有错误提示、确认框等，统一走 i18n 的 key，避免硬编码。

### 3.4 工具脚本（可选但推荐）

1. **i18n:format**：对齐各语言 JSON/YAML 的 key 顺序、移除未使用 key、统一缩进等，可参考 CVR 的 `scripts/cleanup-unused-i18n.mjs` 思路，适配 Kabegame 的目录与命名空间。
2. **i18n:check**：扫描前端 `$t`/`useI18n().t` 与后端 `t!(...)` 的 key，与 JSON/YAML 中的 key 做差集，发现缺失或多余 key。
3. **i18n:types**（可选）：为前端生成 `i18n-keys.ts` 或类型定义，减少手写 key 的错误，参考 CVR 的 `scripts/generate-i18n-keys.mjs`。

以上脚本可放在项目根或 `apps/main` 的 `scripts/` 下，并在 `package.json` 中增加 `i18n:format`、`i18n:check`、`i18n:types` 等命令。

---

## 4. 今后维护与使用方式（大框架）

### 4.1 日常开发

- **新增/修改前端文案**：只改对应命名空间下的 JSON（如 `locales/zh/settings.json`），key 保持与英文等基准语言一致；若新增命名空间，需在各语言的 `index.ts` 中聚合。
- **新增/修改后端文案**：只改 `kabegame-i18n/locales/*.yml` 中对应模块；新增 key 时在所有语言 YAML 中补全（可先复制英文），避免运行时 fallback 到默认语种造成混语。
- **新增语言**：  
  - 前端：复制 `locales/en/`（或 zh）为 `locales/<new-lang>/`，翻译后在各语言列表与 `supportedLanguages` 中注册。  
  - 后端：复制 `en.yml` 为 `<new-lang>.yml` 并翻译，在 crate 的「支持语言」逻辑中加入新语种。

### 4.2 规范与约定

- **key 命名**：语义化（如 `gallery.emptyHint`、`settings.language`），避免 `item1`、`title2` 等无意义命名。
- **占位符**：统一用 `{{name}}` 形式，与 CVR 一致；组件传参时保证与 key 内占位符一致。
- **共享用语**：通用按钮、状态、错误信息等放在 `common` 或 `shared` 命名空间，避免重复定义。
- **前后端 key 对齐**：若同一概念在前端与后端都有展示（如「设置」），可约定命名一致（如都叫 `settings.title`），便于后续做 format/check 时跨端校验。

### 4.3 发布与贡献

- **PR**：涉及 UI 文案的 PR 建议同时改所有已支持语言的 JSON/YAML，或至少补全英文/中文，并在描述中说明哪些语言待母语者校对。
- **CI（可选）**：在 CI 中跑 `i18n:check`，确保没有缺失 key 或多余 key。
- **文档**：在 CONTRIBUTING 或 cocs 中说明「新增/修改文案去哪些文件、运行哪些命令」，指向本文档或精简版快速指南。

### 4.4 不在此文档范围内的内容

- **.kgpg 爬虫插件内的 i18n**：插件运行在独立上下文，多语言方案（若需要）单独设计与实现，不纳入本次迁移范围。

---

## 5. 涉及代码文件一览（迁移完成后预期）

| 层级 | 路径（示例） | 作用 |
|------|----------------|------|
| 前端入口 | `apps/main/src/main.ts` | 创建并挂载 vue-i18n |
| 前端 i18n | `apps/main/src/i18n/index.ts` | createI18n、resolveLanguage、setLocale |
| 前端 locales | `apps/main/src/i18n/locales/<lang>/*.json`、`index.ts` | 按命名空间的前端翻译 |
| 后端 i18n crate | `src-tauri/kabegame-i18n/` | `lib.rs`、`locales/*.yml` |
| 后端配置 | app-main 中读取/保存 `language` 的模块 | 启动时 `sync_locale`，配置变更时 `set_locale` |
| 后端托盘/通知 | app-main 中托盘菜单、通知、对话框 | 使用 `t!(...)` 输出文案 |
| 脚本 | `scripts/i18n-*.mjs` 或等价 | format、check、types |

实际路径以仓库最终结构为准；迁移时按上述角色对号入座即可。

---

## 6. 参考：CVR 关键实现位置

便于对照与抄写逻辑，下表列出 CVR 中与 i18n 直接相关的文件。

| 用途 | CVR 路径 |
|------|----------|
| 前端 i18n 初始化、切换、懒加载 | `src/services/i18n.ts` |
| 前端 useI18n 封装（含与 verge 配置同步） | `src/hooks/use-i18n.ts` |
| 前端语言列表与解析 | `src/services/i18n.ts`（supportedLanguages、resolveLanguage） |
| 前端 preload 取配置语言 | `src/services/preload.ts` |
| 后端 i18n crate | `crates/clash-verge-i18n/src/lib.rs` |
| 后端 YAML | `crates/clash-verge-i18n/locales/*.yml` |
| 配置中 language 变更 → set_locale + 托盘刷新 | `src-tauri/src/feat/config.rs`（UpdateFlags::LANGUAGE、process_terminated_flags） |
| 启动时 sync_locale | `src-tauri/src/config/config.rs`（init_config） |
| 默认 language 从系统读取 | `src-tauri/src/config/verge.rs`（如 default 中 language: system_language()） |

迁移时以「框架搭建 → 后端 crate 与配置 → 前端初始化与配置联动 → 逐屏替换文案 → 工具脚本」为顺序，可减少返工。
