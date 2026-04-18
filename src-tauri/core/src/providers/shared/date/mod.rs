//! 按日期分层的共享 provider（shared 底层）。
//!
//! 层级：YearsProvider → YearProvider → MonthProvider → DayProvider。
//! 时间排序（crawled_at ASC）由 YearsProvider 的 apply_query 统一 prepend，
//! 下层 Year/Month/Day 只追加各自的 WHERE 过滤。

pub mod day;
pub mod month;
pub mod year;
pub mod years;
