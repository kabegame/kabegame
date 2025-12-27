// 示例爬取脚本
// 用户可以在脚本中自定义所有变量和逻辑

// 定义起始 URL（用户在前端输入的 URL 会作为 start_url 变量传入，但这里可以自己定义）
// 计算总页数
let total_pages = max_pages - start_page + 1;

// 遍历所有页面
let pg = start_page;
while pg <= max_pages {
    let start_url = `https://anihonetwallpaper.com/ranking-daily-imgpc/${pg}`;
    to(start_url);
    
    // 使用 CSS 选择器获取所有链接的 href 属性
    // 函数现在直接返回数组，不需要处理 Result
    let hrefs = get_attr("a", "href");
    
    // 计算每页应该增加的进度：90% / 总页数（留10%给下载阶段）
    let page_progress_increment = 90.0 / total_pages;
    
    // 遍历所有链接
    let idx = 0;
    let total_links = hrefs.len();
    while idx < total_links {
        let href = hrefs[idx];
        let full_url = resolve_url(href);
        to(full_url);
        
        // 使用 query_by_text 查找包含"画像をダウンロード"的元素
        let elements = query_by_text("画像をダウンロード");
        let elem_idx = 0;
        while elem_idx < elements.len() {
            let element = elements[elem_idx];
            // query_by_text 返回的是 Map，包含 tag 和 attrs
            let tag = element["tag"];
            if tag == "a" {
                let attrs = element["attrs"];
                let href = attrs["href"];
                let full_image = resolve_url(href);
                if is_image_url(full_image) {
                    // download_image 会将图片添加到下载队列，异步下载
                    download_image(full_image);
                }
            }
            elem_idx = elem_idx + 1;
        }
        
        // 每处理一个链接，增加一部分进度
        // 链接进度增量 = 页面进度增量 / 总链接数
        if total_links > 0 {
            let link_progress_increment = page_progress_increment / total_links;
            add_progress(link_progress_increment);
        }
        
        idx = idx + 1;
    }
    
    // 移动到下一页
    pg = pg + 1;
}

// 所有页面处理完成，确保进度达到 99.9%（等待下载完成）
// 注意：任务成功结束时，后端会自动设置为 100%
// 这里不需要额外操作，因为 Rust 中已经限制了最大值为 99.9%


