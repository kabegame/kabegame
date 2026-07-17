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
