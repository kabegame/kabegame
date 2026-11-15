//! CDN 下载：manifest 与 chunk。照 SteamKit2 `CDN.Client` / DepotDownloader `ContentDownloader`：
//! 服务器按顺序轮换；某台返回 403 且还没为它申请过 CDN 授权 token 时，按它的 `host` 申请一次再重试；
//! 跟随跳转、照常走系统代理。

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use steam_vent::Connection;
use steam_vent_proto_common::protobuf::Message;
use steam_vent_proto_steam::content_manifest::{ContentManifestMetadata, ContentManifestPayload};
use tokio::sync::Mutex;

use super::cm::{cdn_auth_token, CdnServer, CmError};
use super::crypto::{decompress_chunk, decrypt_filename, sha1, symmetric_decrypt};
use crate::wpe::is_safe_relative_path;

const MAGIC_PAYLOAD: u32 = 0x71F6_17D0;
const MAGIC_METADATA: u32 = 0x1F48_12BE;
const MAGIC_SIGNATURE: u32 = 0x1B81_B817;
const MAGIC_END: u32 = 0x32C4_15AB;
/// manifest 文件标志：目录。
const FLAG_DIRECTORY: u32 = 0x40;
/// 每个请求最多换几台服务器 / 重试几次。
const MAX_ATTEMPTS: usize = 6;

/// manifest 里的一个 chunk。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkRef {
    /// 解压后数据的 SHA-1，也是 CDN 上的 chunk id。
    pub id: [u8; 20],
    pub offset: u64,
    pub original_len: u32,
    pub compressed_len: u32,
}

/// manifest 里的一个文件或目录。`path` 已解密、统一成 `/` 分隔，并通过了相对路径校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    /// 整个文件的 SHA-1。
    pub sha: [u8; 20],
    pub chunks: Vec<ChunkRef>,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub depot_id: u32,
    pub manifest_id: u64,
    pub files: Vec<ManifestFile>,
    pub compressed_total: u64,
}

fn read_u32(bytes: &[u8], pos: &mut usize) -> Result<u32, String> {
    let slice = bytes.get(*pos..*pos + 4).ok_or("manifest 截断")?;
    *pos += 4;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn sha_array(bytes: &[u8]) -> [u8; 20] {
    let mut out = [0u8; 20];
    let n = bytes.len().min(20);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

/// 解析 manifest：外层是单条目 zip，里面按 magic 分段（payload / metadata / signature / end）。
/// 文件名加密时用 depot 密钥解开；不安全的相对路径（`..`、绝对路径、盘符）直接拒绝整份 manifest。
pub fn parse_manifest(
    zipped: &[u8],
    depot_id: u32,
    manifest_id: u64,
    depot_key: &[u8],
) -> Result<Manifest, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zipped)).map_err(|e| format!("manifest 不是 zip：{e}"))?;
    let mut raw = Vec::new();
    archive
        .by_index(0)
        .map_err(|e| format!("manifest zip 为空：{e}"))?
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取 manifest 失败：{e}"))?;

    let mut payload = None;
    let mut metadata = None;
    let mut pos = 0usize;
    loop {
        let magic = read_u32(&raw, &mut pos)?;
        if magic == MAGIC_END {
            break;
        }
        let len = read_u32(&raw, &mut pos)? as usize;
        let section = raw.get(pos..pos + len).ok_or("manifest 段截断")?;
        pos += len;
        match magic {
            MAGIC_PAYLOAD => {
                payload = Some(ContentManifestPayload::parse_from_bytes(section).map_err(|e| e.to_string())?)
            }
            MAGIC_METADATA => {
                metadata = Some(ContentManifestMetadata::parse_from_bytes(section).map_err(|e| e.to_string())?)
            }
            MAGIC_SIGNATURE => {}
            other => return Err(format!("未知的 manifest 段：{other:#x}")),
        }
    }
    let payload = payload.ok_or("manifest 缺 payload")?;
    let metadata = metadata.ok_or("manifest 缺 metadata")?;

    let mut files = Vec::with_capacity(payload.mappings.len());
    let mut compressed_total = 0u64;
    for mapping in &payload.mappings {
        let name = if metadata.filenames_encrypted() {
            decrypt_filename(depot_key, mapping.filename())?
        } else {
            mapping.filename().to_string()
        };
        let path = name.replace('\\', "/").trim_matches('/').to_string();
        if !is_safe_relative_path(&path) {
            return Err(format!("manifest 里有不安全的路径：{name}"));
        }
        let mut chunks: Vec<ChunkRef> = mapping
            .chunks
            .iter()
            .map(|chunk| ChunkRef {
                id: sha_array(chunk.sha()),
                offset: chunk.offset(),
                original_len: chunk.cb_original(),
                compressed_len: chunk.cb_compressed(),
            })
            .collect();
        chunks.sort_by_key(|chunk| chunk.offset);
        compressed_total += chunks.iter().map(|chunk| chunk.compressed_len as u64).sum::<u64>();
        files.push(ManifestFile {
            path,
            size: mapping.size(),
            is_dir: mapping.flags() & FLAG_DIRECTORY != 0,
            sha: sha_array(mapping.sha_content()),
            chunks,
        });
    }
    Ok(Manifest {
        depot_id,
        manifest_id,
        files,
        compressed_total,
    })
}

