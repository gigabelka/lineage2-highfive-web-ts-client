# Rendering

The client-side renderer lives under [src/rendering/](../src/rendering/). It consumes only
plain decoded data and three.js objects — never UE2 parsing code.

## `RenderManager`

[src/rendering/render-manager.ts](../src/rendering/render-manager.ts) (~3300 lines) is a
god-object. It is constructed once in [src/core.ts](../src/core.ts)
(`new RenderManager(viewport, assetManager)`), then `startRendering()` is called. Its first
two imports are side-effect imports:

```ts
import "./ue2-conventions";                        // Z-up + mirrored projection (see below)
import "../materials/shader-chunks/register-chunks"; // custom THREE.ShaderChunk
```

### What it owns

- `renderer: WebGLRenderer` — `logarithmicDepthBuffer`, `preserveDrawingBuffer`,
  `premultipliedAlpha: false`, `autoClear = false`, `debug.checkShaderErrors = false` (it
  polls `KHR_parallel_shader_compile` itself).
- `camera: PerspectiveCamera` — 60° horizontal FOV converted to vertical per aspect, near
  `0.1`, far `100_000_000`, `up = (0,0,1)`.
- `scene`, `objectGroup` (`"SectorGroup"`, holds every streamed sector), `globalSky`.
- `controls: { orbit: ZUpOrbitControls, fps: ZUpPointerLockControls }` — toggled with the
  `C` key / pointer-lock events.
- `physicsWorld: RAPIER.World` — gravity `(0, 0, -980)` (Z-down). `RAPIER` is
  `@dimforge/rapier3d-compat` via the alias map.
- `mixer: AnimationMixer`, `player: Player` (added to the scene near a church),
  `skyRenderer: SkyRenderer`, `audioManager: AudioManager`, `visualizer: Visualizer`
  (recreated on each sector change), `particleBatcher: InstancedSpriteBatcher`.
- Sector registry `sectors: Map<number, Map<number, SectorObject>>` keyed by grid X/Y;
  `sectorBounds: Box3[]`; `getSectorId(pos)` uses `sectorSize = 256*128` and offsets `+20`
  (X) / `+18` (Y).
- Post FX: `mainRenderTarget`, `uGlowPass` (instantiated but its `render()` call in
  `_doRender` is **commented out** — bloom is only active with shader rendering, off by
  default), `displayGammaPass` (active only when the GUI "Gamma" dropdown enables it).
- Warmup pipeline (`pendingSectorWarmups`, `TEXTURE_WARMUP_FRAME_MS = 2`,
  `MATERIAL_RESTORES_PER_FRAME = 8`), shader-diagnostics queue, `environment: L2Environment`,
  a module-level `dat.GUI` panel (folders `World` / `Quality` / `Sky Layers` / `Audio`) and
  a `stats.js` panel.

### The render loop

`startRendering()` steps the physics world once, does an initial matrix / collider / terrain
pass, then `requestAnimationFrame`-loops `_preRender` → `_doRender` → `_postRender` (only
when `isPersistentRendering || needsUpdate`).

