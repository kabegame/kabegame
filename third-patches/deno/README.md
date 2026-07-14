# deno_core patches

kabegame's changes to **`deno_core`** live here as one numbered series. `third/deno` is the
pristine upstream `denoland/deno` monorepo submodule; the series patches its `libs/core`
crate (published to crates.io as `deno_core`), pulled into the app via `[patch.crates-io]`.
One submodule, one series — no separate `kabegame/deno_core` fork to re-vendor by hand on
every bump.

`deno_core` used to live in the standalone `denoland/deno_core` repo, but development moved
into the monorepo under `libs/core`; the old repo is abandoned (no `0.40x` tags). The
monorepo is the only upstream that carries `deno_core` 0.405.0.

## Upstream

- Repository: <https://github.com/denoland/deno.git>
- Vendor base: `94d375ddd0` — tag `v2.9.0`, where `libs/core` is byte-identical to crates.io
  `deno_core` 0.405.0 (the version the app resolves — no library churn). `deno_core` is
  version-bumped only at CLI releases, so a bump means moving to the tag whose `libs/core`
  matches the target `deno_core` version.

## Patches

All three patch `libs/core` (i.e. the `deno_core` crate). See
[cocs/crawler/V8_RUNTIME.md](../../cocs/crawler/V8_RUNTIME.md).

- `0001-embed-extension-js-sources.patch` — `extensions.rs`: flip `include_lazy_loaded_js_files!`
  and `__extension_include_js_files_detect!` from `mode=loaded` to `mode=included`, so extension
  `esm`/`js`/`lazy_loaded` sources are `include_str!`-embedded at compile time instead of recorded
  as absolute build-machine paths read from disk at runtime. kabegame runs snapshotless, so the
  loaded path would `read_to_string` the host's cargo-registry paths — nonexistent on a
  cross-compiled Android device (`os error 2`). Because `[patch.crates-io] deno_core` also routes
  `deno_web`/`deno_crypto`/`deno_webidl`'s `extension!` macros through this crate, embedding covers
  all of them.
- `0002-shared-v8-platform-init.patch` — `runtime/setup.rs`: let ordinary runtimes and
  `JsRuntimeForSnapshot` share one process-wide V8 platform init, and decouple the global V8 flags
  from the `snapshot` argument. Device-side baseline snapshot generation must not install
  deterministic flags (`--predictable --random-seed=42`) app-wide merely by winning the one-time
  init race.
- `0003-android-bionic-errno.patch` — `uv_compat/tty.rs`: add a `cfg(target_os = "android")`
  `errno_location()` using Bionic's `__errno()` (glibc uses `__errno_location`); without it the
  Android target hits the platform `compile_error!`.

Apply the whole series manually before building against `third/deno`:

```bash
bun run patch deno
```

Use `bun run patch`, not `bun patch`: Bun 1.3 provides its own unrelated dependency-patching
subcommand under the latter name.

## Consumption (root `Cargo.toml`)

`deno_core` is `[patch.crates-io]`-pointed at `third/deno/libs/core`, so the submodule is the
single source of truth — a bump is just a submodule bump + this series, with no vendored copy
to keep in sync. `libs/core`'s workspace-inherited deps resolve from the excluded `third/deno`
workspace: most (`deno_error`, `deno_path_util`, `deno_unsync`, `deno_core_icudata`) are plain
crates.io versions, while `serde_v8` and `deno_ops` are monorepo path deps (`libs/serde_v8`,
`libs/ops`). Only `deno_core` depends on those two in kabegame's graph (the extension crates use
`deno_core`'s re-exports), so they resolve as a **single copy** from the submodule — no path-vs-
registry duplication.

`third/deno` is a shallow submodule (`shallow = true`); only the pinned commit's tree is fetched.

## Re-vendor

1. `bun run patch deno -r` to restore the clean submodule tree.
2. Bump `third/deno` to the new upstream tag whose `libs/core` matches the `deno_core` version
   the app resolves (check `libs/core/Cargo.toml` `version`).
3. Re-apply each patch with `git apply --check`, repairing context drift.
4. Regenerate the numbered patch files against the new base and update this README.
5. Rebuild the Android `librusty_v8` prebuilt if `v8`/`deno_core` changed (see the mode-plugin
   error message and [cocs/crawler/V8_RUNTIME.md](../../cocs/crawler/V8_RUNTIME.md)).
