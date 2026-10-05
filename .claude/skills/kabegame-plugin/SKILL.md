---
name: kabegame-plugin
description: 编写新的 Kabegame 爬虫插件、或修改已有插件（src-crawler-plugins/plugins/<id>/）的完整工作流 —— 先用 curl/探针把「列表页 → 详情页/JSON → 媒体 URL → 媒体字节」这条链路逐环实测打通，再写成 V8 或 WebView 插件代码（每张图都带能还原详情页的 JSON metadata、labels 标签数组，以及还原源站详情样式的 description.ejs），最后真跑验证（V8 用 release kabegame-cli 以测试 id 直接运行 .kgpg，WebView 在 dev app 里经 CDP 跑）。凡是要给某个网站加爬虫/收集源、适配站点改版、修插件抓不到图/下载失败/选择器失效、给插件加新模式或配置项、把 V8 插件改成 WebView（或反之）时都用本 skill，即使用户只说「帮我爬一下 xx 站」「这个插件坏了」。
---

# Kabegame 插件编写

插件是 `src-crawler-plugins/plugins/<id>/` 下的 JS/TS 包，打成 `.kgpg` 后由应用加载。
本 skill 的核心约束是**每一步都绑着一个验证**：上一环没有拿到实测证据，就不进下一环。
爬虫失败几乎都发生在「以为页面里有、其实没有」「以为能直拉、其实要 Referer」这类假设上，
写完代码再跑才发现，返工成本是逐环验证的好几倍。

所有路径相对仓库根。脚本在 `.claude/skills/kabegame-plugin/scripts/`，下文记作 `$K`：

```bash
K=.claude/skills/kabegame-plugin/scripts
```

| 脚本 | 用途 |
|---|---|
| `$K/probe.ts get <url> [-o f]` | 取页：状态/最终 URL/标题/内嵌 state/反爬信号 |
| `$K/probe.ts sel <file\|url> <css> [attr\|@text\|@html]` | 选择器实测（与插件 V8 运行时同一个 deno-dom） |
| `$K/probe.ts json <file\|url> [a.b.0]` | JSON 或 HTML 内嵌 state 的结构概览 |
| `$K/probe.ts media <url> [--referer R]` | Range 拉前 64 字节，按魔数判定是不是真媒体 |
| `$K/deploy.sh <id>` | 构建 + 打包到 `.kabegame/debug/data/plugins-directory/<id>.kgpg` |
| `$K/run-cli.sh <id> [--id T] [--secs N] [--var k=v]…` | deploy → release CLI `plugin run <kgpg> --id <id>-test`，限时取消并摘要 |
| `$K/app-run.sh <id> '<userConfig JSON>' [--secs N]` | 在 dev app 里跑任务（WebView 插件唯一验证途径） |
| `$K/render-desc.ts <id> --db [--where <sql>]` | 从库里取真实 metadata 渲染 `description.ejs` 并截图 |

`probe.ts` 用 `deno run -A $K/probe.ts …` 调。所有 probe 都带 Chrome UA；需要时加
`--referer` / `--cookie` / `-H "K: V"`。把中间文件放 scratchpad，别放仓库里。

## 第 0 步：弄清需求，定后端

先确认：目标站点和入口（排行/搜索/作者/标签/单个作品…）、要哪些配置项、是新插件还是改旧插件。

**改已有插件**：先读 `plugins/<id>/package.json`（`kbBackend`、`main`、`kbConfig`）和源码入口，
然后**先跑一次复现**（V8 用 `run-cli.sh`，WebView 用 `app-run.sh`），拿到失败的那一环再动手。
别凭报错描述猜——站点改版、配置写错、登录失效、去重跳过，日志长得完全不一样。

**选后端**——默认 V8，只在必要时 WebView：

