# Asset pipeline (worker-side)

Everything in this document runs **inside the decode worker** (or in-process when
`decodeWorkerPoolSize` is `0`). None of it may be reachable from the client bundle. For the
worker pool and the message protocol see [decode-worker.md](decode-worker.md).

## `@l2js/core` and the shell / mixin pattern

`@l2js/core` is **vendored** into the repo at `vendor/l2js-core/` (raw TypeScript source,
upstream `realratchet/l2js-core`) — not an npm/SSH dependency, so `npm install` needs no GitHub
access. The alias `@l2js/core` points at `vendor/l2js-core/src`, and Vite's
`optimizeDeps.exclude` keeps it out of dependency pre-bundling. Its one hand-authored
CommonJS file (`src/supported-extensions.js` upstream) was rewritten to plain ESM/TS **once, in
place**, when it was vendored, so the old CJS-shim plugin that used to do this on the fly at
build time is gone. Because it is type-checked as source, `tsc` emits ~30 errors from inside it
that are unrelated to this project — the [tools/typecheck.ts](../tools/typecheck.ts) wrapper
suppresses them. Its runtime dep `gmp-wasm` (RSA decrypt) is likewise vendored at
`vendor/gmp-wasm/` (prebuilt ESM bundle, WASM embedded as base64) — edit `vendor/l2js-core/**`
in place when core needs changes; there is no separate upstream checkout.

`@l2js/core` provides:

- `AAssetLoader` — abstract package registry + import-closure loader.
- `APackage extends UEncodedFile` and `ANativePackage extends APackage` — abstract. They
  decode the encrypted container header and the package header (signature `0x9E2A83C1`,
  name / import / export tables), but `readArrayBuffer()`, `toBuffer()`, and concrete class
  construction are left abstract.
- The primitive `UObject` class tree, `BufferValue` readers, property-tag decoding, the
  `FArray` family, the crypto (`decryptModulo` for old packages, RSA for `4xx` packages).

### Shells vs implementations

At runtime a package registered by core is a **constructor shell** — the methods that
actually read bytes or build UE2 objects do not exist until the worker imports the mixin hub.
The client graph can safely hold the *type* `C.APackage` / `UEncodedFile` without pulling any
UE2 code.

The injection point is [src/assets/asset-loader.ts](../src/assets/asset-loader.ts)
`AssetLoader.Instantiate`, which does `await import("@unreal/un-package")` and passes the
module (`{ UPackage, UCorePackage, UEnginePackage, UNativePackage }`) into
`new AssetLoader().init(assetList, Library)`.

[src/assets/unreal/un-package.ts](../src/assets/unreal/un-package.ts) is the **mixin hub**
(~1000 lines):

- Its first line is `import "./un-object-mixin"` — a side-effect patch of core's
  `UObject.prototype`/statics: adds the `uuid` getter, a tolerant `loadProperty` (skips
  unknown Chronicle-4 property tags instead of aborting the decode), `dumpLayout`, and an
  `onClassCreated` hook that installs `make()`/`class()` statics.
- `class UPackage extends APackage` — implements `readArrayBuffer()` via
  `fetchAssetHandle(this.path)` and `free()` (nulls decoded state for GC).
- `class UCorePackage extends UPackage` — carries ~60 ripped-from-memory client global
  constants (`NEAR_CLIPPING_PLANE`, screen size, colour-ramp values, …).
- `class UEnginePackage extends UPackage` — injects synthetic Native class dependencies
  (`Font`, `Sound`, `Primitive`, `Model`, `Mesh`, `StaticMesh`, `TerrainSector`, …).
- `class UNativePackage extends ANativePackage` — the big dispatch tables:
  `getStructConstructor(name)` → `F*` math/struct ports; `getNonNativeConstructor(name)` →
  the class-name → `@unreal` class map (`Level` → `ULevel`, `StaticMesh` → `UStaticMesh`,
  `Texture` → `UTexture`, `Emitter` → `UEmitter`, `Shader`/`Combiner`/`FinalBlend`/... →
  `UnMaterials.*`, and so on). Unmodeled classes fall back to a generic `UObject`; genuinely
  unknown names throw.

## `AssetLoader` — package registry and per-worker refcounting

[src/assets/asset-loader.ts](../src/assets/asset-loader.ts) extends `AAssetLoader`.

- `Instantiate(assetList)` — registers one package per entry in
  `html/asset-list.json`; `createPackage` points each at `/assets/<downloadPath>`.
- `using(pkg, { neverUnload? })` — `await this.load(pkg)` (core decodes `pkg` and
  BFS-walks its import table, decoding every dependency), then for every path in
  `getDependencies(pkg)` adds a weight: `Infinity` when `neverUnload`, else `1`.
- `getDependencies(pkg)` — iterative DFS over `pkg.imports` (skipping
  `className === "Package"`), resolving each import to its root package, collecting
  `p.path` for `pkg` and every transitive dependency.
- `free(pkg)` — decrements each dependency path by 1 (floored at 0). Any package whose count
  transitions `>0 → 0` gets `pkg.free()`, which nulls `buffer`/`exports`/`imports`/
  `nameTable`/`header` so it can be GC'd (a later `load` re-reads from OPFS).

