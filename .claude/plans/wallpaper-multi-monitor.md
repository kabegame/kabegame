# Multi-Monitor Wallpaper Support — Implementation Plan

> Doc language: **English** (per user request). Chat/commit language stays Simplified Chinese per repo convention.
> Scope: add per-display wallpaper + per-display rotation to the **native** backend, one platform at a time.
> Status: **Windows = researched & designed (this doc)**. macOS / GNOME / Plasma / Android = pending.

---

## 0. Goals

- **Per-display image**: assign a different wallpaper to each physical monitor.
- **Per-display rotation** (轮播): each monitor can rotate its own source (gallery / album), mode (random / sequential), and interval — independently.
- **Graceful hotplug**: monitors attach/detach at runtime; assignments must survive and re-apply.
- **Legible selection UI**: the user must be able to tell which on-screen tile maps to which physical monitor, and set each one.
- Keep the existing "single wallpaper for all monitors" behavior as the default; multi-monitor is opt-in.
- Platform-by-platform. This doc lands Windows first.

Two orthogonal capabilities exist and must not be conflated:
1. **Per-display different image** (this plan's focus).
2. **Span one big image across displays** (already partially reachable; secondary).

---

## 1. Platform capability matrix (from prior research)

| Platform | Per-display image | Span | Native mechanism | Per-display **style** |
|----------|:---:|:---:|------|:---:|
| **Windows** 10+ | ✅ | ✅ | `IDesktopWallpaper` COM | ❌ global only |
| **macOS** | ✅ | ❌ (self-tile) | `NSWorkspace` / AppleScript `desktop N` | limited |
| **GNOME** | ❌ hard limit | ✅ | `gsettings picture-options=spanned` | n/a |
| **KDE Plasma** | ✅ | ⚠️ self-tile | per-containment `desktops()` | ✅ per-containment |

---

## 2. Windows

### 2.1 Answers to the specific questions

**Q1 — Does the current approach need administrator privileges?**
**No.** `IDesktopWallpaper` runs in the **per-user** shell context and writes only the current user's desktop state. No elevation, no manifest change. (What *does* need admin is setting a wallpaper for *all users* via Group Policy / `HKLM` — a different mechanism we are **not** using.) The existing `SystemParametersInfoW(SPI_SETDESKWALLPAPER)` fallback is likewise per-user and unelevated.

**Q2 — Is it stable?**
Yes — `IDesktopWallpaper` is the canonical, stable shell API since Windows 8 and unchanged through Win11. Two real caveats to engineer around (see 2.4):
- **COM apartment affinity** — calls must run on a thread that has done `CoInitializeEx`; the rotator lives on tokio worker threads that hop, so COM work must be pinned (dedicated STA thread or `spawn_blocking` with per-call init).
- **Hotplug enumeration** — `GetMonitorDevicePathCount`/`At` include *detached* monitors that still have an assigned image; `GetMonitorRECT` **fails on detached** ones. Must filter attached via `GetMonitorRECT`.

**Q3 — Is there a better approach?**
No. `IDesktopWallpaper` is the only correct modern per-monitor API. Alternatives are strictly worse:
- `SystemParametersInfo(SPI_SETDESKWALLPAPER)` — all-monitors-same-image, no per-monitor concept.
- Writing `HKCU\...\Desktop\TranscodedImageCache*` directly — undocumented internal cache format, brittle.
- `IActiveDesktop` — deprecated since Vista, effectively dead post-Win8.
So the current direction (COM) is right; the change is **stop passing `NULL`** and instead enumerate + target each monitor's device path.

**Q4 — Per-monitor rotation.**
Fully supported: `SetWallpaper(devicePath, newImage)` touches exactly one monitor with the native fade, leaving others untouched. Requires extending `WallpaperRotator` from one global "current image" + one ticker to **per-monitor state** (see 2.6).

**Q5 — Different Windows versions.**
- `IDesktopWallpaper` exists on **Windows 8 / 8.1 / 10 / 11**, uniform behavior.
- kabegame's **real floor is Windows 10**: the CEF/Chromium backend (CEF 7827 ≈ Chromium 140-series) requires Win10+, because Chromium dropped Win7/8/8.1 at **v110 (Feb 2023)**. Therefore the app cannot run anywhere `IDesktopWallpaper` is missing — **per-monitor is always available** on supported targets.
- Practical implication: we do **not** need a down-level per-monitor code path. Keep the `SPI_SETDESKWALLPAPER` path only as an all-monitors fallback for the (theoretical) case where COM instantiation fails.
- Win10 vs Win11: no API difference. Differences are cosmetic (fade animation, Settings UI) and DPI/HDR-related, none of which affect the API contract.

### 2.2 Hard constraint to surface in UX

`IDesktopWallpaper::SetPosition(DESKTOP_WALLPAPER_POSITION)` is **global** — there is **no per-monitor position/style** on Windows. Per-monitor can differ **only in the image**; fill/fit/center/tile/stretch/span is one value shared by all displays. `DWPOS_SPAN` is a global mode that stretches a single image across the whole virtual desktop and is **mutually exclusive** with per-display images. UX must reflect: "style is global; only images are per-monitor."

Position enum (note: different from the registry values the code uses today):
`DWPOS_CENTER=0, DWPOS_TILE=1, DWPOS_STRETCH=2, DWPOS_FIT=3, DWPOS_FILL=4, DWPOS_SPAN=5`.

### 2.3 Current state (现状) — real code

**a. COM setter always targets all monitors** (`native.rs:308`)
```rust
// desktop_wallpaper.SetWallpaper(None, wallpaper_path)  -> None = ALL monitors
desktop_wallpaper
    .SetWallpaper(None, wallpaper_path)              // 现状：写死 None，全屏同图
    .map_err(|e| format!("SetWallpaper failed: {:?}", e))?;
```

**b. Style is set globally via registry** (`native.rs:634`)
```rust
let (style_value, tile_value) = match style {           // 现状：注册表值，全局
    "center" => (0, 0), "tile" => (0, 1), "stretch" => (2, 0),
    "fit" => (6, 0), "fill" => (10, 0), _ => (10, 0),
};
// WallpaperStyle / TileWallpaper under HKCU\Control Panel\Desktop
```

**c. Rotator holds ONE global current image + ONE ticker** (`rotator.rs`)
```rust
pub struct WallpaperRotator {
    current_index: Arc<Mutex<usize>>,   // 现状：单一顺序索引
    // ...一个 Notify、一个 ticker、一个 STATE 机
}
// 选图后：settings.set_current_wallpaper_image_id(Some(id))   // 现状：单值
```

**d. Settings model is a flat SettingKey → SettingValue map** (`settings/mod.rs:76`)
```rust
pub enum SettingKey {
    WallpaperMode, WallpaperRotationAlbumId, WallpaperRotationIntervalMinutes,
    WallpaperRotationMode, WallpaperRotationStyle, CurrentWallpaperImageId, // 现状：全部是单值标量
}
// SettingValue = String | OptionString | U32 | Bool | ...  （无嵌套 map/结构）
```

### 2.4 Implementation points (明确的点)

#### Point 1 — Windows monitor module (`windows_monitors.rs`, new)

- **新增** a self-contained COM helper. All COM lives here; callers never touch COM directly.
  > All functions run their COM work on a pinned thread (see Point 5) — never on a random tokio worker.

```rust
// src-tauri/kabegame/src/wallpaper/manager/windows_monitors.rs (新增)
pub struct MonitorInfo {
    pub device_path: String, // 持久标识（GetMonitorDevicePathAt），作为 settings key
    pub attached: bool,      // GetMonitorRECT 成功 == 在线
    pub rect: Option<(i32, i32, i32, i32)>, // (left, top, right, bottom) 虚拟桌面坐标；UI 排列/分辨率
    pub is_primary: bool,    // rect 含 (0,0) 或 MONITORINFOF_PRIMARY
    pub index: u32,          // 枚举序号（仅展示，勿持久化）
}

/// 枚举所有 monitor（含已断开但有分配的），用 GetMonitorRECT 判定在线。
pub fn enumerate_monitors() -> Result<Vec<MonitorInfo>, String>;

/// 逐屏设置图片：dw.SetWallpaper(device_path, image)。空 device_path -> None（全屏）。
pub fn set_wallpaper_for(device_path: Option<&str>, image_abs_path: &str) -> Result<(), String>;

/// 全局 position（fill/fit/... / span）。Windows 只能全局。
pub fn set_position(pos: DesktopWallpaperPosition) -> Result<(), String>;

/// 批量：拿一个 IDesktopWallpaper 实例，一次 CoInit，循环 set 多屏，减少 COM 往返。
pub fn apply_assignments(pairs: &[(String /*device_path*/, String /*image*/)]) -> Result<(), String>;
```

#### Point 2 — Native manager grows a per-monitor path (`native.rs`)

- **修改** `set_wallpaper_via_com` to delegate to `windows_monitors::set_wallpaper_for` with an optional device path (keep `None` = all).
- **新增** a per-monitor entry the rotator/commands call: `set_wallpaper_for_monitor(device_path, path)`.
- **修改** style handling for per-monitor mode: prefer `IDesktopWallpaper::SetPosition` over the registry write so image + position go through one COM instance consistently. Keep the registry path for the legacy all-monitors mode.
  > Rationale: mixing registry-style with COM-image occasionally needs a desktop refresh; one COM instance avoids it.

#### Point 3 — Per-monitor settings model (`settings/`, migration `v003`)

- **决策点** the flat `SettingValue` has no nested map. Two options (pick in §2.8):
  - **(A, recommended)** add `SettingValue::Json(serde_json::Value)` and one new key `WallpaperMonitorConfig` holding `{ device_path -> MonitorAssignment }`.
  - **(B)** store per-monitor config outside settings (own table / json file under app data), settings keeps only a `wallpaper_per_monitor_enabled: bool`.
- **新增** `WallpaperPerMonitorEnabled: bool` (default false).
- **新增** `MonitorAssignment` shape:
```rust
struct MonitorAssignment {
    source: RotationSource,        // Gallery | Album(id)   —— 复用 rotator 里的枚举
    rotation_enabled: bool,
    rotation_mode: String,         // "random" | "sequential"
    interval_minutes: u32,         // 每屏可不同
    current_image_id: Option<String>, // 取代全局单值在多屏模式下的角色
    // 注：Windows 无 per-monitor style，样式仍是全局，不入此结构
}
```
- **新增** `migrations/v003_wallpaper_per_monitor.rs` seeding defaults; follows the existing `v001`/`v002` pattern.

#### Point 4 — Rotator becomes per-monitor aware (`rotator.rs`)

- **修改** the single-ticker loop into a **single scheduler with per-monitor due-times** (recommended over N threads — reuses the existing one-task lifecycle/state machine):
```rust
struct MonitorRotationState { device_path: String, next_due: Instant, current_id: Option<String>, /* per-monitor cfg snapshot */ }
// loop:
//   next = states.iter().filter(attached).min_by_key(|s| s.next_due)
//   sleep until next.next_due (or wake on Notify for manual/settings change)
//   pick image for that monitor's source/mode -> windows_monitors::set_wallpaper_for(device_path, path)
//   advance next_due += interval; update current_id
```
- **保留** the legacy single-monitor branch when `WallpaperPerMonitorEnabled == false` (current behavior, zero regression).
- **修改** `set_current_wallpaper_image_id` usage: in per-monitor mode, current image is tracked **per assignment**, not globally.
- Image picking reuses existing `load_next_sequential` / `load_random_image_for_wallpaper` (per-monitor source snapshot); no rewrite.

#### Point 5 — COM threading discipline (cross-cutting)

- **新增** a dedicated **STA worker** (single long-lived thread that `CoInitializeEx(APARTMENTTHREADED)` once and serves all wallpaper COM ops via a channel), **or** wrap each op in `tokio::task::spawn_blocking` that inits/uninits COM per call.
  > Recommend the dedicated STA thread: cheaper (no per-call CoInit), serializes ops, matches shell COM expectations. Rotator + commands both post to it.

#### Point 6 — Monitor listing + identify for the UI (see §2.5 for the full data flow)

- **新增** Tauri command `list_wallpaper_monitors() -> Vec<MonitorGeometry>` — maps backend `MonitorInfo` into the platform-neutral `MonitorGeometry` the front-end renders (only `attached` monitors; detached ones stay dormant in settings).
- **新增** Tauri command `identify_monitors()` — briefly shows a large index overlay on each physical screen so the user can match a tile in the layout picker to a real monitor. Implement with borderless always-on-top app windows positioned at each monitor's rect, auto-dismissed after ~1.5s.
- **新增** display-change handling: listen for `WM_DISPLAYCHANGE` (or Tauri's monitor events) → re-enumerate → re-apply assignments for now-attached monitors, keep detached assignments dormant, and emit an event so the settings UI re-fetches `list_wallpaper_monitors`.

#### Point 7 — Fallback

- **保留** `SystemParametersInfoW(SPI_SETDESKWALLPAPER)` strictly as the all-monitors fallback if COM instance creation fails. Never used for per-monitor (it can't).

### 2.5 Front-end: how the UI knows monitor positions

The UX problem: with extended displays, the user must know **which tile in the settings UI maps to which physical monitor** before assigning an image to it. Solution = a scaled **layout map** driven by real geometry, plus an **identify** action to disambiguate.

**Source of position — the virtual-desktop coordinate space.**
Windows composes all monitors into one virtual coordinate space where the **primary monitor's top-left is `(0,0)`**. Extended monitors carry signed offsets that *encode direction*:
- secondary to the **left** → negative `left` (e.g. `-2560`)
- to the **right** → `left = primary width` (e.g. `1920`)
- **above** → negative `top`; below → positive.

So the `RECT` from `GetMonitorRECT(device_path)` (`left/top/right/bottom`) already encodes both position and size — the same coordinate space the Windows "Display settings" arrangement diagram uses.

**Geometry and `device_path` are same-source.** Both come from the one `IDesktopWallpaper` instance, so "where a monitor is" and "the persistent id used to set its wallpaper" are inherently aligned. Do **not** join Tauri's `available_monitors()` against `IDesktopWallpaper` device paths by comparing rects — that cross-API match is fragile. One backend command emits both.

**Platform-neutral payload the front-end consumes:**
```ts
interface MonitorGeometry {
  device_path: string;   // persistent id — used for both the settings map key and SetWallpaper
  x: number; y: number;  // virtual-desktop coords (signed → encodes direction)
  width: number; height: number;
  is_primary: boolean;   // the rect containing (0,0)
  attached: boolean;     // GetMonitorRECT succeeded
  label?: string;        // optional friendly name (post-MVP)
}
```

**Rendering the layout map (front-end):**
1. Compute the bounding box over attached monitors (`min left/top`, `max right/bottom`).
2. Translate so `(minLeft, minTop)` becomes the origin (removes negative coords).
3. Scale uniformly into the UI container; place each monitor as an absolutely-positioned tile.

Relative position and relative size then faithfully mirror the physical arrangement. A **portrait / rotated** monitor has `width < height` and naturally draws as a tall tile — no special-casing. The **primary** monitor is the tile whose rect contains `(0,0)` (or `MONITORINFOF_PRIMARY`); badge it. Clicking a tile selects that `device_path` and opens its per-monitor image / album / rotation panel. (Mockup shown in chat.)

**Disambiguation — identify overlay.**
A layout map alone can't tell the user whether "tile 2" is the left or right physical screen (worst with two identical models). Mirror the OS "Identify" button: `identify_monitors()` flashes a large number on each physical screen matching the tile's index (Point 6).

**Details / caveats:**
- **Mixed DPI**: with per-monitor scaling, `GetMonitorRECT` still returns virtual coords, so the map's *relative* layout stays correct; absolute pixels may differ slightly from the OS diagram — irrelevant for "pick which screen".
- **Online filtering**: the map only draws monitors where `GetMonitorRECT` succeeds; detached monitors are omitted but their assignment persists by `device_path` and reappears on reconnect.
- **Cross-platform**: `MonitorGeometry` is deliberately platform-neutral — macOS fills it from `NSScreen.frame`, Plasma from `screenGeometry` — so the layout-map + identify front-end is written once and reused on all three desktops.
- **Friendly names**: vendor/model names need `QueryDisplayConfig` target names on Windows; defer to a later iteration (MVP label = index + resolution). See §2.8 decision.

### 2.6 Risks / open questions (Windows)

- **Style is global** — confirm UX accepts "per-image, shared style." (§2.2)
- **Per-monitor different interval** — do we need it, or is one global interval with per-monitor source enough? Affects scheduler complexity (Point 4).
- **Detached-monitor policy** — keep dormant assignment (Windows default) vs. drop it. Recommend keep.
- **Video/dynamic wallpaper** is **out of scope** for native per-monitor: `IDesktopWallpaper` is static-image only. Per-monitor video belongs to the `window` backend (one WorkerW child per monitor) — a separate, larger effort.
- **Settings shape** decision (A vs B in Point 3) blocks migration authoring.

### 2.7 Verification plan (真机, per debug-empirically rule)

1. Enumerate: log `enumerate_monitors()` on a 2-monitor rig; unplug one → confirm count still includes it but `attached=false`.
2. Set distinct images on 2 monitors; confirm independent, with native fade, no elevation prompt.
3. Toggle global position (fill/span) and confirm span disables per-monitor images.
4. Rotate: per-monitor intervals fire independently; unplug/replug mid-rotation → assignment re-applies.
5. Layout map: verify tiles' relative position/size match the physical arrangement (incl. a portrait/rotated and a left-of-primary negative-coord monitor); `identify_monitors()` flashes the matching index on the right physical screen.
6. Falsification criterion (write before running): if `SetWallpaper(devicePath, …)` ever changes a *different* monitor, or if `GetMonitorRECT` succeeds on a detached monitor, the enumeration/coordinate model is wrong — stop and re-measure.

### 2.8 Decisions needed before coding

1. Per-monitor **interval**: independent per monitor, or one global interval?
2. Settings storage: **(A)** `SettingValue::Json` + one key, or **(B)** separate store?
3. Detached monitor: keep dormant assignment (recommended) or drop?
4. Friendly monitor names via `QueryDisplayConfig` in MVP, or defer (index + resolution only)?

---

## 3. macOS — pending

`NSWorkspace.setDesktopImageURL(_:for:options:)` per `NSScreen`, or AppleScript `tell desktop N`. No native span (self-tile). Per-Space caveat. Geometry for the layout map comes from `NSScreen.frame` → fills the same `MonitorGeometry`. To be researched next.

## 4. Linux GNOME — pending

No per-monitor (hard GNOME limit). Only `picture-options=spanned`. Per-display requires app-side compositing into one big image (HydraPaper approach).

## 5. Linux KDE Plasma — pending

Per-containment via existing `desktops()` script; loop already present, just needs per-`d.screen` dispatch. `d.screen` index is volatile — persistence anchor TBD. Geometry via `screenGeometry` → `MonitorGeometry`.

## 6. Android — N/A

Single wallpaper surface; no multi-display wallpaper concept in scope.

---

## 7. Next step

Continue platform-by-platform research (macOS next), then converge on the shared front-end model already sketched here (`MonitorGeometry` layout map + identify) plus a per-backend capability flag (`supports_per_monitor()` on `WallpaperManager`) so the UI enables/disables the feature per platform.
</parameter>
</invoke>
