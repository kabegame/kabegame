//! Standalone CEF subprocess executable (renderer/GPU/utility).
//!
//! Every CEF-based process in this workspace that needs a subprocess (the
//! `cef-example` windowed demo and Kabegame's macOS CEF runtime backend) points
//! `Settings.browser_subprocess_path` at this binary
//! instead of re-executing itself. See docs/README_PLUGIN_DEV.md sibling
//! `tauri-runtime-cef` README and the `cef-example` crate for the browser
//! (main) process side of this split.
//!
//! macOS requires the CEF framework to be loaded at runtime (cef-dll-sys
//! does not link libcef there); Linux/Windows link `dylib=cef` at build
//! time and need no explicit load step.

fn main() {
    #[cfg(target_os = "macos")]
    let _loader = {
        let exe = std::env::current_exe().expect("failed to resolve current_exe");
        let loader = cef::library_loader::LibraryLoader::new(&exe, true);
        assert!(loader.load(), "cef-helper: cef_load_library failed");
        loader
    };

    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    let mut app = cef_helper::new_cef_helper_app();
    let code = cef::execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    std::process::exit(code.max(0));
}
