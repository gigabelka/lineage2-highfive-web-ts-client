/*
 * Offline byte oracle for HighFive UE2 packages.
 *
 * Reverse-engineering a memory layout is much faster when the round trip is "read a file,
 * print some numbers" instead of "boot the decode worker, wait for WebGL". This tool does the
 * parts that need no WebGL/Worker/OPFS: decrypt the container, parse the package header and the
 * name/import/export tables, hexdump windows, and walk an export payload field by field so a
 * desync shows up as the first field whose value stops making sense.
 *
 * Usage:
 *   npx tsx tools/ukx-bytes.ts info   <package>
 *   npx tsx tools/ukx-bytes.ts find   <package> <nameRegex>
 *   npx tsx tools/ukx-bytes.ts hex    <package> <absOffset> <length>
 *   npx tsx tools/ukx-bytes.ts walk   <package> <exportName>
 *
 * Paths are relative to the client install (c:/Games/HighFive) unless absolute.
 */
import fs from "node:fs";
import nodePath from "node:path";

const CLIENT_ROOT = "c:/Games/HighFive";
const UE2_SIGNATURE = 0x9e2a83c1;

/* Every offset the package header carries - table offsets and export payload offsets alike - is
   relative to the start of the archive *content*, i.e. just past the 28-byte banner. The hexdumps
   and the reader work in absolute file offsets, so the banner length is added back at every use. */
const CONTENT_OFFSET = 28;

/* Lineage2Ver111 wraps the archive in a 28-byte UTF-16 banner followed by a single-byte XOR
   keystream. The key is recovered from the first encrypted byte, which must decode to the low
   byte of the UE2 signature - that is what makes this self-checking rather than magic. */
function decrypt(raw: Buffer): { data: Buffer; key: number } {
  const key = raw[28] ^ (UE2_SIGNATURE & 0xff);
  const data = Buffer.alloc(raw.length);

  for (let i = 0; i < raw.length; i++)
    data[i] = i < 28 ? raw[i] : raw[i] ^ key;

  if (data.readUInt32LE(28) !== UE2_SIGNATURE)
    throw new Error(
      `Not a Lineage2Ver111 archive (signature after decrypt: 0x${data
        .readUInt32LE(28)
        .toString(16)})`,
    );

  return { data, key };
}

class Reader {
  public constructor(
    private readonly buf: Buffer,
    public off: number,
  ) {}

  public tell() {
    return this.off;
  }
  public seek(off: number) {
    this.off = off;
  }
  public skip(n: number) {
    this.off += n;
  }

  /* l2js `compat32`: a compaction of the UE2 FCompactIndex - the low 6 bits of the first byte
     are the value, bit 6 means "a second byte follows", bit 7 is the sign. Reading it as a
     fixed int32 is what silently shifts every later field by up to 3 bytes. */
  public compat32(): number {
    let b = this.buf[this.off++];
    const sign = b & 0x80;
    let shift = 6;
    let r = b & 0x3f;

    if (b & 0x40) {
      let count = 0;

      do {
        if (count++ >= 4) break;
        b = this.buf[this.off++];
        r |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }

    return sign ? -r : r;
  }

  public u8() {
    return this.buf[this.off++];
  }
  public i16() {
    const v = this.buf.readInt16LE(this.off);
    this.off += 2;

    return v;
  }
  public u16() {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;

    return v;
  }
  public i32() {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;

    return v;
  }
  public u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;

    return v;
  }
  public f32() {
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;

    return v;
  }
}

type UName_T = { name: string; flags: number };
type UImport_T = {
  index: number;
  classPackage: string;
  className: string;
  idPackage: number;
  objectName: string;
};
type UExport_T = {
  index: number;
  idClass: number;
  idSuper: number;
  idPackage: number;
  objectName: string;
  flags: number;
  size: number;
  offset: number;
};

class Package {
  public readonly data: Buffer;
  public versions: number;
  public packageFlags: number;
  public names: UName_T[] = [];
  public imports: UImport_T[] = [];
  public exports: UExport_T[] = [];

