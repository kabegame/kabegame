use crate::ast::AliasName;
use std::collections::HashMap;

/// fold 期分配的字面别名（用于 `${ref:X}` 形态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedAlias {
    pub literal: String,
}

/// 已解析的 alias：要么是字面，要么是未解析的 ref（fold 期都会变成 Literal）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAlias {
    Literal(String),
    /// 仅作为内部状态; fold 完成后所有 ResolvedAlias 都应为 Literal。
    UnresolvedRef(String),
}

impl ResolvedAlias {
    /// 把 AST 的 AliasName 解析为 ResolvedAlias。
    /// `${ref:X}` 形态 → UnresolvedRef("X")；其他 → Literal(原文)。
    pub fn from_alias_name(a: &AliasName) -> Self {
        let s = &a.0;
        if let Some(inner) = s
            .strip_prefix("${ref:")
            .and_then(|s| s.strip_suffix('}'))
        {
            ResolvedAlias::UnresolvedRef(inner.to_string())
        } else {
            ResolvedAlias::Literal(s.clone())
        }
    }

    pub fn as_literal(&self) -> Option<&str> {
        match self {
            ResolvedAlias::Literal(s) => Some(s),
            _ => None,
        }
    }
}

/// 别名分配表：ref ident → 字面别名（首次见到时分配 _aN）。
#[derive(Debug, Clone, Default)]
pub struct AliasTable {
    pub map: HashMap<String, AllocatedAlias>,
    pub counter: u32,
}

impl AliasTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// 首次分配返回新字面 `_aN`；重复 ident 返回已分配项。
    pub fn allocate(&mut self, ref_ident: &str) -> &AllocatedAlias {
        if !self.map.contains_key(ref_ident) {
            let literal = format!("_a{}", self.counter);
            self.counter += 1;
            self.map.insert(
                ref_ident.to_string(),
                AllocatedAlias { literal },
            );
        }
        self.map
            .get(ref_ident)
            .expect("just inserted or already present")
    }

    pub fn lookup(&self, ref_ident: &str) -> Option<&AllocatedAlias> {
        self.map.get(ref_ident)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_alias_name_literal() {
        let a = ResolvedAlias::from_alias_name(&AliasName("img_id".into()));
        assert_eq!(a, ResolvedAlias::Literal("img_id".into()));
    }

    #[test]
    fn from_alias_name_ref() {
        let a = ResolvedAlias::from_alias_name(&AliasName("${ref:my_id}".into()));
        assert_eq!(a, ResolvedAlias::UnresolvedRef("my_id".into()));
    }

    #[test]
    fn from_alias_name_partial_ref_treated_literal() {
        // missing closing `}` — not a valid ref, stays literal
        let a = ResolvedAlias::from_alias_name(&AliasName("${ref:x".into()));
        assert_eq!(a, ResolvedAlias::Literal("${ref:x".into()));
    }

    #[test]
    fn as_literal_returns_some_for_literal() {
        let a = ResolvedAlias::Literal("x".into());
        assert_eq!(a.as_literal(), Some("x"));
    }

    #[test]
    fn as_literal_none_for_unresolved() {
        let a = ResolvedAlias::UnresolvedRef("x".into());
        assert!(a.as_literal().is_none());
    }

    #[test]
    fn alias_table_allocates_sequential() {
        let mut t = AliasTable::new();
        assert_eq!(t.allocate("a").literal, "_a0");
        assert_eq!(t.allocate("b").literal, "_a1");
        assert_eq!(t.allocate("c").literal, "_a2");
    }

    #[test]
    fn alias_table_allocate_idempotent() {
        let mut t = AliasTable::new();
        let a0 = t.allocate("x").literal.clone();
        let a0_again = t.allocate("x").literal.clone();
        assert_eq!(a0, "_a0");
        assert_eq!(a0_again, "_a0");
        assert_eq!(t.counter, 1);
    }

    #[test]
    fn alias_table_lookup() {
        let mut t = AliasTable::new();
        assert!(t.lookup("x").is_none());
        t.allocate("x");
        assert_eq!(t.lookup("x").unwrap().literal, "_a0");
    }
}
