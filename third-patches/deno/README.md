# deno_core patches

This patch series exists only for **`deno_core`** in `libs/core`. Kabegame always runs build
orchestration with an official Deno CLI binary, installed through `denoland/setup-deno`, Homebrew,
or the official install script; the patches here do not change CLI behavior.

`third/deno` is the pristine upstream `denoland/deno` monorepo submodule. The series patches its
`libs/core` crate (published to crates.io as `deno_core`), pulled into the app through
`[patch.crates-io]`. One submodule and one series replace a separate `kabegame/deno_core` fork that
would otherwise need manual re-vendoring on every bump.

`deno_core` used to live in the standalone `denoland/deno_core` repository, but development moved
into the monorepo under `libs/core`; the old repository has no `0.40x` tags. The monorepo is the
upstream source for `deno_core` 0.405.0.

## Upstream

- Repository: <https://github.com/denoland/deno.git>
- Vendor base: `94d375ddd0` — tag `v2.9.0`, where `libs/core` is byte-identical to crates.io
  `deno_core` 0.405.0 (the version the app resolves, with no library churn). `deno_core` is
  version-bumped at Deno CLI releases, so a bump means moving to the tag whose `libs/core` matches
  the target `deno_core` version.

## Patches

All four patches touch `libs/core` (the `deno_core` crate). See
[cocs/crawler/V8_RUNTIME.md](../../cocs/crawler/V8_RUNTIME.md).

- `0001-embed-extension-js-sources.patch` — changes extension source inclusion from upstream
  `mode=loaded` (an absolute build-time path read from disk at runtime) to `mode=included`
  (`include_str!`). Kabegame runs snapshotless, so paths recorded on the build machine do not exist
  on a cross-compiled Android device and otherwise fail with `os error 2`. Because
  `[patch.crates-io] deno_core` also routes the `deno_web`, `deno_crypto`, and `deno_webidl`
  `extension!` macros through this crate, their sources are covered too. Patch 0005 feature-gates
  this behavior instead of leaving it unconditional.
- `0002-shared-v8-platform-init.patch` — changes `runtime/setup.rs` so ordinary runtimes and
  `JsRuntimeForSnapshot` share one process-wide V8 platform initialization, while global V8 flags
  no longer depend on the `snapshot` argument. Device-side baseline snapshot generation therefore
  cannot install deterministic flags (`--predictable --random-seed=42`) app-wide merely by winning
  the one-time initialization race.
- `0003-android-bionic-errno.patch` — changes `uv_compat/tty.rs` to add an Android-specific
  `errno_location()` backed by Bionic's `__errno()`; glibc uses `__errno_location`. Without it the
  Android target reaches the platform `compile_error!`.
- `0005-embed-ext-sources-feature-gate.patch` — follows up 0001 by adding the
  `embed_ext_sources` Cargo feature and selecting `mode=included` only when that feature is enabled.
  Kabegame-core enables it for its snapshotless runtime, including Android cross-compilation;
  consumers that leave it disabled retain upstream `mode=loaded`. This keeps the embedding change
  explicit instead of changing the default behavior of every `deno_core` consumer.

The former `0004-node-modules-suffix-env.patch` and
`0006-node-modules-suffix-keep-alias-dir.patch` were removed. They were CLI-only patches outside
`libs/core`, whose sole purpose was the `DENO_NODE_MODULES_SUFFIX` mechanism. That mechanism became
fully dormant after the Docker channel stopped using it on 2026-07-27 and the Ubuntu 22.04 guest
stopped using it on 2026-08-06. The custom-built Deno CLI has also been retired, so those patches no
longer have a consumer. The official Deno binary is the more compatible choice as well: its glibc
floor is 2.27, versus 2.35 for the former custom build.

Apply the whole series before building against `third/deno`:

```bash
deno task patch deno
```

The patch manager uses a reset model: applying resets the submodule to its clean pinned baseline and
then applies every patch in filename order; removing (`-r`) resets it to that baseline. Patch numbers
do not need to be contiguous.

## Consumption (root `Cargo.toml`)

`deno_core` is `[patch.crates-io]`-pointed at `third/deno/libs/core`, so the submodule is the single
source of truth. A bump is a submodule bump plus this series, with no vendored copy to keep in sync.
`libs/core`'s workspace-inherited dependencies resolve from the excluded `third/deno` workspace:
most (`deno_error`, `deno_path_util`, `deno_unsync`, `deno_core_icudata`) are plain crates.io
versions, while `serde_v8` and `deno_ops` are monorepo path dependencies (`libs/serde_v8`,
`libs/ops`). Only `deno_core` depends on those two in Kabegame's graph (the extension crates use
`deno_core`'s re-exports), so they resolve as a single copy from the submodule without
path-versus-registry duplication.

`third/deno` is a shallow submodule (`shallow = true`); only the pinned commit's tree is fetched.

## Re-vendor

1. Run `deno task patch deno -r` to reset the submodule to its clean pinned baseline.
2. Move the `third/deno` pin to the upstream tag whose `libs/core/Cargo.toml` version matches the
   `deno_core` version resolved by the app.
3. Repair or regenerate the numbered patch files against the new baseline and update this README.
4. Run `deno task patch deno` to reset to the new baseline and apply the full repaired series.
5. Rebuild the Android `librusty_v8` prebuilt if `v8` or `deno_core` changed; see the mode-plugin
   error message and [cocs/crawler/V8_RUNTIME.md](../../cocs/crawler/V8_RUNTIME.md).