  public constructor(public readonly file: string) {
    const raw = fs.readFileSync(file);

    this.data = decrypt(raw).data;

    const r = new Reader(this.data, CONTENT_OFFSET);

    if (r.u32() !== UE2_SIGNATURE)
      throw new Error("Signature does not sit at the content start.");

    /* The archive and licensee versions share one uint32: licensee in the high half. */
    this.versions = r.u32();
    this.packageFlags = r.u32();

    const nameCount = r.u32(),
      nameOffset = r.u32(),
      exportCount = r.u32(),
      exportOffset = r.u32(),
      importCount = r.u32(),
      importOffset = r.u32();

    /* String length is a compat32 that *includes* the trailing NUL; L2 identifiers are short
       enough that it always fits in one byte, which is why the field reads as a plain length. */
    r.seek(nameOffset + CONTENT_OFFSET);
    for (let i = 0; i < nameCount; i++) {
      const len = r.compat32();
      let name = "";

      for (let c = 0; c < Math.max(len - 1, 0); c++) name += String.fromCharCode(r.u8());
      if (len > 0) r.u8(); // NUL

      this.names.push({ name, flags: r.u32() });
    }

    r.seek(importOffset + CONTENT_OFFSET);
    for (let i = 0; i < importCount; i++) {
      const idClassPackage = r.compat32(),
        idClassName = r.compat32(),
        idPackage = r.i32(),
        idObjectName = r.compat32();

      this.imports.push({
        index: i,
        classPackage: this.names[idClassPackage].name,
        className: this.names[idClassName].name,
        idPackage,
        objectName: this.names[idObjectName].name,
      });
    }

    r.seek(exportOffset + CONTENT_OFFSET);
    for (let i = 0; i < exportCount; i++) {
      const idClass = r.compat32(),
        idSuper = r.compat32(),
        idPackage = r.u32(),
        idObjectName = r.compat32(),
        flags = r.u32(),
        size = r.compat32();
      const offset = size > 0 ? r.compat32() : 0;

      this.exports.push({
        index: i,
        idClass,
        idSuper,
        idPackage,
        objectName: this.names[idObjectName].name,
        flags,
        size,
        offset,
      });
    }
  }

  public get archiveVersion() {
    return this.versions & 0xffff;
  }
  public get licenseeVersion() {
    return (this.versions >>> 16) & 0xffff;
  }

  /* A class reference is an FPackageIndex: negative indexes the import table, positive the
     export table. What identifies the class is the imported *object* name - an import of
     `Core.Class` named `SkeletalMesh` is the SkeletalMesh class, not "Class". */
  public classNameOf(exp: UExport_T): string {
    if (exp.idClass === 0) return "<self>";
    if (exp.idClass < 0) {
      const imp = this.imports[-exp.idClass - 1];

      return imp ? `${imp.classPackage}.${imp.objectName}` : "<bad import>";
    }

    return this.exports[exp.idClass - 1]?.objectName ?? "<bad export>";
  }

  /* Export payloads are content-relative; the reader works in absolute file offsets because
     that is what a hexdump is in. */
  public fileOffset(exp: UExport_T) {
    return exp.offset + CONTENT_OFFSET;
  }
}

function resolve(p: string) {
  return nodePath.isAbsolute(p) ? p : nodePath.join(CLIENT_ROOT, p);
}

function f(n: number, digits = 4) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

/* --- the ULodMesh / USkeletalMesh walk ------------------------------------------------------
 *
 * `UPrimitive` is the base every mesh class serializes through, so the payload opens with the
 * UObject property list (a lone terminator byte when empty), the bounding box and the bounding
 * sphere. Getting those two sizes right is what makes `ULodMesh.Version` land on a sane value
 * (5) instead of 3243748099, so they are checked rather than trusted.
 */
function walkPrimitive(r: Reader, log: (s: string) => void) {
  const at = r.tell();
  const terminator = r.u8();

  log(`  @${at} propertyListTerminator = ${terminator} (${r.tell() - at}B)`);

  const box = { min: [0, 0, 0], max: [0, 0, 0] };

  for (let i = 0; i < 3; i++) box.min[i] = r.f32();
  for (let i = 0; i < 3; i++) box.max[i] = r.f32();

  const isValid = r.u8();

  log(
    `  @${at + 1} FBox min=(${box.min.map((v) => f(v, 2)).join(", ")}) max=(${box.max
      .map((v) => f(v, 2))
      .join(", ")}) isValid=${isValid} (25B)`,
  );

  const sphere = [r.f32(), r.f32(), r.f32(), r.f32()];

  log(
    `  sphere center=(${sphere.slice(0, 3).map((v) => f(v, 2)).join(", ")}) r=${f(sphere[3], 2)} (16B)`,
  );

  const minMaxOk = box.min.every((v, i) => v <= box.max[i]);
  const centerOk = sphere
    .slice(0, 3)
    .every((v, i) => Math.abs(v - (box.min[i] + box.max[i]) / 2) < Math.abs(box.max[i] - box.min[i]));

  log(`  sanity: min<=max ${minMaxOk}, sphere centre ~ bbox centre ${centerOk}`);
  log(`  primitive ends @${r.tell()} (payload starts @${at})`);
}

