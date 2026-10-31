# Phase 7 — 用户属性（属性面板）

> 状态：已实现（2026-10-31）；关键决策全部按推荐项确认（见文末）。静态检查与单测通过，真机回归待做（`versions/latest/regression.md`）。上级：[PLAN.md](PLAN.md)。
>
> 2026-10-31 验收补改（与方案的差异）：
> - 显示条件解释器：一元 `! + -` 原先在 `primary` 里只吃紧跟的原子，`!a.value.endsWith('x')` 被算成对取反结果调方法，改为比成员 / 调用低一级（同 JS）；
>   运行期出错不再缓存成失败（只缓存解析结果）；数组字面量允许负数。
> - 内置词表：创意工坊根也能推出 `<库>/steamapps/common/wallpaper_engine`，不只靠项目根往上找。
> - `list_directory_files`：按文件名有序遍历、够数即停，不再走完整棵树再截断。
> - 垫片：没有默认值的 `file` / `directory` 重置后键会从状态里消失，垫片补推空路径让页面撤销旧选择（codex 补的，方案未写）。
> - `resolve_web_user_props`：没有 `type` 的带值条目不再推（定义解析只认已知类型）。
> - 验证项 8 的预期按点 4「只增不减」改正。
>
> 2026-10-31 修订：6b 之后运行时已有 `FilePolicy` 结构（能力位 + 根目录），现状锚点 g 与点 4 按现有代码重写：在 `FilePolicy` 上加 `grants`，闸门改读 `FileAccess` 快照。
>
> Phase 6（FPS、暂停、多显示器）暂时跳过。本 Phase 只依赖 Phase 5：垫片已经订阅了本张图片的 `metadataId` 补丁，
> 补丁一到就重拉状态，用户属性按键差异投递。
>
> 用户指定（2026-10-28）：面板不复刻 WPE 属性页的外观，用 Kabegame 自己的表单组件，缺什么再新增组件。
>
> 2026-10-28 修订：静态分析了 WPE 自己的属性面板（API.md 第一节「WPE 自己的面板怎么求值、怎么渲染」），
> 按它的实际做法改了四处：
> - 显示条件照 WPE 的白名单解释器（点 8），决策 2 已定；
> - 标签净化对齐 ngSanitize 默认白名单，分组标题按纯文本（点 8、点 10）；
> - 本地化顺序与 WPE 内置词表（点 1、点 3）；
> - 分组语义：组条件为假整组隐藏，组可折叠（点 10）。
>
> 2026-10-28 第二次修订（用户指定）：为了能在预览里跑 Slideshow 并调试 `file` / `directory`，预览也支持这两类属性。
> 先考虑过「`/wpe` 文本里粗暴替换 `file:///` + 专门端点」，因 HTTP 页面的 `file:` 请求在渲染进程就被拦、Rust 侧无钩子，
> 最终改为 [Phase 6a](phase-6a-file-preview.md)：预览 iframe 也走 `file://`，与桌面共用运行时目录拦截。本 Phase 的追加放行（点 4、5）
> 因此对两种宿主同一套，本 Phase 依赖 6a。
>
> 范围：
> - 逐壁纸用户属性的存储（图片 metadata 的 `userProperties` 段）与写命令；
> - 属性面板：排序、分组、说明行、显示条件、本地化、单键重置与全部重置；
> - 面板入口：图库预览右侧详情栏、设置页「当前壁纸」；
> - `file` / `directory` 属性：桌面与预览都经运行时追加放行（Phase 6a 后两者同一套）。
>
> **不做**：
> - `x-wpe/video` 行的属性面板。视频的对齐、倍速、音量由 Kabegame 自己的壁纸设置覆盖（`properties.rs` 头注释），
>   `get_current_wallpaper_target` 不改；
> - 紧凑布局（PhotoSwipe）预览里的面板；
> - 监视目录属性指向的文件夹，内容变化只在下次重拉时体现；
> - 作者更新 `project.json` 后刷新 metadata（现状：重新导入是幂等的，不改 metadata）；
> - WPE 的 `editable` 字段：滑块总是带输入框；
> - Web 发布版。

## 总体设计思路

Phase 5 已经接好了「属性 → 页面」这一半：
- 页面里的垫片订阅本张图片的 `metadataId` 补丁；
- 补丁一到就重拉完整状态，只把值变化的键交给 `applyUserProperties`。

Phase 7 补另一半：让用户在 Kabegame 里改属性，并把每次改动变成一次 metadata 换行。数据只朝一个方向流：

```
面板 ──写命令──▶ 新 metadata 行 + 图片改指 + image-changed { metadataId }
                          │
          ┌───────────────┼──────────────────┐
          ▼               ▼                  ▼
   桌面壁纸窗口垫片   预览 iframe 垫片    各处打开的同一张的面板
   （重拉、按键差异）  （经宿主页代办）   （重读视图）
```

面板、桌面、预览之间不互相通知，都只听同一个后端事件。所以在预览里改属性，桌面上正在显示的同一张壁纸也会跟着变。

**存储**：
- 用户值存在图片 metadata JSON 顶层的 `userProperties` 段（PLAN 已确认决策 6），形如 `{ key: value }`；
- 只存与作者默认值不同的键，值就是推给页面的格式。改回默认值等于删键，整段为空就去掉；
- 写入遵守 metadata 按 id 不可变的语义，在一个事务里完成：读旧行 → 套用改动 → 插入新行 → 图片改指 → 旧行没人引用就删；
- 新行的 `plugin_id` / `plugin_version` / `template` 照抄旧行，搜索词映射也从旧行拷贝。作者文本没变，用户填的值也不应进搜索。
- Storage 只提供一个通用原语「在事务里改写某张图的 metadata」。WPE 的规则放在 core 的 `wpe::user_props`：键必须存在、按类型校验并归一、等于默认值就删键。

**属性定义只在 Rust 解析一次**：
- core 新增 `wpe::user_props`，把 `general.properties` 解析成有序的 `WpePropDef` 列表；
- 三处共用这份列表：写命令的校验、给面板的视图、给页面的状态。`resolve_web_user_props` 改成「作者默认值 ⊕ 用户值」；
- 面板拿到的是后端整理好的条目：类型、范围、步长、选项、已本地化的标签、默认值、当前值、是否改过。前端不读 `project.json`；
- 本地化也在 Rust，照 WPE 的顺序：当前语言 → `en-us` → 原文，每一级里 WPE 内置词条覆盖作者的 `ui_` 词条。
  - 语言码复用 Phase 5 的 `wpe_language_code`；
  - WPE 内置词表在运行时**只读**读取用户 WPE 安装目录的 `locale\ui_<语言码>.json`。安装目录由现有的 Steam 库发现得到，按语言缓存；
  - 找不到 WPE 安装时，`ui_browse_properties_scheme_color` 这一条退回 Kabegame 自己的 Rust i18n，其余显示原文；
- 面板和垫片用同一组触发重读：本张的 `metadataId` 补丁、`setting-change` 的 `language`。

**面板只做渲染与编辑**：
- 字段复用 `components/common/form` 的现有组件：
  - 滑块用 `KbNumber`，补上 float 模式的 `step`；
  - 下拉用 `KbSelect`，开关用 `KbBoolean`，文本用 `KbText`；
  - 文件 / 文件夹用 `KbPath`；
- 新增组件：
  - `KbColor`：通用取色，十六进制进出；
  - `WpePropertyField`：按类型分发，同 `PluginVar`，WPE 的 `"r g b"` 颜色格式在这里换算；
  - `WpeWebPropertiesPanel`：分组、说明行、显示条件、单键 / 全部重置。
- **显示条件不 eval**。WPE 自己也不 eval：它在 Angular 的 AST 上跑一个白名单解释器（`$parse.readOnly`），不认识的一律当 true。
  Kabegame 照同一份白名单自写一个小解释器，作者条件在两边的显隐结果一致：
  - 字面量、一元 / 二元 / 逻辑 / 三元运算、原始值数组字面量；
  - `<key>.value`、`.length`、`[下标]`；
  - `split` / `includes` / `indexOf` / `startsWith` / `endsWith` 五个方法。
  解析失败、不在白名单里、运行出错都当作显示，并在控制台警告一次。
- 标签、说明行与 `combo` 选项文字里的 HTML（样例有 `<h3>`、`<br><small>`、`<b>`）经 DOMPurify 净化后 `v-html`。
  白名单取 WPE 所用的 ngSanitize 默认白名单，另去掉链接、图片和 `class`：面板里不点外链、不加载远程资源。分组标题按纯文本显示。

