//! 原始文件（图库 `local_path` 指向的图片/视频）的安全删除。
//!
//! 策略（不可配置）：
//! - 删除一律走系统**回收站**（`trash` crate），不做永久 `remove_file`，删错也可恢复。
//! - 仅对「正常本机路径」的文件执行删除：**拒绝软链接路径**与**网络/虚拟文件系统**
//!   （NFS/SMB/FUSE/网络盘等）。这类文件只从数据库移除记录、**保留磁盘文件**。
//!   这是为了避免历史事故：`~/Pictures` 软链到外置盘后，删除穿过软链误删共享物理文件。
//! - 移入回收站失败、或路径不安全时返回 `false`；调用方据此知道"文件仍在盘上"，
//!   但**无论真假都照常删除数据库记录**（仅文件去留不同）。
//!
//! 仅桌面端编译；Android/iOS 的库文件是 `content://`，删除走各自的内容提供方，不在此处。

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use std::path::Path;

/// 自身或任一祖先目录是否为软链接。命中即视为"非正常本机路径"。
fn has_symlink_in_path(path: &Path) -> bool {
    let mut cur = Some(path);
    while let Some(p) = cur {
        if let Ok(m) = std::fs::symlink_metadata(p) {
            if m.file_type().is_symlink() {
                return true;
            }
        }
        cur = p.parent();
    }
    false
}

/// 文件所在文件系统是否为「正常本机盘」（保守 allowlist：未知一律视为不安全）。
#[cfg(target_os = "macos")]
fn is_local_filesystem(path: &Path) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut buf) } != 0 {
        return false;
    }
    let name = unsafe { CStr::from_ptr(buf.f_fstypename.as_ptr()) }
        .to_string_lossy()
        .to_ascii_lowercase();
    // 本机物理/可移动盘文件系统；smbfs/nfs/afpfs/webdav/ftp/osxfuse 等一律排除。
    matches!(
        name.as_str(),
        "apfs" | "hfs" | "hfsplus" | "exfat" | "msdos" | "ntfs" | "ufs"
    )
}

#[cfg(target_os = "linux")]
fn is_local_filesystem(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut buf) } != 0 {
        return false;
    }
    // f_type 魔数 allowlist：ext*/btrfs/xfs/f2fs/vfat/exfat/ntfs。
    // 排除 nfs(0x6969)/cifs(0xFF534D42)/fuse(0x65735546)/overlay 等。
    let t = buf.f_type as i64;
    const ALLOW: &[i64] = &[
        0xEF53,     // ext2/3/4
        0x9123683E, // btrfs
        0x58465342, // xfs
        0xF2F52010, // f2fs
        0x4D44,     // msdos/vfat
        0x2011BAB0, // exfat
        0x5346544E, // ntfs
    ];
    ALLOW.contains(&t)
}

#[cfg(windows)]
fn is_local_filesystem(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    // 从路径取卷根（如 "C:\"）。无盘符前缀（UNC \\server\share 等）一律视为非本机。
    let mut root = PathBuf::new();
    let mut have_prefix = false;
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => {
                root.push(p.as_os_str());
                have_prefix = true;
            }
            Component::RootDir => {
                root.push("\\");
                break;
            }
            _ => break,
        }
    }
    if !have_prefix {
        return false;
    }
    if !root.as_os_str().to_string_lossy().ends_with('\\') {
        root.push("\\");
    }
    let wide: Vec<u16> = root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let t = unsafe { GetDriveTypeW(wide.as_ptr()) };
    t == DRIVE_FIXED || t == DRIVE_REMOVABLE
}

/// 判定路径是否为「可安全自动删除的正常本机文件」。
fn path_is_normal_local(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if !meta.is_file() {
        return Err("不是普通文件（可能是符号链接或目录）".to_string());
    }
    if has_symlink_in_path(path) {
        return Err("路径经过符号链接，跳过删除以免误删共享文件".to_string());
    }
    if !is_local_filesystem(path) {
        return Err("文件位于网络/虚拟/未知文件系统，跳过删除".to_string());
    }
    Ok(())
}

/// 把原始文件移入系统回收站（带安全护栏）。
///
/// 返回 `true` 表示文件已移入回收站；`false` 表示路径不安全或回收站操作失败、
/// **文件仍保留在磁盘上**。无论返回值如何，调用方都应照常删除数据库记录。
/// 本函数**永不**永久删除（不调用 `remove_file`）。
pub fn trash_source_file(path: &Path) -> bool {
    if let Err(reason) = path_is_normal_local(path) {
        eprintln!(
            "[safe_delete] 保留磁盘文件（仅移出图库）: {} — {}",
            path.display(),
            reason
        );
        return false;
    }
    match trash::delete(path) {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "[safe_delete] 移入回收站失败，保留磁盘文件: {} — {}",
                path.display(),
                e
            );
            false
        }
    }
}

/// 把多个原始文件一次性移入系统回收站（`trash::delete_all`）。
///
/// 过滤掉不安全路径后，对剩余路径调用一次 `delete_all`，减少回收站交互次数。
/// 无论成功与否，调用方都应照常删除数据库记录。
pub fn trash_source_files_batch(paths: &[&Path]) {
    let safe: Vec<&Path> = paths
        .iter()
        .copied()
        .filter(|p| {
            if let Err(reason) = path_is_normal_local(p) {
                eprintln!(
                    "[safe_delete] 保留磁盘文件（仅移出图库）: {} — {}",
                    p.display(),
                    reason
                );
                false
            } else {
                true
            }
        })
        .collect();
    if safe.is_empty() {
        return;
    }
    if let Err(e) = trash::delete_all(&safe) {
        eprintln!("[safe_delete] 批量移入回收站失败，保留磁盘文件: {}", e);
    }
}
