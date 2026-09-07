import { ShaderChunk } from "three";
import Chunk_L2FogFragment from "./l2_fog_fragment.glsl";

// `@types/three` types `ShaderChunk` as a sealed record of the built-in chunks;
// custom chunk keys need the widened view.
const chunks = ShaderChunk as unknown as Record<string, string>;

chunks.l2_fog_fragment = chunks.l2_fog_fragment ?? Chunk_L2FogFragment;

// three.js removed/renamed these built-in chunks after r146 (the version this
// project's custom `.fs` files were written against):
//   - `lightmap_fragment`  -> folded into `lights_fragment_maps` (r150)
//   - `output_fragment`     -> renamed `opaque_fragment` (r154)
//   - `encodings_fragment`  -> renamed `colorspace_fragment` (r152)
// Our shaders (`shader-mesh-static.fs`, `shader-mesh-terrain.fs`,
// `mesh-emitter.fs`) still `#include` the old names, so re-register them here
// with their r146 bodies to keep behaviour identical across the upgrade.

chunks.lightmap_fragment = chunks.lightmap_fragment ?? /* glsl */ `
#ifdef USE_LIGHTMAP

	vec4 lightMapTexel = texture2D( lightMap, vUv2 );
	vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;

	// factor of PI kept to match pre-r150 (PHYSICALLY_CORRECT_LIGHTS undefined) output
	lightMapIrradiance *= PI;

	reflectedLight.indirectDiffuse += lightMapIrradiance;

#endif
`;

chunks.output_fragment = chunks.output_fragment ?? chunks.opaque_fragment;

chunks.encodings_fragment = chunks.encodings_fragment ?? chunks.colorspace_fragment;