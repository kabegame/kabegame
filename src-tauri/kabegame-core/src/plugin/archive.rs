use std::fs::{self, File, OpenOptions as StdOpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};

use super::vfs::PluginVfs;

const DEFAULT_MAX_ENTRIES: usize = 10_000;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractOptions {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub password: Option<String>,
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub flatten: bool,
    pub overwrite: bool,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            include: Vec::new(),
            exclude: Vec::new(),
            password: None,
            max_entries: DEFAULT_MAX_ENTRIES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            flatten: false,
            overwrite: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub entries: Vec<ExtractedEntry>,
    pub skipped: usize,
    pub total_bytes: u64,
}

struct ExtractContext<'a> {
    vfs: &'a PluginVfs,
    dest_dir: String,
    opts: &'a ExtractOptions,
    include: GlobSet,
    exclude: GlobSet,
    result: ExtractResult,
}

impl<'a> ExtractContext<'a> {
    fn new(vfs: &'a PluginVfs, dest_dir: &str, opts: &'a ExtractOptions) -> Result<Self, String> {
        let host_dest = vfs
            .host_path_for_write(Path::new(dest_dir))
            .map_err(|error| format!("无法写入解压目录“{dest_dir}”：{error}"))?;
        fs::create_dir_all(&host_dest)
            .map_err(|error| format!("无法创建解压目录“{dest_dir}”：{error}"))?;

        Ok(Self {
            vfs,
            dest_dir: dest_dir.trim_end_matches(['/', '\\']).to_string(),
            opts,
            include: build_glob_set(&opts.include, "include")?,
            exclude: build_glob_set(&opts.exclude, "exclude")?,
            result: ExtractResult {
                entries: Vec::new(),
                skipped: 0,
                total_bytes: 0,
            },
        })
    }

    fn normalized_entry_name(&self, name: &str) -> Result<String, String> {
        let normalized = name.replace('\\', "/");
        if normalized.starts_with('/') {
            return Err(format!("归档条目路径“{name}”是绝对路径，已拒绝解压"));
        }

        let mut segments = Vec::new();
        for segment in normalized.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    return Err(format!("归档条目路径“{name}”包含上级目录跳转，已拒绝解压"));
                }
                _ if segment.contains('\0') => {
                    return Err(format!("归档条目路径“{name}”包含 NUL 字节，已拒绝解压"));
                }
                _ => segments.push(segment),
            }
        }

        if segments.is_empty() {
            return Err(format!("归档条目路径“{name}”为空，已拒绝解压"));
        }
        Ok(segments.join("/"))
    }

    fn selected(&mut self, name: &str) -> bool {
        let included = self.opts.include.is_empty() || self.include.is_match(name);
        if included && !self.exclude.is_match(name) {
            true
        } else {
            self.result.skipped += 1;
            false
        }
    }

    fn output_path(&self, entry_name: &str) -> Result<String, String> {
        let relative = if self.opts.flatten {
            entry_name
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| format!("归档条目路径“{entry_name}”没有文件名"))?
        } else {
            entry_name
        };
        Ok(format!("{}/{relative}", self.dest_dir))
    }

    fn extract_file(
        &mut self,
        entry_name: &str,
        declared_size: u64,
        reader: &mut dyn Read,
    ) -> Result<(), String> {
        if self.result.entries.len() >= self.opts.max_entries {
            return Err(format!(
                "解压条目数超过上限 {}，已中止解压",
                self.opts.max_entries
            ));
        }
        let next_total = self
            .result
            .total_bytes
            .checked_add(declared_size)
            .ok_or_else(|| "解压后总大小溢出，已中止解压".to_string())?;
        if next_total > self.opts.max_total_bytes {
            return Err(format!(
                "解压后总大小超过上限 {} 字节，已中止解压",
                self.opts.max_total_bytes
            ));
        }

        let virtual_path = self.output_path(entry_name)?;
        let host_path = self
            .vfs
            .host_path_for_write(Path::new(&virtual_path))
            .map_err(|error| format!("无法写入解压条目“{entry_name}”：{error}"))?;
        if let Some(parent) = host_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建解压条目“{entry_name}”的父目录：{error}"))?;
        }

        let mut open_options = StdOpenOptions::new();
        open_options.write(true);
        if self.opts.overwrite {
            open_options.create(true).truncate(true);
        } else {
            open_options.create_new(true);
        }
        let mut output = open_options.open(&host_path).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                format!("解压目标“{virtual_path}”已存在，且 overwrite 为 false")
            } else {
                format!("无法创建解压目标“{virtual_path}”：{error}")
            }
        })?;

        let write_result = copy_with_guards(
            reader,
            &mut output,
            declared_size,
            self.result.total_bytes,
            self.opts.max_total_bytes,
            entry_name,
        );
        drop(output);
        let actual_size = match write_result {
            Ok(size) => size,
            Err(error) => {
                let _ = fs::remove_file(&host_path);
                return Err(error);
            }
        };

        self.result.total_bytes = next_total;
        self.result.entries.push(ExtractedEntry {
            path: virtual_path,
            size: actual_size,
        });
        Ok(())
    }

    fn finish(self) -> ExtractResult {
        self.result
    }
}

