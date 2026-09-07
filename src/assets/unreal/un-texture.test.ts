import { describe, expect, it } from "vitest";
import { locatePrependedMipArray } from "./un-texture";

// FCompactIndex encoder matching @l2js/core's "compat32" decode (bit 6 of byte 0 flags a
// continuation byte, bit 7 is the sign; continuation bytes chain via their own bit 7).
function encodeCompat(value: number): number[] {
    const neg = value < 0;
    let v = Math.abs(value) >>> 0;

    let b0 = (neg ? 0x80 : 0) | (v & 0x3f);
    v = Math.floor(v / 64);
    if (v !== 0) b0 |= 0x40;

    const bytes = [b0];

    while (v !== 0) {
        let b = v & 0x7f;
        v = Math.floor(v / 128);
        if (v !== 0) b |= 0x80;
        bytes.push(b);
    }

    return bytes;
}

/**
 * Build one High Five 0x100 texture export body: `prependLen` bytes of junk, then a real
 * `FArray<FMipmap>` for the given mips, ending exactly at readTail. Returns the DataView
 * plus the tell()-space `startPos` / `readTail` and the true mip-array `offset`.
 */
function buildExport(mips: { w: number; h: number; payload: number }[], prependLen: number, startPos = 4096) {
    const bytes: number[] = [];
    const putU8 = (v: number) => bytes.push(v & 0xff);
    const putI32 = (v: number) => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, v, true);
        bytes.push(...b);
    };

    // prepend: 0xFF filler - its int32s read as -1 so the scan's cheap-reject skips them
    for (let i = 0; i < prependLen; i++) putU8(0xff);

    const offset = bytes.length;
    encodeCompat(mips.length).forEach(putU8);

    for (const mip of mips) {
        const skipPatchAt = bytes.length;
        putI32(0); // skipOffset placeholder
        encodeCompat(mip.payload).forEach(putU8);
        for (let i = 0; i < mip.payload; i++) putU8(i & 0xff);

        // skipOffset is the pkg.tell()-space position right past the payload
        const afterPayload = startPos + bytes.length;
        const patch = new Uint8Array(4);
        new DataView(patch.buffer).setInt32(0, afterPayload, true);
        bytes[skipPatchAt] = patch[0];
        bytes[skipPatchAt + 1] = patch[1];
        bytes[skipPatchAt + 2] = patch[2];
        bytes[skipPatchAt + 3] = patch[3];

        putI32(mip.w);
        putI32(mip.h);
        putU8(Math.log2(mip.w) | 0);
        putU8(Math.log2(mip.h) | 0);
    }

    const u8 = new Uint8Array(bytes);
    return {
        dv: new DataView(u8.buffer),
        startPos,
        readTail: startPos + u8.length,
        offset,
    };
}

describe("locatePrependedMipArray", () => {
    it("finds the mip array after a variable-length prepended block (single mip)", () => {
        const { dv, startPos, readTail, offset } = buildExport([{ w: 32, h: 32, payload: 512 }], 205);

        expect(locatePrependedMipArray(dv, startPos, readTail, 32, 32)).toBe(offset);
    });

    it("finds the mip array with a full mip chain and multi-byte compact indices", () => {
        const mips = [
            { w: 256, h: 256, payload: 32768 },
            { w: 128, h: 128, payload: 8192 },
            { w: 64, h: 64, payload: 2048 },
            { w: 32, h: 32, payload: 512 },
            { w: 16, h: 16, payload: 128 },
        ];
        const { dv, startPos, readTail, offset } = buildExport(mips, 312);

        expect(locatePrependedMipArray(dv, startPos, readTail, 256, 256)).toBe(offset);
    });

    it("returns -1 when mip 0 does not match the declared texture size", () => {
        const { dv, startPos, readTail } = buildExport([{ w: 32, h: 32, payload: 512 }], 205);

        expect(locatePrependedMipArray(dv, startPos, readTail, 64, 64)).toBe(-1);
    });

    it("returns -1 when the mip array does not run exactly to the export end", () => {
        const { dv, startPos, readTail } = buildExport([{ w: 32, h: 32, payload: 512 }], 205);

        // one byte short of the true tail -> no offset can consume up to `avail`
        expect(locatePrependedMipArray(dv, startPos, readTail - 1, 32, 32)).toBe(-1);
    });

    it("returns -1 for a degenerate region", () => {
        const dv = new DataView(new Uint8Array(8).buffer);

        expect(locatePrependedMipArray(dv, 0, 8, 32, 32)).toBe(-1);
    });
});