function walkLodMesh(r: Reader, log: (s: string) => void) {
  const start = r.tell();
  const version = r.u32();
  const vertexCount = r.u32();

  log(`  @${start} ULodMesh.Version = ${version}`);
  log(`  vertexCount = ${vertexCount}`);

  const unk0 = r.compat32();
  log(`  unkArr0 count = ${unk0} @${r.tell()} (ends @${r.tell() + unk0 * 4})`);
  r.skip(unk0 * 4);

  const nMat = r.compat32();
  const matIndices: number[] = [];

  for (let i = 0; i < nMat; i++) matIndices.push(r.compat32());
  log(`  lodMeshMaterials count = ${nMat} indices=[${matIndices.join(", ")}]`);

  const scale = [r.f32(), r.f32(), r.f32()],
    origin = [r.f32(), r.f32(), r.f32()],
    rotOrigin = [r.i32(), r.i32(), r.i32()];

  log(`  meshScale = (${scale.map((v) => f(v, 3)).join(", ")})`);
  log(`  meshOrigin = (${origin.map((v) => f(v, 3)).join(", ")})`);
  log(`  meshRotOrigin = (${rotOrigin.join(", ")})`);

  const isIdentity = scale.every((v) => v === 1) && origin.every((v) => v === 0) && rotOrigin.every((v) => v === 0);

  log(`  identity placement signature: ${isIdentity}`);

  const n2 = r.compat32();
  log(`  unkArr2 count = ${n2} (u16, ends @${r.tell() + n2 * 2})`);
  r.skip(n2 * 2);

  const n3 = r.compat32();
  log(`  unkArr3 count = ${n3} (8B structs, ends @${r.tell() + n3 * 8})`);
  r.skip(n3 * 8);

  const n4 = r.compat32();
  log(`  unkArr4 count = ${n4} (u16, ends @${r.tell() + n4 * 2})`);
  r.skip(n4 * 2);

  const n5 = r.compat32();
  log(`  unkArr5 count = ${n5} (10B structs, ends @${r.tell() + n5 * 10})`);
  r.skip(n5 * 10);

  const n6 = r.compat32();
  log(`  unkArr6 count = ${n6} (8B structs, ends @${r.tell() + n6 * 8})`);
  r.skip(n6 * 8);

  const tail = [r.f32(), r.f32(), r.f32(), r.i32(), r.f32(), r.f32()];
  log(`  lod tail = [${tail.map((v) => f(v, 3)).join(", ")}]`);

  if (version >= 3) {
    const imp = r.u32();

    log(`  hasImpostor(version>=3) = ${imp}`);

    /* The decoder reads the impostor struct whether or not the flag is set - a zero flag is
       "no impostor", not "no impostor record". Skipping it here used to throw the whole walk
       off by the struct size and produce the "48 bytes of zeros" that looked like missing data. */
    const materialId = r.compat32();
    const location = [r.f32(), r.f32(), r.f32()];
    const rotation = [r.i32(), r.i32(), r.i32()];
    const scale = [r.f32(), r.f32(), r.f32()];
    const color = [r.u8(), r.u8(), r.u8(), r.u8()];
    const spaceMode = r.u32(),
      drawMode = r.u32(),
      lightMode = r.u32();

    log(
      `    MeshImpostor materialId=${materialId} loc=(${location.map((v) => f(v, 2)).join(", ")}) rot=(${rotation.join(
        ", ",
      )}) scale=(${scale.map((v) => f(v, 2)).join(", ")}) color=(${color.join(", ")}) space=${spaceMode} draw=${drawMode} light=${lightMode}`,
    );
  }
  if (version >= 4) log(`  skinTesselationFactor(version>=4) = ${r.u32()}`);
  if (version >= 5) log(`  unkVar2(version>=5) = ${r.u32()}`);

  log(`  ULodMesh ends @${r.tell()}`);
}

