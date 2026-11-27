# 从 Steam 导入

内建插件 `wpe-import` 的来源「从 Steam 导入」：用户在「壁纸」导入对话框里登录购买了 Wallpaper Engine（app 431960）的 Steam 账号，在订阅列表里挑创意工坊条目，任务把它们下载进 WPE 目录的 `projects/myprojects/<条目 id>/` 并入库。WPE 本体只是顺带：设置里没有可用的 WPE 目录时，任务先把 Windows 版 WPE 下载到 Kabegame 自己的目录，作为一处普通的本机安装使用（场景壁纸读它的 `assets`）。不导入官方默认壁纸，那是「本机」来源的事。只随 `wpe` feature 编译（桌面主程序与 CLI）。

代码在 `src-tauri/kabegame-core/src/wpe/steam/`，验证工程在 `ignore/steam-p0`（不入库，`subs <参数>` 探订阅接口、`depot <depot> <manifest>` 探下载），计划在 `.claude/plans/wpe-import/4-steam/`（`README.md` 总纲与 P0 结论、`P3.md` 创意工坊）。

## 总体结构

```
「网络」对话框的 Steam 来源（collect/SteamImportPanel.vue）
  ├─ WpeSteamPanel.vue 登录：每一步一次 HTTPS 调用 IAuthenticationService（auth.rs）
  │    └─ 成功 → refresh token 存进 wpe-import 插件数据的私有区（sessions.rs）
  ├─ WpeSteamWorkshopList.vue 两个页签：「我的订阅」每页一次 wpe_steam_subscriptions、「工坊发现」每页一次
  │    wpe_steam_workshop_query（workshop.rs，分页 / 排序 / 搜索 / 筛选由 Steam 做）；已选条目 id 两个页签共用
  └─ 提交任务：config 带 steamAccount（账号名）+ steamItems（条目 id）与 / 或 steamAllSubscriptions（分级），任务取并集
任务（crawler/wpe_import.rs 的 run_steam_import）
  ├─ install.rs：按「Wallpaper Engine 目录」设置决定 下载 / 更新 / 跳过 本体
  ├─ workshop.rs：按 id 查详情或按分级列全部订阅 → 逐条下载进 <WPE>/projects/myprojects/<id>/ → 立即入库
  ├─ cm.rs：账号的共享 CM 连接（steam-vent）：PICS、depot 密钥、manifest request code、CDN 服务器、CDN 授权 token、PublishedFile 服务
  └─ cdn.rs：manifest 与 chunk → 解密、解压、SHA-1 校验（crypto.rs）→ 写盘、写状态
```

### 关键决策

