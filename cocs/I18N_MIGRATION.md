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
   - 应用启动时：在 `App.vue` 中 `settingsStore.loadAll()` 后，用 `resolveLanguage`（已保存且合法 → 系统 → `en`）得到 canonical 语种，调用 `setLocale`；若存储值与 canonical 不一致（含 `null`、别名、非法串），再 `save('language', canonical)` 写回持久化。
   - 用户切换语言时：通过 `LanguageSetting` 组件仅选择具体语种，调用 `settingsStore.save('language', value)`；保存后后端 `set_language` 会调用 `sync_locale`；`setting-change` 事件中同样会做 canonical 收敛。
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

---

## 7. 最后一步：待迁移清单

框架与配置联动已完成，以下为**尚未替换为 i18n key 的硬编码文案**清单，按模块逐项迁移即可收尾。

### 7.1 前端待迁移清单

**当前已有**：`apps/main/src/i18n/locales/<lang>/` 下 `common`、`settings`、`gallery` 三个命名空间，且 `Settings.vue` 中语言设置、部分 tab 已用 `$t('settings.xxx')`；Gallery 等少量组件已用 `$t('gallery.xxx')` / `$t('common.xxx')`。

**需扩展的 locales**（在 `locales/<lang>/` 下新增或扩展现有 JSON，并在各语言 `index.ts` 中聚合）：

| 命名空间 | 说明 |
|----------|------|
| `settings` | 扩展 key：应用设置内所有表单项 label/description、壁纸/下载 tab 标签与文案、清理数据等按钮与确认语 |
| `wallpaper` | 壁纸相关：轮播设置、当前壁纸、过渡/样式/模式/周期等选项文案（或并入 settings） |
| `download` | 下载间隔等（或并入 settings） |
| `albums` | 画册列表、画册详情、新建/重命名/删除等 |
| `tasks` | 任务详情、状态、操作按钮 |
| `plugins` | 插件浏览、插件详情、安装/启用/配置等 |
| `help` | 帮助页标题、侧栏、所有 Tip 正文 |
| `surf` | 畅游、畅游图片等 |
| `common` | 扩展：确定/取消/关闭/保存等已有，可补「加载中」「无数据」等通用语 |

以下按**文件/模块**列出待迁移项（凡用户可见的中文或固定英文均需改为 `$t('namespace.key')` 或 `useI18n().t(...)`）。

#### 7.1.1 路由与全局

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/router/index.ts` | 各路由 `meta.title`：画廊、源、画册、任务详情、源详情、设置、帮助、畅游、畅游图片 |

#### 7.1.2 设置页与设置项组件

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/views/Settings.vue` | `StyledTabs` 的 `title="设置"`；应用设置内所有 `SettingRow` 的 `label` / `description`（开机启动、画册盘、图片点击行为、应用内预览/系统默认打开、图片宽高比、画廊列数、图片对齐方式、居中/靠上/靠下、清理应用数据、自动打开 WebView、生成测试图片、桌面端开发 WebView 窗口、打开 WebView 窗口）；tab 标签「壁纸设置」「下载设置」；壁纸区块「壁纸轮播设置」「启用壁纸轮播」「选择画册」「当前壁纸：」；下载区块所有 label/description；清理数据等按钮与确认对话框文案 |
| `apps/main/src/components/settings/items/WallpaperTransitionSetting.vue` | 过渡方式选项 label/文案 |
| `apps/main/src/components/settings/items/WallpaperStyleSetting.vue` | 壁纸样式选项 |
| `apps/main/src/components/settings/items/WallpaperRotationTargetSetting.vue` | 轮播目标选项 |
| `apps/main/src/components/settings/items/WallpaperModeSetting.vue` | 壁纸模式选项 |
| `apps/main/src/components/settings/items/GalleryGridColumnsSetting.vue` | 列数选项 label/描述 |
| `apps/main/src/components/settings/items/DownloadIntervalSetting.vue` | 下载间隔选项 |
| `apps/main/src/components/settings/items/GalleryImageAspectRatioSetting.vue` | 宽高比选项 |
| `apps/main/src/components/settings/items/DebugGenerateImagesSetting.vue` | 调试用 label/描述 |
| `apps/main/src/components/settings/QuickSettingsDrawer.vue` | 抽屉内标题、快捷项文案 |
| `apps/main/src/components/settings/items/LanguageSetting.vue` | 已用 i18n 的可仅核对 key 是否与 settings 一致 |

