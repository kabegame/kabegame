//! Windows 虚拟盘（Dokan）：将 Kabegame 的画册映射为目录，将图片映射为文件（只读，允许画册目录重命名）。
//!
//! 需求约束（当前实现）：
//! - 根目录：列出所有画册（目录名=画册 name）
//! - 画册目录：列出图片文件（文件名=图片 id + 原始扩展名；不允许重命名）
//! - 文件内容：优先 local_path；若不存在则使用 thumbnail_path；两者都不存在则不显示
//! - 写入/删除/创建文件：全部拒绝
//! - 重命名：仅允许根目录下画册目录重命名（映射到 storage.rename_album）

#![cfg(all(target_os = "windows", feature = "virtual-drive"))]

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Mutex, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dokan::{
    CreateFileInfo, DiskSpaceInfo, FileInfo, FileSystemHandler, FileSystemMounter, MountFlags,
    MountOptions, OperationInfo, OperationResult, VolumeInfo,
};
use widestring::{U16CStr, U16CString};
use winapi::{
    shared::ntstatus::{
        STATUS_ACCESS_DENIED, STATUS_INVALID_PARAMETER, STATUS_NOT_A_DIRECTORY,
        STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    },
    shared::winerror,
    um::winnt::{FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY},
};
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::storage::Storage;

static DOKAN_INIT: Once = Once::new();

fn dokan_init_once() {
    DOKAN_INIT.call_once(|| dokan::init());
}

fn now() -> SystemTime {
    SystemTime::now()
}

fn system_time_from_fs_metadata(meta: &std::fs::Metadata) -> (SystemTime, SystemTime, SystemTime) {
    let created = meta.created().unwrap_or(UNIX_EPOCH);
    let accessed = meta.accessed().unwrap_or(created);
    let modified = meta.modified().unwrap_or(accessed);
    (created, accessed, modified)
}

fn parse_components(file_name: &U16CStr) -> Vec<String> {
    let s = file_name.to_string_lossy();
    s.split('\\')
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .collect()
}

fn is_numeric_id(stem: &str) -> bool {
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit())
}

fn split_stem_ext(file_name: &str) -> (&str, &str) {
    match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (file_name, ""),
    }
}

fn file_index_from_numeric_id(id: &str) -> u64 {
    id.parse::<u64>().unwrap_or(0)
}

fn file_index_from_uuidish(id: &str) -> u64 {
    // 取 uuid 前 16 个 hex（忽略 '-'），作为一个稳定 index。
    let mut hex = String::with_capacity(16);
    for ch in id.chars() {
        if ch == '-' {
            continue;
        }
        if ch.is_ascii_hexdigit() {
            hex.push(ch);
        }
        if hex.len() >= 16 {
            break;
        }
    }
    u64::from_str_radix(&hex, 16).unwrap_or(0)
}

fn normalize_mount_point(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("mount_point 不能为空".to_string());
    }
    // 支持 "K", "K:", "K:\\" 以及完整路径挂载点
    if s.len() == 1 && s.chars().next().unwrap().is_ascii_alphabetic() {
        return Ok(format!("{}:\\", s.to_uppercase()));
    }
    if s.len() == 2
        && s.chars().next().unwrap().is_ascii_alphabetic()
        && s.chars().nth(1) == Some(':')
    {
        return Ok(format!("{}\\", s.to_uppercase()));
    }
    Ok(s.to_string())
}

fn drive_letter_from_mount_point(mount_point: &str) -> Option<char> {
    // 期望已 normalize：例如 "K:\"
    let s = mount_point.trim();
    if s.len() < 2 {
        return None;
    }
    let bytes = s.as_bytes();
    let c0 = bytes[0] as char;
    if !c0.is_ascii_alphabetic() {
        return None;
    }
    if bytes[1] as char != ':' {
        return None;
    }
    Some(c0.to_ascii_uppercase())
}

