use std::collections::HashSet;

/// 校验配置。调用方按需注入。
#[derive(Debug, Clone)]
pub struct ValidateConfig {
    /// 表名白名单。`None` = 跳过白名单检查（开发期默认）。
    /// 生产环境调用方应注入完整集合。
    pub table_whitelist: Option<HashSet<String>>,
    /// 保留标识符。
    pub reserved_idents: HashSet<&'static str>,
    /// 是否强制 `ProviderInvocation::ByName` 的引用必须在 registry 命中。
    /// 默认 `false`：测试 / 部分加载场景不报错；生产（Phase 6 加载全部 provider 后）置 `true`。
    pub enforce_cross_refs: bool,
}

impl Default for ValidateConfig {
    fn default() -> Self {
        Self::with_default_reserved()
    }
}

impl ValidateConfig {
    /// 默认配置：跳过白名单 + reserved identifiers (引擎自身用的命名空间和方法名)。
    ///
    /// "out" / "row" 等是约定的 binding 名而非保留字，不在此集合内（实际数据广泛使用）。
    pub fn with_default_reserved() -> Self {
        let reserved = ["properties", "capture", "composed", "ref", "_"]
            .into_iter()
            .collect();
        Self {
            table_whitelist: None,
            reserved_idents: reserved,
            enforce_cross_refs: false,
        }
    }

    pub fn with_whitelist<I: IntoIterator<Item = String>>(mut self, tables: I) -> Self {
        self.table_whitelist = Some(tables.into_iter().collect());
        self
    }

    pub fn with_cross_refs(mut self, enforce: bool) -> Self {
        self.enforce_cross_refs = enforce;
        self
    }
}
