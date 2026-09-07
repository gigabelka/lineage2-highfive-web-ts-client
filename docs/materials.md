# Materials and shaders

All material code is client-side, under [src/materials/](../src/materials/).

## Folder layout

One folder per shader program, each with a `shader/` subfolder holding raw GLSL:

```
src/materials/
├── global-uniforms.ts                     shared frozen Uniform instances
├── wet-water-texture.ts                    CPU fractal water DataTexture (UnFractal.h port)
├── materials.d.ts                          *.vs / *.fs / *.glsl module declarations
├── shader-chunks/
│   ├── register-chunks.ts                  registers ShaderChunk.l2_fog_fragment
│   └── l2_fog_fragment.glsl                the custom fog chunk body
├── mesh-static-material/
│   ├── mesh-static-material.ts             MeshStaticMaterial — StaticMesh + BSP surfaces
│   ├── transform-stage.ts                  UV transform-chain struct builder + padding
│   └── shader/shader-mesh-static.vs / .fs
├── mesh-terrain-material/
│   ├── mesh-terrain-material.ts            MeshTerrainMaterial — runtime shader codegen
│   ├── terrain-layer-array.ts              packs layer maps/masks into sampler2DArray
│   └── shader/shader-mesh-terrain.vs / .fs
├── particle-material/
│   ├── particle-material.ts                ParticleMaterial + AnimatedParticleMaterial
│   ├── instanced-particle-material.ts      InstancedParticleMaterial (batched sprites)
│   └── shader/shader-particle[-instanced].vs / .fs
└── mesh-emitter-material/
    ├── mesh-emitter-material.ts            MeshEmitterMaterial
    └── shader/mesh-emitter.vs / .fs
```

## Raw shader imports (`rawShadersPlugin`)

Shaders are imported **without a `?raw` suffix**:

```ts
import VERTEX_SHADER from "./shader/shader-mesh-static.vs";
```

The `rawShadersPlugin` in [vite.config.ts](../vite.config.ts) `transform`s any id matching
`/\.(vs|fs|glsl)$/` into `export default <JSON-stringified source>`. It replaces
`raw-loader`; Vite's built-in `?raw` is not used because the imports carry no suffix.
[materials.d.ts](../src/materials/materials.d.ts) declares the `*.vs` / `*.fs` / `*.glsl`
modules so TypeScript accepts the imports.

> **Vitest does not load this plugin.** [vitest.config.ts](../vitest.config.ts) deliberately
> does not reuse `vite.config.ts`. Any test that imports a material module must stub the
> shader imports itself.

## The custom fog chunk

[register-chunks.ts](../src/materials/shader-chunks/register-chunks.ts) installs
`ShaderChunk.l2_fog_fragment` globally (it is imported once, as line 2 of
`render-manager.ts`). [l2_fog_fragment.glsl](../src/materials/shader-chunks/l2_fog_fragment.glsl)
is a drop-in replacement for three's `<fog_fragment>`. It computes a linear or `FOG_EXP2`
`fogFactor`, then picks the mix target by define:

| Define | Mix target | Set by |
| --- | --- | --- |
| `USE_MODULATED_FOG` | `vec3(127/255)` (grey) | materials using `modulate` blending |
| `USE_ADDITIVE_FOG` | `vec3(0.0)` (fade to black) | additive blends (`brighten`, additive particles, the moon) |
| *(neither)* | real `fogColor` | everything else |

Each material chooses the define from its UE2 blend mode.

## Global uniforms

[global-uniforms.ts](../src/materials/global-uniforms.ts):

```ts
const GLOBAL_UNIFORMS = Object.freeze(UniformsUtils.merge([
    UniformsLib.fog, {
        globalTimeSeconds:    new Uniform(0),
        staticMeshSunAmbient: new Uniform(new Vector3()),
        cameraBillboardRight: new Uniform(new Vector3(1, 0, 0)),
        cameraBillboardUp:    new Uniform(new Vector3(0, 1, 0)),
    }
]));
```

`appendGlobalUniforms(uniforms)` copies each entry into a material's own uniform map, so
every material shares the **same `Uniform` object instances**. `RenderManager` writes them
once per frame (`_updateObjects` / `_updateEnvironment`), so updating fog colour or the
billboard basis touches one object, not every material.

## The materials

### `MeshStaticMaterial` (`extends ShaderMaterial`)

The main world material — static meshes and BSP surfaces.
[mesh-static-material.ts](../src/materials/mesh-static-material/mesh-static-material.ts).

