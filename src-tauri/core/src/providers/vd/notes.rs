//! VD 目录 note 文本（仅 VDRoot / byTask / byPlugin / byTime 携带）。

/// VD 根目录 note（`在这里你可以自由查看图片.txt`）。
pub fn vd_root_note() -> (String, String) {
    let s = "在这里你可以自由查看图片.txt".to_string();
    (s.clone(), s)
}

/// byPlugin 目录 note。
pub fn vd_by_plugin_note() -> (String, String) {
    let s = "这里记录了不同插件安装的所有图片.txt".to_string();
    (s.clone(), s)
}

/// byTask 目录 note。
pub fn vd_by_task_note() -> (String, String) {
    let s = "这里按任务归档图片（目录名含插件名与任务ID）.txt".to_string();
    (s.clone(), s)
}

/// byTime 目录 note。
pub fn vd_by_time_note() -> (String, String) {
    let s = "这里按抓取时间归档图片（年→月→日）.txt".to_string();
    (s.clone(), s)
}
