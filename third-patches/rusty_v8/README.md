# rusty_v8 patches (Android `librusty_v8` build tree)

`third/rusty_v8` (denoland/rusty_v8, pinned `v149.4.0` = Cargo.lock's `v8`) is the reproducible
**source** for the Android self-built `librusty_v8` archive, produced by `deno task build:v8`
(`scripts/build-v8.sh`, Linux only). Unlike the other `third/` submodules, this is a **reuse-in-place
fat build tree**: its nested submodules (`v8`, `build/`, `third_party/*`) and the compiled `target/`
live in the working tree, so a rebuild is incremental — no re-fetch, no from-scratch compile.

## `v8` is NOT `[patch.crates-io]`-patched

The rusty_v8 git repo omits the pre-generated FFI bindings (`gen/src_binding_*.rs`) that the
published crates.io crate ships — those are what let a normal build skip bindgen/clang. Patching
`v8` to the git source would force every platform (desktop included) to supply a binding, breaking
the desktop build. It is also unnecessary: the Android **app** build never compiles v8 from source —
it links the archive from `deno task build:v8` via `RUSTY_V8_ARCHIVE`. So the crates.io `v8` stays for
all app builds, and this submodule is only the from-source archive's build tree.

## Patches

Both are flat top-level `*.patch`, applied with `git -C third/rusty_v8 apply` (`build-v8.sh` does this
idempotently — skip if already applied):

- `0001-ninja-jobserver-fd.patch` → `build.rs`: `ninja()` drops `CARGO_MAKEFLAGS` / `MAKEFLAGS`. Cargo
  injects its jobserver via those into build scripts, but the fds don't survive into ninja-spawned
  rustc, which then aborts on a dead descriptor.
- `0002-android-ndk-build-gn.patch` → `build/config/android/BUILD.gn`: new config.gni dropped
  `android_ndk_version`; use the literal `ANDROID_NDK_VERSION_ROLL=r26c_1`. The path is prefixed
  `build/` so `git -C third/rusty_v8 apply` reaches **into the nested `build` submodule's working
  tree** — no separate per-submodule invocation, no nested patch folders.

`deno task patch rusty_v8` is a no-op here: patch-manager only applies to a **clean** tree (and only
reverses a **dirty** one), and this reuse-in-place tree is permanently dirty (nested submodules +
`target/` + baked fixups), so it is skipped. The patches are applied by `build-v8.sh` instead.

Three more build-tree adjustments are **actions, not diffs**, so they are `build-v8.sh` steps done
only on a fresh nested checkout (present already in the reused tree): `third_party/simdutf` file
checkout, host amd64 sysroot install, and the `third_party/android_toolchain/ndk → ../android_ndk`
symlink.

## Artifacts

`deno task build:v8` writes to `bin/android/` (gitignored, reproduced by command, NOT committed):
`librusty_v8_simdutf_release_aarch64-linux-android.a` + `src_binding_simdutf_release_aarch64-linux-android.rs`,
injected into the Android build by mode-plugin (`RUSTY_V8_ARCHIVE` / `RUSTY_V8_SRC_BINDING_PATH`). The `.a`
is stored raw (no gzip) — the dir is gitignored, so there's no committed-blob size to shrink.
The submodule is marked `ignore = dirty` in `.gitmodules` — the fat working tree (nested submodules +
`target/` + baked fixups) is intentional and should not show in `git status`.

## Re-vendor (new v8 version)

1. Bump `third/rusty_v8` to the tag matching the app's `v8` version; `git submodule update --init --recursive`.
2. Rebase both patches (`git apply --check`), repairing `build.rs` / `BUILD.gn` context drift, and
   regenerate them here.
3. `deno task build:v8` — first run fetches nested submodules + NDK and builds from source (~15 GB),
   applying the patches and the three fresh-checkout fixups.