/* `FJointPos` is FQuaternion + FVector + float + FVector, and the trailing `scale` is read but
   then overwritten with 1s by the decoder - it still costs 12 bytes on the wire. */
const JOINT_POS_BYTES = 16 + 12 + 4 + 12;
const MESH_COORDS_BYTES = 4 * 12;

function walkSkeletalMesh(r: Reader, log: (s: string) => void, exportEnd: number) {
  const start = r.tell();
  const align = (label: string, value: unknown, expected: unknown) =>
    log(`  ${value === expected ? "ok  " : "BAD "} ${label} = ${String(value)}`);

  const nPoints2 = r.compat32();

  align("points2.count", nPoints2, 0);
  r.skip(nPoints2 * 12);

  const nBones = r.compat32();
  const boneStart = r.tell();
  const parentErrors: number[] = [];
  let boneNameOk = 0;

  for (let i = 0; i < nBones; i++) {
    const nameIdx = r.compat32();
    const flags = r.u32();

    void flags;
    r.skip(JOINT_POS_BYTES);

    const numChildren = r.u32(),
      parentIndex = r.u32();

    void numChildren;
    if (parentIndex < i || parentIndex === 0xffffffff) boneNameOk++;
    else parentErrors.push(i);
  }

  log(
    `  refSkeleton.count = ${nBones} @${boneStart} -> ${r.tell()} (${r.tell() - boneStart}B, ${
      nBones ? ((r.tell() - boneStart) / nBones).toFixed(1) : "-"
    }B/bone)`,
  );
  align("bones with parentIndex < own index", `${boneNameOk}/${nBones}`, `${nBones}/${nBones}`);
  if (parentErrors.length) log(`      first bad parent links: ${parentErrors.slice(0, 8).join(", ")}`);

  const animationId = r.compat32();
  const skeletalDepth = r.u32();

  log(`  animationId = ${animationId} (import #${-animationId - 1} if negative)`);
  align("skeletalDepth in 1..64", skeletalDepth <= 64 && skeletalDepth > 0, true);

  const nWeights = r.compat32();
  const weightStart = r.tell();
  let totalInfluences = 0;

  for (let i = 0; i < nWeights; i++) {
    const n = r.compat32();

    totalInfluences += n;
    r.skip(n * 2);
    r.u32();
  }
  log(`  weightIndices.count = ${nWeights} @${weightStart} -> ${r.tell()} (Σ influences ${totalInfluences})`);
  align("weightIndices.count == refSkeleton.count", nWeights, nBones);

  const nInfluences = r.compat32();

  r.skip(nInfluences * 4);
  log(`  boneInfluences.count = ${nInfluences}`);

  const nAliases = r.compat32();

  for (let i = 0; i < nAliases; i++) r.compat32();
  log(`  attachAliases.count = ${nAliases}`);

  const nBoneNames = r.compat32();

  for (let i = 0; i < nBoneNames; i++) r.compat32();
  log(`  attachBoneNames.count = ${nBoneNames}`);

  const coordsAt = r.tell();
  const nCoords = r.compat32();

  r.skip(nCoords * MESH_COORDS_BYTES);
  log(`  attachCoords.count = ${nCoords} @${coordsAt} (${MESH_COORDS_BYTES}B each)`);
  align("attachCoords.count == refSkeleton.count", nCoords, nBones);

  const lodAt = r.tell();
  const nLods = r.compat32();

  log(`  lodModels.count = ${nLods} @${lodAt} (ends @${r.tell()}), cursor now @${r.tell()}`);
  log(`  skeleton portion @${start}..${r.tell()}, ${exportEnd - r.tell()} bytes remain`);

  return { nLods, lodAt, lodDataAt: r.tell() };
}

/* Locate an `FArray<FMeshBone>` by shape rather than by position.
 *
 * When the field order is unknown, a skeleton array is easy to recognise and almost impossible to
 * fake: a count in the plausible bone-number range, then that many records whose name index lands
 * inside the name table, whose joint transform is finite, and whose parent link always points
 * backwards. A run of zeros can satisfy "finite", so the parent-link and name-index tests carry
 * the discrimination. */
