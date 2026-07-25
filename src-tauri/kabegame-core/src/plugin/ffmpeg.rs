use serde::Serialize;
use std::path::Path;

use super::vfs::PluginVfs;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegProbeResult {
    pub is_video: bool,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub browser_safe: bool,
}

/// 通过任务虚拟路径对多个媒体流执行 stream-copy 合流。
pub fn mux_streams_sync(vfs: &PluginVfs, inputs: &[String], output: &str) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err("音视频合流至少需要两个输入流".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let _ = (vfs, output);
        return Err("音视频合流暂不支持 Android".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let real_inputs = inputs
            .iter()
            .map(|input| {
                vfs.host_path_for_read(Path::new(input))
                    .map(|path| (path, String::new()))
                    .map_err(|error| format!("无法读取合流输入“{input}”：{error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let real_output = vfs
            .host_path_for_write(Path::new(output))
            .map_err(|error| format!("无法写入合流输出“{output}”：{error}"))?;
        crate::crawler::downloader::compress::mux_media_streams(&real_inputs, &real_output)
    }
}

/// 通过任务虚拟路径探测受支持的视频媒体。
pub fn probe_sync(vfs: &PluginVfs, path: &str) -> Result<Option<FfmpegProbeResult>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (vfs, path);
        return Err("媒体探测暂不支持 Android".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let real_path = vfs
            .host_path_for_read(Path::new(path))
            .map_err(|error| format!("无法读取待探测媒体“{path}”：{error}"))?;
        Ok(
            crate::media::dimensions::probe_media_sync(&real_path).map(|probe| FfmpegProbeResult {
                is_video: probe.is_video,
                mime_type: probe.mime_type,
                width: probe.width,
                height: probe.height,
                browser_safe: probe.browser_safe,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mux_requires_at_least_two_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let vfs = PluginVfs::new_session(42, temp.path());
        let error = mux_streams_sync(&vfs, &["/42/tmp/video.mp4".to_string()], "/42/tmp/out.mp4")
            .unwrap_err();
        assert!(error.contains("至少需要两个输入流"));
    }
}