**Counts are per worker instance and never shared across the pool.** This is why sector →
worker routing is sticky and `freeSector` must reach the worker that decoded that sector.

At init the worker pins the framework packages with `neverUnload`:
`using(getNativePackage())`, `using(getCorePackage())`, `using(getEnginePackage())`, then
`pkgCore.loadNativeClasses()`.

## `DecodeEngine`

[src/assets/decode-worker/decode-engine.ts](../src/assets/decode-worker/decode-engine.ts)
owns one `AssetLoader` and runs the full decode. It is used identically by the worker and by
the in-process (`poolSize: 0`) path.

| Method | Returns | Used by |
| --- | --- | --- |
| `initialize()` | — | worker `init` message |
| `decodeSector(name, settings)` | a `DecodeLibrary` object | in-process path |
| `decodeSectorBinary(name, settings)` | a serialized `ArrayBuffer` | the worker (transferred zero-copy) |
| `precacheSector(name, settings)` | `{ cached, bytes }` | `?precacheSectors` |
| `freeSector(name)` | — | `free` message |
| `decodeEnvConfig()` | env decode-info | `decodeEnv` message |
| `decodeMusicInfo()` | music table | `musicInfo` message |

The first decode ever also runs `sweepDecodeCache(settings)` once.

Decode of a cache **miss**:

1. `pkg = await assetLoader.using(assetLoader.getPackage(sectorName, "Level"))`.
2. `library = buildDecodeLibrary(pkg, sectorName, settings)` — see below.
3. `buildStaticMeshBatchData(library)` — merges sections that share a material into
   `library.geometries` + a `library.staticMeshBatches` manifest, rewrites
   `library.leafActors`.
4. `prepareLibraryForTransfer(library, collectPackageBuffers())` — sanitize in place;
   package buffers are cloned, not transferred (so they are not detached from the loader).
5. If cacheable (`!settings.isSkyLevel`): `serializeLibrary(library)` → write to OPFS.
6. If RGBA texture mode: `convertDDSMaterialsToRGBA(library)`, re-serialize.

Decode of a cache **hit**: `loadCachedLibraryBuffer` returns the stored blob (DDS-format
textures). RGBA mode deserializes, runs `convertDDSMaterialsToRGBA`, re-serializes;
compressed mode returns the blob as-is.

`decode.worker.ts` processes incoming messages **strictly in order** (a promise chain), so an
`init` always finishes before any `decode`.

## `buildDecodeLibrary` / `DecodeLibraryBuilder`

[src/assets/decode-worker/build-decode-library.ts](../src/assets/decode-worker/build-decode-library.ts)
fetches the `Level` export and calls
[DecodeLibraryBuilder](../src/assets/unreal/decode-library-builder.ts) `.pullLevel(uLevel, name)`:

- `pullModel` — BSP model: zones, nodes, sections, lightmaps, geometry buffers.
- `pullActors` — iterates level actors, `switch (actor.constructor.friendlyName)`:
  `TerrainInfo`, `NSun` / `NMoon`, `SkyZoneInfo`, `L2FogInfo`, `Emitter`, `Pawn`,
  `StaticMeshActor` / `Mover` / `MovableStaticMeshActor`, `Light` / `NMovableSunLight`,
  `MusicVolume`, `AmbientSoundObject`. Each actor's `getDecodeInfo(builder)` copies plain
  data (geometry, material descriptors, transforms, leaf/zone masks, sound blobs) into the
  library. `settings.load*` flags gate each category.

The result — [`DecodeLibrary`](../src/assets/unreal/decode-library.ts) — is a plain-data
container: BSP nodes/sections/zones, geometries, materials, `leafActors`,
`staticMeshBatches`, lights, emitters, terrain, sounds. No functions, no live `UObject`s.

## Transfer path: sanitize, serialize, deserialize

- [collect-transferables.ts](../src/assets/decode-worker/collect-transferables.ts)
  `prepareLibraryForTransfer(root, exclude?)` — walks the library, drops functions /
  Promises / live `UObject`s, normalizes `FArray` subclasses to plain arrays (with
  path-tagged `console.warn`s), and returns the transfer list of every reachable
  `ArrayBuffer`. Buffers in `exclude` (the loaded package buffers) are cloned instead of
  transferred so they are not detached from the worker's loader.
- [library-serializer.ts](../src/assets/decode-worker/library-serializer.ts) — a custom
  binary (de)serializer. Magic `0x4C324443` (`"L2DC"`), format version `1`. Handles plain
  objects / arrays / `Map` / `Set` / `ArrayBuffer` / typed arrays / bigints, with back-refs
  for aliasing and cycles. `deserializeLibraryAsync` time-slices deserialization
  (`DECODE_FRAME_MS = 2`, `MessageChannel` yields) so a big library does not jank the frame.

## `decode-cache.ts`

[src/assets/decode-worker/decode-cache.ts](../src/assets/decode-worker/decode-cache.ts)
caches fully-decoded, sanitized libraries in OPFS.

