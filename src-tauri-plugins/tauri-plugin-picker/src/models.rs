use serde::{Deserialize, Serialize};

/// 选文件夹结果：Android 返回 uri（及可选的 path），桌面返回 path。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderResult {
  pub uri: Option<String>,
  pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListContentChildrenArgs {
  pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentEntry {
  pub uri: String,
  pub name: String,
  pub is_directory: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListContentChildrenResponse {
  pub entries: Vec<ContentEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadContentUriArgs {
  pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadContentUriResponse {
  pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsDirectoryArgs {
  pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsDirectoryResponse {
  pub is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMimeTypeArgs {
  pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMimeTypeResponse {
  pub mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileBytesArgs {
  pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileBytesResponse {
  pub data: String,
  pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakePersistablePermissionArgs {
  pub uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArchiveArgs {
  pub archive_uri: String,
  pub folder_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArchiveResponse {
  pub uris: Vec<String>,
  pub count: u32,
}

/// 选图结果：返回 content:// URI 列表。需 Serialize 供 command 返回前端。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickImagesResponse {
  pub uris: Vec<String>,
}

/// 选 .kgpg 文件结果。需 Serialize 供 command 返回前端。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickKgpgFileResponse {
  pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractBundledPluginsArgs {
  pub target_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractBundledPluginsResponse {
  pub files: Vec<String>,
  pub count: usize,
}