- Constructor takes a decoded shader-info object (`diffuse` / `opacity` / `specular` /
  `specularMask` parameters, a `combiner`, a `blendingMode`).
- `applyParameters()` builds defines: `USE_DIFFUSE`, `USE_MAP_DIFFUSE`, `..._TRANSFORM`,
  `..._TRANSFORM_CHAIN` (via `padTransformStages`), `USE_UV` / `USE_UV2`, sprite-sheet
  animation.
- Blend modes map 1:1 to `D3DMaterialState.cpp`: `brighten` = SrcAlpha/One, `translucent` =
  One/OneMinusSrcColor, `modulate` = DstColor/SrcColor, `alphaModulate`, `invisible` =
  Zero/One, `darken`, `masked` = alpha-test at `127/255`.
- Runtime toggles: `setLightmap`, `enableAmbient` / `enableDirectionalAmbient`,
  `setInstanced`, `setTerrainDecoration`, `setSway`, `setLit`, `setUnlit`.
- `update(time)` drives sprite frames and procedural maps (`isUpdatable`, e.g.
  `WetWaterTexture`).
- `UniformsLib.lights` is deliberately **not** merged — `DynamicLight` is not a
  `THREE.Light`, saving ~19 uniforms.

[transform-stage.ts](../src/materials/mesh-static-material/transform-stage.ts) —
`buildTransformStage("pan" | "rotate" | "oscillate", transform)` produces a superset struct
(a GLSL struct cannot be a union); `padTransformStages` pads to `MAX_TRANSFORM_STAGES = 2`
(must match the shader) because three's uniform-array setter throws on a short array.

### `MeshTerrainMaterial` (`extends ShaderMaterial`)

[mesh-terrain-material.ts](../src/materials/mesh-terrain-material/mesh-terrain-material.ts) —
does **string codegen on the fragment shader** at construct time: it finds
`#pragma params_include_layers` / `#pragma include_layers` and splices in per-layer
`texture2D(...)` + `addLayer(...)` calls. All layer maps and masks are packed into two
`highp sampler2DArray`s by
[terrain-layer-array.ts](../src/materials/mesh-terrain-material/terrain-layer-array.ts)
(`buildTerrainLayerArray` → `DataArrayTexture`, mip-0 bytes or S3TC-decoded, `nextPow2` +
nearest resample, capped at `MAX_LAYER_SIZE = 512`, `WeakRef`-cached). This keeps the
fragment stage at exactly two texture units regardless of layer count, avoiding a link
failure from overrunning `MAX_TEXTURE_IMAGE_UNITS`.

### `ParticleMaterial` / `AnimatedParticleMaterial` / `InstancedParticleMaterial`

[particle-material.ts](../src/materials/particle-material/particle-material.ts),
[instanced-particle-material.ts](../src/materials/particle-material/instanced-particle-material.ts).

- `getPartcileBlendingSettings(blendingMode)` is a **particle-specific** blend table (distinct
  from `AActor::Style`): `normal` → NoBlending, `alpha` → NormalBlending,
  `modulate`/`translucent`/`alphaModulate`/`darken`/`brighten` → CustomBlending with
  `blendSrcAlpha = Zero`, `blendDstAlpha = One` (the render target is a transparent
  compositing intermediate). Additive modes set `USE_ADDITIVE_FOG`.
- `fixParticleTextureSampling` forces `ClampToEdgeWrapping` and optionally disables mips for
  atlas sprites.
- `InstancedParticleMaterial` adds a `particleProjectionNormal` uniform and a
  `USE_FIXED_NORMAL` define for `spriteDirection === "normal"`; `FrontSide` for camera
  billboards.

### `MeshEmitterMaterial`

[mesh-emitter-material.ts](../src/materials/mesh-emitter-material/mesh-emitter-material.ts) —
for `MeshEmitter` particles. Simple `diffuse` / `opacity` / `map` uniforms, sprite-sheet
`update(time)`, `applyBlending` (normal / brighten / translucent / modulate / darken).

### `WetWaterTexture`

[wet-water-texture.ts](../src/materials/wet-water-texture.ts) — `extends DataTexture`,
`isUpdatable = true`. A CPU fractal water simulation ported from `UnFractal.h`: a
half-x-resolution byte height field with a row-parity ping-pong wave automaton, an 8-bit sine
phase table, ~15 drop types (`fixedDepth`, `rainDrops`, `leakyTap`, `whirlyThing`, …), and a
displacement bitmap applied as `out[u] = src[(u + disp[u]) & umask]`. Steps at ~30 Hz, driven
by `MeshStaticMaterial.update()`.
