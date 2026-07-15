# CEF patches

## Upstream

- Repository: <https://github.com/chromiumembedded/cef.git>
- Vendor base: `0d0eeb61160536e447c79335c1ee963f57eb6d60` (branch `7827`)

## Patches

- `0001-flat-subprocess-path.patch` — honors an explicit browser subprocess path for every child process type, allowing Kabegame to use one flat helper executable on all desktop platforms.

Apply this series manually before running CEF's `patcher.py`:

```bash
deno task patch cef
```

## Re-vendor

1. Run `deno task patch cef -r` to restore the clean vendor tree.
2. Update `third/cef` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
