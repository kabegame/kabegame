use crate::validate::{dynamic, names, paths, query_refs, ValidateConfig, ValidateError};
use crate::ProviderRegistry;

/// 不需要 sqlparser / regex 的所有 per-provider 检查。
pub fn validate_simple(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter_dsl() {
        names::validate_names(ns, name, def, errors);
        query_refs::validate_query_refs(ns, name, def, errors);
        dynamic::validate_dynamic(ns, name, def, cfg, errors);
        paths::validate_path_exprs(ns, name, def, errors);
    }
}
