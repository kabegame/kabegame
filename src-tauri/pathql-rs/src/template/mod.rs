pub mod eval;
pub mod parse;

pub use eval::{evaluate_var, EvalError, TemplateContext, TemplateValue};
pub use parse::{parse, validate_scope, ParseError, ScopeError, Segment, TemplateAst, VarRef};

/// 把连续空白（空格 / 换行 / 制表符）压成单个空格。YAML `|-` 块标量里 SQL 按子句换行，
/// 判别 SQL 形态时不能假设关键字两侧恰好是空格。
pub(crate) fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 字符串 meta 是否为 SQL（RULES §4.5 的启发式）：以 `select` 开头且含 `from` 关键字。
/// 先归一化空白，换行与空格等价。
pub(crate) fn meta_looks_like_select(s: &str) -> bool {
    let norm = collapse_whitespace(s).to_ascii_lowercase();
    norm.starts_with("select ") && norm.contains(" from ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_select_detection_is_whitespace_insensitive() {
        assert!(meta_looks_like_select("SELECT 1 AS a FROM t"));
        // YAML 块标量：关键字前后是换行 / 缩进 / 制表符
        assert!(meta_looks_like_select(
            "SELECT\n  CASE WHEN 1 THEN 2 END AS a\nFROM (SELECT 1)"
        ));
        assert!(meta_looks_like_select("  select\ta\tfrom\tt"));
        // 不是 SQL：模板串、只有 select 没有 from、from 只是单词的一部分
        assert!(!meta_looks_like_select("${row}"));
        assert!(!meta_looks_like_select("select a"));
        assert!(!meta_looks_like_select("selected from here"));
        assert!(!meta_looks_like_select("SELECT a FROMAGE"));
    }
}
