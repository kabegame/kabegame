pub async fn fetch_favicon(host: &str) -> Option<Vec<u8>> {
    let host = host.trim().trim_matches('/').to_lowercase();
    if host.is_empty() {
        return None;
    }

    let urls = [
        format!("https://{host}/favicon.ico"),
        format!("https://www.google.com/s2/favicons?domain={host}&sz=128"),
        format!("https://logo.clearbit.com/{host}?size=128"),
    ];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("kabegame/favicon-fetcher")
        .build()
        .ok()?;

    for url in urls {
        let Ok(resp) = client.get(&url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_type.starts_with("image/") && !url.ends_with(".ico") {
            continue;
        }
        let Ok(bytes) = resp.bytes().await else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        return Some(bytes.to_vec());
    }

    None
}
