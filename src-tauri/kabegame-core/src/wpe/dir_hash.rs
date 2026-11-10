//! WPE 壁纸目录的文件枚举与内容哈希。
//!
//! 一行 `x-wpe/*` 记录对应一个目录，`images.hash` 存的是这里算出的目录哈希：只对内容敏感
//! （文件的相对路径、长度与字节），与文件创建顺序、时间戳、所在位置无关。服务端的文件清单、
//! 跨文件系统的整目录复制和哈希共用 [`list_files`] 这一个枚举函数，三处看到的文件集合一致。
//!
//! 不受 `wpe` feature 门控：回填作业与 `Storage` 侧在所有构建里都要能编译。

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// 域前缀：目录哈希的输入以它开头，不会与散文件的 SHA-256 相撞。
const DIR_HASH_DOMAIN: &[u8] = b"kabegame-wpe-dir-v1\0";

/// 访达、资源管理器会自己往目录里写的文件，不算壁纸内容（文件名不分大小写）。
const IGNORED_FILE_NAMES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// 目录里的一个普通文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirFile {
    /// 相对目录根的路径，统一用 `/` 分隔。
    pub rel: String,
    /// 文件大小（枚举时的元数据值）。
    pub size: u64,
    /// 文件的实际路径；文件名不是合法 Unicode 时 `rel` 是替换后的近似值，读文件要用它。
    pub path: PathBuf,
}

/// 目录哈希与总字节数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirDigest {
    /// 小写 hex 的 SHA-256，与 `images.hash` 现有格式一致。
    pub hash: String,
    /// 全部文件实际读到的字节数之和。
    pub total_bytes: u64,
}

fn is_ignored_name(name: &str) -> bool {
    IGNORED_FILE_NAMES
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(name))
}

