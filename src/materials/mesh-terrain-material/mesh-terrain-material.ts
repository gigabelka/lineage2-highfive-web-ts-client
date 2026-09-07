import { ShaderMaterial, IUniform, Uniform, Color, Matrix3, FrontSide } from "three";

import VERTEX_SHADER from "./shader/shader-mesh-terrain.vs";
import FRAGMENT_SHADER from "./shader/shader-mesh-terrain.fs";
import { appendGlobalUniforms } from "../global-uniforms";
import buildTerrainLayerArray from "./terrain-layer-array";

class MeshTerrainMaterial extends ShaderMaterial {
    // @ts-ignore
    constructor(info: MeshTerrainMaterialParameters) {
        const defines: Record<string, any> = {
            USE_FOG: "",
            USE_UV_TEXTURE: "",
            UV_COUNT: info.uvs.size.y,
            MASK_UV_INDEX: info.uvs.size.y - 1
        };

        // one texture image unit per layer map + one per mask overruns
        // MAX_TEXTURE_IMAGE_UNITS(16) on segments with many layers and the program
        // fails to link. Pack every layer into a sampler2DArray so the fragment
        // shader binds exactly two units regardless of layer count.
        const validLayers = info.layers
            .map((layer, index) => ({ index, map: layer.map, alphaMap: layer.alphaMap }))
            .filter(layer => layer.map && layer.alphaMap);

        const uniforms: Record<string, IUniform> = appendGlobalUniforms({
            alphaTest: new Uniform(1e-3),
            diffuse: new Uniform(new Color(1, 1, 1)),
            opacity: new Uniform(1),
            uvTransform: new Uniform(new Matrix3()),
            transformSpecular: new Uniform(null),
            uvs: new Uniform(info.uvs),
            terrainLayerMaps: new Uniform(buildTerrainLayerArray(validLayers.map(l => l.map.uniforms?.map?.texture ?? null))),
            terrainLayerMasks: new Uniform(buildTerrainLayerArray(validLayers.map(l => l.alphaMap.uniforms?.map?.texture ?? null)))
        });

        const splitFragmentShader = FRAGMENT_SHADER.split("\n");

        const pragmaSearchParams = "#pragma params_include_layers";
        const pragmaSearch = "#pragma include_layers";

        const paramsIndex = splitFragmentShader.findIndex(x => x.includes(pragmaSearchParams));
        const wsParams = " ".repeat(splitFragmentShader[paramsIndex].indexOf(pragmaSearchParams));

        const pragmaLayerIndex = splitFragmentShader.findIndex(x => x.includes(pragmaSearch));
        const ws = " ".repeat(splitFragmentShader[pragmaLayerIndex].indexOf(pragmaSearch));

        const paramsCode = [
            `${wsParams}uniform highp sampler2DArray terrainLayerMaps;`,
            `${wsParams}uniform highp sampler2DArray terrainLayerMasks;`
        ];

        const layerCode: string[] = [];

        validLayers.forEach((layer, slice) => {
            defines[`USE_LAYER_${layer.index}`] = "";
            defines[`USE_LAYER_${layer.index}_OPACITY`] = "";

            // masks all share MASK_UV_INDEX; each layer map keeps its own UV set (index + 1)
            layerCode.push(`${ws}layerMask = texture2D(terrainLayerMasks, vec3(vUv[MASK_UV_INDEX], ${slice}.0));`);
            layerCode.push(`${ws}layer = vec4(texture2D(terrainLayerMaps, vec3(vUv[${layer.index + 1}], ${slice}.0)).rgb, layerMask.r);`);
            layerCode.push(slice === 0
                ? `${ws}texelDiffuse = layer;`
                : `${ws}texelDiffuse = addLayer(layer, texelDiffuse);`);
            layerCode.push("");
        });

        if (validLayers.length === 0) {
            // keep the generated shader well-formed for a segment with no usable layers
            layerCode.push(`${ws}layerMask = vec4(1.0);`);
            layerCode.push(`${ws}layer = texelDiffuse;`);
        }

        splitFragmentShader.splice(paramsIndex, 1, ...paramsCode);

        const layerIndex = splitFragmentShader.findIndex(x => x.includes(pragmaSearch));
        splitFragmentShader.splice(layerIndex, 1, ...layerCode);

        const fragmentShader = splitFragmentShader.join("\n");

        super({
            defines,
            uniforms,
            vertexShader: VERTEX_SHADER,
            fragmentShader: fragmentShader,
            side: FrontSide
        });
    }
}

export default MeshTerrainMaterial;

type MeshTerrainMaterialParameters = {
    uvs: GD.MapData_T,
    layers: { map: GD.IDecodedParameter, alphaMap: GD.IDecodedParameter }[]
};