**编辑节奏**：
- 改动先进面板本地的「草稿」，立即生效，显示条件随之重算；
- 写入防抖合并（300ms），并且串行：同一时刻最多一个写请求在途；
- 写命令直接返回保存后的视图（同运行配置写命令的惯例）。面板据此清掉已落库的草稿；
- 后端事件触发的重读，只在补丁的 `metadataId` 与手上视图不同时才发；
- 拖动滑块时，页面大约每 300ms 跟一次。

**`file` / `directory` 属性**：
- 白名单只有一份，在 core：壁纸项目目录 ∪ 用户 `file` 属性选的文件 ∪ 用户 `directory` 属性选的目录。
  Phase 6a 之后桌面与预览都是 `file:` 文档、都经 `FileDocumentGuardHandler`，放行位置也相同。
- 页面是 `file://` 且已开文件访问，挡住用户文件的只有运行时的目录拦截。照 WPE 的两张白名单（API.md §4.1）做：
  运行时每个窗口的策略从「一个根目录」扩成「根目录 + 追加放行」；
- 拉取状态的命令（桌面 `wpe_web_pull_state`、预览 `get_wpe_web_state`）在把状态交出去之前，按调用方 label 把状态里的文件 / 目录追加进该窗口的放行集合：
  - 只增不减，导航时随根目录一起清空，所以页面拿到路径时一定已经能读；
  - 追加时核对根目录仍是这次状态对应的壁纸目录，在途的旧拉取不会把别的壁纸的文件放进来；
  - 路径只来自用户在面板里的选择，页面没有任何写入口；
- `directory` 的文件列表也放进状态：递归列举、只留 `MEDIA_FORMATS` 里 `browser_safe` 的格式、设上限。
  - `fetchall`：垫片按差异回调 `userDirectoryFilesAddedOrChanged` / `userDirectoryFilesRemoved`；
  - `ondemand`：垫片在列表里随机取一个回给 `wallpaperRequestRandomFileForProperty`；
- 预览的根目录由 6a 的 `set_wpe_web_preview` 设置；`get_wpe_web_state` 追加 grants 时核对该 label 当前根目录仍是这张壁纸的目录，
  与桌面的在途保护相同。页面拼的 `'file:///' + 路径` 原样可用，不改任何页面文本。

## 现状锚点

**a. 页面状态只有作者默认值**（`src-tauri/kabegame-core/src/wpe/properties.rs`）
```rust
/// 网页壁纸推给页面的用户属性：`general.properties` 中带 `value` 的条目，形如 `{ key: { type, value } }`。
/// 没有 `value` 的纯展示条目（分组、说明行）与没有默认值的 `file` 属性不推。作者默认值层；
/// Phase 7 的用户值在调用方叠加。
pub fn resolve_web_user_props(raw: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(props) = properties(raw) else {
        return out;
    };
    for (key, prop) in props {
        let Some(value) = prop.get("value") else {
            continue;                       // 现状：没有默认值就不推，用户值也无处可来
        };
        let mut entry = serde_json::Map::new();
        if let Some(kind) = prop.get("type") {
            entry.insert("type".into(), kind.clone());
        }
        entry.insert("value".into(), value.clone());   // 现状：原样推作者值（可能是 "true" / "150" 这种字符串）
        out.insert(key.clone(), Value::Object(entry));
    }
    out
}
```

**b. 状态组装与桌面拉取**（`src-tauri/kabegame/src/commands/wpe_web.rs`）
```rust
pub struct WpeWebState {
    pub image_id: String,
    pub user: serde_json::Map<String, serde_json::Value>,   // 现状：只有用户属性与通用属性，没有目录文件
    pub general: WpeWebGeneral,
}

pub async fn wpe_web_pull_state<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<WpeWebState, String> {
    let dir = WallpaperController::global()
        .manager_for_mode("window")
        .web_wallpaper_dir(webview.label())
        .ok_or("no web wallpaper")?;
    let image = Storage::find_image_by_path(&dir.to_string_lossy())
        .map_err(|e| format!("Storage error: {}", e))?
        .ok_or("web wallpaper row missing")?;
    build_wpe_web_state(&image.id)          // 现状：只读，不碰运行时的 file: 放行
        .await?
        .ok_or_else(|| "web wallpaper row missing".to_string())
}
```

**c. WPE 行的 metadata 是导入时的 `project.json` 原文**（`src-tauri/kabegame-core/src/crawler/wpe_import.rs:274`）
```rust
fn insert_project_metadata(project: &WpeProject) -> Result<i64, String> {
    Storage::global()
        .insert_metadata_row(&project.raw, WPE_IMPORT_PLUGIN_ID, 0, None, None)   // 现状：每张图独占一行；搜索词按默认规则展开整份 JSON
        .map_err(|e| format!("写入 metadata 失败：{e}"))
}
```

**d. 没有「按图改写 metadata」的原语**（`src-tauri/kabegame-core/src/storage/images.rs`）
```rust
// 现状：插入新行与改指是两步、不在同一事务里；迁移有自己的批量写回 writeback_migrated_metadata_batch
pub fn insert_metadata_row(&self, value: &Value, plugin_id: &str, plugin_version: u32,
    template: Option<&str>, search_terms: Option<Vec<String>>) -> Result<i64, String> { /* … */ }

/// 去重命中时把旧图改挂到新 metadata；… 旧 metadata 行改挂后无人引用则 GC。
pub fn rebind_image_metadata(&self, image_id: &str, metadata_id: i64,
    plugin_id: Option<&str>, post_url: Option<&str>) -> Result<(), String> {
    // 现状：先 UPDATE images，释放锁后再 gc_metadata，读改写之间没有原子性
}
```

**e. 预览右栏对 WPE 行显示原始 metadata**（`apps/kabegame/src/components/common/ImagePreviewDialog.vue:393`、`ImagePluginDescriptionPanel.vue:407`）
```vue
<div class="preview-detail-drawer-scroll preview-detail-drawer-scroll-right">
  <ImagePluginDescriptionPanel :image="previewImage" fill-when-expanded />   <!-- 现状：所有行都是插件详情面板 -->
</div>
```
```ts
const showRawMetadata = computed(() => {
  // …
  if (!img?.pluginId || !isRenderableMetadata(meta)) return false;
  const tpl = descriptionTemplate.value;
  if (tpl?.trim()) return false;
  // 现状：wpe-import 没有描述模板，WPE 行落到这里，把 project.json 的顶层键逐个列出来
```

**f. `KbNumber` 的 `step` 只对 int 生效**（`apps/kabegame/src/components/common/form/KbNumber.vue`）
```ts
const props = defineProps<{
  modelValue: unknown;
  type?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  /** 以下仅 int 模式生效：按钮步进量（默认 1）、禁用 */
  step?: number;
  disabled?: boolean;
}>();

/** 滑杆/步进器的步进粒度：int 恒为 1；float 按有效范围的 ~1% 取，且不小于 0.01 */
const sliderStep = computed(() => {
  if (!isFloat.value) return 1;
  const span = effectiveMax.value - effectiveMin.value;   // 现状：kaguya 的 0.25…2（step 0.25）会得到 0.0175
  // …
});
function formatNumber(v: number): string {
  return isFloat.value ? v.toFixed(2) : String(Math.round(v));   // 现状：float 固定两位小数
}
```
现有 float 调用方（`PluginVar.vue`）都不传 `step`。

**g. 运行时 `file:` 策略只有一个根目录**（`src-tauri/tauri-runtime-kbcef/src/file_access.rs:73`、`webview.rs:1057`；2026-10-31 按 6b 之后的代码重写）
```rust
/// 一个 label 的 `file:` 访问策略。
#[derive(Debug, Default)]
struct FilePolicy {
    /// 建窗带 04 键：`file:` 文档可读本地文件。
    file_documents: bool,
    /// 建窗带 05 键：应用页可加载 `file:`。
    app_local_resources: bool,
    /// 子 frame 与 `file:` 文档的根目录（`None` = 这类请求全拒）；应用页主 frame 的子资源
    /// 免检时不看它。
    root: Option<PathBuf>,              // 现状：只有根目录，没有追加放行
}
static FILE_POLICIES: OnceLock<Mutex<HashMap<String, FilePolicy>>> = OnceLock::new();

pub(crate) fn set_file_document_root(webview_label: &str, root: Option<PathBuf>) -> Result<(), String>;
pub(crate) fn file_document_root(webview_label: &str) -> Option<PathBuf>;

pub(crate) fn check_file_request(url: &str, root: Option<&Path>) -> Result<PathBuf, FileDeny> {
    let Some(root) = root else {
        return Err(FileDeny::NoRoot);
    };
    // … 普通文件、canonicalize 后位于 root 之内才放行（现状：用户选的文件在壁纸目录之外，一律 OutsideRoot）
}
```
```rust
// webview.rs FileDocumentGuardHandler::on_before_resource_load（应用页主 frame 的子资源在 :820 已按 6b 免检，到这里的
// 是子 frame 导航与 `file:` 文档的请求：桌面壁纸窗口的页面、预览 iframe 的页面）
let root = crate::file_access::file_document_root(&self.label);
match crate::file_access::check_file_request(&url, root.as_deref()) {
```

