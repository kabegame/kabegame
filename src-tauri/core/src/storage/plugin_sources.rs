use crate::plugin::PluginSource;
use rusqlite::{params, Connection, Result as SqliteResult};
use std::sync::{Arc, Mutex};

/// 内置的 GitHub Releases 插件商店源 ID（不可删除；index_url 不可修改）
pub const OFFICIAL_PLUGIN_SOURCE_ID: &str = "official_github_release";

/// 默认官方 index.json（与首次迁移一致，可由编译期 env 覆盖仓库 owner/name）
pub fn default_official_index_url() -> String {
    let owner = option_env!("CRAWLER_PLUGINS_REPO_OWNER").unwrap_or("kabegame");
    let repo = option_env!("CRAWLER_PLUGINS_REPO_NAME").unwrap_or("crawler-plugins");
    format!(
        "https://github.com/{}/{}/releases/latest/download/index.json",
        owner, repo
    )
}

fn constraint_err(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(19), // SQLITE_CONSTRAINT
        Some(msg.into()),
    )
}

/// 插件源相关的数据库操作
pub struct PluginSourcesStorage {
    conn: Arc<Mutex<Connection>>,
}

impl PluginSourcesStorage {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// 若不存在则插入官方 GitHub Releases 源（应用每次启动时调用，修复用户曾删除官方源等情况）
    pub fn ensure_official_github_release(&self) -> SqliteResult<()> {
        let conn = self.conn.lock().expect("plugin_sources db lock");
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plugin_sources WHERE id = ?",
            params![OFFICIAL_PLUGIN_SOURCE_ID],
            |row| row.get(0),
        )?;
        if count > 0 {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO plugin_sources (id, name, index_url) VALUES (?, ?, ?)",
            params![
                OFFICIAL_PLUGIN_SOURCE_ID,
                "官方 GitHub Releases 源",
                default_official_index_url(),
            ],
        )?;
        Ok(())
    }

    /// 获取所有插件源
    pub fn get_all_sources(&self) -> SqliteResult<Vec<PluginSource>> {
        let conn = self.conn.lock().expect("plugin_sources db lock");
        let mut stmt = conn.prepare(
            "SELECT id, name, index_url FROM plugin_sources ORDER BY created_at ASC",
        )?;

        let sources = stmt.query_map([], |row| {
            Ok(PluginSource {
                id: row.get(0)?,
                name: row.get(1)?,
                index_url: row.get(2)?,
            })
        })?;

        sources.collect()
    }

    /// 添加插件源
    /// id 为 None 时自动生成 UUID
    pub fn add_source(
        &self,
        id: Option<String>,
        name: String,
        index_url: String,
    ) -> SqliteResult<PluginSource> {
        use uuid::Uuid;

        let conn = self.conn.lock().expect("plugin_sources db lock");
        let source_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());

        if source_id == OFFICIAL_PLUGIN_SOURCE_ID {
            return Err(constraint_err("不能使用保留的官方源 ID"));
        }

        // 检查 ID 是否已存在
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plugin_sources WHERE id = ?",
            params![&source_id],
            |row| row.get(0),
        )?;

        if exists > 0 {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(2067), // SQLITE_CONSTRAINT_UNIQUE
                Some(format!("Plugin source with id '{}' already exists", source_id)),
            ));
        }

        // 插入新记录
        conn.execute(
            "INSERT INTO plugin_sources (id, name, index_url) VALUES (?, ?, ?)",
            params![source_id, name, index_url],
        )?;

        Ok(PluginSource {
            id: source_id,
            name,
            index_url,
        })
    }

    /// 更新插件源
    pub fn update_source(&self, id: String, name: String, index_url: String) -> SqliteResult<()> {
        let conn = self.conn.lock().expect("plugin_sources db lock");

        if id == OFFICIAL_PLUGIN_SOURCE_ID {
            let current_url: String = conn.query_row(
                "SELECT index_url FROM plugin_sources WHERE id = ?",
                params![&id],
                |row| row.get(0),
            )?;
            if index_url != current_url {
                return Err(constraint_err("官方 GitHub Releases 源的 index.json 地址不可修改"));
            }
            let rows_affected = conn.execute(
                "UPDATE plugin_sources SET name = ? WHERE id = ?",
                params![name, id],
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            return Ok(());
        }

        let rows_affected = conn.execute(
            "UPDATE plugin_sources SET name = ?, index_url = ? WHERE id = ?",
            params![name, index_url, id],
        )?;

        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        Ok(())
    }

    /// 删除插件源（缓存会通过 FOREIGN KEY CASCADE 自动删除）
    pub fn delete_source(&self, id: String) -> SqliteResult<()> {
        if id == OFFICIAL_PLUGIN_SOURCE_ID {
            return Err(constraint_err("官方 GitHub Releases 源不可删除"));
        }

        let conn = self.conn.lock().expect("plugin_sources db lock");
        let rows_affected = conn.execute(
            "DELETE FROM plugin_sources WHERE id = ?",
            params![id],
        )?;

        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        Ok(())
    }

    /// 获取插件源缓存
    pub fn get_source_cache(&self, source_id: &str) -> SqliteResult<Option<String>> {
        let conn = self.conn.lock().expect("plugin_sources db lock");
        let mut stmt = conn
            .prepare("SELECT json_content FROM plugin_source_cache WHERE source_id = ?")?;

        let mut rows = stmt.query_map(params![source_id], |row| row.get(0))?;
        match rows.next() {
            Some(result) => result.map(Some),
            None => Ok(None),
        }
    }

    /// 保存插件源缓存（INSERT OR REPLACE）
    pub fn save_source_cache(&self, source_id: String, json_content: String) -> SqliteResult<()> {
        let conn = self.conn.lock().expect("plugin_sources db lock");
        conn.execute(
            "INSERT OR REPLACE INTO plugin_source_cache (source_id, json_content, updated_at) VALUES (?, ?, strftime('%s','now'))",
            params![source_id, json_content],
        )?;

        Ok(())
    }
}
