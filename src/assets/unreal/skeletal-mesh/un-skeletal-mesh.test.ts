import { describe, expect, it } from "vitest";
import { UEncodedFile } from "@l2js/core";
import { FStaticModelLOD } from "./un-skeletal-mesh";

// FCompactIndex encoder matching @l2js/core's "compat32" decode (see un-texture.test.ts).
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

/** Minimal readable `APackage` stand-in - `FStaticModelLOD.load` and everything it calls only
 * ever touch `read`/`seek`/`tell`, all implemented on `UEncodedFile` itself. */
class TestPackage extends UEncodedFile {
  public constructor(bytes: Uint8Array) {
    super("test");
    (this as any).buffer = bytes.buffer;
    (this as any).contentOffset = 0;
    (this as any).offset = 0;
    (this as any).isReadable = true;
  }
}

/**
 * Builds an empty `FStaticModelLOD` body (every array/section count 0) ending in the
 * HighFive-only tail: a `uint32` flag, then - only when `softVertexRecordCount` is set - a
 * `compat32` count and that many opaque 52-byte records. Returns the buffer plus the byte
 * offset right after the LOD (where the next LOD, or the export tail, begins).
 */
function buildEmptyLod(numSoftWedges: number, softVertexRecordCount: number | null) {
  const bytes: number[] = [];
  const putU8 = (v: number) => bytes.push(v & 0xff);
  const putU32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    bytes.push(...b);
  };
  const putI32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    bytes.push(...b);
  };
  const putF32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    bytes.push(...b);
  };
  const putCompat = (v: number) => encodeCompat(v).forEach(putU8);
  const putLazyArray = () => {
    // unkLazyInt patched below once every prior byte length is known; placeholder for now.
    const patchAt = bytes.length;

    putI32(0); // unkLazyInt placeholder
    putCompat(0); // empty array

    return patchAt;
  };

  putCompat(0); // skinningData.count
  putCompat(0); // skinPoints.count
  putI32(numSoftWedges);
  putCompat(0); // softSections.count
  putCompat(0); // rigidSections.count
  putCompat(0); // softIndices.count
  putI32(0); // softIndices.revision
  putCompat(0); // rigidIndices.count
  putI32(0); // rigidIndices.revision
  putU32(0); // skinVertexStream.revision
  putU32(0); // skinVertexStream.unkVar0
  putU32(0); // skinVertexStream.unkVar1
  putCompat(0); // skinVertexStream.vertices.count

  const lazyPatches = [putLazyArray(), putLazyArray(), putLazyArray(), putLazyArray()];

  putF32(1); // lodHysteresis
  putU32(0); // numSharedVertices
  putU32(0); // lodMaxInfluences
  putU32(0); // unkVar0
  putU32(0); // unkVar1
  putU32(0); // useNewWedges

  putU32(softVertexRecordCount !== null ? 1 : 0); // hasSoftVertexRecords flag

  if (softVertexRecordCount !== null) {
    putCompat(softVertexRecordCount);
    for (let i = 0; i < softVertexRecordCount * 52; i++) putU8(0);
  }

  // Each FArrayLazy asserts pkg.tell() (content-relative) equals the `unkLazyInt` it read -
  // patch each placeholder to the offset right after its own (empty) count byte.
  for (const patchAt of lazyPatches) {
    const endOffset = patchAt + 5; // 4-byte unkLazyInt + 1-byte empty compat32 count
    const view = new DataView(new Uint8Array(4).buffer);

    view.setInt32(0, endOffset, true);
    for (let i = 0; i < 4; i++) bytes[patchAt + i] = view.getUint8(i);
  }

  return { bytes: new Uint8Array(bytes), end: bytes.length };
}

describe("FStaticModelLOD.load", () => {
  it("stops exactly at the next LOD for a rigid section (no soft-vertex tail)", () => {
    const { bytes, end } = buildEmptyLod(0, null);
    const pkg = new TestPackage(bytes) as unknown as C.APackage;

    new FStaticModelLOD().load(pkg);

    expect(pkg.tell()).toBe(end);
  });

  it("consumes the 52-byte-per-record soft-vertex tail and stops at the next LOD", () => {
    const { bytes, end } = buildEmptyLod(189, 189);
    const pkg = new TestPackage(bytes) as unknown as C.APackage;
    const lod = new FStaticModelLOD().load(pkg);

    expect(lod.hasSoftVertexRecords).toBe(true);
    expect(pkg.tell()).toBe(end);
  });

  it("rejects an implausible soft-vertex-records count instead of desyncing silently", () => {
    const { bytes } = buildEmptyLod(1, 1);
    const corrupted = new Uint8Array(bytes);
    const countAt = bytes.length - 1 - 52; // offset of the compat32 record count byte

    corrupted[countAt] = 0x81; // sign bit + nonzero magnitude -> decodes negative

    const pkg = new TestPackage(corrupted) as unknown as C.APackage;

    expect(() => new FStaticModelLOD().load(pkg)).toThrow(/desynced/);
  });
});
