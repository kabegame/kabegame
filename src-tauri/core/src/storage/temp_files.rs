use crate::storage::Storage;
use rusqlite::params;

impl Storage {
    pub fn add_temp_file(&self, file_path: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "INSERT OR REPLACE INTO temp_files (path, created_at) VALUES (?1, ?2)",
            params![file_path, now],
        )
        .map_err(|e| format!("Failed to add temp file: {}", e))?;
        Ok(())
    }

    pub fn remove_temp_file(&self, file_path: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute("DELETE FROM temp_files WHERE path = ?1", params![file_path])
            .map_err(|e| format!("Failed to remove temp file: {}", e))?;
        Ok(())
    }

    pub fn get_all_temp_files(&self) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT path FROM temp_files")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("Failed to query temp files: {}", e))?;

        let mut files = Vec::new();
        for r in rows {
            files.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(files)
    }

    pub fn cleanup_temp_files(&self) -> Result<usize, String> {
        let files = self.get_all_temp_files()?;
        let mut count = 0;
        for file in files {
            if std::fs::remove_file(&file).is_ok() {
                let _ = self.remove_temp_file(&file);
                count += 1;
            } else if !std::path::Path::new(&file).exists() {
                // 如果文件本身就不存在，也从数据库删除
                let _ = self.remove_temp_file(&file);
            }
        }
        Ok(count)
    }
}