fn build_glob_set(patterns: &[String], label: &str) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = Glob::new(pattern)
            .map_err(|error| format!("无效的 {label} glob 模式“{pattern}”：{error}"))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|error| format!("无法构建 {label} glob 过滤器：{error}"))
}

fn copy_with_guards(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    declared_size: u64,
    current_total: u64,
    max_total_bytes: u64,
    entry_name: &str,
) -> Result<u64, String> {
    let mut buffer = [0u8; 64 * 1024];
    let mut actual_size = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取归档条目“{entry_name}”失败：{error}"))?;
        if read == 0 {
            break;
        }
        actual_size = actual_size
            .checked_add(read as u64)
            .ok_or_else(|| format!("归档条目“{entry_name}”实际大小溢出"))?;
        if actual_size > declared_size
            || current_total.saturating_add(actual_size) > max_total_bytes
        {
            return Err(format!(
                "归档条目“{entry_name}”实际写入大小超过声明或总量上限，已中止解压"
            ));
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入归档条目“{entry_name}”失败：{error}"))?;
    }
    if actual_size != declared_size {
        return Err(format!(
            "归档条目“{entry_name}”声明大小为 {declared_size} 字节，实际写入 {actual_size} 字节，已中止解压"
        ));
    }
    Ok(actual_size)
}

fn drain_entry(reader: &mut dyn Read, declared_size: u64, entry_name: &str) -> Result<(), String> {
    let actual_size = io::copy(reader, &mut io::sink())
        .map_err(|error| format!("跳过归档条目“{entry_name}”时读取失败：{error}"))?;
    if actual_size != declared_size {
        return Err(format!(
            "归档条目“{entry_name}”声明大小为 {declared_size} 字节，实际读取 {actual_size} 字节，已中止解压"
        ));
    }
    Ok(())
}

fn sevenz_error(message: String) -> sevenz_rust2::Error {
    sevenz_rust2::Error::Other(message.into())
}

pub fn extract_zip_sync(
    vfs: &PluginVfs,
    src: &str,
    dest_dir: &str,
    opts: &ExtractOptions,
) -> Result<ExtractResult, String> {
    let host_src = vfs
        .host_path_for_read(Path::new(src))
        .map_err(|error| format!("无法读取 ZIP 归档“{src}”：{error}"))?;
    let source =
        File::open(&host_src).map_err(|error| format!("无法打开 ZIP 归档“{src}”：{error}"))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("无法解析 ZIP 归档“{src}”：{error}"))?;
    let mut context = ExtractContext::new(vfs, dest_dir, opts)?;

    for index in 0..archive.len() {
        let mut entry = match opts.password.as_deref() {
            Some(password) => archive.by_index_decrypt(index, password.as_bytes()),
            None => archive.by_index(index),
        }
        .map_err(|error| {
            format!(
                "无法读取 ZIP 归档“{src}”中的第 {} 个条目：{error}",
                index + 1
            )
        })?;

        if entry.is_dir() {
            continue;
        }
        let entry_name = context.normalized_entry_name(entry.name())?;
        if !context.selected(&entry_name) {
            continue;
        }
        if entry.is_symlink() {
            return Err(format!("ZIP 归档条目“{entry_name}”是符号链接，已拒绝解压"));
        }
        context.extract_file(&entry_name, entry.size(), &mut entry)?;
    }

    Ok(context.finish())
}

pub fn extract_tar_sync(
    vfs: &PluginVfs,
    src: &str,
    dest_dir: &str,
    opts: &ExtractOptions,
) -> Result<ExtractResult, String> {
    let host_src = vfs
        .host_path_for_read(Path::new(src))
        .map_err(|error| format!("无法读取 TAR 归档“{src}”：{error}"))?;
    let mut source =
        File::open(&host_src).map_err(|error| format!("无法打开 TAR 归档“{src}”：{error}"))?;
    let mut magic = [0u8; 3];
    let magic_len = source
        .read(&mut magic)
        .map_err(|error| format!("无法识别 TAR 归档“{src}”的压缩格式：{error}"))?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("无法重置 TAR 归档“{src}”的读取位置：{error}"))?;

    let reader: Box<dyn Read> = if magic_len >= 2 && magic[..2] == [0x1f, 0x8b] {
        Box::new(GzDecoder::new(source))
    } else if magic_len >= 3 && magic == *b"BZh" {
        Box::new(BzDecoder::new(source))
    } else {
        Box::new(source)
    };
    let mut archive = tar::Archive::new(reader);
    let mut context = ExtractContext::new(vfs, dest_dir, opts)?;
    let entries = archive
        .entries()
        .map_err(|error| format!("无法读取 TAR 归档“{src}”的目录：{error}"))?;

    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("无法读取 TAR 归档“{src}”中的条目：{error}"))?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("无法读取 TAR 归档条目路径：{error}"))?;
        let name = path
            .to_str()
            .ok_or_else(|| "TAR 归档包含非 UTF-8 条目路径，已拒绝解压".to_string())?;
        let entry_name = context.normalized_entry_name(name)?;
        if !context.selected(&entry_name) {
            continue;
        }
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(format!("TAR 归档条目“{entry_name}”是链接，已拒绝解压"));
        }
        if !entry_type.is_file() {
            return Err(format!(
                "TAR 归档条目“{entry_name}”不是普通文件，已拒绝解压"
            ));
        }
        let declared_size = entry.size();
        context.extract_file(&entry_name, declared_size, &mut entry)?;
    }

    Ok(context.finish())
}