| 选 V8（`kbBackend: "v8"`） | 选 WebView（`kbBackend: "webview"`） |
|---|---|
| curl 能拿到含数据的 HTML 或 JSON API | 内容只能由浏览器 JS 渲染、且找不到可直调的 API |
| 鉴权只靠 Cookie/Header（可 `Kabegame.requireCookie()` 借畅游登录态） | 请求签名在页面 JS 里算（如 xhs 的 `x-s`）、或有 JS 质询 |
| 要能在 Android、CLI 上跑 | 只需桌面；要滚动加载、点击交互、页面自发下载 |

判断依据来自第 1 步的实测，不是来自对站点的印象。V8 能跑的就别上 WebView：WebView
只能在桌面 app 里跑，开窗慢，验证也更麻烦。

## 第 1 步：取页面 —— curl 优先

```bash
deno run -A $K/probe.ts get 'https://site/list?page=1' -o $SP/list.html
```

**验证门槛**：`status 200`、`✓ 未见拦截信号`，并且你要找的东西（作品链接/标题）确实出现在
HTML 文字或 `内嵌state` 里——用 `grep -c` 或下一步的 `sel` 确认，别只看状态码。

失败时按顺序排查：
1. **数据在 XHR 里**：页面是空壳但站点有 API。到 HTML 里搜 `api/`、`fetch(`、`.json`，
   或者在畅游/浏览器 DevTools 里看网络请求，然后直接 `probe.ts get` 那个 API。能直调 API
   就仍是 V8。即使 HTML 能解析，有 JSON API 也优先用 API，它比页面 DOM 稳定得多。
   按框架找接口和参数，比翻打包后的 JS 快：
   - **接口文档**：试 `/api/openapi.json`、`/openapi.json`、`/api/v1/openapi.json`、`/docs`、
     `/swagger.json`（错误响应是 `{"detail":"Not Found"}` 时多半是 FastAPI）。文档里有全部参数和
     枚举值（排序字段、过滤条件），还常有一次带回关联数据的开关（如 `include_comments`），
     能省掉逐条请求；
   - **SvelteKit**：页面路径后加 `/__data.json`（如 `/images/top/__data.json?period=week`），
     返回这个路由 load 函数的数据，能看到页面用了哪些参数、默认值和结果；格式是 devalue，
     只作参考，插件里别解析它；
   - **Next.js**：`<script id="__NEXT_DATA__">`，或者 `/_next/data/<buildId>/<path>.json`；
     **Nuxt**：`window.__NUXT__`。`probe.ts get` 的「内嵌state」一行会把这些列出来。
   - 页面上切换排序/范围的是按钮而不是链接时，参数一般在 `__data.json` 或接口文档里，不在 HTML 里。
2. **要登录**：用户先在 app 的「畅游」里登录该站，插件里 `Kabegame.requireCookie()` 注入；
   探针阶段用 `--cookie` 手动带上同样的 Cookie 复现。
3. **Cloudflare/JS 质询、签名参数**：curl 走不通，转 WebView。这时用 `kabegame-chromium`
   skill 连上正在跑的 dev app（`deno task dev -c kabegame` 由用户自己启动），在 app 自己的
   Chromium 里访问页面：
   ```bash
   C=.claude/skills/kabegame-chromium/driver.sh
   $C targets                                   # 找畅游(surf)或 crawler-<taskId> 窗口
   $C eval 'location.href' --url surf
   $C eval 'document.documentElement.outerHTML.length' --url surf
   $C eval 'Object.keys(window.__INITIAL_STATE__||{})' --url surf
   ```
   拿到的 `outerHTML` 可存成文件，后面照样用 `probe.ts sel/json` 分析。
   **验证门槛**同上：真实渲染后的 DOM/state 里有目标数据。

## 第 2 步：提取结构 —— 找到通向图片的字段

列表页 → 详情链接 → 详情页 → 原图 URL，每一跳都要实测出**具体的选择器或 JSON 路径**：

```bash
deno run -A $K/probe.ts sel $SP/list.html 'article .item a[href]' href
deno run -A $K/probe.ts get 'https://site/post/123' -o $SP/post.html
deno run -A $K/probe.ts sel $SP/post.html 'a.download' href
deno run -A $K/probe.ts json $SP/post.html                      # 有内嵌 state 时看结构
deno run -A $K/probe.ts json $SP/post.html __INITIAL_STATE__.note.noteDetailMap
```

