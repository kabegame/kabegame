use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct LocalFolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    sync_path: PathBuf,
    created_at: i64,
}

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("v029 begin local folder rechain: {e}")
    })?;

    let result = (|| -> Result<(usize, usize, usize, usize), String> {
        let lifted = lift_normal_albums_from_local_folders(conn)?;
        let rechained = rechain_local_folder_albums(conn)?;
        let stripped = strip_legacy_name_prefixes(conn)?;
        let rebuilt = rebuild_ancestor_paths(conn)?;

        conn.execute_batch("COMMIT;")
            .map_err(|e| format!("v029 commit: {e}"))?;
        Ok((lifted, rechained, stripped, rebuilt))
    })();

    match result {
        Ok((lifted, rechained, stripped, rebuilt)) => {
            println!(
                "[v029] lifted {lifted} normal albums, rechained {rechained} local folder albums, stripped {stripped} names, rebuilt {rebuilt} ancestor paths"
            );
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

/// 普通画册不能挂在本地文件夹画册下；只提起直接违规节点，其普通子树随之保留。
fn lift_normal_albums_from_local_folders(conn: &Connection) -> Result<usize, String> {
    let rows = {
        let mut stmt = conn
            .prepare(
                "SELECT child.id, child.name
                   FROM albums child
                   JOIN albums parent ON parent.id = child.parent_id
                  WHERE child.type = 'normal' AND parent.type = 'local_folder'
                  ORDER BY child.created_at ASC, child.id ASC",
            )
            .map_err(|e| format!("v029 prepare normal album lift: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("v029 query normal album lift: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v029 read normal album lift: {e}"))?
    };

    let mut changed = 0;
    for (id, name) in rows {
        let resolved = resolve_name_ci(conn, None, &name, Some(&id))?;
        changed += conn
            .execute(
                "UPDATE albums SET name = ?1, parent_id = NULL WHERE id = ?2",
                params![resolved, id],
            )
            .map_err(|e| format!("v029 lift normal album: {e}"))?;
    }
    Ok(changed)
}

/// 按同步目录的最近真祖先重建所有本地文件夹画册的父子关系。
fn rechain_local_folder_albums(conn: &Connection) -> Result<usize, String> {
    let mut rows = read_local_folder_rows(conn)?;
    rows.sort_by(|a, b| {
        path_depth(&a.sync_path)
            .cmp(&path_depth(&b.sync_path))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let desired_parents: Vec<(String, Option<String>)> = rows
        .iter()
        .map(|album| {
            let parent = rows
                .iter()
                .filter(|candidate| {
                    candidate.id != album.id
                        && is_true_ancestor(&candidate.sync_path, &album.sync_path)
                })
                .max_by(|a, b| {
                    path_depth(&a.sync_path)
                        .cmp(&path_depth(&b.sync_path))
                        .then_with(|| b.created_at.cmp(&a.created_at))
                        .then_with(|| b.id.cmp(&a.id))
                })
                .map(|candidate| candidate.id.clone());
            (album.id.clone(), parent)
        })
        .collect();

    let mut changed = 0;
    for (id, desired_parent) in desired_parents {
        let album = rows
            .iter()
            .find(|album| album.id == id)
            .expect("desired parent must refer to a loaded album");
        if album.parent_id == desired_parent {
            continue;
        }
        let resolved = resolve_name_ci(
            conn,
            desired_parent.as_deref(),
            &album.name,
            Some(&album.id),
        )?;
        changed += conn
            .execute(
                "UPDATE albums SET name = ?1, parent_id = ?2 WHERE id = ?3",
                params![resolved, desired_parent.as_deref(), album.id],
            )
            .map_err(|e| format!("v029 rechain local folder album {}: {e}", album.id))?;
    }
    Ok(changed)
}

/// 旧同步逻辑把父画册名拼进子画册名；仅在无撞名时剥成目录本名。
fn strip_legacy_name_prefixes(conn: &Connection) -> Result<usize, String> {
    let rows = {
        let mut stmt = conn
            .prepare(
                "SELECT child.id, child.name, child.parent_id, child.sync_folder
                   FROM albums child
                   JOIN albums parent ON parent.id = child.parent_id
                  WHERE child.type = 'local_folder' AND parent.type = 'local_folder'
                  ORDER BY child.created_at ASC, child.id ASC",
            )
            .map_err(|e| format!("v029 prepare legacy name stripping: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("v029 query legacy name stripping: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("v029 read legacy name stripping: {e}"))?
    };

    let mut changed = 0;
    for (id, current_name, parent_id, sync_folder) in rows {
        let Some(directory_name) = Path::new(&sync_folder)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let legacy_suffix = format!("-{directory_name}").to_lowercase();
        if current_name == directory_name
            || !current_name.to_lowercase().ends_with(&legacy_suffix)
            || !name_available_ci(conn, Some(&parent_id), directory_name, Some(&id))?
        {
            continue;
        }
        changed += conn
            .execute(
                "UPDATE albums SET name = ?1 WHERE id = ?2",
                params![directory_name, id],
            )
            .map_err(|e| format!("v029 strip legacy album name: {e}"))?;
    }
    Ok(changed)
}

fn rebuild_ancestor_paths(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        r#"
WITH RECURSIVE tree(id, path) AS (
    SELECT id, '/' || id || '/' FROM albums WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, tree.path || a.id || '/'
      FROM albums a JOIN tree ON a.parent_id = tree.id
)
UPDATE albums SET ancestor_path = tree.path
  FROM tree
 WHERE albums.id = tree.id AND albums.ancestor_path <> tree.path
"#,
        [],
    )
    .map_err(|e| format!("v029 rebuild ancestor_path: {e}"))
}

fn read_local_folder_rows(conn: &Connection) -> Result<Vec<LocalFolderRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, parent_id, sync_folder, created_at
               FROM albums
              WHERE type = 'local_folder' AND sync_folder IS NOT NULL
              ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| format!("v029 prepare local folder albums: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LocalFolderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sync_path: normalize_lexical_path(&row.get::<_, String>(3)?),
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("v029 query local folder albums: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("v029 read local folder albums: {e}"))
}

fn normalize_lexical_path(raw: &str) -> PathBuf {
    Path::new(raw).components().collect()
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn is_true_ancestor(candidate: &Path, path: &Path) -> bool {
    path_depth(candidate) < path_depth(path) && path.starts_with(candidate)
}

fn resolve_name_ci(
    conn: &Connection,
    parent_id: Option<&str>,
    base: &str,
    exclude_id: Option<&str>,
) -> Result<String, String> {
    if name_available_ci(conn, parent_id, base, exclude_id)? {
        return Ok(base.to_string());
    }
    for suffix in 2usize.. {
        let candidate = format!("{base} ({suffix})");
        if name_available_ci(conn, parent_id, &candidate, exclude_id)? {
            return Ok(candidate);
        }
    }
    unreachable!("an unbounded numeric suffix always has an available value")
}

fn name_available_ci(
    conn: &Connection,
    parent_id: Option<&str>,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<bool, String> {
    let existing: Option<String> = match (parent_id, exclude_id) {
        (None, None) => conn.query_row(
            "SELECT id FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1) LIMIT 1",
            params![name],
            |row| row.get(0),
        ),
        (None, Some(exclude)) => conn.query_row(
            "SELECT id FROM albums WHERE parent_id IS NULL AND LOWER(name) = LOWER(?1) AND id != ?2 LIMIT 1",
            params![name, exclude],
            |row| row.get(0),
        ),
        (Some(parent), None) => conn.query_row(
            "SELECT id FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2) LIMIT 1",
            params![parent, name],
            |row| row.get(0),
        ),
        (Some(parent), Some(exclude)) => conn.query_row(
            "SELECT id FROM albums WHERE parent_id = ?1 AND LOWER(name) = LOWER(?2) AND id != ?3 LIMIT 1",
            params![parent, name, exclude],
            |row| row.get(0),
        ),
    }
    .optional()
    .map_err(|e| format!("v029 check scoped album name: {e}"))?;
    Ok(existing.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
PRAGMA foreign_keys = ON;
CREATE TABLE albums (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    parent_id     TEXT    REFERENCES albums(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL DEFAULT 'normal',
    sync_folder   TEXT,
    folder_status TEXT,
    ancestor_path TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_albums_name_scoped
    ON albums(COALESCE(parent_id, ''), LOWER(name));
CREATE UNIQUE INDEX idx_albums_sync_folder
    ON albums(sync_folder) WHERE sync_folder IS NOT NULL;
"#,
        )
        .unwrap();
        conn
    }

    fn insert_album(
        conn: &Connection,
        id: &str,
        name: &str,
        parent_id: Option<&str>,
        kind: &str,
        sync_folder: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, ancestor_path)
             VALUES (?1, ?2, (SELECT COUNT(*) + 1 FROM albums), ?3, ?4, ?5, '')",
            params![id, name, parent_id, kind, sync_folder],
        )
        .unwrap();
    }

    fn album_state(conn: &Connection, id: &str) -> (String, Option<String>, String) {
        conn.query_row(
            "SELECT name, parent_id, ancestor_path FROM albums WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn lifts_normal_subtree_and_resolves_root_name_collision() {
        let conn = test_connection();
        insert_album(&conn, "root-name", "Name", None, "normal", None);
        insert_album(
            &conn,
            "local",
            "Local",
            None,
            "local_folder",
            Some("/library"),
        );
        insert_album(&conn, "normal", "name", Some("local"), "normal", None);
        insert_album(&conn, "leaf", "leaf", Some("normal"), "normal", None);

        up(&conn).unwrap();

        assert_eq!(album_state(&conn, "normal").0, "name (2)");
        assert_eq!(album_state(&conn, "normal").1, None);
        assert_eq!(album_state(&conn, "leaf").1.as_deref(), Some("normal"));
    }

    #[test]
    fn rechains_parallel_and_deep_local_folder_albums_by_nearest_path() {
        let conn = test_connection();
        insert_album(&conn, "a", "A", None, "local_folder", Some("/library/A/"));
        insert_album(&conn, "e", "E", None, "local_folder", Some("/library/A/E"));
        insert_album(&conn, "c", "C", None, "local_folder", Some("/library/A/C"));
        insert_album(
            &conn,
            "deep-e",
            "A-C-E",
            None,
            "local_folder",
            Some("/library/A/C/E"),
        );

        up(&conn).unwrap();

        assert_eq!(album_state(&conn, "e").1.as_deref(), Some("a"));
        assert_eq!(album_state(&conn, "c").1.as_deref(), Some("a"));
        assert_eq!(album_state(&conn, "deep-e").1.as_deref(), Some("c"));
    }

    #[test]
    fn strips_legacy_prefix_only_without_sibling_collision() {
        let conn = test_connection();
        insert_album(&conn, "a", "A", None, "local_folder", Some("/library/A"));
        insert_album(
            &conn,
            "b",
            "A-B",
            Some("a"),
            "local_folder",
            Some("/library/A/B"),
        );
        insert_album(
            &conn,
            "c",
            "A-C",
            Some("a"),
            "local_folder",
            Some("/library/A/C"),
        );
        insert_album(
            &conn,
            "other",
            "B",
            Some("a"),
            "local_folder",
            Some("/library/A/Other"),
        );

        up(&conn).unwrap();

        assert_eq!(album_state(&conn, "b").0, "A-B");
        assert_eq!(album_state(&conn, "c").0, "C");
    }

    #[test]
    fn second_run_is_idempotent_without_updates() {
        let conn = test_connection();
        insert_album(&conn, "a", "A", None, "local_folder", Some("/library/A"));
        insert_album(
            &conn,
            "b",
            "A-B",
            None,
            "local_folder",
            Some("/library/A/B"),
        );

        up(&conn).unwrap();
        let before = conn.total_changes();
        up(&conn).unwrap();

        assert_eq!(conn.total_changes(), before);
    }

    #[test]
    fn up_rebuilds_all_ancestor_paths_without_orphans() {
        let conn = test_connection();
        insert_album(&conn, "a", "A", None, "local_folder", Some("/library/A"));
        insert_album(
            &conn,
            "b",
            "A-B",
            None,
            "local_folder",
            Some("/library/A/B"),
        );
        insert_album(&conn, "normal", "normal", Some("b"), "normal", None);

        up(&conn).unwrap();

        let orphan_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM albums WHERE ancestor_path = ''",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan_count, 0);
        assert_eq!(album_state(&conn, "b").2, "/a/b/");
        assert_eq!(album_state(&conn, "normal").2, "/normal/");
    }
}
