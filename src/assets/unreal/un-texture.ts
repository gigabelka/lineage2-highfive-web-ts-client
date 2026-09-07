import { FMipmap } from "./un-mipmap";
import decompressDDS from "../dds/dds-decode";
import ETextureFormat, { ETexturePixelFormat } from "./un-tex-format";
import FColor from "./un-color";
import { BufferValue } from "@l2js/core";
import getTypedArrayConstructor from "@client/utils/typed-arrray-constructor";
import UMaterial from "./un-material";
import FArray from "@l2js/core/src/unreal/un-array";

/*

    1000000000 (512)
    0100000000 (256)
    0010000000 (128)
    0001000000 ( 64)
    0000100000 ( 32)
*/

enum ETexClampMode {
    TC_Wrap = 0x00,
    TC_Clamp = 0x01,
}

abstract class UTexture extends UMaterial {
    declare public readonly palette: GA.UPlatte;
    declare public readonly internalTime: number[];
    declare public readonly format: ETextureFormat/* = ETextureFormat.TEXF_RGBA8*/;

    declare public readonly width: number;
    declare public readonly height: number;
    declare public readonly bitsW: number; // texture size log2 (number of bits in size value)
    declare public readonly bitsH: number;
    declare public readonly wrapS: ETexClampMode;
    declare public readonly wrapT: ETexClampMode;

    declare public readonly clampedW: number; // clamped width
    declare public readonly clampedH: number;

    declare public readonly maxColor: FColor;
    declare public readonly mipZero: FColor;

    declare public readonly minFrameRate: number;
    declare public readonly maxFrameRate: number;
    declare public readonly totalFrameNum: number;
    declare public readonly animNext: UTexture;

    declare public readonly isTwoSided: boolean;
    declare public readonly isAlphaTexture: boolean;
    declare public readonly isMasked: boolean;

    declare protected lodSet: number;

    public readonly mipmaps = new FArray(FMipmap);

    protected getPropertyMap() {
        return Object.assign({}, super.getPropertyMap(), {
            "Palette": "palette",

            "Format": "format",
            "InternalTime": "internalTime",

            "VSize": "height",
            "USize": "width",

            "UBits": "bitsW",
            "VBits": "bitsH",
            "UClamp": "clampedW",
            "VClamp": "clampedH",

            "UClampMode": "wrapS",
            "VClampMode": "wrapT",

            "MaxColor": "maxColor",

            "MipZero": "mipZero",

            "MinFrameRate": "minFrameRate",
            "MaxFrameRate": "maxFrameRate",
            "TotalFrameNum": "totalFrameNum",
            "AnimNext": "animNext",

            "bTwoSided": "isTwoSided",
            "bAlphaTexture": "isAlphaTexture",
            "bMasked": "isMasked",

            "LODSet": "lodSet",
        });
    }

    public isTransparent() { return this.isAlphaTexture || this.isMasked; }

    public getTextureSize(): { width: number; height: number; } | null {
        return { width: this.width, height: this.height };
    }