**验证门槛**：
- 列表选择器的命中数等于页面上肉眼可见的作品数，而不是 0 或者把导航链接也算进去；
- 至少两个不同详情页用同一个选择器都能取到原图 URL，别只验证一个样本；
- 优先取**原图**：留意 `-thumb`、`/resize/`、`_300x`、`?w=` 这类缩略图标记，找下载按钮、
  `srcset` 里最大的那张，或者 JSON 里 `original` / `raw` / `urlDefault` 一类的字段。
- 翻页：确认第 2 页 URL 规律，或者 API 的 `next` / `cursor` 字段，以及最后一页长什么样。
- **数据源和源站页面不是同一个东西时**（用 API 去复现网页上的列表、排行、搜索），要和源站页面
  **逐项比对**：拿网页（或 `__data.json`）上每个模式/范围前两页的 ID 序列，和你拼出来的 API 结果
  对照，顺序、条数、总数都一致才算通过。只比第一条或只看「有数据」不够——默认过滤
  （已删除/重复/待审核的状态值）、最少票数这类隐含条件，往往只有逐项比才暴露；
  也要确认过滤发生在**分页之前还是之后**（网页先分页再隐藏时，页码会和服务端过滤的结果错开）。

同时把**源站详情页**也当成要还原的对象：详情页上展示的每一块（上传者/作者、标签及其分类、
尺寸/大小/评分/收藏/来源等信息、简介、评论…）都要找到对应的数据来源。列表 API 没有的
（常见是评论），去找详情或评论接口，用 `probe.ts get/json` 实测。再给源站详情页截一张图，
作为后面写模板时对照的样本：

```bash
# SSR 页面：去掉脚本、补 <base> 后用无头 Chrome 截图（客户端水合在无头环境常常报错）
python3 -c "import re,sys;h=open(sys.argv[1]).read();h=re.sub(r'<script\b[^>]*>.*?</script>','',h,flags=re.S);open(sys.argv[2],'w').write(h.replace('<head>','<head><base href=\"https://site/\">',1))" $SP/post.html $SP/post-static.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1400,2000 --virtual-time-budget=6000 --screenshot=$SP/post.png "file://$SP/post-static.html"
```

站点 CSS 里的配色变量（标签分类色、卡片、用户组颜色）可以从页面引用的 `.css` 里直接 grep，
模板照抄这些值最接近原样。纯客户端渲染的站点，改用 `kabegame-chromium` 在畅游窗口里截图。

## 第 3 步：拉取媒体 —— 证明字节可得

```bash
deno run -A $K/probe.ts media 'https://cdn.site/img/123.jpg'
deno run -A $K/probe.ts media 'https://cdn.site/img/123.jpg' --referer 'https://site/post/123'
```

**验证门槛**：`✓ 媒体可直接拉取`，`magic` 是 jpeg/png/webp/mp4 等真实格式。`magic` 是
HTML 或 JSON 说明拿到的是防盗链页或错误响应，不算通过。需要 Referer 或 Cookie 才能拉，
就记下来：插件里用 `Kabegame.setHeader("Referer", …)`，或者 `requireCookie()`。

到这里你手上应该有一条**完整的、实测过的链路笔记**（入口 URL 规律 → 选择器/JSON 路径 →
原图 URL 规律 → 需要的请求头），写代码只是把它翻译过去。链路有任何一环没实测过，回到对应步骤。

## 第 4 步：写插件代码

按后端读对应参考，里面有宿主 API、`package.json` 要点和最小骨架：
- V8：[references/v8.md](references/v8.md)
- WebView：[references/webview.md](references/webview.md)

新插件**复制一个结构相近的现有插件起步**，然后改 `name`、`kbBaseUrl`、`kbConfig`、源码：
V8 + TS 打包选 `plugins/wallspic`（小）或 `plugins/anihonet-wallpaper`（多模式、metadata 齐全）；
WebView 选 `plugins/xhs-webview`。不要用 `kabegame-cli plugin new`，它的产物目录结构不对。

