use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWallpaperArgs {
    pub file_path: String,
    pub style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRotationArgs {
    pub interval_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetWallpaperResponse {
    pub success: bool,
}
