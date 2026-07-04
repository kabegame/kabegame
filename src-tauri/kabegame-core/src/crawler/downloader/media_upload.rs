use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub const SESSION_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct MediaUploadSession {
    task_id: String,
    streams: Vec<StreamFile>,
    written: u64,
    total: Option<u64>,
    source_url: String,
}

struct StreamFile {
    file: File,
    path: PathBuf,
    mime: String,
    written: u64,
}

pub struct FinishedMediaUpload {
    pub task_id: String,
    pub streams: Vec<(PathBuf, String)>,
    pub written: u64,
    pub total: Option<u64>,
    pub source_url: String,
}

static SESSIONS: OnceLock<Mutex<HashMap<u64, MediaUploadSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<u64, MediaUploadSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn begin(
    id: u64,
    task_id: String,
    streams: Vec<(PathBuf, String)>,
    source_url: String,
    total: Option<u64>,
) -> Result<(), String> {
    if streams.is_empty() {
        return Err("Media upload requires at least one stream".to_string());
    }
    if matches!(total, Some(total) if total > SESSION_MAX_BYTES) {
        return Err(format!("Media upload exceeds {} bytes", SESSION_MAX_BYTES));
    }
    let mut stream_files = Vec::with_capacity(streams.len());
    for (path, mime) in streams {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create media upload directory: {e}"))?;
        }
        let file =
            File::create(&path).map_err(|e| format!("Failed to create media upload file: {e}"))?;
        stream_files.push(StreamFile {
            file,
            path,
            mime,
            written: 0,
        });
    }
    let mut guard = sessions()
        .lock()
        .map_err(|e| format!("media upload sessions lock failed: {e}"))?;
    if guard.contains_key(&id) {
        return Err(format!("Media upload session already exists: {id}"));
    }
    guard.insert(
        id,
        MediaUploadSession {
            task_id,
            streams: stream_files,
            written: 0,
            total,
            source_url,
        },
    );
    Ok(())
}

pub fn append(id: u64, stream_idx: usize, bytes: &[u8]) -> Result<(u64, Option<u64>), String> {
    let mut guard = sessions()
        .lock()
        .map_err(|e| format!("media upload sessions lock failed: {e}"))?;
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| format!("Media upload session not found: {id}"))?;
    let next = session
        .written
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Media upload byte count overflow".to_string())?;
    if next > SESSION_MAX_BYTES {
        return Err(format!("Media upload exceeds {} bytes", SESSION_MAX_BYTES));
    }
    let stream = session
        .streams
        .get_mut(stream_idx)
        .ok_or_else(|| format!("Media upload stream not found: {stream_idx}"))?;
    stream
        .file
        .write_all(bytes)
        .map_err(|e| format!("Failed to write media upload chunk: {e}"))?;
    stream.written = stream
        .written
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Media upload stream byte count overflow".to_string())?;
    session.written = next;
    Ok((session.written, session.total))
}

pub fn finish(id: u64) -> Result<FinishedMediaUpload, String> {
    let mut session = sessions()
        .lock()
        .map_err(|e| format!("media upload sessions lock failed: {e}"))?
        .remove(&id)
        .ok_or_else(|| format!("Media upload session not found: {id}"))?;
    for stream in &mut session.streams {
        stream
            .file
            .flush()
            .map_err(|e| format!("Failed to flush media upload file: {e}"))?;
        stream
            .file
            .sync_all()
            .map_err(|e| format!("Failed to sync media upload file: {e}"))?;
    }
    let streams = session
        .streams
        .into_iter()
        .map(|stream| {
            drop(stream.file);
            (stream.path, stream.mime)
        })
        .collect();
    Ok(FinishedMediaUpload {
        task_id: session.task_id,
        streams,
        written: session.written,
        total: session.total,
        source_url: session.source_url,
    })
}

pub fn abort(id: u64) {
    let paths = sessions().lock().ok().and_then(|mut guard| {
        guard.remove(&id).map(|session| {
            session
                .streams
                .into_iter()
                .map(|stream| stream.path)
                .collect::<Vec<_>>()
        })
    });
    if let Some(paths) = paths {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn abort_task_sessions(task_id: &str) -> Vec<u64> {
    let mut removed: Vec<(u64, Vec<PathBuf>)> = Vec::new();
    if let Ok(mut guard) = sessions().lock() {
        let ids: Vec<u64> = guard
            .iter()
            .filter_map(|(id, session)| (session.task_id == task_id).then_some(*id))
            .collect();
        for id in ids {
            if let Some(session) = guard.remove(&id) {
                removed.push((
                    id,
                    session
                        .streams
                        .into_iter()
                        .map(|stream| stream.path)
                        .collect(),
                ));
            }
        }
    }
    for (_, paths) in &removed {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
    removed.into_iter().map(|(id, _)| id).collect()
}