**h. 垫片没有目录接口**（`src-tauri/kabegame/src/webview_js/wpe_shim.js`）
```js
window.wallpaperRequestRandomFileForProperty = function () {}; // file / directory 属性暂不支持
// …
function call(name, arg) {            // 现状：只能传一个参数；目录回调要 (propertyName, files)
  var target = listener;
  if (target && typeof target[name] === "function") {
    try { target[name](arg); } catch (error) { console.error("[kb-wpe] " + name, error); }
  }
}
function deliverFull(state) {
  call("applyUserProperties", clone(state.user));
  call("applyGeneralProperties", clone(state.general));
  delivered = state;                  // 现状：没有 userDirectoryFiles* 回调
}
```

**i. 设置页「当前壁纸」只显示路径**（`apps/kabegame/src/views/Settings.vue:207`）
```vue
<SettingRow v-if="currentWallpaperPath" :label="$t('settings.wallpaperCurrent')">
  <button type="button" class="setting-current-wallpaper-path" @click="openCurrentWallpaperPath">
    {{ currentWallpaperPath }}
  </button>
</SettingRow>
```

**j. 样例里的属性写法**（只读查看，2026-10-28）
- kaguya `3679122549`：`color` × 3（含 `schemecolor`，其 `text` 是 WPE 内置词条 `ui_browse_properties_scheme_color`）；
  带 `step` 的小数滑块 × 3（`0.25…2` 步长 0.25 等）；`file` × 1（`custom_user_bg`，`filter: "*.jpg|*.png|*.jpeg|*.webp"`，无默认值）。
- Slideshow `796697921`：123 项。
  - `group` 分组标题、`text` 说明行，都没有 `value`；`custom_` 连 `type` 都没有，只有 `text: "<h3>Slideshow</h3>"`；
  - 标签与说明行里有 HTML（`<h4><small>`、`<br>`、`<b>`）；
  - `condition` 如 `backgroundImageVisible.value && backgroundImageScale.value > 100`、`customSize.value == 'contain'`；
  - `directory` × 1（`customdirectory`，`mode: "fetchall"`）。
- 官方默认项目 corsair_*：
  - `condition` 用了 `effect.value.endsWith('pulse') === true`、`scene.value !== 'cartoon'`；
  - 有字符串形式的默认值：`bool` 写 `"true"`，`slider` 写 `"150"`。
- 三个样例都没有 `general.localization`。

**k. WPE 自己的属性面板**（只读静态分析，WE 2.8.42 `ui\dist\scripts\scripts.js` / `vendor.js`；完整结论见 API.md 第一节）
```js
// browseruserproperties.html（$templateCache）：普通属性行
<div class="settingsWallpaperProperty" ng-repeat="property in properties track by $index"
     ng-if="!property.condition || evalCondition(property.condition)">
  <span class="browsePropertyLabel" translate="{{property.text | san}}"></span>   // 先 $sanitize，再当翻译 id，结果按 HTML 插入
// 分组容器：组自己的条件为假时整组隐藏
<div class="browserUserPropertyGroup" ng-class="{'closed':!open}"
     ng-show="!groupProperty.condition || evalCondition(groupProperty.condition)">

// BrowseWallpapersCtrl：M 是 $parse，readOnly 是 WPE 加进 vendor.js 的白名单解释器（不 eval，失败当 true）
V.evalCondition = function (e) {
  return V.selectedMonitor && V.selectedMonitor.location && V.currentSelection && V.currentSelection.properties
    && M.readOnly(e)(V.currentSelection.properties[V.selectedMonitor.location], ea);
};
```
- 分组：按 `order` 排序后，从一个 `group` 条目到下一个为一组，第一个 `group` 之前的属性不属于任何组；组默认折叠。
- 本地化：当前语言表 → `en-us` 表 → 原文；项目 `localization` 只收 `ui_` 开头的键，同名时 WPE 内置词表（`locale\ui_<码>.json`）覆盖项目。

**l. 页面自己拼 `file:///`**（Slideshow，只读查看）。Phase 6a 后预览也是 `file:` 文档，这些写法原样可用，不需要改页面文本：
```js
// slideshow.js:257
slideshow.getFilenameCallback( 'file:///' + fixFilename( data ) );        // fixFilename 现在原样返回
// index.html:825
document.body.style.background = color + ' ' + ( image ? (' url("file:///' + fixFilename( image ) + '") center center no-repeat') : … );
// index.html:1515：拿拼出的字符串和 img.src（浏览器解析后的绝对地址）比较
if( 'file:///' + files[ i ] == slideshow.preload.src ) {
// index.html:727
if( slideshow.preload.src && slideshow.preload.src != 'file:///') {
```
kaguya 的脚本混淆过、搜不到 `file:` 字面量，`custom_user_bg` 怎么被页面消费要真机看；但只要它最终发出 `file:` 请求，两种宿主都按同一白名单放行。

---

## 点 1 — 属性定义解析、用户值与内置词表（`kabegame-core/src/wpe/user_props.rs`、`wpe/locale.rs`，新）