- **登录走 HTTPS，CM 用 `steam-vent`**。`steam-vent` 0.5 没有扫码登录，凭据登录是一个阻塞调用（拿一个确认处理器一直等），不适合表单分步；而 `IAuthenticationService` 的各方法都能经 `api.steampowered.com` 调（请求 protobuf 放在表单字段 `input_protobuf_encoded`，响应是 protobuf，结果看 `x-eresult` 头）。登录以 `SteamClient` 平台类型发起，拿到的 refresh token `aud` 含 `client`，才能登录 CM。CM 那一半（握手、加密信道、job 与服务方法）交给 `steam-vent`，`Connection::access(账号, refresh token)` 就能登录（它要的就是 refresh token，`iss` 必须是 `steam`）。
- **网页 Cookie 不能用**。畅游里登录 Steam 后的 `steamLoginSecure`（`aud` 为 `web:store` 等）与 `steamRefresh_steam`（`aud` 为 `web, renew, derive`）都没有 `client`，登录不了 CM，也就拿不到 depot 密钥。网页 access token 只能调部分 Web API（`IPlayerService/GetOwnedGames` 可以，`IPublishedFileService/GetUserFiles` 要 API key）。
- **密码不入库**。任务参数只有账号名（`steamAccount`）；密码只在 `wpe_steam_login_credentials` 这一次调用里经过内存。token 存在插件数据的宿主私有区（见下），对外出口都读不到。
- **主角是壁纸，本体顺带**。登录后列订阅、由用户挑；本体只在设置里没有 WPE 时下载。任务不导入官方默认壁纸。
- **工坊条目一律放 `<WPE>/projects/myprojects/<条目 id>/`**（用户定）：WPE 是 Kabegame 下载的还是用户自己的 Steam 安装都一样，不碰 `defaultprojects`，也不写 Steam 客户端管理的 `steamapps/workshop/content/431960`（没登记在 `appworkshop_431960.acf` 里的目录可能被 Steam 清掉，登记它又等于替 Steam 客户端记账）。`myprojects` 本来就是一种 WPE 来源，本机导入与文件夹发现不用改。
- **不替用户全量拉取**（用户定）：订阅可以有几百条、十几 GB（本机 225 条、18.6 GB），列表服务端分页、由用户勾选；「全部 N 个」只带分级，任务运行时重新列。
- **每个账号只有一条 CM 连接**。steam-vent 登录时 login id（`CMsgClientLogon.obfuscated_private_ip`）固定为 0，同一账号再登录一条会把前一条踢下线（日志里是 `steam_vent::connection::filter: Error while reading message error=InvalidHeader`，之后被踢的那条每 9 秒报一次 `Failed to send heartbeat message error=Ws(AlreadyClosed)`，直到它被丢掉）。DepotDownloader 为此给 SteamKit 设了 `LoginID`，steam-vent 没开放这个参数，所以浏览、验证、下载本体、下载条目共用 `cm::shared_connection`。
- **只在没有 WPE 时下载**。先跑一次自动查找（`discover::engine_dir`，Steam 库里有 WPE 时会写进设置），再看设置：为空就下载并写进设置；是应用管理目录就增量更新；是别处就跳过。
- **下载完整 WPE**。不做文件过滤，与真实安装一致；以后要省体积再按 manifest 文件表过滤。
- **安装目录照 Steam 库排**：`<数据目录>/plugins-data/wpe-import/steamapps/common/wallpaper_engine`。`discover_roots` 把 `plugins-data/wpe-import` 当作一个库补登，`roots_in_library`、`steam_engine_dirs` 与扫描都不用另写。创意工坊条目不放这个库的 `workshop/content`，而是放进 WPE 目录的 `projects/myprojects/`（见上）。卸载内建插件不会发生，这个目录随应用数据目录走。
- **复用前验证要连 CM**。经 HTTPS 调 `GenerateAccessTokenForApp` 验证客户端 token 返回 eresult 63（AccountLogonDenied），不可用；改为直接 `Connection::access` 一次。2026-11-15 那次 HTTPS 调用之后，同一个 token 连 CM 也被拒（`AccessDenied`），原因没能确认（也可能是用户在 Steam 里取消了授权），所以不要再对客户端 token 调这个 HTTPS 方法。

## 登录（`auth.rs`）

| 步骤 | 调用 | 说明 |
|---|---|---|
| 扫码第一步 | `BeginAuthSessionViaQR` | 返回 `client_id`、`request_id`、`challenge_url`（后端渲染成 PNG data URL）、`interval` |
| 账号密码第一步 | `GetPasswordRSAPublicKey`（**只接受 GET**，参数放查询串；POST 返回 HTTP 405）→ `BeginAuthSessionViaCredentials` | 密码 RSA PKCS#1 v1.5 加密（`rsa` + `OsRng`）；带上已存的 Steam Guard 机器数据（`guardData`），同一台机器通常不再要邮箱验证码；`allowed_confirmations` 里邮箱验证码的 `associated_message` 是发往的邮箱提示 |
| 提交验证码 | `UpdateAuthSessionWithSteamGuardCode` | `emailCode` / `deviceCode` |
| 轮询 | `PollAuthSessionStatus` | 有 `refresh_token` 即成功；扫码时会给 `new_client_id` 与 `new_challenge_url`（约 20 s 刷新一次），`had_remote_interaction` 表示手机已扫 |

