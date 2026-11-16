# Web 版支持 WPE 壁纸 —— 总计划（思路）

本文只记思路、已倾向的决策与待定事项，不含现状锚点与逐点代码；各期细化时再拆分文件。

---

## 总体设计思路

桌面上网页壁纸和场景宿主都是应用页里的 `file:` iframe，靠三样桌面专属的东西跑起来：CEF 让它们能读本地文件（`file:` 加闸门）、给子 frame 注入 Tauri IPC 桥（ACL 按 capability 放行），再加上应用经 CEF 补丁把原生鼠标注入进去。Web 版是浏览器加 HTTP 服务器，这三样都没有。方案是**把这三样换成 Web 上的等价物，iframe 里的代码（场景宿主、`wpe_shim.js`）基本不改**：
- **读文件**：换成 HTTP，`file:` 地址统一映射成 HTTP 地址；
- **IPC**：在 iframe 里放一个基于 `postMessage` 的 `__TAURI_INTERNALS__`，由父页面代理到 Web 的 `/rpc` 与 SSE；
- **鼠标**：浏览器里 iframe 本来就能收到真实鼠标，直接走 Linux 现有的退回路径。

**关于「hook fetch」的取舍。** 场景宿主里所有本地路径都只经过一个函数 `apps/wpe-scene/src/fileUrl.ts` 的 `fileToUrl`。对它的调用里，fetch 只占大部分（编译管线、`scene.pkg` 区间读、纹理、视频与用户视频取 Blob、`jsmodules` 查找、字体 wasm），另外还有三处不走 fetch：场景脚本 realm 里 `baseclasses.js` 与用户模块的 `<script src>`、import map、声音散文件的媒体元素 `src`。全局 hook fetch 管不到这三处，所以**场景宿主里不 hook fetch，改 `fileToUrl` 这一个函数**：Web 上它按后端给的「本地根 → URL 前缀」映射产出 HTTP 地址，fetch、`<script src>`、媒体 `src` 一次全部覆盖，也不用在全局打补丁。hook 只在**第三方页面**里才有意义，也就是网页壁纸。网页壁纸自己的资源都写相对路径，经 HTTP 加载天然可用，只有用户属性里 `file` / `directory` 的值会被页面拼成 `file:///…`。Web 上用户本来选不了服务器上的文件，这类值只会出现在从桌面带过来的数据里，所以这里的 hook（fetch、XHR，以及 `src` / `setAttribute` 的 setter）只算尽力而为的补丁，放在最后一期。

**文件经由谁提供，沿用 Web 现在的媒体规则。** debug 构建由同端口的 `/file/<路径>` 提供（它已经能对 WPE 目录内的文件做带 Range 的流式返回）。release 构建由 CDN 提供（`image_rewrite` 在出口把本地路径改写成 `cdn.kabegame.com/<末级目录>/…`）。要新增的只有两处：
- 场景要读的第二个根「WPE 安装目录的 `assets/`」，也要能经 `/file` 读、能上 CDN；
- 后端在 Web 出口改写的字段，从图片的媒体路径扩大到壁纸目标的 `webEntry` 和场景目标里的根。

场景宿主的构建产物、wasm（`wpesl2wgsl`、`wpefont`）随 Web 前端一起发布到 `cdn.kabegame.com/web/wpe-scene/`。这样宿主与壁纸文件都在 CDN 这一个源上，带 Range 的读取不需要 CORS 预检；它们相对应用页（demo 域名）是跨源的，隔离关系和桌面上「`file:` 源 ≠ 应用源」一致。

**IPC 桥由父页面放行。** 桌面上，iframe 能调什么命令由 ACL 的 `wpe-web-capability` / `wpe-scene-host-capability` 决定；「是哪一张壁纸」则由 `CallerOrigin`（文档 URL）认出。Web 上这两件事都交给父页面（`WpeWallpaperContent` / `WpeSceneView`）：
- 父页面按 `event.source` 认出是哪个 iframe，只放行与两个 capability 对应的命令白名单，并替 iframe 补上它自己的 `imageId`，后端命令不再依赖调用方身份；
- 事件只转发 capability 允许监听的那几个（相当于 `allow-listen` 作用域）。

