# WPE 从 Steam 直接拉取（总纲）

> 第一稿只写思路。现状锚点与逐点代码等总纲确认、细化某一期时再补。

## 总体设计思路

在内建插件 `wpe-import` 里加一个来源「从 Steam 拉取」。登录与取任务分两步：**登录在前端表单里完成**，
任务只负责下载。

用户在「壁纸」导入对话框里填 Steam 账号和密码，对话框调后端命令发起登录。需要邮箱验证码或令牌验证码时，
对话框就地显示输入框；选了手机确认时，对话框轮询等待。登录成功后，后端把 refresh token 按账号存进
`wpe-import` 的插件数据（`plugin_data` 表里这个插件 id 的那一行），前端拿到「已登录」再提交任务。任务参数里只有账号名，没有密码，所以密码从不进任务表、运行配置
和日志，只在一次 IPC 调用里经过内存。

**复用上次的登录**：refresh token 是 JWT，过期时间就在它的 `exp` 里，本地解出来即可，不用联网。后端提供一个
只返回 `{ 账号, steamId, 过期时间 }` 的命令（不返回 token）。对话框打开时如果有未过期的会话，就显示「以
<账号> 继续（有效至 <日期>）」和「换个账号 / 重新登录」，选继续就直接提交任务，不显示登录表单。`exp` 只是
上限：用户在 Steam 里「取消所有设备授权」、改密码或登出，都会让 token 提前失效。所以复用前先做一次轻量
验证；验证失败或任务里 CM 登录被拒时，删掉这份会话，提示回对话框重新登录。快到期时（例如剩不到 30 天）
提示重新登录续期。

登录必须拿到 **Steam 客户端（`client`）用途**的 refresh token。网页登录的 Cookie 不行（2026-11-15 实测，
见「网页 Cookie 能做什么」），所以表单提供两种方式：扫码（Steam 手机 App 扫二维码，不输密码）与账号密码
（加邮箱 / 令牌验证码或手机确认），两者都以 `SteamClient` 平台类型发起。

任务用 token 登录 Steam，把**完整的** Windows 版 Wallpaper Engine 下载到应用管理的安装目录。目录照 Steam 库
的结构排：`<数据目录>/plugins-data/wpe-import/steamapps/common/wallpaper_engine`（`wpe-import` 的插件数据目录，
`discover_roots` 把它当作一个 Steam 库），这样创意工坊落在
`<WPE>/../../workshop/content/431960/<id>`，和真实安装同一个相对位置，现有的查找与工具都能直接用。
是否下载只看「Wallpaper Engine 目录」设置：

- 设置为空（自动查找后仍为空）：下载到应用管理目录，写进这项设置。
- 设置指向应用管理目录：按 manifest 增量更新，manifest 没变就跳过。
- 设置指向别处（用户自己的安装或手选目录）：不下载，直接沿用。

下载完成后，这个目录就是一处普通的本机安装：场景壁纸读它的 `assets`，官方默认壁纸按现有的
`defaultprojects` 来源原地入库。因为直接写设置，`discover::engine_dir` 的查找顺序不用改。第二阶段用同一套
下载核心拉创意工坊订阅，下到当前 WPE 目录（我们下载的，或用户指定的）旁边的工坊目录，再原地入库。

### 网页 Cookie 能做什么（2026-11-15 实测）

畅游里登录 Steam 后，Cookie 里有两种 token：

| Cookie | 域 | `aud` | 有效期 |
|---|---|---|---|
| `steamLoginSecure` | 每个子站各一个（store / community / help / checkout / steam.tv） | `web:store`、`web:community` …… | 约 24 小时的 access token |
| `steamRefresh_steam` | `login.steampowered.com` | `web`、`renew`、`derive` | 约 7 个月的 refresh token |

两者都不带 `client`，不能用来登录 CM，所以拿不到 depot 解密密钥，也就下不了 WPE 本体和工坊内容；
`renew` / `derive` 只能续出新的网页 token。网页 access token 能调部分 Web API：`IPlayerService/GetOwnedGames`
返回 200，可以用来检查是否拥有 431960；`IPublishedFileService/GetUserFiles` 返回 401，要的是 API key。
所以 Cookie 只适合网页侧的辅助（检查是否购买、浏览工坊、读订阅页），登录仍走表单。

实现分两半，都在 Rust、都在 `wpe` feature 之内：

- **登录**（扫码、账号密码、Steam Guard）自己经 HTTPS 调 `IAuthenticationService`，消息类型用
  `steam-vent-proto-steam` 生成好的 protobuf。表单的每一步对应一次 HTTPS 调用，不用为等待用户输入而一直挂着 CM 连接。