待完成的登录只在内存里（`login_id` → `client_id` / `request_id` / `steamid`），15 分钟过期；对话框关掉或换方式时 `wpe_steam_login_cancel`。

## 会话（`sessions.rs`）与插件数据私有区

`plugin_data` 每个插件一行 JSON object。顶层键 `__private`（`storage::plugin_data::PRIVATE_KEY`）是宿主私有区：`PluginDataStorage::get` 一律剥掉，`set` 写入时保留库里原有的私有区（传入值里的同名键被忽略），只有 `get_private` / `update_private` 能读写。所有对外出口（Tauri / web 调度的 `get_plugin_data`、V8 与 WebView 插件的 `pluginData` / `setPluginData`、详情 EJS 的 `__bridge.getPluginData`）都经过 `get` / `set`。

`wpe-import` 的私有区：`steamSessions[账号] = { refreshToken, steamId, expiresAt, guardData?, savedAt }`、`steamLastAccount`。`expiresAt` 取 refresh token（JWT）的 `exp`，本地解出、不验签；保存时检查 `aud` 含 `client`。对外（`wpe_steam_status` 的 `sessions`）只有账号、steamId、过期时间，最近用过的排第一，过期的不列。CM 拒绝登录时删掉 token、保留 `guardData`。

## CM 与 PICS（`cm.rs`）

- 连接：`ServerList::discover` + `Connection::access`，每次最多等 20 秒（WebSocket 偶尔连不上时系统要等 75 秒才超时），网络错误与超时重试 3 次、每次重新取服务器列表；`LoginError`（含 `Unknown(AccessDenied)`）与 `AccessToken` 错误视为会话失效。
- 共享连接 `shared_connection(账号)`：按账号缓存一条 `Arc<Connection>`；还有人持有（任务在下载）时不回收，没人持有且空闲 5 分钟后断开（每分钟扫一次）。调用失败由调用方 `invalidate(&连接)` 从缓存里拿掉（只拿掉同一条），下次重新登录。`connect_and_build` 是任务的第一步：取连接查 PICS，失败就作废、重连再查一次（缓存里的连接可能已断）。复用前的验证 `verify_session` 也走它：已有连接时再查一次 PICS 访问令牌确认还活着。删会话（`wpe_steam_forget_session`）时 `forget_account`。
- PICS：先 `CMsgClientPICSAccessTokenRequest` 取 app access token（`app_denied_tokens` 含 431960 表示没买），再 `CMsgClientPICSProductInfoRequest`。应用信息是文本 VDF，用 `discover::parse_vdf` 解析（分词器跳过 `\x` 转义）。取 public 分支：depot 键是数字、有 `manifests.public.gid`；跳过 `config.realm = steamchina`、`oslist` 不含 windows、`depotfromapp`、`dlcappid`。2026-11-15 实测 431960 只有 `431961`（826 MB，下载 377 MB，6301 个文件）可取，`431966` 是 steamchina 区域的 8 MB。
- depot 密钥：`CMsgClientGetDepotDecryptionKey`，`eresult != 1` 时报错。
- manifest request code：`ContentServerDirectory.GetManifestRequestCode`。**public 分支的 `app_branch` 必须留空**（照 SteamKit2；传 `"public"` 拿到的码，CDN 一律 403）。约 5 分钟有效。
- CDN 服务器：`GetServersForSteamPipe(cell_id)`，只取 `SteamCache` / `CDN` 且 `allowed_app_ids` 为空或含本 app 的，按 `weighted_load` 排；URL 主机用 `vhost`，`https_support` 为 `mandatory` 才走 https，否则 http（照 SteamKit2 `ConvertServerList` / `BuildCommand`）。
- CDN 授权 token：`GetCDNAuthToken(app, depot, host)`，**用服务器的 `host` 而不是 `vhost`**，返回值原样作为 query 拼在 URL 后（格式因 CDN 而异，有的以 `expiration_time=` 开头，不解析）。

