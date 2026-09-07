# Architecture overview

## The two-graph model

The app is split into **two logically separate module graphs**, expressed through Vite as two
build sub-graphs:

| Graph | Root | Target | Owns |
| --- | --- | --- | --- |
| **Client / renderer** | [src/index.ts](../src/index.ts) | `web` | three.js, materials, cameras, DOM, `lil-gui`, physics, audio, sector streaming orchestration. |
| **Decode worker** | [src/assets/decode-worker/decode.worker.ts](../src/assets/decode-worker/decode.worker.ts) | worker | The *entire* UE2 asset pipeline: package deserialization, decode-info generation, static-mesh batching, DXT→RGBA conversion, the decoded-library binary (de)serializer. |

The worker is spawned from
[src/assets/decode-worker/decode-worker-client.ts](../src/assets/decode-worker/decode-worker-client.ts):

```ts
new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module", name: "sector-decode" })
```

### Why the split is strict

- **Per-worker package refcounts.** Loaded UE2 packages are reference-counted *inside each
  worker instance*, keyed by package path. The count is never shared across the pool.
  Therefore every sector sticks to the one worker that decoded it, and `freeSector` must be
  routed back to that same worker.
- **Bundle hygiene.** UE2 parsing (`src/assets/unreal/**`) is large and irrelevant to the
  renderer. Keeping it unreachable from the client graph keeps the renderer bundle lean and
  makes the contract between the two sides explicit.

### Which directory belongs to which side

| Path | Side | Notes |
| --- | --- | --- |
| `src/index.ts`, `src/core.ts`, `src/sector-precache.ts`, `src/sector-test.ts` | client | entry / mode select |
| `src/rendering/**`, `src/materials/**`, `src/objects/**` | client | three.js, DOM |
| `src/base-actor.ts`, `src/player.ts`, `src/utils/**` | client | |
| `src/assets/asset-manager.ts` | client | main-thread sector streaming; only ever sees plain decoded data |
| `src/assets/asset-handle.ts` | client | OPFS raw-file fetch helper |
| `src/assets/decoders/object3d-decoder.ts`, `material-decoder.ts`, `texture-decoder.ts`, `object-batching.ts`, `env-decoder.ts`, `env-colors-decoder.ts` | client | translate plain decode-info → three.js objects on the main thread |
| `src/assets/decoders/dxt-decode.ts`, `batch-data.ts` | **worker** | deliberately three.js-free (math only) so the worker can run them before transfer |
| `src/assets/dds/**` | **worker** | DDS container handling, no three.js/DOM |
| `src/assets/asset-loader.ts` | **worker** | extends `@l2js/core` `AAssetLoader`; owned by `DecodeEngine` |
| `src/assets/unreal/**` | **worker** | the whole UE2 class layer, incl. `decode-library.ts` (the client may hold its *type* but not the parsing code) |
| `src/assets/decode-worker/**` | **worker** | except `decode-worker-client.ts`, which runs on the main thread and is the *only* client file that names `decode.worker.ts` |

Rule of thumb: **anything touching `src/assets/unreal/**` or the DXT/batch decoders is
worker-side.**

## Entry points and mode selection

[src/index.ts](../src/index.ts) is the only script `index.html` loads. It forks twice:

```
index.ts
 ├─ ?sectorTest present ──────────────► runSectorTest()      src/sector-test.ts   (full-map sweep harness)
 └─ else startCore()  src/core.ts
      ├─ ?precacheSectors present ────► runSectorPrecache()  src/sector-precache.ts (warm the OPFS decode cache, no render)
      └─ else ─────────────────────────► normal app: AssetManager + RenderManager + render loop
```

- [src/core.ts](../src/core.ts) — `startCore()`. Initializes the Rapier physics wasm,
  requests persistent storage, then builds one large `loadSettings` object
  (`GD.LoadSettings_T`) that every mode passes down. `loadSettings` contains big
  commented-out blocks of specific actor IDs (`_loadStaticModelList`, `_loadEmitterList`)
  used to isolate a single asset while debugging a rendering bug — expect to edit those.
- [src/sector-precache.ts](../src/sector-precache.ts) — `?precacheSectors`. Renders a
  progress UI, walks every `maps/NN_MM.unr` sector, decodes each through a **single-worker**
  `DecodeWorkerClient(1)` to populate the OPFS decoded-library cache. No three.js.