#### 7.1.3 视图页（已完成）

已完成：新增命名空间 `surf`、`tasks`、`albums`、`plugins`、`help`，扩展 `gallery`、`common`；各视图用户可见文案已替换为 `$t()` / `useI18n().t()`。

| 文件 | 迁移内容 |
|------|------------|
| `apps/main/src/views/Gallery.vue` | 开始收集、确认删除、选择收集方式、本地/网络、本地导入提示、滚动过快提示、删除等 |
| `apps/main/src/views/Surf.vue` | 标题、占位符、按钮、Cookie 对话框、畅游说明、会话与错误提示等 |
| `apps/main/src/views/SurfImages.vue` | 确认删除、收藏/轮播/壁纸/文件夹/分享/打开/移除等提示与副标题 |
| `apps/main/src/views/TaskDetail.vue` | 确认删除、任务状态文案、刷新/加载失败、停止与删除任务确认及提示等 |
| `apps/main/src/views/Albums.vue` | 空状态、新建画册对话框、刷新/创建/轮播/删除画册等提示与确认 |
| `apps/main/src/views/AlbumDetail.vue` | （待补：从画册移除、收藏/加入画册等操作文案与对话框） |
| `apps/main/src/views/PluginBrowser.vue` | （待补：已安装源、商店源、安装/更新/导入等 tab 与对话框） |
| `apps/main/src/views/PluginDetail.vue` | （待补：源详情、确认安装/卸载等） |
| `apps/main/src/views/Help.vue` | （待补：帮助标题、使用技巧、快捷键等） |
| `apps/main/src/App.vue` | 侧栏与 Android 底部 Tab：画廊、画册、收集源、畅游、设置、帮助；退出确认对话框 |

#### 7.1.4 通用组件与弹窗（已完成）

已完成：扩展 `common`、`tasks`、`albums`、`plugins`、`gallery`、`help`，新增 `import` 命名空间；各组件用户可见文案已替换为 `$t()` / `useI18n().t()`。

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/components/TaskDrawer.vue` | 抽屉标题、状态、操作按钮 |
| **`packages/core/.../TaskDrawerContent.vue`** | 任务抽屉内全部文案（**见 7.1.10**，位于 core 未迁移） |
| `apps/main/src/components/MediaPicker.vue` | 标题、按钮、提示 |
| `apps/main/src/components/LocalImportDialog.vue` | 标题、说明、按钮 |
| `apps/main/src/components/CrawlerDialog.vue` | 爬虫/采集相关文案 |
| `apps/main/src/components/OrganizeDialog.vue` | 整理相关 label/按钮 |
| `apps/main/src/components/AddToAlbumDialog.vue` | 加入画册相关文案 |
| `apps/main/src/components/import/PluginImportDialog.vue` | 插件导入说明与按钮 |
| `apps/main/src/components/import/ImportConfirmContent.vue` | 导入确认说明 |
| `apps/main/src/components/import/ImportConfirmDialog.vue` | 若有标题/按钮 |
| `apps/main/src/components/CollectSourcePicker.vue` | 收藏来源选择文案 |
| `apps/main/src/components/help/HelpDrawer.vue` | 帮助抽屉标题、分类 |
| `apps/main/src/components/help/CodeBlock.vue` | 若有「复制」等按钮 |
| `apps/main/src/components/common/EmptyState.vue` | 空状态标题/描述 |
| `apps/main/src/components/common/OptionPickerDrawer.vue` | 选项标题、确认等 |
| `apps/main/src/components/FileDropOverlay.vue` | 拖拽提示文案 |
| `apps/main/src/components/ImageGrid.vue` | 加载中、错误提示等 |
| **`packages/core/.../ImageDetailDialog.vue`** | 图片详情弹窗标题与字段标签（**见 7.1.10**，位于 core 未迁移） |
| `apps/main/src/components/GalleryBigPaginator.vue` | 上一页/下一页等 |
| `apps/main/src/components/GalleryToolbar.vue` | 工具栏按钮、筛选文案 |
| `apps/main/src/components/LoadMoreButton.vue` | 「加载更多」等 |
| `apps/main/src/components/albums/AlbumCard.vue` | 画册卡标题、数量等 |

#### 7.1.5 页头与操作区（已完成）

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/components/header/TaskDetailPageHeader.vue` | 返回、标题、操作按钮 |
| `apps/main/src/components/header/PluginBrowserPageHeader.vue` | 同上 |
| `apps/main/src/components/header/AlbumsPageHeader.vue` | 同上 |
| `apps/main/src/components/header/AlbumDetailPageHeader.vue` | 同上 |
| `apps/main/src/header/comps/GallerySortControl.vue` | 排序选项 |
| `apps/main/src/header/comps/CollectAction.vue` | 收藏相关文案 |
| `apps/main/src/header/comps/OrganizeHeaderControl.vue` | 整理相关文案 |

