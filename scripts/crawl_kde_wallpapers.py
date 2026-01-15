#!/usr/bin/env python3
"""
爬取 KDE Store Plasma 5 壁纸插件源代码
使用 OpenDesktop OCS API
https://store.kde.org/browse?cat=419&ord=latest
"""

import os
import re
import time
import tarfile
import zipfile
import requests
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

# 配置
OCS_API_URL = "https://api.opendesktop.org/ocs/v1"
CATEGORY_ID = 419  # Plasma 5 Wallpaper Plugins
OUTPUT_DIR = Path("wallpaper-example")
DELAY_BETWEEN_REQUESTS = 3  # 秒，避免限流
MAX_RETRIES = 3  # 最大重试次数
RETRY_DELAY = 10  # 重试延迟（秒）

# 请求头
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/xml,text/xml,*/*",
}


def get_session():
    """创建会话"""
    session = requests.Session()
    session.headers.update(HEADERS)
    return session


def get_all_content_items(session):
    """获取所有壁纸插件列表"""
    url = f"{OCS_API_URL}/content/data"
    params = {
        "categories": CATEGORY_ID,
        "pagesize": 100,  # 获取所有（共34个）
        "page": 0,
    }
    
    print(f"获取插件列表: {url}")
    response = session.get(url, params=params, timeout=30)
    response.raise_for_status()
    
    # 解析 XML
    root = ET.fromstring(response.text)
    
    # 检查状态
    status = root.find(".//status")
    if status is not None and status.text != "ok":
        raise Exception(f"API 错误: {status.text}")
    
    total_items = root.find(".//totalitems")
    print(f"共找到 {total_items.text if total_items is not None else '?'} 个插件")
    
    # 提取内容项
    items = []
    for content in root.findall(".//content"):
        item = {
            "id": content.findtext("id", ""),
            "name": content.findtext("name", ""),
            "version": content.findtext("version", ""),
            "personid": content.findtext("personid", ""),
            "description": content.findtext("description", ""),
            "downloadlink1": content.findtext("downloadlink1", ""),
        }
        items.append(item)
    
    return items


def get_content_details(session, content_id):
    """获取单个插件的详细信息（包括下载链接）"""
    url = f"{OCS_API_URL}/content/data/{content_id}"
    
    response = session.get(url, timeout=30)
    response.raise_for_status()
    
    root = ET.fromstring(response.text)
    content = root.find(".//content")
    
    if content is None:
        return None
    
    # 提取所有下载链接
    downloads = []
    for i in range(1, 10):  # 最多9个下载链接
        link = content.findtext(f"downloadlink{i}", "")
        name = content.findtext(f"downloadname{i}", "")
        if link:
            downloads.append({
                "url": link,
                "name": name or f"file{i}",
            })
    
    return {
        "id": content.findtext("id", ""),
        "name": content.findtext("name", ""),
        "version": content.findtext("version", ""),
        "personid": content.findtext("personid", ""),
        "description": content.findtext("description", ""),
        "downloads": downloads,
    }


def sanitize_filename(name):
    """清理文件名"""
    # 移除或替换非法字符
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    name = re.sub(r'\s+', '_', name)
    name = name.strip('._')
    return name or "unknown"


def download_file(session, url, output_path):
    """下载文件（带重试机制）"""
    for attempt in range(MAX_RETRIES):
        try:
            print(f"    下载: {url[:80]}...")
            response = session.get(url, timeout=120, stream=True)
            
            # 处理限流
            if response.status_code == 429:
                wait_time = RETRY_DELAY * (attempt + 1)
                print(f"    限流，等待 {wait_time} 秒后重试...")
                time.sleep(wait_time)
                continue
            
            response.raise_for_status()
            
            # 确保目录存在
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            print(f"    已保存: {output_path}")
            return True
        except requests.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                wait_time = RETRY_DELAY * (attempt + 1)
                print(f"    错误: {e}, 等待 {wait_time} 秒后重试...")
                time.sleep(wait_time)
            else:
                print(f"    下载失败（已重试 {MAX_RETRIES} 次）: {e}")
                return False
    return False


def extract_archive(archive_path, extract_dir):
    """解压压缩文件"""
    try:
        if str(archive_path).endswith(('.tar.gz', '.tgz', '.tar.xz', '.tar.bz2')):
            with tarfile.open(archive_path, 'r:*') as tar:
                tar.extractall(path=extract_dir)
            print(f"    已解压 (tar): {extract_dir}")
            return True
        elif str(archive_path).endswith('.zip'):
            with zipfile.ZipFile(archive_path, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
            print(f"    已解压 (zip): {extract_dir}")
            return True
    except Exception as e:
        print(f"    解压失败: {e}")
    return False


def main():
    """主函数"""
    print("=" * 60)
    print("KDE Store Plasma 5 壁纸插件爬虫")
    print("使用 OpenDesktop OCS API")
    print("=" * 60)
    
    # 创建输出目录
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"\n输出目录: {OUTPUT_DIR.absolute()}")
    
    session = get_session()
    
    # 获取所有插件列表
    print("\n正在获取插件列表...")
    items = get_all_content_items(session)
    print(f"获取到 {len(items)} 个插件")
    
    # 统计
    downloaded_count = 0
    failed_count = 0
    skipped_count = 0
    
    # 处理每个插件
    print("\n开始下载插件源代码...")
    for i, item in enumerate(items, 1):
        plugin_name = sanitize_filename(item["name"])
        plugin_dir = OUTPUT_DIR / plugin_name
        
        print(f"\n[{i}/{len(items)}] {item['name']} (ID: {item['id']})")
        
        # 获取详细信息
        time.sleep(DELAY_BETWEEN_REQUESTS)
        details = get_content_details(session, item["id"])
        
        if not details or not details["downloads"]:
            print("  没有可下载的文件")
            failed_count += 1
            continue
        
        # 下载所有文件
        for dl in details["downloads"]:
            url = dl["url"]
            if not url:
                continue
            
            # 确定文件名
            parsed_url = urlparse(url)
            filename = os.path.basename(parsed_url.path)
            if not filename:
                filename = dl["name"]
            
            # 只下载源代码文件
            if not any(ext in filename.lower() for ext in ['.tar.gz', '.tar.xz', '.tgz', '.zip', '.tar.bz2']):
                # 如果文件名没有扩展名，尝试从URL判断
                if 'download' in url.lower():
                    filename = f"{plugin_name}.tar.gz"
                else:
                    print(f"    跳过非源代码文件: {filename}")
                    continue
            
            output_path = plugin_dir / filename
            
            # 检查是否已存在
            if output_path.exists():
                print(f"    已存在，跳过: {output_path}")
                skipped_count += 1
                continue
            
            # 下载
            time.sleep(DELAY_BETWEEN_REQUESTS)
            if download_file(session, url, output_path):
                downloaded_count += 1
                
                # 解压文件
                extract_dir = plugin_dir / "src"
                if not extract_dir.exists():
                    extract_archive(output_path, extract_dir)
            else:
                failed_count += 1
    
    # 打印总结
    print("\n" + "=" * 60)
    print("下载完成!")
    print(f"  成功下载: {downloaded_count} 个文件")
    print(f"  已跳过: {skipped_count} 个文件（已存在）")
    print(f"  失败: {failed_count} 个")
    print(f"  保存位置: {OUTPUT_DIR.absolute()}")
    print("=" * 60)
    
    # 列出已下载的插件
    print("\n已下载的插件:")
    for d in sorted(OUTPUT_DIR.iterdir()):
        if d.is_dir():
            files = list(d.glob("*.*"))
            print(f"  - {d.name}: {len(files)} 个文件")


if __name__ == "__main__":
    main()
