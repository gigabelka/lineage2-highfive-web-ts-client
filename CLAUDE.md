# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. All answers must be in Russian.

## What this is

A from-scratch browser reimplementation of the Lineage II _Chronicle 4: Scions of Destiny_ game client. It reads the original encrypted UE2 asset binaries (`.unr/.utx/.usx/.uax/.ukx/.u/.ogg`) and renders the world with three.js + WebGL. Started as a streaming asset viewer; gameplay (actors, physics, UnrealScript bridge) is now being ported in phases from a more complete donor project (`realratchet`'s original client) — see "Actors" below. The code is deliberately messy in places because memory-layout reverse-engineering forces frequent churn — do not "clean up" adjacent code as a side effect of a change.

## Commands

- `npm run dev` (alias: `vite`) — Vite dev server on `127.0.0.1:8888`. Serves the app, the `html/` publicDir at `/`, and (via a custom plugin) the `c:/Games/HighFive/` tree with HTTP byte-range support under `/assets`. HMR on by default.
- `npm run build-dev` — `vite build --mode development` into `bin/` (`emptyOutDir`, sourcemaps, `target: chrome80`).
- `npm run preview` — serve a prior `bin/` build.
- `LIVE_RELOAD=0 npm run dev` — disables HMR. Use it for automated `?sectorTest` sweeps so a mid-sweep rebuild doesn't reload the sweep page and corrupt the report.
- `npm test` — Vitest (`vitest run`), config in `vitest.config.ts` (standalone — it does **not** load `vite.config.ts` or its dev-server plugins). Picks up `src/**/*.{test,spec}.ts`. `npm run test:watch` / `npm run test:ui` for the interactive runner. Run one file with `npx vitest run src/path/to/file.test.ts`, one case with `npx vitest run -t "test name"`. Unit-level coverage is almost nonexistent — the only spec is the smoke test in `src/__smoke__/`; `?sectorTest` is the real integration check. Add tests alongside the code you change.
- `tsconfig.json` is `emitDeclarationOnly` — types are never emitted to JS; esbuild/Vite strips them. Type errors do **not** fail the build or the tests.
- `npm run lint` / `npm run lint:fix` — ESLint v10 flat config (`eslint.config.mjs`): `js.recommended` + `typescript-eslint` recommended (no type-aware rules). Advisory only, not wired into `build`/`test` — like `knip`. Stylistic noise on the intentionally "dirty" reverse-engineering code is downgraded to `warn`; only rules that flag real defects (assignment in condition, unreachable code, duplicate keys, `case` fall-through) stay errors. Ignores `bin/ configs/ reference/ docs/ html/ *.d.ts *-report.jsonl`.
- `npm run typecheck` — `tools/typecheck.ts` (via `tsx`): runs `tsc --noEmit`, prints all output, but sets the exit code **only** from error lines outside `node_modules/` and `vendor/`. The vendored `@l2js/core` source (`vendor/l2js-core/`) is type-checked transitively and emits ~30 errors unrelated to this project's code; the wrapper suppresses those. Advisory, same as `lint`/`knip`.
- `npm run knip` — reports unused files, exports, and `package.json` dependencies (`knip.json` lists the entry points: client graph, decode worker, `?sectorTest`/`?precacheSectors` modes, configs, `tools/`). Advisory only; it never fails the build. Expect false positives on the redundant `export { X }` next to `export default X` pattern and on classes registered only via the `un-package.ts` import hub.
- `?sectorTest` (see below) is still the closest thing to a full integration test.
- Path aliases live in **three** places now — keep them in sync: `vite.config.ts` (`resolve.alias`), `tsconfig.json` (`compilerOptions.paths`), and `vitest.config.ts` (`resolve.alias`).

### Requirements to actually run

`c:/Games/HighFive/` must exist (the real client assets install). `vite.config.ts`'s `assetListPlugin` walks it on config-resolve (dev) and `buildStart` (build) and writes `html/asset-list.json` (git-ignored, auto-generated — never edit by hand; served at `/asset-list.json`). Without assets the build still runs but the app has nothing to load.

`@l2js/core` is **vendored** into the repo at `vendor/l2js-core/` (raw TS source, upstream `realratchet/l2js-core`). It's consumed through the `@l2js/core` path alias, not as an npm dependency, so `npm install` needs no GitHub SSH access. Its runtime dep `pako` is a direct dependency in `package.json`; its other runtime dep `gmp-wasm` (RSA decrypt) is **also vendored** at `vendor/gmp-wasm/` (prebuilt ESM bundle with the WASM embedded as base64, plus `.d.ts` types — no npm dependency, so an upstream unpublish/hijack of that niche single-maintainer package can't reach the decrypt path). It's consumed through the `gmp-wasm` path alias. Edit `vendor/l2js-core/**` in place when core needs changes — there is no separate repo checkout; to bump `gmp-wasm` follow the note in `vendor/gmp-wasm/package.json`.

