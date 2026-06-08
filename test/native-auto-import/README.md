# Native Auto Import Probe

Small Rust probe for validating native local-media indexing strategies before wiring them into Kabegame.

Current backends:

- macOS: `mdfind` / Spotlight command line
- macOS: `NSMetadataQuery` / Foundation API

## Usage

```bash
cd test/native-auto-import
cargo run -- --scope ~/Pictures --once
cargo run -- --backend nsmetadata --scope ~/Pictures --once
cargo run -- --scope ~/Pictures --poll 5 --stable 3
cargo run -- --backend nsmetadata --scope ~/Pictures --stable 3
```

Useful flags:

- `--backend <name>`: native backend. Values: `auto`, `mdfind`, `nsmetadata`. Default: `auto`.
- `--scope <dir>`: directory searched through the native indexer. Can be repeated.
- `--once`: run one scan and print stable candidates.
- `--poll <seconds>`: poll interval for polling watch backends. Ignored by `nsmetadata`. Default: `5`.
- `--stable <seconds>`: only emit files whose mtime is at least this old. Default: `3`.
- `--nsmetadata-timeout <seconds>`: maximum time to wait for `NSMetadataQuery` initial gathering. Default: `10`.
- `--include-videos`: include `public.movie` in addition to `public.image`.
- `--emit-initial`: in watch mode, emit candidates from the first scan instead of only warming the cache.
- `--limit <n>`: limit printed candidates per scan.
- `--json`: print newline-delimited JSON events.
- `--print-query`: print the native index query before scanning.

Watch mode intentionally does not import files. It prints the candidate stream that Kabegame would send into the existing local import/postprocess path.

`nsmetadata` watch mode is event-driven: it keeps one `NSMetadataQuery` alive and reacts to Foundation update notifications instead of rerunning a query on `--poll`. Startup still performs non-emitting warmup scans; live updates use the notification `userInfo` added/changed/removed items.