/// 枚举 `root` 下的全部普通文件，已按 `rel` 的字节序排序。
///
/// 迭代式遍历，不跟随符号链接（链接本身也不计入）；跳过 [`IGNORED_FILE_NAMES`]。
pub fn list_files(root: &Path) -> io::Result<Vec<DirFile>> {
    let mut files = Vec::new();
    // (目录的实际路径, 目录相对根的前缀：空串或以 `/` 结尾)
    let mut pending: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            // `DirEntry::file_type` 不跟随符号链接
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if file_type.is_dir() {
                pending.push((entry.path(), format!("{prefix}{name}/")));
            } else if file_type.is_file() {
                if is_ignored_name(&name) {
                    continue;
                }
                files.push(DirFile {
                    rel: format!("{prefix}{name}"),
                    size: entry.metadata()?.len(),
                    path: entry.path(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.rel.as_bytes().cmp(b.rel.as_bytes()));
    Ok(files)
}

/// 流式读一个文件，返回实际长度与内容的 SHA-256。
fn digest_file(path: &Path) -> io::Result<(u64, [u8; 32])> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length += read as u64;
    }
    Ok((length, hasher.finalize().into()))
}

/// 目录哈希：域前缀之后，按 `rel` 顺序逐个文件喂入
/// 「路径长度 u32 LE + 路径 + 文件长度 u64 LE + 该文件的 SHA-256」。
///
/// 阻塞读盘，目录可能有几个 GB，异步上下文里放进 `spawn_blocking`。
pub fn digest_dir(root: &Path) -> io::Result<DirDigest> {
    let mut hasher = Sha256::new();
    hasher.update(DIR_HASH_DOMAIN);
    let mut total_bytes = 0u64;
    for file in list_files(root)? {
        hasher.update((file.rel.len() as u32).to_le_bytes());
        hasher.update(file.rel.as_bytes());
        let (length, content) = digest_file(&file.path)?;
        hasher.update(length.to_le_bytes());
        hasher.update(content);
        total_bytes += length;
    }
    Ok(DirDigest {
        hash: format!("{:x}", hasher.finalize()),
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kabegame-dir-hash-test-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn creation_order_does_not_change_hash() {
        let first = temp_dir("order-a");
        write(&first, "project.json", b"{}");
        write(&first, "materials/a.tex", b"aaaa");
        write(&first, "scene.pkg", b"pkg");

        let second = temp_dir("order-b");
        write(&second, "scene.pkg", b"pkg");
        write(&second, "materials/a.tex", b"aaaa");
        write(&second, "project.json", b"{}");

        let a = digest_dir(&first).unwrap();
        let b = digest_dir(&second).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.total_bytes, 2 + 4 + 3);
        assert_eq!(a.hash.len(), 64);
        assert_eq!(a.hash, a.hash.to_ascii_lowercase());

        let _ = fs::remove_dir_all(first);
        let _ = fs::remove_dir_all(second);
    }

    #[test]
    fn content_name_and_location_changes_change_hash() {
        let base = temp_dir("base");
        write(&base, "project.json", b"{}");
        write(&base, "video.mp4", b"0123456789");
        let base_hash = digest_dir(&base).unwrap().hash;

        // 改一个字节（长度不变）
        let byte = temp_dir("byte");
        write(&byte, "project.json", b"{}");
        write(&byte, "video.mp4", b"0123456780");
        assert_ne!(digest_dir(&byte).unwrap().hash, base_hash);

        // 改文件名
        let renamed = temp_dir("renamed");
        write(&renamed, "project.json", b"{}");
        write(&renamed, "movie.mp4", b"0123456789");
        assert_ne!(digest_dir(&renamed).unwrap().hash, base_hash);

        // 挪进子目录
        let moved = temp_dir("moved");
        write(&moved, "project.json", b"{}");
        write(&moved, "sub/video.mp4", b"0123456789");
        assert_ne!(digest_dir(&moved).unwrap().hash, base_hash);

        for dir in [base, byte, renamed, moved] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// 路径与内容的边界不能被挪动后仍得到同一个哈希。
    #[test]
    fn path_and_content_boundaries_are_unambiguous() {
        let first = temp_dir("boundary-a");
        write(&first, "ab", b"c");
        let second = temp_dir("boundary-b");
        write(&second, "a", b"bc");
        assert_ne!(
            digest_dir(&first).unwrap().hash,
            digest_dir(&second).unwrap().hash
        );
        let _ = fs::remove_dir_all(first);
        let _ = fs::remove_dir_all(second);
    }

    #[test]
    fn os_metadata_files_are_ignored() {
        let dir = temp_dir("junk");
        write(&dir, "project.json", b"{}");
        write(&dir, "sub/entry.html", b"<html></html>");
        let before = digest_dir(&dir).unwrap();

        write(&dir, ".DS_Store", b"finder");
        write(&dir, "sub/Thumbs.db", b"explorer");
        write(&dir, "sub/Desktop.ini", b"explorer");
        let after = digest_dir(&dir).unwrap();

        assert_eq!(before, after);
        let listed: Vec<String> = list_files(&dir)
            .unwrap()
            .into_iter()
            .map(|file| file.rel)
            .collect();
        assert_eq!(listed, vec!["project.json", "sub/entry.html"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped() {
        let dir = temp_dir("symlink");
        write(&dir, "project.json", b"{}");
        let before = digest_dir(&dir).unwrap();

        let outside = temp_dir("symlink-target");
        write(&outside, "secret.txt", b"secret");
        std::os::unix::fs::symlink(outside.join("secret.txt"), dir.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("linked-dir")).unwrap();

        assert_eq!(digest_dir(&dir).unwrap(), before);
        assert_eq!(list_files(&dir).unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn differs_from_single_file_hash_of_same_content() {
        let dir = temp_dir("single");
        write(&dir, "only.bin", b"same-content");
        let file_hash = crate::crawler::downloader::compute_file_hash(&dir.join("only.bin"))
            .await
            .unwrap();
        assert_ne!(digest_dir(&dir).unwrap().hash, file_hash);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn listing_is_sorted_by_relative_path_bytes() {
        let dir = temp_dir("sorted");
        write(&dir, "b.txt", b"1");
        write(&dir, "a/z.txt", b"22");
        write(&dir, "a.txt", b"333");
        let listed: Vec<(String, u64)> = list_files(&dir)
            .unwrap()
            .into_iter()
            .map(|file| (file.rel, file.size))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("a.txt".to_string(), 3),
                ("a/z.txt".to_string(), 2),
                ("b.txt".to_string(), 1),
            ]
        );
        let _ = fs::remove_dir_all(dir);
    }
}
