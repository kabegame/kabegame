use serde_json::Value;

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };

    map.entry("mcpEnabled").or_insert(Value::Bool(false));
    map.entry("mcpPort").or_insert(Value::from(7490));
    map.entry("mcpDisabledCapabilities")
        .or_insert(Value::Array(vec![]));

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn fills_missing_mcp_keys_without_overwriting() {
        let mut v = json!({ "mcpPort": 8000 });
        super::up(&mut v).unwrap();
        let once = v.clone();
        super::up(&mut v).unwrap();
        assert_eq!(v, once);
        assert_eq!(v["mcpPort"], 8000);
        assert_eq!(v["mcpEnabled"], false);
        assert_eq!(v["mcpDisabledCapabilities"], json!([]));
    }
}