`html/` is Vite's `publicDir` served at `/` — it holds committed static assets (`skybox.png`) plus the generated `asset-list.json`. `bin/` is the build output directory (`build-dev` / `preview`), git-ignored. `style/style.scss` is the single stylesheet, imported for side effect at the top of `src/index.ts` (hence the `sass` devDependency).

## Build system: Vite (`vite.config.ts`)

The project was migrated off Webpack; there is no more `configs/create-config.js`. `vite.config.ts` is the single source of truth and carries three custom plugins:

- **`assetListPlugin`** — regenerates `html/asset-list.json` (see above).
- **`rawShadersPlugin`** — replaces `raw-loader`: `.vs`/`.fs`/`.glsl` imports resolve to the file text as a default-exported string. Imports in `src/materials/**` and `register-chunks.ts` carry **no `?raw` suffix**, so a plugin is required instead of Vite's built-in `?raw`.
- **`devServerPlugin`** — byte-range-aware static serving of `c:/Games/HighFive/` under `/assets`, plus the `POST /sector-test/report` sink that appends to `sector-test-report.jsonl`.

Other config of note: `define: { global: "globalThis" }` (src has runtime `global` refs, no more Webpack node polyfill); `worker.format: "es"`; `path` → `path-browserify`; `@dimforge/rapier3d` → `@dimforge/rapier3d-compat`. The `@l2js/core` alias maps to `vendor/l2js-core/src` in all three alias locations (`vite.config.ts`, `tsconfig.json`, `vitest.config.ts`); the regex form collapses the optional `src/` in `@l2js/core/src/…` vs `@l2js/core/…` imports, and `tsconfig.json` mirrors it with a two-entry `paths` fallback. `vendor/l2js-core/src/supported-extensions.ts` was rewritten to plain ESM (now TS) when vendored (it was CommonJS `.js` upstream), so the old `l2CoreCjsShimPlugin` is gone. `vite.config.ts` keeps its own `SUPPORTED_EXTENSIONS` list (drives the `assetListPlugin` walk) — keep it aligned with the vendored one.

## Client / decode-worker separation (critical)

Still two logically separate graphs, now expressed through Vite:

1. **Client** (`src/index.ts`, `target: web`) — the renderer. three.js, materials, camera, DOM. **Must stay free of UE2 asset-parsing code.**
2. **Decode worker** (`src/assets/decode-worker/decode.worker.ts`) — owns the _entire_ UE2 asset pipeline (package deserialization, decode-info generation, batching, DXT→RGBA). Spawned from `decode-worker-client.ts` as `new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" })`; Vite compiles it as its own module sub-graph.

When adding code, decide which side it belongs to: anything touching `src/assets/unreal/**`, `src/assets/decoders/**`, or `src/assets/dds/**` (DXT/DDS decode) is worker-side and must not be reachable from the client graph.

## Runtime architecture

### Entry / mode select

`src/index.ts` runs `runSectorTest()` if the URL has `?sectorTest`, otherwise `startCore()` (`src/core.ts`). `startCore()` itself branches to `runSectorPrecache()` (`src/sector-precache.ts`) when the URL has `?precacheSectors`. `core.ts` holds a large `loadSettings` object (`GD.LoadSettings_T`) with big commented-out blocks of specific actor IDs used for isolating rendering bugs — expect to edit `_loadStaticModelList` etc. when debugging a single asset.

### Decode worker pool

- `DecodeWorkerClient` (`src/assets/decode-worker/decode-worker-client.ts`) — main-thread handle to a pool of N workers (`loadSettings.decodeWorkerPoolSize`, default 3). Each sector routes to whichever single worker decoded it, because package refcounts are **per-worker**, not shared. `freeSector` must go to that same worker.
- `poolSize: 0` runs one `DecodeEngine` in-process (dynamic import) so a decode can be stepped through in normal devtools — a dev knob.
- `DecodeEngine` (`decode-engine.ts`) owns an `AssetLoader` and runs the full decode; used identically by the worker and the in-process path.
- Message protocol in `decode-protocol.ts`; the worker processes messages strictly in order (an init must finish before any decode).
- Decoded packages are shared with the main thread at the **OPFS file level**, not in memory (`decode-cache.ts`). `loadSettings.cache.version` — bump it whenever decode logic changes; it invalidates all cached sectors.