function scanForSkeletons(pkg: Package, r: Reader, from: number, to: number) {
  const results: { offset: number; count: number; end: number }[] = [];

  for (let off = from; off < to; off++) {
    const probe = new Reader(pkg.data, off);
    let count: number;

    try {
      count = probe.compat32();
    } catch {
      continue;
    }

    if (count < 20 || count > 600) continue;

    let ok = true;
    let parentErrors = 0;
    let finite = 0;

    for (let i = 0; i < count && ok; i++) {
      let nameIdx: number;

      try {
        nameIdx = probe.compat32();
      } catch {
        ok = false;
        break;
      }

      if (nameIdx < 0 || nameIdx >= pkg.names.length) {
        ok = false;
        break;
      }

      probe.u32(); // flags

      const joint = [probe.f32(), probe.f32(), probe.f32(), probe.f32()];
      const pos = [probe.f32(), probe.f32(), probe.f32()];
      const length = probe.f32();
      const scale = [probe.f32(), probe.f32(), probe.f32()];

      if ([...joint, ...pos, length, ...scale].every(Number.isFinite)) finite++;

      probe.u32(); // numChildren

      const parentIndex = probe.u32();

      if (parentIndex >= i + 1 && parentIndex !== 0xffffffff) parentErrors++;
    }

    if (ok && parentErrors === 0 && finite === count)
      results.push({ offset: off, count, end: probe.tell() });
  }

  return results;
}

/* Coarse structure map of a byte range: per block, how full it is, how much of it looks like
   finite floats, and how much looks like small integers. Long runs of one kind are what identify
   vertex/index/transform blocks when the layout is unknown. */
function cmdMap(pkg: Package, from: number, to: number, block = 256) {
  console.log(`${"offset".padStart(10)}  bytes  nonzero  floats  smallInts  ascii  sample`);

  for (let off = from; off < to; off += block) {
    const end = Math.min(off + block, to);
    let nonzero = 0,
      floats = 0,
      smallInts = 0,
      ascii = 0;

    for (let p = off; p + 4 <= end; p += 4) {
      const v = pkg.data.readUInt32LE(p);

      if (v !== 0) nonzero++;

      const fv = pkg.data.readFloatLE(p);

      if (Number.isFinite(fv) && Math.abs(fv) > 1e-6 && Math.abs(fv) < 1e6) floats++;
      if (v > 0 && v < 4096) smallInts++;

      const b = pkg.data[p];

      if (b >= 32 && b < 127) ascii++;
    }

    const n = Math.floor((end - off) / 4);
    const sample = pkg.data
      .subarray(off, off + 12)
      .toString("hex")
      .replace(/(..)/g, "$1 ")
      .trim();

    console.log(
      `${String(off).padStart(10)}  ${String(end - off).padStart(5)}  ${String(nonzero).padStart(7)}  ${String(
        floats,
      ).padStart(6)}  ${String(smallInts).padStart(9)}  ${String(ascii).padStart(5)}  ${sample}` +
        (n ? `  (${nonzero}/${n} nz, ${floats}/${n} f)` : ""),
    );
  }
}

/* `FStaticModelLOD` is the payload that actually failed. Every count here is cross-checked against
   something the neighbouring fields imply, because a lone garbage count only surfaces later as a
   native RangeError from the array length setter, with no clue which field was wrong. */
