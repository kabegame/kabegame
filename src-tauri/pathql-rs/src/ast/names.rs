use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SimpleName(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Namespace(pub String);

impl Namespace {
    pub fn parent(&self) -> Option<Namespace> {
        self.0.rfind('.').map(|i| Namespace(self.0[..i].to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ProviderName(pub String);

impl ProviderName {
    pub fn is_absolute(&self) -> bool {
        self.0.contains('.')
    }

    pub fn split(&self) -> (Option<Namespace>, SimpleName) {
        match self.0.rfind('.') {
            Some(i) => (
                Some(Namespace(self.0[..i].to_string())),
                SimpleName(self.0[i + 1..].to_string()),
            ),
            None => (None, SimpleName(self.0.clone())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Identifier(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_parent_nested() {
        let ns = Namespace("kabegame.plugin.foo".to_string());
        assert_eq!(ns.parent(), Some(Namespace("kabegame.plugin".to_string())));
    }

    #[test]
    fn namespace_parent_root() {
        let ns = Namespace("kabegame".to_string());
        assert_eq!(ns.parent(), None);
    }

    #[test]
    fn provider_name_split_absolute() {
        let p = ProviderName("kabegame.foo".to_string());
        assert_eq!(
            p.split(),
            (
                Some(Namespace("kabegame".to_string())),
                SimpleName("foo".to_string())
            )
        );
    }

    #[test]
    fn provider_name_split_simple() {
        let p = ProviderName("bar".to_string());
        assert_eq!(p.split(), (None, SimpleName("bar".to_string())));
    }

    #[test]
    fn provider_name_is_absolute() {
        assert!(ProviderName("kabegame.foo".to_string()).is_absolute());
        assert!(!ProviderName("foo".to_string()).is_absolute());
    }

    #[test]
    fn simple_name_transparent_roundtrip() {
        let s = SimpleName("foo".to_string());
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "\"foo\"");
        let back: SimpleName = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn provider_name_transparent_roundtrip() {
        let s = ProviderName("a.b.c".to_string());
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "\"a.b.c\"");
        let back: ProviderName = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn identifier_transparent_roundtrip() {
        let s = Identifier("row".to_string());
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "\"row\"");
    }
}
