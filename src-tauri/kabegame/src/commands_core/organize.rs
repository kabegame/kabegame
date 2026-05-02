use kabegame_core::storage::organize::{OrganizeOptions, OrganizeService};
use kabegame_core::storage::Storage;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

fn default_safe_delete_organize() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOrganizeArgs {
    pub dedupe: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    #[serde(default)]
    pub delete_source_files: bool,
    #[serde(default = "default_safe_delete_organize")]
    pub safe_delete: bool,
    pub range_start: Option<usize>,
    pub range_end: Option<usize>,
}

pub async fn start_organize(args: StartOrganizeArgs) -> Result<Value, String> {
    let (offset, limit) = match (args.range_start, args.range_end) {
        (Some(s), Some(e)) if e > s => (Some(s), Some(e - s)),
        _ => (None, None),
    };
    OrganizeService::global()
        .clone()
        .start(
            Arc::new(Storage::global().clone()),
            OrganizeOptions {
                dedupe: args.dedupe,
                remove_missing: args.remove_missing,
                remove_unrecognized: args.remove_unrecognized,
                regen_thumbnails: args.regen_thumbnails,
                delete_source_files: args.delete_source_files,
                safe_delete: args.safe_delete,
                offset,
                limit,
            },
        )
        .await?;
    Ok(Value::Null)
}