fn refresh_explorer_icons() {
    // 让 Explorer 刷新关联/图标缓存（不保证立即刷新，但一般足够）
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

fn drive_icons_root() -> Result<RegKey, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons",
        winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
    )
    .or_else(|_| {
        hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons")
            .map(|(k, _)| k)
    })
    .map_err(|e| format!("打开注册表 DriveIcons 失败: {}", e))
}

fn set_drive_icon(letter: char, icon_spec: &str) -> Result<(), String> {
    let root = drive_icons_root()?;
    let drive_key = root
        .create_subkey(letter.to_string())
        .map_err(|e| format!("创建注册表 DriveIcons\\{} 失败: {}", letter, e))?
        .0;
    let default_icon = drive_key
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("创建注册表 DefaultIcon 失败: {}", e))?
        .0;

    // DefaultIcon 的“默认值”：例如 "C:\path\kabegame.exe,0"
    default_icon
        .set_value("", &icon_spec)
        .map_err(|e| format!("写入盘符图标失败: {}", e))?;
    Ok(())
}

fn clear_drive_icon(letter: char) -> Result<(), String> {
    let root = drive_icons_root()?;
    // 删除整棵 DriveIcons\<letter>，避免污染其它驱动器复用该盘符
    root.delete_subkey_all(letter.to_string())
        .map_err(|e| format!("删除盘符图标注册表失败: {}", e))?;
    Ok(())
}

fn apply_default_drive_icon_if_possible(mount_point: &str) {
    let Some(letter) = drive_letter_from_mount_point(mount_point) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let spec = format!("{},0", exe.to_string_lossy());
    let _ = set_drive_icon(letter, &spec);
    refresh_explorer_icons();
}

#[derive(Debug, Clone)]
enum FsContext {
    RootDir,
    AlbumDir {
        album_id: String,
    },
    ImageFile {
        resolved_path: PathBuf,
        size: u64,
        id: String,
    },
}

pub struct VirtualDriveService {
    mounted: Mutex<Option<String>>, // normalized mount point
}

impl Default for VirtualDriveService {
    fn default() -> Self {
        Self {
            mounted: Mutex::new(None),
        }
    }
}

impl VirtualDriveService {
    pub fn is_mounted(&self) -> bool {
        self.mounted.lock().ok().and_then(|g| g.clone()).is_some()
    }

    pub fn current_mount_point(&self) -> Option<String> {
        self.mounted.lock().ok().and_then(|g| g.clone())
    }

    pub fn mount(&self, mount_point: &str, storage: Storage) -> Result<(), String> {
        let mount_point = normalize_mount_point(mount_point)?;
        {
            let mut g = self
                .mounted
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            if g.is_some() {
                return Err("虚拟盘已挂载".to_string());
            }
            *g = Some(mount_point.clone());
        }

        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let mount_point_for_thread = mount_point.clone();
        std::thread::spawn(move || {
            dokan_init_once();

            let handler = KabegameAlbumsFs::new(storage);
            let mount_point_u16 = match U16CString::from_str(&mount_point_for_thread) {
                Ok(v) => v,
                Err(_) => {
                    let _ = tx.send(Err("mount_point 编码失败".to_string()));
                    return;
                }
            };

            let options = MountOptions {
                single_thread: false,
                // 不启用 WRITE_PROTECT：因为我们需要允许“画册目录重命名”（move_file）。
                // 其它写操作在 handler 内统一拒绝。
                flags: MountFlags::empty(),
                unc_name: None,
                timeout: Duration::from_secs(30),
                allocation_unit_size: 4096,
                sector_size: 512,
                volume_security_descriptor: None,
            };

            let mut mounter =
                FileSystemMounter::new(&handler, mount_point_u16.as_ucstr(), &options);
            let mount_res = mounter.mount();
            match mount_res {
                Ok(fs) => {
                    let _ = tx.send(Ok(()));
                    drop(fs); // 阻塞直到 unmount
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("挂载失败: {}", e)));
                }
            };
        });

        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => {
                // 挂载成功后：为盘符设置自定义图标（仅对盘符挂载生效）
                apply_default_drive_icon_if_possible(&mount_point);
                Ok(())
            }
            Ok(Err(e)) => {
                let mut g = self
                    .mounted
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
                *g = None;
                Err(e)
            }
            Err(_) => {
                // 不急着清空 mounted：此时可能是驱动/首次挂载较慢导致未能及时确认，
                // 但系统层面可能已经出现盘符。用户仍可用 unmount() 尝试卸载。
                apply_default_drive_icon_if_possible(&mount_point);
                Err("挂载确认超时：系统可能已出现盘符；若无法访问请先关闭开关卸载再重试（也可能是 Dokan 驱动不兼容）".to_string())
            }
        }
    }

    pub fn unmount(&self) -> Result<bool, String> {
        let mount_point = self
            .mounted
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .clone();
        let Some(mount_point) = mount_point else {
            return Ok(false);
        };
        let mp =
            U16CString::from_str(&mount_point).map_err(|_| "mount_point 编码失败".to_string())?;
        let ok = dokan::unmount(mp.as_ucstr());
        if ok {
            let mut g = self
                .mounted
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *g = None;
            if let Some(letter) = drive_letter_from_mount_point(&mount_point) {
                let _ = clear_drive_icon(letter);
                refresh_explorer_icons();
            }
        }
        Ok(ok)
    }
}