    public doLoad(pkg: C.APackage, exp: C.UExport) {    // 2785
        super.doLoad(pkg, exp);

        this.readHead = pkg.tell();

        const verArchive = pkg.header.getArchiveFileVersion();
        const verLicense = pkg.header.getLicenseeVersion();

        let someFlag = 0;

        if (verArchive >= 123 && verLicense >= 16) {
            someFlag = pkg.read("uint32");

            if (someFlag !== 0) {
                // TODO: обработать ненулевой someFlag
            }
        }

        if (verArchive < 84) {

            throw new Error("Don't know what to do");
        }

        // High Five licensee bit 0x100: the export prepends a variable-length block before
        // the mip array — a run of header ints (one is a float 5.0) plus a self-path
        // FString (and, on FX_E_T.utx water surfaces, an embedded pixel-shader-microcode
        // FString) — then a completely ordinary `FArray<FMipmap>` that runs to the export
        // end (readTail). Rather than model the prepended block we locate the mip array by
        // scanning for the byte offset at which walking an `FArray<FMipmap>` consumes
        // exactly up to readTail with mip 0 reporting this texture's USize/VSize (see
        // loadPrependedMipArray). Falls back to the graceful empty-material skip if no
        // offset validates (e.g. a genuinely unmodelled FX layout).
        if ((someFlag & 0x100) !== 0) {
            const startPos = pkg.tell();
            const found = this.loadPrependedMipArray(pkg, startPos);

            if (found) {
                this.readHead = pkg.tell();
                console.assert(this.readTail === this.readHead);
                return this;
            }

            pkg.seek(startPos, "set");
            this.skipRemaining = true;
            return this;
        }

        // Older licensee textures (e.g. verLicense 33 bitmaps embedded in pre-C4 .usx
        // packages like Field_Deco_Artifact_S.usx) use a mip layout we don't model:
        // there's no 0x100 flag, but an extra pre-mip block still sits between the
        // properties and the mip array, so FArray.load reads a bogus count (zero, or
        // garbage that overruns the buffer) and leaves the pixel payload unconsumed.
        // Rather than assert-crash the whole sector decode, fall back to the same
        // graceful skip the 0x100 path uses - decodeTexture() returns an empty
        // material when mips=0.
        const mipArrayStart = pkg.tell();
        let mipLoadError: unknown = null;

        try {
            this.mipmaps.load(pkg);
        } catch (e) {
            mipLoadError = e;
        }

        this.readHead = pkg.tell();

        if (mipLoadError || (this.mipmaps.length === 0 && this.readTail - this.readHead > 0)) {
            console.warn(
                `UTexture '${this.objectName}' (${pkg.path}, verLicense ${verLicense}): ` +
                `unmodelled mip layout${mipLoadError ? ` (${mipLoadError})` : ""}, ` +
                `${this.readTail - mipArrayStart} bytes unread - skipping`,
            );
            this.mipmaps.length = 0;
            pkg.seek(mipArrayStart, "set");
            this.skipRemaining = true;
            return this;
        }

        console.assert(this.readTail === this.readHead);

        return this;
    }

    protected getTexturePixelFormat(): ETexturePixelFormat {
        switch (this.format.valueOf()) {
            case ETextureFormat.TEXF_P8: return ETexturePixelFormat.TPF_P8;
            case ETextureFormat.TEXF_DXT1: return ETexturePixelFormat.TPF_DXT1;
            // case ETextureFormat.TEXF_RGB8: return ETexturePixelFormat.TPF_RGB8;
            case ETextureFormat.TEXF_RGBA8: return ETexturePixelFormat.TPF_BGRA8;
            case ETextureFormat.TEXF_DXT3: return ETexturePixelFormat.TPF_DXT3;
            case ETextureFormat.TEXF_DXT5: return ETexturePixelFormat.TPF_DXT5;
            // case ETextureFormat.TEXF_L8: return ETexturePixelFormat.TPF_G8;
            // case ETextureFormat.TEXF_CxV8U8: return ETexturePixelFormat.TPF_V8U8_2;
            // case ETextureFormat.TEXF_DXT5N: return ETexturePixelFormat.TPF_DXT5N;
            // case ETextureFormat.TEXF_3DC: return ETexturePixelFormat.TPF_BC5;
            case ETextureFormat.TEXF_G16: return ETexturePixelFormat.TPF_G16;
            default: throw new Error(`Unknown UE2 pixel format: ${this.format}`);
        }
    }

    // High Five 0x100 textures (see doLoad): the `FArray<FMipmap>` is preceded by a
    // variable-length prepended block. Find the offset where the mip array begins
    // (locatePrependedMipArray), seek there and load it for real. Returns true and leaves
    // `pkg` positioned at readTail on success.
    private loadPrependedMipArray(pkg: C.APackage, startPos: number): boolean {
        const readTail = this.readTail;
        const avail = readTail - startPos;

        if (avail <= 12 || !(this.width > 0) || !(this.height > 0)) return false;

        const dv = pkg.readPrimitive(startPos, avail) as DataView;
        const off = locatePrependedMipArray(dv, startPos, readTail, this.width | 0, this.height | 0);

        if (off < 0) return false;

        pkg.seek(startPos + off, "set");
        this.mipmaps.load(pkg);

        return this.mipmaps.length >= 1 && pkg.tell() === readTail;
    }