写代码时守住这几条：
- `package.json` 的 `kbLabels` 只能用 6 个内置 id（如 R-18 站点用 `content.nsfw`），`kbConfig` 只有
  8 种类型（`int` / `float` / `string` / `boolean` / `date` / `options` / `list` / `checkbox`），
  两者的完整清单、字段和脚本拿到的值形态见 [references/manifest.md](references/manifest.md)。
- 选择器、URL 规律、请求头**逐字照搬链路笔记**；改动任何一处都回第 2/3 步重测。
- 每个阶段打带前缀的日志（`[<id>] 进入详情页 3/20: …`），排障时它们是唯一能定位卡在哪一步的线索。
- 进度：按页、按条分摊 `Kabegame.addProgress(pct)`，总和约等于 100。
- 单个作品失败要 `Kabegame.warn` 后继续，不要让一张图的异常结束整个任务。
- 改已有插件时，在 `package.json` 里 bump `version`，并更新 `CHANGELOG.md`（如果有）。

**每张图都要带三样东西**，写法与规则见 [references/metadata-labels.md](references/metadata-labels.md)：
1. `metadata`：一个带 `schema` 版本号的 JSON 对象，存到**足以还原源站详情页**的程度——
   详情页上看得到的信息都要有，只与当前访客有关的字段（是否已收藏、我的评分）不存；
2. `labels`：把站点标签映射成 `{ key, category: "<插件id>/<分类>", name }` 数组；
3. `templates/description.ejs`（在 `package.json` 的 `kbDescriptionTemplate` 登记）：
   用 metadata 还原源站详情页的版式和配色，应用里预览图片时显示在「插件详情」面板。

## 第 5 步：真跑验证

### V8 插件 —— release kabegame-cli

```bash
$K/run-cli.sh <id> --secs 60 --var mode=search --var keyword=miku --var start_page=1 --var end_page=1
```

它会依次执行：
1. `deploy.sh`：用 `package-plugin.ts` 打包到 `.kabegame/debug/data/plugins-directory/<id>.kgpg`。
   打包到 dev 目录是为了让开发中的 app 也能看到这一版；
2. `target/release/kabegame-cli plugin run <该 .kgpg> --id <id>-test --plain --output-dir <临时目录>`：
   路径模式临时运行，不安装。`--id` 换成测试 id，这样插件数据目录、`default-configs`、入库的
   `plugin_id` 都和正式插件隔离开；不传 `--data`（release 默认用系统用户数据目录）。
   到了时限就发 SIGINT 取消；
3. 从系统数据目录的 `images.db` 读任务计数，再汇总日志和本次新增的文件数。

测试 id 可以用 `--id` 自己指定；连续改连续跑时，可以加 `--no-deploy` 跳过重新打包。
`--var` 的 key 必须是 `kbConfig` 里的 key，写错时 CLI 会列出可用项。配置要尽量缩到一两页，
验证的是链路，不是把整站抓下来。只想看配置解析结果，就把 `--dry-run` 透传给 `plugin run`。

**验证门槛**（看摘要）：
- `任务：completed` 或者限时取消，且没有 `✗ 进程崩溃`；
- `新下载 + 去重跳过 > 0`。重复验证时同一批图会被 URL 去重
  （日志里是 `i18n:taskLogDedupByUrl`），新下载为 0 是正常的，去重数同样证明链路通了；
- 摘要里 `插件 <测试id> v<版本>` 的版本号就是你刚改的那一版；
- 打开输出目录，抽一两张确认是原图（尺寸、能正常打开），不是缩略图；
- 插件日志的最后几行停在你预期的阶段；`WARN` 的分类里没有成片的「找不到」「解析失败」；
- 新增或修改了列表类模式（排行、搜索、筛选）时，把本次入库图片的源站 ID（从 metadata 取）和
  源站对应页面的 ID 集合比对，确认抓的正是用户在网页上看到的那一页；