impl Drop for VirtualDriveService {
    fn drop(&mut self) {
        // 进程退出时尽力卸载，避免残留挂载点。
        let mount_point = self.mounted.lock().ok().and_then(|g| g.clone());
        let Some(mount_point) = mount_point else {
            return;
        };
        if let Ok(mp) = U16CString::from_str(&mount_point) {
            let _ = dokan::unmount(mp.as_ucstr());
        }
        if let Some(letter) = drive_letter_from_mount_point(&mount_point) {
            let _ = clear_drive_icon(letter);
            refresh_explorer_icons();
        }
    }
}

struct KabegameAlbumsFs {
    storage: Storage,
}

impl KabegameAlbumsFs {
    fn new(storage: Storage) -> Self {
        Self { storage }
    }

    fn resolve_album_id_by_name(
        &self,
        name: &str,
    ) -> Result<Option<String>, winapi::shared::ntdef::NTSTATUS> {
        self.storage
            .find_album_id_by_name_ci(name)
            .map_err(|_| STATUS_OBJECT_PATH_NOT_FOUND)
    }

    fn resolve_image_path(
        &self,
        album_id: &str,
        image_id: &str,
    ) -> Result<Option<(PathBuf, u64)>, winapi::shared::ntdef::NTSTATUS> {
        let resolved = self
            .storage
            .resolve_album_image_local_or_thumbnail_path(album_id, image_id)
            .map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
        if let Some(path) = resolved {
            let pb = PathBuf::from(&path);
            let meta = std::fs::metadata(&pb).map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
            return Ok(Some((pb, meta.len())));
        }
        Ok(None)
    }

    fn list_album_dirs(
        &self,
        mut fill: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
    ) -> Result<(), winapi::shared::ntdef::NTSTATUS> {
        let albums = self
            .storage
            .get_albums()
            .map_err(|_| STATUS_OBJECT_PATH_NOT_FOUND)?;
        for a in albums {
            let data = dokan::FindData {
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                creation_time: now(),
                last_access_time: now(),
                last_write_time: now(),
                file_size: 0,
                file_name: U16CString::from_str(&a.name).map_err(|_| STATUS_INVALID_PARAMETER)?,
            };
            let _ = fill(&data);
        }
        Ok(())
    }

