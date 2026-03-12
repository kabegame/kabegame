use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressVideoForPreviewArgs {
    pub input_path: String,
    pub output_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressVideoForPreviewResponse {
    pub output_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
