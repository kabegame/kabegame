use crate::ast::ProviderDef;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone)]
pub enum Source<'a> {
    Path(&'a std::path::Path),
    Bytes(&'a [u8]),
    Str(&'a str),
}

#[derive(Debug, Error)]
pub enum LoadError {
    #[error("syntax error in {path:?}: {msg}")]
    Syntax {
        path: Option<PathBuf>,
        line: Option<u32>,
        col: Option<u32>,
        msg: String,
    },
    #[error("io error reading {path}: {source}", path = path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("missing required field `{field}` in {path:?}")]
    MissingField {
        path: Option<PathBuf>,
        field: String,
    },
    #[error("type error in {path:?}: {msg}")]
    Type { path: Option<PathBuf>, msg: String },
}

pub trait Loader {
    fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockLoader;
    impl Loader for MockLoader {
        fn load(&self, _: Source<'_>) -> Result<ProviderDef, LoadError> {
            Err(LoadError::MissingField {
                path: None,
                field: "name".into(),
            })
        }
    }

    #[test]
    fn loader_trait_object_works() {
        let l: Box<dyn Loader> = Box::new(MockLoader);
        let r = l.load(Source::Str("{}"));
        assert!(matches!(r, Err(LoadError::MissingField { .. })));
    }

    #[test]
    fn syntax_error_display() {
        let e = LoadError::Syntax {
            path: Some(PathBuf::from("/tmp/foo.json")),
            line: Some(3),
            col: Some(7),
            msg: "unexpected token".into(),
        };
        let s = format!("{}", e);
        assert!(s.contains("/tmp/foo.json"));
        assert!(s.contains("unexpected token"));
    }

    #[test]
    fn io_error_display() {
        let e = LoadError::Io {
            path: PathBuf::from("/tmp/x"),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "nope"),
        };
        let s = format!("{}", e);
        assert!(s.contains("/tmp/x"));
    }

    #[test]
    fn missing_field_display() {
        let e = LoadError::MissingField {
            path: None,
            field: "name".into(),
        };
        let s = format!("{}", e);
        assert!(s.contains("name"));
    }

    #[test]
    fn type_error_display() {
        let e = LoadError::Type {
            path: None,
            msg: "expected string".into(),
        };
        assert!(format!("{}", e).contains("expected string"));
    }
}
