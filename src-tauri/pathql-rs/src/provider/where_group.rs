//! 路径 WHERE 组合器 —— 把 [`WhereQuery`] 树映射到线性的路径段序列。
//!
//! 路径是线性的, 而树需要边界, 所以引入一组以 `~` 开头的**保留段**作结构记号:
//!
//! ```text
//! group  ::= "~any" branch ("~or" branch)* "~end"
//!          | "~not" branch "~end"
//! branch ::= segment+           (可含嵌套 group)
//! ```
//!
//! 例: `gallery://all/~any/plugin/pixiv/~or/album/收藏/~end/~not/plugin/yande/~end`
//! ⇒ `(来自 pixiv OR 在收藏画册) AND NOT(来自 yande)`。
//!
//! **分支是旁路(detour)**: 每个分支从组入口的 provider 出发正常折叠, 但只为收集
//! 谓词贡献; `~end` 之后路径游标**回到组入口 provider** 继续前进。组合器是挂在入口
//! 节点上的过滤器注解, 不改变「你在树上的位置」。
//!
//! 保留段在 provider resolve **之前**被拦截, 不参与任何 provider 的 resolve/list
//! 碰撞检查, 也不会被动态 list 反查吞掉。字面段确实以 `~` 开头时写 `\~<原名>`。
//! 路径段统一用反斜线转义: `\X` 表示字面字符 `X`; 未转义的 `/` 是分隔符,
//! 需要放进段内的 `/` 写作 `\/`。

use std::sync::Arc;

use super::{EngineError, Provider};
use crate::ast::{JoinKind, WhereQuery};
use crate::compose::ProviderQuery;

/// 路径段经组合器解释后的形态。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SegmentKind {
    /// 开一个 OR 组。
    OpenAny,
    /// 开一个取非组。
    OpenNot,
    /// 分支分隔符。
    Branch,
    /// 闭合当前组。
    Close,
    /// 未转义的 `~` 前缀保留段。
    Reserved(String),
    /// 普通路径段 (已解反斜线转义, 或经 percent-decode 过渡兜底)。
    Literal(String),
}

/// 解开字面路径段里的反斜线转义。
///
/// `\X` 无条件还原为 `X`; 孤立的尾部 `\` 按字面反斜线保留。
pub fn unescape_path_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    let mut chars = seg.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            out.push(chars.next().unwrap_or('\\'));
        } else {
            out.push(ch);
        }
    }
    out
}

/// 解释单个原始路径段。未转义的 `~` 前缀整体保留给引擎语法。
pub(crate) fn classify_segment(seg: &str) -> SegmentKind {
    match seg {
        "~any" => SegmentKind::OpenAny,
        "~or" => SegmentKind::Branch,
        "~not" => SegmentKind::OpenNot,
        "~end" => SegmentKind::Close,
        _ if seg.starts_with('~') => SegmentKind::Reserved(seg.to_string()),
        _ if seg.contains('\\') => SegmentKind::Literal(unescape_path_segment(seg)),
        _ => {
            // TODO(Phase 3 收尾): 前端全部迁到反斜线转义后移除本兜底
            SegmentKind::Literal(
                percent_encoding::percent_decode_str(seg)
                    .decode_utf8_lossy()
                    .into_owned(),
            )
        }
    }
}

/// 把一个**字面**路径段转义成可安全放进路径的形式。
///
/// 宿主用数据(画册名、插件 id、tag …)拼路径段时必须经过此函数。它会转义反斜线、
/// 段内 `/` 与前导 `~`, 使返回值可直接作为一个原始路径段使用。
pub fn escape_path_segment(literal: &str) -> String {
    let mut escaped = String::with_capacity(literal.len());
    for ch in literal.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '/' => escaped.push_str("\\/"),
            _ => escaped.push(ch),
        }
    }
    if escaped.starts_with('~') {
        escaped.insert(0, '\\');
    }
    escaped
}

