# Glossary and quick file reference

## The `L2JS.*` namespace aliases

[global.d.ts](../global.d.ts) is a *script* file (not a module), so its aliases are visible
**unqualified in every `.ts` file** without importing anything:

```ts
import C  = L2JS.Core;              // @l2js/core package types
import G  = L2JS.Client;            // container namespace
import GR = L2JS.Client.Rendering;  // currently empty, reserved
import GA = L2JS.Client.Assets;     // UE2 class-port types + config/enum types
import GD = L2JS.Client.Decoding;   // the decode-pipeline contract
```

The members are declared in [index.d.ts](../index.d.ts) (~1000 lines) inside
`declare global { namespace L2JS { namespace Client { … } } }`.

| Alias | Holds | Representative members |
| --- | --- | --- |
| `C` | `@l2js/core` types | `C.UObject`, `C.APackage`, `C.NativeTypes_T` |
| `GA` | asset-side types | `GA.UStaticMesh`, `GA.UMaterial`, `GA.AActor`, `GA.SupportedBlendingTypes_T`, `GA.IUserConfig`, `GA.EEnvCycle` |
| `GD` | decode contract | `GD.LoadSettings_T`, `GD.DecodeLibrary`, `GD.IShaderDecodeInfo`, `GD.IDecodedParameter`, `GD.EmitterConfig_T`, `GD.IMoverDecodeInfo`, `GD.ITerrainDecorationDecodeInfo`, `GD.Vector3Arr` |

Supporting ambient files: [l2js-core.d.ts](../l2js-core.d.ts) augments core's `UObject` with
the runtime mixin (`uuid`, `dumpLayout()`); per-directory `*.d.ts` files provide
`HTMLViewportElement`, `ICollidable`, `ParticleMaterialInitSettings_T`, etc.

## Naming conventions

| Pattern | Meaning | Example |
| --- | --- | --- |
| `U` / `Un` prefix | a UE2 engine class port | `UStaticMesh`, `un-static-mesh.ts` |
| `A` prefix | a UE2 actor class port | `ATerrainInfo`, `UAActor` |
| `F` prefix | a UE2 value struct | `FVector`, `FBSPNode`, `FCoords` |
| `_T` suffix | a TypeScript type alias | `LoadSettings_T`, `SectorObject`, `Particle_T` |
| `0x8a2ae0` in a comment | an address in the original client disassembly — **load-bearing documentation, keep it** | |
| `.uc` reference in a comment | a cited UnrealScript source file | |

## Terms

- **Sector** — one `maps/<x>_<y>.unr` package = one square of the world (`256 * 128` world
  units per axis). The unit of streaming. Also identified as `"<x>_<y>"`.
- **`DecodeLibrary`** — the plain-data DTO the worker produces and the main thread consumes.
  BSP nodes/sections/zones, geometries, materials, `leafActors`, `staticMeshBatches`,
  lights, emitters, terrain, sounds. No functions, no live `UObject`s. Typed by `GD.*`.
- **Decode-info** — the per-object plain data a UE2 object contributes to the
  `DecodeLibrary` via its `getDecodeInfo(builder)` method (`IShaderDecodeInfo`,
  `IMoverDecodeInfo`, …).
- **Leaf actor** — an entry in `library.leafActors`: one drawable instance (transform +
  geometry ref + material ref + zone/leaf visibility mask), possibly merged into a batch.
- **BSP zone / node / section** — the level's binary space partition. Zones drive visibility
  and per-zone fog/ambient; nodes are the tree; sections are the drawable geometry groups.
- **Batch / batch manifest** — `buildStaticMeshBatchData` merges static-mesh sections that
  share a material into shared geometry buffers + a `staticMeshBatches` manifest, so many
  actors draw in one call.
- **Warmup / lighting gate** — after a sector's geometry is on screen, `RenderManager`
  streams materials and lighting in progressively. `stageSectorWarmup` swaps textured
  materials for a grey fallback; `processSectorWarmups` restores real materials at ≤8/frame
  within a 2 ms budget, then releases the `lightingGate` and emitter `warmupGate`.
- **Retirement** — a sector past `unloadDistance` is hidden but kept reusable for
  `RETIRED_SECTOR_DISPOSE_MS` (30 s) before real disposal, so a quick U-turn does not
  re-decode.
- **Shell package** — a `UPackage` / `UEncodedFile` object registered by `@l2js/core` whose
  byte-reading and object-construction methods do not exist until the worker imports the
  `@unreal/*` mixin hub. The client graph can hold the *type* without the code.
- **Mixin hub** — [src/assets/unreal/un-package.ts](../src/assets/unreal/un-package.ts),
  which implements the shell methods and wires the class-name → `@unreal` class dispatch
  tables. Injected via `await import("@unreal/un-package")` in `AssetLoader.Instantiate`.
