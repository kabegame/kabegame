//! 陌壽供逶俶ｨ｡蝮暦ｼ郁ｷｨ蟷ｳ蜿ｰ髣ｨ髱｢・峨・//!
//! - 蜈ｷ菴灘ｹｳ蜿ｰ螳樒鴫謾ｾ蝨ｨ蟄先ｨ｡蝮嶺ｸｭ・啗indows 菴ｿ逕ｨ Dokan・帛・莉門ｹｳ蜿ｰ證よ署萓・no-op/stub・御ｾｿ莠主錘扈ｭ謇ｩ螻輔・
pub mod driver_service;
#[cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]
mod fs;
pub mod ipc;
#[cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]
mod semantics;
#[cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]
mod virtual_drive_io;
#[cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]
mod windows;
// 莉・drive_service 讓｡蝮怜ｯｼ蜃ｺ VirtualDriveService・域ｹ謐ｮ蟷ｳ蜿ｰ閾ｪ蜉ｨ騾画叫螳樒鴫・・
pub use driver_service::VirtualDriveService;