- 创意工坊 depot：PICS 的 `depots.workshopdepot`（431960 是 `"431960"`），没写时照 DepotDownloader 用 app id 本身。

## CDN（`cdn.rs`）

- 请求照 DepotDownloader：服务器轮换；某台返回 403 且还没为它申请过 token 时申请一次再重试；其它失败换下一台；跟随跳转、照常走系统代理。2026-11-15 本机分到的三台国内 CDN 都必须带 token，曾误以为是代理导致的 403。
- manifest：`/depot/<depot>/manifest/<gid>/5/<request code>`，单条目 zip，里面按 magic 分段（payload `0x71F617D0`、metadata `0x1F4812BE`、signature `0x1B81B817`、end `0x32C415AB`），protobuf 用 `steam-vent-proto-steam` 的 `content_manifest`。文件名加密时：base64（**每 72 字符带换行**，解码前去空白）→ 对称解密 → 去掉结尾 NUL，`\` 统一成 `/`，并过 `wpe::is_safe_relative_path`（有 `..`、绝对路径、盘符就拒绝整份 manifest）。标志 `0x40` 是目录。
- chunk：`/depot/<depot>/chunk/<sha 小写十六进制>`。对称解密（前 16 字节 ECB 解出 IV，其余 AES-256-CBC + PKCS7）→ 按头分三种封装：`VZa`（7 字节头 + 5 字节 LZMA 属性，尾 10 字节，`lzma-rust2` 的 `LzmaReader::new_with_props`）、`VSZa`（8 字节头 + 一个 zstd 帧，用纯 Rust 的 `ruzstd`，仓库禁止链 C 的 zstd）、`PK`（zip 单条目）→ 长度与 chunk id（解压后数据的 SHA-1）校验，失败重试。错误密钥不一定能被填充检查发现（约 1/256 恰好合法），真正的保护是 SHA-1。

## 安装（`install.rs`）

- 状态文件 `<库>/steamapps/kabegame_wpe_install.json`：`appId`、`buildId`、`depots`（depot → manifest id，都存字符串）、`files`（路径 → 大小与 SHA-1）、`updatedAt`。
- manifest 与状态一致且状态里的文件都在、大小对：「已是最新」，不连 CDN。
- 否则逐 depot 取密钥、request code、manifest（后面的 depot 覆盖前面的同名文件），规划：目录直接建；文件已是最新（状态记录一致且大小对；没有记录时大小对再现算 SHA-1，覆盖首次拉取中断后的续传）就跳过；空文件直接写；其余下载。
- 下载：每个文件先建定长的 `<文件>.kbpart`，chunk 按偏移写入，8 个并发（DepotDownloader 缺省）；每个 chunk 写完再把该文件的剩余计数减一，减到 0 的那个 chunk 是最后写完的，由它触发改名。chunk 的 future 只持有 `Arc` 与克隆，不借用外部引用：`stream.map(|..| async { 借用 })` 会让 rustc 报「`Send` 不够通用」。
- 新版本里没有的旧文件只删状态里记录过的。最后写状态、设置为空时写进设置。
- 计划与下载（`plan_downloads` / `download_files`）以安装根为参数，工坊条目复用同一套（根是条目目录）。
- 进度：本体占「从 Steam 导入」任务进度的前 20%（按压缩字节），工坊条目占后 80%；取消在每个 chunk 前检查。dry-run 不下载。

## 创意工坊（`workshop.rs`）

- **列订阅**：`PublishedFile.GetUserFiles#1`（`steamid` 取连接自己的、`appid` 431960、`type = "mysubscriptions"`、`return_tags`），经 CM 调、不需要 Web API key。2026-11-15 实测（`ignore/steam-p0 subs`）：
  - 分页 `numperpage` + `page`（从 1 起），响应带 `total` 与 `startindex`；`numperpage = 500` 也一次返回全部；`totalonly` 只回总数。代码里每页最多 100。
  - 排序 `sortmethod` 只认 `lastupdated`（缺省，条目更新时间倒序）与 `subscriptiondate`（订阅时间倒序）；`title`、`creationorder` 与不认识的值都落到同一个顺序（看起来是条目 id 倒序），没有按标题排。
  - 分级是 WPE 的标签 `Everyone` / `Questionable` / `Mature`，每条恰有一个；筛选用 `excludedtags` 排除没选的分级，`total` 与分页都在筛选之后。多个 `requiredtags` 是「都要有」。`excluded_content_descriptors` 是作者自己声明的、不全，不用。
