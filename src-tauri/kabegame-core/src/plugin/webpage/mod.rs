//! builtin `webpage`（网页收集）插件的脚本载荷与变量定义。
//!
//! `page_discover.js` 是唯一一份页面媒体发现脚本：既是本插件的 builtin 载荷
//! （`PluginScript::builtin_source()`），也被畅游一键下载与网页收集 WebView 任务直接拼接复用。
//! 运行逻辑（配置校验、按后端分流）在 `crate::crawler::webpage`。

use super::VarDefinition;
use serde_json::json;

/// 保留插件 ID：同名 `.kgpg` 由内建表统一拒绝。
pub const WEBPAGE_PLUGIN_ID: &str = "webpage";

/// 页面媒体发现脚本（不挂 window、不依赖任务，只定义 `discoverMedia`）。
pub const PAGE_DISCOVER_JS: &str = include_str!("page_discover.js");

/// V8 / WebView 两个后端共用的编排（冻结快照、逐个提交下载、汇总日志），需前置 [`PAGE_DISCOVER_JS`]。
pub const WEBPAGE_COLLECT_JS: &str = include_str!("webpage_collect.js");

/// V8 后端入口（`export async function crawl`）。
const WEBPAGE_V8_COLLECT_JS: &str = include_str!("webpage_v8_collect.js");

/// V8 后端执行的完整自包含 ES 模块源码。
pub fn v8_collect_module() -> String {
    [
        PAGE_DISCOVER_JS,
        "\n",
        WEBPAGE_COLLECT_JS,
        "\n",
        WEBPAGE_V8_COLLECT_JS,
    ]
    .concat()
}

/// 插件变量（manifest 扁平 i18n 格式），同时作为 `var_defs` 与前端 `config.vars` 的唯一来源。
pub(super) fn var_defs() -> Vec<VarDefinition> {
    let value = json!([
        {
            "key": "url",
            "type": "string",
            "name": "Full URL",
            "name.zh": "完整 URL",
            "name.zhtw": "完整 URL",
            "name.ja": "完全な URL",
            "name.ko": "전체 URL",
            "descripts": "An absolute http(s) address of a single page; only that page is collected",
            "descripts.zh": "单个网页的完整 http(s) 地址，只收集这一页",
            "descripts.zhtw": "單一網頁的完整 http(s) 位址，只收集這一頁",
            "descripts.ja": "単一ページの完全な http(s) アドレス。そのページのみ収集します",
            "descripts.ko": "단일 페이지의 전체 http(s) 주소이며 해당 페이지만 수집합니다",
        },
        {
            "key": "backend",
            "type": "options",
            "default": "v8",
            "name": "Backend",
            "name.zh": "后端",
            "name.zhtw": "後端",
            "name.ja": "バックエンド",
            "name.ko": "백엔드",
            "options": [
                {
                    "variable": "v8",
                    "name": "V8 (static HTML, recommended)",
                    "name.zh": "V8（静态 HTML，推荐）",
                    "name.zhtw": "V8（靜態 HTML，推薦）",
                    "name.ja": "V8（静的 HTML・推奨）",
                    "name.ko": "V8 (정적 HTML, 권장)",
                },
                {
                    "variable": "webview",
                    "name": "WebView (browser rendering)",
                    "name.zh": "WebView（浏览器渲染）",
                    "name.zhtw": "WebView（瀏覽器渲染）",
                    "name.ja": "WebView（ブラウザ描画）",
                    "name.ko": "WebView (브라우저 렌더링)",
                },
            ],
        },
        {
            "key": "injectSurfCookie",
            "type": "boolean",
            "default": true,
            "when": { "backend": ["v8"] },
            "name": "Inject Surf cookies",
            "name.zh": "自动注入畅游 Cookie",
            "name.zhtw": "自動注入暢遊 Cookie",
            "name.ja": "サーフの Cookie を自動注入",
            "name.ko": "서핑 쿠키 자동 주입",
            "descripts": "If you have visited or signed in to this site in Surf, send its cookies",
            "descripts.zh": "若在畅游里访问或登录过该站，自动带上其 Cookie",
            "descripts.zhtw": "若在暢遊裡造訪或登入過該站，自動帶上其 Cookie",
            "descripts.ja": "サーフでこのサイトを閲覧・ログインしたことがあれば、その Cookie を送信します",
            "descripts.ko": "서핑에서 이 사이트를 방문하거나 로그인한 적이 있으면 해당 쿠키를 함께 보냅니다",
        },
        {
            "key": "injectCefUserAgent",
            "type": "boolean",
            "default": true,
            "when": { "backend": ["v8"] },
            "name": "Use the browser User-Agent",
            "name.zh": "自动注入 CEF UA",
            "name.zhtw": "自動注入 CEF UA",
            "name.ja": "CEF の UA を自動注入",
            "name.ko": "CEF UA 자동 주입",
            "descripts": "Use the same User-Agent as Surf (cookies such as Cloudflare clearance are bound to it)",
            "descripts.zh": "使用与畅游一致的浏览器 User-Agent（Cloudflare 等绑定 UA 的 Cookie 需要）",
            "descripts.zhtw": "使用與暢遊一致的瀏覽器 User-Agent（Cloudflare 等綁定 UA 的 Cookie 需要）",
            "descripts.ja": "サーフと同じ User-Agent を使います（Cloudflare など UA に紐づく Cookie に必要）",
            "descripts.ko": "서핑과 같은 User-Agent를 사용합니다(Cloudflare 등 UA에 묶인 쿠키에 필요)",
        },
    ]);
    serde_json::from_value(value).expect("webpage 内建插件变量定义必须合法")
}
