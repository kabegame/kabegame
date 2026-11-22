# pipewire-rs patches

`third/pipewire-rs` is the pristine upstream `pipewire/pipewire-rs` submodule. The root `Cargo.toml`
points all four crates it publishes (`libspa`, `libspa-sys`, `pipewire`, `pipewire-sys`) at it through
`[patch.crates-io]`. Patching only `libspa` is not enough: its `spa_sys` path dependency would be a
second `libspa-sys` package next to the registry one, and both declare the same `links`.

Why the series exists: Linux release builds run in an Ubuntu 22.04 VM (see
[cocs/build/LINUX_BUILD_WORKFLOW.md](../../cocs/build/LINUX_BUILD_WORKFLOW.md)), whose `libspa-0.2-dev`
ships the PipeWire 0.3.48 headers. `libspa` gates most newer API behind `v0_3_*` / `v1_*` features,
but a few spots use newer header content unconditionally, so the crate does not compile against 0.3.48.
Building against the oldest headers we support keeps the binary honest about the oldest
`libpipewire-0.3` it can run on. Using anything newer then fails at compile time instead of on a
user's machine.

## Upstream

- Repository: <https://gitlab.freedesktop.org/pipewire/pipewire-rs.git>
- Vendor base: `70b20f09` — tag `v0.10.1` (the commit crates.io `libspa` / `libspa-sys` /
  `pipewire` / `pipewire-sys` 0.10.1 were published from, per their `.cargo_vcs_info.json`).

## Patches

- `01-libspa-spa-headers-before-0-3-65.patch` — lets `libspa` compile against SPA headers older than
  0.3.65 without changing anything on newer ones:
  - `MetaRegion::is_valid` and `VideoDamageIter::new` compute what the static inline
    `spa_meta_region_is_valid` / `spa_meta_first` do (a size check and `m->data`). In 0.3.48 those
    are macros, so bindgen exports no function for them.
  - `spa_video_info_raw` only gained `flags`, and turned `modifier` from `int64_t` into `uint64_t`, in
    0.3.65 (checked against Debian 12's 0.3.65 headers). `VideoInfoRaw::new()` now zero-initialises
    instead of naming every field. `flags()` / `set_flags()` and the `Debug` field require
    `v0_3_65`, matching the crate's existing gating of `VideoFlags::MODIFIER`. `modifier()` /
    `set_modifier()` cast, so they keep their `u64` signature on both layouts.

Checked with `pipewire = "=0.10.1"` + `libspa = "=0.10.1"` against the 0.3.48 headers, the 1.6.2
headers, and the 1.6.2 headers with `pipewire/v1_2_0` + `libspa/v1_6_0`. The patch is a plain upstream
bug fix; drop the series once upstream ships it.

Apply it before any cargo build that resolves these crates:

```bash
deno task patch pipewire-rs   # or: deno task patch --all
```

## Re-vendor

1. Run `deno task patch pipewire-rs -r` to restore the clean vendor tree.
2. Check out the upstream tag matching the version in `src-tauri/kabegame/Cargo.toml`, and make
   sure its `.cargo_vcs_info.json` commit matches the crates.io release.
3. Run `deno task patch pipewire-rs --check`. Repair context drift, or drop the patch if upstream
   fixed the gating.
4. Re-check against the Ubuntu 22.04 headers (`libspa-0.2-dev` / `libpipewire-0.3-dev`
   0.3.48): build in the VM, or point `PKG_CONFIG_PATH` at extracted copies of those packages.