- **条目**：`WorkshopItem`（id 与 manifest id 都是字符串，避免 JS 精度问题）。类型看类型标签（`Scene` / `Video` / `Web` / `Application` / `Preset`），能导入的是 scene / video / web 且 `hcontent_file` 不为 0；本机 225 条全是 Scene 217 / Web 5 / Video 3，Application 与预设实测不到，列表照显示、不能勾选，任务里记日志跳过。`preview_url` 是 Steam 图片 CDN，主窗口 CSP 的 `img-src *` 直接显示。
- **工坊发现**：`PublishedFile.QueryFiles#1`（`appid` 431960、`return_tags`），2026-11-15 实测（`ignore/steam-p0 query`）：
  - 约 328 万条；`page` + `numperpage` 分页，`page = 2000` 也能直接取；0.4–2.3 s / 页。
  - `query_type` 含义靠实测，不照猜：0 按评分、1 最新发布、3 趋势（`days` 时间窗生效）、9 总订阅数、11 好评数、12 搜索相关度、21 最近更新；19 只回 2.3 万条、含义不明，不用。`DiscoverSort` 只开放 3 / 9 / 0 / 1 / 21 / 12。
  - `search_text` 中英文都行，能叠加任何排序；有搜索字时前端缺省换成「相关度」，清空时换回「最热门」。
  - 分级与类型都用「排除没选的」（`excludedtags`，组内「或」、组间「与」）；`requiredtags` 多个时由 `match_all_tags` 决定都要有还是有一个，不用它。预设（约 14 万条）与程序壁纸（1 条）导入不了，固定排除。
  - `WorkshopItem.subscriptions` 是当前订阅人数，发现列表里显示。
  - **按 id 搜**：搜索文字整段由条目 id 或工坊链接（`…/filedetails/?id=<id>`、`steam://url/CommunityFilePage/<id>`）组成（空格、逗号、分号、换行分隔）时，`workshop::parse_item_ids` 认出来，命令改走 `details_page`（`GetDetails`），不看排序与筛选，结果就是这几条。实测请求带 `appid = 431960` 时，别的游戏的条目回 `result = 8`、不存在的回 `9`，都按 `result != 1` 丢掉，不用另判 `consumer_appid`。
- **按 id 查详情**：`PublishedFile.GetDetails#1`（每次最多 100 个，`includetags`）。任务对选中的 id 再查一次，拿运行时的最新 manifest；查不到的（删了、不可见）记一条日志。
- **本地状态**：`<WPE>/projects/myprojects/kabegame_workshop.json`（跟着 WPE 目录走）：`items[id] = { manifestId, files（路径 → 大小与 SHA-1）, tags, updatedAt }`。列表的 `local`：没有 `<id>/project.json` 是 `missing`；有且记录的 manifest 等于 `hcontent_file` 是 `current`；其余（manifest 变了，或目录不是 Kabegame 下的）是 `outdated`。WPE 与我们的扫描只看 `myprojects` 下的目录，这个文件不影响它们。
- **下载**（`WorkshopDownloader`）：`open` 取共享连接、查 PICS 拿工坊 depot、取 depot 密钥与 CDN 服务器、建 CDN 池；`download` 对一个条目：记录的 manifest 等于 `hcontent_file` 且文件都在就「已是最新」，否则 request code → manifest → `plan_downloads`（没有记录时大小对上再现算 SHA-1，所以目录里已有的同一份内容不重下）→ `download_files` → 删掉新版本里没有的旧文件（只删记录过的）→ 重新读一次状态再写（同一个 WPE 目录可能有别的任务在写）。
- **标签**：状态里记着 Steam 标签，`tags::read_workshop_tags` 先读它，再用 WPE 自己的工坊缓存 `bin/workshopcache.json` 覆盖同一条。导入时与工坊缓存同一路径挂 `WPE/<子目录>/<tag>`，所以「广受好评」（`Approved`）这类只有 Steam 才知道的标签也能挂上。