- 改已有插件时，旧模式也要跑一遍做回归（重复跑全部被去重是正常的，看计数和日志）。

**metadata / labels / 模板的验证门槛**（V8 跑完后，同样适用于 WebView）：
- 查库：本次任务的每张图都有 `metadata_id`；抽一条 metadata 看字段齐全
  （release CLI 的库在系统数据目录，查询写法见 metadata-labels.md）；
- labels：本次任务里图片关联的 label 数量约等于源数据的 tag 总数，被跳过的只该是 key 派生不出来的那些；
- 模板：`$K/render-desc.ts <id> --db --where "<挑一条信息最全的，比如有评论的>"`，用 Read 看截图，
  和第 2 步的源站截图逐块对照（卡片、标签配色、信息表、评论）。要看到 app 里的真实效果，
  在 dev app 里跑一次（`app-run.sh`），再打开那张图的预览：
  ```bash
  C=.claude/skills/kabegame-chromium/driver.sh
  $C eval "(async()=>{const r=document.querySelector('#app').__vue_app__.config.globalProperties.\$router;await r.push({query:{...r.currentRoute.value.query,pvwimgid:'<图片id>'}})})()"
  $C shot $SP/preview.png
  ```
  看完再把 `pvwimgid` 从 query 里删掉，把用户的界面还原。

改代码后重新跑 `run-cli.sh` 即可，它每次都会重新打包。release CLI 不存在或太旧时，
请用户在仓库根执行 `deno task b -c kabegame-cli --release`。

### WebView 插件 —— dev app + CDP

CLI 起不了浏览器窗口，WebView 插件只能在 app 里跑。需要用户先启动 `deno task dev -c kabegame`。

```bash
$K/deploy.sh <id>
$K/app-run.sh <id> '{"mode":"search","search_keyword":"壁纸","max_items":3}' --secs 90
```

`app-run.sh` 依次调用 `refresh_plugins`（让 app 读到刚打包的版本）→ `start_task`（带
`outputDir`）→ 轮询 `get_task`，超时就 `cancel_task`，最后输出状态、计数、warn/error 分类
和最后几条日志。任务跑的时候，可以另开终端看爬虫窗口里的真实页面：

```bash
C=.claude/skills/kabegame-chromium/driver.sh
$C targets                                         # crawler-<taskId> 窗口
$C eval 'location.href' --url crawler
$C shot $SP/crawler.png --url crawler              # 截图后用 Read 看一眼
```

**验证门槛**同 V8；另外要确认每次导航后 `pageLabel` 的阶段日志都按预期出现
（WebView 每次导航都会重新执行整份脚本）。

## Gotchas

- **探针和运行时是同一个 DOM 实现**：V8 的 `DOMParser` 是 deno-dom（`plugin/v8/deno_dom_wasm_noinit.js`），
  `probe.ts sel` 也用 deno-dom。所以探针选不中的，插件里也选不中；浏览器 DevTools 里能选中不代表这里能。
- **V8 的 `fetch` 不会按当前页解析相对 URL**：用 `new URL(href, base)`，或者 SDK 的 `resolveUrl`。
- **`Kabegame.to(url)` + `currentHtml()` 和 `fetch` 不一样**：`to` 会把页面压入 page stack，
  并带上任务请求头和重试；只取 JSON 用 `fetch`。两者都会合并 `setHeader` 设置的请求头。
- **app 内存里的插件不会自动更新**：打包后必须 `refresh_plugins`（`app-run.sh` 已经做了），
  否则 app 跑的还是旧版本。
- **i18n 占位日志**：下载器的 warn 是 `{"_i18n":{"k":"taskLogDedupByUrl",…}}` 这种原始 JSON，
  摘要按 key 聚合。`taskLogDedupByUrl` 是去重，不是错误。
- **CLI 只跑 V8**：对 `kbBackend: "webview"` 的插件执行 `plugin run` 会直接报错。
