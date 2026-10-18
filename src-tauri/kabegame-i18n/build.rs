fn main() {
    // `rust_i18n::i18n!("locales")` 是编译期宏，把 locales/*.yml 内联进 rlib。
    // 但 cargo 只跟踪 .rs 源文件；对**目录**的 `rerun-if-changed` 只观察目录项增删，
    // 原地修改 `.yml` 不会触发本 crate 重编——新增的 key 会静默失败成 key 原文，
    // 老 key 照常翻译，因此极难察觉。必须逐个文件声明，mtime 变化才会触发重编。
    let locales = std::path::Path::new("locales");
    println!("cargo:rerun-if-changed={}", locales.display());
    for entry in std::fs::read_dir(locales).expect("读取 kabegame-i18n/locales 失败") {
        let path = entry.expect("读取 locales 目录项失败").path();
        if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
