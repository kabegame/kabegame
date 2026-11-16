//! 空迁移：只为登记回填作业 `video_thumbnail_frame`（见 [`super::backfills::video_thumbnail_frame`]）。
//!
//! 视频缩略图从 2.5 秒短片（桌面）/ GIF 动图（Android）/ 作者的 `preview.*`（WPE 视频）改成首帧 JPEG，
//! 存量行由回填作业在后台重做并删掉旧文件；schema 不变。

use rusqlite::Connection;

pub fn up(_conn: &Connection) -> Result<(), String> {
    Ok(())
}
