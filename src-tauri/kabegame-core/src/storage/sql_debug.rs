//! `KABEGAME_SQL_DEBUG` 为真（已设置且不是 `""` / `"0"` / `"false"`）时，
//! 在连接上挂 SQLite trace：语句开始执行时打印代入参数后的完整 SQL，结束时打印耗时。
//! 输出到 stderr，不影响 CLI 的 JSON stdout。

use rusqlite::trace::{TraceEvent, TraceEventCodes};

pub(crate) fn install_if_enabled(conn: &rusqlite::Connection) {
    if !enabled() {
        return;
    }
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT | TraceEventCodes::SQLITE_TRACE_PROFILE,
        Some(on_trace),
    );
}

fn enabled() -> bool {
    let Some(value) = std::env::var_os("KABEGAME_SQL_DEBUG") else {
        return false;
    };
    let value = value.to_string_lossy();
    !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
}

fn on_trace(event: TraceEvent<'_>) {
    match event {
        // 触发器子程序的 STMT 事件里只有 "-- TRIGGER name" 注释，原样打印即可。
        TraceEvent::Stmt(stmt, sql) if !sql.starts_with("--") => {
            eprintln!(
                "[sql] {}",
                stmt.expanded_sql().unwrap_or_else(|| sql.to_string())
            );
        }
        TraceEvent::Stmt(_, sql) => eprintln!("[sql] {sql}"),
        // 耗时从语句开始到 reset/finalize，包含 Rust 侧逐行取值的时间。
        TraceEvent::Profile(stmt, elapsed) => {
            eprintln!(
                "[sql] {:.3}ms  {}",
                elapsed.as_secs_f64() * 1e3,
                one_line_head(&stmt.sql(), 120)
            );
        }
        _ => {}
    }
}

fn one_line_head(sql: &str, max_chars: usize) -> String {
    let mut output = String::new();
    let mut words = sql.split_whitespace();

    while let Some(word) = words.next() {
        let separator_len = usize::from(!output.is_empty());
        let remaining = max_chars.saturating_sub(output.chars().count() + separator_len);
        if remaining == 0 {
            break;
        }
        if separator_len != 0 {
            output.push(' ');
        }
        output.extend(word.chars().take(remaining));
        if word.chars().count() > remaining {
            break;
        }
    }

    output
}
