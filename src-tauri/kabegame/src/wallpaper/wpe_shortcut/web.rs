//! 网址快捷方式的图标（照 `rea-p11d.md` 第 1 节，WPE 的 `winrtutil!FUN_14002fb10`）。
//!
//! 用页面里的 `<link>` 挑图标：按用户填的网址原样请求（建不成地址才补 `https://`、`https://www.`），只带一条
//! iPhone Safari 的 User-Agent，不看状态码，整页读成字符串；不分大小写地扫全部 `<link`，只认双引号属性，apple 图标按
//! `sizes` 的宽排前，最后补 `/favicon.ico`，按宽从大到小稳定排序；以最终响应地址为基准拼相对地址，逐个下载，第一个能解码的
//! 就用（ICO 取像素最多的一帧，不支持 SVG）。边长 ≤ 512 的正方形保持原尺寸，否则缩成 `min(w, h, 512)` 的正方形，再乘圆形遮罩。
//! 全部失败用 WPE 自带的 `assets/materials/util/webthumbnailfallback.png`（不缩放，同样乘遮罩）。不去预乘、不做透明区填色。

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use url::Url;

use super::{cv, Icon};

/// WPE 请求页面与图标时用的 User-Agent（`winrtutil` 里的原文）。
const USER_AGENT: &str = "Mozilla/5.0 (iPhone17,2; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Resorts/4.5.2";

/// 单次请求的超时。
// TODO:[WPE_SCENE] WPE 代码里没设超时，WinRT `HttpClient` 缺省是 100 s【未知】；这里取 15 s，免得一个慢站点挂住图标槽。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 缩放的边长上限。
const MAX_SIDE: u32 = 512;

/// 网址 → 图标。页面与候选都失败时用缺省图；缺省图也读不到返回 `None`（这个槽用缺省纹理）。
pub async fn icon(input: &str) -> Option<Icon> {
    if let Some(icon) = fetch_icon(input).await {
        return Some(icon);
    }
    tokio::task::spawn_blocking(fallback_icon)
        .await
        .ok()
        .flatten()
}

fn client() -> Option<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT);
    if let Some(proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().ok()
}

async fn fetch_icon(input: &str) -> Option<Icon> {
    let client = client()?;
    // 请求用户填的整串；建不成地址才依次补 https://、https://www.（只试第一个建得成的）
    let page_url = page_urls(input).into_iter().next()?;
    // 页面取不到（DNS、连接、TLS、协议不支持如 steam://、正文读不出）都按失败处理
    let response = client.get(page_url).send().await.ok()?;
    let base = response.url().clone();
    let html = response.text().await.ok()?;
    for href in icon_candidates(&html) {
        let Some(url) = base.join(&href).ok().or_else(|| Url::parse(&href).ok()) else {
            continue;
        };
        let Ok(response) = client.get(url).send().await else {
            continue;
        };
        let Ok(bytes) = response.bytes().await else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        if let Some(icon) = decode_icon(&bytes) {
            return Some(icon);
        }
    }
    None
}

/// 用户填的串 → 可请求的地址，按 WPE 的顺序：原串、`https://` + 串、`https://www.` + 串，建得成的留下。
fn page_urls(input: &str) -> Vec<Url> {
    [
        input.to_owned(),
        format!("https://{input}"),
        format!("https://www.{input}"),
    ]
    .iter()
    .filter_map(|text| Url::parse(text).ok())
    .collect()
}

struct Regexes {
    link: Regex,
    apple: Regex,
    href: Regex,
    sizes: Regex,
    icon: Regex,
}

