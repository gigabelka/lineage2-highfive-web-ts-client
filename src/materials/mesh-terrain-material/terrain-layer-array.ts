import {
    DataArrayTexture, RGBAFormat, UnsignedByteType, RepeatWrapping,
    LinearFilter, LinearMipmapLinearFilter,
    RGBA_S3TC_DXT1_Format, RGB_S3TC_DXT1_Format, RGBA_S3TC_DXT3_Format, RGBA_S3TC_DXT5_Format
} from "three";
import { dxt1ToRgba, dxt3ToRgba, dxt5ToRgba } from "@client/assets/decoders/dxt-decode";

// A terrain segment binds one sampler per layer map + one per layer mask. Past ~7
// layers that overruns MAX_TEXTURE_IMAGE_UNITS(16) and the program fails to link.
// Packing every layer into a sampler2DArray drops the fragment cost to two units
// regardless of layer count.

type Rgba_T = { data: Uint8Array, width: number, height: number };

const WHITE: Rgba_T = { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 };

// terrain layer textures are 256 in the C4 assets; cap so a pathological segment
// can't allocate hundreds of MB for the merged buffer
const MAX_LAYER_SIZE = 512;

const WeakRefCtor: (typeof WeakRef) | undefined = (globalThis as any).WeakRef;
const cache = new Map<string, { deref(): DataArrayTexture | undefined }>();

// Pull an RGBA byte buffer out of whatever texture-decoder produced for a layer:
// DataTexture keeps its pixels on .image.data, CompressedTexture only carries S3TC
// blocks so mip 0 is decoded here with the same helpers the decode worker uses.
function readRgba(texture: THREE.Texture | null | undefined): Rgba_T {
    const image: any = texture?.image;

    if (image && image.data && image.width && image.height) {
        const view: ArrayLike<number> = image.data;
        const px = image.width * image.height;
        const channels = Math.max(1, Math.round((view as any).length / px));
        const isFloat = view instanceof Float32Array;
        const out = new Uint8Array(px * 4);

        const sample = (i: number): number => {
            const v = view[i] ?? 0;
            return isFloat ? Math.max(0, Math.min(255, Math.round(v * 255))) : v;
        };

        for (let i = 0; i < px; i++) {
            const s = i * channels, d = i * 4;

            if (channels >= 3) {
                out[d] = sample(s); out[d + 1] = sample(s + 1); out[d + 2] = sample(s + 2);
                out[d + 3] = channels >= 4 ? sample(s + 3) : 255;
            } else {
                // r / rg mask textures: broadcast red into rgb so a .r read still works
                const r = sample(s);
                out[d] = out[d + 1] = out[d + 2] = r;
                out[d + 3] = channels === 2 ? sample(s + 1) : 255;
            }
        }

        return { data: out, width: image.width, height: image.height };
    }

    if ((texture as any)?.isCompressedTexture && (texture as any).mipmaps?.length) {
        const mip = (texture as any).mipmaps[0];
        const format = (texture as any).format;
        let rgba: Uint8Array | null = null;

        if (format === RGBA_S3TC_DXT1_Format || format === RGB_S3TC_DXT1_Format) rgba = dxt1ToRgba(mip.width, mip.height, mip.data);
        else if (format === RGBA_S3TC_DXT3_Format) rgba = dxt3ToRgba(mip.width, mip.height, mip.data);
        else if (format === RGBA_S3TC_DXT5_Format) rgba = dxt5ToRgba(mip.width, mip.height, mip.data);

        if (rgba) return { data: rgba, width: mip.width, height: mip.height };
    }

    return WHITE;
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// nearest-neighbour resample - layers tile and are viewed from a distance, a box
// filter is not worth the cost here
function resample(src: Rgba_T, dw: number, dh: number): Uint8Array {
    if (src.width === dw && src.height === dh) return src.data;

    const dst = new Uint8Array(dw * dh * 4);

    for (let y = 0; y < dh; y++) {
        const sy = Math.min(src.height - 1, (y * src.height / dh) | 0);
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(src.width - 1, (x * src.width / dw) | 0);
            const si = (sy * src.width + sx) * 4;
            const di = (y * dw + x) * 4;
            dst[di] = src.data[si];
            dst[di + 1] = src.data[si + 1];
            dst[di + 2] = src.data[si + 2];
            dst[di + 3] = src.data[si + 3];
        }
    }

    return dst;
}

function buildTerrainLayerArray(textures: (THREE.Texture | null)[]): DataArrayTexture {
    const key = textures.map(t => t?.uuid ?? "-").join(",");
    const cached = cache.get(key)?.deref();

    if (cached) return cached;
    if (!cached) cache.delete(key);

    const slices = textures.map(readRgba);

    let w = 1, h = 1;
    for (const s of slices) { w = Math.max(w, s.width); h = Math.max(h, s.height); }

    w = Math.min(MAX_LAYER_SIZE, nextPow2(w));
    h = Math.min(MAX_LAYER_SIZE, nextPow2(h));

    const depth = Math.max(1, slices.length);
    const stride = w * h * 4;
    const merged = new Uint8Array(stride * depth);

    slices.forEach((s, i) => merged.set(resample(s, w, h), i * stride));

    const array = new DataArrayTexture(merged, w, h, depth);

    array.format = RGBAFormat;
    array.type = UnsignedByteType;
    array.wrapS = array.wrapT = RepeatWrapping;
    array.magFilter = LinearFilter;
    array.minFilter = LinearMipmapLinearFilter;
    array.generateMipmaps = true;
    array.needsUpdate = true;

    if (WeakRefCtor) cache.set(key, new WeakRefCtor(array));
    else cache.set(key, { deref: () => array });

    return array;
}

export default buildTerrainLayerArray;
