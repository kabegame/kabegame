# 从 Steam 拉取 Wallpaper Engine

内建插件 `wpe-import` 的来源「从 Steam 拉取」：用户在「壁纸」导入对话框里登录购买了 Wallpaper Engine（app 431960）的 Steam 账号，任务把 Windows 版 WPE 下载到 Kabegame 自己的目录，作为一处普通的本机安装使用（场景壁纸读它的 `assets`，官方默认壁纸原地入库）。只随 `wpe` feature 编译（桌面主程序与 CLI）。

代码在 `src-tauri/kabegame-core/src/wpe/steam/`，验证工程在 `ignore/steam-p0`（不入库），计划与 P0 结论在 `.claude/plans/wpe-import/4-steam/README.md`。

## 总体结构

```
对话框（WpeSteamPullCard.vue）
  ├─ 登录：每一步一次 HTTPS 调用 IAuthenticationService（auth.rs）
  │    └─ 成功 → refresh token 存进 wpe-import 插件数据的私有区（sessions.rs）
  └─ 提交任务：config 只带 steamAccount（账号名）
任务（crawler/wpe_import.rs → install.rs）
  ├─ 按「Wallpaper Engine 目录」设置决定 下载 / 更新 / 跳过
  ├─ steam-vent 用 refresh token 登录 CM（cm.rs）：PICS、depot 密钥、manifest request code、CDN 服务器、CDN 授权 token
  └─ CDN（cdn.rs）：manifest 与 chunk → 解密、解压、SHA-1 校验（crypto.rs）→ 写盘、写安装状态
```

### 关键决策

- **登录走 HTTPS，CM 用 `steam-vent`**。`steam-vent` 0.5 没有扫码登录，凭据登录是一个阻塞调用（拿一个确认处理器一直等），不适合表单分步；而 `IAuthenticationService` 的各方法都能经 `api.steampowered.com` 调（请求 protobuf 放在表单字段 `input_protobuf_encoded`，响应是 protobuf，结果看 `x-eresult` 头）。登录以 `SteamClient` 平台类型发起，拿到的 refresh token `aud` 含 `client`，才能登录 CM。CM 那一半（握手、加密信道、job 与服务方法）交给 `steam-vent`，`Connection::access(账号, refresh token)` 就能登录（它要的就是 refresh token，`iss` 必须是 `steam`）。
- **网页 Cookie 不能用**。畅游里登录 Steam 后的 `steamLoginSecure`（`aud` 为 `web:store` 等）与 `steamRefresh_steam`（`aud` 为 `web, renew, derive`）都没有 `client`，登录不了 CM，也就拿不到 depot 密钥。网页 access token 只能调部分 Web API（`IPlayerService/GetOwnedGames` 可以，`IPublishedFileService/GetUserFiles` 要 API key）。
- **密码不入库**。任务参数只有账号名（`steamAccount`）；密码只在 `wpe_steam_login_credentials` 这一次调用里经过内存。token 存在插件数据的宿主私有区（见下），对外出口都读不到。
- **只在没有 WPE 时下载**。先跑一次自动查找（`discover::engine_dir`，Steam 库里有 WPE 时会写进设置），再看设置：为空就下载并写进设置；是应用管理目录就增量更新；是别处就跳过。
- **下载完整 WPE**。不做文件过滤，与真实安装一致；以后要省体积再按 manifest 文件表过滤。
- **安装目录照 Steam 库排**：`<数据目录>/plugins-data/wpe-import/steamapps/common/wallpaper_engine`。`discover_roots` 把 `plugins-data/wpe-import` 当作一个库补登，`roots_in_library`、`steam_engine_dirs` 与扫描都不用另写；创意工坊以后落在 `<库>/steamapps/workshop/content/431960`，和真实安装同一个相对位置。卸载内建插件不会发生，这个目录随应用数据目录走。
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

