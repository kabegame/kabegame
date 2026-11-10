// Kabegame 修改，见 KABEGAME.md
fn main() {
    cfg_aliases::cfg_aliases! {
        wgsl_out: { feature = "wgsl-out" },
        std: { any(test, feature = "stderr") },
        no_std: { not(std) },
    }
}
