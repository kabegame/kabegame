//! 虚拟盘（画册盘）功能下线：删掉 `albumDriveEnabled` 与 `albumDriveMountPoint` 两个不再有人读的键。
//!
//! 两个键对应的 `SettingKey` 已随功能一起删除，留在文件里只会被解析时忽略；本迁移把它们清掉，
//! 避免用户的 `settings.json` 长期残留已下线功能的配置。
//!
//! 挂载本身不需要清理：Dokan / FUSE 都在主进程内挂载，旧版本进程退出时挂载点已经消失；
//! 用户自己装的 Dokan / macFUSE 驱动是系统组件，不由本应用卸载。
//!
//! 降级回旧版本时这两个键会回到各自的默认值（关闭 / 默认挂载点），不做保留。

use serde_json::Value;

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };
    map.remove("albumDriveEnabled");
    map.remove("albumDriveMountPoint");
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn drops_both_keys_and_keeps_the_rest() {
        let mut v = json!({
            "albumDriveEnabled": true,
            "albumDriveMountPoint": "K:\\",
            "wallpaperEnabled": true,
        });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "wallpaperEnabled": true }));
    }

    #[test]
    fn missing_keys_change_nothing() {
        let mut v = json!({ "x": 1 });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "x": 1 }));
    }

    #[test]
    fn drops_either_key_alone() {
        let mut v = json!({ "albumDriveEnabled": false, "x": 1 });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "x": 1 }));

        let mut v = json!({ "albumDriveMountPoint": "/home/u/kabegame-vd", "x": 1 });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "x": 1 }));
    }

    #[test]
    fn idempotent() {
        let mut v = json!({ "albumDriveEnabled": true, "x": 1 });
        super::up(&mut v).unwrap();
        let once = v.clone();
        super::up(&mut v).unwrap();
        assert_eq!(v, once);
    }

    #[test]
    fn non_object_is_ignored() {
        let mut v = json!("not an object");
        super::up(&mut v).unwrap();
        assert_eq!(v, json!("not an object"));
    }
}