## 任务（`crawler/wpe_import.rs` 的 `run_steam_import`）

- 有 `steamAccount` 时整条走这里，不看 `sources` / `extraDirs`。`steamAllSubscriptions`（分级列表，按它列全部订阅）与 `steamItems`（条目 id，去重；订阅里勾的与工坊发现里勾的都在这里）取并集，已经在「全部订阅」里的 id 不再查详情；两者都没有时报错。
- 顺序：`pull_engine`（本体下载 / 更新 / 跳过）→ 再跑一次 `discover::engine_dir()`，设置指向的目录失效时报错、不往里写（`ensure_engine` 对它也只是跳过）→ `WorkshopDownloader::open` → 查详情或列全部订阅 → 不支持的记日志跳过 → 逐条下载、下完一个就经下载后处理的目录分支（`postprocess_downloaded_image` + `PostprocessSource::Path`，与本机导入同一入口）入库。取消时保留已完成的条目。
- 条目失败记日志、继续下一个；失败后作废共享连接并重新 `open`（连接可能被踢下线或断了），重连不上就结束任务。全部失败时任务失败。
- 进度按条目的 `file_size` 加权，条目内部按 chunk 字节。dry-run 只列条目、记 `taskLogWpeWorkshopDryRun`，不下载。
- 条目更新后（manifest 变了）按路径命中已有行，只补画册成员；行的目录哈希 / 大小 / metadata 不重算（见「已知限制」）。

## 对话框（`collect/SteamImportPanel.vue` + `WpeSteamPanel.vue`）

- 入口是「开始收集 → 网络」对话框顶部的「Steam」来源（与插件、网页并列，上次的来源记在 localStorage）；本机已有的 Wallpaper Engine 目录在「开始收集 → 本地 → WPE 壁纸」（`collect/WpeLocalPanel.vue`）。两种来源的任务参数互不混用：本机不带 `steamAccount`；Steam 传 `sources: null`、`steamAccount`，以及 `steamItems`（条目 id）或 `steamAllSubscriptions`（分级）之一，另一个为 `null`。两边的提交与「保存到」字段共用 `collect/wpeImport.ts` 与 `collect/WpeImportSaveFields.vue`。
- `SteamImportPanel` 第一次切到 Steam 来源时挂载、每次打开对话框重新挂载，`WpeSteamPanel` 随它挂载即调 `wpe_steam_status`。登录区始终显示；WPE 只是顺带，状态是登录框下面的一行小字（使用已有的 WPE（带路径）/ Kabegame 已下载（build 号）/ 没有找到、导入时顺带下载 / 设置里的目录不可用）。有未过期的会话就先问「以 <账号> 继续（有效至 …）」，点击时 `wpe_steam_verify_session` 连一次 CM，失败删会话、回到登录；没有会话直接进登录，缺省扫码。账号密码登录后要用户做什么完全看 Steam 返回的 `confirmations`（按账号的 Steam Guard 设置给，开了手机令牌的账号只给 `deviceConfirmation` + `deviceCode`，邮箱令牌的账号才给 `emailCode`）：能在手机上点确认或点邮件链接（`emailConfirmation`）时只提示这一步，后台照常轮询、确认后自动变成已登录，验证码收进「改用令牌 / 邮箱验证码」链接；只有验证码这一种方式时直接显示输入框。卸载时放弃进行中的登录。
- 已登录的账号由 `SteamImportPanel` 持有（`v-model:account`）；本次打开内来回切换来源不丢（面板用 `v-show` 留着）。
- 登录后显示「选择壁纸」：两个页签「我的订阅」「工坊发现」，都是 `WpeSteamWorkshopList.vue`（`source` 区分，按账号重新挂载；两个都用 `v-show` 留着，切换不丢页码与筛选；工坊发现第一次切过去才挂载）。只持有当前一页（每页 20 条），翻页、换分级 / 类型（每组至少留一个，全不选在 Steam 那边等于不筛选）、换排序、换趋势时间窗、搜索（输入停 500 ms 或回车）各调一次命令，旧请求回来作废；加载中列表半透明。每行整行可点，复选框只做显示；预览图、标题、类型、大小（发现里另有订阅人数）、分级（成人标红），以及「已下载」「有更新」「不支持」。已选条目 id 由 `SteamImportPanel` 持有（`v-model:selected-ids`），两个页签共用、跨页保留，「选中本页未下载」三态、只管本页本地还没有的条目（「已下载」「有更新」的不勾）；分级、类型、排序与趋势时间窗按页签记在 localStorage（`kabegame-steam-workshop-view:<subscriptions|discover>`，逐项校验、不合法取默认），下次打开沿用，搜索字与搜索时自动换上的「相关度」不记；总页数封顶 2500（每页 20 条即前 5 万条，「共 N 个」仍是 Steam 的总数）；「全部 N 个」只在订阅里，锁住订阅里的逐条勾选，经 `v-model:all-subscriptions` 交出分级与总数。换账号时清空已选。没有选择时不能提交，底栏显示「将导入 N 个创意工坊壁纸」/「将导入全部 N 个订阅」/「…另加选中的 M 个」。

