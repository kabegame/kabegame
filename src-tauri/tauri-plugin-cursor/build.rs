// 生成 `allow-attach-frame` / `allow-detach-frame` 等权限：子 frame（网页壁纸、场景宿主）不在 ACL 特赦里，
// 要靠 capability 放行这两个命令。
const COMMANDS: &[&str] = &["attach_frame", "detach_frame"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