    protected decodeTexture(library: GD.DecodeLibrary): GD.ITextureDecodeInfo | GD.IBaseMaterialDecodeInfo {
        const totalMipCount = this.mipmaps.length;

        if (totalMipCount === 0) return { materialType: "empty" };

        const loadMipmaps = library.loadMipmaps && totalMipCount > 1;

        const firstMipmap = this.mipmaps[0];
        const lastMipmap = loadMipmaps ? this.mipmaps[totalMipCount - 1] : firstMipmap;
        const insertMipmap = loadMipmaps ? lastMipmap.sizeW !== 1 || lastMipmap.sizeH !== 1 : false;
        const levelsToInsert = loadMipmaps ? Math.log2(Math.max(lastMipmap.sizeW, lastMipmap.sizeH)) : 0;

        const embededMipCount = loadMipmaps ? totalMipCount : 1;
        const mipCount = loadMipmaps ? totalMipCount + levelsToInsert : 1;

        const format = this.getTexturePixelFormat();

        let blockSize;

        switch (format) {
            case ETexturePixelFormat.TPF_DXT1: blockSize = 8; break;
            case ETexturePixelFormat.TPF_DXT3: blockSize = 16; break;
            case ETexturePixelFormat.TPF_DXT5: blockSize = 16; break;
            case ETexturePixelFormat.TPF_DXT5N: blockSize = 16; break;
            default: blockSize = 4; break;
        }

        let byteOffset = 0;
        let imSize = firstMipmap.getByteLength();

        for (let i = 1; i < embededMipCount; i++) {
            imSize += (this.mipmaps[i] as FMipmap).getByteLength();
        }

        for (let i = levelsToInsert - 1, w = lastMipmap.sizeW, h = lastMipmap.sizeH; i >= 0; i--) {
            w = Math.max(1, w / 2);
            h = Math.max(1, h / 2);

            const dataLength = Math.max(4, w) / 4 * Math.max(4, h) / 4 * blockSize;

            imSize += dataLength;
        }

        const data = new Uint8Array(imSize);

        firstMipmap.getImageBuffer(data, 0);
        byteOffset += firstMipmap.getByteLength();

        for (let i = 1, len = embededMipCount; i < len; i++) {
            const mipmap = this.mipmaps[i] as FMipmap;

            mipmap.getImageBuffer(data, byteOffset);
            byteOffset += mipmap.getByteLength();
        }

        if (insertMipmap) {
            const lastSliceSize = lastMipmap.getByteLength();
            const pixelCount = lastSliceSize / 4;

            const color = new Uint8Array(4);

            for (let i = byteOffset - lastSliceSize; i < byteOffset; i += 4) {
                color[0] += data[i + 0];
                color[1] += data[i + 1];
                color[2] += data[i + 2];
                color[3] += data[i + 3];
            }

            color[0] = Math.round(color[0] / pixelCount);
            color[1] = Math.round(color[1] / pixelCount);
            color[2] = Math.round(color[2] / pixelCount);
            color[3] = Math.round(color[3] / pixelCount);

            for (let j = levelsToInsert - 1, w = lastMipmap.sizeW, h = lastMipmap.sizeH; j >= 0; j--) {
                w = Math.max(1, w / 2);
                h = Math.max(1, h / 2);

                const dataLength = Math.max(4, w) / 4 * Math.max(4, h) / 4 * blockSize;

                for (let i = 0; i < blockSize; i += 4) {
                    data[byteOffset + i + 0] = color[0];
                    data[byteOffset + i + 1] = color[1];
                    data[byteOffset + i + 2] = color[2];
                    data[byteOffset + i + 3] = color[3];
                }

                byteOffset = byteOffset + dataLength;
            }
        }

        const width = firstMipmap.sizeW, height = firstMipmap.sizeH;
        let decodedBuffer: ArrayBuffer;
        let textureType: GD.DecodableTexture_T;

        switch (format) {
            case ETexturePixelFormat.TPF_DXT1:
            case ETexturePixelFormat.TPF_DXT3:
            case ETexturePixelFormat.TPF_DXT5:
            case ETexturePixelFormat.TPF_DXT5N:
                textureType = "dds";
                decodedBuffer = decompressDDS(format, mipCount, width, height, data);
                break;
            case ETexturePixelFormat.TPF_G16:
                textureType = "g16";
                decodedBuffer = data.buffer;
                break;
            case ETexturePixelFormat.TPF_BGRA8:
            case ETexturePixelFormat.TPF_RGBA8:
            case ETexturePixelFormat.TPF_P8: {
                textureType = "rgba";
                if (!this.palette) {
                    decodedBuffer = data.buffer;

                    if (format === ETexturePixelFormat.TPF_BGRA8) {
                        const view = new Uint8Array(decodedBuffer);

                        for (let i = 0, len = view.length; i < len; i += 4) {
                            const r = view[i], b = view[i + 2];

                            view[i] = b;
                            view[i + 2] = r;
                        }

                        decodedBuffer = view.buffer;
                    }
                } else {
                    const buff = new Uint8Array(imSize * 4);

                    for (let i = 0, len = imSize; i < len; i++) {
                        const c = this.palette.loadSelf().colors.getElem(data[i]);
                        const ii = i * 4;

                        if (format === ETexturePixelFormat.TPF_BGRA8) {
                            buff[ii + 0] = c.b;
                            buff[ii + 1] = c.g;
                            buff[ii + 2] = c.r;
                            buff[ii + 3] = c.a;
                        } else {
                            buff[ii + 0] = c.r;
                            buff[ii + 1] = c.g;
                            buff[ii + 2] = c.b;
                            buff[ii + 3] = c.a;
                        }
                    }

                    decodedBuffer = buff.buffer;
                }
            } break;
            default: throw new Error(`Unsupported texture format: ${format}`);
        }

        return {
            materialType: "texture",
            textureType,
            name: this.uuid,
            buffer: decodedBuffer,
            width,
            height,
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            useMipmaps: mipCount > 0,
            twoSided: this.isTwoSided,
            isMasked: this.isMasked,
            isAlphaTexture: this.isAlphaTexture
        } as GD.ITextureDecodeInfo;
    }