/// 下载用的服务器池，带每台服务器每个 depot 的 CDN 授权 token。
pub struct CdnPool {
    app_id: u32,
    connection: Connection,
    servers: Vec<CdnServer>,
    next: AtomicUsize,
    tokens: Mutex<HashMap<(u32, String), String>>,
    http: reqwest::Client,
}

enum Fetch {
    Ok(Vec<u8>),
    Forbidden,
    Failed(String),
}

impl CdnPool {
    pub fn new(app_id: u32, connection: Connection, servers: Vec<CdnServer>) -> Self {
        Self {
            app_id,
            connection,
            servers,
            next: AtomicUsize::new(0),
            tokens: Mutex::new(HashMap::new()),
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(90))
                .build()
                .unwrap_or_default(),
        }
    }

    async fn fetch(&self, url: &str) -> Fetch {
        match self.http.get(url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) => Fetch::Ok(bytes.to_vec()),
                Err(e) => Fetch::Failed(format!("读取 {url} 失败：{e}")),
            },
            Ok(res) if res.status() == reqwest::StatusCode::FORBIDDEN => Fetch::Forbidden,
            Ok(res) => Fetch::Failed(format!("{url} 返回 HTTP {}", res.status())),
            Err(e) => Fetch::Failed(format!("请求 {url} 失败：{e}")),
        }
    }

    /// GET `<服务器>/<path>`，带上已有的授权 token；403 时申请 token 重试，其它失败换下一台。
    async fn get(&self, depot_id: u32, path: &str) -> Result<Vec<u8>, String> {
        let mut last_error = String::new();
        for _ in 0..MAX_ATTEMPTS {
            let index = self.next.load(Ordering::Relaxed) % self.servers.len();
            let server = &self.servers[index];
            let key = (depot_id, server.host.clone());
            let token = self.tokens.lock().await.get(&key).cloned();
            let url = match &token {
                Some(token) if !token.is_empty() => format!("{}{path}?{token}", server.base_url),
                _ => format!("{}{path}", server.base_url),
            };
            match self.fetch(&url).await {
                Fetch::Ok(bytes) => return Ok(bytes),
                Fetch::Forbidden if token.is_none() => {
                    match cdn_auth_token(&self.connection, self.app_id, depot_id, &server.host).await {
                        Ok(token) => {
                            self.tokens.lock().await.insert(key, token);
                            continue;
                        }
                        Err(CmError::SessionInvalid(message) | CmError::Other(message)) => {
                            last_error = message;
                        }
                    }
                }
                Fetch::Forbidden => last_error = format!("{} 拒绝访问（403）", server.base_url),
                Fetch::Failed(message) => last_error = message,
            }
            // 这台不行，换下一台
            let _ = self
                .next
                .compare_exchange(index, index + 1, Ordering::Relaxed, Ordering::Relaxed);
        }
        Err(last_error)
    }

    pub async fn manifest(
        &self,
        depot_id: u32,
        manifest_id: u64,
        request_code: u64,
        depot_key: &[u8],
    ) -> Result<Manifest, String> {
        let zipped = self
            .get(depot_id, &format!("/depot/{depot_id}/manifest/{manifest_id}/5/{request_code}"))
            .await
            .map_err(|e| format!("下载 depot {depot_id} 的 manifest 失败：{e}"))?;
        let key = depot_key.to_vec();
        tokio::task::spawn_blocking(move || parse_manifest(&zipped, depot_id, manifest_id, &key))
            .await
            .map_err(|e| e.to_string())?
    }

    /// 下载一个 chunk 并解密、解压、按 chunk id 校验，返回原始数据。网络与校验失败都重试。
    pub async fn chunk(&self, depot_id: u32, chunk: &ChunkRef, depot_key: &[u8]) -> Result<Vec<u8>, String> {
        let path = format!("/depot/{depot_id}/chunk/{}", hex::encode(chunk.id));
        let mut last_error = String::new();
        for _ in 0..3 {
            let encrypted = match self.get(depot_id, &path).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            };
            let key = depot_key.to_vec();
            let expected = chunk.original_len as usize;
            let id = chunk.id;
            let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                let plain = decompress_chunk(&symmetric_decrypt(&key, &encrypted)?, expected)?;
                if sha1(&plain) != id {
                    return Err("chunk 校验不一致".to_string());
                }
                Ok(plain)
            })
            .await
            .map_err(|e| e.to_string())?;
            match result {
                Ok(plain) => return Ok(plain),
                Err(e) => last_error = e,
            }
        }
        Err(format!("下载 chunk {} 失败：{last_error}", hex::encode(chunk.id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use steam_vent_proto_steam::content_manifest::content_manifest_payload::{
        file_mapping::ChunkData, FileMapping,
    };

    fn manifest_zip(names: &[&str]) -> Vec<u8> {
        let payload = ContentManifestPayload {
            mappings: names
                .iter()
                .map(|name| FileMapping {
                    filename: Some(name.to_string()),
                    size: Some(3),
                    flags: Some(0),
                    sha_content: Some(vec![1; 20]),
                    chunks: vec![ChunkData {
                        sha: Some(vec![2; 20]),
                        offset: Some(0),
                        cb_original: Some(3),
                        cb_compressed: Some(9),
                        ..Default::default()
                    }],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let metadata = ContentManifestMetadata {
            filenames_encrypted: Some(false),
            ..Default::default()
        };
        let mut raw = Vec::new();
        for (magic, bytes) in [
            (MAGIC_PAYLOAD, payload.write_to_bytes().unwrap()),
            (MAGIC_METADATA, metadata.write_to_bytes().unwrap()),
            (MAGIC_SIGNATURE, Vec::new()),
        ] {
            raw.extend_from_slice(&magic.to_le_bytes());
            raw.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            raw.extend_from_slice(&bytes);
        }
        raw.extend_from_slice(&MAGIC_END.to_le_bytes());
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            zip.start_file("z", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(&raw).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn parses_sections_and_normalizes_paths() {
        let manifest = parse_manifest(&manifest_zip(&["assets\\shaders\\common.h"]), 1, 2, &[0; 32]).unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].path, "assets/shaders/common.h");
        assert_eq!(manifest.files[0].chunks[0].compressed_len, 9);
        assert_eq!(manifest.compressed_total, 9);
    }

    #[test]
    fn rejects_traversal_paths() {
        assert!(parse_manifest(&manifest_zip(&["..\\evil.dll"]), 1, 2, &[0; 32]).is_err());
        assert!(parse_manifest(&manifest_zip(&["C:\\evil.dll"]), 1, 2, &[0; 32]).is_err());
    }
}
