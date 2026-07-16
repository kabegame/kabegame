use serde_json::Value;

mod v001_wallpaper_drop_system;

type MigrationFn = fn(&mut Value) -> Result<(), String>;

struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "wallpaper_drop_system",
    up: v001_wallpaper_drop_system::up,
}];

pub const LATEST_VERSION: u32 = 1;
pub const VERSION_KEY: &str = "schemaVersion";

fn current_version(json: &Value) -> u32 {
    json.get(VERSION_KEY)
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32
}

pub fn run_pending(json: &mut Value) -> Result<bool, String> {
    let mut current = current_version(json);
    if current >= LATEST_VERSION {
        return Ok(false);
    }

    for migration in MIGRATIONS {
        if migration.version > current {
            println!(
                "[settings-migration] v{:03}: {}",
                migration.version, migration.name
            );
            (migration.up)(json)?;
            current = migration.version;
        }
    }

    mark_as_latest(json);
    Ok(true)
}

pub fn mark_as_latest(json: &mut Value) {
    if let Value::Object(map) = json {
        map.insert(VERSION_KEY.into(), Value::from(LATEST_VERSION));
    }
}