新增命名空间 `header`（`locales/<lang>/header.json`），用于页头功能按钮 label；`headerFeatures.ts` 使用 i18n，语言切换时调用 `registerHeaderFeatures()` 重新注册。

#### 7.1.6 右键菜单（已完成）

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/components/contextMenu/TaskContextMenu.vue` | 菜单项文案 |
| `apps/main/src/components/contextMenu/TaskImageContextMenu.vue` | 同上 |
| `apps/main/src/components/contextMenu/SingleImageContextMenu.vue` | 同上 |
| `apps/main/src/components/contextMenu/MultiImageContextMenu.vue` | 同上 |
| `apps/main/src/components/contextMenu/GalleryContextMenu.vue` | 同上 |
| `apps/main/src/components/contextMenu/AlbumImageContextMenu.vue` | 同上 |
| `apps/main/src/components/contextMenu/AlbumContextMenu.vue` | 同上 |

#### 7.1.7 帮助与 Tip 文案 ✅ 已完成

| 文件/目录 | 待迁移内容 | 状态 |
|-----------|------------|------|
| `apps/main/src/help/tipsRegistry.ts` | Tip 的 title/分类名 | ✅ 已迁移：getTipCategories(t) |
| `apps/main/src/help/helpRegistry.ts` | 帮助侧栏分类、标题 | ✅ 已迁移：titleKey/labelKey/descriptionKey |
| `apps/main/src/views/Help.vue` | 页面标题、tab、快捷键列表 | ✅ 已迁移 |
| `apps/main/src/components/help/HelpDrawer.vue` | 抽屉内分组与项 | ✅ 已迁移 |
| `apps/main/src/help/tips/**/*.vue` | 各 Tip 组件内全部说明正文 | ✅ 已迁移：21 个 Tip 组件均已使用 `$t('help.tipsContent.<tip-id>.<key>')`，zh/help.json 含完整 tipsContent |

#### 7.1.8 TS/Composables/Stores/Actions（已完成）

| 文件 | 待迁移内容 |
|------|------------|
| `apps/main/src/composables/useImageOperations.ts` | 消息提示、确认框文案（如删除成功、是否删除等） |
| `apps/main/src/composables/useProviderPathRoute.ts` | 面包屑或路由展示用中文（若有） |
| `apps/main/src/wallpaper.ts` | 壁纸相关 toast/错误提示 |
| `apps/main/src/stores/albums.ts` | 默认画册名等用户可见字符串 |
| `apps/main/src/stores/taskDrawer.ts` | 若有展示用文案 |
| `apps/main/src/settings/quickSettingsRegistry.ts` | 快捷设置项 label/描述 |
| `apps/main/src/header/headerFeatures.ts` | 页头功能名称（若硬编码） |
| `apps/main/src/actions/imageActions.ts` | 操作结果提示文案 |
| `apps/main/src/actions/albumActions.ts` | 同上 |
| `apps/main/src/actions/surfRecordActions.ts` | 同上 |
| `apps/main/src/utils/dragScroll.ts` | 若有用户可见提示 |
| `apps/main/src/composables/useImagesChangeRefresh.ts` | 若有提示 |
| `apps/main/src/composables/useFileDrop.ts` | 拖拽提示文案 |

**说明**：TS 中需在调用处注入 `i18n`（如 `useI18n().t`）或通过 `import { i18n } from '@kabegame/i18n'` 使用 `i18n.global.t`，再替换硬编码字符串。

#### 7.1.9 前端迁移顺序建议

1. 扩展 `settings`、`common`、`gallery` 的 key，并补全 `locales/zh`、`en`、`zhtw`。
2. 路由 `meta.title` 改为从 i18n 读取（需在路由或布局里用 `t()` 设 document title）。
3. `Settings.vue` 及所有 `settings/items/*` 组件。
4. 各视图页（Gallery、Albums、TaskDetail、PluginBrowser、Help、Surf 等）。
5. 通用组件与弹窗、页头、右键菜单。
6. Help/Tips 正文（可单列命名空间 `help`，按 tipId 或模块分子 key）。
7. TS/Composables/Stores/Actions 中的 toast、确认框、默认名称等。

#### 7.1.10 前端遗漏补充（packages/core 及零散）✅ 已完成

以下为**尚未接入 i18n 的硬编码文案**，多位于 **packages/core**。文案与语言包已抽到 **`@kabegame/i18n`**；core 依赖该包，组件内使用 `useI18n()` 与 `resolveManifestText` / `resolveConfigText`（见包内 `resolve.ts`），不再通过 `provide`/`inject`。

| 文件 | 待迁移内容 | 状态 |
|------|------------|------|
| **`packages/core/.../ImageDetailDialog.vue`** | 弹窗标题、字段标签、无效时间占位、日期格式、错误提示 | ✅ 已迁移：`useI18n` + `@kabegame/i18n`，gallery.* + common.* |
| **`packages/core/.../TaskDrawerContent.vue`** | 下载区、任务列表、参数标签、状态文案、时长格式、配置值等 | ✅ 已迁移：`useI18n` + resolve 函数，tasks.drawer* |
| `apps/main/.../useFileDrop.ts` | 拖拽确认列表中「（插件包）」后缀 | ✅ 已迁移：import.pluginPackageSuffix |

**实现方式**：主应用在 `main.ts` 中 `app.use(i18n)`（`i18n` 来自 `@kabegame/i18n`）；core 组件与 main 共用同一 `vue-i18n` 实例，直接 `useI18n()` 即可。

---

### 7.2 后端待迁移清单

**当前已有**：`kabegame-i18n` crate 已存在（`src-tauri/kabegame-i18n/`），`lib.rs` 提供 `t!()`、`sync_locale`、`set_locale`、`system_language`；`locales/zh.yml`、`en.yml`、`zhtw.yml` 已有 `common`、`settings`、`tray`（show/hide/exit）、`notifications`、`dialog`（exitConfirm/exitTitle）；启动时 `lib.rs` 已 `sync_locale`，`set_language` 命令已调用 `sync_locale`。

以下按**模块与文件**列出尚未改为 `kabegame_i18n::t!(...)` 的**用户可见字符串**及所需 YAML key（需在 `kabegame-i18n/locales/*.yml` 中补全并统一 key）。

---

#### 7.2.1 托盘菜单（`src-tauri/app-main/src/tray.rs`）✅ 已完成

| 当前硬编码文案 | 建议 key | 说明 |
|----------------|----------|------|
| `"显示窗口"`   | `tray.showWindow`  | 托盘菜单项 |
| `"隐藏窗口"`   | `tray.hideWindow`  | 托盘菜单项 |
| `"下一张壁纸"` | `tray.nextWallpaper` | 托盘菜单项 |
| `"退出"`       | `tray.quit` 或沿用 `tray.exit` | 托盘菜单项 |
| `"Kabegame"`   | `common.appName` 或保持固定 | 托盘 tooltip |

**实现要点**：在 `setup_tray` 内、创建各 `MenuItem::with_id` 时，将上述字符串改为 `kabegame_i18n::t!("tray.xxx")`。因托盘在 `init_wallpaper_controller` 中延迟 500ms 后创建，此时 `sync_locale` 已在 setup 中执行，首屏语言正确；**语言切换后**若需托盘菜单随当前语言更新，需在 `set_language` 命令中增加「刷新托盘菜单」逻辑（若 Tauri 支持动态更新菜单项文案），否则仅下次启动生效。

**YAML 扩展**：在 `tray:` 下新增 `showWindow`、`hideWindow`、`nextWallpaper`，`quit` 可与现有 `exit` 二选一统一（如统一为 `quit`）。

---

#### 7.2.2 原生错误对话框（`src-tauri/app-main/src/utils/dialog.rs`）✅ 已完成

| 当前硬编码文案 | 建议 key | 说明 |
|----------------|----------|------|
| `"出错啦 😿"`   | `dialog.errorTitle` | `show_error` 的对话框标题 |

**实现要点**：`show_error(app, msg)` 中 `.title("出错啦 😿")` 改为 `.title(kabegame_i18n::t!("dialog.errorTitle"))`。`msg` 为调用方传入的错误详情，若将来有「后端构造的固定错误提示」也应改为 `t!(...)`。

**YAML 扩展**：在 `dialog:` 下新增 `errorTitle`（zh: 出错啦 😿，en: Oops 😿，zhtw: 出錯啦 😿）。

---

#### 7.2.3 启动致命错误（`src-tauri/app-main/src/lib.rs`）✅ 已完成

| 当前硬编码文案 | 建议 key | 说明 |
|----------------|----------|------|
| `"初始化过程中出现了致命错误！: {}"` | `dialog.initFatalError`（占位符 `{detail}`） | `show_error` 调用处，用户可见 |

**实现要点**：`utils::show_error(app, format!("初始化过程中出现了致命错误！: {}", e))` 改为使用 `kabegame_i18n::t!("dialog.initFatalError", detail = e.to_string())`，YAML 中 `initFatalError: "初始化过程中出现了致命错误！: {detail}"`。

---

#### 7.2.4 窗口标题（用户可见）✅ 已完成

| 文件 | 当前硬编码文案 | 建议 key | 说明 | 状态 |
|------|----------------|----------|------|------|
| `startup.rs` | `.title("Kabegame")` | `common.appName` | 主窗口标题 | ✅ |
| `startup.rs` | `.title("Kabegame Wallpaper")` | `window.wallpaperTitle` | 壁纸窗口 | ✅ |
| `startup.rs` | `.title("Kabegame Crawler")` | `window.crawlerTitle` | 爬虫/采集窗口 | ✅ |
| `commands/surf.rs` | `format!("畅游 - {}", host)` | `surf.windowTitle`（占位 `{host}`） | 畅游窗口 | ✅ |
| `commands/misc.rs` | `"Kabegame 开发 WebView"` | `window.devWebViewTitle` | 开发用 WebView 窗口 | ✅ |

**实现要点**：在创建各窗口时，将 `.title(...)` 改为 `kabegame_i18n::t!("...")` 或带占位符的 `t!("surf.windowTitle", host = host.as_str())`。主窗口标题使用 `common.appName`。

**YAML 扩展**：已新增 `window:` 块（`wallpaperTitle`、`crawlerTitle`、`devWebViewTitle`）；`surf:` 下 `windowTitle: "畅游 - {host}"` / "Surf - {host}"。

---

#### 7.2.5 系统通知（若后端发送带文案的通知）✅ 已确认

当前 `startup.rs` 中仅使用 `tauri_plugin_task_notification` 的「任务数量」等，未见后端发送带自定义标题/正文的系统通知。若后续在 app-main 或 core 中调用 `send_notification` 等并传入用户可见标题/正文，应改为 `t!("notifications.xxx")`，并在 `notifications:` 中补全 key。

---

#### 7.2.6 后端迁移顺序建议

1. **YAML 扩展**：在 `kabegame-i18n/locales/zh.yml`、`en.yml`、`zhtw.yml` 中补全上述 key（`tray.showWindow`/`hideWindow`/`nextWallpaper`/`quit`、`dialog.errorTitle`、`dialog.initFatalError` 或等价、`window.*`、`surf.windowTitle`）。
2. **托盘**：修改 `tray.rs`，所有菜单项文案与 tooltip 改为 `kabegame_i18n::t!(...)`。
3. **对话框**：修改 `utils/dialog.rs` 的 `show_error` 标题；修改 `lib.rs` 中初始化失败时的 `show_error` 文案为 i18n。
4. **窗口标题**：按 `startup.rs`、`commands/surf.rs`、`commands/misc.rs` 顺序替换 `.title(...)`。
5. **（可选）语言切换后刷新托盘**：在 `commands/settings.rs` 的 `set_language` 中，在 `sync_locale` 之后调用托盘更新逻辑（若 Tauri 提供更新菜单项文本的 API）。

---

#### 7.2.7 涉及代码文件一览（后端）✅ 已完成

| 文件 | 作用 | 状态 |
|------|------|------|
| `src-tauri/kabegame-i18n/locales/{zh,en,zhtw}.yml` | 后端翻译源，tray/dialog/window/surf key | ✅ |
| `src-tauri/app-main/src/tray.rs` | 托盘菜单项与 tooltip 改为 `t!(...)` | ✅ |
| `src-tauri/app-main/src/utils/dialog.rs` | 错误对话框标题改为 `t!("dialog.errorTitle")` | ✅ |
| `src-tauri/app-main/src/lib.rs` | 初始化致命错误 `show_error` 文案改为 i18n | ✅ |
| `src-tauri/app-main/src/startup.rs` | 主窗口/壁纸窗口/爬虫窗口标题改为 `t!(...)` | ✅ |
| `src-tauri/app-main/src/commands/surf.rs` | 畅游窗口标题改为 `t!("surf.windowTitle", host = host)` | ✅ |
| `src-tauri/app-main/src/commands/misc.rs` | 开发 WebView 窗口标题改为 `t!("window.devWebViewTitle")` | ✅ |
| `src-tauri/app-main/src/commands/settings.rs` | `set_language` 仅 `sync_locale`；刷新由 setting-change 回调触发 | ✅（在 startup 事件循环中监听 language 变更后调用 `tray::update_tray_menu`） |

---

## 8. 插件国际化（.kgpg 爬虫插件）

以下为 **src-crawler-plugins** 及打包后的 .kgpg 内可能存在的**界面文本**清单，供后续设计插件 i18n 方案时使用。插件运行在独立上下文，多语言需单独设计与实现（见 4.4）。

### 8.1 插件界面文本来源分类

| 类型 | 位置 | 展示位置 | 说明 |
|------|------|----------|------|
| **manifest** | 各插件 `manifest.json` | 插件列表、插件详情、任务抽屉「源」名称、商店 index | `name`、`description`、`author` 直接展示 |
| **config 变量** | 各插件 `config.json` 的 `var[]` | 任务表单（TaskDrawerContent：参数 label、说明、选项名） | `name`（表单项 label）、`descripts`（说明）、`options[].name`（下拉/多选选项文案） |
| **插件文档** | 各插件 `doc_root/doc.md` | 插件详情页内嵌文档 / 帮助 | 整篇 Markdown 为用户可见说明 |
| **脚本错误/日志** | `crawl.js` / `crawl.rhai` | 任务失败时的错误提示、可选的任务日志 | `throw "..."` 会作为任务错误信息展示；`ctx.log()`、Rhai `print()` 可能出现在日志 |

### 8.2 各插件 manifest 与 config 内界面文本

#### 8.2.1 Pixiv（`plugins/pixiv/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | Pixiv |
| `manifest.json` | `description` | Pixiv 插画爬虫：排行榜、收藏、画师、关键词 |
| `config.json` | `var[].name` | 爬取类型、用户 UID、排行榜类型、内容类型、起始日期、日期范围（天）、画师 UID、搜索关键词、搜索模式、排序方式、最大下载数 |
| `config.json` | `var[].descripts` | 各变量说明（如「Pixiv 用户 ID，不清楚请点击插件查看文档」「格式 YYYYMMDD，如 20240501」等） |
| `config.json` | `options[].name` | 排行榜、个人收藏、画师作品、关键词搜索；日榜、周榜、月榜、男性向、女性向、AI 日榜、日榜 R18…；全部、插画、漫画、动图；安全、R18、全部；按日期、按人气 |

#### 8.2.2 konachan（`plugins/konachan/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | konachan动漫壁纸 |
| `manifest.json` | `description` | konachan动漫壁纸收集源插件 |
| `config.json` | `var[].name` | 起始页面、结束页数、质量 |
| `config.json` | `var[].descripts` | 要拉取的起始页面；要拉取的结束页面。请保持最多爬取100页…；图片质量，这个网站质量都挺高的 |
| `config.json` | `options[].name` | 高、中 |

#### 8.2.3 twodwallpapers（`plugins/twodwallpapers/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | 2dwallpapers二次元壁纸 |
| `manifest.json` | `description` | 2dwallpapers 壁纸网站爬虫 |
| `config.json` | `var[].name` | 目录、子目录关键字、爬取总数、排序方式 |
| `config.json` | `var[].descripts` | 爬取某一种壁纸；按名称过滤包含的子目录；最大爬取的总图片张数 |
| `config.json` | `options[].name` | 动漫壁纸、游戏壁纸、未分类；最新、最多查看、最多喜欢、最多收藏、最近更新、随机 |

#### 8.2.4 anime-pictures（`plugins/anime-pictures/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | anime-pictures动漫图库 |
| `manifest.json` | `description` | anime-pictures动漫图库收集源插件（可按标签检索） |
| `config.json` | `var[].name` | 起始页面、结束页数、标签 |
| `config.json` | `var[].descripts` | 要拉取的起始页面；要拉取的结束页面；要拉取的标签（默认无标签爬全站） |

#### 8.2.5 anihonet-wallpaper（`plugins/anihonet-wallpaper/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | anihonet动漫壁纸 |
| `manifest.json` | `description` | anihonet动漫壁纸收集源插件 |
| `config.json` | `var[].name` | 起始页面、结束页数、壁纸类型、排行榜周期 |
| `config.json` | `var[].descripts` | 要拉取的起始页面；要拉取的结束页面；选择要爬取的壁纸类型：桌面壁纸（imgpc）或手机壁纸（sp）；选择要爬取的排行榜周期：日榜、周榜、月榜或年榜 |
| `config.json` | `options[].name` | 桌面壁纸、手机壁纸；日榜、周榜、月榜、年榜 |

#### 8.2.6 ziworld（`plugins/ziworld/`）

| 文件 | 字段/位置 | 界面文本示例 |
|------|------------|--------------|
| `manifest.json` | `name` | ziworld高质量壁纸 |
| `manifest.json` | `description` | ziworld高质量壁纸收集源插件 |
| `config.json` | `var[].name` | 目录 |
| `config.json` | `var[].descripts` | 勾选要拉取的目录（可多选） |
| `config.json` | `options`（checkbox 选项名） | PC、背景、二次元、移动端、手机壁纸、横版壁纸、头像、萌图MP、萌图PC、原神、崩坏、鸣潮、video、七濑胡桃、未归类 |

### 8.3 插件文档（doc_root/doc.md / doc_root/doc.\<lang>.md）

以下为**整篇用户可见**的 Markdown 说明。支持多语言：`doc_root/doc.md` 为默认，`doc_root/doc.zh.md`、`doc_root/doc.en.md` 等按语言码分文件；后端下发为 record 类型 `{ "default": "...", "zh": "...", "en": ... }`，前端按当前 locale 解析展示。

| 插件 | 路径 | 说明 |
|------|------|------|
| Pixiv | `plugins/pixiv/doc_root/doc.md` | Pixiv 爬虫说明、Cookie 获取、配置项、注意事项等 |
| konachan | `plugins/konachan/doc_root/doc.md` | Konachan 动漫壁纸说明、配置项、使用说明、注意事项 |
| twodwallpapers | `plugins/twodwallpapers/doc_root/doc.md` | 2dwallpaper 插件说明、大目录/小目录/排序、使用示例 |
| anime-pictures | `plugins/anime-pictures/doc_root/doc.md` | anime-pictures 按标签下载说明、参数表、获取标签名、示例、注意事项 |
| anihonet-wallpaper | `plugins/anihonet-wallpaper/doc_root/doc.md` | anihonet 关键规则、配置项、使用建议 |
| ziworld | `plugins/ziworld/doc_root/doc.md` | ziworld 抓取说明 |

### 8.4 脚本内用户可见字符串（throw / print / ctx.log）

任务失败时 **throw** 的字符串会作为错误信息展示给用户；**ctx.log** / Rhai **print** 可能出现在任务日志中。

#### 8.4.1 crawl.rhai

| 插件 | 文件 | 类型 | 文案 |
|------|------|------|------|
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 排行榜模式请填写起始日期（格式 YYYYMMDD） |
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 收藏模式请填写用户 UID |
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 画师模式请填写画师 UID |
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 无法获取画师作品列表 |
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 关键词模式请填写搜索关键词 |
| pixiv | `plugins/pixiv/crawl.rhai` | throw | 未知的爬取类型: …（含变量） |
| konachan | `plugins/konachan/crawl.rhai` | throw | 在一次之内不允许爬取超过100页，咱二次元人要保持文明礼仪 |
| konachan | `plugins/konachan/crawl.rhai` | throw | 结束页面需要比开始页面大 |
| anime-pictures | `plugins/anime-pictures/crawl.rhai` | throw | 此插件不支持安卓版本！如果您是桌面版本，请下载最新版kabegame来运行本插件！ |
| anihonet-wallpaper | `plugins/anihonet-wallpaper/crawl.rhai` | print | 错误：wallpaper_type 必须是 'imgpc' 或 'sp' |

#### 8.4.2 crawl.js

| 插件 | 文件 | 类型 | 文案 |
|------|------|------|------|
| anime-pictures | `plugins/anime-pictures/crawl.js` | throw | 在一次之内不允许爬取超过100页，咱二次元人要保持文明礼仪 |
| anime-pictures | `plugins/anime-pictures/crawl.js` | throw | 结束页面需要比开始页面大 |
| anime-pictures | `plugins/anime-pictures/crawl.js` | ctx.log | [anime-pictures] 检测到挑战页（如 Cloudflare 验证），请求打开 WebView 窗口并等待 20 秒 |
| anime-pictures | `plugins/anime-pictures/crawl.js` | ctx.log | [anime-pictures] 等待结束，重新查询页面元素 |

### 8.5 其他与插件相关的界面文本

- **packed/index.json**：商店索引中的 `name`、`description`、`author` 与各插件 manifest 一致，随 .kgpg 发布生成，若插件支持 i18n 则索引生成逻辑可能需按语言输出或仅保留一种语言。
- **应用内「本地导入」**：`packages/core/.../TaskDrawerContent.vue` 中 `pluginId === "本地导入"` 与 `getBuiltinLocalImportMeta()[key]?.name` 为内置任务参数 label，属于主应用 i18n 范围，非插件包内文案。

### 8.6 实现思路与已实现部分

#### 8.6.1 config 变量 i18n（已实现，与 manifest 同构）

- **后端**：`get_plugin_vars` 返回的每条变量定义中，`name`、`descripts`、`options[].name` 均为 **Record** 结构：`{ "default": "单语言或默认文案", "zh": "可选", "en": "可选", ... }`。当前 config.json 仍为单语言（`name`/`descripts` 为 string），后端在序列化给前端时通过 `var_definition_to_frontend_value` 包装为 `{ default: value }`，以便前端统一按 locale 解析。
- **前端**：
  - **类型**：`PluginConfigText`（与 `PluginManifestText` 同构，`Record<string, string>`）在 `@kabegame/core/stores/plugins` 导出；`PluginVarDef` 的 `name`/`descripts` 及 `options[].name` 类型为 `PluginConfigText | string`（兼容旧数据）。
  - **解析**：`resolveConfigText(value, locale)` 与 manifest 的 `resolveManifestText` 同构，优先 `value[locale]`，否则 `value["default"]`；兼容 `value` 为 string。
  - **Composable**：`usePluginConfigI18n()`（`@kabegame/i18n`）提供 `varDisplayName(varDef)`、`varDescripts(varDef)`、`optionDisplayName(opt)`、`resolveConfigText`、`locale`，用于按当前语言解析并得到响应式展示文案。
  - **Record 存储与使用**：任务抽屉（TaskDrawerContent）中 `pluginVarMetaMap` 按插件存储原始变量定义（`name`/`optionNameByVariable` 为 record），展示时用 `resolveConfigText(..., locale.value)` 计算 `getVarDisplayName`/`formatConfigValue`；CrawlerDialog 中 `visiblePluginVars` 为 computed，在过滤 when 后对每条变量用 `varDisplayName`/`varDescripts`/`optionDisplayName` 解析为展示用字符串。
- **涉及文件**：`src-tauri/core/src/plugin/mod.rs`（`var_definition_to_frontend_value`）、`src-tauri/app-main/src/commands/plugin.rs`（`get_plugin_vars` 返回前端结构）；`packages/core`（`PluginConfigText`、TaskDrawerContent 的 metaMap）；`@kabegame/i18n`（`resolve.ts`、`usePluginConfigI18n`）；`apps/main`（usePluginConfig 类型、CrawlerDialog 的 visiblePluginVars）。

#### 8.6.2 config.json 扁平多语言键（已实现）

- **约定**：与 manifest 一致，config 内 `var[].name`、`var[].descripts`、`options[].name` 支持扁平键：`name` / `name.zh` / `name.en` 等，后端反序列化时用 `extract_manifest_text_from_flat` 转为 `ManifestI18nText`，再经 `var_definition_to_frontend_value` 输出为前端 record。
- **已更新插件**：anihonet-wallpaper、konachan、anime-pictures、ziworld、twodwallpapers、pixiv 的 `config.json` 已补充 `name.en`、`descripts.en` 及选项的 `name.en`（ziworld 的 options 为 string 数组，仅变量 name/descripts 有多语言）。
- **doc**：可按语言分文件（如 `doc.zh.md`、`doc.en.md`）或单文件内按 frontmatter/段落标记切分，展示时按当前语言选取。
- **脚本 throw/log**：Rhai/JS 无内置 i18n，可约定插件包内提供 `locales/<lang>.json`，脚本通过 ctx 注入的 `locale` 与 `t(key)` 取文案；或暂时保持中文，后续统一方案再替换。