- **`_preRender`** — `assetManager.tick(this)`, `processSectorWarmups`,
  `processShaderDiagnostics`, `mixer.update`, advance time-of-day, rebuild the frustum, FPS
  camera WASD movement, `audioManager.update`, two **live** physics/actor tick gates
  (`player.update()` at 60 Hz, every other pawn's `update()` at 30 Hz — see "Actors: live vs
  scaffolding" below), `_updateObjects`, music-volume switching, a full spatial ambient-sound
  pass (ported from `alaudio.dll`), listener update, `renderer.clear()`.
- **`_updateObjects`** — sets `dropDetail` / `aggressiveLod` from frame time vs
  `MIN_DESIRED_FRAME_RATE = 35`; advances `GLOBAL_UNIFORMS.globalTimeSeconds`; computes
  `staticMeshSunAmbient` and the shared `cameraBillboardRight`/`cameraBillboardUp` basis;
  then per-sector BSP visibility, emitter throttling (`OFFSCREEN_EMITTER_HZ = 2`), mover /
  rotator updates, `_updateEnvironment`, pawn visibility, sector render-order.
- **`_updateEnvironment`** — the fog / sky pipeline. Base sky colour from `L2Environment`;
  fog ranges from the env preset × `2048`; overrides from the camera's zone and from
  `L2FogInfo` actors gathered across the current + 8 neighbour sectors, weight-blended by
  `interpolateFogInfo*` from `l2-env.ts`. Feeds `skyRenderer.update(...)`,
  `renderer.setClearColor`, `scene.fog`, and the fog global uniforms.
- **`_doRender`** — optional gamma target bind, `skyRenderer.render` then `clearDepth`,
  recreate the visualizer on sector change, `renderer.render(scene, camera)`, gamma blit.

### Network hand-off: `placePlayerAt` / `releasePlayerHold`

The only two public methods `RenderManager` exposes for the live-server session
(`src/game/net-world-bridge.ts`, see [networking.md](networking.md)) — `RenderManager` itself
has no knowledge of the network stack beyond these two generic calls:

- **`placePlayerAt(position, opts?)`** — teleports the player to a server-reported world
  position and moves the camera to look at it (also what kicks off `AssetManager` streaming
  toward that area, since there is no `loadAround(x,y,z)`). Snapshots the real collision
  size before forcing `setFlying(true)`, because `setFlying` overwrites it with the debug
  wyvern's collision and never restores it on its own.
- **`releasePlayerHold()`** — `setFlying(false)` + restores the snapshotted collision size.
  Idempotent. Called once the caller has confirmed the target sector's collision actually
  streamed in — `RenderManager` does not decide *when*, only exposes the primitive.
- **`hasSector(id)`** / **`getSector(position)`** — narrow read-only windows onto
  `assetManager`, used by the network bridge to tell "still streaming" apart from "this tile
  was never shipped".

### Input

F1 BSP helper camera · F2 frustum culling toggle · F3 visualizer toggle · F4 cycle
visualizer mode · F5 cycle leaf detail · number keys `1`–`6` camera bookmarks · `+` / `-`
next / prev sector · WASD + shift FPS movement · left-click raycasts and calls
`player.goTo(point)` on a collidable.

## UE2 coordinate convention

[src/rendering/ue2-conventions.ts](../src/rendering/ue2-conventions.ts) (imported for side
effects as line 1 of `render-manager.ts`) makes two global mutations:

1. `Object3D.DefaultUp.set(0, 0, 1)` — every `Object3D` and camera is **Z-up**. All world
   data flows through the pipeline as native UE2 with **no axis swizzle**.
2. `PerspectiveCamera.prototype.updateProjectionMatrix` is monkey-patched: after the
   original runs, it negates `te[0]` (clip-space X scale) and `te[8]` (X skew), then
   re-inverts `projectionMatrixInverse`.

Rationale: UE2 is left-handed, three.js is right-handed. Since the data is un-swizzled the
image would be mirrored; a quaternion cannot express a reflection, so the handedness flip is
baked into the projection matrix, patched once on the prototype so every camera inherits it.

**Consequence:** the rendered image is mirrored horizontally, so anything reasoning about
screen-space left / right must negate its horizontal term. This is why:

- [zup-orbit-controls.ts](../src/rendering/camera/controllers/zup-orbit-controls.ts) negates
  rotate / pan `deltaX`,
- [zup-pointer-lock-controls.ts](../src/rendering/camera/controllers/zup-pointer-lock-controls.ts)
  negates yaw (not pitch),
- `_preRender` builds the strafe vector as `(1,0,0).applyQuaternion(camera.quaternion) * -v`,
- `_updateObjects` builds the billboard basis with an explicit right-vector cross so sprites
  are not mirrored.

### The two camera controllers

Both are forks (not patches) of the three.js examples controllers, because the drag FSM state
lives in constructor closures.

- **`ZUpOrbitControls`** — fork of `OrbitControls`. Only change: horizontal rotate / pan
  deltas negated. `update()` rotates the offset into a Y-up frame so `camera.up` is the
  orbit axis.
- **`ZUpPointerLockControls`** — Z-up equivalent of `PointerLockControls` (which hardcodes a
  Y-up `'YXZ'` Euler). Tracks `yaw` / `pitch` directly, rebuilds the look vector from
  spherical coords. `syncFromCamera()` is called before every mouse move because bookmark
  keys and sector jumps move the camera outside this controller.

## Env / fog / sky

- [l2-env.ts](../src/rendering/l2-env.ts) — `L2Environment` implements the UE2 `NTimeLight`
  time-of-day colour model: `getSunColor` / `getSkyColor` / `getMoonColor` / `getHazeColor` /
  `getFogColor`, the per-target ambient planes (`getAmbientPlane{Terrain,Actor,StaticMesh,
  BSP}Light[Halved]`), `selectEnvironmentLightIndices(n)` → `[curr, next, lerp]`. Also
  `FogBlendState` (~1 s lerp on fog-target change) and the exported `interpolateFogInfo*`
  blend helpers. Many constants and the `>> 1` byte-level halving are lifted directly from
  disassembly — **keep the address citations**.
- [env-color.ts](../src/rendering/env-color.ts) / [env-info.ts](../src/rendering/env-info.ts)
  — plain value containers (`EnvColor`, `TimeColor`, `TimeHSV`, `EnvSetup`, `EnvFog`,
  `EnvWaterVolume`).
- [sky-renderer.ts](../src/rendering/sky-renderer.ts) — `SkyRenderer` owns a **separate
  `Scene`** rendered before the world, with its own `Fog`: the sun and moons (additive
  `MeshBasicMaterial`, no depth) and the skybox / haze / cloud BSP layers pinned to the
  camera. Celestial positioning is spherical (longitude, time-of-day latitude, 30° tilt).
- [display-gamma.ts](../src/rendering/display-gamma.ts) — `DisplayGammaPass`, a fullscreen
  blit replicating the C4 `D3DDrv.dll UpdateGamma` ramp
  (`clamp(scale * pow(texel, 1/gamma) + offset)`), toggled from the GUI.
- [postprocessing/uglow-pass.ts](../src/rendering/postprocessing/uglow-pass.ts) — `UGlowPass`,
  a UE2 `UGlowEffect` bloom pass. Instantiated but the `render()` call is commented out.

## Audio

[audio-manager.ts](../src/rendering/audio-manager.ts) — one `AudioContext`, `masterGain` →
music gain + ambient gain. Music: preload / crossfade queue (500 ms linear ramp), OGG
"decryption" by overwriting the first 4 bytes with `"OggS"`. Ambient: `MAX_AUDIOCHANNELS =
32`, `PannerNode` `equalpower` + `inverse` distance model, priority-based channel stealing,
`rollAmbientTrigger` (one reroll per sound-duration slot), all ported from `alaudio.dll` with
address citations.

## Actors: live vs scaffolding

| Class | File | Status |
| --- | --- | --- |
| `BaseActor` | [src/base-actor.ts](../src/base-actor.ts) | **Live.** Rapier cuboid + dynamic body, animation state machine, ground raycasts. `update()` is driven by `RenderManager._preRender`'s two tick gates: `player.update()` at 60 Hz, every other pawn's `update()` at 30 Hz (`render-manager.ts:2721`, ~`this.nextPlayerTick`/`this.nextPawnTick`) — `physicsWorld.step()` runs inside the 60 Hz gate too. |
| `Player` | [src/player.ts](../src/player.ts) | **Live.** Constructed and added to the scene; `goTo(point)` is wired to left-click and drives `PawnMovementComponent`. `RenderManager.placePlayerAt`/`releasePlayerHold` (see below) let the network session teleport it and hand it back to gravity once collision has streamed in. |
| `MovableObject` | [src/objects/movable-object.ts](../src/objects/movable-object.ts) | **Live.** UE2 `Mover` port (doors, castle gates): key positions/quaternions, `closed → delaying → opening → open → closing` state machine, kinematic body. Driven by `RenderManager.movableObjects` + `updateMovableObjects`. |
| `RotatingObject` | [src/objects/rotating-object.ts](../src/objects/rotating-object.ts) | **Live.** Windmills, spinners. `pitch/yaw/roll += rate * dt`. Driven by `RenderManager.rotatingObjects`. |
| `SwayingObject` | [src/objects/swaying-object.ts](../src/objects/swaying-object.ts) | **Live** (a `RotatingObject`). `PHYS_L2Movement` sway (trees, hanging props); can carry attached emitters. |
| `TerrainDecoration` | [src/objects/terrain-decoration.ts](../src/objects/terrain-decoration.ts) | **Live.** `InstancedMesh` grass / foliage, distance-culled against `fadeoutRadius`, lit from the terrain's per-vertex colours. |
| Emitters | [src/objects/emitters/](../src/objects/emitters/) | **Live.** See [materials.md](materials.md) and the emitter notes below. |

### The lit-actor chain

`Mesh → LitActorMesh → CollidingMesh → { MovableObject | RotatingObject → SwayingObject }`.

- [lit-actor.ts](../src/objects/lit-actor.ts) — `LitActorMesh` is the per-vertex lighting
  engine (fully wired). It rebuilds a `staticLightingCache` when the env version changes or a
  static light moves, applies zone ambient + static scene lights + interpolated static env
  lights, then a dynamic pass filtered by visibility for batched actors. Decodes each light's
  per-vertex bitmask once, narrowed by a vertex range to keep necropolis-scale cost bounded.
- [colliding-mesh.ts](../src/objects/colliding-mesh.ts) — adds a Rapier trimesh + fixed body
  from `colliderIndices`.

### Emitters

[base-emitter.ts](../src/objects/emitters/base-emitter.ts) (~2400 lines) is a faithful port
of UE2 `UParticleEmitter` / `UnParticleEmitter.cpp`: the full simulation (acceleration,
coordinate systems, revolution, mesh spawning, fade, size-by-velocity, spin), `warmUp` to
replay `PrimeTime`, a `warmupGate` set false by `RenderManager` while higher sector tiers
load. Unimplemented UE2 branches (sibling-emitter refs, collision, some velocity modes) are
stubbed with `__break__()` because the decode info does not carry the data. Subclasses:
`SpriteEmitter` (billboard quads; instanced path for `camera` / `normal` directions),
`MeshEmitter`, `BeamEmitter`. [instanced-sprite-batcher.ts](../src/objects/emitters/instanced-sprite-batcher.ts)
merges order-independent additive instanced sprite emitters from all visible sectors into
shared world-space draws.