    public getDecodeInfo(builder: GD.DecodeLibraryBuilder): GD.IBaseMaterialDecodeInfo | string {
        if (typeof this.totalFrameNum === "number" && this.totalFrameNum > 1) {
            const sprites: GD.ITextureDecodeInfo[] = [];

            let tex: UTexture = this;

            for (let i = 0, len = this.totalFrameNum; i < len && tex; i++) {
                sprites.push(tex.loadSelf().decodeTexture(builder.library) as GD.ITextureDecodeInfo);
                tex = tex.animNext;
            }

            return {
                name: `Sprite_${this.uuid}`,
                materialType: "sprite",
                sprites,
                framerate: 1000 / this.maxFrameRate
            } as GD.IAnimatedSpriteDecodeInfo;
        }

        return this.decodeTexture(builder.library);
    }
}

export default UTexture;
export { ETexClampMode, locatePrependedMipArray };

/**
 * FCompactIndex (Unreal) decode: byte 0 keeps the sign in bit 7 and six value bits in
 * bits 0-5, and uses bit 6 to flag a continuation byte; each continuation byte then
 * contributes seven value bits and chains via its own bit 7. Mirrors BufferValue's
 * "compat32" decode in @l2js/core. Returns [value, bytesConsumed].
 */
function readCompactIndex(dv: DataView, pos: number, end: number): [value: number, len: number] {
    const b0 = dv.getUint8(pos);
    let value = b0 & 0x3f;
    let len = 1;

    if (b0 & 0x40) {
        let shift = 6;
        let b: number;
        do {
            if (len >= 5 || pos + len >= end) break;
            b = dv.getUint8(pos + len);
            value |= (b & 0x7f) << shift;
            shift += 7;
            len++;
        } while (b & 0x80);
    }

    return [value >>> 0, len];
}

