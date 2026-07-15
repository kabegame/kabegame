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

- `0001-embed-extension-js-sources.patch` — `extensions.rs` + `Cargo.toml`: add an
  `embed_ext_sources` cargo feature; when enabled, `include_lazy_loaded_js_files!` and
  `__extension_include_js_files_detect!` expand with `mode=included`, so extension
  `esm`/`js`/`lazy_loaded` sources are `include_str!`-embedded at compile time instead of recorded
  as absolute build-machine paths read from disk at runtime. kabegame runs snapshotless, so the
  loaded path would `read_to_string` the host's cargo-registry paths — nonexistent on a
  cross-compiled Android device (`os error 2`). Because `[patch.crates-io] deno_core` also routes
  `deno_web`/`deno_crypto`/`deno_webidl`'s `extension!` macros through this crate, embedding covers
  all of them. kabegame-core's `deno_core` dependency enables the feature. It must stay **off**
  for the in-tree deno CLI build (`deno task build:deno`): the CLI's `ext/node` lazy sources are
  TypeScript that upstream transpiles during the snapshot build — embedding raw `.ts` bypasses the
  transpile and `node:*` imports die with `SyntaxError: Unexpected identifier` at runtime
  (feature off = upstream `mode=loaded`, verified 2026-07-15).
- `0002-shared-v8-platform-init.patch` — `runtime/setup.rs`: let ordinary runtimes and
  `JsRuntimeForSnapshot` share one process-wide V8 platform init, and decouple the global V8 flags
  from the `snapshot` argument. Device-side baseline snapshot generation must not install
  deterministic flags (`--predictable --random-seed=42`) app-wide merely by winning the one-time
  init race.
- `0003-android-bionic-errno.patch` — `uv_compat/tty.rs`: add a `cfg(target_os = "android")`
  `errno_location()` using Bionic's `__errno()` (glibc uses `__errno_location`); without it the
  Android target hits the platform `compile_error!`.
- `0004-node-modules-suffix-env.patch` — **CLI-only** (patches `cli/` + `ext/fs`/`ext/napi`/
  `ext/process`, NOT `libs/core`): add `DENO_NODE_MODULES_SUFFIX` support. When set (e.g. `-22`),
  every path component exactly equal to `node_modules` is transparently redirected to
  `node_modules{suffix}` at the real-IO boundary — an in-process bind mount, so glibc-specific
  native modules can live in per-environment dirs (`node_modules-22` in the 22.04 VM,
  `node_modules-web` in docker) on a shared source tree without sudo/fstab. Mechanics: a wrapped
  `CliSys` (all sys_traits fs traits, cli/node_modules_suffix.rs), `RealFs`/std_fs rewrite
  (covers Deno.* AND node:fs — vite/rollup/tsc userland resolution), napi `op_napi_open`
  (dlopen of .node natives) and process spawn program/cwd. Two invariants discovered by
  real-workload testing: (1) canonicalize/realpath REVERSE-maps its result back to logical
  paths (a real bind mount never leaks the target name; leaking it corrupts the module graph);
  (2) paths under DENO_DIR are exempt both ways (npm packages legitimately ship dirs literally
  named `node_modules` as data, e.g. `resolve`'s test fixtures). Nested physical dirs get the
  suffix too (`node_modules-22/@vue/compiler-core/node_modules-22/…`) — the suffixed tree MUST
  be produced by `deno install` run with the suffix set (don't copy an unsuffixed tree in).
  Known limits: native subprocesses that walk the fs themselves (esbuild's binary during
  `vite dev` optimizeDeps) and deno_task_shell's PATH lookup of non-registered native bins
  don't see the illusion — neither is used by kabegame build/check flows.

Apply the whole series manually before building against `third/deno`:

```bash
deno task patch deno
```

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

1. `deno task patch deno -r` to restore the clean submodule tree.
2. Bump `third/deno` to the new upstream tag whose `libs/core` matches the `deno_core` version
   the app resolves (check `libs/core/Cargo.toml` `version`).
3. Re-apply each patch with `git apply --check`, repairing context drift.
4. Regenerate the numbered patch files against the new base and update this README.
5. Rebuild the Android `librusty_v8` prebuilt if `v8`/`deno_core` changed (see the mode-plugin
   error message and [cocs/crawler/V8_RUNTIME.md](../../cocs/crawler/V8_RUNTIME.md)).
