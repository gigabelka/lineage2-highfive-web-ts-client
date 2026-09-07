# Decode worker pool, protocol, and sector streaming

## `DecodeWorkerClient` — the main-thread handle

[src/assets/decode-worker/decode-worker-client.ts](../src/assets/decode-worker/decode-worker-client.ts)
is a main-thread handle to a **pool of N workers** (`loadSettings.decodeWorkerPoolSize`,
default `3`).

- **`poolSize: 0`** runs a single `DecodeEngine` in-process (dynamic import) so a decode can
  be stepped through in normal devtools. A dev knob; `isDead` is never true on this path.
- **Sticky per-sector routing.** `sectorWorker: Map<sectorName, workerIndex>`. `pickWorker`
  prefers the sticky worker *only if it is idle* (its shared dependency packages are likely
  still warm), otherwise the least-loaded live slot. The sticky entry is **kept** after a
  free, so a re-decode still prefers that worker.
- **Back-pressure.** Decoded binaries land on `binaryDecodeQueue` and
  `processBinaryDecodeQueue` drains them **one at a time** (`isDecodingBinary` guard) so
  several sectors arriving together do not jank the frame. Each is run through
  `deserializeLibraryAsync` (itself time-sliced) and `refreshSoundBlobUris`, then the
  pending request is resolved with `Object.setPrototypeOf(library, DecodeLibrary.prototype)`.
- **Failure handling.** `onWorkerDead(i, err)` marks the slot dead, rejects that slot's
  still-pending requests, and `terminate()`s it. `isDead` is true only when **every** slot
  is dead. `freeSector(name)` is routed (fire-and-forget) to `sectorWorker.get(name)` — the
  exact worker that decoded it.

The pool exists so that a stale in-flight decode for a sector the camera already left cannot
head-of-line-block a newly urgent sector.

## Message protocol

[src/assets/decode-worker/decode-protocol.ts](../src/assets/decode-worker/decode-protocol.ts)
defines two type unions and no logic.

| Main → worker | Worker → main | Notes |
| --- | --- | --- |
| `init` | `ready` / `initError` | build `AssetLoader`, pin native/core/engine packages |
| `decode` (sectorName, settings) | `decoded` (requestId, **buffer**) / `decodeError` | `buffer` is transferred zero-copy in the transfer list |
| `precache` (sectorName, settings) | `precached` ({cached, bytes}) | used by `?precacheSectors` |
| `free` (sectorName) | — | fire-and-forget; releases that worker's package refcounts |
| `decodeEnv` | `envDecoded` (info) | `env.int` + `l2_skies`; transfer list from `collectTransferables` |
| `musicInfo` | `musicInfoDecoded` (rows) | reads `musicinfo.dat`; music files are **not** UE2 packages |

The worker's `onmessage` is a promise chain, so messages are processed strictly in order.

## `AssetManager` — main-thread sector streaming

[src/assets/asset-manager.ts](../src/assets/asset-manager.ts) streams the world in and out
around the camera. It runs once per frame from `RenderManager._preRender`
(`assetManager.tick(this)`), guarded by an `isTicking` re-entrancy flag. It only ever sees
plain decoded data.

### Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `SECTOR_WORLD_SIZE` | `256 * 128` = `32768` | one sector's world extent per axis |
| `renderDistance` | `SECTOR_WORLD_SIZE / 2` | load radius |
| `unloadDistance` | `SECTOR_WORLD_SIZE` | retire radius |
| `FAILED_SECTOR_RETRY_MS` | `30_000` | cooldown before retrying a failed decode |
| `RETIRED_SECTOR_DISPOSE_MS` | `30_000` | grace period a retired sector stays reusable |
| `SECTOR_PREFETCH_LOOKAHEAD_MS` | `1500` | how far ahead the velocity projection looks |
| `SECTOR_PREFETCH_MAX_DISTANCE` | `SECTOR_WORLD_SIZE` | clamp on the projected offset |
| `STATIC_MESH_BUILD_FRAME_MS` | `2` | per-frame budget for the deferred static-mesh build |

### Hysteresis

A sector is **loaded** when within `renderDistance` and **retired** when past
`unloadDistance`. The gap between the two radii (a factor of 2) is the hysteresis band that
stops a camera hovering on a boundary from thrashing load/unload. `sectorDistance` is the
distance from the camera to the sector's AABB (0 when inside); the grid mapping offsets X by
`-20` and Y by `-18` (matching `RenderManager.getSectorId`).

### Velocity-lookahead prefetch

Each tick samples the camera position. If the previous sample was `0 < Δt < 250 ms`, a
movement vector `(pos - lastPos)` with Z zeroed is scaled by
`SECTOR_PREFETCH_LOOKAHEAD_MS / Δt` and clamped to `SECTOR_PREFETCH_MAX_DISTANCE`, giving a
projected position ~1.5 s ahead. Candidate sectors in a ring around both the current and the
projected cell are sorted by projected distance, then real distance — nearest-to-lookahead
first, with the camera's own cell forced to the front. Recomputed every tick, so a direction
change re-prioritizes the next free worker immediately. While the camera is moving,
background (non-origin) sectors are capped at `maxConcurrentDecodes - 1` so a worker is
always reserved for the origin sector.

### Deferred, time-sliced static-mesh build

On decode completion only `decodeSectorCore(library)` runs (geometry + materials on screen),
the sector is added, and particle warmup is gated. The `{ sector, library }` goes onto
`pendingStaticMeshBuilds`. `processPendingBuilds` runs once per tick: it picks the nearest
pending sector, lazily creates a decode job, and loops `stepSectorStaticMeshDecodeJob` until
the job completes **or** `performance.now()` passes `now + STATIC_MESH_BUILD_FRAME_MS`
(2 ms). On completion it splices the job out and calls
`RenderManager.attachStaticMeshGroup(sector)` (which also un-gates particle warmup).

### Retirement, reuse, disposal

- `retireSector` — `RenderManager.removeSector` (hidden, **not** disposed), recorded in
  `retiredSectors` with a timestamp. Worker package refcounts are **not** released yet.
- If the sector is wanted again within `RETIRED_SECTOR_DISPOSE_MS`, `requestSector` pulls it
  straight back out of `retiredSectors` and re-adds the retained object — no worker
  round-trip, no re-decode.
- `destroyExpiredSectors` (every tick) — retired sectors past 30 s get
  `RenderManager.disposeSector` (real three.js disposal) and `decodeWorker.freeSector(id)`
  (releases that worker's refcounts; packages that hit 0 get `pkg.free()`).
- Failed decodes go into `failedSectors` with a retry timestamp; `requestSector` skips ids
  whose retry time is in the future.

### `setAlwaysLoaded` / `neverUnload`

`setAlwaysLoaded(renderManager, sectorName)` decodes a sector once, marks
`sector.neverUnload = true`, and adds it. The retire loop skips such sectors. Used for the
sky level.