- File name: `decode-cache/<sector>.v<cache.version>.<settingsHash>.bin`.
- `settingsHash` is a djb2 hash of `loadSettings` with `cache`, `textures`, `rgbaTextures`,
  and `decodeWorkerPoolSize` deliberately **stripped** — those do not change the decoded
  geometry, only how textures are delivered.
- TTL `CACHE_TTL_DAYS = 7`.
- Stores **DDS-format** textures (4–8× smaller than RGBA); the worker re-runs
  `convertDDSMaterialsToRGBA` after a hit when RGBA mode is active.
- `refreshSoundBlobUris(library)` re-mints session-scoped `blob:` URLs from the raw bytes in
  `library.soundBlobCache`, because `blob:` URLs do not survive a page reload.
- Disabled with `settings.cache.enabled === false`.
- `sweepDecodeCache` deletes wrong-version and past-TTL entries; runs once per engine.

## Supported UE2 asset types

Non-vanilla-purist: skipping non-critical data hiding in the binaries is acceptable and
expected. The ports below live under `src/assets/unreal/`.

| Group | Classes (representative) | Files |
| --- | --- | --- |
| Static meshes | `UStaticMesh`, `UStaticMeshInstance`, sections / UV streams / vertex streams / triangles / collision | `static-mesh/un-static-mesh*.ts` |
| Skeletal meshes | `USkeletalMesh`, `UMeshAnimation`, `USkeletalMeshInstance` | `skeletal-mesh/*.ts` |
| Mesh base classes | `UPrimitive`, `UMesh`, `UMeshInstance`, `ULodMesh` | `un-primitive.ts`, `un-mesh*.ts`, `un-lod-mesh.ts` |
| BSP / level model | `UModel`, `UPolys`, `FBSPNode`, `FBSPSurf`, `FBSPSection`, `FVert`, lightmap index, multi-lightmap texture | `model/*.ts`, `bsp/*.ts` |
| Terrain | `ATerrainInfo`, `UTerrainSector`, `UTerrainPrimitive`, `UTerrainLayer`, `UDecoLayer`, `FTIntMap` | `un-terrain-*.ts`, `un-deco-layer.ts`, `un-tint-map.ts` |
| Textures / materials | `UTexture`, `UCubemap`, `UWetTexture`, `UShader`, `UCombiner`, `UFinalBlend`, `UTexEnvMap`, `UTexPanner`/`UTexRotator`/`UTexOscillator`, `UColorModifier`, `UFadeColor`, `UVertexColor`, `UStaticMeshMaterial`, palette, mipmap, pixel formats | `un-texture.ts`, `un-material.ts`, `un-cubemap.ts`, `un-wet-texture.ts`, `un-palette.ts`, `un-mipmap.ts`, `un-tex-format.ts` |
| Actors / world | `UAActor`, `AInfo`, `UBrush`, `ULevel`/`ULevelBase`, `ULevelInfo`, `ULevelSummary`, `UStaticMeshActor`, `UMovableStaticMeshActor`, `UMover` | `un-aactor.ts`, `un-info.ts`, `un-brush.ts`, `un-level*.ts`, `static-mesh/un-*-actor.ts`, `un-mover.ts` |
| Volumes / zones | `UPhysicsVolume`, `UBlockingVolume`, `UMusicVolume`, `UConvexVolume`, `FZoneInfo`, `USkyZoneInfo`, `FZoneProperties` | `un-*-volume.ts`, `un-zone-info.ts`, `un-sky-zone-info.ts`, `un-zone-properties.ts` |
| Pawns / spawn | `UPawn`, `UPlayerStart`, `UCamera` | `un-pawn.ts`, `un-player-start.ts`, `un-camera.ts` |
| Lights / celestial / env | `ULight`, `UNMovableSunLight`, `UNCelestial`, `UNSun`, `UNMoon`, `UL2NTimeLight`, `UL2NEnvLight`, `UL2FogInfo`, env time-color structs | `un-light.ts`, `un-movable-sunlight.ts`, `un-ncelestial.ts`, `un-nsun.ts`, `un-nmoon.ts`, `un-l2env.ts`, `un-fog-info.ts` |
| Audio | `USound`, `UAmbientSoundObject` | `un-sound.ts`, `un-ambient-sound.ts` |
| Emitters / particles | `UEmitter`, `UParticleEmitter`, `USpriteEmitter`, `UMeshEmitter`, `UBeamEmitter`, particle scale/sound/beam structs | `un-emitter.ts`, `emitters/*.ts` |
| Math / support structs | `FVector`, `FRotator`, `FQuaternion`, `FMatrix`, `FCoords`, `FPlane`, `FBox`, `FScale`, `FColor`, `FRange`, `GMath` | `un-vector.ts`, `un-rotator.ts`, `un-quaternion.ts`, `un-matrix.ts`, `un-coords.ts`, `un-plane.ts`, `un-box.ts`, `un-scale.ts`, `un-color.ts`, `un-range.ts`, `un-gmath.ts` |
| Config / data files | `.int`/`.ini` env & system config, encrypted `.dat` tables (musicinfo, npcgrp) | `conf-files/*.ts`, `datafile/*.ts` |