- **新增**
  - 模块 `wpe::user_props`（`wpe/mod.rs` 加 `pub mod user_props;`）。
  - `parse_defs(raw)`：把 `general.properties` 解析成按 `(order, key)` 排好序的定义列表。规则如下：
    - 未知 `type` 的条目跳过；
    - 没有 `type` 但有 `text` 的条目当 `Text`（Slideshow 的 `custom_`）；
    - 缺 `order` 的排到最后。
  - `normalize_value(def, value)`：按类型校验并归一（下表）。作者默认值也过一遍，供面板显示与「等于默认值」的比较。
  - `user_values(raw)`：读 `raw.userProperties`，不是对象就当空。
  - `apply_changes(raw, changes)`：`changes` 是 `{ key: 新值 | null }`，`null` 表示恢复默认。处理规则：
    - 键不存在或类型不可编辑（`Group` / `Text`）：整个请求报错；
    - 归一后等于作者默认值：删键；
    - 结果与原来相同：返回 `None`；
    - 否则返回新的整份 `raw`。`userProperties` 为空时整段去掉。
  - `localize(raw, language, text, builtin)`：照 WPE 的顺序查（现状锚点 k）：
    1. `builtin(language, text)`：WPE 内置词表，同名时覆盖项目词条；
    2. `general.localization[language][text]`：只认 `ui_` 开头的键；
    3. 同上两步换成 `en-us`；
    4. 原文。
    `builtin` 由调用方传入（点 3 用 `wpe::locale::builtin_term`），`localize` 本身不读文件，便于单测。
  - 模块 `wpe::locale`（`wpe/locale.rs`，新）：`builtin_term(language, key)`。
    - 只认 `ui_` 开头的键；
    - 从现有 Steam 库发现（`discover.rs`）拿到各库的 `steamapps\common\wallpaper_engine`，**只读**读取第一个存在的
      `locale\ui_<语言码>.json`；
    - 按语言缓存整张表，进程内只读一次。读不到（没装 WPE、语言文件缺失、JSON 坏）就缓存为空；
    - 不写、不改、不复制 WPE 目录下的任何文件，也不把词表带进 Kabegame 仓库。
  - `list_directory_files(dir, limit)`：
    - 递归遍历（`walkdir`，不跟随符号链接），按路径排序；
    - 只留 `media_format_by_ext` 命中且 `browser_safe` 的文件，不硬编码扩展名；
    - 最多 `limit` 个。
  - 用户文件白名单，桌面与预览的追加放行（点 5）共用这一份规则：
    - `user_file_grants(raw)`：取 `userProperties` 里 `file` 属性的值（只放行该文件）与 `directory` 属性的值（放行其中的普通文件）。
      只看用户值，不看作者默认值。空串跳过；`canonicalize` 失败（文件已被删）也跳过。
    - `file_allowed(project_dir, raw, target)`：`target` 必须是普通文件，不能是符号链接。`canonicalize` 后满足以下任一条件即放行：
      - 位于 `project_dir` 内；
      - 等于某个文件 grant；
      - 位于某个目录 grant 内。
    - 路径比较规则同运行时 `file_access.rs`：去掉 `\\?\`，Windows 下不区分大小写、统一分隔符。运行时不依赖 core，这几行比较逻辑两边各写一份。

| 类型 | 接受 | 归一结果 |
|---|---|---|
| `bool` | 布尔、数字、`"true"` / `"false"` / `"1"` / `"0"` 等 | 布尔 |
| `slider` | 数字、数字字符串 | 数字，夹到 `[min, max]`；整数值存成整数 |
| `combo` | 与某个选项的 `value` 字符串形式相等 | 该选项的原始 `value`（字符串或数字） |
| `color` | 三个空格分隔的浮点 | 各分量夹到 0–1，空格连接 |
| `textinput` | 字符串 | 原样 |
| `file` | 空串（清空）或存在的普通文件的绝对路径 | 原样（本机路径格式） |
| `directory` | 空串（清空）或存在的目录的绝对路径 | 原样 |
| `group` / `text` | 拒绝 | — |

```rust
pub const USER_PROPERTIES_KEY: &str = "userProperties";   // 新增：metadata 顶层段名（PLAN 已确认决策 6）

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WpePropKind { Color, Slider, Bool, Combo, TextInput, File, Directory, Group, Text }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WpeComboOption {
    pub label: String,     // 原文，未本地化；没有 label 的选项用 value 的字符串形式
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WpePropDef {
    pub key: String,
    pub kind: WpePropKind,
    pub text: String,              // 原文，可能是 `ui_` 词条或带 HTML
    pub order: Option<f64>,
    pub condition: Option<String>,
    pub default: Option<Value>,    // project.json 里的原值（推给页面用，保持 Phase 5 的投递不变）
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<WpeComboOption>,
    pub extensions: Vec<String>,   // file：`filter` "*.jpg|*.png" → ["jpg", "png"]
    pub mode: Option<String>,      // directory："fetchall" | "ondemand"
}

pub fn parse_defs(raw: &Value) -> Vec<WpePropDef>;
pub fn user_values(raw: &Value) -> serde_json::Map<String, Value>;
pub fn normalize_value(def: &WpePropDef, value: &Value) -> Result<Value, String>;
pub fn apply_changes(raw: &Value, changes: &serde_json::Map<String, Value>) -> Result<Option<Value>, String>;
pub fn localize(
    raw: &Value,
    language: &str,
    text: &str,
    builtin: &dyn Fn(&str, &str) -> Option<String>,   // (语言码, 词条) → WPE 内置译文
) -> String;
pub fn list_directory_files(dir: &Path, limit: usize) -> Vec<PathBuf>;

/// 用户为本张壁纸选的本地路径（已 canonicalize）：文件只放行它本身，目录放行其中的普通文件。
pub struct WpeFileGrant { pub path: PathBuf, pub is_dir: bool }
pub fn user_file_grants(raw: &Value) -> Vec<WpeFileGrant>;
/// 页面读本地文件的白名单：项目目录 ∪ 用户选的文件 ∪ 用户选的目录。
pub fn file_allowed(project_dir: &Path, raw: &Value, target: &Path) -> bool;
```

- **修改**（`wpe/properties.rs`）
  - `resolve_web_user_props` 改成在 `parse_defs` 之上组装，把用户值叠加上去。
  - 作者默认值仍原样推（`"true"` 还是字符串），保持 Phase 5 已验证的投递不变；用户值推归一后的值。
  - 推给页面时，`file` / `directory` 的路径分隔符换成 `/`。页面会自己拼 `'file:///' + value`，Chromium 两种分隔符都认，统一后便于页面做字符串处理。
```rust
pub fn resolve_web_user_props(raw: &Value) -> serde_json::Map<String, Value> {
    let user = super::user_props::user_values(raw);                       // 新增
    let mut out = serde_json::Map::new();
    for def in super::user_props::parse_defs(raw) {                       // 修改：改走解析后的定义
        if matches!(def.kind, WpePropKind::Group | WpePropKind::Text) {
            continue;
        }
        // 修改：用户值优先；没有默认值的 file / directory 在用户设置后也推
        let Some(value) = user.get(&def.key).cloned().or(def.default.clone()) else {
            continue;
        };
        let value = page_value(&def, value);                              // 新增：路径分隔符统一成 `/`
        out.insert(def.key.clone(), json!({ "type": def.kind, "value": value }));
    }
    out
}
```

- **新增**（测试，`user_props.rs` 与 `properties.rs`）
  - 用三个样例的片段覆盖：
    - 排序；无 `type` 的条目当 `Text`；
    - `"true"` / `"150"` 的归一；`combo` 的数字选项；颜色夹取；
    - 等于默认值删键、空段去掉、无变化返回 `None`；
    - 未知键报错；
    - `localize` 的回退顺序，以及内置词条覆盖同名项目词条、非 `ui_` 键不查项目词条；
    - `resolve_web_user_props` 的叠加，以及「无默认值的 `file` 设置后才推」；
    - `file_allowed`：项目内文件、文件 grant 本身、目录 grant 内的文件放行；文件 grant 的同目录兄弟文件、
      目录 grant 之外、符号链接、目录本身、只有作者默认值没有用户值的路径，都拒绝。

## 点 2 — 按图改写 metadata 的原语（`kabegame-core/src/storage/images.rs`）

- **新增**
  - `Storage::rewrite_image_metadata(image_id, edit)`：在一个事务里完成「读当前行 → `edit` 给出新 data → 插新行 → 图片改指 → 删无引用的旧行」。
    - `edit` 返回 `None` 表示没有变化：回滚，什么都不写，返回 `Ok(None)`；
    - 新行照抄旧行的 `plugin_id` / `plugin_version` / `template`；
    - 搜索词映射从旧行拷贝（`INSERT INTO metadata_search_terms … SELECT ?new, term_id … WHERE metadata_id = ?old`），
      不重新展开新 data。文档注释写明：调用方保证改动不涉及可搜索文本；
    - 只改指这一张图。别的图（或 `task_failed_images`）还引用旧行时，旧行保留；
    - 图片不存在，或图片没有 metadata：返回 Err；
    - 不发事件，由调用方在提交后发。
```rust
/// 在一个事务里改写一张图的 metadata（metadata 按 id 不可变：改写 = 新行 + 改指）。
/// `edit` 收到当前 data，返回 None 表示不变（什么都不写）。新行沿用旧行的 plugin_id / plugin_version /
/// template 与搜索词映射——调用方保证改动不涉及可搜索文本。只改指 `image_id` 这一张；旧行没有别的
/// 引用（images / task_failed_images）才删除。返回新 metadata id，事件由调用方在返回后发送。
pub fn rewrite_image_metadata(
    &self,
    image_id: &str,
    edit: impl FnOnce(&Value) -> Result<Option<Value>, String>,
) -> Result<Option<i64>, String>;
```

- **新增**（测试）
  - 改写后图片指向新行、旧行被删、搜索词映射相同；
  - 两张图共享旧行时只改指一张、旧行保留；
  - `edit` 返回 `None` 时行数不变；
  - `edit` 报错时事务回滚。

## 点 3 — 属性视图与写命令（`kabegame/src/commands/wpe_web.rs`）

- **新增**
  - `WpeWebPropertiesView`：给面板的视图。
    - `items` 已排序、标签已本地化；
    - `value` 是当前生效值（用户值优先，都已归一）；
    - `modified` 表示存了用户值。
  - `get_wpe_web_properties(imageId)`：读视图。行不存在或不是 `x-wpe/web` 时返回 `None`。
  - `set_wpe_web_user_properties(imageId, changes)`：写入并返回保存后的视图。步骤：
    1. 在 blocking 线程里 `rewrite_image_metadata(id, |raw| apply_changes(raw, &changes))`；
    2. 返回 `Some(新 id)` 时发 `emit_image_fields([id], { metadataId })`，也就是 `image-changed { patch: { id, metadataId } }`；
    3. 重新组装视图返回。
  - 标签本地化：`localize(raw, wpe_language_code(Settings::global().get_resolved_language()), text, &builtin)`，
    `builtin` 先查 `wpe::locale::builtin_term`。属性标签和 `combo` 选项的 `label` 都走这一条（同 WPE）。
  - 没装 WPE 时，`ui_browse_properties_scheme_color` 退回 Rust i18n 的 `wpe.schemeColor`（几乎每张壁纸都有这一项）；其余保留原文。
- **修改**
  - `lib.rs`：在 `cfg(not(target_os = "android"))` 段注册两个命令。
  - `permissions/main.toml`：放行这两个命令。**不**加进 `wpe-web.toml`，页面不能写属性。
```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebPropertyItem {
    pub key: String,
    pub kind: WpePropKind,
    pub label: String,                 // 已本地化；可能含 HTML，前端净化后渲染
    pub condition: Option<String>,
    pub default: Option<Value>,        // 归一后的作者默认值（面板比较与「重置」显示用）
    pub value: Option<Value>,          // 当前生效值
    pub modified: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<WpeComboOption>,  // label 已本地化
    pub extensions: Vec<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebPropertiesView {
    pub image_id: String,
    pub metadata_id: Option<i64>,      // 面板按它判断事件补丁是否需要重读
    pub items: Vec<WpeWebPropertyItem>,
}

#[tauri::command]
pub async fn get_wpe_web_properties(image_id: String) -> Result<Option<WpeWebPropertiesView>, String>;

#[tauri::command]
pub async fn set_wpe_web_user_properties(
    image_id: String,
    changes: serde_json::Map<String, Value>,   // { key: 新值 | null }，null = 恢复默认
) -> Result<WpeWebPropertiesView, String>;
```

- **新增**（`src-tauri/kabegame-i18n/locales/*.yml`）
  - `wpe.schemeColor`，五种语言。

## 点 4 — 运行时：`file:` 放行加「追加放行」（`tauri-runtime-kbcef/src/file_access.rs`、`webview.rs`、`lib.rs`）

- **修改**
  - 现有 `FilePolicy`（6b 引入，含 `file_documents` / `app_local_resources` / `root`）增加 `grants` 字段，其余字段不动。
  - `set_file_document_root` 同时清空 `grants`。调用方：桌面导航（`show_web` 设新根，`show_app` 清空）、预览 `set_wpe_web_preview`（挂载设根、卸载清空）。
  - `file_document_root` 换成 `file_document_access(label) -> Option<FileAccess>`，返回 `root` 与 `grants` 的快照（`FilePolicy` 本身带能力位，不整份拷出）。
  - `check_file_request(url, &FilePolicy)` 放行的条件是以下任一成立：
    - 位于 `root` 内；
    - 规范化后等于某个文件 grant；
    - 位于某个目录 grant 内。
    `root` 与 `grants` 都为空时仍是 `NoRoot`。符号链接、目录、不存在的判定不变。
  - `webview.rs` 的调用点改成取整份策略，拒绝日志里补上 grants 个数。
- **新增**
  - `grant_file_documents(label, for_root, paths)`：
    - 当前 `root` 不等于 `for_root` 时什么都不做，在途的旧拉取不会把别的壁纸的文件放进来；
    - 每个路径先 `canonicalize` 并判断是文件还是目录，失败的跳过；
    - 去重后追加，只增不减。
  - `lib.rs` 公开 `grant_file_documents`，文档注释写明「只给嵌入方放行用户为当前页面选的文件」。
```rust
/// 追加放行的一项：文件只放行它本身，目录放行其中的普通文件。路径已 canonicalize。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Grant { pub path: PathBuf, pub is_dir: bool }    // 新增

#[derive(Debug, Default)]
struct FilePolicy {
    file_documents: bool,
    app_local_resources: bool,
    root: Option<PathBuf>,
    /// 追加放行：只增不减，换根即清空。只放用户为当前页面选的文件 / 目录。
    grants: Vec<Grant>,                                       // 新增
}

/// 闸门裁决用的快照：根目录 + 追加放行。
#[derive(Debug, Clone, Default)]
pub(crate) struct FileAccess { pub root: Option<PathBuf>, pub grants: Vec<Grant> }   // 新增

pub(crate) fn set_file_document_root(webview_label: &str, root: Option<PathBuf>) -> Result<(), String>;   // 修改：同时清空 grants
pub(crate) fn grant_file_documents(webview_label: &str, for_root: &Path, paths: &[PathBuf]) -> Result<(), String>; // 新增
pub(crate) fn file_document_access(webview_label: &str) -> Option<FileAccess>;   // 修改：替代 file_document_root
pub(crate) fn check_file_request(url: &str, access: &FileAccess) -> Result<PathBuf, FileDeny>;   // 修改：签名
```
- **新增**（测试）
  - 文件 grant 只放行它本身，同目录别的文件仍是 `OutsideRoot`；
  - 目录 grant 放行其中文件，放行不到目录之外；
  - 换根后 grants 清空；
  - `for_root` 不符时忽略；
  - 只有 grants、没有 root 时照样生效。

## 点 5 — 状态带目录文件，桌面拉取时追加放行（`kabegame/src/commands/wpe_web.rs`）

- **修改**
  - `WpeWebState` 增加 `directories`，结构是 `{ key: { mode, files } }`，只含设了值的 `directory` 属性。
    - `files` 是 `list_directory_files(dir, 10000)` 的结果，路径统一 `/` 分隔，与 `user` 里的值同形；
    - 列举在 blocking 线程里做。
  - `wpe_web_pull_state` 在返回之前，用组装状态时读到的同一份 metadata 算 `user_file_grants(raw)`（点 1），调
    `tauri_runtime_kbcef::grant_file_documents(label, &dir, &paths)`。`dir` 就是这次状态对应的壁纸目录。
    - `build_wpe_web_state` 因此改成同时返回 metadata 原文，不再为放行另读一次；
  - `get_wpe_web_state` 改为接 `webview` 参数，对调用方 label（主窗口）做同样的 `grant_file_documents(label, &dir, &grants)`；
    根目录不等于 `dir`（预览已切走）时运行时自动忽略。
```rust
pub struct WpeWebState {
    pub image_id: String,
    pub user: serde_json::Map<String, serde_json::Value>,
    pub general: WpeWebGeneral,
    /// 新增：directory 属性的文件列表；fetchall 由垫片按差异回调，ondemand 由垫片随机取。
    pub directories: BTreeMap<String, WpeWebDirectory>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebDirectory {
    pub mode: String,        // "fetchall" | "ondemand"（缺省按 fetchall）
    pub files: Vec<String>,
}

pub async fn wpe_web_pull_state<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Result<WpeWebState, String> {
    // …按 label 找 dir、按路径找行（不变）
    let (state, raw) = build_wpe_web_state_with_raw(&image.id).await?      // 修改：同时拿到 metadata 原文
        .ok_or_else(|| "web wallpaper row missing".to_string())?;
    let grants: Vec<PathBuf> = user_file_grants(&raw).into_iter().map(|g| g.path).collect();   // 新增：与端点同一份白名单
    if let Err(error) = tauri_runtime_kbcef::grant_file_documents(webview.label(), &dir, &grants) {
        eprintln!("[wpe-web] 追加放行失败: {error}");                        // 新增：放行失败不影响其余属性
    }
    Ok(state)
}
```

## 点 6 — 垫片：目录回调与随机取文件（`kabegame/src/webview_js/wpe_shim.js`）

- **修改**
  - `call(name, …args)` 支持多个参数。
  - `deliverFull`：推完用户属性后，对 `fetchall` 目录各回调一次 `userDirectoryFilesAddedOrChanged(key, 全部文件)`。
  - `receive` 的差异投递：对新旧状态里所有 `fetchall` 目录键按集合求差：
    - 消失的文件 → `userDirectoryFilesRemoved`；
    - 新出现的文件 → `userDirectoryFilesAddedOrChanged`；
    - 目录被清空或换掉，等于全删后全加。
  - `wallpaperRequestRandomFileForProperty(key, cb)`：在 `latest.directories[key].files` 里随机取一个，下一个任务里回调 `cb(key, file)`。
    - 首个状态到达前先排队；
    - 列表为空时不回调。
```js
function call(name) {
  var target = listener;
  var args = Array.prototype.slice.call(arguments, 1);              // 修改：多参数
  if (target && typeof target[name] === "function") {
    try { target[name].apply(target, args); } catch (error) { console.error("[kb-wpe] " + name, error); }
  }
}
function fetchallFiles(dirs, key) {
  var dir = dirs && dirs[key];
  return dir && dir.mode !== "ondemand" ? dir.files : [];
}
function deliverDirectories(prev, next) {                            // 新增
  var keys = {};
  Object.keys(prev || {}).concat(Object.keys(next || {})).forEach(function (key) { keys[key] = true; });
  Object.keys(keys).forEach(function (key) {
    var before = new Set(fetchallFiles(prev, key));
    var after = fetchallFiles(next, key);
    var afterSet = new Set(after);
    var removed = Array.from(before).filter(function (f) { return !afterSet.has(f); });
    var added = after.filter(function (f) { return !before.has(f); });
    if (removed.length) call("userDirectoryFilesRemoved", key, removed);
    if (added.length) call("userDirectoryFilesAddedOrChanged", key, added);
  });
}
function deliverFull(state) {
  call("applyUserProperties", clone(state.user));
  call("applyGeneralProperties", clone(state.general));
  deliverDirectories(null, state.directories);                       // 新增
  delivered = state;
}
// receive() 的差异分支在 applyGeneralProperties 之后加：deliverDirectories(delivered.directories, next.directories);

var randomQueue = [];                                                // 新增：首个状态到达前的请求
window.wallpaperRequestRandomFileForProperty = function (key, cb) {  // 修改：原为空实现
  if (typeof cb !== "function") return;
  if (!latest) return void randomQueue.push([key, cb]);
  answerRandom(key, cb);
};
function answerRandom(key, cb) {                                     // 新增
  var dir = latest.directories && latest.directories[key];
  var files = dir ? dir.files : [];
  if (!files.length) return;
  var file = files[Math.floor(Math.random() * files.length)];
  setTimeout(function () {
    try { cb(key, file); } catch (error) { console.error("[kb-wpe] random file", error); }
  }, 0);
}
// receive() 开头 latest = next 之后：清空 randomQueue 逐个 answerRandom
```

## 点 7 — 表单组件（`apps/kabegame/src/components/common/form/`）

- **修改**（`KbNumber.vue`）
  - float 模式也认 `step`：调用方传了正数就用作滑杆与步进器的步长，显示的小数位数取 `step` 的小数位数。
  - 不传 `step` 时行为不变（现有 float 调用方都不传）。
```ts
const props = defineProps<{
  // …
  /** 步进量：int 模式为按钮步进（默认 1）；float 模式为滑杆 / 步进器步长，并决定显示的小数位（不传按范围自动取，两位小数） */
  step?: number;                                                    // 修改：注释
  disabled?: boolean;
}>();

const explicitStep = computed(() =>                                 // 新增
  typeof props.step === "number" && Number.isFinite(props.step) && props.step > 0 ? props.step : undefined,
);
const sliderStep = computed(() => {
  if (!isFloat.value) return 1;
  if (explicitStep.value) return explicitStep.value;                // 新增
  // …原有按范围取步长不变
});
const fractionDigits = computed(() => (explicitStep.value ? decimalsOf(explicitStep.value) : 2));   // 新增
function formatNumber(v: number): string {
  return isFloat.value ? v.toFixed(fractionDigits.value) : String(Math.round(v));   // 修改
}
// 模板里 KbStepper 的 :precision 同样改用 fractionDigits
```

- **新增**（`KbColor.vue`）
  - 通用取色：包一层 `el-color-picker`，不带透明度，进出都是 `#rrggbb`，在 `change`（确认）时才提交。
  - 不认识 WPE 格式，换算放在 `WpePropertyField`。
```vue
<template>
  <el-color-picker
    :model-value="hex"
    :show-alpha="false"
    @change="(value) => value && emit('update:modelValue', value)"
  />
</template>
<script setup lang="ts">
const props = defineProps<{ modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const hex = computed(() => (typeof props.modelValue === "string" ? props.modelValue : null));
</script>
```

## 点 8 — 显示条件、标签净化、颜色换算（`apps/kabegame/src/utils/wpeProperties.ts`，新）

- **新增**
  - `evaluateWpeCondition(expr, valueOf)`：显示条件求值，不用 `eval` / `new Function`。照 WPE 的 `$parse.readOnly`（API.md 第一节）实现同一份白名单，作者条件在两边的显隐结果一致。
    - **词法**：
      - 标识符 `[A-Za-z_$][A-Za-z0-9_$]*`；
      - 十进制数字（可带指数）；单 / 双引号字符串（支持转义）；
      - `true` / `false` / `null` / `undefined`；
      - 运算符 `+ - * / % === !== == != < > <= >= && || ! ? :`，以及 `( ) [ ] . ,`。
      - 其它字符（`?.`、`??`、模板字符串、正则、位运算、`|`、`=`、`;`、`{`）一律算解析失败。
    - **允许的节点**：
      - 字面量；一元 `! + -`；二元 `+ - * / % === !== == != < > <= >=`；`&&` / `||`；三元 `?:`；
      - 数组字面量：元素必须是原始值，不嵌套，最多 1024 项；
      - 成员：`<键>.value`、`<任意>.length`、`<任意>[非负整数]`。后两种只作用于字符串或数组字面量，接收方是 `null` / `undefined` 时得 `undefined`，下标越界得 `undefined`；
      - 方法调用：`split` / `includes` / `indexOf` / `startsWith` / `endsWith`，最多 2 个参数。
        - 接收方是 `null` / `undefined` 时得 `undefined`，不算失败；
        - `startsWith` / `endsWith` / `split` 的接收方不是字符串时算失败；
        - `includes` / `indexOf` 也可用于数组字面量，`includes` 按 SameValueZero 比较。
    - **不允许**：单独的标识符、`a.value.b`、其它任何方法（`toLowerCase`、`trim`、`slice`……）、`Math.*`、辅助函数调用。
      WPE 只有内置对齐属性用 `checkPositionVisibility()`，作者用不到。
    - **语义**：
      - `<键>.value` 是当前生效值（含草稿）。键不存在得 `undefined`；值不是原始类型算失败；
      - `+` 遇 `undefined` 返回另一侧，`-` 把 `undefined` 当 0；
      - `==` / `!=` 是 JS 宽松相等（只涉及原始值，按规范的 ToNumber / ToPrimitive 规则实现）；
      - `&&` / `||` 短路并返回操作数本身，最终结果按 JS 真值判定。
    - **限额**：表达式超过 2048 字符、AST 超过 256 个节点或深度超过 32，算失败。
    - **失败一律返回 `true`**（显示），每个表达式只警告一次。解析结果按表达式字符串缓存，失败也缓存。
  - `sanitizeWpeLabel(html)`：DOMPurify 净化，结果按原文缓存。
    - 元素白名单取 ngSanitize 默认的块级与行内元素（`h1–h6 div p ul ol li table … hr pre blockquote b i u s small big strong em span font br sub sup code mark` 等），
      另去掉 `a`（保留文字）、`img`、`svg`：面板里不点外链、不加载远程资源；
    - 属性只留 `color face size align title`。不留 `class`（会撞上应用的 CSS），也不留 `style`。
  - `wpeLabelText(html)`：净化后取纯文本，给分组标题与 `KbSelect` 选项文字用。WPE 的分组标题是文本插值，HTML 会原样显示成字面文字，这里干脆去掉标签。
  - `wpeColorToHex("r g b")` / `hexToWpeColor("#rrggbb")`：分量是 `c / 255` 的完整精度，与 WPE 写法一致。
```ts
// 文法（解析出 AST 后再按白名单逐节点解释，照 WPE 的 $parse.readOnly）：
//   expr    := ternary
//   ternary := or ("?" ternary ":" ternary)?
//   or      := and ("||" and)*
//   and     := eq ("&&" eq)*
//   eq      := rel (("===" | "!==" | "==" | "!=") rel)*
//   rel     := add (("<" | "<=" | ">" | ">=") add)*
//   add     := mul (("+" | "-") mul)*
//   mul     := unary (("*" | "/" | "%") unary)*
//   unary   := ("!" | "+" | "-") unary | postfix
//   postfix := primary ("." ident ("(" args? ")")? | "[" expr "]")*
//   primary := number | string | true | false | null | undefined | ident | "[" elements? "]" | "(" expr ")"
export function evaluateWpeCondition(expr: string, valueOf: (key: string) => unknown): boolean;
export function sanitizeWpeLabel(html: string): string;
export function wpeLabelText(html: string): string;
export function wpeColorToHex(value: unknown): string | null;
export function hexToWpeColor(hex: string): string;
```
- **新增**（`wpeProperties.test.ts`）
  - 样例里的全部条件写法：
    - 裸 `.value`、`== 'contain'`、`> 100`、`&&`；
    - `endsWith(...) === true`、`startsWith(...) === false`、`!==`；
    - 无空格的 `alignment.value<2`；
  - 白名单内、样例之外的写法：`includes` / `indexOf`、`['a','b'].includes(x.value)`、`.length > 0`、`[0] == '#'`、`split(',').length`、三元、算术、`=== undefined`；
  - 宽松相等：`'1' == 1`、`true == 1`、`null == undefined`；
  - 必须返回 `true` 的情况：
    - 语法错误；`toLowerCase()`、`Math.max()`、单独的标识符、`a.value.b`、`?.`；
    - `startsWith` 用在数字上；
    - 超过 2048 字符；
  - 键不存在时 `x.value === undefined` 为真，接收方为 `null` 的方法调用得 `undefined`；
  - 净化去掉 `<script>`、`onclick`、`<a href>`、`<img>`、`style`、`class`，保留 `<font color>`；
  - 颜色往返。

## 点 9 — 面板数据（`apps/kabegame/src/composables/useWpeWebProperties.ts`，新）

- **新增**
  - `useWpeWebProperties(imageId)`：
    - 读：`get_wpe_web_properties`。每次请求取递增序号，只落地比已落地更新的结果（同垫片的拉取编号）；
    - 重读的触发：
      - `imageId` 变化；
      - `image-changed` / `images-change` 里有本张的 `metadataId` 补丁，且与 `view.metadataId` 不同；
      - `setting-change` 带 `language`；
    - 草稿：`set(key, value)` 写进 `draft`，`reset(key)` 写 `null`，`resetAll()` 对所有 `modified` 的键写 `null`；
    - 写：草稿变化后 300ms 无新改动才发 `set_wpe_web_user_properties`，同一时刻最多一个在途，在途期间的新改动等它结束后再发。返回的视图按同一套序号落地；
    - 写成功后，从草稿里删掉「值仍等于发出时的值」的键。写失败时提示错误，删掉这批草稿并重读；
    - `imageId` 变化或作用域销毁时，有未发的草稿就立即按原 id 发出，不等防抖；
    - `valueOf(key)`：草稿优先（`null` 表示默认值），否则取 `view` 里的当前值；
    - `isModified(item)`：草稿里有值时，看它是否不等于默认值；否则看 `item.modified`。
```ts
export interface WpeWebPropertyItem {
  key: string;
  kind: "color" | "slider" | "bool" | "combo" | "textinput" | "file" | "directory" | "group" | "text";
  label: string;
  condition?: string | null;
  default?: unknown;
  value?: unknown;
  modified: boolean;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  options: { label: string; value: string | number }[];
  extensions: string[];
  mode?: string | null;
}

export function useWpeWebProperties(imageId: Ref<string | null | undefined>): {
  view: Readonly<ShallowRef<WpeWebPropertiesView | null>>;
  loading: Readonly<Ref<boolean>>;
  error: Readonly<Ref<string | null>>;
  valueOf(key: string): unknown;
  isModified(item: WpeWebPropertyItem): boolean;
  set(key: string, value: unknown): void;
  reset(key: string): void;
  resetAll(): void;
  reload(): void;
};
```
- 事件直接用 `kbEvent$`（主窗口有 IPC），不经 `useTauriProxy`。

## 点 10 — 面板组件（`apps/kabegame/src/components/wallpaper/`，新）

- **新增**（`WpePropertyField.vue`）：按类型分发，与 `PluginVar.vue` 同一个写法。

| 类型 | 组件 | 换算 |
|---|---|---|
| `bool` | `KbBoolean` | — |
| `slider` | `KbNumber type="float"` | `step` 取作者值；没给且 `min` / `max` 都是整数时传 1（WPE 的整数滑块）；否则不传，按范围自动取 |
| `combo` | `KbSelect` | 选项映射成 `{ name: wpeLabelText(label), variable: String(index) }`，回写时按下标还原成原始 `value`（可能是数字） |
| `color` | `KbColor` | `wpeColorToHex` / `hexToWpeColor` |
| `textinput` | `KbText` | — |
| `file` | `KbPath type="file" allow-unset` | `:file-extensions="item.extensions"`，清空写 `""` |
| `directory` | `KbPath type="folder" allow-unset` | 清空写 `""` |

- **新增**（`WpeWebPropertiesPanel.vue`）
  - 外壳用 `CollapsibleDrawerPanel`，`storage-key="kabegame-image-detail-wpe-props-open"`，标题为「壁纸属性」。有改过的键时，`#trailing` 放「全部重置」。
  - 分段（照 WPE，现状锚点 k）：
    - 按 `items` 顺序遍历，遇到 `group` 开一段新分段，到下一个 `group` 为止；第一个 `group` 之前的条目是没有标题的首段；
    - `group` 自己的条件为假：整段连同组内条目一起隐藏；
    - 组内条目再各自按条件隐藏。条件为假只是不渲染，值不变，没有「禁用」状态；
    - 有标题的分段可折叠，默认折叠（同 WPE），折叠状态不持久化；
    - 段内条目全部隐藏时，连标题一起不显示。WPE 这种情况仍显示空组，这里不跟。
  - 文字：分组标题与 `combo` 选项用 `wpeLabelText`（纯文本），属性标签与 `text` 说明行用 `sanitizeWpeLabel` 后 `v-html`。
  - 条目：
    - `text`：净化后的说明块（次要文字色）；
    - 其它：标签（净化后 `v-html`）、改过时的「重置」小按钮、字段；
    - `bool` 与 `color` 和标签同一行，其余字段在标签下方（侧栏窄）；
    - `file` / `directory` 在预览里也生效（Phase 6a + 点 5），不加提示。
  - 加载、错误（带重试）、空态的写法同 `ImageNativeMetadataPanel`。空态文案是「这张壁纸没有可调属性」。
  - 样式：标签里的 `h1–h6` 限制字号；其余用 UnoCSS 工具类。
  - 面板只接 `imageId`，不接整行图片：数据全部来自 `useWpeWebProperties`。
```vue
<CollapsibleDrawerPanel
  class="wpe-web-properties-panel"
  storage-key="kabegame-image-detail-wpe-props-open"
  :collapsible="collapsible"
  :fill-when-expanded="fillWhenExpanded"
  :toggle-aria-label="t('gallery.wpePropsTitle')"
>
  <template #title>{{ t("gallery.wpePropsTitle") }}</template>
  <template #trailing>
    <el-button v-if="anyModified" text size="small" @click="resetAll">{{ t("gallery.wpePropsResetAll") }}</el-button>
  </template>
  <div class="wpe-props-body kb-selectable">
    <!-- loading / error / empty 同 ImageNativeMetadataPanel -->
    <!-- sections 已按条件过滤：组条件为假的整段、条目全隐藏的段都不在里面 -->
    <section v-for="section in sections" :key="section.key" class="wpe-props-section">
      <button v-if="section.group" type="button" class="wpe-props-group" @click="toggleGroup(section.key)">
        {{ wpeLabelText(section.group.label) }}
      </button>
      <template v-for="item in section.open ? section.items : []" :key="item.key">
        <div v-if="item.kind === 'text'" class="wpe-props-text" v-html="sanitizeWpeLabel(item.label)" />
        <div v-else class="wpe-props-row" :class="{ 'wpe-props-row--inline': isInline(item) }">
          <div class="wpe-props-label">
            <span v-html="sanitizeWpeLabel(item.label)" />
            <el-button v-if="isModified(item)" text circle size="small" :title="t('gallery.wpePropsReset')" @click="reset(item.key)">
              <el-icon><RefreshLeft /></el-icon>
            </el-button>
          </div>
          <WpePropertyField :item="item" :model-value="valueOf(item.key)" @update:model-value="set(item.key, $event)" />
        </div>
      </template>
    </section>
  </div>
</CollapsibleDrawerPanel>
```

- **新增**（`WpeWebPropertiesDialog.vue`）：设置页用的弹窗，外壳是 `el-dialog`，里面放 `WpeWebPropertiesPanel :collapsible="false"`，并调 `useModalBack(visible)`。

## 点 11 — 入口（`ImagePreviewDialog.vue`、`Settings.vue`）

- **修改**（`ImagePreviewDialog.vue`，桌面 Dialog 分支的右栏）
  - `x-wpe/web` 行换成属性面板，其余行不变。WPE 行原来在这里显示的原始 `project.json` 键值对没有用处。
```vue
<div class="preview-detail-drawer-scroll preview-detail-drawer-scroll-right">
  <!-- 新增：网页壁纸显示属性面板；其它行仍是插件详情 -->
  <WpeWebPropertiesPanel
    v-if="previewImage && isWpeWebType(previewImage.type)"
    :image-id="previewImage.id"
    fill-when-expanded
  />
  <ImagePluginDescriptionPanel v-else :image="previewImage" fill-when-expanded />
</div>
```
  - `utils/mediaMime.ts` 若还没有 `isWpeWebType`，就照 `isWpeVideoType` 补一个。

- **修改**（`Settings.vue`）
  - 监听 `currentWallpaperImageId` 的那个 watch 里，顺带 `fetchImageById` 判断当前壁纸是不是 `x-wpe/web`。
  - 是的话，「当前壁纸」那一行在路径按钮旁加「壁纸属性」按钮，打开 `WpeWebPropertiesDialog`。
```vue
<SettingRow v-if="currentWallpaperPath" :label="$t('settings.wallpaperCurrent')">
  <button type="button" class="setting-current-wallpaper-path" @click="openCurrentWallpaperPath">
    {{ currentWallpaperPath }}
  </button>
  <!-- 新增 -->
  <el-button v-if="currentWallpaperIsWeb" size="small" @click="wpePropsOpen = true">
    {{ $t("settings.wallpaperCurrentProperties") }}
  </el-button>
</SettingRow>
<!-- 新增 -->
<WpeWebPropertiesDialog v-model="wpePropsOpen" :image-id="currentWallpaperImageId" />
```

## 点 12 — 文案（`packages/kabegame-i18n/src/locales/*/`）

- **新增**（五种语言）
  - `gallery.json`：
    - `wpePropsTitle`「壁纸属性」、`wpePropsResetAll`「全部重置」、`wpePropsReset`「恢复默认」；
    - `wpePropsEmpty`「这张壁纸没有可调属性」；
    - `wpePropsLoadFailed`、`wpePropsSaveFailed`；
  - `settings.json`：`wallpaperCurrentProperties`「壁纸属性」。

## 点 13 — 文档与回归

- **修改**
  - `cocs/wpe/WPE_IMPORT.md`：新增「用户属性」一节，内容包括：
    - 存储形态；
    - `rewrite_image_metadata` 的语义；
    - 视图与写命令；
    - 面板的触发与写入节奏；
    - 条件子集；
    - `file` / `directory`：共用白名单、按调用方 label 的追加放行（桌面与预览同一套，预览根目录来自 Phase 6a）；
  - `cocs/README.md`：WPE 条目补「用户属性面板 / `userProperties` / 追加放行」，以及对应的适用场景。
  - `AGENTS.md`：WPE 那条补一句「用户属性存 metadata `userProperties`，改写走 `rewrite_image_metadata` + `metadataId` 补丁」。
  - `src-tauri/tauri-runtime-kbcef/README.md`：`file:` 策略一节补 `grant_file_documents`。
  - `API.md`：兼容矩阵里的 `applyUserProperties` 增量推送（触发）、`localization`、`condition`、`file`、`directory` 改成「已完成（7）」；
    `wallpaperRequestRandomFileForProperty` 也一并改。
    - 难点一标记已解决：两种宿主同一套追加放行（已于 2026-10-28 追记）；
    - §5.3 两种宿主的对照表补「本地文件」一行。
  - `PLAN.md`：
    - 状态行与文件列表；
    - Phase 7 一节改成指向本文件的要点；
    - 去掉「`get_current_wallpaper_target` 返回合并后属性」这一项（视频不在范围内）。
  - `versions/latest/regression.md`：新增 Phase 7 一节，用例见下。
  - `versions/latest/changelog.md`：
    - 用户向：「网页壁纸可在预览详情栏与设置页调整作者提供的属性，桌面壁纸实时生效」；
    - 开发向：一行。

## 验证

- `check-kabegame`（vue-tsc + cargo check）通过。
- 单测：
  - `test-kabegame` 跑 `kabegame-core wpe::`（点 1、2）；
  - runtime `file_access`（点 4）；
  - 前端 `wpeProperties.test.ts`（点 8）。
  - dev 在跑时用 `CARGO_TARGET_DIR=D:/Codes/kabegame/target-check`。
- 真机（Windows，dev 由用户跑；改了垫片或 runtime 要完全重启 dev，helper 只在 dev 启动时预构建）：
  1. 预览 kaguya：右栏是「壁纸属性」，有 3 个颜色、3 个滑块、1 个文件。
     - `schemecolor` 在简体中文下显示「主题配色」，这是 WPE 内置词表 `ui_zh-chs.json` 里的译文；
     - 普通图片的右栏仍是插件详情。
  2. 改 `text_color`：预览 iframe 与桌面壁纸的文字颜色都变；metadata 只多了 `userProperties.text_color`，图片的 `metadata_id` 已换，旧行已删。
  3. `playback_rate` 滑块只落在 0.25 的倍数上，输入框显示两位小数；快速来回拖动时没有报错，最终值落库，页面跟上。
  4. 单键「恢复默认」与「全部重置」：对应键 / 整段 `userProperties` 消失，页面收到作者默认值。
  5. Slideshow：
     - 7 个分组默认折叠，点开后显示组内属性；第一个分组之前的属性不在任何组里；
     - `backgroundImageVisible` 开关让相关行出现 / 消失，关掉再打开时原来的值还在；
     - 分组标题是纯文本；HTML 说明行正常排版，没有残留脚本或属性；
     - `combo` 选择后页面生效。
  6. 切换界面语言：面板重读，不丢草稿。
  7. `file`：kaguya 的 `custom_user_bg` 选一张壁纸目录之外的图，预览与桌面的背景都换成它，stderr 没有对它的 `deny file:`；清空后恢复作者默认。
  8. `directory`（本次修订的主要目标）：Slideshow 的 `customdirectory` 选一个文件夹，预览与桌面的幻灯片都显示其中的图片；
     换文件夹后旧文件夹的图在两边都停止出现（页面收到 `userDirectoryFilesRemoved`）。追加放行只增不减（点 4），旧文件夹在本次导航前仍可读；
     关掉预览重开、桌面切走再切回之后，旧路径的请求才有 `deny file:` 日志（2026-10-31 验收时按点 4 改正，原写法与只增不减矛盾）。
  8b. 白名单：预览 iframe 里 CDP `fetch` 目录属性之外的文件、文件属性同目录的兄弟文件、`C:/Windows/win.ini`，都被拒并有 `deny` 日志；
     项目目录内文件、当前选的文件、目录里的文件都成功。
  9. 设置页：当前壁纸是网页壁纸时出现「壁纸属性」按钮，弹窗里改，预览面板随之更新；当前壁纸不是网页壁纸时没有按钮。
  10. 预览里改完立刻切到下一张：改动落在原图上，没有串到下一张。
  11. 下拉、取色的弹层不被预览弹窗遮住（预览 `el-dialog` 的 `z-index` 是显式值），被遮住就给弹层设 `popper-class` / `z-index`。

## 关键决策（2026-10-31 全部确认，均按推荐项）

1. **范围只做 `x-wpe/web`**（推荐，**已定**）。视频行的 `general.properties` 也有对齐、倍速等，但它们与 Kabegame 的壁纸样式、音量、倍速设置重叠，放进来要先定两者的优先级。
2. ~~**显示条件用自写的受限解析器**~~ **已定**（2026-10-28 静态分析）：WPE 自己就是白名单解释器（`$parse.readOnly`），不认识的一律当 true。
   Kabegame 照同一份白名单实现（点 8），连「失败当 true」也一致。否则同一张壁纸在两边的显隐会不同。
3. **本地化在 Rust**（推荐，**已定**）。语言映射只有 `wpe_language_code` 一份；代价是语言变化时面板要重读一次。
   查找顺序照 WPE：当前语言 → `en-us` → 原文，每级里 WPE 内置词条覆盖项目词条。
4. **WPE 内置词条从用户的 WPE 安装目录只读读取**（推荐，**已定**：运行时只读读取 `locale\ui_<码>.json`）。词条只决定显示文字，不影响取值和显隐。
   属性可以引用 WPE 整张界面词表（3325 个 `ui_` 键），不只是专给属性用的 52 个 `ui_browse_properties_*`。
   本机统计（API.md 第一节）：
   - web 与 video 壁纸只用到 `ui_browse_properties_scheme_color`；
   - scene 壁纸用了 20 余条，其中有 `ui_editor_properties_*`，第三阶段会碰到。
   可选做法：
   - **运行时读 `<安装目录>\locale\ui_<码>.json`**（推荐）：译文与 WPE 完全一致，36 种语言都有，不把 WPE 的译文带进仓库，scene 也直接受益。
     导入 WPE 壁纸的用户几乎都装着 WPE；没装时 `scheme_color` 退回 Kabegame 自己的翻译，其余显示原文；
   - Kabegame 自己翻一份常用词条：web 眼下只需要 `scheme_color` 一条，但到 scene 要补几十条、维护五种语言，说法也和 WPE 不一致；
   - 只显示原文键名：零成本，但 `ui_browse_properties_scheme_color` 这种键名直接露给用户。
5. **写入节奏：草稿即时 + 300ms 防抖串行写**（推荐，**已定**）。拖滑块期间页面约每 300ms 跟一次，每次写一行新 metadata。备选是只在松手 / 失焦时提交：写得更少，但拖动时页面不跟。
6. **改回默认值就删键**（推荐，**已定**）。`userProperties` 只反映「用户改过什么」，「全部重置」后 metadata 与导入时一致。
7. **用户值不进搜索**（推荐，**已定**）。改写时搜索词沿用旧行；用户填的文本、选的路径搜不到。
8. ~~**`file` / `directory` 只在桌面生效**~~ **已定**（2026-10-28，用户指定）：桌面与预览都生效，经 Phase 6a 同一套运行时拦截 + 本 Phase 的追加放行。
   - 目录递归列举，只留 `browser_safe` 格式，最多 10000 个；
   - 不监视目录变化。
   WPE 自己是否递归、推给页面的 `directory` 值是什么格式都没确认，第一版推路径字符串。
9. **不认 WPE 的 `editable`**：滑块总带输入框（**已定**）。