- 连接：`ServerList::discover` + `Connection::access`；网络错误重试 3 次（连 CM 的 WebSocket 偶有超时）；`LoginError`（含 `Unknown(AccessDenied)`）与 `AccessToken` 错误视为会话失效。
- PICS：先 `CMsgClientPICSAccessTokenRequest` 取 app access token（`app_denied_tokens` 含 431960 表示没买），再 `CMsgClientPICSProductInfoRequest`。应用信息是文本 VDF，用 `discover::parse_vdf` 解析（分词器跳过 `\x` 转义）。取 public 分支：depot 键是数字、有 `manifests.public.gid`；跳过 `config.realm = steamchina`、`oslist` 不含 windows、`depotfromapp`、`dlcappid`。2026-11-15 实测 431960 只有 `431961`（826 MB，下载 377 MB，6301 个文件）可取，`431966` 是 steamchina 区域的 8 MB。
- depot 密钥：`CMsgClientGetDepotDecryptionKey`，`eresult != 1` 时报错。
- manifest request code：`ContentServerDirectory.GetManifestRequestCode`。**public 分支的 `app_branch` 必须留空**（照 SteamKit2；传 `"public"` 拿到的码，CDN 一律 403）。约 5 分钟有效。
- CDN 服务器：`GetServersForSteamPipe(cell_id)`，只取 `SteamCache` / `CDN` 且 `allowed_app_ids` 为空或含本 app 的，按 `weighted_load` 排；URL 主机用 `vhost`，`https_support` 为 `mandatory` 才走 https，否则 http（照 SteamKit2 `ConvertServerList` / `BuildCommand`）。
- CDN 授权 token：`GetCDNAuthToken(app, depot, host)`，**用服务器的 `host` 而不是 `vhost`**，返回值原样作为 query 拼在 URL 后（格式因 CDN 而异，有的以 `expiration_time=` 开头，不解析）。

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
- 进度：拉取占任务进度的前 80%（按压缩字节），导入官方默认壁纸占后 20%；取消在每个 chunk 前检查。dry-run 不下载。

## 对话框（`WallpaperImportDialog.vue` + `WpeSteamPanel.vue`）

- 对话框顶部先选来源：「本机」（Steam 库自动发现 + 手选文件夹，原有界面）或「从 Steam」。来源关掉对话框不重置。两种来源的任务参数互不混用：本机不带 `steamAccount`；从 Steam 传 `sources: null`、只带 `steamAccount`，不带手选文件夹（拉取完成后任务自己并入这份 WPE 的 `defaultprojects`）。
- `WpeSteamPanel` 只在选中「从 Steam」时挂载（每次打开对话框按 key 重新挂载）：挂载即调 `wpe_steam_status`。设置里有别的 WPE 目录时只显示说明与路径（目录失效时提示去设置里清空），经 `v-model:blocked` 让对话框置灰提交；否则显示是否已下载（build 号），有未过期的会话就先问「以 <账号> 继续（有效至 …）」，点击时 `wpe_steam_verify_session` 连一次 CM，失败删会话、回到登录；没有会话直接进登录，缺省扫码。账号密码登录后要用户做什么完全看 Steam 返回的 `confirmations`（按账号的 Steam Guard 设置给，开了手机令牌的账号只给 `deviceConfirmation` + `deviceCode`，邮箱令牌的账号才给 `emailCode`）：能在手机上点确认或点邮件链接（`emailConfirmation`）时只提示这一步，后台照常轮询、确认后自动变成已登录，验证码收进「改用令牌 / 邮箱验证码」链接；只有验证码这一种方式时直接显示输入框。卸载时放弃进行中的登录。
- 已登录的账号由对话框持有（`v-model:account`），来回切换来源不丢；没登录时不能提交，底栏提示先登录。

## 已知限制与后续

- 失效判断只看 CM 登录结果；任务级失败重试对登录类错误也会重试（P2 要排除）。
- 创意工坊订阅（P3）复用本模块：工坊条目的 `hcontent_file` 是 depot 431960 上的 manifest id。
- token 明文存在数据库里（P4 用 passkey 或系统钥匙串保护）。