- [src/sector-test.ts](../src/sector-test.ts) — `?sectorTest`. Decodes every sector,
  instantiates it, renders + simulates a few frames in an offscreen `WebGLRenderer`, probes
  luminance / terrain color, and POSTs one JSONL row per sector. See [testing.md](testing.md).

All three modes read `/asset-list.json` (auto-generated, see
[build-and-tooling.md](build-and-tooling.md#runtime-requirements)) and go through
`DecodeWorkerClient`.

## End-to-end: how one sector reaches the screen

```
 .unr on disk (c:/Games/HighFive/maps/20_21.unr)
     │  Vite devServerPlugin: byte-range static serve under /assets
     ▼
 HTTP GET /assets/maps/20_21.unr  (Range requests)
     │  asset-handle.ts: fetchCached → mirror into OPFS root, navigator.locks per path
     ▼
 OPFS raw package mirror  (avoids re-downloading shared packages)
     │  WORKER: AssetLoader.using(getPackage(sector,"Level"))
     │          → @l2js/core decodes header + walks the transitive import closure,
     │            incrementing a per-worker refcount for every dependency package
     ▼
 live UPackage graph (UStaticMesh, UTexture, ATerrainInfo, UEmitter, …)
     │  WORKER: buildDecodeLibrary → DecodeLibraryBuilder.pullLevel
     │          (pullModel = BSP zones/geometry, pullActors = switch on friendlyName)
     ▼
 DecodeLibrary  — a plain-data DTO (no functions, no live UObjects), typed by GD.* in index.d.ts
     │  WORKER: buildStaticMeshBatchData  (merge shared-material sections → batch manifest)
     │  WORKER: prepareLibraryForTransfer (sanitize in place, collect ArrayBuffers)
     │  WORKER: serializeLibrary → binary blob (magic "L2DC"); stored to OPFS decode cache
     │  WORKER: if RGBA mode, convertDDSMaterialsToRGBA, re-serialize
     ▼
 postMessage({type:"decoded", buffer}, [buffer])   ← zero-copy transfer
     │  MAIN: DecodeWorkerClient.processBinaryDecodeQueue (one at a time, back-pressure)
     │  MAIN: deserializeLibraryAsync (time-sliced, 2 ms frames)
     │  MAIN: refreshSoundBlobUris (re-mint session blob: URLs)
     ▼
 DecodeLibrary on the main thread
     │  MAIN: decodeSectorCore(library)  → three.js geometry + materials  (static meshes deferred)
     │  MAIN: RenderManager.addSector(sector) — sector is on screen now
     │  MAIN: push {sector, library} onto AssetManager.pendingStaticMeshBuilds
     │  MAIN: processPendingBuilds — stepSectorStaticMeshDecodeJob in ≤2 ms slices per frame
     │  MAIN: RenderManager.attachStaticMeshGroup(sector) — materials/lighting stream in progressively
     ▼
 fully built sector in the scene
```

Key idea: **the main thread never parses UE2.** It receives a `DecodeLibrary` of plain
arrays/objects and instantiates three.js objects from it. The `DecodeLibrary` shape is the
contract boundary and is typed under the `GD.*` namespace in [../index.d.ts](../index.d.ts).

## OPFS: three distinct uses

The Origin Private File System is used for three unrelated things:

| Use | Where | Key / location | Purpose |
| --- | --- | --- | --- |
| Raw package mirror | [asset-handle.ts](../src/assets/asset-handle.ts) `fetchCached` | mirrors `/assets/<path>` into the OPFS root; `navigator.locks` `asset-cache:<path>` | avoid re-downloading `.unr/.utx/...` over HTTP; sync-access read path also locked because sync handles are origin-exclusive and packages are read by multiple workers |
| Decoded-library cache | [decode-cache.ts](../src/assets/decode-worker/decode-cache.ts) | `decode-cache/<sector>.v<cache.version>.<settingsHash>.bin` | skip deserialization + decode-info + batch merge on warm hits; TTL 7 days |
| Cache sweep | [decode-cache.ts](../src/assets/decode-worker/decode-cache.ts) `sweepDecodeCache` | — | runs once per engine on first decode; deletes wrong-version and stale entries |

`loadSettings.cache.version` (in [src/core.ts](../src/core.ts), currently `7`) must be bumped
whenever decode logic changes — it invalidates every cached sector.