/// 预扫描: 返回「处理完第 i 段之后」的组嵌套深度。
/// 深度为 0 的前缀边界才允许读写路径前缀缓存 —— 组的效果此时已完全烘进 composed。
/// 语法错误在这里不报, 留给 walk 期带上具体路径报。
pub(crate) fn group_depths(segments: &[String]) -> Vec<usize> {
    let mut depth: usize = 0;
    segments
        .iter()
        .map(|seg| {
            match classify_segment(seg) {
                SegmentKind::OpenAny | SegmentKind::OpenNot => depth += 1,
                SegmentKind::Close => depth = depth.saturating_sub(1),
                _ => {}
            }
            depth
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupKind {
    Any,
    Not,
}

impl GroupKind {
    pub(crate) fn marker(self) -> &'static str {
        match self {
            GroupKind::Any => "~any",
            GroupKind::Not => "~not",
        }
    }
}

/// 一层组的折叠状态。
pub(crate) struct GroupFrame {
    kind: GroupKind,
    /// 组入口处的 provider —— 每个分支都从它出发, `~end` 后也回到它。
    entry_provider: Option<Arc<dyn Provider>>,
    /// **当前分支**的折叠基线。每收完一个分支就更新为「带上该分支 LEFT JOIN、
    /// 但不带该分支 where」的状态, 于是 join 跨分支累积而谓词彼此隔离。
    base_composed: ProviderQuery,
    /// 已收完的分支谓词。
    branches: Vec<WhereQuery>,
}

/// 组栈。空栈 = 不在任何组内。
#[derive(Default)]
pub(crate) struct GroupStack {
    frames: Vec<GroupFrame>,
}

impl GroupStack {
    pub(crate) fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// 开组: 快照入口 provider 与当前累积状态。
    pub(crate) fn open(
        &mut self,
        kind: GroupKind,
        provider: Option<Arc<dyn Provider>>,
        composed: &ProviderQuery,
    ) {
        self.frames.push(GroupFrame {
            kind,
            entry_provider: provider,
            base_composed: composed.clone(),
            branches: Vec::new(),
        });
    }

    /// `~or`: 收束当前分支, 游标回到组入口, 下一分支从更新后的基线出发。
    /// 返回 (回退到的 provider, 回退到的 composed)。
    pub(crate) fn branch(
        &mut self,
        path: &str,
        current: &ProviderQuery,
    ) -> Result<(Option<Arc<dyn Provider>>, ProviderQuery), EngineError> {
        let frame = self.frames.last().ok_or_else(|| {
            EngineError::WhereGroup(
                path.to_string(),
                "`~or` without an enclosing `~any` group".into(),
            )
        })?;
        if frame.kind == GroupKind::Not {
            return Err(EngineError::WhereGroup(
                path.to_string(),
                "`~or` is not allowed inside a `~not` group; nest `~not/~any/.../~end/~end` instead"
                    .into(),
            ));
        }
        let (atom, carry) = finish_branch(path, &frame.base_composed, current)?;
        let provider = frame.entry_provider.clone();
        let frame = self.frames.last_mut().expect("frame checked above");
        frame.branches.push(atom);
        frame.base_composed = carry.clone();
        Ok((provider, carry))
    }

    /// `~end`: 收束最后一个分支, 组装成 WhereQuery 树并坍缩进累积状态。
    /// 返回 (回退到的 provider, 带上该组谓词的 composed)。
    pub(crate) fn close(
        &mut self,
        path: &str,
        current: &ProviderQuery,
    ) -> Result<(Option<Arc<dyn Provider>>, ProviderQuery), EngineError> {
        let frame = self.frames.pop().ok_or_else(|| {
            EngineError::WhereGroup(
                path.to_string(),
                "`~end` without a matching `~any` / `~not`".into(),
            )
        })?;
        let (atom, mut carry) = finish_branch(path, &frame.base_composed, current)?;

        let mut branches = frame.branches;
        branches.push(atom);
        let tree = match frame.kind {
            GroupKind::Any => WhereQuery::Any(branches),
            GroupKind::Not => {
                // `~or` 已在 branch() 拒绝, 故 Not 组恒为单分支。
                let inner = branches
                    .pop()
                    .expect("a group always finishes at least one branch");
                WhereQuery::Not(Box::new(inner))
            }
        };
        if let Some(expr) = tree.collapse() {
            carry.wheres.push(expr);
        }
        Ok((frame.entry_provider, carry))
    }

    /// 仍未闭合的组记号, 外层在前。**路径走完不自动闭合** —— 未闭合状态原样带出,
    /// 由执行入口拒绝, 免得静默补上 `~end` 产生意料之外的结果集。
    pub(crate) fn open_markers(&self) -> Vec<&'static str> {
        self.frames.iter().map(|f| f.kind.marker()).collect()
    }
}

/// 收束一个分支: 校验它只贡献了谓词与 LEFT JOIN, 取出谓词原子, 并算出
/// 「带 join、不带 where」的携带状态。
///
/// 组内只允许 `where` 与 **LEFT JOIN**: INNER JOIN 是全局 AND 语义的行过滤,
/// 放进 OR 分支会把「或」悄悄变成「且」; LEFT JOIN 只补列不滤行, 谓词引用它是安全的。
fn finish_branch(
    path: &str,
    base: &ProviderQuery,
    current: &ProviderQuery,
) -> Result<(WhereQuery, ProviderQuery), EngineError> {
    let reject = |what: &str| {
        Err(EngineError::WhereGroup(
            path.to_string(),
            format!(
                "a where-group branch may only contribute `where` and LEFT JOINs, but it changed {}",
                what
            ),
        ))
    };

    if current.from != base.from {
        return reject("`from`");
    }
    if current.fields.len() != base.fields.len() {
        return reject("`fields`");
    }
    if current.order != base.order {
        return reject("`order`");
    }
    if current.limit != base.limit {
        return reject("`limit`");
    }
    if current.offset_terms.len() != base.offset_terms.len() {
        return reject("`offset`");
    }
    for join in &current.joins[base.joins.len().min(current.joins.len())..] {
        if join.kind != JoinKind::Left {
            return reject("a non-LEFT `join` (use `kind: \"left\"` inside where groups)");
        }
    }
    if current.joins.len() < base.joins.len() {
        return reject("`join` (joins were dropped)");
    }

    // 分支不得改写基线已有的谓词 (where_clear 会让按索引取增量失真)。
    if current.wheres.len() < base.wheres.len()
        || current.wheres[..base.wheres.len()] != base.wheres[..]
    {
        return Err(EngineError::WhereGroup(
            path.to_string(),
            "a where-group branch must not clear or rewrite predicates accumulated outside the group"
                .into(),
        ));
    }

    let delta = &current.wheres[base.wheres.len()..];
    // 分支内部各谓词之间是 AND —— 折叠语义本来如此, 这里只是把它压成一个原子。
    let atom = match delta.len() {
        0 => WhereQuery::Is(crate::ast::SqlExpr("1 = 1".into())),
        1 => WhereQuery::Is(delta[0].clone()),
        _ => WhereQuery::Is(crate::ast::SqlExpr(
            delta
                .iter()
                .map(|w| format!("({})", w.0))
                .collect::<Vec<_>>()
                .join(" AND "),
        )),
    };

    // 携带 join / alias / adhoc properties 前进, 但丢掉本分支的谓词。
    let mut carry = current.clone();
    carry.wheres.truncate(base.wheres.len());
    Ok((atom, carry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::SqlExpr;
    use crate::compose::JoinFrag;

    fn segs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Ok 分支含 `Arc<dyn Provider>` (非 Debug), 所以不能用 `unwrap_err`。
    fn expect_err(
        r: Result<(Option<Arc<dyn Provider>>, ProviderQuery), EngineError>,
    ) -> EngineError {
        match r {
            Ok(_) => panic!("expected a where-group error"),
            Err(e) => e,
        }
    }

    fn q_with_wheres(list: &[&str]) -> ProviderQuery {
        let mut q = ProviderQuery::new();
        q.from = Some(SqlExpr("images".into()));
        for w in list {
            q.wheres.push(SqlExpr((*w).into()));
        }
        q
    }

    // ===== 段分类 / 转义 =====

    #[test]
    fn markers_classified() {
        assert_eq!(classify_segment("~any"), SegmentKind::OpenAny);
        assert_eq!(classify_segment("~or"), SegmentKind::Branch);
        assert_eq!(classify_segment("~not"), SegmentKind::OpenNot);
        assert_eq!(classify_segment("~end"), SegmentKind::Close);
    }

    #[test]
    fn plain_segment_is_literal() {
        assert_eq!(
            classify_segment("pixiv"),
            SegmentKind::Literal("pixiv".into())
        );
    }

    #[test]
    fn escaped_tilde_is_literal() {
        assert_eq!(
            classify_segment(r"\~any"),
            SegmentKind::Literal("~any".into())
        );
    }

    #[test]
    fn unknown_and_double_tilde_segments_are_reserved() {
        assert_eq!(classify_segment("~x"), SegmentKind::Reserved("~x".into()));
        assert_eq!(
            classify_segment("~~foo"),
            SegmentKind::Reserved("~~foo".into())
        );
    }

    #[test]
    fn backslash_escapes_are_unescaped_in_literals() {
        assert_eq!(
            classify_segment(r"a\/b"),
            SegmentKind::Literal("a/b".into())
        );
        assert_eq!(
            classify_segment(r"a\\b"),
            SegmentKind::Literal(r"a\b".into())
        );
        assert_eq!(classify_segment(r"a\"), SegmentKind::Literal(r"a\".into()));
    }

    #[test]
    fn percent_decode_fallback_only_applies_without_backslash() {
        assert_eq!(
            classify_segment("%E7%94%BB"),
            SegmentKind::Literal("画".into())
        );
        assert_eq!(
            classify_segment(r"a\%2F"),
            SegmentKind::Literal("a%2F".into())
        );
    }

    #[test]
    fn escape_examples_and_unescape_round_trip() {
        let cases = [
            ("~any", r"\~any"),
            ("a/b", r"a\/b"),
            (r"a\b", r"a\\b"),
            ("~a/b", r"\~a\/b"),
            ("pixiv", "pixiv"),
            ("100%", "100%"),
        ];

        for (literal, escaped) in cases {
            assert_eq!(escape_path_segment(literal), escaped);
            assert_eq!(unescape_path_segment(escaped), literal);
        }
    }

    // ===== 深度预扫描 =====

    #[test]
    fn depths_track_nesting() {
        let d = group_depths(&segs(&["a", "~any", "b", "~or", "c", "~end", "d"]));
        assert_eq!(d, vec![0, 1, 1, 1, 1, 0, 0]);
    }

    #[test]
    fn depths_track_nested_groups() {
        let d = group_depths(&segs(&["~any", "~not", "x", "~end", "~end"]));
        assert_eq!(d, vec![1, 2, 2, 1, 0]);
    }

    // ===== 组折叠 =====

    #[test]
    fn any_group_ors_two_branches() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&["outer = 1"]);
        stack.open(GroupKind::Any, None, &base);

        let mut b1 = base.clone();
        b1.wheres.push(SqlExpr("a = 1".into()));
        let (_, carry) = stack.branch("p", &b1).unwrap();
        assert_eq!(carry.wheres.len(), 1, "分支谓词不留在携带状态里");

        let mut b2 = carry.clone();
        b2.wheres.push(SqlExpr("b = 2".into()));
        let (_, out) = stack.close("p", &b2).unwrap();

        assert_eq!(out.wheres.len(), 2);
        assert_eq!(out.wheres[0].0, "outer = 1");
        assert_eq!(out.wheres[1].0, "(a = 1) OR (b = 2)");
        assert!(stack.is_empty());
    }

    #[test]
    fn not_group_negates_single_branch() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Not, None, &base);
        let mut b = base.clone();
        b.wheres.push(SqlExpr("plugin = 'yande'".into()));
        let (_, out) = stack.close("p", &b).unwrap();
        assert_eq!(out.wheres.len(), 1);
        assert_eq!(out.wheres[0].0, "NOT (plugin = 'yande')");
    }

    #[test]
    fn branch_with_multiple_wheres_ands_them_into_one_atom() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        let mut b1 = base.clone();
        b1.wheres.push(SqlExpr("a = 1".into()));
        b1.wheres.push(SqlExpr("b = 2".into()));
        let (_, carry) = stack.branch("p", &b1).unwrap();
        let mut b2 = carry.clone();
        b2.wheres.push(SqlExpr("c = 3".into()));
        let (_, out) = stack.close("p", &b2).unwrap();
        assert_eq!(out.wheres[0].0, "((a = 1) AND (b = 2)) OR (c = 3)");
    }

    #[test]
    fn empty_branch_contributes_tautology() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        let (_, carry) = stack.branch("p", &base).unwrap();
        let mut b2 = carry.clone();
        b2.wheres.push(SqlExpr("a = 1".into()));
        let (_, out) = stack.close("p", &b2).unwrap();
        // 空分支 = 无约束 = 恒真; OR 恒真即全集, 语义正确且显式可见。
        assert_eq!(out.wheres[0].0, "(1 = 1) OR (a = 1)");
    }

    #[test]
    fn left_joins_carry_across_branches() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);

        let mut b1 = base.clone();
        b1.joins.push(JoinFrag {
            kind: JoinKind::Left,
            table: SqlExpr("album_images".into()),
            alias: crate::compose::ResolvedAlias::Literal("ai".into()),
            on: None,
            in_need: false,
        });
        b1.wheres.push(SqlExpr("ai.album_id = 1".into()));
        let (_, carry) = stack.branch("p", &b1).unwrap();
        assert_eq!(carry.joins.len(), 1, "LEFT JOIN 跨分支保留");
        assert!(carry.wheres.is_empty());
    }

    #[test]
    fn inner_join_in_branch_rejected() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        let mut b = base.clone();
        b.joins.push(JoinFrag {
            kind: JoinKind::Inner,
            table: SqlExpr("album_images".into()),
            alias: crate::compose::ResolvedAlias::Literal("ai".into()),
            on: None,
            in_need: false,
        });
        let err = expect_err(stack.close("p", &b));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("non-LEFT")));
    }

    #[test]
    fn branch_changing_from_rejected() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        let mut b = base.clone();
        b.from = Some(SqlExpr("albums".into()));
        let err = expect_err(stack.close("p", &b));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("`from`")));
    }

    #[test]
    fn branch_changing_limit_rejected() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        let mut b = base.clone();
        b.limit = Some(crate::ast::NumberOrTemplate::Number(10.0));
        let err = expect_err(stack.close("p", &b));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("`limit`")));
    }

    #[test]
    fn branch_clearing_outer_where_rejected() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&["outer = 1"]);
        stack.open(GroupKind::Any, None, &base);
        let mut b = base.clone();
        b.wheres.clear(); // 模拟组内 where_clear 剥掉了外层谓词
        let err = expect_err(stack.close("p", &b));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("must not clear")));
    }

    // ===== 语法错误 =====

    #[test]
    fn branch_without_group_rejected() {
        let mut stack = GroupStack::default();
        let err = expect_err(stack.branch("p", &q_with_wheres(&[])));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("without an enclosing")));
    }

    #[test]
    fn close_without_group_rejected() {
        let mut stack = GroupStack::default();
        let err = expect_err(stack.close("p", &q_with_wheres(&[])));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("without a matching")));
    }

    #[test]
    fn or_inside_not_rejected() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Not, None, &base);
        let err = expect_err(stack.branch("p", &base));
        assert!(matches!(err, EngineError::WhereGroup(_, msg) if msg.contains("not allowed inside")));
    }

    #[test]
    fn open_markers_report_unclosed_groups_outermost_first() {
        let mut stack = GroupStack::default();
        let base = q_with_wheres(&[]);
        stack.open(GroupKind::Any, None, &base);
        stack.open(GroupKind::Not, None, &base);
        assert_eq!(stack.open_markers(), vec!["~any", "~not"]);
    }

    #[test]
    fn empty_stack_has_no_open_markers() {
        let stack = GroupStack::default();
        assert!(stack.open_markers().is_empty());
    }
}
