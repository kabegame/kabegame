fn main() {
    // `rust_i18n::i18n!("locales")` 是编译期宏，把 locales/*.yml 内联进 rlib。
    // 但 cargo 只跟踪 .rs 源文件，改 yml 不会触发本 crate 重编，于是新增的
    // key 静默失败成 key 原文（老 key 照常翻译，因此极难察觉）。
    // 这里显式声明 yml 目录为构建输入。
    println!("cargo:rerun-if-changed=locales");
}
