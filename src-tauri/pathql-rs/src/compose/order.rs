use crate::ast::OrderDirection;

/// 累积的 ORDER 状态。
///
/// `entries` 保留最终 ORDER BY 优先级（index 0 优先）。`global` 是
/// `OrderForm::Global { all }` 的累积，多次声明 last-wins。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderState {
    pub entries: Vec<(String, OrderDirection)>,
    pub global: Option<OrderDirection>,
}

impl OrderState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 插入或更新一条 ORDER BY 项。
    ///
    /// - `prepend = false`：新字段追加；已有字段保持当前位置并更新方向。
    /// - `prepend = true`：新字段插入到最前；已有字段移到最前并更新方向。
    /// - `Revert` 在 fold 期解析；已有字段翻转方向，缺失字段默认为 Asc。
    pub fn insert(&mut self, sql: String, dir: OrderDirection, prepend: bool) {
        let existing_pos = self.entries.iter().position(|(field, _)| field == &sql);
        let existing_dir = existing_pos.map(|pos| self.entries[pos].1);
        let effective_dir = resolve_direction(dir, existing_dir);

        match (prepend, existing_pos) {
            (false, Some(pos)) => {
                self.entries[pos].1 = effective_dir;
            }
            (false, None) => {
                self.entries.push((sql, effective_dir));
            }
            (true, Some(pos)) => {
                self.entries.remove(pos);
                self.entries.insert(0, (sql, effective_dir));
            }
            (true, None) => {
                self.entries.insert(0, (sql, effective_dir));
            }
        }
    }

    pub fn clear_all(&mut self) {
        self.entries.clear();
    }
}

fn resolve_direction(incoming: OrderDirection, existing: Option<OrderDirection>) -> OrderDirection {
    match incoming {
        OrderDirection::Asc | OrderDirection::Desc => incoming,
        OrderDirection::Revert => match existing {
            Some(OrderDirection::Asc) => OrderDirection::Desc,
            Some(OrderDirection::Desc) => OrderDirection::Asc,
            Some(OrderDirection::Revert) | None => OrderDirection::Asc,
        },
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
    fn default_global_none() {
        let o = OrderState::new();
        assert!(o.global.is_none());
        assert!(o.entries.is_empty());
    }

    #[test]
    fn insert_revert_flips_existing_asc_to_desc() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("a".into(), OrderDirection::Revert, false);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Desc));
    }

    #[test]
    fn insert_revert_flips_existing_desc_to_asc() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Desc, false);
        o.insert("a".into(), OrderDirection::Revert, false);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Asc));
    }

    #[test]
    fn insert_revert_on_missing_defaults_to_asc() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Revert, false);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Asc));
    }

    #[test]
    fn prepend_revert_existing_flips_and_moves_to_front() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.insert("b".into(), OrderDirection::Desc, false);
        o.insert("a".into(), OrderDirection::Revert, true);
        assert_eq!(
            o.entries,
            vec![
                ("a".into(), OrderDirection::Desc),
                ("b".into(), OrderDirection::Desc),
            ]
        );
    }

    #[test]
    fn clear_all_drops_entries_but_keeps_global_modifier() {
        let mut o = OrderState::new();
        o.insert("a".into(), OrderDirection::Asc, false);
        o.global = Some(OrderDirection::Revert);
        o.clear_all();
        assert!(o.entries.is_empty());
        assert_eq!(o.global, Some(OrderDirection::Revert));
    }
}
