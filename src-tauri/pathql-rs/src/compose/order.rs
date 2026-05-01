use crate::ast::OrderDirection;

/// 累积的 ORDER 状态。
///
/// `entries` 保留路径声明顺序（首次声明决定位置；同名 field 后续声明覆盖方向）。
/// `global` 是 `OrderForm::Global { all }` 的累积，多次声明 last-wins。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderState {
    pub entries: Vec<(String, OrderDirection)>,
    pub global: Option<OrderDirection>,
}

impl OrderState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加 (field, direction)，行为视 dir 而定：
    /// - `Asc` / `Desc`：若已存在同名 field 则覆盖方向；否则追加。
    /// - `Revert`：fold 期立即解析 — 若已存在则翻转 (Asc↔Desc, 已有 Revert 翻为 Asc)；
    ///   若不存在则按默认 Asc 新增。Phase 5 渲染期假设 entries 中**不含** Revert。
    pub fn upsert(&mut self, field: String, dir: OrderDirection) {
        match dir {
            OrderDirection::Asc | OrderDirection::Desc => {
                if let Some(slot) = self.entries.iter_mut().find(|(f, _)| f == &field) {
                    slot.1 = dir;
                } else {
                    self.entries.push((field, dir));
                }
            }
            OrderDirection::Revert => {
                if let Some(slot) = self.entries.iter_mut().find(|(f, _)| f == &field) {
                    slot.1 = match slot.1 {
                        OrderDirection::Asc => OrderDirection::Desc,
                        OrderDirection::Desc => OrderDirection::Asc,
                        OrderDirection::Revert => OrderDirection::Asc,
                    };
                } else {
                    self.entries.push((field, OrderDirection::Asc));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_appends_new() {
        let mut o = OrderState::new();
        o.upsert("a".into(), OrderDirection::Asc);
        o.upsert("b".into(), OrderDirection::Desc);
        assert_eq!(o.entries.len(), 2);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Asc));
        assert_eq!(o.entries[1], ("b".into(), OrderDirection::Desc));
    }

    #[test]
    fn upsert_overwrites_keeping_position() {
        let mut o = OrderState::new();
        o.upsert("a".into(), OrderDirection::Asc);
        o.upsert("b".into(), OrderDirection::Desc);
        o.upsert("a".into(), OrderDirection::Desc);
        assert_eq!(o.entries.len(), 2);
        // a still at position 0 with new direction
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Desc));
        assert_eq!(o.entries[1], ("b".into(), OrderDirection::Desc));
    }

    #[test]
    fn default_global_none() {
        let o = OrderState::new();
        assert!(o.global.is_none());
        assert!(o.entries.is_empty());
    }

    #[test]
    fn upsert_revert_flips_existing_asc_to_desc() {
        let mut o = OrderState::new();
        o.upsert("a".into(), OrderDirection::Asc);
        o.upsert("a".into(), OrderDirection::Revert);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Desc));
    }

    #[test]
    fn upsert_revert_flips_existing_desc_to_asc() {
        let mut o = OrderState::new();
        o.upsert("a".into(), OrderDirection::Desc);
        o.upsert("a".into(), OrderDirection::Revert);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Asc));
    }

    #[test]
    fn upsert_revert_on_missing_defaults_to_asc() {
        let mut o = OrderState::new();
        o.upsert("a".into(), OrderDirection::Revert);
        assert_eq!(o.entries[0], ("a".into(), OrderDirection::Asc));
    }
}