- **Steam 连接**（PICS 查 depot 与 manifest、depot 解密密钥、manifest request code、CDN 服务器与授权 token、
  之后的创意工坊服务方法）用 `steam-vent` crate（MIT，自带 WebSocket 传输与 protobuf），用 refresh token 登录。
- **CDN 下载**（内容服务器列表、manifest 下载与解析、文件名解密、chunk 下载、AES 解密、解压、校验、拼文件）
  写在 `wpe::steam` 里，依赖已在锁文件里的 `aes` / `lzma` / `zstd` / `zip` 与 `reqwest`。可以照 SteamKit2 的
  CDN / manifest / chunk 实现移植（LGPL-2.1，可并入 GPL-3.0）。

### 关键决策与理由

1. **内建 Rust 而不是 kgpg 插件**：V8 运行时没有 WebSocket / TCP，CM 那一半做不了。放进 `wpe-import` 后，
   入库、设置、场景宿主的 `file:` 范围都在同一进程同一套代码里。
2. **登录放在前端表单，任务只拿账号**：Steam Guard 的验证码只有在登录之后才会发出，任务中途又没法让
   用户输入；放进表单，交互一次完成，密码也不落库。token 由后端存，前端只知道某个账号「已登录」。
3. **用 `steam-vent`，不自己写 CM**：CM 握手、加密信道、多消息封包、Steam Guard 状态机工作量大，也容易错；
   CDN 那一半格式稳定，自己写依赖更少。
4. **下载完整 WPE，只在没有设置时下载**：省掉文件过滤与「缺了哪部分」的判断，和真实安装完全一致。
   用户已经有 WPE 时什么都不下。
5. **安装到 `wpe-import` 的插件数据目录**（`AppPaths::plugin_data_dir`，内建插件也有）：随应用数据目录走，也不会和真正的 Steam 客户端抢目录。
6. **官方默认壁纸复用 `defaultprojects` 来源**：拉取完成后照常入库，不新增入库路径。
7. **许可证**：项目是 GPL-3.0。SteamKit2 是 LGPL-2.1，可以移植；DepotDownloader 只附 GPL-2.0 文本、没有声明
   「或更新版本」，和 GPL-3.0 不兼容，所以只参考它的流程，不复制代码。它本身主要是编排，核心实现都在
   SteamKit2 里。

## P0 结论（2026-11-15，macOS，工程在 `ignore/steam-p0`）

全链路走通：扫码登录 → CM → PICS → depot 密钥 → manifest → chunk 解密解压，`assets/shaders/common.h`
的 chunk 与整文件 SHA-1 都一致。

- **登录走 HTTPS，不走 `steam-vent`**：`steam-vent` 0.5 没有扫码登录，凭据登录是一个阻塞调用、不适合表单分步。
  `IAuthenticationService` 的 `BeginAuthSessionViaQR` / `PollAuthSessionStatus` 经
  `api.steampowered.com`（`input_protobuf_encoded`，响应是 protobuf，`x-eresult` 判结果）以 `SteamClient`
  平台类型调用，拿到的 refresh token `aud` 为 `client, web, renew, derive`，约 7 个月有效。账号密码登录
  （`GetPasswordRSAPublicKey` → `BeginAuthSessionViaCredentials` → `UpdateAuthSessionWithSteamGuardCode`）
  是同一个服务，同样走 HTTPS，P1 实测。
- **CM 用 `steam-vent`**：`Connection::access(账号, refresh token)` 能登录（它要的就是 refresh token，
  `iss` 必须是 `steam`）。PICS 要先取 app access token；`CMsgClientGetDepotDecryptionKey`、
  `GetManifestRequestCode`、`GetServersForSteamPipe`、`GetCDNAuthToken` 都能直接用它的 `job` /
  `service_method` 调，不用 fork。
- **depot**：`431961` 是主体（public manifest 826 MB，下载 377 MB，6301 个文件）；`431966` 只在
  `realm = steamchina` 时才要（8 MB）；`workshopdepot = 431960`。分支有 public / beta / previous /
  windows_7_support，只取 public。没有 `oslist`，按 realm 选 depot。
- **体积**：`distribution/bin` 510 MB 是 WPE 自己的运行时，`projects/defaultprojects` 142 MB，`assets` 76 MB，
  `ui` 37 MB，`locale` 8 MB。按「下载完整 WPE」的决定照下。