function walkLodModel(r: Reader, log: (s: string) => void, index: number, lodEnd: number) {
  const start = r.tell();
  const indent = "    ";

  const nSkinning = r.compat32();

  r.skip(nSkinning * 4);
  log(`${indent}LOD[${index}] @${start} skinningData.count = ${nSkinning} (${nSkinning * 4}B)`);

  const skinPointsAt = r.tell();
  const nSkinPoints = r.compat32();

  r.skip(nSkinPoints * 16);
  log(
    `${indent}  skinPoints.count = ${nSkinPoints} @${skinPointsAt} -> ${r.tell()} (16B each)`,
  );

  const softWedgesAt = r.tell();
  const numSoftWedges = r.i32();

  log(`${indent}  numSoftWedges = ${numSoftWedges} @${softWedgesAt}`);

  for (const which of ["softSections", "rigidSections"] as const) {
    const at = r.tell();
    const n = r.compat32();

    if (n < 0 || n > 100000) {
      log(`${indent}  BAD ${which}.count = ${n} @${at} (implausible)`);
      return null;
    }

    // Every field is a WORD, not SWORD - a soft section leaves minStreamIndex/boneIndex/fE unset
    // as 0xfefe, which would come back negative and wrongly look "out of range" as int16. The
    // material index is still the best desync signal: a wrong stride shows up as a resolveable-
    // looking value here going implausible.
    let bad = 0;
    const materials: number[] = [];
    let boneMapTotal = 0;

    for (let i = 0; i < n; i++) {
      materials.push(r.u16());
      if (materials[i] > 32) bad++;
      for (let f16 = 1; f16 < 9; f16++) r.u16();

      // HighFive only: each section carries its own bone palette after the 9 WORDs.
      const boneMapAt = r.tell();
      const boneMapCount = r.compat32();

      if (boneMapCount < 0 || boneMapCount > 256) {
        log(`${indent}  BAD ${which}[${i}].boneMap.count = ${boneMapCount} @${boneMapAt} (implausible)`);
        return null;
      }

      r.skip(boneMapCount * 4);
      boneMapTotal += boneMapCount;
    }

    log(
      `${indent}  ${which}.count = ${n} @${at} -> ${r.tell()} (18B + boneMap each, ${bad}/${
        materials.length || 0
      } out-of-range materialIndex${bad ? ` e.g. ${materials.slice(0, 6).join(",")}` : ""}, ΣboneMap=${boneMapTotal})`,
    );
  }

  for (const which of ["softIndices", "rigidIndices"] as const) {
    const n = r.compat32();

    r.skip(n * 2);
    const revision = r.i32();

    log(`${indent}  ${which}: ${n} u16 + revision=${revision}`);
  }

  const streamRevision = r.u32(),
    isPartial = r.u32(),
    isStreamCallback = r.u32();
  const nVertices = r.compat32();
  const vertsAt = r.tell();

  r.skip(nVertices * 32);
  log(
    `${indent}  skinVertexStream rev=${streamRevision} partial=${isPartial} callback=${isStreamCallback} vertices.count = ${nVertices} @${vertsAt} (32B each)`,
  );

  for (const [which, size] of [
    ["vertexInfluences", 8],
    ["wedges", 10],
    ["faces", 8],
    ["points", 12],
  ] as const) {
    const lazyInt = r.i32();
    const n = r.compat32();

    r.skip(Math.max(n, 0) * size);
    log(
      `${indent}  ${which}: lazyInt=${lazyInt} count=${n} -> @${r.tell()} (delta from end ${r.tell() - lazyInt})`,
    );
  }

  const lodHysteresis = r.f32(),
    numSharedVertices = r.u32(),
    lodMaxInfluences = r.u32(),
    unkVar0 = r.u32(),
    unkVar1 = r.u32(),
    useNewWedges = r.u32();

  log(
    `${indent}  tail: lodHysteresis=${f(lodHysteresis, 3)} numSharedVertices=${numSharedVertices} lodMaxInfluences=${lodMaxInfluences} unkVar0=${unkVar0} unkVar1=${unkVar1} useNewWedges=${useNewWedges}`,
  );

  // HighFive-only hypothesis: one more u32 flag, then (when set) a compat32 count of 52-byte
  // records. Rigid meshes (MFighter_m001_m00_bh) carry flag=0 and nothing after; soft meshes
  // (mimic1_m00) carry flag=1 and `numSoftWedges` records of 52 bytes each.
  const extraFlagAt = r.tell();
  const extraFlag = r.u32();
  let extraRecords = 0;

  if (extraFlag !== 0) {
    const countAt = r.tell();
    extraRecords = r.compat32();

    if (extraRecords < 0 || extraRecords > 100000) {
      log(`${indent}  BAD extra.count = ${extraRecords} @${countAt} (implausible)`);
      return null;
    }

    r.skip(extraRecords * 52);
  }

  log(
    `${indent}  extra: flag=${extraFlag} @${extraFlagAt} records=${extraRecords} (52B each) -> @${r.tell()}`,
  );
  log(`${indent}  LOD[${index}] ends @${r.tell()} (${r.tell() - start}B)`);

  return r.tell();
}

