use crate::ast::OrderDirection;

/// 累积的 ORDER 状态。
///
/// `entries` 保留最终 ORDER BY 优先级（index 0 优先）。`revert` 控制是否
/// 在渲染时翻转全部方向。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderState {
    pub entries: Vec<(String, OrderDirection)>,
    pub revert: bool,
}

impl OrderState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 插入或更新一条 ORDER BY 项。
    ///
    /// - `prepend = false`：新字段追加；已有字段保持当前位置并更新方向。
    /// - `prepend = true`：新字段插入到最前；已有字段移到最前并更新方向。
    pub fn insert(&mut self, sql: String, dir: OrderDirection, prepend: bool) {
        let existing_pos = self.entries.iter().position(|(field, _)| field == &sql);

        match (prepend, existing_pos) {
            (false, Some(pos)) => {
                self.entries[pos].1 = dir;
            }
            (false, None) => {
                self.entries.push((sql, dir));
            }
            (true, Some(pos)) => {
                self.entries.remove(pos);
                self.entries.insert(0, (sql, dir));
            }
            (true, None) => {
                self.entries.insert(0, (sql, dir));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_appends_new_without_prepend() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("b".into(), OrderDirection::Desc, false);
        assert_eq!(
            o.entries,
            vec![
                ("a".into(), OrderDirection::Asc),
                ("b".into(), OrderDirection::Desc),
            ]
        );
    }

    #[test]
    fn insert_overwrites_existing_without_moving_when_not_prepend() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("b".into(), OrderDirection::Desc, false);
        o.insert("a".into(), OrderDirection::Desc, false);
        assert_eq!(
            o.entries,
            vec![
                ("a".into(), OrderDirection::Desc),
                ("b".into(), OrderDirection::Desc),
            ]
        );
    }

    #[test]
    fn insert_prepends_new() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("b".into(), OrderDirection::Desc, true);
        assert_eq!(
            o.entries,
            vec![
                ("b".into(), OrderDirection::Desc),
                ("a".into(), OrderDirection::Asc),
            ]
        );
    }

    #[test]
    fn insert_prepends_existing() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("b".into(), OrderDirection::Desc, false);
        o.insert("a".into(), OrderDirection::Desc, true);
        assert_eq!(
            o.entries,
            vec![
                ("a".into(), OrderDirection::Desc),
                ("b".into(), OrderDirection::Desc),
            ]
        );
    }

    #[test]
    fn default_revert_false() {
        let o = OrderState::new();
        assert!(!o.revert);
        assert!(o.entries.is_empty());
    }
}