    fn list_album_files(
        &self,
        album_id: &str,
        mut fill: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
    ) -> Result<(), winapi::shared::ntdef::NTSTATUS> {
        let entries = self
            .storage
            .get_album_images_fs_entries(album_id)
            .map_err(|_| STATUS_OBJECT_PATH_NOT_FOUND)?;
        for e in entries {
            // 只显示可映射到真实文件的条目
            let meta = match std::fs::metadata(PathBuf::from(&e.resolved_path)) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let (created, accessed, modified) = system_time_from_fs_metadata(&meta);
            let data = dokan::FindData {
                attributes: FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                creation_time: created,
                last_access_time: accessed,
                last_write_time: modified,
                file_size: meta.len(),
                file_name: U16CString::from_str(&e.file_name)
                    .map_err(|_| STATUS_INVALID_PARAMETER)?,
            };
            let _ = fill(&data);
        }
        Ok(())
    }
}

impl<'c, 'h: 'c> FileSystemHandler<'c, 'h> for KabegameAlbumsFs {
    type Context = FsContext;

    fn create_file(
        &'h self,
        file_name: &U16CStr,
        _security_context: &dokan::IO_SECURITY_CONTEXT,
        desired_access: winapi::um::winnt::ACCESS_MASK,
        file_attributes: u32,
        _share_access: u32,
        create_disposition: u32,
        create_options: u32,
        _info: &mut OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<CreateFileInfo<Self::Context>> {
        // Dokan 传进来的 create_disposition/create_options 是内核语义，不等同 Win32 的 OPEN_EXISTING=3。
        // 使用 Dokan 的 helper 映射到 Win32 CreateFile flags，再判断是否“试图创建/覆盖”。
        let user_flags = dokan::map_kernel_to_user_create_file_flags(
            desired_access,
            file_attributes,
            create_options,
            create_disposition,
        );
        // 3 = OPEN_EXISTING（winbase::OPEN_EXISTING）
        if user_flags.creation_disposition != 3 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        let comps = parse_components(file_name);
        if comps.is_empty() {
            return Ok(CreateFileInfo {
                context: FsContext::RootDir,
                is_dir: true,
                new_file_created: false,
            });
        }

        // 如果请求对文件写入，拒绝（目录 rename 可能会带 DELETE 等权限，这里不严格卡）。
        const GENERIC_WRITE: u32 = winapi::um::winnt::GENERIC_WRITE;
        if comps.len() == 2 && (desired_access & GENERIC_WRITE) != 0 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        if comps.len() == 1 {
            let Some(album_id) = self.resolve_album_id_by_name(&comps[0])? else {
                return Err(STATUS_OBJECT_PATH_NOT_FOUND);
            };
            return Ok(CreateFileInfo {
                context: FsContext::AlbumDir { album_id },
                is_dir: true,
                new_file_created: false,
            });
        }

        if comps.len() == 2 {
            let album_name = &comps[0];
            let file_name = &comps[1];
            let Some(album_id) = self.resolve_album_id_by_name(album_name)? else {
                return Err(STATUS_OBJECT_PATH_NOT_FOUND);
            };
            let (stem, _ext) = split_stem_ext(file_name);
            if !is_numeric_id(stem) {
                return Err(STATUS_OBJECT_NAME_NOT_FOUND);
            }
            let Some((resolved_path, size)) = self.resolve_image_path(&album_id, stem)? else {
                return Err(STATUS_OBJECT_NAME_NOT_FOUND);
            };
            return Ok(CreateFileInfo {
                context: FsContext::ImageFile {
                    resolved_path,
                    size,
                    id: stem.to_string(),
                },
                is_dir: false,
                new_file_created: false,
            });
        }

        Err(STATUS_OBJECT_NAME_NOT_FOUND)
    }

    fn get_file_information(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<FileInfo> {
        match context {
            FsContext::RootDir => Ok(FileInfo {
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                creation_time: now(),
                last_access_time: now(),
                last_write_time: now(),
                file_size: 0,
                number_of_links: 1,
                file_index: 1,
            }),
            FsContext::AlbumDir { album_id } => Ok(FileInfo {
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                creation_time: now(),
                last_access_time: now(),
                last_write_time: now(),
                file_size: 0,
                number_of_links: 1,
                file_index: file_index_from_uuidish(album_id),
            }),
            FsContext::ImageFile {
                resolved_path,
                size,
                id,
            } => {
                let meta =
                    std::fs::metadata(resolved_path).map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
                let (created, accessed, modified) = system_time_from_fs_metadata(&meta);
                Ok(FileInfo {
                    attributes: FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                    creation_time: created,
                    last_access_time: accessed,
                    last_write_time: modified,
                    file_size: *size,
                    number_of_links: 1,
                    file_index: file_index_from_numeric_id(id),
                })
            }
        }
    }

    fn find_files(
        &'h self,
        file_name: &U16CStr,
        fill_find_data: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        let _ = file_name; // context 已包含类型信息
        match context {
            FsContext::RootDir => self.list_album_dirs(fill_find_data).map_err(|e| e),
            FsContext::AlbumDir { album_id } => self
                .list_album_files(album_id, fill_find_data)
                .map_err(|e| e),
            FsContext::ImageFile { .. } => Err(STATUS_NOT_A_DIRECTORY),
        }
    }

    fn read_file(
        &'h self,
        _file_name: &U16CStr,
        offset: i64,
        buffer: &mut [u8],
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<u32> {
        let FsContext::ImageFile { resolved_path, .. } = context else {
            return Err(STATUS_INVALID_PARAMETER);
        };
        if offset < 0 {
            return Err(STATUS_INVALID_PARAMETER);
        }
        let mut f = File::open(resolved_path).map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
        f.seek(SeekFrom::Start(offset as u64))
            .map_err(|_| STATUS_INVALID_PARAMETER)?;
        let n = f.read(buffer).map_err(|_| STATUS_INVALID_PARAMETER)?;
        Ok(n as u32)
    }

    fn write_file(
        &'h self,
        _file_name: &U16CStr,
        _offset: i64,
        _buffer: &[u8],
        _info: &OperationInfo<'c, 'h, Self>,
        _context: &'c Self::Context,
    ) -> OperationResult<u32> {
        Err(STATUS_ACCESS_DENIED)
    }

    fn delete_file(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        _context: &'c Self::Context,
    ) -> OperationResult<()> {
        Err(STATUS_ACCESS_DENIED)
    }

    fn delete_directory(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        _context: &'c Self::Context,
    ) -> OperationResult<()> {
        Err(STATUS_ACCESS_DENIED)
    }

    fn move_file(
        &'h self,
        file_name: &U16CStr,
        new_file_name: &U16CStr,
        _replace_if_existing: bool,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        // 仅允许根目录下目录重命名：\Old -> \New
        let FsContext::AlbumDir { album_id } = context else {
            // 文件重命名一律禁止
            return Err(STATUS_ACCESS_DENIED);
        };

        let old = parse_components(file_name);
        let newp = parse_components(new_file_name);
        if old.len() != 1 || newp.len() != 1 {
            return Err(STATUS_ACCESS_DENIED);
        }
        let new_name = newp[0].trim();
        if new_name.is_empty() {
            return Err(STATUS_INVALID_PARAMETER);
        }

        self.storage
            .rename_album(album_id, new_name)
            .map_err(|_| STATUS_ACCESS_DENIED)?;
        Ok(())
    }

    fn get_disk_free_space(
        &'h self,
        _info: &OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<DiskSpaceInfo> {
        Ok(DiskSpaceInfo {
            byte_count: 1024 * 1024 * 1024 * 1024,     // 1TB
            free_byte_count: 512 * 1024 * 1024 * 1024, // 512GB
            available_byte_count: 512 * 1024 * 1024 * 1024,
        })
    }

    fn get_volume_information(
        &'h self,
        _info: &OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<VolumeInfo> {
        Ok(VolumeInfo {
            name: U16CString::from_str("Kabegame").map_err(|_| STATUS_INVALID_PARAMETER)?,
            serial_number: 0x4B41_4245u32, // 'KABE'
            max_component_length: 255,
            fs_flags: 0,
            // 伪装成 NTFS：Windows/Explorer 会按此决定功能开关。
            fs_name: U16CString::from_str("NTFS").map_err(|_| STATUS_INVALID_PARAMETER)?,
        })
    }
}