/* Find `FArray<FAnimMeshVertex>` by shape.
 *
 * Each record is position(3f) + normal(3f) + uv(2f). A vertex *normal* is unit length, which no
 * other field in the LOD is, so a long run of records whose second float triple has length 1
 * pins the vertex stream down exactly - and from it the indices, sections and skinning stream
 * that surround it become reachable by counting backwards. */
function scanForVertexStreams(pkg: Package, from: number, to: number, minRecords = 16) {
  const hits: { dataOffset: number; count: number; end: number; unitRate: number }[] = [];

  const unitTriples = (off: number, count: number) => {
    let unit = 0,
      finite = 0;

    for (let i = 0; i < count; i++) {
      const p = off + i * 32;
      const nx = pkg.data.readFloatLE(p + 12),
        ny = pkg.data.readFloatLE(p + 16),
        nz = pkg.data.readFloatLE(p + 20);

      if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) continue;

      finite++;

      const len = Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1);

      if (len < 0.02) unit++;
    }

    return { unit, finite };
  };

  for (let off = from; off + 64 < to; off += 4) {
    const probe = new Reader(pkg.data, off);
    const count = probe.compat32();

    if (count < minRecords || count > 200000) continue;

    const declen = probe.tell() - off;
    const dataOffset = probe.tell();

    if (dataOffset + count * 32 > to) continue;

    const { unit, finite } = unitTriples(dataOffset, count);

    if (finite === count && unit / count > 0.95)
      hits.push({ dataOffset, count, end: dataOffset + count * 32, unitRate: unit / count });
  }

  // A hit and its neighbour one float along are the same array seen twice; keep the first.
  return hits.filter((h, i) => i === 0 || h.dataOffset - hits[i - 1].dataOffset > 32);
}

function cmdVerts(pkg: Package, from: number, to: number, minRecords: number) {
  const hits = scanForVertexStreams(pkg, from, to, minRecords);

  console.log(`${hits.length} vertex-stream candidates in [${from}, ${to})`);

  for (const h of hits.slice(0, 40))
    console.log(
      `  data@${h.dataOffset} count=${h.count} ends@${h.end} (${h.count * 32}B) unit-normals=${(
        h.unitRate * 100
      ).toFixed(1)}%`,
    );
}

/* Generalised version of the above: an array of records of `stride` bytes where the float triple
   at `normalAt` is unit length. Strides/offsets are enumerated because the record structs are
   exactly what is unknown - a 24-byte FSkinPoint puts its normal at +12, a 32-byte
   FAnimMeshVertex at +12 as well, and a bare normal array has it at +0. */
function cmdScan(pkg: Package, from: number, to: number, minRecords: number) {
  const strides = [12, 16, 20, 24, 28, 32, 36, 40, 44, 48];

  for (const stride of strides) {
    for (let normalAt = 0; normalAt + 12 <= stride; normalAt += 4) {
      let best: { offset: number; count: number } | null = null;

      for (let off = from; off + stride * minRecords < to; off += 4) {
        const probe = new Reader(pkg.data, off);
        const count = probe.compat32();

        if (count < minRecords || count > 200000) continue;
        if (probe.tell() + count * stride > to) continue;

        let unit = 0,
          finite = 0;

        for (let i = 0; i < count; i++) {
          const p = probe.tell() + i * stride;
          const nx = pkg.data.readFloatLE(p + normalAt),
            ny = pkg.data.readFloatLE(p + normalAt + 4),
            nz = pkg.data.readFloatLE(p + normalAt + 8);

          if (![nx, ny, nz].every(Number.isFinite)) break;

          finite++;
          if (Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) < 0.02) unit++;
        }

        if (finite === count && unit / count > 0.98 && (!best || count > best.count))
          best = { offset: probe.tell(), count };
      }

      if (best)
        console.log(
          `stride=${stride} normalAt=+${normalAt}: data@${best.offset} count=${best.count} ends@${
            best.offset + best.count * stride
          } (${best.offset - 4} count field, ${best.count * stride}B)`,
        );
    }
  }
}