pub fn extract_7z_sync(
    vfs: &PluginVfs,
    src: &str,
    dest_dir: &str,
    opts: &ExtractOptions,
) -> Result<ExtractResult, String> {
    let host_src = vfs
        .host_path_for_read(Path::new(src))
        .map_err(|error| format!("无法读取 7z 归档“{src}”：{error}"))?;
    let password = opts
        .password
        .as_deref()
        .map(sevenz_rust2::Password::from)
        .unwrap_or_else(sevenz_rust2::Password::empty);
    let mut archive = sevenz_rust2::ArchiveReader::open(&host_src, password)
        .map_err(|error| format!("无法打开 7z 归档“{src}”：{error}"))?;
    let mut context = ExtractContext::new(vfs, dest_dir, opts)?;

    archive
        .for_each_entries(|entry, reader| {
            if entry.is_directory {
                return Ok(true);
            }
            let entry_name = context
                .normalized_entry_name(&entry.name)
                .map_err(sevenz_error)?;
            if !context.selected(&entry_name) {
                drain_entry(reader, entry.size, &entry_name).map_err(sevenz_error)?;
                return Ok(true);
            }
            if entry.is_anti_item {
                return Err(sevenz_error(format!(
                    "7z 归档条目“{entry_name}”是 anti-item，已拒绝解压"
                )));
            }
            context
                .extract_file(&entry_name, entry.size, reader)
                .map_err(sevenz_error)?;
            Ok(true)
        })
        .map_err(|error| format!("解压 7z 归档“{src}”失败：{error}"))?;

    Ok(context.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_vfs() -> (tempfile::TempDir, PluginVfs) {
        let temp = tempfile::tempdir().unwrap();
        let vfs = PluginVfs::new_session(42, temp.path());
        (temp, vfs)
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_extracts_selected_entries_to_virtual_paths() {
        let (_temp, vfs) = test_vfs();
        let src = "/42/tmp/archive.zip";
        let host_src = vfs.host_path_for_write(Path::new(src)).unwrap();
        fs::write(
            host_src,
            zip_bytes(&[("images/a.jpg", b"a"), ("notes/readme.txt", b"no")]),
        )
        .unwrap();
        let opts = ExtractOptions {
            include: vec!["**/*.jpg".to_string()],
            ..Default::default()
        };

        let result = extract_zip_sync(&vfs, src, "/42/tmp/out", &opts).unwrap();

        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].path, "/42/tmp/out/images/a.jpg");
        assert_eq!(result.total_bytes, 1);
        assert_eq!(result.skipped, 1);
    }

    #[test]
    fn rejects_entry_count_total_size_and_actual_size_overruns() {
        let (_temp, vfs) = test_vfs();
        let src = "/42/tmp/archive.zip";
        let host_src = vfs.host_path_for_write(Path::new(src)).unwrap();
        fs::write(host_src, zip_bytes(&[("a.txt", b"a")])).unwrap();

        let entries_error = extract_zip_sync(
            &vfs,
            src,
            "/42/tmp/entries",
            &ExtractOptions {
                max_entries: 0,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(entries_error.contains("条目数超过上限"));

        let bytes_error = extract_zip_sync(
            &vfs,
            src,
            "/42/tmp/bytes",
            &ExtractOptions {
                max_total_bytes: 0,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(bytes_error.contains("总大小超过上限"));

        let mut input = io::Cursor::new(b"x".as_slice());
        let mut output = Vec::new();
        let actual_error =
            copy_with_guards(&mut input, &mut output, 2, 0, 10, "short.txt").unwrap_err();
        assert!(actual_error.contains("实际写入"));
    }

    #[test]
    fn rejects_parent_directory_traversal() {
        let (_temp, vfs) = test_vfs();
        let src = "/42/tmp/archive.zip";
        let host_src = vfs.host_path_for_write(Path::new(src)).unwrap();
        fs::write(host_src, zip_bytes(&[("../escape.txt", b"x")])).unwrap();

        let error =
            extract_zip_sync(&vfs, src, "/42/tmp/out", &ExtractOptions::default()).unwrap_err();
        assert!(error.contains("上级目录跳转"));
    }
}