- **CDN 流程照 SteamKit2 / DepotDownloader**，差一步都拿不到：
  - `GetManifestRequestCode` 的 `app_branch` 在 public 时**留空**（传 `"public"` 拿到的码无效）；
  - 服务器只取 `SteamCache` / `CDN` 且允许本 app 的，按 `weighted_load` 排；URL 主机用 `vhost`，
    `https_support` 为 `mandatory` 才走 https，否则 http；跟随跳转；照常走系统代理；
  - manifest 返回 403 时，用该服务器的 `host`（不是 vhost）申请 `GetCDNAuthToken`，token 原样作为 query
    重试，之后这台服务器的 chunk 也带它（token 的格式因 CDN 而异，不解析）。本机分到的三台国内 CDN
    都必须带 token；
  - manifest 是单条目 zip，里面按 magic 分段（payload / metadata / signature / end）；文件名是 base64，
    **每 72 字符带换行**，解码前去空白；
  - 解密：前 16 字节 ECB 解出 IV，其余 CBC + PKCS7；chunk 解密后按头部分 VZip（LZMA）/ VSZa（zstd）/ zip，
    用 chunk id（解压后数据的 SHA-1）校验。
- **偶发**：连 CM 的 WebSocket 有一次超时，P1 要重试。

## 待定事项

- ~~复用前的轻量验证用什么~~（P1 已定）：直接连一次 CM。经 HTTPS 调 `GenerateAccessTokenForApp` 对客户端 token
  返回 eresult 63（AccountLogonDenied）；之后同一 token 连 CM 也被拒，原因未能确认（也可能是用户取消了授权），
  不再对客户端 token 调这个 HTTPS 方法。续期（renew）是否可行留待以后在 CM 上实测。
- 登录会话：对话框里的登录是一个后端内存里的待完成会话（带超时），关掉对话框就丢弃。要不要给 CLI
  也做一个登录命令？
- token 存储：复用插件数据 `plugin_data`，存在 `wpe-import` 行的一个保留顶层键下（暂名 `__private`，例如
  `__private.steamSessions[账号] = { refreshToken, steamId, exp }`），先明文，之后用 passkey 或系统钥匙串保护。
  `get_plugin_data` 同时注册在 Tauri、web 调度表（桌面应用 Web 服务器、Web 版）和插件详情 EJS 的
  `__bridge.getPluginData` 里，都能按任意插件 id 读。所以由 core 的 `get_plugin_data` 统一剥掉 `__private`，
  只有 Rust 内部的读取函数能看到它。这条规则是通用的，第三方插件以后也可以用；`setPluginData` 写入时要
  保留原有的 `__private`，不能被插件整份覆盖掉。多账号按账号名分开存，对话框记住最近一个账号。
- 自动更新：只在用户运行任务时检查 manifest，还是启动时也检查一次？
- 「重置」：用户在设置里清空目录后，应用管理目录是保留（下次拉取直接复用）还是删除？
- 失败保护：token 失效、频率限制、需要重新验证时，任务级失败重试不应再试。
- 创意工坊：P3 先做「我的订阅」（`PublishedFileService` 经 CM 调，不需要 API key）。浏览 / 搜索要不要做、
  做成什么 UI？
- 工坊壁纸写进用户自己的 Steam 库：`<库>/steamapps/workshop/content/431960` 归 Steam 客户端管，没登记在
  `appworkshop_431960.acf` 里的目录可能被 Steam 清掉。用户指定的是真实 Steam 安装时，是照写还是改放
  `<WPE>/projects/myprojects/`？

## 分期

| 期 | 内容 | 产出 |
|---|---|---|
| P0 ✅ | 可行性验证：`ignore/steam-p0` 独立小程序，扫码登录、取 431960 的 depot、manifest、解密密钥，下载并解密 chunk | 见「P0 结论」 |
| P1（代码完成，真机待测） | 后端登录命令（发起扫码 / 账号密码、提交验证码、轮询确认、列出已存会话及过期时间、复用前验证、删除会话）与 token 存储；对话框「从 Steam 拉取」卡片与登录表单；`wpe::steam` 的 CDN 客户端、完整下载与增量更新；`wpe-import` 新增来源与账号变量；按设置决定下载 / 更新 / 跳过并写设置；进度与取消 | macOS 上从零登录、拉取到可以渲染场景壁纸，密码不进任务参数 |
| P2 | 错误码映射成可读提示；登录类错误不触发任务重试；对话框显示已装版本与上次检查时间 | 第二次运行不需要密码，失败原因看得懂 |
| P3 | 创意工坊订阅拉取与入库，复用 P1 的下载核心与 token | 订阅的工坊壁纸可在没装 Steam 的机器上导入 |
| P4 | token 保护：passkey 或系统钥匙串 | token 不再明文存放 |