## 已知限制与后续

- 失效判断只看 CM 登录结果；任务级失败重试对登录类错误也会重试（P2 要排除）。
- 条目更新后入库行的目录哈希、大小与 metadata（`project.json`）不重算，属性面板读的还是旧 metadata；要等「刷新已有行」的入口（文件夹同步也有同样的缺口）。
- 取消订阅的条目不删除目录、不动入库的行。
- 用户自己的 Steam 已经下过的工坊条目（在 `workshop/content/431960`）会再下一份到 `myprojects`；入库时按目录哈希去重命中已有行，只多占磁盘。
- 场景里的 `<种类>/workshop/<id>/…` 路径（2026-11-27 核对）：作者在编辑器里用了别的工坊素材（effect、着色器、字体、粒子预设等）时，素材被拷进工程的 `<种类>/workshop/<id>/…`，发布时随场景打进 `scene.pkg`，`SceneFs` 当普通路径从 pkg 读到，不需要下载依赖条目，渲染器也不用特殊解析。
  - 本机 217 张场景里 142 张有这类引用，真不在包里的只有 `3643916956` 的 `fonts/workshop/3632410990/BRONSON-Black.ttf`（依赖条目 `3632410990` 本机也没装）：排版退回 arial，同 WPE 找不到字体时。WPE 在装了依赖条目时会不会去它的目录里找，没查。
  - 另有 7 张的 effect.json `dependencies` 列着编辑器源文件（`.png`、`.tex-json`），编好的 `.tex` 都在包里，不影响渲染。
  - 2026-11-15 曾把 `3836725625`、`3837598414` 记成「依赖条目没下载、画面缺效果」，是误诊：日志里的 `deny file: … NotFound` 是 `SceneFs` 先探工程散文件时 `file:` 闸门打的 info 日志，随后在 pkg 命中。两张都和 WPE 对照过（P7c、P6b），11-27 在 dev 里重新渲染，`unsupported` 为空，effect 与字体都在。11-28 起 `SceneFs` 按场景文件表找、不再先探散文件，闸门对不存在的文件改记 debug 级 `file: not found`（见 [scene/COMPILE.md](scene/COMPILE.md)「编译管线」）。
- 收藏还没做，入口会排在「我的订阅」「工坊发现」旁边；工坊发现还没有题材标签（Anime、Game 等）筛选，可以先用搜索。
- token 明文存在数据库里（P4 用 passkey 或系统钥匙串保护）。