/// WPE 的五个正则（ECMAScript、不分大小写）。`\W` / `\d` 在 ECMAScript 里只认 ASCII，这里写成显式的 ASCII 类。
fn regexes() -> &'static Regexes {
    static REGEXES: OnceLock<Regexes> = OnceLock::new();
    REGEXES.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(&format!("(?i){pattern}")).expect("正则");
        Regexes {
            link: compile("<link([^>]*)"),
            apple: compile(r#"rel[^A-Za-z0-9_]*=[^A-Za-z0-9_]*"(apple-touch-icon|apple-touch-icon-precomposed)""#),
            href: compile(r#"href[^A-Za-z0-9_]*=[^A-Za-z0-9_]*"([^"]*)""#),
            sizes: compile(r#"sizes[^A-Za-z0-9_]*=[^A-Za-z0-9_]*"([0-9]*)x([0-9]*)""#),
            icon: compile(r#"rel[^A-Za-z0-9_]*=[^A-Za-z0-9_]*"(shortcut|icon|[^A-Za-z0-9_]+)+""#),
        }
    })
}

/// 扫整页的 `<link`，返回按宽从大到小稳定排序的 href 列表（最后总有一个 `/favicon.ico`，宽 0）：
/// apple 图标 href 非空才收、宽取 `sizes` 的第一个数；普通图标宽 0、href 缺失也收（空串）。
pub(super) fn icon_candidates(html: &str) -> Vec<String> {
    let re = regexes();
    let mut candidates: Vec<(String, f32)> = Vec::new();
    for link in re.link.captures_iter(html) {
        let attributes = &link[1];
        let href = || {
            re.href
                .captures(attributes)
                .map(|caps| caps[1].to_owned())
                .unwrap_or_default()
        };
        if re.apple.is_match(attributes) {
            let width = re
                .sizes
                .captures(attributes)
                .map(|caps| caps[1].parse::<f32>().unwrap_or(0.0))
                .unwrap_or(0.0);
            let href = href();
            if !href.is_empty() {
                candidates.push((href, width));
            }
        } else if re.icon.is_match(attributes) {
            candidates.push((href(), 0.0));
        }
    }
    candidates.push(("/favicon.ico".to_owned(), 0.0));
    // 稳定排序：同宽保持文档顺序，`/favicon.ico` 在宽 0 的组里最后
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    candidates.into_iter().map(|(href, _)| href).collect()
}

/// ICO 取像素数严格最大的一帧（相等时保留先出现的），拼成只含这一帧的 ICO 交给解码器；不是 ICO 或结构不对返回 `None`。
pub(super) fn largest_ico_frame(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 6 || bytes[..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut best: Option<(usize, u32)> = None;
    for index in 0..count {
        let entry = bytes.get(6 + index * 16..6 + index * 16 + 16)?;
        // 宽高 0 表示 256
        let side = |value: u8| if value == 0 { 256u32 } else { value as u32 };
        let pixels = side(entry[0]) * side(entry[1]);
        if best.is_none_or(|(_, top)| pixels > top) {
            best = Some((index, pixels));
        }
    }
    let (index, _) = best?;
    let entry = &bytes[6 + index * 16..6 + index * 16 + 16];
    let size = u32::from_le_bytes(entry[8..12].try_into().ok()?) as usize;
    let offset = u32::from_le_bytes(entry[12..16].try_into().ok()?) as usize;
    let data = bytes.get(offset..offset.checked_add(size)?)?;
    let mut single = Vec::with_capacity(22 + data.len());
    single.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    single.extend_from_slice(&entry[..12]);
    single.extend_from_slice(&22u32.to_le_bytes());
    single.extend_from_slice(data);
    Some(single)
}

/// 按内容认格式并解码成 RGBA；宽或高为 0、认不出（SVG 等）返回 `None`。尺寸不是 ≤ 512 的正方形时缩成
/// `min(w, h, 512)` 的正方形，最后乘圆形遮罩。
fn decode_icon(bytes: &[u8]) -> Option<Icon> {
    let ico_frame = largest_ico_frame(bytes);
    let source = ico_frame.as_deref().unwrap_or(bytes);
    let image = image::load_from_memory(source).ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    let image = if width > MAX_SIDE || height > MAX_SIDE || width != height {
        let side = width.min(height).min(MAX_SIDE);
        // TODO:[WPE_SCENE] WPE 的缩放滤镜【未知】（`FUN_1400653e0` 里用了哪个 FreeImage 滤镜没读），先用 FreeImage `Rescale`
        // 的缺省 Catmull-Rom；拉伸成正方形、不保持比例、不裁切。
        image::imageops::resize(&image, side, side, image::imageops::FilterType::CatmullRom)
    } else {
        image
    };
    let (width, height) = image.dimensions();
    let mut rgba = image.into_raw();
    cv::circle_mask(&mut rgba, width as usize, height as usize);
    Some(Icon {
        width,
        height,
        rgba,
    })
}

/// 缺省图：`<WPE 安装目录>/assets/materials/util/webthumbnailfallback.png`，不缩放，乘圆形遮罩。
fn fallback_icon() -> Option<Icon> {
    let path = kabegame_core::wpe::discover::engine_dir()?
        .join("assets/materials/util/webthumbnailfallback.png");
    let image = image::open(path).ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    let mut rgba = image.into_raw();
    cv::circle_mask(&mut rgba, width as usize, height as usize);
    Some(Icon {
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_urls_follow_wpes_order() {
        // 能解析成绝对地址就不改
        let urls = page_urls("https://example.com/a?b=1");
        assert_eq!(urls[0].as_str(), "https://example.com/a?b=1");
        // 解析不了才依次补 https://、https://www.（两个都建得成，取第一个）
        let urls = page_urls("example.com");
        assert_eq!(urls[0].as_str(), "https://example.com/");
        assert_eq!(urls[1].as_str(), "https://www.example.com/");
    }

    #[test]
    fn candidates_sort_by_width_descending_and_stably() {
        let html = r#"
            <html><head>
            <LINK rel="icon" href="/a.png">
            <link rel="apple-touch-icon" sizes="57x57" href="/57.png">
            <link rel="shortcut icon" href="/b.ico">
            <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/180.png">
            <link rel="apple-touch-icon" href="/nosize.png">
            </head></html>"#;
        assert_eq!(
            icon_candidates(html),
            [
                "/180.png",
                "/57.png",
                "/a.png",
                "/b.ico",
                "/nosize.png",
                "/favicon.ico"
            ]
        );
    }

    #[test]
    fn candidate_edges_follow_the_regexes() {
        // 只认双引号：单引号、无引号的属性认不出（href 认不出时 apple 链接被丢弃、普通链接以空串加入）
        assert_eq!(
            icon_candidates("<link rel='icon' href='/x.png'>"),
            ["/favicon.ico"]
        );
        assert_eq!(
            icon_candidates(r#"<link rel="icon" href=/x.png>"#),
            ["", "/favicon.ico"]
        );
        assert_eq!(
            icon_candidates(r#"<link rel="apple-touch-icon" href=/x.png>"#),
            ["/favicon.ico"]
        );
        // alternate icon / mask-icon 不算；icon shortcut、rel = "icon" 算
        assert_eq!(
            icon_candidates(
                r#"<link rel="alternate icon" href="/a.png"><link rel="mask-icon" href="/m.svg">"#
            ),
            ["/favicon.ico"]
        );
        assert_eq!(
            icon_candidates(r#"<link rel = "icon shortcut" href = "/s.png">"#),
            ["/s.png", "/favicon.ico"]
        );
        // sizes 不匹配（any、多组）宽取 0；`sizes="x"` 宽也是 0
        assert_eq!(
            icon_candidates(
                r#"<link rel="apple-touch-icon" sizes="any" href="/any.png"><link rel="apple-touch-icon" sizes="64x64" href="/64.png">"#
            ),
            ["/64.png", "/any.png", "/favicon.ico"]
        );
        // href 不做实体解码
        assert_eq!(
            icon_candidates(r#"<link rel="icon" href="/a?x=1&amp;y=2">"#),
            ["/a?x=1&amp;y=2", "/favicon.ico"]
        );
        // 没有任何 link：只有 /favicon.ico
        assert_eq!(icon_candidates("<html></html>"), ["/favicon.ico"]);
    }

    #[test]
    fn relative_hrefs_resolve_against_the_final_url() {
        let base = Url::parse("https://example.com/dir/page.html").unwrap();
        for (href, expected) in [
            ("/a.png", "https://example.com/a.png"),
            ("a.png", "https://example.com/dir/a.png"),
            ("//cdn.x.com/a.png", "https://cdn.x.com/a.png"),
            ("../a.png", "https://example.com/a.png"),
            ("https://o.com/a.png", "https://o.com/a.png"),
        ] {
            assert_eq!(base.join(href).unwrap().as_str(), expected);
        }
    }

    /// 造一个 PNG 字节（纯色）。
    fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba(rgba));
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn decoded_icons_keep_small_squares_and_shrink_the_rest() {
        // ≤ 512 的正方形保持原尺寸
        let icon = decode_icon(&png(160, 160, [1, 2, 3, 255])).unwrap();
        assert_eq!((icon.width, icon.height), (160, 160));
        assert_eq!(icon.rgba.len(), 160 * 160 * 4);
        // 不是正方形：缩成 min(w, h) 的正方形
        let icon = decode_icon(&png(600, 400, [1, 2, 3, 255])).unwrap();
        assert_eq!((icon.width, icon.height), (400, 400));
        // 大于 512：缩成 512
        let icon = decode_icon(&png(700, 700, [1, 2, 3, 255])).unwrap();
        assert_eq!((icon.width, icon.height), (512, 512));
        // 认不出（SVG、HTML）
        assert!(decode_icon(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        assert!(decode_icon(b"<html></html>").is_none());
    }

    #[test]
    fn ico_takes_the_frame_with_the_most_pixels() {
        // 两帧 PNG 数据的 ICO：16x16 在前、32x32 在后；取 32x32
        let (small, big) = (png(16, 16, [255, 0, 0, 255]), png(32, 32, [0, 255, 0, 255]));
        let mut ico = vec![0, 0, 1, 0, 2, 0];
        let first = 6 + 32;
        for (side, data, offset) in [(16u8, &small, first), (32u8, &big, first + small.len())] {
            ico.extend_from_slice(&[side, side, 0, 0, 1, 0, 32, 0]);
            ico.extend_from_slice(&(data.len() as u32).to_le_bytes());
            ico.extend_from_slice(&(offset as u32).to_le_bytes());
        }
        ico.extend_from_slice(&small);
        ico.extend_from_slice(&big);
        let icon = decode_icon(&ico).unwrap();
        assert_eq!((icon.width, icon.height), (32, 32));
        // 看圆心：decode_icon 最后乘了圆形遮罩，角在圆外（alpha 0），圆内 alpha = (255·255) >> 8 = 254
        let center = (16 * 32 + 16) * 4;
        assert_eq!(&icon.rgba[center..center + 4], &[0, 255, 0, 254]);
        assert!(largest_ico_frame(&ico).is_some());
        assert!(largest_ico_frame(b"not an ico").is_none());
    }
}