function cmdInfo(pkg: Package) {
  console.log(`file            ${pkg.file} (${pkg.data.length} bytes)`);
  console.log(`archiveVersion  ${pkg.archiveVersion}`);
  console.log(`licenseeVersion ${pkg.licenseeVersion}`);
  console.log(`packageFlags    0x${pkg.packageFlags.toString(16)}`);
  console.log(`names           ${pkg.names.length}`);
  console.log(`imports         ${pkg.imports.length}`);
  console.log(`exports         ${pkg.exports.length}`);

  const byClass = new Map<string, number>();

  for (const exp of pkg.exports) {
    const cls = pkg.classNameOf(exp);

    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
  }

  console.log("exports by class:");

  for (const [cls, count] of [...byClass].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(count).padStart(6)}  ${cls}`);
}

function cmdFind(pkg: Package, pattern: string) {
  const re = new RegExp(pattern, "i");
  const hits = pkg.exports.filter((e) => re.test(e.objectName));

  console.log(`${hits.length} exports matching /${pattern}/i`);

  for (const e of hits.slice(0, 100))
    console.log(
      `  #${e.index} ${e.objectName} class=${pkg.classNameOf(e)} size=${e.size} file=${
        pkg.fileOffset(e)
      }..${pkg.fileOffset(e) + e.size}`,
    );
}

function cmdHex(pkg: Package, offset: number, len: number) {
  for (let i = 0; i < len; i += 16) {
    const off = offset + i;
    const row = pkg.data.subarray(off, Math.min(off + 16, offset + len));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");

    const asInt32 = row.length >= 4 ? String(pkg.data.readInt32LE(off)).padStart(11) : "";
    const asFloat = row.length >= 4 ? Number(pkg.data.readFloatLE(off).toPrecision(6)).toString() : "";

    console.log(
      `${String(off).padStart(10)}  ${hex.padEnd(47)}  ${ascii.padEnd(16)} i32=${asInt32} f=${asFloat}`,
    );
  }
}

function cmdWalk(pkg: Package, name: string) {
  const exp = pkg.exports.find((e) => e.objectName.toLowerCase() === name.toLowerCase());

  if (!exp) throw new Error(`No export named '${name}'.`);

  const start = pkg.fileOffset(exp),
    end = start + exp.size;

  console.log(`export #${exp.index} '${exp.objectName}' class=${pkg.classNameOf(exp)}`);
  console.log(`  flags=0x${exp.flags.toString(16)} size=${exp.size}`);
  console.log(`  payload file=[${start}, ${end})`);

  const r = new Reader(pkg.data, start);
  const log = (s: string) => console.log(s);

  walkPrimitive(r, log);
  walkLodMesh(r, log);

  const { nLods, lodDataAt } = walkSkeletalMesh(r, log, end);

  r.seek(lodDataAt);
  for (let i = 0; i < nLods; i++) if (walkLodModel(r, log, i, end) === null) break;

  console.log(`  remaining ${end - r.tell()} bytes to export end`);
  console.log("  skeleton-array candidates in the remaining payload:");

  for (const hit of scanForSkeletons(pkg, r, r.tell(), end))
    console.log(`    @${hit.offset} count=${hit.count} ends@${hit.end} (absent from start by ${hit.offset - r.tell()}B)`);
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);

  if (!cmd || !file) {
    console.log(
      "usage: tsx tools/ukx-bytes.ts <info|find|hex|walk> <package> [args...]\n" +
        "  find <nameRegex>\n  hex <absOffset> <length>\n  walk <exportName>",
    );
    process.exit(1);
  }

  const pkg = new Package(resolve(file));

  switch (cmd) {
    case "info":
      return cmdInfo(pkg);
    case "find":
      return cmdFind(pkg, rest[0]);
    case "hex":
      return cmdHex(pkg, Number(rest[0]), Number(rest[1] ?? 128));
    case "map":
      return cmdMap(pkg, Number(rest[0]), Number(rest[1]), Number(rest[2] ?? 256));
    case "scan":
      return cmdScan(pkg, Number(rest[0]), Number(rest[1]), Number(rest[2] ?? 8));
    case "verts":
      return cmdVerts(pkg, Number(rest[0]), Number(rest[1]), Number(rest[2] ?? 16));
    case "walk":
      return cmdWalk(pkg, rest[0]);
    default:
      throw new Error(`Unknown command '${cmd}'.`);
  }
}

main();