父页面已经在用 `postMessage` 处理音量、右键、加载进度、样式，IPC 代理只是在同一个消息通道里再加一类消息。Channel（音频频谱、媒体）在 Web 上没有意义（服务器的声卡不是用户的），订阅一律回「不支持」。现有的「非 Windows 时脚本收到 `enabled: false`」路径正好接住这个结果。

**后端要在 Web 构建里开放 WPE 的只读部分。** 现在 `wpe` feature 在 Web 上整体不编译。需要拆出只读的子集给 Web 开启，包括：
- 用户属性解析 `wpe::user_props`；
- `wpe_web_pull_state`、`wpe_scene_target`、`get_wpe_scene_host_url`；
- 预览设置的读取；
- `wpe_scene_report` 的日志。

导入、Steam、媒体采集、快捷方式、封面截图仍然只在桌面编译。写操作（改属性、预览设置）在 Web 上是否持久化，看下面的待定事项。

---

## 关键决策（已倾向）

1. **场景宿主改 `fileToUrl`，不 hook 全局 fetch**：它是唯一的转换点，能覆盖 fetch 管不到的 `<script src>`、import map、媒体 `src`。产出 HTTP 地址后，`compile/fs.ts` 里「`file:` 响应 200、只核对长度」的读法对 206 同样成立，读取代码不用改。
2. **IPC 用 `postMessage` 版 `__TAURI_INTERNALS__`**：场景宿主（`@tauri-apps/api` 的 `invoke` / `listen`）和垫片（`internals.invoke`）都不改调用方式。桥由谁装：场景宿主在 `main.ts` 里检测到 Web 时自装；网页壁纸跟垫片一起注入。
3. **身份由父页面补，不由后端认**：Web 上没有 `CallerOrigin`。命令改成显式带 `imageId`（场景宿主的命令已经带了，`wpe_web_pull_state` 补一个可选参数），父页面强制改写成该 iframe 对应的 id，iframe 自己填的不算数。
4. **鼠标走 Linux 退回路径**：不调 `plugin:cursor|attach_frame`（父页面回的音量消息里，可交互由 Web 判定为直接收事件）；开场光标 `wpe_scene_cursor` 由父页面用自己最后一次的 pointer 位置回答。
5. **不做的**：音频、媒体集成、快捷方式、设为壁纸封面、桌面壁纸窗口。Web 上只有图库预览与应用背景两个形态。

---

## 待定事项

1. **（前置，决定做不做）公开 demo 的分发许可。** 场景离不开 WPE 安装目录的 `assets/`（通用着色器、材质），这是 Wallpaper Engine 的专有文件，上 CDN 等于公开再分发；创意工坊壁纸本身也有作者授权问题。可选：
   - a. 公开 demo 只开网页壁纸，不开场景；
   - b. 只对 super / 自部署开放，公开 demo 维持「只显示预览图」；
   - c. 只有一份我们有权分发的样例集。
   这一项不定，后面的范围定不下来。
2. **网页壁纸的垫片怎么注入。** 第三方 `index.html` 是 CDN 上的静态文件，没有 CEF 的 all-frames 注入。
   - a. CDN 源上放一个通用宿主页 `wpe-web.html?entry=…`：取回入口 HTML，插入 `<base>`、桥、垫片后 `document.write`。源仍是 CDN，隔离不变；代价是 `location` 停在宿主页（垫片已经处理过 history），还有 `document.write` 的少量怪癖。
   - b. 应用服务器动态返回注入后的入口 HTML，子资源经 `<base>` 指向 CDN。实现最简单，但文档变成 demo 域名同源，`localStorage` 和应用混在一起，`sandbox` 去掉 `allow-same-origin` 又会让 `localStorage` 抛错。
   - 倾向 a。