### Package loading & asset dependencies (worker-side)

- `AssetLoader` (`src/assets/asset-loader.ts`) extends `AAssetLoader` from `@l2js/core`. `Instantiate(assetList)` registers one `UPackage` per entry in `html/asset-list.json`; `createPackage` points each at `/assets/<downloadPath>`.
- `UPackage` / `UEncodedFile` start as **constructor shells** from `@l2js/core` (`APackage`, `un-encoded-file.ts`) — real methods throw until the worker mixes in the implementation from `@unreal/*`. The client graph can hold the shell type without pulling UE2 code.
- Refcounting lives here, keyed by package `path`: `using(pkg, { neverUnload })` loads a package, walks the transitive import closure (`getDependencies`), and increments a count per dependency (`Infinity` for `neverUnload`). `free(pkg)` decrements the same closure and calls `pkg.free()` on anything that hits 0. This is the per-worker refcount the pool comment above refers to.

### Sector streaming

`AssetManager` (`src/assets/asset-manager.ts`) streams the world in/out around the camera every frame:

- `renderDistance` loads, larger `unloadDistance` unloads (hysteresis so boundary crossings don't thrash).
- Retired sectors are hidden but kept reusable for a grace period before disposal.
- Camera-velocity prefetch projects a lookahead position and prioritizes sectors nearest it.
- Static-mesh building is time-sliced across frames (`STATIC_MESH_BUILD_FRAME_MS`) after geometry is already on screen, so materials/lighting stream in progressively.
- The main thread only ever sees plain decoded data and instantiates three.js objects from it — it never parses UE2.

### Rendering

`RenderManager` (`src/rendering/render-manager.ts`, ~2600 lines) — the render loop, camera controllers (Z-up variants of OrbitControls / PointerLockControls in `src/rendering/camera/`), postprocessing (`postprocessing/`), env/fog/sky (`l2-env.ts`, `sky-renderer.ts`, `env-*.ts`), audio (`audio-manager.ts`), and a `lil-gui` panel. Many constants are lifted directly from disassembly of the original client (referenced by address in comments) or from UE2 `.ini` defaults — preserve those citations.

`src/rendering/ue2-conventions.ts` duck-types three.js into UE2's coordinate space (Z-up, UE2 asset format) — imported for side effects at the top of `render-manager.ts`. Assets are kept in UE2 space rather than being swizzled on load.

`src/rendering/visualizer.ts` (`Visualizer`, `VisualizerMode`) is an in-scene BSP/streaming debug overlay owned by `RenderManager` — **F3** toggles it, **F4** cycles modes (portals / zones / leaves / fogs / audio / emitters). It reads the current `SectorObject` and camera position each frame; the BSP data it draws (`ZoneObject`, `BSPZoneData` / `BSPLeafData` / `BSPNodeData`, `FogInfoObject`, `ILightInfo`) lives in `src/objects/zone-object.ts`, which also defines the `SectorObject` root that a decoded sector instantiates into.

### Actors — component-based, ported from the donor project in phases

`src/game/components.ts` defines the component framework: `GameObject`/`GameMesh` (both implement `IObject`, extend three.js `Object3D`/`Mesh`) hold a `ComponentCollection` of `IComponent`s looked up by `componentName` string (`getComponent`/`findComponent`/`addComponent`), each optionally ticked (`onUpdate`, ordered by `updateOrder`) and able to broadcast/receive events via `dispatchComponentEvent`/`onEvent`. Event name constants live in `src/game/component-events.ts` — a single source of truth so components stay decoupled; the strings are the donor project's verbatim wire format and must not be renamed.

`src/base-actor.ts` (`BaseActor extends GameObject`) and `src/player.ts` (`Player extends BaseActor`) are being rebuilt on top of this by porting the donor project (`realratchet`'s original, more complete client) component-by-component in phases, tracked via comments like `(Phase 3)`, `(Phase 4)`, `(Phase 5)` on the pieces not yet landed. Components that exist today: `PawnMovementComponent`/`ColliderComponent`/`PhysicsComponent` (`src/physics/components/`, backed by `src/physics/collision-world.ts`, `collision-primitive.ts`, `volume-bsp.ts` — a from-scratch collision/physics layer, not rapier-only), `AnimationComponent` (`src/objects/components/animation-component.ts`), `PawnRenderableComponent` (`src/rendering/components/pawn-renderable-component.ts`), `NpcLifecycleComponent` (`src/objects/components/npc-lifecycle-component.ts`). `BaseActor` looks up not-yet-ported components (`"transform"`, `"script"`, Phase 4) via `findComponent` so it degrades to a no-op instead of throwing; components attached unconditionally in the constructor are fetched with `getComponent`, which throws if missing — that distinction is intentional, keep it when porting more components.

`src/ue-script/script-values.ts` defines the type-only shapes (`ScriptValue_T`, `ScriptHost_T`, `ScriptNativeCall_T`) for the future UnrealScript VM bridge (`vm.ts`, `operators.ts`, `native-registry.ts`, Phase 4) so `BaseActor`/`PawnMovementComponent` can carry final method signatures ahead of the VM landing; this file is client-side only (the VM proper is client-side, `script-dump-loader.ts` is worker-side).

`RenderManager.update` drives `player.update` at 60 Hz and NPC `pawn.update` at 30 Hz (`render-manager.ts:2721`); this is a live path now, not commented-out scaffolding. `src/objects/` also has non-actor scene object types (`movable-object.ts`, `rotating-object.ts`, `swaying-object.ts`, `lit-actor.ts`, `terrain-decoration.ts`, emitters).

### Utilities

`src/utils/` — small standalone helpers with no project dependencies (`color-byte.ts`, `hash-cyrb.ts`, `hsv-to-rgb.ts`, `string-set.ts`, `typed-arrray-constructor.ts`); safe to use from either graph.

### Materials

`src/materials/<name>-material/` — one folder per material type (static mesh, terrain, UV, emitter, particle), each with a `shader/` subfolder of `.vs`/`.fs`/`.glsl` (loaded via `rawShadersPlugin`). `shader-chunks/register-chunks.ts` registers custom three.js `ShaderChunk`s (side-effect import). `global-uniforms.ts` holds shared uniforms (time, gamma, etc.).

## Path aliases

Defined in **three** places: `vite.config.ts` (`resolve.alias`), `tsconfig.json` (`paths`), and `vitest.config.ts` (`resolve.alias`). Keep them in sync.

| alias        | target                                            |
| ------------ | ------------------------------------------------- |
| `@client/*`  | `src/*`                                           |
| `@unreal/*`  | `src/assets/unreal/*`                             |
| `@native`    | `src/assets/unreal/scripts/un-native-registry.ts` |
| `@l2js/core` | `vendor/l2js-core/src` (vendored raw source)      |
| `gmp-wasm`   | `vendor/gmp-wasm/dist` (vendored prebuilt ESM)    |

VSCode is configured for non-relative imports (`typescript.preferences.importModuleSpecifier: non-relative`) — prefer alias imports over `../../..`.

### Global namespaces

`global.d.ts` aliases `L2JS.*` namespaces used unqualified everywhere: `C` = `L2JS.Core`, `G` = `L2JS.Client`, `GR` = `Rendering`, `GA` = `Assets`, `GD` = `Decoding`. Types like `GD.LoadSettings_T`, `GD.DecodeLibrary`, `GA.IUserConfig` come from here plus the various `*.d.ts` files (`src/**/*.d.ts`, `index.d.ts`, `l2js-core.d.ts`).

## `?sectorTest` — the sweep harness

`src/sector-test.ts`: decodes every level sector through the worker, instantiates it, renders + simulates a few frames (shader compile, emitter warmup, lighting, animated materials), and POSTs one JSONL row per sector to `/sector-test/report`, appended to `sector-test-report.jsonl` (that endpoint is the `devServerPlugin` in `vite.config.ts`). Use it to check for regressions across the whole map.

Query params: `start=N` (resume), `only=a,b` (subset), `emitters=0`, `cache=1`, `free=0`, `render=0`, `forceRender=1`, `textures=auto|rgba|compressed`.

Run automated sweeps with `LIVE_RELOAD=0 npm run dev`.

`sector-test-report.jsonl` is git-ignored and **appended to** — the endpoint never truncates it. Delete it before a clean sweep or you'll be reading stale rows mixed with new ones.

## Tooling

- `.vscode/launch.json` — a Chrome launch config ("Launch Chrome against localhost") pointed at the dev server on `:8888`.

## Conventions

- Type suffix `_T` for type aliases (`LoadSettings_T`, `SectorObject`), `Un`/`U` prefix for UE2 class ports (`UStaticMesh`, `un-static-mesh.ts`).
- Comments frequently cite original-client disassembly addresses (`0x8a2ae0`) or UE source — these are load-bearing documentation, keep them.
- Non-vanilla-purist: skipping non-critical data hiding in the binaries is acceptable and expected.