- **UE2 space / Z-up** — world data is kept in native Unreal Engine 2 coordinates (Z-up,
  left-handed) with no swizzle. The handedness flip is baked into the camera projection
  matrix. See [rendering.md](rendering.md#ue2-coordinate-convention).
- **Non-vanilla-purist** — the project's stated stance: skipping non-critical data hiding in
  the binaries is acceptable when the render works without it.
- **`?sectorTest` / `?precacheSectors`** — URL modes; see [testing.md](testing.md).

## Key file quick reference

| Path | Role |
| --- | --- |
| [src/index.ts](../src/index.ts) | entry; forks on `?sectorTest` |
| [src/core.ts](../src/core.ts) | `startCore()`; builds `loadSettings`; forks on `?precacheSectors` |
| [src/assets/asset-manager.ts](../src/assets/asset-manager.ts) | main-thread sector streaming (load/unload/prefetch/build slicing) |
| [src/assets/asset-handle.ts](../src/assets/asset-handle.ts) | OPFS raw-package fetch/mirror |
| [src/assets/asset-loader.ts](../src/assets/asset-loader.ts) | worker package registry + per-worker refcounting |
| [src/assets/decode-worker/decode-worker-client.ts](../src/assets/decode-worker/decode-worker-client.ts) | main-thread handle to the worker pool |
| [src/assets/decode-worker/decode.worker.ts](../src/assets/decode-worker/decode.worker.ts) | worker entry; in-order message queue |
| [src/assets/decode-worker/decode-engine.ts](../src/assets/decode-worker/decode-engine.ts) | runs the full decode (worker + in-process) |
| [src/assets/decode-worker/decode-protocol.ts](../src/assets/decode-worker/decode-protocol.ts) | main↔worker message type unions |
| [src/assets/decode-worker/decode-cache.ts](../src/assets/decode-worker/decode-cache.ts) | OPFS decoded-library cache + sweep |
| [src/assets/decode-worker/library-serializer.ts](../src/assets/decode-worker/library-serializer.ts) | `"L2DC"` binary (de)serializer |
| [src/assets/decode-worker/collect-transferables.ts](../src/assets/decode-worker/collect-transferables.ts) | sanitize library + collect transfer list |
| [src/assets/decode-worker/build-decode-library.ts](../src/assets/decode-worker/build-decode-library.ts) | `Level` package → `DecodeLibrary` |
| [src/assets/unreal/un-package.ts](../src/assets/unreal/un-package.ts) | the mixin hub / class dispatch tables |
| [src/assets/unreal/un-object-mixin.ts](../src/assets/unreal/un-object-mixin.ts) | runtime patch of core's `UObject` |
| [src/assets/unreal/decode-library.ts](../src/assets/unreal/decode-library.ts) | the `DecodeLibrary` DTO class |
| [src/assets/unreal/decode-library-builder.ts](../src/assets/unreal/decode-library-builder.ts) | `pullLevel` / `pullModel` / `pullActors` |
| [src/assets/decoders/object3d-decoder.ts](../src/assets/decoders/object3d-decoder.ts) | `DecodeLibrary` → three.js `Object3D` graph (main thread) |
| [src/assets/decoders/material-decoder.ts](../src/assets/decoders/material-decoder.ts) | decode-info → three.js materials |
| [src/assets/decoders/texture-decoder.ts](../src/assets/decoders/texture-decoder.ts) | decode-info → `CompressedTexture` / `DataTexture` |
| [src/assets/decoders/dxt-decode.ts](../src/assets/decoders/dxt-decode.ts) | software DXT→RGBA (worker) |
| [src/assets/decoders/batch-data.ts](../src/assets/decoders/batch-data.ts) | static-mesh batch merge (worker, math only) |
| [src/rendering/render-manager.ts](../src/rendering/render-manager.ts) | the render loop god-object |
| [src/rendering/ue2-conventions.ts](../src/rendering/ue2-conventions.ts) | Z-up + mirrored projection (side-effect import) |
| [src/rendering/l2-env.ts](../src/rendering/l2-env.ts) | time-of-day colour model + fog blending |
| [src/rendering/sky-renderer.ts](../src/rendering/sky-renderer.ts) | separate celestial scene (sun/moons/sky layers) |
| [src/rendering/audio-manager.ts](../src/rendering/audio-manager.ts) | music + 32-channel spatial ambient |
| [src/materials/global-uniforms.ts](../src/materials/global-uniforms.ts) | shared `Uniform` instances |
| [src/materials/mesh-static-material/mesh-static-material.ts](../src/materials/mesh-static-material/mesh-static-material.ts) | the main world material |
| [src/objects/lit-actor.ts](../src/objects/lit-actor.ts) | per-vertex lighting engine (base of the actor chain) |
| [src/objects/emitters/base-emitter.ts](../src/objects/emitters/base-emitter.ts) | UE2 `UParticleEmitter` port |
| [vite.config.ts](../vite.config.ts) | build config + 4 custom plugins |
| [global.d.ts](../global.d.ts) / [index.d.ts](../index.d.ts) | the `L2JS.*` namespace aliases and their members |