3. **Web 上的写操作。** 非 super 的 Web 是只读的。属性面板与预览设置可以：
   - a. 只改本页内存里的草稿，不写库；
   - b. 对非 super 隐藏写入口。
   super 是否允许写库另外再定。
4. **feature 怎么拆。** 可以在 core / app 两侧各拆出 `wpe-view` 给 Web 开；也可以让 Web 开 core 的 `wpe`，平台依赖只挂在 app 侧。要先看 core 的 `wpe` 带进了多少平台依赖再定。
5. **CDN 的可达范围。** `rewrite_fs_path` 只取「末级目录名 + 文件名」，所以只有下载目录里的壁纸目录（`relocate` 过来的）在 CDN 上。原地导入的（Steam 库路径）到不了，这类行在 Web 上退回预览图。WPE `assets/` 要单独上传，并约定 CDN 路径。
6. **流量与体积。** `scene.pkg` 和场景视频可达数百 MB，release 下全部走 OSS 流量。要不要在 Web 上只在用户主动打开预览时加载、给出体积提示、或设上限，待定。
7. **字体。** 场景宿主放行的系统字体是 `%WINDIR%\Fonts` 下的 13 个文件，Web 服务器上没有，Windows 字体也不能再分发。用到系统字体的文本场景在 Web 上是退回，还是换成可分发的替代字体，待定。
8. **debug 下的同源。** debug 时应用、宿主、壁纸都在同一个端口上，iframe 带 `allow-same-origin` 时与应用同源。开发期接受，还是用 `127.0.0.1` / `localhost` 两个主机名错开，待定。
9. **浏览器能力。** 渲染场景需要 WebGPU，以及（多数场景）`texture-compression-bc`，要求安全上下文：经局域网 IP 的 http 自部署拿不到 WebGPU，移动端浏览器多数没有 BC。这些情况走现有的退回预览图加红字原因，文案要区分「浏览器不支持」。

---

## 分期

| 期 | 内容 | 验收 |
|---|---|---|
| W0 | 定待定 1（许可与开放范围），据此裁剪后面各期 | 有结论 |
| W1 | 后端：Web 开 WPE 只读子集；`/file` 授权 WPE `assets/`；Web 出口改写 `webEntry` 与场景根；只读命令进 Web dispatch，显式 `imageId` | debug Web 下，`wpe_scene_target` / `wpe_web_pull_state` 能经 `/rpc` 取到，`/file` 能带 Range 读到 pkg 与 assets |
| W2 | IPC 桥：`postMessage` 版 `__TAURI_INTERNALS__`（invoke、listen、Channel 回不支持）；父页面代理、命令与事件白名单、补 `imageId` | 单测覆盖白名单与身份改写；桌面行为不变 |
| W3 | 场景宿主上 Web：构建进 Web 产物；`fileToUrl` 走映射；`get_wpe_scene_host_url` 返回 HTTP 地址；鼠标走真实事件；开场光标由父页面回答 | debug Web 下，一批能渲染的场景与桌面画面哈希一致（排除音频 / 媒体 / 快捷方式 / 系统字体） |
| W4 | 网页壁纸上 Web：按待定 2 注入桥与垫片；音量、暂停、右键、history 复用现有协议 | 语料里的网页壁纸在 Web 上能显示、属性生效 |
| W5 | release 与部署：宿主与 wasm 上 CDN、WPE `assets/` 上传（如果 W0 允许）、`deploy-web.sh` 跟进；流量策略（待定 6） | 线上 demo 可用、MIME / CORS 正确 |
| W6（可选） | 网页壁纸里旧 `file:` 属性值的兜底 hook（fetch、XHR、`src` / `setAttribute`）；Web 上的属性草稿编辑（待定 3） | 带 `directory` 属性的幻灯片壁纸用桌面带来的数据能显示 |