/**
 * Locate the `FArray<FMipmap>` inside a High Five 0x100 texture export, past its
 * variable-length prepended block (see `UTexture.doLoad`). `dv` spans the export bytes
 * from `startPos` (a pkg.tell()-space offset, right after the 0x100 flag) to `readTail`
 * (the export end); `width`/`height` are the texture's declared USize/VSize.
 *
 * Scans every byte offset and returns the first at which walking an `FArray<FMipmap>` —
 *   [compat32 mipCount] then per mip
 *   [int32 skipOffset][compat32 byteCount][byteCount payload][int32 USize][int32 VSize][int8 UBits][int8 VBits]
 * — consumes exactly up to `readTail` with mip 0 reporting `width`/`height` and every
 * lazy-array `skipOffset` matching the post-payload position. That triple check
 * (lands-on-tail + size match + skip markers) makes a false positive inside the pixel
 * payload not a practical concern. Returns -1 when nothing validates.
 */
function locatePrependedMipArray(
    dv: DataView,
    startPos: number,
    readTail: number,
    width: number,
    height: number,
): number {
    const avail = readTail - startPos;

    if (avail <= 12 || !(width > 0) || !(height > 0)) return -1;

    const walk = (off: number): number => {
        const [mipCount, mcLen] = readCompactIndex(dv, off, avail);
        if (mipCount < 1 || mipCount > 20) return -1;

        let pos = off + mcLen;

        for (let k = 0; k < mipCount; k++) {
            if (pos + 4 > avail) return -1;
            const skipOffset = dv.getInt32(pos, true);
            pos += 4;

            const [byteCount, clen] = readCompactIndex(dv, pos, avail);
            pos += clen + byteCount; // compat32 + raw pixel payload

            if (skipOffset !== startPos + pos) return -1;
            if (pos + 10 > avail) return -1;

            const sizeW = dv.getInt32(pos, true);
            const sizeH = dv.getInt32(pos + 4, true);
            pos += 10; // USize, VSize, UBits, VBits

            if (sizeW < 1 || sizeH < 1) return -1;
            if (k === 0 && (sizeW !== width || sizeH !== height)) return -1;
        }

        return pos;
    };

    for (let off = 0; off + 12 <= avail; off++) {
        if (dv.getInt32(off + 1, true) <= startPos + off + 5) continue; // cheap reject
        if (walk(off) === avail) return off;
    }

    return -1;
}

function createPlane(width: number, height: number, widthSegments: number, heightSegments: number) {
    const width_half = width / 2;
    const height_half = height / 2;

    const gridX = Math.floor(widthSegments);
    const gridY = Math.floor(heightSegments);

    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;

    const segment_width = width / gridX;
    const segment_height = height / gridY;

    //

    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    for (let iy = 0; iy < gridY1; iy++) {

        const y = iy * segment_height - height_half;

        for (let ix = 0; ix < gridX1; ix++) {

            const x = ix * segment_width - width_half;

            vertices.push(x, - y, 0);

            normals.push(0, 0, 1);

            uvs.push(ix / gridX);
            uvs.push(1 - (iy / gridY));

        }

    }

    for (let iy = 0; iy < gridY; iy++) {

        for (let ix = 0; ix < gridX; ix++) {

            const a = ix + gridX1 * iy;
            const b = ix + gridX1 * (iy + 1);
            const c = (ix + 1) + gridX1 * (iy + 1);
            const d = (ix + 1) + gridX1 * iy;

            indices.push(a, b, d);
            indices.push(b, c, d);

        }
    }

    const TypedIndicesArray = getTypedArrayConstructor(indices.length / 3);

    return {
        indices: new TypedIndicesArray(indices),
        positions: new Float32Array(vertices),
        uvs: new Float32Array(uvs),
        normals: new Float32Array(normals)
    };
}
